import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Ajv } from 'ajv'
import { z } from 'zod'
import type { AgentTool, ToolContext } from '../shared/types'
import type { ExtensionPackage, ExtensionInfo, ExtensionManifest } from '../shared/extensions'
import { runExtension, validateRequest, publicRequest, requestSchema } from './extension-runtime'
import { authorizeGoogle, refreshGoogle, type GoogleClient, type GoogleTokens } from './extension-oauth'

const idSchema = z.string().regex(/^[a-z][a-z0-9-]*$/), hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.object({
  id: idSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/), name: z.string().min(1), description: z.string().min(1),
  hosts: z.array(z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/)),
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1),
  tools: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), description: z.string().min(1), inputSchema: z.record(z.string(), z.unknown()) }).strict()).min(1),
  auth: z.discriminatedUnion('type', [z.object({ type: z.literal('google-readonly') }).strict(), z.object({ type: z.literal('api-key'), header: z.string().regex(/^(?:Authorization|X-[A-Za-z0-9-]+)$/), prefix: z.string().regex(/^[\x20-\x7e]*$/) }).strict()]).optional(),
}).strict()
export const extensionPackageSchema = z.object({ manifest: manifestSchema, code: z.string().min(1), tests: z.array(z.object({
  tool: z.string(), input: z.record(z.string(), z.unknown()), expected: z.unknown(), responses: z.array(z.object({ request: requestSchema,
    response: z.object({ status: z.number().int().min(100).max(599), body: z.string() }).strict() }).strict()),
}).strict()).min(1) }).strict()
const entrySchema = z.object({ current: hashSchema.optional(), previous: hashSchema.optional(), draft: hashSchema.optional(), tested: hashSchema.optional(), enabled: z.boolean().default(false) })
type Entry = z.infer<typeof entrySchema>
interface Connection { stamp: string; apiKey?: string; client?: GoogleClient; tokens?: GoogleTokens }
interface Secrets { get(id: string): string; set(id: string, value: string): void; available(): boolean }
const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: false })
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const toolName = (id: string, name: string) => `ext_${id.replace(/-/g, '_')}_${name}`
const stamp = (manifest: ExtensionManifest) => digest({ hosts: manifest.hosts, methods: manifest.methods, auth: manifest.auth })
function validateSchema(schema: Record<string, unknown>) {
  const pending: unknown[] = [schema]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', 'patternProperties'].includes(key)) throw new Error('Plugin input schemas cannot use references or patternProperties')
      if (key === 'pattern') {
        const simple = typeof child === 'string' ? child.match(/^\^\[([^\]]+)\](\+|\*|\{\d+(?:,\d*)?\})\$$/) : null
        if (!simple || simple[1]!.replace(/\\[dw]/g, '').replace(/[A-Za-z0-9_ -]/g, '')) throw new Error('Use an anchored character-class pattern or minLength/maxLength')
      }
      pending.push(child)
    }
  }
  ajv.compile(schema)
}

export class ExtensionManager {
  private directory: string
  private active = new Map<string, Set<AbortController>>()
  private authJobs = new Map<string, AbortController>()
  private errors = new Map<string, string>()
  onChange = () => {}
  constructor(home: string, private secrets: Secrets) {
    this.directory = join(home, 'extensions')
    mkdirSync(join(this.directory, 'revisions'), { recursive: true, mode: 0o700 })
  }
  private index(): Record<string, Entry> {
    const path = join(this.directory, 'registry.json')
    return existsSync(path) ? z.record(idSchema, entrySchema).parse(JSON.parse(readFileSync(path, 'utf8'))) : {}
  }
  private write(index: Record<string, Entry>) {
    const path = join(this.directory, 'registry.json'), temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(index, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, path)
    this.onChange()
  }
  private package(id: string, revision: string): ExtensionPackage {
    idSchema.parse(id); hashSchema.parse(revision)
    const value = extensionPackageSchema.parse(JSON.parse(readFileSync(join(this.directory, 'revisions', `${id}-${revision}.json`), 'utf8')))
    if (value.manifest.id !== id || digest(value) !== revision) throw new Error('Plugin content changed after validation; stage and test it again')
    return value
  }
  private connection(id: string): Connection | undefined {
    try { const value = this.secrets.get(`extension:${id}`); return value ? JSON.parse(value) : undefined } catch { return undefined }
  }
  private connected(manifest: ExtensionManifest) {
    if (!manifest.auth) return true
    const connection = this.connection(manifest.id)
    return connection?.stamp === stamp(manifest) && Boolean(manifest.auth.type === 'api-key' ? connection.apiKey : connection.tokens?.refreshToken || connection.tokens?.accessToken)
  }
  list(): ExtensionInfo[] {
    try {
      return Object.entries(this.index()).map(([id, entry]) => {
        try {
          const value = this.package(id, (entry.current ?? entry.draft)!), draft = entry.draft ? this.package(id, entry.draft) : undefined
          return { id, name: value.manifest.name, description: value.manifest.description, version: entry.current ? value.manifest.version : undefined,
            revision: entry.current, previous: entry.previous, enabled: entry.enabled, hosts: value.manifest.hosts, methods: value.manifest.methods,
            tools: value.manifest.tools.map(t => toolName(id, t.name)), auth: value.manifest.auth, connected: this.connected(value.manifest),
            draft: draft ? { revision: entry.draft!, version: draft.manifest.version, tested: entry.tested === entry.draft } : undefined, error: this.errors.get(id) }
        } catch (error) { return { id, name: id, description: '', enabled: false, hosts: [], methods: [], tools: [], connected: false, error: (error as Error).message } }
      })
    } catch { return [{ id: 'registry', name: 'Plugin registry', description: '', enabled: false, hosts: [], methods: [], tools: [], connected: false, error: '插件索引损坏；已停止加载，原文件保留。' }] }
  }
  stage(input: unknown) {
    const value = extensionPackageSchema.parse(input), { id, tools, auth, hosts, methods } = value.manifest
    if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error('Plugin tool names must be unique')
    for (const tool of tools) {
      if (tool.inputSchema.type !== 'object' || !value.tests.some(test => test.tool === tool.name)) throw new Error('Each tool needs an object input schema and at least one test')
      validateSchema(tool.inputSchema)
    }
    if (value.tests.some(test => !tools.some(tool => tool.name === test.tool))) throw new Error('Test refers to an unknown tool')
    if (auth?.type === 'api-key' && hosts.length !== 1) throw new Error('API-key plugins must declare exactly one credential destination')
    if (auth?.type === 'google-readonly' && (!hosts.length || hosts.some(host => !['gmail.googleapis.com', 'www.googleapis.com'].includes(host)) || methods.some(method => method !== 'GET'))) throw new Error('Gmail plugins are limited to Gmail hosts and GET')
    const revision = digest(value), index = this.index()
    const path = join(this.directory, 'revisions', `${id}-${revision}.json`)
    if (!existsSync(path)) writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    index[id] = { ...index[id], enabled: index[id]?.enabled ?? false, draft: revision, tested: undefined }
    this.write(index)
    return { id, revision, tests: value.tests.length, state: 'draft' }
  }
  read(id: string, target: 'current' | 'draft' = 'current'): ExtensionPackage {
    idSchema.parse(id)
    const revision = this.index()[id]?.[target]
    if (!revision) throw new Error(`Plugin has no ${target} revision`)
    return this.package(id, revision)
  }
  async test(id: string, signal: AbortSignal) {
    idSchema.parse(id)
    const revision = this.index()[id]?.draft
    if (!revision) throw new Error('No plugin draft to test')
    const value = this.package(id, revision)
    for (const test of value.tests) {
      const tool = value.manifest.tools.find(t => t.name === test.tool)!, validate = ajv.compile(tool.inputSchema)
      if (!validate(test.input)) throw new Error(`Invalid test input: ${ajv.errorsText(validate.errors)}`)
      const fixtures = [...test.responses]
      const output = await runExtension(value.code, test.tool, test.input, signal, async request => {
        const parsed = validateRequest(value.manifest, request), fixture = fixtures.shift()
        if (!fixture || !isDeepStrictEqual(parsed, validateRequest(value.manifest, fixture.request))) throw new Error('Plugin test made an unexpected HTTP request')
        return fixture.response
      })
      if (!isDeepStrictEqual(output, test.expected) || fixtures.length) throw new Error(`Plugin test failed: ${test.tool}; actual=${JSON.stringify(output)}`)
    }
    signal.throwIfAborted()
    const index = this.index()
    if (index[id]?.draft !== revision) throw new Error('Draft changed during testing; test the new revision')
    index[id]!.tested = revision; this.write(index)
    return { id, revision, passed: value.tests.length }
  }
  async install(id: string, signal: AbortSignal) {
    const before = this.index()[id]
    const checked = await this.test(id, signal), index = this.index(), entry = index[id]!
    if (entry.draft !== checked.revision || entry.tested !== checked.revision) throw new Error('Draft changed before installation')
    if (entry.current !== before?.current || entry.enabled !== before?.enabled) throw new Error('Plugin state changed during testing; installation cancelled')
    this.abort(id)
    index[id] = { current: checked.revision, previous: entry.current !== checked.revision ? entry.current : entry.previous, enabled: true }
    this.write(index); this.errors.delete(id)
    return { id, revision: checked.revision, installed: true, tools: this.list().find(item => item.id === id)!.tools }
  }
  setEnabled(id: string, enabled: boolean) {
    idSchema.parse(id); const index = this.index()
    if (!index[id]?.current) throw new Error('Plugin is not installed')
    this.package(id, index[id]!.current!); this.abort(id); index[id]!.enabled = enabled; this.write(index)
  }
  rollback(id: string) {
    idSchema.parse(id); const index = this.index(), entry = index[id]
    if (!entry?.previous) throw new Error('No previous installed version')
    this.package(id, entry.previous); this.abort(id)
    index[id] = { ...entry, current: entry.previous, previous: entry.current, enabled: true }; this.write(index)
  }
  private abort(id: string) { for (const controller of this.active.get(id) ?? []) controller.abort(); this.authJobs.get(id)?.abort() }
  tools(): AgentTool[] {
    return this.list().filter(item => item.enabled && item.revision && !item.error).flatMap(item => {
      const value = this.package(item.id, item.revision!)
      return value.manifest.tools.map(tool => ({ name: toolName(item.id, tool.name), description: `${tool.description}${!item.connected ? ' Requires human connection in Settings → Extensions.' : ''}`, inputSchema: tool.inputSchema,
        execute: async (input: Record<string, unknown>, context: ToolContext) => {
          if (this.index()[item.id]?.current !== item.revision || !this.index()[item.id]?.enabled) throw new Error('Plugin changed or disabled; refresh the tool plan')
          const validate = ajv.compile(tool.inputSchema)
          if (!validate(input)) throw new Error(`Plugin input: ${ajv.errorsText(validate.errors)}`)
          if (!this.connected(value.manifest)) throw new Error('请在 Settings → Extensions 配置 API Key 或连接 Gmail；尚未访问真实账号。')
          const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal])
          const active = this.active.get(item.id) ?? new Set<AbortController>(); this.active.set(item.id, active); active.add(controller)
          try {
            const output = await runExtension(value.code, tool.name, input, signal, async (request, requestSignal) => {
              const parsed = validateRequest(value.manifest, request)
              const headers: Record<string, string> = {}, connection = this.connection(item.id)
              if (value.manifest.auth?.type === 'api-key') headers[value.manifest.auth.header] = value.manifest.auth.prefix + connection!.apiKey
              if (value.manifest.auth?.type === 'google-readonly') {
                let tokens = connection!.tokens!
                if (tokens.expiresAt <= Date.now()) {
                  tokens = await refreshGoogle(connection!.client!, tokens, requestSignal); requestSignal.throwIfAborted()
                  if (digest(this.connection(item.id)) !== digest(connection)) throw new Error('Connection changed; retry with the current connection')
                  this.secrets.set(`extension:${item.id}`, JSON.stringify({ ...connection, tokens }))
                }
                headers.Authorization = `Bearer ${tokens.accessToken}`
              }
              try { return await publicRequest(parsed, requestSignal, headers) }
              catch (error) {
                let message = error instanceof Error ? error.message : 'Plugin HTTP request failed'
                for (const secret of [connection?.apiKey, ...Object.values(headers)]) if (secret) message = message.split(secret).join('[redacted]')
                throw new Error(message)
              }
            })
            return JSON.stringify({ source: `extension:${item.id}@${value.manifest.version}`, untrustedData: output })
          } finally { active.delete(controller) }
        } }))
    })
  }
  async connect(id: string, input: { apiKey?: string; clientId?: string; clientSecret?: string }, open: (url: string) => Promise<unknown>) {
    idSchema.parse(id); const entry = this.index()[id]
    if (!entry?.current || !entry.enabled) throw new Error('请先安装并启用插件。')
    if (!this.secrets.available()) throw new Error('系统加密存储不可用，无法保存插件账号连接。')
    const manifest = this.package(id, entry.current).manifest
    if (!manifest.auth) throw new Error('This plugin needs no account connection')
    this.abort(id); this.errors.delete(id)
    if (manifest.auth.type === 'api-key') {
      if (!input.apiKey?.trim()) throw new Error('请输入该插件服务的 API Key。')
      if (!/^[\x21-\x7e]+$/.test(input.apiKey.trim())) throw new Error('API Key 不能包含空白或控制字符。')
      this.secrets.set(`extension:${id}`, JSON.stringify({ stamp: stamp(manifest), apiKey: input.apiKey.trim() })); this.onChange(); return
    }
    const previous = this.connection(id), client = { clientId: input.clientId?.trim() || previous?.client?.clientId || '', clientSecret: input.clientSecret || previous?.client?.clientSecret }
    if (!/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(client.clientId)) throw new Error('请填写 Google Cloud 的桌面应用 OAuth Client ID。')
    const controller = new AbortController(); this.authJobs.set(id, controller)
    try {
      const tokens = await authorizeGoogle(client, controller.signal, open)
      controller.signal.throwIfAborted()
      if (this.index()[id]?.current !== entry.current) throw new Error('插件已更新，请重新连接。')
      this.secrets.set(`extension:${id}`, JSON.stringify({ stamp: stamp(manifest), client, tokens }))
      this.errors.delete(id)
    } catch (error) { if (this.authJobs.get(id) === controller && !controller.signal.aborted) this.errors.set(id, (error as Error).message); throw error }
    finally { if (this.authJobs.get(id) === controller) this.authJobs.delete(id); this.onChange() }
  }
  disconnect(id: string) { idSchema.parse(id); this.abort(id); this.authJobs.delete(id); this.secrets.set(`extension:${id}`, ''); this.errors.delete(id); this.onChange() }
  close() { for (const id of new Set([...this.active.keys(), ...this.authJobs.keys()])) this.abort(id) }
}
