import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { LocalStore, dataHome, type SecureCodec } from '../src/main/storage'
import { AgentService } from '../src/main/service'
import { ProcessManager, createTools } from '../src/main/tools'
import { commandRisk, inside } from '../src/main/permissions'
import { fixtureServer } from './fixture-server'
import { LocalAgentRuntime, MAX_STEPS } from '../src/main/runtime'
import { DEFAULT_SHORTCUT } from '../src/shared/shortcuts'
import { requestTokens } from '../src/main/context'
import type { AgentEvent, ModelProvider, ModelRequest, ToolContext, AgentTool, ModelEvent } from '../src/shared/types'

const volatileCodec: SecureCodec = { available: () => false, encrypt: () => { throw new Error('unavailable') }, decrypt: () => { throw new Error('unavailable') } }
async function setup(codec = volatileCodec) {
  const root = await mkdtemp(join(tmpdir(), 'clax-test-')), workspace = join(root, 'workspace')
  await mkdir(workspace); await writeFile(join(workspace, 'package.json'), '{"name":"test-workspace"}\n')
  const store = new LocalStore(join(root, 'data'), codec, workspace)
  store.saveSettings({ ...store.settings, memory: { enabled: true, autoCapture: false } })
  const session = store.createSession(), processes = new ProcessManager()
  const context: ToolContext = { session, signal: new AbortController().signal, permission: 'auto', progress: () => {}, approve: async () => true }
  const tools = createTools(store, processes)
  return { root, workspace, store, session, processes, context, tool: (name: string) => tools.find(t => t.name === name)!,
    cleanup: async () => { await processes.shutdown(); store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('Root/disk destruction is blocked and Auto distinguishes development from risky commands', () => {
  for (const command of ['rm -rf /', 'rm -rf /*', 'rm -rf "$HOME"', 'rm -rf ~', 'format C:', 'mkfs.ext4 /dev/disk0', 'rd /s /q C:\\']) assert.equal(commandRisk(command).blocked, true, command)
  for (const command of ['pnpm test', 'npm run build', 'node --version', 'git status']) assert.equal(commandRisk(command).automatic, true, command)
  for (const command of ['rm -rf tmp', 'sudo npm install -g x', 'ls; rm file', 'node -e "require(\'fs\').rmSync(\'x\')"', 'pnpm test > /etc/test']) assert.equal(commandRisk(command).automatic, false, command)
  assert.equal(inside('/project', '/project-neighbor/x'), false)
})
test('Clax migrates the legacy data directory without overwriting existing data or explicit paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clax-rename-'))
  const legacy = join(root, '.deskagent'), home = join(root, '.clax')
  try {
    await mkdir(legacy); await writeFile(join(legacy, 'credentials.json'), '{"encrypted":"retained"}')
    await writeFile(join(legacy, 'sessions.db'), Buffer.from([0, 1, 255, 3]))
    assert.equal(dataHome(root, {}), home)
    assert.equal(await readFile(join(home, 'credentials.json'), 'utf8'), '{"encrypted":"retained"}')
    assert.deepEqual(await readFile(join(home, 'sessions.db')), Buffer.from([0, 1, 255, 3]))
    await assert.rejects(access(legacy))
    await mkdir(legacy); await writeFile(join(legacy, 'keep.txt'), 'Do not overwrite either store')
    assert.equal(dataHome(root, {}), home); await access(join(legacy, 'keep.txt'))
    assert.equal(dataHome(root, { CLAX_HOME: 'explicit', DESKAGENT_HOME: 'legacy-explicit' }), 'explicit')
    assert.equal(dataHome(root, { DESKAGENT_HOME: 'legacy-explicit' }), 'legacy-explicit')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('Existing settings receive the new shortcut default and preserve other preferences', async () => {
  const f = await setup()
  try {
    const { globalShortcut, ...legacy } = f.store.settings
    f.store.writeJSON('settings.json', { ...legacy, permissionMode: 'ask', enabledSkills: { coding: false } })
    const second = new LocalStore(f.store.home, { available: () => false, encrypt: v => Buffer.from(v), decrypt: v => v.toString() }, f.workspace)
    try {
      assert.equal(second.settings.globalShortcut, DEFAULT_SHORTCUT)
      assert.equal(second.settings.permissionMode, 'ask')
      assert.deepEqual(second.settings.enabledSkills, { coding: false })
      second.saveSettings({ ...second.settings, globalShortcut: 'Alt+Shift+Space' })
      assert.equal(JSON.parse(await readFile(join(f.store.home, 'settings.json'), 'utf8')).globalShortcut, 'Alt+Shift+Space')
    } finally { second.close() }
    for (const shortcut of ['Alt+Space', 'Control+Shift+Space', 'Alt+D']) {
      f.store.writeJSON('settings.json', { ...f.store.settings, globalShortcut: shortcut, permissionMode: 'ask' })
      const upgraded = new LocalStore(f.store.home, volatileCodec, f.workspace)
      try {
        const expected = shortcut === 'Alt+D' ? shortcut : DEFAULT_SHORTCUT
        assert.equal(upgraded.settings.globalShortcut, expected)
        assert.equal(upgraded.settings.permissionMode, 'ask')
        if (shortcut !== 'Alt+D') assert.equal(JSON.parse(await readFile(join(f.store.home, 'settings.json'), 'utf8')).globalShortcut, expected)
      } finally { upgraded.close() }
    }
  } finally { await f.cleanup() }
})
test('File tools create, patch and search; they refuse ambiguous edits and overwrites', async () => {
  const f = await setup()
  try {
    await f.tool('write_file').execute({ path: 'src/note.txt', content: 'before\nhello\n' }, f.context)
    await assert.rejects(f.tool('write_file').execute({ path: 'src/note.txt', content: 'overwrite' }, f.context), /EEXIST/)
    const diff = await f.tool('edit_file').execute({ path: 'src/note.txt', patch: '--- src/note.txt\n+++ src/note.txt\n@@ -1,2 +1,2 @@\n-before\n+after\n hello\n' }, f.context)
    assert.match(diff, /\+after/)
    assert.match(await f.tool('read_file').execute({ path: 'src/note.txt' }, f.context), /1: after/)
    assert.match(await f.tool('search_files').execute({ query: 'hello', mode: 'content' }, f.context), /src\/note.txt:2/)
    await assert.rejects(f.tool('edit_file').execute({ path: 'src/note.txt', oldText: 'missing', newText: 'x' }, f.context), /exactly once/)
  } finally { await f.cleanup() }
})
test('Workspace boundary checks include symlinks and Ask permits no write before approval', async () => {
  const f = await setup(); let asked = 0
  try {
    await mkdir(join(f.root, 'outside')); await symlink(join(f.root, 'outside'), join(f.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const denied = { ...f.context, approve: async () => { asked++; return false } }
    await assert.rejects(f.tool('write_file').execute({ path: 'link/test.txt', content: 'x' }, denied), /denied/)
    assert.equal(asked, 1); await assert.rejects(access(join(f.root, 'outside/test.txt')))
    await assert.rejects(f.tool('write_file').execute({ path: 'ask.txt', content: 'x' }, { ...denied, permission: 'ask' }), /denied/)
    await assert.rejects(access(join(f.workspace, 'ask.txt')))
  } finally { await f.cleanup() }
})
test('Shell streams stdout/stderr, reports exit, times out and kills on abort', async () => {
  const f = await setup(); const chunks: string[] = []
  try {
    const result = await f.tool('shell').execute({ command: 'node -e "console.log(123);console.error(456);process.exit(3)"', timeout: 5000 }, { ...f.context, progress: (_, text) => chunks.push(text) })
    assert.match(result, /Exit code: 3/); assert.match(chunks.join(''), /123/); assert.match(chunks.join(''), /456/)
    await assert.rejects(f.tool('shell').execute({ command: 'node -e "setInterval(()=>{},1000)"', timeout: 80 }, f.context), /timed out/)
    const controller = new AbortController()
    const task = f.tool('shell').execute({ command: 'node -e "setInterval(()=>console.log(1),20)"', timeout: 5000 }, { ...f.context, signal: controller.signal, progress: () => controller.abort() })
    await assert.rejects(task, error => error instanceof Error && error.name === 'AbortError')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(f.processes.list().filter(p => p.status === 'running').length, 0)
    await assert.rejects(f.tool('shell').execute({ command: 'rm -rf /' }, { ...f.context, permission: 'full' }), /blocked/)
  } finally { await f.cleanup() }
})
test('Process tool lists and kills managed background tasks', async () => {
  const f = await setup()
  try {
    const result = JSON.parse(await f.tool('shell').execute({ command: 'node -e "setInterval(()=>{},1000)"', background: true, timeout: 20000 }, f.context))
    const list = await f.tool('process').execute({ action: 'list' }, f.context); assert.match(list, new RegExp(result.processId))
    await f.tool('process').execute({ action: 'kill', id: result.processId }, f.context)
    await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(f.processes.list().find(p => p.id === result.processId)?.status, 'exited')
  } finally { await f.cleanup() }
})
test('SQLite restores sessions, memory and skills; secrets are encrypted or kept in RAM', async () => {
  const key = randomBytes(32)
  const codec: SecureCodec = { available: () => true, encrypt: value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
    decrypt: data => { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString() } }
  const f = await setup(codec)
  try {
    f.store.setSecret('fixture', 'test-secret-not-plaintext')
    assert.doesNotMatch(await readFile(join(f.store.home, 'credentials.json'), 'utf8'), /test-secret-not-plaintext/)
    f.store.saveMemory('PREFERENCES.md', 'Keep code concise.')
    f.session.messages.push({ id: 'u', turnId: 't', role: 'user', content: 'persist me', createdAt: Date.now() })
    f.session.runtime = 'deskagent'
    f.store.saveSession(f.session)
    const second = new LocalStore(f.store.home, codec, f.workspace)
    assert.equal(second.getSession(f.session.id)?.messages[0]?.content, 'persist me')
    assert.equal(second.getSession(f.session.id)?.runtime, 'clax'); assert.equal(second.getSession(f.session.id)?.updatedAt, f.session.updatedAt)
    assert.equal(second.getSecret('fixture'), 'test-secret-not-plaintext'); assert.match(second.context(), /Keep code concise/)
    assert.equal(second.listSkills()[0]?.enabled, true); second.close()
    f.store.setSecret('fixture', '')
  } finally { await f.cleanup() }
  const volatile = await setup()
  try { volatile.store.setSecret('ram', 'ram-only'); assert.equal(volatile.store.getSecret('ram'), 'ram-only'); assert.doesNotMatch(await readFile(join(volatile.store.home, 'credentials.json'), 'utf8'), /ram-only/) }
  finally { await volatile.cleanup() }
})
test('Real compatible HTTP adapter handles fragmented tool calls, model switching, usage and retry', async () => {
  const f = await setup(), server = await fixtureServer(); const service = new AgentService(f.store, () => {})
  try {
    const input = { name: 'Fixture', kind: 'compatible' as const, baseUrl: server.url, apiKey: 'fixture-key', toolCalling: true }
    const models = await service.testProvider(input); assert.equal(models.length, 2)
    const p = await service.saveProvider({ ...input, modelIds: models.map(m => m.id), pricing: { input: 1, output: 2, cache: .5 } })
    const id = service.currentId; service.setModel(id, { provider: p.id, model: 'fixture-a' })
    service.send(id, 'files-fixture'); await service.waitForIdle(id)
    let snapshot = await service.bootstrap(); assert.equal(snapshot.session.messages.flatMap(m => m.activities ?? [])[0]?.name, 'list_directory')
    assert.match(snapshot.session.messages.find(m => m.role === 'tool')?.content ?? '', /package.json/)
    assert.equal(snapshot.session.usage.reportedRequests, 2); assert.equal(snapshot.session.usage.inputTokens, 240); assert.ok(snapshot.session.usage.estimatedCost! > 0)
    service.setModel(id, { provider: p.id, model: 'fixture-b' }); service.send(id, 'shell-fixture'); await service.waitForIdle(id)
    snapshot = await service.bootstrap(); assert.match(snapshot.session.messages.filter(m => m.role === 'tool').at(-1)!.content, /v\d+\./)
    assert.equal(server.requests.at(-1).model, 'fixture-b'); assert.equal(server.requests.at(-1).messages.filter((m: any) => m.role === 'user').length, 2)
    const target = snapshot.session.messages.filter(m => m.role === 'assistant').at(-1)!
    await service.retry(id, target.id); await service.waitForIdle(id)
    assert.equal((await service.bootstrap()).session.messages.filter(m => m.role === 'user').length, 2)
    await service.stop(id)
  } finally { await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('Steering skips stale unexecuted tools; Stop aborts a live HTTP request', async () => {
  const f = await setup(), server = await fixtureServer(); let service: AgentService
  service = new AgentService(f.store, event => { if (event.type === 'session' && event.event?.type === 'tool_started' && event.event.activity.name === 'shell') service.send(service.currentId, 'Do not write the file. Just report 42.') })
  try {
    const p = await service.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: server.url, toolCalling: true, modelIds: ['fixture-a'] })
    service.saveSettings({ ...f.store.settings, permissionMode: 'full' }); service.setModel(service.currentId, { provider: p.id, model: 'fixture-a' })
    service.send(service.currentId, 'steer-fixture'); await service.waitForIdle(service.currentId)
    const snapshot = await service.bootstrap()
    assert.equal(snapshot.session.messages.flatMap(m => m.activities ?? []).find(a => a.name === 'write_file')?.status, 'denied')
    await assert.rejects(access(join(f.workspace, 'must-not-exist.txt')))
    assert.match(server.requests.at(-1).messages.at(-1).content, /Do not write/)
    service.send(service.currentId, 'slow-fixture'); await new Promise(resolve => setTimeout(resolve, 120)); const start = Date.now(); await service.stop(service.currentId)
    assert.ok(Date.now() - start < 1000); assert.equal((await service.bootstrap()).runningSessions.length, 0)
    assert.equal((await service.bootstrap()).session.messages.filter(m => m.role === 'assistant').at(-1)?.status, 'stopped')
  } finally { await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('HTTP text streams incrementally; Pause preserves progress across restart and Resume uses it', async () => {
  const f = await setup(), server = await fixtureServer(), chunks: string[] = []
  const service = new AgentService(f.store, event => {
    if (event.type === 'session' && event.event?.type === 'text_delta') chunks.push(event.session.messages.at(-1)!.content)
  })
  try {
    const p = await service.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: server.url, toolCalling: true, modelIds: ['fixture-a'] })
    const id = service.currentId; service.setModel(id, { provider: p.id, model: 'fixture-a' })
    service.send(id, 'slow-fixture')
    const deadline = Date.now() + 3000
    while (chunks.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(chunks.length >= 2, 'Text must arrive while the request remains open')
    assert.ok(chunks[1]!.length > chunks[0]!.length)
    assert.deepEqual((await service.bootstrap()).runningSessions, [id])
    await service.pause(id)
    let state = await service.bootstrap(), partial = state.session.messages.at(-1)!
    assert.equal(state.session.paused, true); assert.equal(partial.status, 'paused'); assert.ok(partial.content.length)
    const retained = partial.content
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await service.bootstrap()).session.messages.at(-1)!.content, retained)
    const restoredStore = new LocalStore(f.store.home, volatileCodec, f.workspace)
    const restored = new AgentService(restoredStore, () => {})
    try {
      assert.equal((await restored.bootstrap()).session.paused, true)
      restored.resume(id); await restored.waitForIdle(id)
      state = await restored.bootstrap()
      assert.equal(state.session.paused, false); assert.equal(state.session.messages.at(-1)!.status, 'complete')
      assert.ok(server.requests.at(-1).messages.some((m: any) => m.role === 'assistant' && m.content === retained))
      assert.match(server.requests.at(-1).messages.at(-1).content, /继续刚才暂停/)
    } finally { await restored.shutdown() }
  } finally { await service.stop(service.currentId); await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('Steer interrupts an unfinished model response and follows the new instruction', async () => {
  const f = await setup(), server = await fixtureServer()
  let service: AgentService, sent = false
  service = new AgentService(f.store, event => {
    if (!sent && event.type === 'session' && event.event?.type === 'text_delta') {
      sent = true; service.send(service.currentId, 'Change direction. Only reply with the new goal.')
    }
  })
  try {
    const p = await service.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: server.url, toolCalling: true, modelIds: ['fixture-a'] })
    service.setModel(service.currentId, { provider: p.id, model: 'fixture-a' })
    service.send(service.currentId, 'slow-fixture')
    await Promise.race([service.waitForIdle(service.currentId), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Steer did not interrupt the open HTTP stream')), 3000); timer.unref() })])
    const state = await service.bootstrap()
    assert.equal(state.session.messages.find(m => m.role === 'assistant')?.status, 'interrupted')
    assert.match(state.session.messages.at(-1)!.content, /new goal/)
    assert.equal(server.requests.length, 2)
  } finally { await service.stop(service.currentId); await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('Full access defaults persist while explicit confirmation modes survive restart', async () => {
  const f = await setup()
  try {
    assert.equal(f.store.settings.permissionMode, 'full')
    assert.equal(f.store.settings.maxContextChars / 3, 256000)
    for (const mode of ['ask', 'auto', 'full'] as const) {
      f.store.saveSettings({ ...f.store.settings, permissionMode: mode })
      const restored = new LocalStore(f.store.home, volatileCodec, f.workspace)
      try { assert.equal(restored.settings.permissionMode, mode) } finally { restored.close() }
    }
  } finally { await f.cleanup() }
})
test('Switching to full access releases all pending sessions and subsequent tool calls', { timeout: 10000 }, async () => {
  const f = await setup(), server = await fixtureServer()
  let requests = 0, ready!: () => void
  const waiting = new Promise<void>(resolve => { ready = resolve })
  const service = new AgentService(f.store, event => {
    if (event.type === 'session' && event.event?.type === 'approval_requested' && ++requests === 2) ready()
  })
  try {
    const p = await service.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: server.url, toolCalling: true, modelIds: ['fixture-a'] })
    service.saveSettings({ ...f.store.settings, permissionMode: 'ask' })
    const first = service.currentId
    service.setModel(first, { provider: p.id, model: 'fixture-a' })
    const second = (await service.newSession()).session.id
    service.send(first, 'permissions-fixture'); service.send(second, 'shell-fixture')
    await waiting
    assert.equal((await service.bootstrap()).approvals.length, 2)
    service.saveSettings({ ...f.store.settings, permissionMode: 'full' })
    assert.equal((await service.bootstrap()).approvals.length, 0)
    await Promise.all([service.waitForIdle(first), service.waitForIdle(second)])
    assert.equal(requests, 2, 'The write following the approved shell must not request approval again')
    assert.equal(await readFile(join(f.workspace, 'approved.txt'), 'utf8'), 'Full access continued the tool batch.')
    assert.ok((await service.openSession(first)).session.messages.flatMap(m => m.activities ?? []).every(a => a.status === 'done'))
    const restored = new LocalStore(f.store.home, volatileCodec, f.workspace)
    try { assert.equal(restored.settings.permissionMode, 'full') } finally { restored.close() }
    // Changing back to Ask restores the normal confirmation path.
    service.saveSettings({ ...f.store.settings, permissionMode: 'ask' })
    service.send(first, 'shell-fixture')
    const deadline = Date.now() + 2000
    while (!(await service.bootstrap()).approvals.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    const approval = (await service.bootstrap()).approvals[0]!
    assert.ok(approval); service.approve(approval.id, false); await service.waitForIdle(first)
    assert.equal((await service.bootstrap()).session.messages.flatMap(m => m.activities ?? []).at(-1)?.status, 'denied')
  } finally { for (const id of (await service.bootstrap()).runningSessions) await service.stop(id); await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('An in-flight tool with an old permission snapshot honors a new full access grant', { timeout: 10000 }, async () => {
  const f = await setup(), server = await fixtureServer()
  let service: AgentService, changed = false, requests = 0
  service = new AgentService(f.store, event => {
    if (event.type === 'session' && event.event?.type === 'approval_requested') requests++
    if (!changed && event.type === 'session' && event.event?.type === 'tool_started') {
      changed = true
      // Defer until execute() captured Ask and yielded for its filesystem checks.
      queueMicrotask(() => service.saveSettings({ ...f.store.settings, permissionMode: 'full' }))
    }
  })
  try {
    const p = await service.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: server.url, toolCalling: true, modelIds: ['fixture-a'] })
    service.saveSettings({ ...f.store.settings, permissionMode: 'ask' }); service.setModel(service.currentId, { provider: p.id, model: 'fixture-a' })
    service.send(service.currentId, 'permissions-fixture'); await service.waitForIdle(service.currentId)
    assert.equal(requests, 0)
    assert.equal(await readFile(join(f.workspace, 'approved.txt'), 'utf8'), 'Full access continued the tool batch.')
  } finally { await service.stop(service.currentId); await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('Steer cancels a pending approval and drops the old remaining tool plan', async () => {
  const f = await setup(), server = await fixtureServer()
  let service: AgentService
  service = new AgentService(f.store, event => {
    if (event.type === 'session' && event.event?.type === 'approval_requested') service.send(service.currentId, 'Do not run anything. Only explain.')
  })
  try {
    const p = await service.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: server.url, toolCalling: true, modelIds: ['fixture-a'] })
    service.saveSettings({ ...f.store.settings, permissionMode: 'ask' }); service.setModel(service.currentId, { provider: p.id, model: 'fixture-a' })
    service.send(service.currentId, 'steer-fixture'); await service.waitForIdle(service.currentId)
    const state = await service.bootstrap()
    assert.equal(state.approvals.length, 0)
    assert.equal(service.processes.list().length, 0)
    assert.equal(state.session.messages.flatMap(m => m.activities ?? []).find(a => a.name === 'write_file')?.status, 'denied')
    await assert.rejects(access(join(f.workspace, 'must-not-exist.txt')))
  } finally { await service.stop(service.currentId); await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('Pause cancels executing tools, preserves tool pairs, and Stop clears paused state', async () => {
  const f = await setup(), server = await fixtureServer()
  let service: AgentService, pausing: Promise<void> | undefined
  service = new AgentService(f.store, event => {
    if (event.type === 'session' && event.event?.type === 'tool_started' && event.event.activity.name === 'shell') pausing = service.pause(service.currentId)
  })
  try {
    const p = await service.saveProvider({ name: 'Fixture', kind: 'compatible', baseUrl: server.url, toolCalling: true, modelIds: ['fixture-a'] })
    service.saveSettings({ ...f.store.settings, permissionMode: 'full' }); service.setModel(service.currentId, { provider: p.id, model: 'fixture-a' })
    service.send(service.currentId, 'steer-fixture'); await service.waitForIdle(service.currentId); await pausing
    let state = await service.bootstrap()
    assert.equal(state.session.paused, true)
    const calls = state.session.messages.flatMap(m => m.toolCalls ?? [])
    for (const call of calls) assert.equal(state.session.messages.filter(m => m.toolCallId === call.id).length, 1)
    assert.equal(service.processes.list().filter(p => p.status === 'running').length, 0)
    await assert.rejects(access(join(f.workspace, 'must-not-exist.txt')))
    await service.stop(service.currentId); state = await service.bootstrap()
    assert.equal(state.session.paused, false); assert.equal(state.session.messages.filter(m => m.role === 'assistant').at(-1)!.status, 'stopped')
  } finally { await service.stop(service.currentId); await service.processes.shutdown(); await server.close(); await f.cleanup() }
})
test('LLM rolling summary preserves recent raw turns and bounded memory context', async () => {
  const f = await setup(); const requests: ModelRequest[] = [], events: AgentEvent[] = []
  try {
    const provider: ModelProvider = { id: 'summary', name: 'Summary', listModels: async () => [], capabilities: () => ({ tools: true }),
      async *stream(request): AsyncIterable<ModelEvent> { requests.push(request); yield { type: 'text', text: request.tools.length ? 'Final reply.' : '## 目标与约束\nSummary preserves paths, decisions and pending work.\n## 决策与关键标识\nKeep paths.\n## 已验证结果\nNo tools run.\n## 待办与风险\nContinue the latest request.' } } }
    for (let i = 0; i < 8; i++) f.session.messages.push({ id: String(i), turnId: String(Math.floor(i / 2)), role: i % 2 ? 'assistant' : 'user', content: i >= 6 ? 'Keep this recent turn intact.' : `Turn ${i}: ${'context '.repeat(900)}`, createdAt: Date.now(), status: 'complete' })
    f.session.currentModel = { provider: 'summary', model: 'test' }
    for await (const event of new LocalAgentRuntime(() => 16000).runTurn(f.session, f.session.currentModel, createTools(f.store, f.processes), f.context.signal,
      { provider: () => provider, context: () => f.store.context(), takeSteering: () => [], permission: () => 'auto', approve: async () => true })) events.push(event)
    assert.ok(f.session.summarizedCount > 0); assert.match(f.session.summary, /preserves paths/); assert.ok(events.some(e => e.type === 'summary_updated'))
    assert.ok(requests.at(-1)!.messages.reduce((n, m) => n + m.content.length, 0) < 5000)
    assert.ok(requestTokens(requests.at(-1)!.system, requests.at(-1)!.messages, requests.at(-1)!.tools) <= f.session.contextState!.budgetTokens)
    assert.equal(f.session.messages.length, 9)
  } finally { await f.cleanup() }
})
test('Step budget ends long tool loops with a summary instead of an error', async () => {
  const f = await setup(); const requests: ModelRequest[] = [], events: AgentEvent[] = []
  try {
    let n = 0
    const provider: ModelProvider = { id: 'loop', name: 'Loop', listModels: async () => [], capabilities: () => ({ tools: true }),
      async *stream(request): AsyncIterable<ModelEvent> {
        requests.push(request)
        yield { type: 'text', text: `step ${++n}` }
        yield { type: 'tool_call', call: { id: `c${n}`, name: 'list_directory', arguments: { path: '.' } } } // always wants more tools
      } }
    f.session.messages.push({ id: 'u', turnId: 't', role: 'user', content: 'loop forever', createdAt: Date.now(), status: 'complete' })
    f.session.currentModel = { provider: 'loop', model: 'test' }
    for await (const event of new LocalAgentRuntime(() => 64000).runTurn(f.session, f.session.currentModel, createTools(f.store, f.processes), f.context.signal,
      { provider: () => provider, context: () => f.store.context(), takeSteering: () => [], permission: () => 'auto', approve: async () => true })) events.push(event)
    assert.equal(requests.length, MAX_STEPS)
    assert.match(requests.at(-1)!.system, /Step budget for this turn is exhausted/)
    assert.ok(!events.some(e => e.type === 'error'))
    assert.deepEqual(events.at(-1), { type: 'turn_finished', status: 'complete' })
    const last = f.session.messages.filter(m => m.role === 'tool').at(-1)!
    assert.match(last.content, /step budget/) // the final tool call is not executed
  } finally { await f.cleanup() }
})
