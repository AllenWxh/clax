import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnthropicProvider, OllamaProvider, GeminiProvider, sse } from '../src/main/providers'
import type { ModelRequest, ProviderConfig, ModelEvent } from '../src/shared/types'

const input: ModelRequest = { model: 'test', system: 'system', messages: [{ id: 'u', turnId: 't', role: 'user', content: 'hi', createdAt: 1 }], tools: [], signal: new AbortController().signal }
test('SSE preserves valid responses larger than the former 2 MB frame cap', async () => {
  const value = 'x'.repeat(2100000) + 'END'
  const response = new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: value } }] }) + '\n\ndata: [DONE]\n\n')
  const frames = []
  for await (const frame of sse(response)) frames.push(frame.data)
  assert.equal(frames[0].choices[0].delta.content, value)
})
async function collect(iterable: AsyncIterable<ModelEvent>) { const result: ModelEvent[] = []; for await (const event of iterable) result.push(event); return result }
async function serverFor(body: string, type: string) {
  const server = createServer((_, response) => { response.setHeader('Content-Type', type); response.end(body) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
const config = (url: string, kind: ProviderConfig['kind']): ProviderConfig => ({ id: kind, name: kind, kind, baseUrl: url, models: [], toolCalling: true })
test('SSE handles comments, multi-line JSON and a final frame without newline', async () => {
  const response = new Response(': heartbeat\r\nevent: message\r\ndata: {"value":\r\ndata: "ok"}\r\n\r\ndata: {"last":true}')
  const data = []; for await (const event of sse(response)) data.push(event)
  assert.deepEqual(data, [{ event: 'message', data: { value: 'ok' } }, { event: '', data: { last: true } }])
})
test('Anthropic parser normalizes tool input and real cache/input/output usage', async () => {
  const frames = [
    ['message_start', { message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call', name: 'read_file', input: {} } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } }],
    ['content_block_stop', { index: 0 }], ['message_delta', { usage: { output_tokens: 7 } }], ['message_stop', {}],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  const server = await serverFor(frames, 'text/event-stream')
  try { const events = await collect(new AnthropicProvider(config(server.url, 'anthropic'), 'fake').stream(input)); assert.deepEqual(events.find(e => e.type === 'tool_call'), { type: 'tool_call', call: { id: 'call', name: 'read_file', arguments: { path: 'x' } } }); assert.deepEqual(events.at(-1), { type: 'usage', usage: { inputTokens: 33, outputTokens: 7, cachedTokens: 20, cacheWriteTokens: 3 } }) }
  finally { await server.close() }
})
test('Anthropic required output limit follows model capacity and explicit requests', async () => {
  const bodies: any[] = []
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    bodies.push(JSON.parse(raw)); response.setHeader('Content-Type', 'text/event-stream'); response.end('event: message_stop\ndata: {}\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const settings = { ...config(url, 'anthropic'), models: [{ provider: 'anthropic', id: 'test', name: 'test', tools: true, contextWindow: 100000, maxOutputTokens: 50000 }] }
    const provider = new AnthropicProvider(settings, 'fake')
    await collect(provider.stream(input)); await collect(provider.stream({ ...input, maxOutputTokens: 1234 }))
    assert.equal(bodies[0].max_tokens, 50000); assert.equal(bodies[1].max_tokens, 1234)
    settings.models[0]!.maxOutputTokens = 100000
    await collect(provider.stream(input))
    assert.ok(bodies[2].max_tokens > 50000 && bodies[2].max_tokens < 90000)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
test('Ollama NDJSON reports actual token counts and function arguments', async () => {
  const server = await serverFor([JSON.stringify({ message: { content: 'hello', tool_calls: [{ function: { name: 'list_directory', arguments: { path: '.' } } }] } }), JSON.stringify({ done: true, prompt_eval_count: 20, eval_count: 4 })].join('\n'), 'application/x-ndjson')
  try { const events = await collect(new OllamaProvider(config(server.url, 'ollama'), '').stream(input)); assert.ok(events.some(e => e.type === 'tool_call' && e.call.arguments.path === '.')); assert.deepEqual(events.at(-1), { type: 'usage', usage: { inputTokens: 20, outputTokens: 4 } }) }
  finally { await server.close() }
})
test('Gemini preserves thought signature on tool calls and uses API usage', async () => {
  const server = await serverFor(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'x' } }, thoughtSignature: 'signature' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 2 } })}\n\n`, 'text/event-stream')
  try { const events = await collect(new GeminiProvider(config(server.url, 'gemini'), 'fake').stream(input)); assert.ok(events.some(e => e.type === 'tool_call' && e.call.signature === 'signature')); assert.deepEqual(events.at(-1), { type: 'usage', usage: { inputTokens: 9, outputTokens: 5, cachedTokens: undefined, reasoningTokens: 2 } }) }
  finally { await server.close() }
})
