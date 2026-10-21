export interface ExtensionManifest {
  id: string
  version: string
  name: string
  description: string
  hosts: string[]
  methods: string[]
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
  auth?: { type: 'google-readonly' } | { type: 'api-key'; header: string; prefix: string }
}
export interface ExtensionResponse { status: number; body: string }
export interface ExtensionRequest { url: string; method?: string; headers?: Record<string, string>; body?: string }
export interface ExtensionTest {
  tool: string; input: Record<string, unknown>; expected: unknown
  responses: { request: ExtensionRequest; response: ExtensionResponse }[]
}
export interface ExtensionPackage { manifest: ExtensionManifest; code: string; tests: ExtensionTest[] }
export interface ExtensionInfo {
  id: string; name: string; description: string; version?: string; revision?: string; previous?: string
  enabled: boolean; hosts: string[]; methods: string[]; tools: string[]; auth?: ExtensionManifest['auth']; connected: boolean
  draft?: { revision: string; version: string; tested: boolean }; error?: string
}
