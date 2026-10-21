import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ExtensionManager } from '../src/main/extensions'
import { runExtension, publicAddress, validateRequest, networkAddressAllowed } from '../src/main/extension-runtime'
import { authorizeGoogle, gmailScope, refreshGoogle } from '../src/main/extension-oauth'
import { exampleExtension } from '../src/main/extension-examples'
import { LocalStore } from '../src/main/storage'
import { LocalAgentRuntime } from '../src/main/runtime'
import { ProcessManager, createTools } from '../src/main/tools'
import type { ExtensionPackage } from '../src/shared/extensions'
import type { ToolContext, ModelProvider, ModelEvent } from '../src/shared/types'

const signal = () => new AbortController().signal
function extension(value = 'v1'): ExtensionPackage {
  return { manifest: { id: 'example', version: value === 'v1' ? '1.0.0' : '1.1.0', name: 'Example', description: 'Test-generated extension', hosts: [], methods: ['GET'],
    tools: [{ name: 'query', description: 'Echo a query with the installed revision', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] },
    code: `async function run(tool,input,sdk) { return {query:input.query,version:${JSON.stringify(value)}} }`,
    tests: [{ tool: 'query', input: { query: 'hello' }, expected: { query: 'hello', version: value }, responses: [] }] }
}
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'clax-extension-test-')), secrets = new Map<string, string>()
  const codec = { get: (id: string) => secrets.get(id) ?? '', set: (id: string, value: string) => { secrets.set(id, value) }, available: () => true }
  const manager = new ExtensionManager(home, codec)
  const context = { signal: signal(), permission: 'auto', approve: async () => true } as unknown as ToolContext
  return { home, manager, context, codec, secrets, close: async () => { manager.close(); await rm(home, { recursive: true, force: true }) } }
}

test('Plugin drafts test/install atomically, update safely, survive restart and roll back to the previous version', async () => {
  const f = await setup()
  try {
    assert.deepEqual(f.manager.list(), [])
    f.manager.stage(extension()); assert.deepEqual(f.manager.tools(), [])
    await f.manager.install('example', signal())
    const original = f.manager.tools()[0]!
    assert.match(await original.execute({ query: 'first' }, f.context), /"version":"v1"/)
    const broken = extension('broken'); broken.tests[0]!.expected = 'incorrect'
    f.manager.stage(broken); await assert.rejects(f.manager.install('example', signal()), /test failed/)
    assert.equal(f.manager.read('example').manifest.version, '1.0.0')
    assert.equal(f.manager.read('example', 'draft').manifest.version, '1.1.0')
    assert.match(await original.execute({ query: 'still works' }, f.context), /v1/)
    f.manager.stage(extension('v2')); await f.manager.install('example', signal())
    await assert.rejects(original.execute({ query: 'stale' }, f.context), /changed/)
    const restarted = new ExtensionManager(f.home, f.codec)
    assert.match(await restarted.tools()[0]!.execute({ query: 'after restart' }, f.context), /v2/)
    restarted.rollback('example')
    assert.match(await restarted.tools()[0]!.execute({ query: 'restored' }, f.context), /v1/)
    restarted.close()
  } finally { await f.close() }
})

test('Malformed manifests, uncovered tools and modified revisions cannot be installed; a corrupt registry stays visible', async () => {
  const f = await setup()
  try {
    const invalid = extension(); invalid.manifest.id = '../escape'
    assert.throws(() => f.manager.stage(invalid))
    const complex = extension(); (complex.manifest.tools[0]!.inputSchema.properties as any).query.pattern = '^(a+)+$'
    assert.throws(() => f.manager.stage(complex), /character-class/)
    const credentialHeader = exampleExtension('search'); credentialHeader.manifest.auth = { type: 'api-key', header: 'Authorization', prefix: '\n' }
    assert.throws(() => f.manager.stage(credentialHeader))
    invalid.manifest.id = 'valid'; invalid.tests = []
    assert.throws(() => f.manager.stage(invalid))
    const staged = f.manager.stage(extension())
    const path = join(f.home, 'extensions/revisions', `example-${staged.revision}.json`)
    const value = JSON.parse(await readFile(path, 'utf8')); value.code += ';'
    await writeFile(path, JSON.stringify(value))
    await assert.rejects(f.manager.install('example', signal()), /content changed/)
    await writeFile(join(f.home, 'extensions/registry.json'), '{bad')
    assert.equal(f.manager.list()[0]?.enabled, false); assert.match(f.manager.list()[0]!.error!, /损坏/)
    assert.deepEqual(f.manager.tools(), [])
  } finally { await f.close() }
})

test('Search and Gmail example plugins execute real guest code against strict offline HTTP fixtures and require real connection credentials', async () => {
  const f = await setup()
  try {
    for (const kind of ['search', 'gmail']) {
      const value = exampleExtension(kind)
      f.manager.stage(value); const tested = await f.manager.test(value.manifest.id, signal())
      assert.equal(tested.passed, value.tests.length)
      await f.manager.install(value.manifest.id, signal())
      assert.equal(f.manager.list().find(item => item.id === value.manifest.id)!.connected, false)
      const tool = f.manager.tools().find(tool => tool.name.includes(kind === 'gmail' ? 'gmail' : 'web_search'))!
      await assert.rejects(tool.execute({ query: 'hello' }, f.context), /尚未访问真实账号/)
    }
    await f.manager.connect('web-search', { apiKey: 'private-test-key' }, async () => {})
    await assert.rejects(f.manager.connect('web-search', { apiKey: 'invalid\nkey' }, async () => {}), /控制字符/)
    assert.equal(f.manager.list().find(item => item.id === 'web-search')!.connected, true)
    assert.ok(!JSON.stringify(f.manager.list()).includes('private-test-key'))
    const changed = exampleExtension('search'); changed.manifest.hosts = ['different.example.com']
    changed.code = 'async function run(){return null}'; changed.tests = [{ tool: 'search', input: { query: 'x' }, expected: null, responses: [] }]
    f.manager.stage(changed); await f.manager.install('web-search', signal())
    assert.equal(f.manager.list().find(item => item.id === 'web-search')!.connected, false, 'Changed destinations require a new human connection')
  } finally { await f.close() }
})

test('Guest isolation denies Node access, local destinations, redirects-by-host, undeclared methods and credential headers', async () => {
  const input = extension().manifest; input.hosts = ['example.com']
  for (const request of [{ url: 'http://example.com' }, { url: 'https://127.0.0.1' }, { url: 'https://evil.example.com' },
    { url: 'https://example.com:8443' }, { url: 'https://user:pass@example.com' }, { url: 'https://example.com', method: 'DELETE' }, { url: 'https://example.com', headers: { Authorization: 'secret' } }]) assert.throws(() => validateRequest(input, request))
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(publicAddress(address), false, address)
  assert.equal(publicAddress('8.8.8.8'), true)
  assert.equal(await networkAddressAllowed('198.18.0.1', async () => 'interface: en0'), false)
  assert.equal(await networkAddressAllowed('127.0.0.1', async () => 'interface: utun8'), false)
  if (process.platform === 'darwin') assert.equal(await networkAddressAllowed('198.18.0.1', async () => 'interface: utun8'), true)
  const output = await runExtension('function run(){return [typeof process,typeof require,typeof fetch,typeof Buffer]}', 'x', {}, signal(), async () => { throw new Error('unexpected') })
  assert.deepEqual(output, ['undefined', 'undefined', 'undefined', 'undefined'])
  await assert.rejects(runExtension('function run(){return ({}).constructor.constructor("return process")()}', 'x', {}, signal(), async () => { throw new Error('unexpected') }), /process/)
})

test('Explicit plugin deadlines and user disable still cancel otherwise unlimited invocations', async () => {
  await assert.rejects(runExtension('function run(){while(true){}}', 'x', {}, signal(), async () => { throw new Error('unexpected') }, 100), /timed out|interrupted/)
  const f = await setup()
  try {
    const value = extension(); value.code = 'function run(tool,input){if(input.query==="hang")while(true){};return {query:input.query,version:"v1"}}'
    f.manager.stage(value); await f.manager.install('example', signal())
    const pending = f.manager.tools()[0]!.execute({ query: 'hang' }, f.context)
    const rejected = assert.rejects(pending, /abort|cancel/i)
    f.manager.setEnabled('example', false); await rejected
    assert.deepEqual(f.manager.tools(), [])
  } finally { await f.close() }
})

test('Plugins run more than 20 requests and return large output without package or invocation quotas', async () => {
  const f = await setup()
  try {
    const value = extension()
    value.code += '\n/*' + 'large source '.repeat(12000) + '*/'
    f.manager.stage(value); await f.manager.install('example', signal())
    const output = await f.manager.tools()[0]!.execute({ query: 'x'.repeat(100000) }, f.context)
    assert.ok(output.length > 100000)
    let calls = 0
    const result = await runExtension('async function run(tool,input,sdk){for(let i=0;i<25;i++)await sdk.request({url:"https://example.com",method:"POST",body:input.body});return input.body}', 'x', { body: 'x'.repeat(100000) }, signal(), async request => {
      const parsed = validateRequest({ ...value.manifest, hosts: ['example.com'], methods: ['POST'] }, request)
      assert.equal(parsed.body!.length, 100000); calls++; return { status: 200, body: 'ok' }
    })
    assert.equal(calls, 25); assert.equal((result as string).length, 100000)
  } finally { await f.close() }
})

test('Native Google OAuth validates state, binds PKCE to code exchange, refreshes and closes cancelled callback listeners', async () => {
  let challenge = '', redirect = ''
  const client = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'client-secret-fixture' }
  const token = await authorizeGoogle(client, signal(), async value => {
    const url = new URL(value); challenge = url.searchParams.get('code_challenge')!; redirect = url.searchParams.get('redirect_uri')!
    assert.equal(url.searchParams.get('scope'), gmailScope); assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal((await fetch(`${redirect}?state=wrong&code=bad`)).status, 400)
    assert.equal((await fetch(`${redirect}?state=${url.searchParams.get('state')}&code=authorized-code`)).status, 200)
  }, async body => {
    assert.equal(body.get('code'), 'authorized-code'); assert.equal(body.get('client_secret'), client.clientSecret)
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), challenge)
    return { access_token: 'access-fixture', refresh_token: 'refresh-fixture', expires_in: 3600, scope: gmailScope }
  })
  assert.equal(token.refreshToken, 'refresh-fixture')
  const refreshed = await refreshGoogle(client, token, signal(), async body => {
    assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('refresh_token'), 'refresh-fixture')
    return { access_token: 'renewed', expires_in: 3600 }
  })
  assert.equal(refreshed.accessToken, 'renewed'); assert.equal(refreshed.refreshToken, token.refreshToken)
  const controller = new AbortController()
  await assert.rejects(authorizeGoogle(client, controller.signal, async value => { redirect = new URL(value).searchParams.get('redirect_uri')!; controller.abort() }), /取消/)
  await assert.rejects(fetch(redirect))
})

test('A running model turn can develop, install and invoke its new tool without restarting the runtime', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clax-hot-tools-'))
  const store = new LocalStore(home, { available: () => false, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }, home)
  const processes = new ProcessManager(), session = store.createSession({ provider: 'fixture', model: 'fixture' })
  store.saveSettings({ ...store.settings, maxContextChars: 100000, memory: { enabled: false, autoCapture: false } })
  session.messages.push({ id: 'u1', turnId: 't1', role: 'user', content: 'Develop and use your own plugin', createdAt: Date.now() })
  let step = 0
  const provider: ModelProvider = { id: 'fixture', name: 'Scripted protocol fixture', listModels: async () => [], capabilities: () => ({ tools: true }),
    async *stream(request): AsyncIterable<ModelEvent> {
      step++
      if (step === 1) yield { type: 'tool_call', call: { id: 'stage', name: 'extension_manage', arguments: { action: 'stage', package: extension() } } }
      else if (step === 2) yield { type: 'tool_call', call: { id: 'install', name: 'extension_manage', arguments: { action: 'install', id: 'example' } } }
      else if (step === 3) {
        assert.ok(request.tools.some(t => t.name === 'ext_example_query'))
        yield { type: 'tool_call', call: { id: 'invoke', name: 'ext_example_query', arguments: { query: 'installed in this turn' } } }
      } else {
        assert.match(request.messages.at(-1)!.content, /installed in this turn/)
        yield { type: 'text', text: 'Installed and used the tool.' }
      }
    } }
  try {
    for await (const event of new LocalAgentRuntime(() => 100000).runTurn(session, session.currentModel!, createTools(store, processes), signal(), {
      tools: () => createTools(store, processes), provider: () => provider, context: () => '', takeSteering: () => [], permission: () => 'auto', approve: async () => true,
    })) assert.notEqual(event.type, 'error', JSON.stringify(event))
    assert.equal(step, 4); assert.match(session.messages.at(-1)!.content, /Installed and used/)
  } finally { await processes.shutdown(); store.close(); await rm(home, { recursive: true, force: true }) }
})
