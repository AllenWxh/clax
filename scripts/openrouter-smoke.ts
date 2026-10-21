import { _electron as electron, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { commonModels } from '../src/shared/models'

// Uses the installed encrypted key in an isolated Electron store; never prints/decrypts it into a script file.
await mkdir('test-results', { recursive: true })
const project = resolve('.'), home = await mkdtemp(resolve('test-results/openrouter-live-')), workspace = join(home, 'workspace')
await mkdir(workspace); await writeFile(join(workspace, 'verification.txt'), 'Clax OpenRouter live verification\n')
for (const name of ['providers.json', 'credentials.json']) { await copyFile(join(homedir(), '.clax', name), join(home, name)); await chmod(join(home, name), 0o600) }
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const desktop = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [`--user-data-dir=${join(home, 'chromium')}`, project], cwd: workspace, env })
const report: Record<string, unknown> = { date: new Date().toISOString(), home, realModel: true, errors: [] }
try {
  const page = await desktop.firstWindow(); await page.waitForFunction(() => Boolean(window.clax))
  await page.evaluate(() => { (window as any).smokeErrors = []; window.clax.onEvent(event => { if (event.type === 'session' && event.event?.type === 'error') (window as any).smokeErrors.push(event.event.error) }) })
  const state = await page.evaluate(() => window.clax.bootstrap()), provider = state.providers.find(p => p.kind === 'openrouter')!
  report.hasKey = provider.hasKey
  if (!provider.hasKey) throw new Error('The copied credential could not be decrypted in this Electron profile')
  const model = commonModels(provider.models).find(m => m.id.startsWith('anthropic/') && m.tools && m.reasoningEfforts?.includes('low'))
  if (!model) throw new Error('No current Claude model with low effort and tools found')
  await page.evaluate(async ({ id, ref }) => {
    const s = await window.clax.bootstrap()
    await window.clax.saveSettings({ ...s.settings, memory: { enabled: false, autoCapture: false }, disabledTools: s.tools.filter(t => t.name !== 'list_directory').map(t => t.name) })
    await window.clax.setModel(id, ref)
    await window.clax.send(id, 'Clax 接入验证：先调用一次 list_directory，path 为 .，确认 verification.txt 存在；然后只回复 CLAX_OPENROUTER_OK。不需要其他操作。')
  }, { id: state.session.id, ref: { provider: provider.id, model: model.id, reasoningEffort: 'low' as const } })
  try { await expect.poll(async () => (await page.evaluate(() => window.clax.bootstrap())).runningSessions.length, { timeout: 120000 }).toBe(0) }
  catch (error) { await page.evaluate(id => window.clax.stop(id), state.session.id); throw error }
  const result = await page.evaluate(() => window.clax.bootstrap()), activities = result.session.messages.flatMap(m => m.activities ?? [])
  const reply = result.session.messages.filter(m => m.role === 'assistant').at(-1)
  if (!activities.some(a => a.name === 'list_directory' && a.status === 'done') || reply?.status !== 'complete' || !reply.content.includes('CLAX_OPENROUTER_OK')) throw new Error('Live tool/reasoning conversation did not complete: ' + (await page.evaluate(() => (window as any).smokeErrors)).join('; '))
  const totals = (await page.evaluate(() => window.clax.usageSummary())).total
  if (!totals.inputTokens || !totals.outputTokens || totals.unpricedRequests) throw new Error('Real token/cost usage was not returned')
  Object.assign(report, { model: model.id, reasoningEffort: 'low', catalogueModels: provider.models.length, commonModels: commonModels(provider.models).map(m => m.id), tool: 'list_directory', reply: reply.content, usage: totals, credits: await page.evaluate(id => window.clax.providerCredits(id), provider.id), reasoningDetailsPreserved: result.session.messages.some(m => m.reasoningDetails?.length) })
  console.log(JSON.stringify({ model: model.id, catalogueModels: provider.models.length, usage: totals, complete: true }))
} catch (error) { report.errors = [(error as Error).message]; throw error }
finally { await writeFile(join(project, 'test-results/openrouter-live-validation.json'), JSON.stringify(report, null, 2) + '\n'); await desktop.close() }
