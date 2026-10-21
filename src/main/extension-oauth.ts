import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly'
export interface GoogleClient { clientId: string; clientSecret?: string }
export interface GoogleTokens { accessToken: string; refreshToken: string; expiresAt: number }
type Exchange = (body: URLSearchParams, signal: AbortSignal) => Promise<Record<string, unknown>>
export const googleExchange: Exchange = async (body, signal) => {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, signal, redirect: 'error' })
  if (!response.ok) throw new Error(`Google 令牌交换失败 (${response.status})，请检查客户端配置或重新授权。`)
  return await response.json() as Record<string, unknown>
}
function tokens(value: Record<string, unknown>, refresh = ''): GoogleTokens {
  if (typeof value.access_token !== 'string' || !value.access_token || typeof value.expires_in !== 'number') throw new Error('Google 未返回有效令牌。')
  if (typeof value.scope === 'string' && !value.scope.split(' ').includes(gmailScope)) throw new Error('Google 未授予 Gmail 只读权限。')
  return { accessToken: value.access_token, refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : refresh,
    expiresAt: Date.now() + Math.max(0, value.expires_in - 60) * 1000 }
}
export async function refreshGoogle(client: GoogleClient, previous: GoogleTokens, signal: AbortSignal, exchange = googleExchange) {
  if (!previous.refreshToken) throw new Error('请在 Extensions 中重新连接 Gmail。')
  const body = new URLSearchParams({ client_id: client.clientId, refresh_token: previous.refreshToken, grant_type: 'refresh_token' })
  if (client.clientSecret) body.set('client_secret', client.clientSecret)
  return tokens(await exchange(body, signal), previous.refreshToken)
}

export async function authorizeGoogle(client: GoogleClient, signal: AbortSignal, open: (url: string) => Promise<unknown>, exchange = googleExchange, timeout = 0): Promise<GoogleTokens> {
  signal.throwIfAborted()
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url')
  let redirect = '', received = false
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  // Attach a rejection handler before opening the browser so cancellation never becomes unhandled.
  void code.catch(() => {})
  const server = createServer((request, response) => {
    let url: URL
    try { url = new URL(request.url ?? '/', redirect || 'http://127.0.0.1') } catch { response.writeHead(400).end(); return }
    if (request.method !== 'GET' || url.pathname !== '/oauth/callback' || request.headers.host !== new URL(redirect).host) { response.writeHead(404).end(); return }
    const supplied = Buffer.from(url.searchParams.get('state') ?? ''), expected = Buffer.from(state)
    if (received || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(400).end('Invalid OAuth state'); return }
    received = true
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('授权结果已交给 Clax，可以关闭此页面。')
    if (url.searchParams.has('error')) rejectCode(new Error('Google 授权被取消或拒绝。'))
    else if (url.searchParams.get('code')) resolveCode(url.searchParams.get('code')!)
    else rejectCode(new Error('Google 没有返回授权码。'))
  })
  const abort = () => rejectCode(new Error('Gmail 授权已取消。'))
  const timer = timeout > 0 ? setTimeout(() => rejectCode(new Error('Gmail 授权超时，请重新连接。')), timeout) : undefined
  signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动本机授权回调。')
    redirect = `http://127.0.0.1:${address.port}/oauth/callback`
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect, response_type: 'code', scope: gmailScope,
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' }).toString()
    signal.throwIfAborted(); await open(url.toString())
    const body = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect, code: await code, code_verifier: verifier, grant_type: 'authorization_code' })
    if (client.clientSecret) body.set('client_secret', client.clientSecret)
    return tokens(await exchange(body, signal))
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); server.close(); server.closeAllConnections() }
}
