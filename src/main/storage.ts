import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentSession, AppSettings, MemoryFile, ProviderConfig, SessionSummary, SkillInfo } from '../shared/types'
import { DEFAULT_SHORTCUT } from '../shared/shortcuts'
import { DEFAULT_CONTEXT_CHARS } from '../shared/context'
import { MemoryStore } from './memory'
import { ActivityStore, defaultActivity } from './activity-store'
import { defaultReminder } from './reminder'
import { ExtensionManager } from './extensions'
import { UsageStore } from './usage'

export interface SecureCodec {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}
const memoryFiles: MemoryFile[] = ['USER.md', 'PREFERENCES.md', 'MEMORY.md']
const defaults: AppSettings = {
  globalShortcut: DEFAULT_SHORTCUT,
  permissionMode: 'full', demoEnabled: false, disabledTools: [], enabledSkills: {}, maxContextChars: DEFAULT_CONTEXT_CHARS,
  memory: { enabled: true, autoCapture: true },
  activity: structuredClone(defaultActivity),
  search: { kind: 'none', baseUrl: '' },
  reminder: structuredClone(defaultReminder),
}

export function dataHome(userHome = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAX_HOME || env.DESKAGENT_HOME
  if (configured) return configured
  const home = join(userHome, '.clax'), legacy = join(userHome, '.deskagent')
  // Migrate the complete store once; never overwrite an existing Clax directory.
  if (!existsSync(home) && existsSync(legacy)) renameSync(legacy, home)
  return home
}

export class LocalStore {
  private db: DatabaseSync
  private volatileSecrets = new Map<string, string>()
  settings: AppSettings
  providers: ProviderConfig[]
  memory: MemoryStore
  activity: ActivityStore
  extensions: ExtensionManager
  usage: UsageStore
  constructor(public home: string, private codec: SecureCodec, private defaultWorkspace: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    mkdirSync(join(home, 'memory'), { recursive: true })
    mkdirSync(join(home, 'skills', 'coding'), { recursive: true })
    for (const file of memoryFiles) {
      const path = join(home, 'memory', file)
      if (!existsSync(path)) writeFileSync(path, `# ${file.replace('.md', '')}\n\n`, { mode: 0o600 })
    }
    const skillPath = join(home, 'skills', 'coding', 'SKILL.md')
    if (!existsSync(skillPath)) writeFileSync(skillPath, '# Coding\nInspect the project before editing. Keep changes concise. Run focused checks and explain the results.\n')
    const saved = this.readJSON<Partial<AppSettings>>('settings.json', {})
    this.settings = { ...structuredClone(defaults), ...saved, memory: { ...defaults.memory, ...saved.memory }, activity: { ...structuredClone(defaultActivity), ...saved.activity }, reminder: { ...structuredClone(defaultReminder), ...saved.reminder } }
    // Upgrade previous defaults; keep independently selected alternatives.
    if (['Alt+Space', 'Control+Shift+Space'].includes(this.settings.globalShortcut)) {
      this.settings.globalShortcut = DEFAULT_SHORTCUT
      this.writeJSON('settings.json', this.settings)
    }
    this.providers = this.readJSON('providers.json', [])
    this.db = new DatabaseSync(join(home, 'sessions.db'))
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);')
    this.usage = new UsageStore(this.db)
    this.usage.importLegacy(this.db.prepare('SELECT payload FROM sessions').all().map(row => JSON.parse(row.payload as string)))
    this.memory = new MemoryStore(home)
    this.activity = new ActivityStore(home, this.memory.sanitize)
    this.extensions = new ExtensionManager(home, { get: id => this.getSecret(id), set: (id, value) => this.setSecret(id, value), available: () => this.secureStorage })
    // A crashed process cannot leave a resumable live request or a dangling tool pair.
    for (const row of this.db.prepare('SELECT payload FROM sessions').all()) {
      const session = JSON.parse(row.payload as string) as AgentSession
      let dirty = session.pendingInstructions.length > 0
      let scoped = false
      const renamedRuntime = session.runtime === 'deskagent'
      if (renamedRuntime) session.runtime = 'clax'
      for (const message of session.messages) {
        if (!message.workspace) { message.workspace = session.workspace; scoped = true }
        if (message.status === 'streaming') { message.status = 'stopped'; dirty = true }
        for (const activity of message.activities ?? []) {
          if (activity.status === 'running' || activity.status === 'awaiting') {
            activity.status = 'stopped'; activity.output += '\nInterrupted by application restart.'; dirty = true
          }
        }
        for (const call of message.toolCalls ?? []) {
          if (!session.messages.some(m => m.toolCallId === call.id)) {
            session.messages.push({ id: randomUUID(), turnId: message.turnId, role: 'tool', toolCallId: call.id,
              toolName: call.name, content: 'Interrupted by application restart.', createdAt: Date.now() })
            dirty = true
          }
        }
      }
      if (session.pendingInstructions.length) {
        for (const text of session.pendingInstructions) session.messages.push({ id: randomUUID(), turnId: randomUUID(), role: 'user', content: text, createdAt: Date.now() })
        session.pendingInstructions = []
      }
      if (dirty) this.saveSession(session)
      else if (renamedRuntime || scoped) this.db.prepare('UPDATE sessions SET payload = ? WHERE id = ?').run(JSON.stringify(session), session.id)
    }
  }
  get secureStorage() { return this.codec.available() }
  readJSON<T>(name: string, fallback: T): T {
    const path = join(this.home, name)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : structuredClone(fallback)
  }
  writeJSON(name: string, value: unknown) {
    const path = join(this.home, name)
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
  getSecret(id: string): string {
    if (this.volatileSecrets.has(id)) return this.volatileSecrets.get(id)!
    const encrypted = this.readJSON<Record<string, string>>('credentials.json', {})[id]
    if (!encrypted) return ''
    try { return this.codec.decrypt(Buffer.from(encrypted, 'base64')) }
    catch { return '' }
  }
  setSecret(id: string, value: string) {
    const secrets = this.readJSON<Record<string, string>>('credentials.json', {})
    delete secrets[id]
    this.volatileSecrets.delete(id)
    // Linux's basic_text backend does not provide meaningful encryption.
    if (value && this.codec.available()) secrets[id] = this.codec.encrypt(value).toString('base64')
    else if (value) this.volatileSecrets.set(id, value)
    this.writeJSON('credentials.json', secrets)
  }
  saveSettings(settings: AppSettings) { this.settings = settings; this.writeJSON('settings.json', settings) }
  saveProviders(providers: ProviderConfig[]) { this.providers = providers; this.writeJSON('providers.json', providers) }
  saveSession(session: AgentSession) {
    session.updatedAt = Date.now()
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at')
      .run(session.id, JSON.stringify(session), session.updatedAt)
  }
  getSession(id: string): AgentSession | null {
    const row = this.db.prepare('SELECT payload FROM sessions WHERE id = ?').get(id)
    return row ? JSON.parse(row.payload as string) as AgentSession : null
  }
  migrateModels(from: string[], model: AgentSession['currentModel']) {
    for (const row of this.db.prepare('SELECT payload FROM sessions').all()) {
      const session = JSON.parse(row.payload as string) as AgentSession
      if (!session.currentModel || from.includes(session.currentModel.provider)) {
        session.currentModel = model; this.saveSession(session)
      }
    }
  }
  listSessions(): SessionSummary[] {
    return this.db.prepare('SELECT payload FROM sessions ORDER BY updated_at DESC LIMIT 60').all().map(row => {
      const s = JSON.parse(row.payload as string) as AgentSession
      return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, workspace: s.workspace }
    })
  }
  createSession(model: AgentSession['currentModel'] = null): AgentSession {
    const session: AgentSession = {
      id: randomUUID(), title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), workspace: this.defaultWorkspace,
      currentModel: model, runtime: 'clax', messages: [], summary: '', summarizedCount: 0, pendingInstructions: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheAvailable: false,
        estimatedCost: null, reportedRequests: 0, unreportedRequests: 0 },
    }
    this.saveSession(session)
    return session
  }
  getMemory(): Record<MemoryFile, string> {
    return Object.fromEntries(memoryFiles.map(file => [file, readFileSync(join(this.home, 'memory', file), 'utf8')])) as Record<MemoryFile, string>
  }
  saveMemory(file: MemoryFile, content: string) {
    if (!memoryFiles.includes(file)) throw new Error('Unknown memory file')
    if (content.length > 100000) throw new Error('Memory file is too large')
    const path = join(this.home, 'memory', file)
    writeFileSync(`${path}.tmp`, content, { mode: 0o600 }); renameSync(`${path}.tmp`, path)
    this.memory.sync()
  }
  listSkills(): SkillInfo[] {
    return readdirSync(join(this.home, 'skills'), { withFileTypes: true }).filter(dir => dir.isDirectory()).flatMap(dir => {
      const path = join(this.home, 'skills', dir.name, 'SKILL.md')
      if (!existsSync(path)) return []
      const content = readFileSync(path, 'utf8').slice(0, 8000)
      return [{ id: dir.name, name: content.match(/^#\s+(.+)$/m)?.[1] ?? dir.name,
        description: content.split('\n').find(line => line.trim() && !line.startsWith('#') && !line.startsWith('---')) ?? '',
        enabled: this.settings.enabledSkills[dir.name] !== false }]
    })
  }
  context(query = '', workspace = this.defaultWorkspace): string {
    const memory = this.settings.memory.enabled ? this.memory.context(query, workspace) : 'Local memory is disabled.'
    const skills = this.listSkills().filter(s => s.enabled).map(s =>
      `## Skill: ${s.name}\n${readFileSync(join(this.home, 'skills', s.id, 'SKILL.md'), 'utf8').slice(0, 4000)}`,
    ).join('\n\n').slice(0, 8000)
    const activity = this.settings.memory.enabled && this.settings.activity.useInMemory ? this.activity.context(query) : ''
    // A direct question about desktop activity must retain its evidence when the context is bounded.
    return `${activity}${memory}\n\nEnabled skills:\n${skills}`
  }
  close() { this.extensions.close(); this.activity.close(); this.memory.close(); this.db.close() }
}
