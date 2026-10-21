import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { exampleExtension } from '../src/main/extension-examples'
import type { ExtensionPackage } from '../src/shared/extensions'

const require = createRequire(import.meta.url), home = resolve(`test-results/extensions-desktop-${Date.now()}`)
await mkdir(home, { recursive: true })
const checks: string[] = [], errors: string[] = [], requests: any[] = []
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`) }
const server = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
  let raw = ''; for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw); requests.push(body)
  const last = body.messages.findLastIndex((m: any) => m.role === 'user'), prompt = body.messages[last].content
  const results = body.messages.slice(last + 1).filter((m: any) => m.role === 'tool')
  const gmail = prompt.includes('gmail'), broken = prompt.includes('broken'), updated = prompt.includes('update')
  const value: ExtensionPackage = gmail ? exampleExtension('gmail') : { manifest: { id: 'fixture', version: updated ? '1.1.0' : '1.0.0', name: 'Fixture 开发的插件', description: 'Scripted HTTP fixture validates the complete installation pipeline.', hosts: [], methods: ['GET'], tools: [
    { name: 'echo', description: 'Return a query from the newly installed tool', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] },
    code: `function run(tool,input){return {query:input.query,version:${updated ? 2 : 1}}}`,
    tests: [{ tool: 'echo', input: { query: 'fixture' }, expected: broken ? 'wrong expectation' : { query: 'fixture', version: updated ? 2 : 1 }, responses: [] }] }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let name = '', args: Record<string, unknown> = {}
  if (!results.length) { name = 'extension_manage'; args = { action: 'stage', package: value } }
  else if (results.length === 1) { name = 'extension_manage'; args = { action: 'install', id: value.manifest.id } }
  else if (results.length === 2 && !gmail && !broken) { name = 'ext_fixture_echo'; args = { query: 'used in the same turn' } }
  const delta = name ? { tool_calls: [{ index: 0, id: `fixture-${requests.length}`, function: { name, arguments: JSON.stringify(args) } }] } : { content: gmail ? '插件已安装，Gmail 需要你在 Extensions 中授权。' : broken ? '草稿测试未通过，原插件继续可用。' : '开发、测试、安装、调用全部完成。' }
  response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address() as { port: number }
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let desktop: ElectronApplication | undefined
async function launch() {
  desktop = await electron.launch({ executablePath: require('electron'), args: [`--user-data-dir=${join(home, 'chromium')}`, '.'], cwd: resolve('.'), env, timeout: 30000 })
  const page = await desktop.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.clax))
  await page.evaluate(() => window.clax.expand())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Expand Clax' }), () => page.evaluate(() => window.clax.expand()))
  return page
}
try {
  let page = await launch()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Extensions', exact: true }).click()
  await expect(page.getByText('还没有插件。', { exact: false })).toBeVisible()
  check('Extensions settings start empty without installing or connecting anything automatically')
  await page.getByRole('button', { name: 'Close settings' }).click()
  const provider = await page.evaluate(async baseUrl => {
    const s = await window.clax.bootstrap(); await window.clax.saveSettings({ ...s.settings, maxContextChars: 100000, memory: { enabled: false, autoCapture: false } })
    const p = await window.clax.saveProvider({ name: 'Protocol fixture', kind: 'compatible', baseUrl, modelIds: ['fixture'], toolCalling: true, contextWindow: 128000 })
    await window.clax.setModel(s.session.id, { provider: p.id, model: 'fixture' }); return p.id
  }, `http://127.0.0.1:${address.port}/v1`)
  const id = (await page.evaluate(() => window.clax.bootstrap())).session.id
  async function send(prompt: string) {
    await page.evaluate(({ id, prompt }) => window.clax.send(id, prompt), { id, prompt })
    await expect.poll(async () => (await page.evaluate(() => window.clax.bootstrap())).runningSessions.length, { timeout: 20000 }).toBe(0)
  }
  await send('extension fixture')
  let state = await page.evaluate(() => window.clax.bootstrap())
  expect(state.extensions.find(item => item.id === 'fixture')?.enabled).toBe(true)
  expect(state.session.messages.find(m => m.toolName === 'ext_fixture_echo')?.content).toContain('used in the same turn')
  expect(requests.some(request => request.tools.some((tool: any) => tool.function?.name === 'ext_fixture_echo'))).toBe(true)
  check('Real HTTP adapter and Electron worker stage, test, install and hot-load the tool in one model turn')
  await send('extension broken fixture')
  state = await page.evaluate(() => window.clax.bootstrap())
  expect(state.extensions.find(item => item.id === 'fixture')?.version).toBe('1.0.0')
  expect(state.extensions.find(item => item.id === 'fixture')?.draft?.tested).toBe(false)
  check('Failing draft tests keep the installed tool and version active')
  await send('extension update fixture')
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Extensions', exact: true }).click()
  const card = page.getByTestId('extension-fixture')
  await expect(card).toContainText('v1.1.0')
  await card.getByRole('button', { name: '回退上一版本' }).click(); await expect(card).toContainText('v1.0.0')
  await card.getByRole('switch').click(); await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  expect((await page.evaluate(() => window.clax.bootstrap())).tools.some(tool => tool.name === 'ext_fixture_echo')).toBe(false)
  await card.getByRole('switch').click(); await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  check('UI can roll back, disable and re-enable installed plugin tools')
  await page.getByRole('button', { name: 'Close settings' }).click(); await send('extension gmail fixture')
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Extensions', exact: true }).click()
  const gmail = page.getByTestId('extension-gmail')
  await expect(gmail).toContainText('连接 Gmail（只读）')
  await gmail.getByRole('button', { name: '在浏览器中授权' }).click()
  await expect(gmail.getByRole('alert')).toContainText('OAuth Client ID')
  expect((await page.evaluate(() => window.clax.bootstrap())).extensions.find(item => item.id === 'gmail')?.connected).toBe(false)
  check('Gmail shows real OAuth configuration requirements; missing credentials never appear connected')
  await page.screenshot({ path: resolve('test-results/extensions.png') })
  await desktop!.close(); desktop = undefined
  page = await launch(); state = await page.evaluate(() => window.clax.bootstrap())
  expect(state.extensions.find(item => item.id === 'fixture')?.version).toBe('1.0.0')
  expect(state.extensions.find(item => item.id === 'fixture')?.enabled).toBe(true)
  expect(state.providers.some(p => p.id === provider)).toBe(true)
  check('Installed versions, enabled state and provider configuration survive Electron restart')
  if (errors.length) throw new Error(errors.join('\n'))
} catch (error) { errors.push((error as Error).message); throw error }
finally {
  await writeFile('test-results/extensions-desktop-validation.json', JSON.stringify({ date: new Date().toISOString(), home, model: 'Scripted local HTTP fixture', checks, errors,
    limitations: ['No real Gmail account authorization or mail access; OAuth uses independent callback protocol tests.'] }, null, 2) + '\n')
  await desktop?.close(); server.close(); server.closeAllConnections()
}
