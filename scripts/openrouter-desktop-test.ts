import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { openRouterFixture } from '../tests/openrouter-fixture'

const fixture = await openRouterFixture(), project = resolve('.'), home = resolve(`test-results/openrouter-desktop-${Date.now()}`), workspace = join(home, 'workspace')
await mkdir(workspace, { recursive: true })
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let desktop: ElectronApplication | undefined
const checks: string[] = [], errors: string[] = [], check = (name: string) => { checks.push(name); console.log(`PASS ${name}`) }
async function launch() {
  desktop = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [`--user-data-dir=${join(home, 'chromium')}`, project], env, cwd: workspace })
  const page = await desktop.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.clax)); await page.evaluate(() => window.clax.expand())
  await page.addLocatorHandler(page.getByRole('button', { name: 'Expand Clax' }), () => page.evaluate(() => window.clax.expand()))
  return page
}
try {
  let page = await launch()
  const provider = await page.evaluate(async baseUrl => {
    const s = await window.clax.bootstrap(); await window.clax.saveSettings({ ...s.settings, memory: { enabled: false, autoCapture: false } })
    const input = { name: 'OpenRouter fixture', kind: 'openrouter' as const, baseUrl, apiKey: 'fixture-key', toolCalling: true }
    const models = await window.clax.testProvider(input), p = await window.clax.saveProvider({ ...input, modelIds: models.map(m => m.id) })
    await window.clax.setModel(s.session.id, { provider: p.id, model: p.models[0]!.id })
    return p
  }, fixture.url)
  await expect(page.getByTestId('balance-button')).toContainText('$13.00')
  await page.getByTestId('balance-button').click()
  await expect(page.getByTestId('usage-panel')).toBeVisible()
  await expect(page.getByTestId('model-usage-row')).toHaveCount(0)
  await expect(page.getByText('还没有模型用量，使用后会显示在这里。')).toBeVisible()
  check('Account balance is visible in the header; one click opens model usage without unused-model bars')
  await page.getByTestId('balance-button').click()
  await page.getByTestId('model-picker').click()
  await expect(page.locator('.model-options').getByRole('button', { name: /Claude fixture/ })).toBeVisible()
  await expect(page.locator('.model-options').getByRole('button', { name: /GPT fixture/ })).toBeVisible()
  await expect(page.locator('.model-options').getByRole('button', { name: /DeepSeek fixture/ })).toBeVisible()
  const effort = page.getByRole('combobox', { name: 'Reasoning effort' })
  await expect(effort.locator('option[value="none"]')).toHaveCount(0)
  await effort.selectOption('low')
  await expect(effort).toHaveValue('low')
  await page.getByRole('button', { name: '全部模型', exact: true }).click()
  await expect(page.getByRole('button', { name: /text-chat/ })).toBeVisible()
  await page.getByTestId('model-picker').click()
  check('Common Claude/GPT/DeepSeek models, full catalogue and per-model reasoning choices are available')
  const id = (await page.evaluate(() => window.clax.bootstrap())).session.id
  async function send(text: string) {
    await page.evaluate(({ id, text }) => window.clax.send(id, text), { id, text })
    await expect.poll(async () => (await page.evaluate(() => window.clax.bootstrap())).runningSessions.length).toBe(0)
  }
  await send('fixture one'); await send('fixture two')
  expect(fixture.calls[0].reasoning).toEqual({ effort: 'low' })
  expect(fixture.calls[1].messages.find((m: any) => m.reasoning_details)?.reasoning_details[0].data).toBe('opaque-block')
  await page.getByTestId('model-picker').click(); await page.locator('.model-options').getByRole('button', { name: /GPT fixture/ }).click()
  await page.getByTestId('model-picker').click(); await effort.selectOption('high'); await page.getByTestId('model-picker').click()
  await send('fixture three')
  expect(fixture.calls.at(-1).reasoning).toEqual({ effort: 'high' })
  check('Selected reasoning effort reaches HTTP; encrypted reasoning survives a real tool loop and model switching')
  await page.getByTestId('balance-button').click(); await page.getByRole('button', { name: 'Refresh usage' }).click()
  const rows = page.getByTestId('model-usage-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Claude fixture')
  await expect(rows.nth(0).locator('.usage-bar-fill')).toHaveAttribute('style', 'width: 100%;')
  await expect(rows.nth(1).locator('.usage-bar-fill')).toHaveAttribute('style', 'width: 50%;')
  await rows.first().hover()
  await expect(page.getByRole('tooltip')).toContainText('输入 400')
  await expect(page.getByRole('tooltip')).toContainText('缓存命中 160')
  await expect(page.getByRole('tooltip')).toContainText('输出 40')
  await expect(page.getByRole('tooltip')).toContainText('API 费用 $0.004')
  await page.screenshot({ path: 'test-results/openrouter-usage.png' })
  check('Used models have proportional rounded bars; hover shows input/cache/output and API-reported cost')
  await desktop!.close(); desktop = undefined
  page = await launch()
  const state = await page.evaluate(() => window.clax.bootstrap())
  expect(state.session.messages.filter(m => m.role === 'user')).toHaveLength(3)
  expect(state.session.currentModel).toMatchObject({ provider: provider.id, model: 'openai/gpt-6-sol', reasoningEffort: 'high' })
  expect((await page.evaluate(() => window.clax.usageSummary())).total.inputTokens).toBe(600)
  await expect(page.getByTestId('balance-button')).toContainText('$13.00')
  check('Model, effort, conversations and per-model usage persist across Electron restart')
  fixture.forbidCredits()
  await page.getByTestId('balance-button').click(); await page.getByRole('button', { name: 'Refresh usage' }).click()
  await expect(page.getByTestId('usage-panel')).toContainText('账户余额暂不可用')
  await expect(page.getByTestId('balance-button')).not.toContainText('$13.00')
  await expect(page.getByTestId('model-usage-row')).toHaveCount(2)
  check('Restricted credits access never becomes a false zero balance; local usage remains available')
  await page.getByRole('button', { name: 'Web search settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Search provider', exact: true }).selectOption('openrouter')
  await page.getByRole('button', { name: 'Save search settings', exact: true }).click()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Web search settings', exact: true })).toContainText('已启用')
  await send('search fixture')
  expect(fixture.calls.at(-1).tools.some((t: any) => t.type === 'openrouter:web_search' && t.parameters.engine === 'native')).toBe(true)
  expect(fixture.calls.at(-1).tools.some((t: any) => t.function?.name === 'web_search')).toBe(false)
  await expect(page.getByTestId('web-search-count')).toContainText('1 次')
  await expect(page.getByTestId('web-sources').getByRole('link')).toHaveAttribute('href', 'https://docs.python.org/3/library/asyncio-task.html')
  await expect(page.locator('.markdown').getByRole('link', { name: '1', exact: true })).toHaveAttribute('href', 'https://docs.python.org/3/library/asyncio-task.html')
  expect((await page.evaluate(() => window.clax.usageSummary())).total.webSearchRequests).toBe(1)
  await page.screenshot({ path: 'test-results/openrouter-native-search.png' })
  await desktop!.close(); desktop = undefined; page = await launch()
  expect((await page.evaluate(() => window.clax.bootstrap())).settings.search.kind).toBe('openrouter')
  await expect(page.getByTestId('web-sources')).toBeVisible()
  expect((await page.evaluate(() => window.clax.usageSummary())).total.webSearchRequests).toBe(1)
  check('Native search runs alongside local tools, renders clickable inline sources and persists citations/search usage across restart')
  await page.getByRole('button', { name: 'Web search settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Search provider', exact: true }).selectOption('none')
  await page.getByRole('button', { name: 'Save search settings', exact: true }).click()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await send('search disabled fixture')
  expect(fixture.calls.at(-1).tools.some((t: any) => t.type === 'openrouter:web_search')).toBe(false)
  expect((await page.evaluate(() => window.clax.bootstrap())).session.messages.at(-1)?.citations).toBeUndefined()
  check('Disabling web search removes the server tool from subsequent requests without inventing search results')
  if (errors.length) throw new Error(errors.join('\n'))
} catch (error) { errors.push((error as Error).message); throw error }
finally {
  await writeFile('test-results/openrouter-desktop-validation.json', JSON.stringify({ date: new Date().toISOString(), home, checks, errors, model: 'Scripted local HTTP fixture; not a live account' }, null, 2) + '\n')
  await desktop?.close(); await fixture.close()
}
