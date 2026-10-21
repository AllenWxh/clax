import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalStore } from '../src/main/storage'
import { AgentService } from '../src/main/service'
import { environmentKey } from '../src/main/environment'
import { createProvider } from '../src/main/providers'
import { ContextManager } from '../src/main/context'
import type { AgentEvent, ProviderConfig } from '../src/shared/types'

// Opt-in live verification: isolated app data, synthetic statements, no production writes.
const workspace = process.cwd(), home = resolve(`test-results/live-memory-${Date.now()}`)
const key = environmentKey('DEEPSEEK_API_KEY', workspace)
if (!key) throw new Error('DEEPSEEK_API_KEY is unavailable in the launch environment or workspace .env')
const configs = JSON.parse(await readFile(join(homedir(), '.clax', 'providers.json'), 'utf8')) as ProviderConfig[]
const existing = configs.find(p => /deepseek/i.test(p.baseUrl))
if (!existing?.models.length) throw new Error('Configure DeepSeek in Clax before running the live smoke test')
const model = existing.models.find(m => /flash/i.test(m.id)) ?? existing.models[0]!
const codec = { available: () => false, encrypt: (v: string) => Buffer.from(v), decrypt: (v: Buffer) => v.toString() }
await mkdir(home, { recursive: true })
const store = new LocalStore(home, codec, workspace), service = new AgentService(store, () => {})
const checks: string[] = []
const check = (text: string) => { checks.push(text); console.log(`PASS ${text}`) }
try {
  const p = await service.saveProvider({ name: 'Live DeepSeek memory smoke', kind: existing.kind, baseUrl: existing.baseUrl,
    apiKey: key, modelIds: [model.id], contextWindow: model.contextWindow ?? existing.contextWindow, toolCalling: true })
  service.setModel(service.currentId, { provider: p.id, model: model.id })
  service.send(service.currentId, '这是测试用的长期通用偏好：我的所有回答都使用中文。现在只回复“收到”，不要调用工具。')
  await service.waitForIdle(service.currentId); await service.waitForMemory()
  const hits = service.searchMemory('回答 中文'), learned = hits.find(h => h.kind === 'preference')
  assert.ok(learned, 'The real model must extract a preference with exact user evidence')
  assert.ok(learned.sourceMessages?.length); assert.equal((await service.bootstrap()).memoryStatus.lastCaptureError, undefined)
  check('Real DeepSeek extracts a grounded durable preference')
  await service.newSession()
  service.send(service.currentId, '根据已经保存的沟通偏好，我希望你使用哪一种语言？只回答语言名称，不要调用工具。')
  await service.waitForIdle(service.currentId); await service.waitForMemory()
  const recalled = (await service.bootstrap()).session.messages.at(-1)!.content
  assert.match(recalled, /中文|Chinese/i)
  check('A new real-model session recalls the language without the original chat')
  const config = store.providers[0]!, ref = { provider: config.id, model: model.id }, provider = createProvider(config, key)
  const session = store.createSession(ref), events: AgentEvent[] = []
  session.messages = [
    { id: 'synthetic-old-user', turnId: 'synthetic-old', role: 'user', createdAt: Date.now(), content: `Synthetic test transcript. 目标是验证上下文压缩，路径 /tmp/clax-memory-smoke，尚未发布任何产品。\n${'约束：只验证本地功能，测试用数据可以重建，不声称外部任务已完成。\n'.repeat(160)}` },
    { id: 'synthetic-old-answer', turnId: 'synthetic-old', role: 'assistant', createdAt: Date.now(), content: '已了解测试约束，将继续验证。' },
    { id: 'synthetic-new-user', turnId: 'synthetic-new', role: 'user', createdAt: Date.now(), content: '最新指令：保留原始对话，只验证摘要，不发布产品。' },
  ]
  const original = structuredClone(session.messages)
  const prepared = await new ContextManager(() => 12000).prepare(session, ref, [], AbortSignal.timeout(90000), {
    provider: () => provider, context: () => '', contextWindow: () => model.contextWindow ?? existing.contextWindow,
    sanitize: store.memory.sanitize, permission: () => 'auto', takeSteering: () => [], approve: async () => false,
  }, event => events.push(event))
  if (session.contextState?.method !== 'model') console.log(JSON.stringify(events.filter(e => e.type === 'notice')))
  assert.equal(session.contextState?.method, 'model'); assert.ok(session.summarizedCount > 0)
  assert.match(session.summary, /\/tmp\/clax-memory-smoke/)
  assert.equal(prepared.messages.at(-1)!.content, original.at(-1)!.content); assert.deepEqual(session.messages, original)
  assert.ok(prepared.estimatedTokens <= prepared.budgetTokens)
  check('Real DeepSeek compaction keeps identifiers, raw history and the latest request')
  const usage = (await service.bootstrap()).session.usage
  await service.shutdown()
  const reopened = new LocalStore(home, codec, workspace)
  try { assert.ok(reopened.memory.search('回答 中文', workspace).some(h => h.path === learned.path)); check('Learned memory is restored from disk after restart') }
  finally { reopened.close() }
  await writeFile(resolve('test-results/live-memory-validation.json'), JSON.stringify({ date: new Date().toISOString(), model: model.id, home, checks,
    preferenceSource: { path: learned.path, sourceSession: learned.sourceSession, sourceMessages: learned.sourceMessages }, recalled, compaction: session.contextState,
    summary: session.summary, usage, summaryRequests: events.filter(e => e.type === 'usage_updated').map(e => e.type === 'usage_updated' ? e.usage : null) }, null, 2))
} catch (error) { await service.shutdown().catch(() => {}); throw error }
