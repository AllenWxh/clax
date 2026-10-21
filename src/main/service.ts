import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type { AgentEvent, AgentSession, AppSnapshot, AppSettings, ApprovalRequest, DesktopEvent, MemoryFile, ModelRef, ProviderConfig, ProviderCredits, ProviderInput, PublicProvider, Usage } from '../shared/types'
import { commonModels } from '../shared/models'
import { LocalStore } from './storage'
import { availableEnvironmentKeys, environmentKey } from './environment'
import { createProvider, demoConfig, endpoint, providerRequest } from './providers'
import { LocalAgentRuntime } from './runtime'
import { createTools, ProcessManager } from './tools'
import { ActivityObserver } from './activity'
import { localDate } from './memory'
import { REMINDER_PROMPT, ReminderScheduler, parseDecision, recentActivity } from './reminder'

interface RunState {
  controller: AbortController
  done?: Promise<void>
  approvals: Map<string, { request: ApprovalRequest; resolve: (allowed: boolean) => void }>
  timer?: ReturnType<typeof setTimeout>
  steer?: () => void
}
export class AgentService {
  private sessions = new Map<string, AgentSession>()
  private running = new Map<string, RunState>()
  private catalogs = new Map<string, ProviderConfig['models']>()
  private maintenance = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private credits = new Map<string, Promise<ProviderCredits | null>>()
  private provisioning = new Map<string, Promise<void>>()
  private observer?: ActivityObserver
  private reminders?: ReminderScheduler
  processes = new ProcessManager()
  currentId: string
  shortcutRegistered = false
  shortcutStatus = '快捷键尚未注册'
  windowMode: 'expanded' | 'collapsed' = 'expanded'
  constructor(public store: LocalStore, private emit: (event: DesktopEvent) => void) {
    store.extensions.onChange = () => this.emit({ type: 'refresh' })
    const previous = store.listSessions()[0]
    const session = previous ? store.getSession(previous.id)! : store.createSession()
    this.sessions.set(session.id, session); this.currentId = session.id
  }
  private session(id: string) {
    const session = this.sessions.get(id) ?? this.store.getSession(id)
    if (!session) throw new Error('Session not found')
    this.sessions.set(id, session); return session
  }
  private configs() { return [...this.store.providers, ...(this.store.settings.demoEnabled ? [demoConfig] : [])] }
  private secret(config: ProviderConfig, workspace = this.session(this.currentId).workspace) {
    return config.apiKeyEnv ? environmentKey(config.apiKeyEnv, workspace) : this.store.getSecret(config.id)
  }
  private config(ref: ModelRef) {
    const config = this.configs().find(p => p.id === ref.provider)
    if (!config || !config.models.some(m => m.id === ref.model)) throw new Error('Selected model is unavailable. Choose a model from the picker.')
    return config
  }
  private approvals() { return [...this.running.values()].flatMap(r => [...r.approvals.values()].map(a => a.request)) }
  private webSearch(ref: ModelRef | null) {
    return Boolean(ref && this.store.settings.search.kind === 'openrouter' && !this.store.settings.disabledTools.includes('web_search')
      && this.configs().some(p => p.id === ref.provider && p.kind === 'openrouter'))
  }
  async bootstrap(): Promise<AppSnapshot> {
    this.memorySecrets(this.session(this.currentId).workspace)
    return { session: this.session(this.currentId), sessions: this.store.listSessions(),
      providers: this.configs().map(p => ({ ...p, hasKey: Boolean(this.secret(p)) })), settings: this.store.settings, extensions: this.store.extensions.list(),
      skills: this.store.listSkills(), memory: this.store.getMemory(), memoryStatus: this.store.memory.status(this.store.settings.memory.enabled, this.store.settings.memory.autoCapture), runningSessions: [...this.running.keys()], approvals: this.approvals(),
      activityStatus: this.observer?.status() ?? { supported: process.platform === 'darwin', enabled: false, state: 'off', accessibility: 'unknown' },
      storagePath: this.store.home, secureStorage: this.store.secureStorage, shortcutRegistered: this.shortcutRegistered,
      shortcutStatus: this.shortcutStatus, windowMode: this.windowMode, environmentKeys: availableEnvironmentKeys(this.session(this.currentId).workspace), searchHasKey: Boolean(this.store.getSecret('web-search')),
      tools: createTools(this.store, this.processes).map(t => ({ name: t.name, available: t.available !== false || t.name === 'web_search' && this.webSearch(this.session(this.currentId).currentModel), enabled: true })), version: '0.1.0' }
  }
  private publish(session: AgentSession, event?: AgentEvent, immediate = false) {
    const run = this.running.get(session.id)
    const flush = () => {
      this.store.saveSession(session)
      this.emit({ type: 'session', session, running: this.running.has(session.id), approvals: this.approvals(), event })
    }
    if (immediate || !run) { if (run?.timer) clearTimeout(run.timer); if (run) run.timer = undefined; flush() }
    else if (!run.timer) run.timer = setTimeout(() => { run.timer = undefined; flush() }, 55)
  }
  async importOpenRouter() {
    if (!environmentKey('OPENROUTER_API_KEY', this.session(this.currentId).workspace)) return
    const existing = this.store.providers.find(p => p.kind === 'openrouter')
    const legacy = this.store.providers.filter(p => { try { return new URL(p.baseUrl).hostname === 'api.deepseek.com' } catch { return false } })
    if (existing && !legacy.length) return
    if (this.running.size) throw new Error('请先停止正在运行的任务，再切换到 OpenRouter。')
    // Persist the variable name only. The key remains in the user's environment.
    const input: ProviderInput = { id: existing?.id, name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', toolCalling: true }
    const models = await this.testProvider(input)
    if (this.running.size) throw new Error('请先停止正在运行的任务，再切换到 OpenRouter。')
    const provider = await this.saveProvider({ ...input, modelIds: models.map(m => m.id) })
    const preferred = commonModels(provider.models)[0] ?? provider.models[0]
    if (!preferred) throw new Error('OpenRouter 未返回可用模型。')
    this.store.migrateModels(legacy.map(p => p.id), { provider: provider.id, model: preferred.id })
    this.sessions.clear()
    for (const old of legacy) this.deleteProvider(old.id)
    this.emit({ type: 'refresh' })
  }
  newSession() {
    const old = this.session(this.currentId)
    const session = this.store.createSession(old.currentModel)
    session.workspace = old.workspace; this.store.saveSession(session)
    this.sessions.set(session.id, session); this.currentId = session.id
    this.emit({ type: 'refresh' }); return this.bootstrap()
  }
  openSession(id: string) { this.session(id); this.currentId = id; return this.bootstrap() }
  setModel(id: string, ref: ModelRef) {
    const config = this.config(ref), model = config.models.find(m => m.id === ref.model)!
    if (ref.reasoningEffort && !model.reasoningEfforts?.includes(ref.reasoningEffort)) throw new Error('该模型不支持这个推理强度，请重新选择。')
    const session = this.session(id); session.currentModel = ref; this.publish(session, undefined, true)
  }
  async setWorkspace(id: string, path: string) {
    if (this.running.has(id)) throw new Error('Stop this session before changing its workspace')
    const workspace = await realpath(path)
    if (!(await stat(workspace)).isDirectory()) throw new Error('Choose a folder')
    const session = this.session(id); session.workspace = workspace; this.publish(session, undefined, true)
  }
  send(id: string, text: string) {
    text = text.trim()
    if (!text || text.length > 32000) throw new Error('Enter a message of up to 32,000 characters')
    const session = this.session(id)
    if (this.running.has(id)) {
      const run = this.running.get(id)!
      session.pendingInstructions.push(text)
      // Interrupt model output immediately; an executing tool finishes at its safe boundary.
      run.steer?.()
      for (const approval of [...run.approvals.values()]) approval.resolve(false)
      this.publish(session, { type: 'notice', text: '正在调整方向；当前工具完成后按新指令继续。' }, true); return
    }
    this.maintenance.get(id)?.controller.abort()
    if (!session.currentModel) throw new Error('No provider configured. Add a provider or enable Demo in Settings.')
    this.config(session.currentModel)
    session.paused = false
    session.messages.push({ id: randomUUID(), turnId: randomUUID(), role: 'user', content: text, createdAt: Date.now(), workspace: session.workspace })
    if (session.title === 'New session') session.title = text.slice(0, 55)
    const run: RunState = { controller: new AbortController(), approvals: new Map() }
    this.running.set(id, run); this.publish(session, undefined, true)
    run.done = this.run(session, run)
  }
  private async run(session: AgentSession, run: RunState) {
    const runtime = new LocalAgentRuntime(() => this.store.settings.maxContextChars)
    let completed = false
    try {
      for await (const event of runtime.runTurn(session, session.currentModel!, createTools(this.store, this.processes), run.controller.signal, {
        tools: () => createTools(this.store, this.processes),
        provider: ref => { const config = this.config(ref); return createProvider(config, this.secret(config, session.workspace)) },
        context: query => { this.memorySecrets(session.workspace); return this.store.context(query, session.workspace) },
        contextWindow: ref => { const config = this.config(ref); return config.models.find(m => m.id === ref.model)?.contextWindow ?? config.contextWindow },
        webSearch: ref => this.webSearch(ref),
        sanitize: this.store.memory.sanitize,
        flushMemory: async (target, through, signal) => {
          await this.cancelMemory(target.id)
          await this.captureMemory(target, through, signal)
        },
        permission: () => this.store.settings.permissionMode,
        takeSteering: () => session.pendingInstructions.splice(0),
        onSteering: listener => { run.steer = listener; return () => { if (run.steer === listener) run.steer = undefined } },
        approve: (toolName, description, args) => this.requestApproval(session, run, toolName, description, args),
      })) {
        if (event.type === 'usage_updated') this.usage(session, event.usage, event.model)
        if (event.type === 'turn_finished') completed = event.status === 'complete'
        this.publish(session, event, ['error', 'turn_finished', 'tool_started', 'summary_updated'].includes(event.type))
      }
    } finally {
      if (run.timer) clearTimeout(run.timer)
      for (const approval of run.approvals.values()) approval.resolve(false)
      // An instruction can arrive after the runtime's final check but before its events drain.
      const queued = run.controller.signal.aborted ? [] : session.pendingInstructions.splice(0)
      this.running.delete(session.id); this.publish(session, undefined, true)
      if (queued.length) this.send(session.id, queued.join('\n\n'))
      else if (completed && !run.controller.signal.aborted) this.scheduleMemory(session)
    }
  }
  private memorySecrets(workspace: string) {
    this.store.memory.setSecrets(this.configs().flatMap(p => [this.secret(p, workspace), p.creditsKeyEnv ? environmentKey(p.creditsKeyEnv, workspace) : '']).concat(this.store.getSecret('web-search')))
  }
  private async captureMemory(session: AgentSession, through: number, signal: AbortSignal) {
    if (!this.store.settings.memory.enabled || !this.store.settings.memory.autoCapture || !session.currentModel || through <= (session.memoryCapturedCount ?? 0)) return
    signal.throwIfAborted(); this.memorySecrets(session.workspace)
    const ref = { ...session.currentModel }, config = this.config(ref)
    try {
      if (config.kind === 'mock') { this.store.memory.journal(session, through); session.memoryCapturedCount = through; return }
      session.memoryCapturedCount = await this.store.memory.capture(session, through, createProvider(config, this.secret(config, session.workspace)), ref, signal,
        usage => { const actual = this.session(session.id); this.usage(actual, usage, ref); this.publish(actual, { type: 'usage_updated', usage, model: ref }, true) },
        config.models.find(m => m.id === ref.model)?.contextWindow ?? config.contextWindow)
      this.store.memory.lastCaptureError = undefined
    } catch (error) {
      if (signal.aborted) throw error
      // The dated journal was already committed; a bad extractor cannot replace the completed reply.
      session.memoryCapturedCount = through
      this.store.memory.lastCaptureError = '本次自动偏好提取失败；每日记录已保存，可以通过搜索找回原文。'
      this.emit({ type: 'session', session: this.session(session.id), running: this.running.has(session.id), approvals: this.approvals(),
        event: { type: 'notice', text: '每日记录已保存；本次自动偏好提取失败，可从记忆搜索找回原文。' } })
    }
  }
  private scheduleMemory(session: AgentSession) {
    if (!this.store.settings.memory.enabled || !this.store.settings.memory.autoCapture) return
    const controller = new AbortController(), snapshot = structuredClone(session)
    const job = { controller, done: Promise.resolve() }
    this.maintenance.set(session.id, job)
    job.done = this.captureMemory(snapshot, snapshot.messages.length, controller.signal).then(() => {
      if (controller.signal.aborted) return
      session.memoryCapturedCount = Math.max(session.memoryCapturedCount ?? 0, snapshot.memoryCapturedCount ?? 0)
      this.publish(session, undefined, true); this.emit({ type: 'refresh' })
    }).catch(() => { /* Cancellation belongs to the next foreground turn or shutdown. */ })
      .finally(() => { if (this.maintenance.get(session.id) === job) this.maintenance.delete(session.id) })
  }
  private async cancelMemory(id: string) { const job = this.maintenance.get(id); job?.controller.abort(); await job?.done }
  startMemory() {
    const session = this.session(this.currentId), last = session.messages.at(-1)
    // Backfill only this app's settled chat; never import other applications or interrupted work.
    if (!session.paused && last?.role === 'assistant' && (!last.status || last.status === 'complete')) this.scheduleMemory(session)
  }
  async waitForMemory(id = this.currentId) { await this.maintenance.get(id)?.done }
  searchMemory(query: string) { this.memorySecrets(this.session(this.currentId).workspace); return this.store.memory.search(query, this.session(this.currentId).workspace, 12) }
  readMemory(path: string, startLine?: number, lines?: number) { this.memorySecrets(this.session(this.currentId).workspace); return this.store.memory.read(path, this.session(this.currentId).workspace, startLine, lines) }
  forgetMemory(path: string) { this.store.memory.forget(path, this.session(this.currentId).workspace); this.emit({ type: 'refresh' }) }
  startActivity(helper: string) {
    this.memorySecrets(this.session(this.currentId).workspace)
    this.observer = new ActivityObserver(this.store.activity, this.store.settings.activity, helper,
      status => this.emit({ type: 'activity', status }))
    this.observer.configure(this.store.settings.activity)
  }
  startReminders(notify: (text: string) => void) {
    this.reminders = new ReminderScheduler(() => this.store.settings.reminder, (since, signal) => this.reminderDecision(since, signal), notify)
    this.reminders.configure()
  }
  /** Asks the current model whether to remind; never runs without fresh activity or while a turn is active. */
  async reminderDecision(since: number, signal: AbortSignal): Promise<string | null> {
    const session = this.session(this.currentId), ref = session.currentModel
    if (!ref || this.running.size || !this.store.settings.activity.enabled) return null
    const items = recentActivity(this.store.activity.report(localDate(), '', undefined, 100).items.filter(i => i.kind === 'focus'), since)
    if (!items.length) return null
    const config = this.config(ref); this.memorySecrets(session.workspace)
    const provider = createProvider(config, this.secret(config, session.workspace))
    let output = '', reported: Usage | null = null
    for await (const event of provider.stream({ model: ref.model, reasoningEffort: ref.reasoningEffort, system: REMINDER_PROMPT, tools: [], signal, maxOutputTokens: 300,
      messages: [{ id: 'reminder', turnId: 'reminder', role: 'user', createdAt: Date.now(), content: JSON.stringify({ now: new Date().toTimeString().slice(0, 5), activity: items }) }] })) {
      if (event.type === 'text') output += event.text
      else if (event.type === 'usage') reported = event.usage
    }
    // Reminder checks cost tokens too; record them alongside chat usage.
    if (reported) this.usage(session, reported, ref)
    return parseDecision(output)
  }
  suspendActivity(suspended: boolean) { this.observer?.suspend(suspended) }
  activityReport(date = localDate(), query = '', before?: string) { this.memorySecrets(this.session(this.currentId).workspace); return this.store.activity.report(date, query, before) }
  deleteActivity(date: string) { if (this.observer) this.observer.clear(date); else this.store.activity.delete(date); this.emit({ type: 'refresh' }) }
  async captureSelection() {
    if (!this.observer) throw new Error('活动记录器尚未启动。')
    this.memorySecrets(this.session(this.currentId).workspace); await this.observer.captureSelection(); this.emit({ type: 'refresh' })
  }
  requestActivityPermission() { if (!this.observer) throw new Error('活动记录器尚未启动。'); this.observer.requestPermission() }
  private usage(session: AgentSession, usage: Usage | null, model?: ModelRef) {
    const total = session.usage
    if (!usage || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
      this.store.usage.record(session.id, model ?? session.currentModel ?? undefined, usage, null)
      total.unreportedRequests++; total.estimatedCost = null; return
    }
    const first = total.reportedRequests === 0
    total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens
    if (usage.cachedTokens !== undefined) { total.cachedTokens += usage.cachedTokens; total.cacheAvailable = true }
    const pricing = this.configs().find(p => p.id === (model ?? session.currentModel)?.provider)?.pricing
    // Prefer API-reported cost; only user-supplied rates can provide an estimate.
    const estimate = pricing && !usage.cacheWriteTokens ? ((usage.inputTokens - (usage.cachedTokens ?? 0)) * pricing.input
      + (usage.cachedTokens ?? 0) * (pricing.cache ?? pricing.input) + usage.outputTokens * pricing.output) / 1_000_000 : null
    const cost = usage.cost ?? estimate
    this.store.usage.record(session.id, model ?? session.currentModel ?? undefined, usage, estimate)
    total.estimatedCost = cost !== null && total.unreportedRequests === 0 && (first || total.estimatedCost !== null) ? (total.estimatedCost ?? 0) + cost : null
    total.reportedRequests++
  }
  private requestApproval(session: AgentSession, run: RunState, toolName: string, description: string, args: Record<string, unknown>): Promise<boolean> {
    // A tool may have captured Ask before an async path check; honor the current setting.
    if (this.store.settings.permissionMode === 'full') return Promise.resolve(true)
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const abort = () => { run.approvals.delete(id); reject(new DOMException('Task stopped', 'AbortError')) }
      const request: ApprovalRequest = { id, sessionId: session.id, toolName, description, arguments: args }
      run.approvals.set(id, { request, resolve: allowed => { run.controller.signal.removeEventListener('abort', abort); run.approvals.delete(id); resolve(allowed) } })
      run.controller.signal.addEventListener('abort', abort, { once: true })
      this.publish(session, { type: 'approval_requested', approval: request }, true)
      if (run.controller.signal.aborted) abort()
    })
  }
  approve(id: string, allow: boolean) {
    for (const run of this.running.values()) if (run.approvals.has(id)) { run.approvals.get(id)!.resolve(allow); return }
    throw new Error('This approval is no longer pending')
  }
  async pause(id: string) {
    const run = this.running.get(id)
    if (!run) return
    const session = this.session(id)
    session.paused = true; this.publish(session, undefined, true)
    run.controller.abort(new DOMException('Task paused', 'PauseError'))
    await run.done
  }
  resume(id: string) {
    const session = this.session(id)
    if (this.running.has(id)) throw new Error('Wait for the current operation to pause')
    if (!session.paused) return
    // The provider starts a fresh request using retained progress, rather than freezing a socket.
    this.send(id, '继续刚才暂停的任务，根据保留的进度接着处理，避免重复已经完成的操作。')
  }
  async stop(id: string) {
    await this.cancelMemory(id)
    const run = this.running.get(id), session = this.session(id)
    session.paused = false; run?.controller.abort(); await run?.done
    const last = session.messages.filter(m => m.role === 'assistant').at(-1)
    if (last?.status === 'paused') last.status = 'stopped'
    this.publish(session, undefined, true)
  }
  async waitForIdle(id: string) { while (this.running.has(id)) await this.running.get(id)?.done }
  async retry(id: string, messageId: string) {
    if (this.running.has(id)) throw new Error('Stop the current turn before retrying')
    const session = this.session(id), target = session.messages.find(m => m.id === messageId)
    if (!target || target.role !== 'assistant') throw new Error('Assistant reply not found')
    const index = session.messages.findIndex(m => m.role === 'user' && m.turnId === target.turnId)
    if (index < 0) throw new Error('Original prompt not found')
    const text = session.messages[index]!.content
    session.messages = session.messages.slice(0, index)
    if (session.summarizedCount > index) { session.summary = ''; session.summarizedCount = 0; session.contextState = undefined }
    session.memoryCapturedCount = Math.min(session.memoryCapturedCount ?? 0, index)
    this.send(id, text)
  }
  private inputConfig(input: ProviderInput): ProviderConfig {
    const id = input.id ?? randomUUID()
    const previous = this.store.providers.find(p => p.id === id)
    const catalog = this.catalogs.get(`${input.kind}:${input.baseUrl.replace(/\/+$/, '')}`) ?? previous?.models ?? []
    return { id, name: input.name, kind: input.kind, baseUrl: input.baseUrl.replace(/\/+$/, ''), toolCalling: input.toolCalling,
      apiKeyEnv: input.apiKeyEnv || undefined, creditsKeyEnv: previous?.creditsKeyEnv, contextWindow: input.contextWindow, pricing: input.pricing,
      models: input.modelIds ? input.modelIds.map(model => ({ ...catalog.find(m => m.id === model), provider: id, id: model,
        name: catalog.find(m => m.id === model)?.name ?? model, tools: input.toolCalling && (input.kind !== 'openrouter' || catalog.find(m => m.id === model)?.tools === true),
        contextWindow: input.contextWindow ?? catalog.find(m => m.id === model)?.contextWindow })) : previous?.models ?? [] }
  }
  async testProvider(input: ProviderInput) {
    const config = this.inputConfig(input)
    const key = input.apiKeyEnv ? environmentKey(input.apiKeyEnv, this.session(this.currentId).workspace) : input.apiKey || this.store.getSecret(config.id)
    if (input.apiKeyEnv && !key) throw new Error(`Environment variable ${input.apiKeyEnv} was not found in this process or workspace .env/.env.local`)
    const models = await createProvider(config, key).listModels(AbortSignal.timeout(20000))
    this.catalogs.set(`${config.kind}:${config.baseUrl}`, models)
    return models
  }
  async saveProvider(input: ProviderInput): Promise<PublicProvider> {
    const config = this.inputConfig(input)
    if (input.apiKey !== undefined && input.apiKey !== '') this.store.setSecret(config.id, input.apiKey)
    if (input.apiKeyEnv) this.store.setSecret(config.id, '')
    this.store.saveProviders([...this.store.providers.filter(p => p.id !== config.id), config])
    this.credits.delete(config.id)
    this.emit({ type: 'refresh' })
    return { ...config, hasKey: Boolean(this.secret(config)) }
  }
  async refreshProvider(id: string) {
    const config = this.store.providers.find(p => p.id === id)
    if (!config) throw new Error('Provider not found')
    config.models = await createProvider(config, this.secret(config)).listModels(AbortSignal.timeout(20000))
    this.store.saveProviders(this.store.providers); this.emit({ type: 'refresh' })
  }
  async providerCredits(id: string) {
    const config = this.store.providers.find(p => p.id === id)
    if (!config) throw new Error('Provider not found')
    const pending = this.credits.get(id)
    if (pending) return pending
    const management = config.kind === 'openrouter' && config.creditsKeyEnv ? environmentKey(config.creditsKeyEnv, this.session(this.currentId).workspace) : undefined
    const job = createProvider(config, this.secret(config), management).getUsage?.() ?? Promise.resolve(null)
    this.credits.set(id, job)
    try { return await job } finally { this.credits.delete(id) }
  }
  usageSummary() { return this.store.usage.summary() }
  async provisionOpenRouter(id: string) {
    const pending = this.provisioning.get(id)
    if (pending) return pending
    const job = this.createRouterKey(id)
    this.provisioning.set(id, job)
    try { await job } finally { this.provisioning.delete(id) }
  }
  private async createRouterKey(id: string) {
    const config = this.store.providers.find(p => p.id === id)
    if (config?.kind !== 'openrouter' || config.baseUrl !== 'https://openrouter.ai/api/v1') throw new Error('只允许为官方 OpenRouter 入口创建调用 Key。')
    if (!this.store.secureStorage) throw new Error('需要系统加密存储可用后才能创建调用 Key。')
    if (this.running.size) throw new Error('请先停止正在运行的任务。')
    const management = this.secret(config)
    const info = (await (await providerRequest(endpoint(config.baseUrl, 'key'), management, { signal: AbortSignal.timeout(20000) })).json() as any).data
    if (!info.is_management_key && !info.is_provisioning_key) return
    if (!config.apiKeyEnv) throw new Error('请通过本地环境变量提供管理 Key。')
    const created = await (await providerRequest(endpoint(config.baseUrl, 'keys'), management, { method: 'POST', signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ name: 'Clax', limit: 15, limit_reset: null, include_byok_in_limit: true }) })).json() as any
    if (typeof created.key !== 'string' || !created.key.startsWith('sk-or-')) throw new Error('OpenRouter 未返回调用 Key，请检查账号中的 Key 列表。')
    try {
      this.store.setSecret(id, created.key)
      this.store.saveProviders(this.store.providers.map(p => p.id === id ? { ...config, apiKeyEnv: undefined, creditsKeyEnv: config.apiKeyEnv } : p))
    } catch (error) {
      // Do not leave a newly issued credential active if local secure persistence fails.
      if (typeof created.data?.hash === 'string') await providerRequest(endpoint(config.baseUrl, `keys/${encodeURIComponent(created.data.hash)}`), management, { method: 'DELETE', signal: AbortSignal.timeout(20000) })
      throw error
    }
    this.credits.delete(id); this.emit({ type: 'refresh' })
  }
  deleteProvider(id: string) {
    if ([...this.running.keys()].some(s => this.session(s).currentModel?.provider === id)) throw new Error('Stop the provider’s active session before removing it')
    this.store.saveProviders(this.store.providers.filter(p => p.id !== id)); this.store.setSecret(id, '')
    for (const session of this.sessions.values()) if (session.currentModel?.provider === id) { session.currentModel = null; this.store.saveSession(session) }
    this.emit({ type: 'refresh' })
  }
  saveSettings(settings: AppSettings) {
    const activityChanged = JSON.stringify(settings.activity) !== JSON.stringify(this.store.settings.activity)
    this.store.saveSettings(settings)
    if (settings.permissionMode === 'full') for (const [id, run] of this.running) {
      if (!run.approvals.size) continue
      // Changing the global mode also releases work already waiting for confirmation.
      for (const approval of [...run.approvals.values()]) approval.resolve(true)
      this.publish(this.session(id), undefined, true)
    }
    if (activityChanged) this.observer?.configure(settings.activity)
    this.reminders?.configure()
    if (!settings.memory.enabled || !settings.memory.autoCapture) for (const job of this.maintenance.values()) job.controller.abort()
    this.emit({ type: 'refresh' })
  }
  saveMemory(file: MemoryFile, content: string) { this.store.saveMemory(file, content); this.emit({ type: 'refresh' }) }
  async shutdown() {
    this.observer?.close(); this.reminders?.close()
    await Promise.all([...this.maintenance.keys()].map(id => this.cancelMemory(id)))
    await Promise.all([...this.running.keys()].map(id => this.stop(id)))
    await this.processes.shutdown(); this.store.close()
  }
}
