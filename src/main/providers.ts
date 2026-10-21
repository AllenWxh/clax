import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Message, ModelCapabilities, ModelEvent, ModelInfo, ModelProvider, ModelRequest, ProviderConfig, ProviderCredits, ToolCall, Usage } from '../shared/types'
import { REASONING_EFFORTS } from '../shared/models'
import { parseCitations } from '../shared/citations'

export function endpoint(base: string, path: string) { return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}` }

export async function providerRequest(url: string, key: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  if (key && !headers.has('x-api-key') && !headers.has('x-goog-api-key')) headers.set('Authorization', `Bearer ${key}`)
  if (options.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, { ...options, headers })
  if (!response.ok) {
    let detail = (await response.text()).slice(0, 1400)
    if (key) detail = detail.split(key).join('[redacted]')
    throw new Error(`Provider HTTP ${response.status}: ${detail || response.statusText}`)
  }
  return response
}
const request = providerRequest

/** Decode incrementally: UTF-8, CRLF, multi-line SSE and split network chunks. */
export async function* lines(response: Response): AsyncIterable<string> {
  if (!response.body) throw new Error('Provider returned an empty stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        yield buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
      }
      if (done) { if (buffer) yield buffer.replace(/\r$/, ''); break }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export async function* sse(response: Response): AsyncIterable<{ event: string; data: any }> {
  let event = ''
  let data: string[] = []
  for await (const line of lines(response)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    else if (!line && data.length) {
      const raw = data.join('\n'); data = []
      if (raw === '[DONE]') return
      yield { event, data: JSON.parse(raw) }; event = ''
    }
  }
  if (data.length && data.join('\n') !== '[DONE]') yield { event, data: JSON.parse(data.join('\n')) }
}
function argumentsObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool arguments from provider')
  return value as Record<string, unknown>
}
function chatMessages(system: string, messages: Message[], providerId?: string, model?: string, openrouter = false) {
  return [{ role: 'system', content: system }, ...messages.map(m => m.role === 'tool'
    ? { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
    : { role: m.role, content: m.content || (m.toolCalls?.length ? null : ''),
      ...(openrouter && m.role === 'assistant' && m.citations?.length ? { annotations: m.citations.map(c => ({ type: 'url_citation', url_citation: {
        url: c.url, title: c.title, content: c.content, start_index: c.startIndex, end_index: c.endIndex } })) } : {}),
      ...(m.model?.provider === providerId && m.model?.model === model ? openrouter
        ? m.reasoningDetails?.length ? { reasoning_details: m.reasoningDetails } : m.reasoningContent ? { reasoning: m.reasoningContent } : {}
        : m.reasoningContent ? { reasoning_content: m.reasoningContent } : {} : {}),
      ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) })]
}
class BaseProvider {
  id: string
  name: string
  constructor(protected config: ProviderConfig, protected key: string, protected creditsKey = key) { this.id = config.id; this.name = config.name }
  capabilities(model: string): ModelCapabilities { return this.config.models.find(m => m.id === model) ?? { tools: this.config.toolCalling } }
  async getUsage(): Promise<ProviderCredits | null> { return null }
  protected model(id: string, name = id, extras: Partial<ModelInfo> = {}): ModelInfo {
    return { provider: this.id, id, name, tools: this.config.toolCalling, contextWindow: this.config.contextWindow, ...extras }
  }
}

export class CompatibleProvider extends BaseProvider implements ModelProvider {
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await (await request(endpoint(this.config.baseUrl, 'models'), this.key, { signal })).json() as any
    if (!Array.isArray(body.data)) throw new Error('No /models catalogue. Enter model IDs manually.')
    const router = this.config.kind === 'openrouter'
    return body.data.filter((m: any) => typeof m.id === 'string' && (!router || !m.id.endsWith(':batch') && (!m.architecture?.output_modalities || m.architecture.output_modalities.includes('text')))).map((m: any) => this.model(m.id, m.name ?? m.id,
      { contextWindow: m.context_length ?? m.context_window ?? this.config.contextWindow,
        ...(router ? { tools: this.config.toolCalling && (m.supported_parameters ?? []).includes('tools'),
          reasoning: (m.supported_parameters ?? []).includes('reasoning'),
          reasoningEfforts: (m.reasoning?.supported_efforts === null ? REASONING_EFFORTS : Array.isArray(m.reasoning?.supported_efforts) ? m.reasoning.supported_efforts.filter((value: any) => REASONING_EFFORTS.includes(value)) : []).filter((value: string) => value !== 'none' || !m.reasoning?.mandatory),
          maxOutputTokens: m.top_provider?.max_completion_tokens } : {}) }))
  }
  async getUsage(): Promise<ProviderCredits | null> {
    if (this.config.kind !== 'openrouter') return null
    const get = async (path: string) => (await (await request(endpoint(this.config.baseUrl, path), path === 'credits' ? this.creditsKey : this.key, { signal: AbortSignal.timeout(20000) })).json() as any).data
    const [key, account] = await Promise.allSettled([get('key'), get('credits')])
    if (key.status === 'rejected' && account.status === 'rejected') throw key.reason
    const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
    const k = key.status === 'fulfilled' ? key.value : {}, a = account.status === 'fulfilled' ? account.value : {}
    const credits = number(a.total_credits), used = number(a.total_usage)
    return { updatedAt: Date.now(), balance: credits !== null && used !== null ? credits - used : null,
      keyLimit: number(k.limit), keyRemaining: number(k.limit_remaining), keyUsage: number(k.usage),
      managementKey: k.is_management_key === true || k.is_provisioning_key === true,
      ...(account.status === 'rejected' ? { error: '账户余额暂不可用（部分账号需 Management Key）；Key 限额及本机用量仍可查看。' } : {}) }
  }
  async *stream(input: ModelRequest): AsyncIterable<ModelEvent> {
    const router = this.config.kind === 'openrouter'
    const tools: unknown[] = input.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
    if (router && input.webSearch) tools.push({ type: 'openrouter:web_search', parameters: { engine: 'native' } })
    if (router && input.reasoningEffort && !this.config.models.find(m => m.id === input.model)?.reasoningEfforts?.includes(input.reasoningEffort)) throw new Error('This model does not support the selected reasoning effort. Refresh the catalogue and choose again.')
    const response = await request(endpoint(this.config.baseUrl, 'chat/completions'), this.key, {
      method: 'POST', signal: input.signal, body: JSON.stringify({
        model: input.model, messages: chatMessages(input.system, input.messages, this.id, input.model, router), stream: true, stream_options: { include_usage: true },
        ...(router && input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
        ...(input.maxOutputTokens ? this.config.kind === 'openai' ? { max_completion_tokens: input.maxOutputTokens } : { max_tokens: input.maxOutputTokens } : {}),
        ...(tools.length ? { tools } : {}),
      }),
    })
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    for await (const { data } of sse(response)) {
      if (data.error) throw new Error(data.error.message ?? 'Provider stream error')
      const delta = data.choices?.[0]?.delta
      const citations = parseCitations(delta?.annotations ?? data.choices?.[0]?.message?.annotations ?? data.annotations)
      if (citations.length) yield { type: 'citations', citations }
      if (delta?.content) yield { type: 'text', text: delta.content }
      if (delta?.reasoning_content || delta?.reasoning) yield { type: 'reasoning', text: delta.reasoning_content ?? delta.reasoning }
      if (router && Array.isArray(delta?.reasoning_details)) yield { type: 'reasoning', details: delta.reasoning_details }
      for (const item of delta?.tool_calls ?? []) {
        if (item.type && item.type !== 'function') continue
        const call = calls.get(item.index) ?? { id: '', name: '', arguments: '' }
        if (item.id) call.id = item.id
        call.name += item.function?.name ?? ''
        call.arguments += item.function?.arguments ?? ''
        calls.set(item.index, call)
      }
      if (data.usage) {
        const u = data.usage
        yield { type: 'usage', usage: { inputTokens: u.prompt_tokens ?? u.input_tokens, outputTokens: u.completion_tokens ?? u.output_tokens,
          cachedTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens,
          cacheWriteTokens: u.prompt_tokens_details?.cache_write_tokens,
          reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
          ...(Number.isSafeInteger(u.server_tool_use?.web_search_requests) && u.server_tool_use.web_search_requests >= 0 ? { webSearchRequests: u.server_tool_use.web_search_requests } : {}),
          ...(typeof u.cost === 'number' && Number.isFinite(u.cost) ? { cost: u.cost } : {}) } }
      }
      if (data.choices?.[0]?.finish_reason === 'length') throw new Error('Model output reached its token limit. Retry or use another model.')
    }
    for (const call of calls.values()) if (call.name) yield { type: 'tool_call', call: { id: call.id || randomUUID(), name: call.name, arguments: argumentsObject(call.arguments) } }
  }
}

export class AnthropicProvider extends BaseProvider implements ModelProvider {
  private headers() { return { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' } }
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await (await request(endpoint(this.config.baseUrl, 'models'), '', { signal, headers: this.headers() })).json() as any
    return (body.data ?? []).map((m: any) => this.model(m.id, m.display_name ?? m.id))
  }
  async *stream(input: ModelRequest): AsyncIterable<ModelEvent> {
    const messages: { role: string; content: any[] }[] = []
    for (const m of input.messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user'
      const blocks = m.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
        : [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments }))]
      if (!blocks.length) continue
      if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...blocks)
      else messages.push({ role, content: blocks })
    }
    const response = await request(endpoint(this.config.baseUrl, 'messages'), '', { method: 'POST', signal: input.signal,
      headers: this.headers(), body: JSON.stringify({ model: input.model, system: input.system, messages, max_tokens: input.maxOutputTokens ?? 8192, stream: true,
        ...(input.tools.length ? { tools: input.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}) }) })
    const calls = new Map<number, { id: string; name: string; input: Record<string, unknown>; json: string }>()
    let usage: Usage | undefined
    for await (const { event, data } of sse(response)) {
      if (event === 'error') throw new Error(data.error?.message ?? 'Anthropic stream error')
      if (event === 'message_start') {
        const u = data.message.usage
        usage = { inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0, cachedTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens }
      }
      if (event === 'content_block_start' && data.content_block.type === 'tool_use') calls.set(data.index, { ...data.content_block, json: '' })
      if (data.delta?.type === 'text_delta') yield { type: 'text', text: data.delta.text }
      if (data.delta?.type === 'thinking_delta') yield { type: 'reasoning' }
      if (data.delta?.type === 'input_json_delta') { const call = calls.get(data.index); if (call) call.json += data.delta.partial_json }
      if (event === 'content_block_stop') {
        const call = calls.get(data.index)
        if (call) yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: call.json ? argumentsObject(call.json) : call.input } }
      }
      if (event === 'message_delta' && usage) usage.outputTokens = data.usage?.output_tokens ?? usage.outputTokens
    }
    if (usage) yield { type: 'usage', usage }
  }
}

export class OllamaProvider extends BaseProvider implements ModelProvider {
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await (await request(endpoint(this.config.baseUrl, 'api/tags'), this.key, { signal })).json() as any
    return (body.models ?? []).map((m: any) => this.model(m.name))
  }
  async *stream(input: ModelRequest): AsyncIterable<ModelEvent> {
    const messages = chatMessages(input.system, input.messages).map((m: any) => m.tool_calls
      ? { ...m, tool_calls: m.tool_calls.map((c: any) => ({ function: { name: c.function.name, arguments: JSON.parse(c.function.arguments) } })) }
      : m)
    const response = await request(endpoint(this.config.baseUrl, 'api/chat'), this.key, { method: 'POST', signal: input.signal,
      body: JSON.stringify({ model: input.model, messages, stream: true,
        ...(input.maxOutputTokens ? { options: { num_predict: input.maxOutputTokens } } : {}),
        ...(input.tools.length ? { tools: input.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}) }) })
    for await (const line of lines(response)) {
      if (!line.trim()) continue
      const data = JSON.parse(line)
      if (data.error) throw new Error(data.error)
      if (data.message?.content) yield { type: 'text', text: data.message.content }
      if (data.message?.thinking) yield { type: 'reasoning' }
      for (const call of data.message?.tool_calls ?? []) yield { type: 'tool_call', call: {
        id: randomUUID(), name: call.function.name, arguments: typeof call.function.arguments === 'string' ? argumentsObject(call.function.arguments) : call.function.arguments,
      } }
      if (data.done && typeof data.prompt_eval_count === 'number' && typeof data.eval_count === 'number')
        yield { type: 'usage', usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count } }
    }
  }
}

export class GeminiProvider extends BaseProvider implements ModelProvider {
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await (await request(endpoint(this.config.baseUrl, 'models'), '', { signal, headers: { 'x-goog-api-key': this.key } })).json() as any
    return (body.models ?? []).filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m: any) => this.model(m.name.replace(/^models\//, ''), m.displayName, { contextWindow: m.inputTokenLimit }))
  }
  async *stream(input: ModelRequest): AsyncIterable<ModelEvent> {
    const contents = input.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: m.role === 'tool'
      ? [{ functionResponse: { name: m.toolName, response: { output: m.content } } }]
      : [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map(c => ({ functionCall: { name: c.name, args: c.arguments }, ...(c.signature ? { thoughtSignature: c.signature } : {}) }))] }))
      .filter(m => m.parts.length)
    const response = await request(endpoint(this.config.baseUrl, `models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`), '', {
      method: 'POST', signal: input.signal, headers: { 'x-goog-api-key': this.key }, body: JSON.stringify({ contents,
        systemInstruction: { parts: [{ text: input.system }] },
        ...(input.maxOutputTokens ? { generationConfig: { maxOutputTokens: input.maxOutputTokens } } : {}),
        ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] } : {}),
      }),
    })
    let usage: Usage | undefined
    for await (const { data } of sse(response)) {
      if (data.error) throw new Error(data.error.message)
      for (const part of data.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought) yield { type: 'reasoning' }
        else if (part.text) yield { type: 'text', text: part.text }
        if (part.functionCall) yield { type: 'tool_call', call: { id: randomUUID(), name: part.functionCall.name,
          arguments: part.functionCall.args ?? {}, signature: part.thoughtSignature } }
      }
      if (data.usageMetadata) { const u = data.usageMetadata; usage = { inputTokens: u.promptTokenCount ?? 0,
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cachedTokens: u.cachedContentTokenCount, reasoningTokens: u.thoughtsTokenCount } }
    }
    if (usage) yield { type: 'usage', usage }
  }
}

export const demoConfig: ProviderConfig = {
  id: 'demo', name: 'Demo · scripted', kind: 'mock', baseUrl: '', toolCalling: true,
  models: [{ provider: 'demo', id: 'demo-tools', name: 'Demo Tools', tools: true }, { provider: 'demo', id: 'demo-chat', name: 'Demo Chat', tools: true }],
}
export class MockProvider extends BaseProvider implements ModelProvider {
  async listModels() { return demoConfig.models }
  async *stream(input: ModelRequest): AsyncIterable<ModelEvent> {
    input.signal.throwIfAborted()
    const userIndex = input.messages.findLastIndex(m => m.role === 'user')
    const text = input.messages[userIndex]?.content ?? ''
    const results = input.messages.slice(userIndex + 1).filter(m => m.role === 'tool')
    if (!results.length && input.tools.length && input.model === 'demo-tools') {
      let call: ToolCall | undefined
      if (/slow|慢|停止测试/.test(text)) call = { id: randomUUID(), name: 'shell', arguments: { command: 'node -e "let i=0; setInterval(()=>console.log(++i),500)"', timeout: 30000 } }
      else if (/shell|运行|执行|test|version/.test(text)) call = { id: randomUUID(), name: 'shell', arguments: { command: /test/.test(text) ? 'npm test' : 'node --version', timeout: 60000 } }
      else if (/read|读取/.test(text)) call = { id: randomUUID(), name: 'read_file', arguments: { path: 'package.json' } }
      else if (/files|文件|目录|list/.test(text)) call = { id: randomUUID(), name: 'list_directory', arguments: { path: '.' } }
      if (call) { yield { type: 'text', text: '我先检查一下。\n' }; await delay(100, undefined, { signal: input.signal }); yield { type: 'tool_call', call }; return }
    }
    const reply = results.length
      ? `已完成，以下是本机工具的真实结果：\n\n\`\`\`text\n${results.map(m => m.content).join('\n').slice(0, 8000)}\n\`\`\`\n\n*Demo Provider 使用脚本回复，工具实际在本机执行。*`
      : input.tools.length ? `收到：${text}\n\n当前是 **${input.model}** 演示模型。试试「列出当前项目文件」或「运行 node --version」。连接真实 Provider 后可以自由提问。`
        : 'Earlier conversation covered local development, workspace inspection and tool results. Keep following the user’s latest instructions.'
    for (let i = 0; i < reply.length; i += 9) { input.signal.throwIfAborted(); yield { type: 'text', text: reply.slice(i, i + 9) }; await delay(15, undefined, { signal: input.signal }) }
    // Deliberately no synthetic usage event.
  }
}
export function createProvider(config: ProviderConfig, key: string, creditsKey?: string): ModelProvider {
  switch (config.kind) {
    case 'openrouter': case 'openai': case 'compatible': return new CompatibleProvider(config, key, creditsKey)
    case 'anthropic': return new AnthropicProvider(config, key)
    case 'gemini': return new GeminiProvider(config, key)
    case 'ollama': return new OllamaProvider(config, key)
    case 'mock': return new MockProvider(config, key)
  }
}
