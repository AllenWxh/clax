import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Local protocol fixture: exercises the real HTTP adapter, never impersonates a live LLM. */
export async function fixtureServer() {
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'fixture-a', context_window: 16000 }, { id: 'fixture-b' }] })); return
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const frame = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\r\n\r\n`)
    const lastUser = body.messages.findLastIndex((m: any) => m.role === 'user')
    const prompt = body.messages[lastUser]?.content ?? ''
    const hasResults = body.messages.slice(lastUser + 1).some((m: any) => m.role === 'tool')
    if (body.messages[0]?.content?.startsWith('Extract durable user preferences')) {
      if (prompt.includes('slow-memory-fixture')) {
        const timer = setInterval(() => res.write(': waiting\n\n'), 30)
        res.on('close', () => clearInterval(timer)); return
      }
      const input = JSON.parse(prompt), source = input.sources.find((s: any) => /回答.*(?:中文|英文)/.test(s.text))
      const text = prompt.includes('bad-memory-fixture') ? 'not valid JSON' : JSON.stringify({ memories: source ? [{ kind: 'preference', scope: 'global', key: 'communication.language',
        text: source.text.includes('英文') ? '用户希望回答使用英文。' : '用户希望回答使用中文。', evidence: [{ messageId: source.id, quote: source.text }] }] : [] })
      frame({ choices: [{ delta: { content: text } }], usage: { prompt_tokens: 80, completion_tokens: 20 } }); res.end('data: [DONE]\n\n'); return
    }
    if (body.messages[0]?.content?.startsWith('Summarize the supplied transcript')) {
      frame({ choices: [{ delta: { content: '## 目标与约束\n继续用户的当前任务，保留上下文。\n## 决策与关键标识\n这是本地协议测试，没有真实模型结论。\n## 已验证结果\n只根据历史工具结果判断完成情况。\n## 待办与风险\n继续最新消息。' } }], usage: { prompt_tokens: 90, completion_tokens: 30 } }); res.end('data: [DONE]\n\n'); return
    }
    if (prompt.includes('slow-fixture')) {
      const timer = setInterval(() => frame({ choices: [{ delta: { content: '…' } }] }), 40)
      res.on('close', () => clearInterval(timer)); return
    }
    if (body.tools?.length && !hasResults && /files-fixture|shell-fixture|steer-fixture|permissions-fixture/.test(prompt)) {
      const calls = prompt.includes('files-fixture') ? [{ name: 'list_directory', args: { path: '.' } }]
        : prompt.includes('permissions-fixture') ? [{ name: 'shell', args: { command: 'node -e "console.log(42)"', timeout: 5000 } }, { name: 'write_file', args: { path: 'approved.txt', content: 'Full access continued the tool batch.' } }]
        : prompt.includes('steer-fixture') ? [{ name: 'shell', args: { command: 'node -e "setTimeout(()=>console.log(42),800)"', timeout: 5000 } }, { name: 'write_file', args: { path: 'must-not-exist.txt', content: 'unsafe stale plan' } }]
        : [{ name: 'shell', args: { command: 'node --version', timeout: 5000 } }]
      for (const [i, call] of calls.entries()) {
        const json = JSON.stringify(call.args), split = Math.floor(json.length / 2)
        frame({ choices: [{ delta: { tool_calls: [{ index: i, id: `call-${requests.length}-${i}`, function: { name: call.name, arguments: json.slice(0, split) } }] } }] })
        frame({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: json.slice(split) } }] } }] })
      }
    } else {
      const text = `模型 ${body.model} 已完成：${prompt.slice(0, 100)}`
      const bytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`)
      // Split within multi-byte text to exercise streaming UTF-8 decoding.
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7))
    }
    frame({ choices: [{ delta: {}, finish_reason: hasResults ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } })
    res.end('data: [DONE]\r\n\r\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }) }
}
