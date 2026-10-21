import { createServer } from 'node:http'

// Scripted HTTP responses are isolated from live OpenRouter account/model checks.
export const catalogue = [
  { id: 'anthropic/claude-sonnet-test', name: 'Claude fixture', context_length: 100000, supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['high', 'low', 'none'], mandatory: true } },
  { id: 'openai/gpt-6-sol', name: 'GPT fixture', context_length: 200000, supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['high', 'medium', 'low', 'none'] } },
  { id: 'deepseek/deepseek-test-flash', name: 'DeepSeek fixture', supported_parameters: ['tools', 'reasoning'], reasoning: { supported_efforts: ['high', 'low', 'none'] } },
  { id: 'text-chat', supported_parameters: [] }, { id: 'bad:batch', supported_parameters: ['tools'] },
  { id: 'image-only', architecture: { output_modalities: ['image'] } },
]
export async function openRouterFixture() {
  const calls: any[] = [], auth: string[] = []
  let creditsForbidden = false
  const server = createServer(async (request, response) => {
    auth.push(request.headers.authorization ?? '')
    if (request.url === '/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: catalogue })); return }
    if (request.url === '/key') { response.end(JSON.stringify({ data: { limit: null, limit_remaining: null, usage: 2 } })); return }
    if (request.url === '/credits') { if (creditsForbidden) response.writeHead(403); response.end(JSON.stringify(creditsForbidden ? { error: { message: 'management key required' } } : { data: { total_credits: 15, total_usage: 2 } })); return }
    if (request.url !== '/chat/completions') { response.writeHead(404).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls.push(body)
    const nativeSearch = body.tools?.some((t: any) => t.type === 'openrouter:web_search')
    const last = body.messages.findLastIndex((m: any) => m.role === 'user')
    const tool = body.tools?.some((t: any) => t.type === 'function') && !body.messages.slice(last + 1).some((m: any) => m.role === 'tool')
    response.setHeader('Content-Type', 'text/event-stream')
    const frame = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`)
    if (nativeSearch && body.messages[last]?.content === 'search-error-fixture') {
      frame({ error: { message: 'Fixture native search is unavailable' } }); response.end('data: [DONE]\n\n'); return
    }
    if (tool) {
      frame({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'opaque-', format: 'anthropic-claude-v1' }] } }] })
      frame({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'block' }], tool_calls: [{ index: 0, id: `call-${calls.length}`, function: { name: 'list_directory', arguments: '{"path":"."}' } }] } }] })
    } else if (body.messages[0]?.content?.startsWith('Extract durable user preferences')) frame({ choices: [{ delta: { content: '{"memories":[]}' } }] })
    else if (nativeSearch) {
      const text = 'TaskGroup was added in Python 3.11. ', marker = 'citefixture-source'
      const annotations = [{ type: 'url_citation', url_citation: { url: 'https://docs.python.org/3/library/asyncio-task.html', title: 'Python TaskGroup fixture source', start_index: text.length, end_index: text.length + marker.length } }]
      frame({ choices: [{ delta: { content: text + marker } }] })
      frame({ choices: [{ delta: { annotations } }] }); frame({ choices: [{ delta: { annotations } }] })
    } else frame({ choices: [{ delta: { content: 'fixture reply' } }] })
    frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 }, cost: 0.001,
      ...(nativeSearch ? { server_tool_use: { web_search_requests: tool ? 0 : 1 } } : {}) } })
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, calls, auth, forbidCredits: () => { creditsForbidden = true }, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
