import type { ExtensionInfo } from './extensions'
export type PermissionMode = 'ask' | 'auto' | 'full'
export type ProviderKind = 'openrouter' | 'openai' | 'compatible' | 'anthropic' | 'gemini' | 'ollama' | 'mock'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface ModelCapabilities { tools: boolean; vision?: boolean; reasoning?: boolean }
export interface ModelInfo extends ModelCapabilities {
  provider: string
  id: string
  name: string
  contextWindow?: number
  reasoningEfforts?: ReasoningEffort[]
  maxOutputTokens?: number
}
export interface ModelRef { provider: string; model: string; reasoningEffort?: ReasoningEffort }
export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  models: ModelInfo[]
  toolCalling: boolean
  contextWindow?: number
  apiKeyEnv?: string
  creditsKeyEnv?: string
  // Optional user-supplied USD rates per million tokens, never guessed.
  pricing?: { input: number; output: number; cache?: number }
}
export interface PublicProvider extends ProviderConfig { hasKey: boolean }
export interface ProviderInput {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  modelIds?: string[]
  toolCalling: boolean
  contextWindow?: number
  pricing?: ProviderConfig['pricing']
}
export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  estimatedCost?: number
  cost?: number
  webSearchRequests?: number
}
export interface ProviderCredits {
  updatedAt: number
  balance: number | null
  keyLimit: number | null
  keyRemaining: number | null
  keyUsage: number | null
  managementKey?: boolean
  error?: string
}
export interface UsageTotals {
  inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; reasoningTokens: number
  requests: number; unreportedRequests: number; cacheReportedRequests: number; unpricedRequests: number
  reportedCost: number; estimatedCost: number
  webSearchRequests: number; webSearchReportedRequests: number
}
export interface UsageSummary { total: UsageTotals; models: (UsageTotals & { provider: string; model: string })[] }
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheAvailable: boolean
  estimatedCost: number | null
  reportedRequests: number
  unreportedRequests: number
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; signature?: string }
export interface ToolActivity extends ToolCall {
  status: 'running' | 'awaiting' | 'done' | 'failed' | 'denied' | 'stopped' | 'unavailable'
  startedAt: number
  finishedAt?: number
  output: string
}
export interface WebCitation { url: string; title: string; startIndex?: number; endIndex?: number; content?: string }
export interface Message {
  id: string
  turnId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
  model?: ModelRef
  workspace?: string
  status?: 'streaming' | 'complete' | 'paused' | 'interrupted' | 'stopped' | 'error'
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  reasoningContent?: string
  reasoningDetails?: Record<string, unknown>[]
  citations?: WebCitation[]
  webSearchRequests?: number
  activities?: ToolActivity[]
}
export interface AgentSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  workspace: string
  currentModel: ModelRef | null
  runtime: string
  messages: Message[]
  summary: string
  summarizedCount: number
  memoryCapturedCount?: number
  contextState?: { estimatedTokens: number; budgetTokens: number; compactions: number; lastCompactedAt?: number; method?: 'model' | 'fallback' }
  pendingInstructions: string[]
  paused?: boolean
  usage: SessionUsage
}
export type SessionSummary = Pick<AgentSession, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'workspace'>
export interface AppSettings {
  globalShortcut: string
  permissionMode: PermissionMode
  demoEnabled: boolean
  disabledTools: string[]
  enabledSkills: Record<string, boolean>
  maxContextChars: number // Legacy persisted unit; divide by 3 for the estimated input-token budget.
  memory: { enabled: boolean; autoCapture: boolean }
  activity: { enabled: boolean; useInMemory: boolean; retentionDays: number; excludedApps: string[] }
  search: { kind: 'none' | 'openrouter' | 'tavily' | 'searxng'; baseUrl: string }
}
export interface ActivityEntry {
  id: string; date: string; kind: 'focus' | 'selection'; startedAt: number; endedAt: number
  app: string; bundleId: string; window: string; activeMs: number; text: string
}
export interface ActivityReport {
  date: string; items: ActivityEntry[]; totalActiveMs: number; selections: number
  apps: { app: string; activeMs: number }[]; nextBefore?: string
}
export interface ActivityStatus {
  supported: boolean; enabled: boolean; state: 'off' | 'starting' | 'recording' | 'idle' | 'excluded' | 'locked' | 'error'
  accessibility: 'unknown' | 'granted' | 'needed'; lastSampleAt?: number; currentApp?: string; error?: string
}
export interface SkillInfo { id: string; name: string; description: string; enabled: boolean }
export type MemoryFile = 'USER.md' | 'PREFERENCES.md' | 'MEMORY.md'
export interface MemoryHit {
  path: string; startLine: number; endLine: number; content: string; score: number
  kind: 'manual' | 'preference' | 'fact' | 'decision' | 'daily'
  scope: string; updatedAt: number; sourceSession?: string; sourceMessages?: string[]
}
export interface MemoryStatus { documents: number; chunks: number; learned: number; daily: number; autoCapture: boolean; enabled: boolean; lastCaptureError?: string }
export interface ApprovalRequest {
  id: string
  sessionId: string
  toolName: string
  description: string
  arguments: Record<string, unknown>
}
export type AgentEvent =
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'reasoning_started' }
  | { type: 'citations_updated'; messageId: string; citations: WebCitation[] }
  | { type: 'tool_started'; messageId: string; activity: ToolActivity }
  | { type: 'tool_progress'; toolId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'tool_finished'; toolId: string; output: string; status: ToolActivity['status'] }
  | { type: 'tool_failed'; toolId: string; error: string }
  | { type: 'usage_updated'; usage: Usage | null; model?: ModelRef }
  | { type: 'approval_requested'; approval: ApprovalRequest }
  | { type: 'summary_updated'; summary: string }
  | { type: 'turn_finished'; status: 'complete' | 'paused' | 'stopped' | 'error' }
  | { type: 'error'; error: string }
  | { type: 'notice'; text: string }

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  available?: boolean
}
export interface ModelRequest {
  model: string
  system: string
  messages: Message[]
  tools: ToolDefinition[]
  signal: AbortSignal
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
  webSearch?: boolean
}
export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string; details?: Record<string, unknown>[] }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'citations'; citations: WebCitation[] }

export interface ModelProvider {
  id: string
  name: string
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
  capabilities(model: string): ModelCapabilities
  getUsage?(): Promise<ProviderCredits | null>
}
export interface ToolContext {
  session: AgentSession
  signal: AbortSignal
  permission: PermissionMode
  progress: (stream: 'stdout' | 'stderr', text: string) => void
  approve: (toolName: string, description: string, args: Record<string, unknown>) => Promise<boolean>
}
export interface AgentTool extends ToolDefinition {
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>
}
export interface RunControl {
  tools?: () => AgentTool[]
  provider: (ref: ModelRef) => ModelProvider
  context: (query?: string) => string
  contextWindow?: (ref: ModelRef) => number | undefined
  webSearch?: (ref: ModelRef) => boolean
  sanitize?: (text: string) => string
  flushMemory?: (session: AgentSession, through: number, signal: AbortSignal) => Promise<void>
  takeSteering: () => string[]
  onSteering?: (listener: () => void) => () => void
  permission: () => PermissionMode
  approve: ToolContext['approve']
}
export interface AgentRuntime {
  id: string
  runTurn(session: AgentSession, model: ModelRef, tools: AgentTool[], signal: AbortSignal, control: RunControl): AsyncIterable<AgentEvent>
}
export interface AppSnapshot {
  extensions: ExtensionInfo[]
  session: AgentSession
  sessions: SessionSummary[]
  providers: PublicProvider[]
  settings: AppSettings
  skills: SkillInfo[]
  memory: Record<MemoryFile, string>
  memoryStatus: MemoryStatus
  activityStatus: ActivityStatus
  runningSessions: string[]
  approvals: ApprovalRequest[]
  storagePath: string
  secureStorage: boolean
  shortcutRegistered: boolean
  shortcutStatus: string
  windowMode: 'expanded' | 'collapsed'
  environmentKeys: string[]
  searchHasKey: boolean
  tools: { name: string; enabled: boolean; available: boolean }[]
  version: string
}
export type DesktopEvent =
  | { type: 'session'; session: AgentSession; running: boolean; approvals: ApprovalRequest[]; event?: AgentEvent }
  | { type: 'settings'; tab?: 'General' | 'Activity' }
  | { type: 'focus' }
  | { type: 'refresh' }
  | { type: 'window_state'; mode: 'expanded' | 'collapsed' }
  | { type: 'activity'; status: ActivityStatus }

export interface DesktopAPI {
  provisionOpenRouter(id: string): Promise<void>
  providerCredits(id: string): Promise<ProviderCredits | null>
  usageSummary(): Promise<UsageSummary>
  importOpenRouter(): Promise<void>
  extensionAction(id: string, action: 'test' | 'install' | 'enable' | 'disable' | 'rollback'): Promise<void>
  connectExtension(id: string, input: { apiKey?: string; clientId?: string; clientSecret?: string }): Promise<void>
  disconnectExtension(id: string): Promise<void>
  openExtensionsFolder(): Promise<void>
  bootstrap(): Promise<AppSnapshot>
  send(sessionId: string, text: string): Promise<void>
  stop(sessionId: string): Promise<void>
  pause(sessionId: string): Promise<void>
  resume(sessionId: string): Promise<void>
  retry(sessionId: string, messageId: string): Promise<void>
  newSession(): Promise<AppSnapshot>
  openSession(id: string): Promise<AppSnapshot>
  setModel(sessionId: string, ref: ModelRef): Promise<void>
  chooseWorkspace(sessionId: string): Promise<string | null>
  saveProvider(input: ProviderInput): Promise<PublicProvider>
  testProvider(input: ProviderInput): Promise<ModelInfo[]>
  refreshProvider(id: string): Promise<void>
  deleteProvider(id: string): Promise<void>
  saveSettings(settings: AppSettings): Promise<void>
  saveMemory(file: MemoryFile, content: string): Promise<void>
  searchMemory(query: string): Promise<MemoryHit[]>
  readMemory(path: string, startLine?: number, lines?: number): Promise<string>
  forgetMemory(path: string): Promise<void>
  activityReport(date: string, query?: string, before?: string): Promise<ActivityReport>
  deleteActivity(date: string): Promise<void>
  captureSelection(): Promise<void>
  requestActivityPermission(): Promise<void>
  saveSearchKey(key: string): Promise<void>
  approve(id: string, allow: boolean): Promise<void>
  hide(): Promise<void>
  openDataFolder(): Promise<void>
  openExternal(url: string): Promise<void>
  enableShortcut(): Promise<void>
  expand(): Promise<void>
  collapse(): Promise<void>
  onEvent(callback: (event: DesktopEvent) => void): () => void
}
