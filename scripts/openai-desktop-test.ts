import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openAIFixture } from '../tests/openai-fixture'
import { openRouterFixture } from '../tests/openrouter-fixture'

const fixture = await openAIFixture(), router = await openRouterFixture(), project = resolve('.')
const home = resolve(`test-results/openai-desktop-${Date.now()}`), workspace = join(home, 'workspace')
await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'fixture.txt'), 'Desktop Responses source fixture.')
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.OPENAI_API_KEY; delete env.OPENROUTER_API_KEY
let desktop: ElectronApplication | undefined
let page!: Page
const checks: string[] = [], errors: string[] = []
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`) }
async function launch() {
  desktop = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [`--user-data-dir=${join(home, 'profile')}`, project], cwd: workspace, env })
  page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message))
  await page.waitForFunction(() => Boolean(window.clax)); await page.evaluate(() => window.clax.expand())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Expand Clax' }), () => page.evaluate(() => window.clax.expand()))
}
const snapshot = () => page.evaluate(() => window.clax.bootstrap())
const idle = () => expect.poll(async () => (await snapshot()).runningSessions.length).toBe(0)
async function send(text: string) { await page.getByTestId('composer').fill(text); await page.getByTestId('composer').press('Enter'); await idle() }
try {
  await launch()
  await page.evaluate(async () => {
    const state = await window.clax.bootstrap()
    await window.clax.saveSettings({ ...state.settings, memory: { enabled: false, autoCapture: false } })
  })
  async function add(kind: 'openai' | 'openrouter', name: string, baseUrl: string) {
    return page.evaluate(async input => {
      const models = await window.clax.testProvider(input)
      return window.clax.saveProvider({ ...input, modelIds: models.map(m => m.id) })
    }, { kind, name, baseUrl, apiKey: 'fixture-key', toolCalling: true })
  }
  const r = await add('openrouter', 'OpenRouter fixture', router.url), p = await add('openai', 'OpenAI', fixture.url)
  const ids = { openai: p.id, router: r.id }
  await page.evaluate(async r => { const s = await window.clax.bootstrap(); await window.clax.setModel(s.session.id, { provider: r.id, model: r.models[0]!.id }) }, r)
  await send('fixture baseline')
  await expect(page.getByTestId('balance-button')).toContainText('$13.00')
  await page.getByTestId('model-picker').click()
  await page.getByRole('combobox', { name: 'Model provider', exact: true }).selectOption(ids.openai)
  await expect(page.locator('.model-options')).not.toContainText('Claude fixture')
  await page.locator('.model-options').getByRole('button', { name: /GPT-6.1 Sol/ }).click()
  await page.getByTestId('model-picker').click()
  await expect(page.getByRole('combobox', { name: 'Model provider', exact: true })).toHaveValue(ids.openai)
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
  await expect(effort.locator('option')).toHaveCount(6)
  await expect(effort.locator('option[value="none"]')).toHaveCount(0)
  await effort.selectOption('high'); await page.getByTestId('model-picker').click()
  check('The model menu follows the selected provider and exposes GPT-6.1 Sol reasoning levels')
  await send('tool-fixture')
  expect(fixture.calls).toHaveLength(2)
  expect(fixture.calls[1].input.filter((i: any) => i.type === 'function_call_output' && i.call_id.startsWith('call_1_'))).toHaveLength(2)
  expect(fixture.calls[1].input.some((i: any) => i.type === 'function_call_output' && i.call_id === 'call-1')).toBe(true)
  expect(fixture.calls[1].input.some((i: any) => i.encrypted_content)).toBe(true)
  expect((await snapshot()).session.messages.flatMap(m => m.activities ?? []).slice(-2).map(a => a.status)).toEqual(['done', 'done'])
  await expect(page.locator('.assistant-message').last()).toContainText('Responses fixture reply.')
  check('The built Responses adapter executes multiple local tools and replays complete reasoning and results')
  await expect(page.getByTestId('balance-button')).toContainText('OpenAI 用量')
  await expect(page.getByTestId('balance-button')).not.toContainText('$13.00')
  await page.getByTestId('balance-button').click(); await page.getByRole('button', { name: 'Refresh usage' }).click()
  await expect(page.getByTestId('usage-panel')).toContainText('OpenAI · 模型用量')
  await expect(page.getByRole('button', { name: '打开 OpenAI 账单' })).toBeVisible()
  await expect(page.getByTestId('model-usage-row')).toHaveCount(1)
  await expect(page.getByTestId('model-usage-row')).toContainText('GPT-6.1 Sol')
  // Keyboard focus exercises the same details without depending on the desktop pointer/focus owner.
  await page.getByTestId('model-usage-row').focus()
  await expect(page.getByRole('tooltip')).toContainText('输入 200')
  await expect(page.getByRole('tooltip')).toContainText('缓存命中 80')
  await expect(page.getByRole('tooltip')).toContainText('输出 20')
  await expect(page.getByRole('tooltip')).toContainText('API 费用 —')
  await page.screenshot({ path: 'test-results/openai-usage.png' })
  await page.getByTestId('balance-button').click()
  check('OpenAI shows only its own token bars and billing entry, without OpenRouter balances or usage')
  await page.getByTestId('composer').fill('slow-fixture'); await page.getByTestId('composer').press('Enter')
  await expect.poll(async () => (await snapshot()).session.messages.at(-1)?.content.length ?? 0).toBeGreaterThan(0)
  await page.getByTestId('pause').click(); await idle()
  const partial = (await snapshot()).session.messages.at(-1)!.content
  await page.getByTestId('resume').click(); await idle()
  expect(fixture.calls.at(-1).input.some((i: any) => i.role === 'assistant' && i.content === partial)).toBe(true)
  check('Pause and Resume keep partial Responses output and continue with retained context')
  await page.getByTestId('composer').fill('slow-fixture'); await page.getByTestId('composer').press('Enter')
  await expect.poll(async () => (await snapshot()).session.messages.at(-1)?.content.length ?? 0).toBeGreaterThan(0)
  await page.getByTestId('composer').fill('steered-fixture'); await page.getByRole('button', { name: 'Steer agent', exact: true }).click(); await idle()
  expect(fixture.calls.at(-1).input.some((i: any) => i.role === 'user' && i.content === 'steered-fixture')).toBe(true)
  expect((await snapshot()).session.messages.filter(m => m.status === 'interrupted').every(m => !m.responseItems)).toBe(true)
  check('Steer cancels the old Responses stream and omits its unfinished native plan')
  await page.getByTestId('composer').fill('slow-fixture'); await page.getByTestId('composer').press('Enter')
  await expect.poll(async () => (await snapshot()).session.messages.at(-1)?.content.length ?? 0).toBeGreaterThan(0)
  await page.getByTestId('stop').click(); await idle()
  expect((await snapshot()).session.messages.at(-1)!.status).toBe('stopped')
  check('Stop cancels an in-flight Responses request')
  await page.getByRole('button', { name: 'Web search settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Search provider', exact: true }).selectOption('openai')
  await page.getByRole('button', { name: 'Save search settings', exact: true }).click()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await send('search-fixture')
  expect(fixture.calls.at(-1).tools.some((t: any) => t.type === 'web_search')).toBe(true)
  expect(fixture.calls.at(-1).tools.some((t: any) => t.type === 'openrouter:web_search' || t.name === 'web_search')).toBe(false)
  await expect(page.getByTestId('web-sources').getByRole('link')).toHaveAttribute('href', 'https://docs.python.org/3/library/asyncio-task.html')
  await expect(page.getByTestId('web-search-count')).toContainText('1 次')
  check('OpenAI native search uses Responses, shares local tools, and displays validated sources and returned calls')
  await desktop!.close(); desktop = undefined; await launch()
  expect((await snapshot()).session.currentModel).toEqual({ provider: ids.openai, model: 'gpt-6.1-sol', reasoningEffort: 'high' })
  expect((await snapshot()).session.messages.some(m => m.responseItems?.some(i => i.encrypted_content))).toBe(true)
  await expect(page.getByTestId('balance-button')).toContainText('OpenAI 用量')
  await page.getByTestId('model-picker').click()
  await expect(page.getByRole('combobox', { name: 'Model provider', exact: true })).toHaveValue(ids.openai)
  await page.getByRole('combobox', { name: 'Model provider', exact: true }).selectOption(ids.router)
  await page.locator('.model-options').getByRole('button', { name: /Claude fixture/ }).click()
  await expect(page.getByTestId('balance-button')).toContainText('$13.00')
  check('Restart retains provider, reasoning and native items; selecting OpenRouter restores its own balance')
  expect(errors).toEqual([])
  await writeFile('test-results/openai-desktop-validation.json', JSON.stringify({ checks, fixture: true, home, errors }, null, 2))
} finally { await desktop?.close(); await fixture.close(); await router.close() }
