import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

// Local protocol fixture only; never connects to OpenAI or uses real credentials.
export async function openAIFixture() {
  const calls: any[] = [], paths: string[] = []
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? '')
    if (request.url === '/models') { response.end(JSON.stringify({ data: ['gpt-6.1-sol', 'gpt-5.4-mini', 'text-embedding-3-small', 'gpt-4o-audio-preview', 'gpt-image-1'].map(id => ({ id })) })); return }
    if (request.url !== '/responses') { response.writeHead(404).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); calls.push(body)
    const index = calls.length, input = body.input ?? [], last = input.findLastIndex((m: any) => m.role === 'user')
    const prompt = input[last]?.content ?? '', results = input.slice(last + 1).some((m: any) => m.type === 'function_call_output')
    const planned = prompt.includes('tool-fixture') && !results
    response.setHeader('Content-Type', 'text/event-stream')
    const frame = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    const reasoning = { type: 'reasoning', id: `rs_${index}`, summary: [], encrypted_content: `fixture-encrypted-${body.model}-${index}` }
    frame('response.created', { response: { id: `resp_${index}`, status: 'in_progress' } })
    frame('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: reasoning.id } })
    const output: any[] = [reasoning]
    if (planned || prompt.startsWith('failure-')) {
      const tools = planned ? [{ name: 'list_directory', args: { path: '.' } }, { name: 'read_file', args: { path: 'fixture.txt' } }] : [{ name: 'list_directory', args: { path: '.' } }]
      for (const [i, tool] of tools.entries()) {
        const call = { type: 'function_call', id: `fc_${index}_${i}`, call_id: `call_${index}_${i}`, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }
        frame('response.output_item.added', { output_index: i + 1, item: { ...call, arguments: '', status: 'in_progress' } })
        const half = Math.floor(call.arguments.length / 2)
        for (const delta of [call.arguments.slice(0, half), call.arguments.slice(half)]) frame('response.function_call_arguments.delta', { output_index: i + 1, item_id: call.id, delta })
        frame('response.function_call_arguments.done', { output_index: i + 1, item_id: call.id, arguments: call.arguments })
        frame('response.output_item.done', { output_index: i + 1, item: call })
        output.push(call)
      }
    } else {
      const text = prompt === 'slow-fixture' ? 'Streaming fixture text keeps growing.' : 'Responses fixture reply.'
      if (body.tools?.some((t: any) => t.type === 'web_search') && prompt === 'search-fixture') output.push({ type: 'web_search_call', id: `ws_${index}`, status: 'completed', action: { type: 'search', query: 'fixture' } })
      const annotations = prompt === 'search-fixture' ? [{ type: 'url_citation', url: 'https://docs.python.org/3/library/asyncio-task.html', title: 'Fixture source', start_index: 0, end_index: 9 }] : []
      output.push({ type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] })
      for (const delta of [text.slice(0, 9), text.slice(9)]) {
        if (response.destroyed) return
        frame('response.output_text.delta', { output_index: output.length - 1, content_index: 0, delta })
        if (prompt === 'slow-fixture') await delay(900)
      }
    }
    if (response.destroyed) return
    const usage = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 3 } }
    if (prompt === 'failure-truncated') { response.end(); return }
    const type = prompt === 'failure-incomplete' ? 'response.incomplete' : prompt === 'failure-error' ? 'response.failed' : 'response.completed'
    frame(type, { response: { id: `resp_${index}`, status: type.slice(9), output, usage,
      ...(type === 'response.incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(type === 'response.failed' ? { error: { message: 'Fixture provider failure' } } : {}) } })
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, calls, paths, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
