import { _electron as electron, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { commonModels } from '../src/shared/models'

// Real search calls incur OpenRouter usage; isolate chat/storage and reuse only the existing encrypted credential.
const project = resolve('.'), home = await mkdtemp(resolve('test-results/native-search-live-')), workspace = join(home, 'workspace')
await mkdir(workspace)
for (const name of ['providers.json', 'credentials.json']) { await copyFile(join(homedir(), '.clax', name), join(home, name)); await chmod(join(home, name), 0o600) }
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), CLAX_HOME: home, CLAX_TEST: '1', CLAX_SHOW: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const desktop = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [`--user-data-dir=${join(home, 'chromium')}`, project], cwd: workspace, env })
const results: Record<string, unknown>[] = [], report = { date: new Date().toISOString(), home, live: true, results, errors: [] as string[] }
try {
  const page = await desktop.firstWindow(); await page.waitForFunction(() => Boolean(window.clax))
  const state = await page.evaluate(() => window.clax.bootstrap()), provider = state.providers.find(p => p.kind === 'openrouter')!
  if (!provider?.hasKey) throw new Error('Existing encrypted OpenRouter credential is not available')
  const models = commonModels(provider.models)
  for (const prefix of ['anthropic/', 'openai/']) {
    const model = models.find(m => m.id.startsWith(prefix) && m.tools && (prefix === 'anthropic/' ? /claude/.test(m.id) : /gpt-[5-9]/.test(m.id)))
    if (!model) throw new Error('No suitable model in the installed catalogue for ' + prefix)
    const selected = await page.evaluate(async ({ provider, model }) => {
      const s = await window.clax.newSession()
      await window.clax.saveSettings({ ...s.settings, search: { kind: 'openrouter', baseUrl: '' }, memory: { enabled: false, autoCapture: false },
        disabledTools: s.tools.filter(t => t.name !== 'web_search').map(t => t.name) })
      await window.clax.setModel(s.session.id, { provider, model: model.id, ...(model.reasoningEfforts?.includes('low') ? { reasoningEffort: 'low' as const } : {}) })
      await window.clax.send(s.session.id, '请实际调用联网搜索，查 Python 官方文档中 asyncio.TaskGroup 从哪个 Python 版本加入。只搜索一次，用一句中文回答并给出 docs.python.org 的来源链接。不要读取本地文件，也不要仅凭记忆回答。')
      return s.session.id
    }, { provider: provider.id, model })
    try { await expect.poll(async () => (await page.evaluate(() => window.clax.bootstrap())).runningSessions.length, { timeout: 150000 }).toBe(0) }
    catch (error) { await page.evaluate(id => window.clax.stop(id), selected); throw error }
    const result = await page.evaluate(() => window.clax.bootstrap()), reply = result.session.messages.at(-1)!
    const usage = await page.evaluate(() => window.clax.usageSummary())
    const entry = { requestedModel: model.id, status: reply.status, reply: reply.content, sources: reply.citations?.map(c => ({ title: c.title, url: c.url })) ?? [],
      reportedSearchRequests: reply.webSearchRequests ?? null, usage: usage.models.find(m => m.provider === provider.id && m.model === model.id) }
    results.push(entry); console.log(JSON.stringify({ requestedModel: entry.requestedModel, status: entry.status, sources: entry.sources.length, reportedSearchRequests: entry.reportedSearchRequests }))
    if (reply.status !== 'complete' || !entry.sources.some(c => new URL(c.url).hostname === 'docs.python.org')) throw new Error('No successful, source-backed real web search for ' + model.id)
    if (entry.reportedSearchRequests === 0) throw new Error('The API explicitly reported no web search for ' + model.id)
  }
} catch (error) { report.errors.push((error as Error).message); throw error }
finally { await writeFile('test-results/native-search-live-validation.json', JSON.stringify(report, null, 2) + '\n'); await desktop.close() }
