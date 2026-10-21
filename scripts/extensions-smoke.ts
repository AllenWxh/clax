import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { LocalStore } from '../src/main/storage'
import { AgentService } from '../src/main/service'
import { environmentKey } from '../src/main/environment'
import type { ProviderConfig } from '../src/shared/types'

const workspace = resolve('.'), home = resolve(`test-results/live-extensions-${Date.now()}`)
const providers = JSON.parse(await readFile(join(homedir(), '.clax/providers.json'), 'utf8')) as ProviderConfig[]
const provider = providers.find(p => p.apiKeyEnv && p.baseUrl.includes('deepseek.com'))
if (!provider?.apiKeyEnv || !environmentKey(provider.apiKeyEnv, workspace)) throw new Error('需要已有的 DeepSeek 环境变量引用；不会打印或复制 Key。')
process.env.CLAX_EXTENSION_SMOKE_KEY = environmentKey(provider.apiKeyEnv, workspace)
await mkdir(home, { recursive: true })
const store = new LocalStore(home, { available: () => false, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }, workspace)
const steps: { tool: string; status: string }[] = []
const service = new AgentService(store, event => {
  if (event.type === 'session' && event.event?.type === 'tool_started') console.log(`RUN ${event.event.activity.name}`)
  if (event.type === 'session' && event.event?.type === 'tool_finished') {
    const toolId = event.event.toolId
    steps.push({ tool: event.session.messages.flatMap(m => m.activities ?? []).find(a => a.id === toolId)?.name ?? '', status: event.event.status })
  }
})
const result: Record<string, unknown> = { home, realModel: true, realNetwork: true, steps, errors: [] }
try {
  const model = provider.models.find(m => /flash/i.test(m.id)) ?? provider.models[0]!
  const saved = await service.saveProvider({ name: 'Live extension validation', kind: provider.kind === 'mock' ? 'compatible' : provider.kind,
    baseUrl: provider.baseUrl, apiKeyEnv: 'CLAX_EXTENSION_SMOKE_KEY', toolCalling: true, modelIds: [model.id], contextWindow: provider.contextWindow })
  const initial = await service.bootstrap(), id = initial.session.id
  service.saveSettings({ ...store.settings, permissionMode: 'auto', memory: { enabled: false, autoCapture: false }, maxContextChars: 100000,
    disabledTools: initial.tools.map(t => t.name).filter(name => name !== 'extension_manage') })
  service.setModel(id, { provider: saved.id, model: model.id })
  service.send(id, '请给你自己开发并安装一个新的联网插件，不要只描述。插件 ID public-check、版本 1.0.0、工具名 probe，工具参数为空对象。只允许 GET 访问 example.com。你自己编写 JavaScript，从 https://example.com 读取网页并返回 {title:"Example Domain"}。至少写一个 HTTP 离线 fixture 测试。先读 extension_manage sdk，然后 stage、test、install，最后在同一轮里调用新工具 ext_public_check_probe，真实访问页面并确认标题。其他工具已关闭。不得伪造真实联网成功，不需要任何账号或 Key。')
  const deadline = Date.now() + 150000
  while ((await service.bootstrap()).runningSessions.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150))
  const final = await service.bootstrap()
  if (final.runningSessions.length) { await service.stop(id); throw new Error('Real model extension validation timed out') }
  assert.ok(store.extensions.list().find(item => item.id === 'public-check' && item.enabled))
  const calls = final.session.messages.filter(m => m.role === 'tool')
  assert.ok(calls.some(call => call.toolName === 'ext_public_check_probe' && call.content.includes('Example Domain')), 'Real model did not invoke its newly installed network tool successfully')
  assert.ok(steps.some(step => step.tool === 'ext_public_check_probe' && step.status === 'done'))
  result.model = model.id; result.installed = store.extensions.list(); result.final = final.session.messages.at(-1)?.content
  console.log('PASS Real DeepSeek developed, tested, installed and invoked its new HTTP plugin in the same turn')
} catch (error) { (result.errors as string[]).push((error as Error).message); process.exitCode = 1 }
finally { await service.shutdown(); delete process.env.CLAX_EXTENSION_SMOKE_KEY; await writeFile('test-results/live-extensions-validation.json', JSON.stringify(result, null, 2) + '\n') }
