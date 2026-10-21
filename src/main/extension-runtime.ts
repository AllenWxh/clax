import { Worker } from 'node:worker_threads'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Agent, fetch } from 'undici'
import ipaddr from 'ipaddr.js'
import { z } from 'zod'
import type { ExtensionManifest, ExtensionRequest, ExtensionResponse } from '../shared/extensions'

export const requestSchema = z.object({ url: z.string().max(8192), method: z.string().max(10).optional(),
  headers: z.record(z.string().max(100), z.string().max(8192)).optional(), body: z.string().max(64000).optional() }).strict()
export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast' } catch { return false }
}
export async function networkAddressAllowed(address: string, route = async (ip: string) => (await promisify(execFile)('/sbin/route', ['-n', 'get', ip], { timeout: 1500 })).stdout): Promise<boolean> {
  if (publicAddress(address)) return true
  // macOS TUN proxies use this benchmark block as virtual DNS, routed through utun rather than the LAN.
  if (process.platform !== 'darwin' || !/^198\.(?:18|19)\./.test(address)) return false
  try { return /interface:\s+utun\d+\b/.test(await route(address)) } catch { return false }
}
export function validateRequest(manifest: ExtensionManifest, input: unknown): ExtensionRequest {
  const request = requestSchema.parse(input), url = new URL(request.url), method = (request.method ?? 'GET').toUpperCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(url.hostname)) throw new Error('Plugins may only request public HTTPS domains on port 443')
  if (!manifest.hosts.includes(url.hostname) || !manifest.methods.includes(method)) throw new Error('Request exceeds the plugin host/method permissions')
  if (Object.keys(request.headers ?? {}).some(key => /^(?:authorization|cookie|host|connection|content-length|proxy-|sec-|transfer-encoding)/i.test(key))) throw new Error('Authentication and transport headers are managed by Clax')
  const auth = manifest.auth
  if (auth?.type === 'api-key' && Object.keys(request.headers ?? {}).some(key => key.toLowerCase() === auth.header.toLowerCase())) throw new Error('Plugin credentials are injected by Clax')
  if (Object.entries(request.headers ?? {}).some(([key, value]) => /[\r\n]/.test(key + value))) throw new Error('Plugin HTTP headers cannot contain line breaks')
  if (manifest.auth?.type === 'google-readonly' && (!['gmail.googleapis.com', 'www.googleapis.com'].includes(url.hostname) || !url.pathname.startsWith('/gmail/v1/') || method !== 'GET')) throw new Error('Gmail connection only permits reading the Gmail API')
  if (method === 'GET' && request.body) throw new Error('GET requests cannot carry a body')
  return { ...request, method }
}
export async function publicRequest(request: ExtensionRequest, signal: AbortSignal, authentication: Record<string, string> = {}): Promise<ExtensionResponse> {
  // DNS is checked on the actual socket lookup, including IPv4-mapped IPv6 addresses.
  const agent = new Agent({ connect: { lookup(hostname, options, callback) {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      void Promise.all(addresses.map(value => networkAddressAllowed(value.address))).then(allowed => {
        if (!addresses.length || allowed.some(value => !value)) return callback(new Error('Local/private network addresses are unavailable to plugins'), '', 0)
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0]!.address, addresses[0]!.family)
      }).catch(error => callback(error, '', 0))
    })
  } } })
  try {
    const response = await fetch(request.url, { method: request.method, body: request.body, headers: { 'User-Agent': 'Clax/0.1', ...request.headers, ...authentication },
      redirect: 'manual', signal, dispatcher: agent })
    if (response.status >= 300 && response.status < 400) throw new Error('Plugin redirects are blocked; request the intended allowed URL explicitly')
    let body = '', size = 0
    const decoder = new TextDecoder()
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length
      if (size > 1_000_000) throw new Error('Plugin HTTP response exceeds 1 MB')
      body += decoder.decode(chunk, { stream: true })
    }
    return { status: response.status, body: body + decoder.decode() }
  } finally { await agent.close() }
}

export async function runExtension(code: string, tool: string, input: Record<string, unknown>, signal: AbortSignal,
  request: (value: unknown, signal: AbortSignal) => Promise<ExtensionResponse>, timeout = 20000): Promise<unknown> {
  signal.throwIfAborted()
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './extension-worker.mjs' : './extension-worker.js', import.meta.url), {
    workerData: { code, tool, input, timeout }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
  })
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
  try {
    return await new Promise((resolve, reject) => {
      let calls = 0, settled = false
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return
        settled = true; clearTimeout(timer); combined.removeEventListener('abort', aborted)
        error ? reject(error) : resolve(result)
      }
      const aborted = () => finish(combined.reason instanceof Error ? combined.reason : new Error('Plugin cancelled'))
      const timer = setTimeout(() => controller.abort(new Error('Plugin execution timed out')), timeout)
      combined.addEventListener('abort', aborted, { once: true })
      worker.on('error', error => finish(error))
      worker.on('exit', code => finish(new Error(`Plugin worker exited (${code})`)))
      worker.on('message', async message => {
        if (settled) return
        if (message.type === 'result') {
          if (message.error) return finish(new Error(String(message.error)))
          try {
            if (typeof message.output !== 'string' || message.output.length > 32000) throw new Error('Plugin output exceeds 32,000 characters')
            finish(undefined, JSON.parse(message.output))
          } catch (error) { finish(error as Error) }
        } else if (message.type === 'request') {
          try {
            if (++calls > 20 || typeof message.request !== 'string' || message.request.length > 80000) throw new Error('Plugin HTTP request limit exceeded')
            const value = await request(JSON.parse(message.request), combined)
            if (!settled) worker.postMessage({ id: message.id, result: { value } })
          } catch (error) { if (!settled) worker.postMessage({ id: message.id, result: { error: (error as Error).message } }) }
        }
      })
      if (combined.aborted) aborted()
    })
  } finally { controller.abort(); await worker.terminate() }
}
