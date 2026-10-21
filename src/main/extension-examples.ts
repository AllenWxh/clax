import type { ExtensionPackage } from '../shared/extensions'

export const extensionSDK = `Build a plugin as {manifest,code,tests}. First stage it with extension_manage, run tests, then install. Installed tools appear on the next model step, without restart. To inspect or repair an existing plugin use action=read,id,target=current|draft; this returns source and tests without accessing credentials.
code is plain JavaScript declaring async function run(tool,input,sdk). It runs in QuickJS: no import/require/process/fs/fetch/URL/Buffer. Use standard JSON, encodeURIComponent and sdk.request({url,method?,headers?,body?}). Response: {status,body:string}; parse JSON explicitly. Return JSON-compatible data. Clax imposes no execution deadline, HTTP-call count, output-size or custom memory quota. User cancellation or disabling the plugin terminates its worker.
manifest: {id:lowercase-hyphen-name (max20),version:"1.0.0",name,description,hosts:[exact HTTPS hostnames],methods:["GET"|"POST"...],tools:[{name:identifier(max24),description,inputSchema:JSON-Schema-object}],auth?:{type:"google-readonly"}|{type:"api-key",header:"Authorization",prefix:"Bearer "}}. Schemas have no Clax size/depth quota; no $ref/patternProperties. Use simple anchored character-class patterns when validation requires a pattern. Tool names must remain compatible with model APIs.
Every tool needs at least one test: {tool,input,expected,responses:[{request:{url,method?,headers?,body?},response:{status,body}}]}. Test requests must exactly match fixtures; tests never use the network or real credentials. Failed or missing tests cannot install. Tests written by you are a baseline, not proof of correctness; also verify real behavior and be candid about untested paths.
Only public HTTPS domains on port443; no private/local IPs, redirects, arbitrary ports or undeclared methods/hosts. Host injects secrets after validation; never put credentials in code, arguments or fixtures. Account connections and API keys are configured by the human in Settings → Extensions. Google-readonly supports only Gmail API GET endpoints. Real browser clicks/navigation are outside this HTTP plugin SDK.
Use prefix ext_ID_TOOL to call installed tools (hyphens in ID become underscores). Read existing plugins before updating. Keep working versions: install preserves previous, rollback restores it. Use failure messages to fix a draft and retry. Do not edit Clax source or credentials to bypass this lifecycle.`

export function exampleExtension(kind: string): ExtensionPackage {
  if (kind === 'gmail') return {
    manifest: { id: 'gmail', version: '1.0.0', name: 'Gmail 只读', description: '搜索 Gmail 邮件并读取消息摘要。需要用户 Google OAuth 授权。', hosts: ['gmail.googleapis.com'], methods: ['GET'], auth: { type: 'google-readonly' },
      tools: [{ name: 'search', description: 'Search Gmail by its search syntax; returns message IDs.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 2000 } }, required: ['query'], additionalProperties: false } },
        { name: 'read', description: 'Read a Gmail message by ID.', inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' } }, required: ['id'], additionalProperties: false } }] },
    code: `async function run(tool, input, sdk) {
      const url = tool === 'search' ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=' + encodeURIComponent(input.query) : 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(input.id) + '?format=full';
      const response = await sdk.request({url});
      if (response.status !== 200) throw new Error('Gmail HTTP ' + response.status);
      return JSON.parse(response.body);
    }`,
    tests: [{ tool: 'search', input: { query: 'is:unread' }, expected: { messages: [{ id: 'demo' }] }, responses: [{ request: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is%3Aunread' }, response: { status: 200, body: '{"messages":[{"id":"demo"}]}' } }] },
      { tool: 'read', input: { id: 'demo' }, expected: { id: 'demo', snippet: 'Fixture message' }, responses: [{ request: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/demo?format=full' }, response: { status: 200, body: '{"id":"demo","snippet":"Fixture message"}' } }] }],
  }
  if (kind === 'search') return {
    manifest: { id: 'web-search', version: '1.0.0', name: '联网搜索', description: '通过 Tavily 搜索网页，返回标题、链接和摘要。需要用户自己的 Tavily API Key。', hosts: ['api.tavily.com'], methods: ['POST'], auth: { type: 'api-key', header: 'Authorization', prefix: 'Bearer ' },
      tools: [{ name: 'search', description: 'Search the public web using Tavily.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false } }] },
    code: `async function run(tool, input, sdk) {
      const response = await sdk.request({url:'https://api.tavily.com/search',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:input.query,max_results:5})});
      if (response.status !== 200) throw new Error('Search HTTP ' + response.status);
      return JSON.parse(response.body).results.map(item => ({title:item.title,url:item.url,content:item.content}));
    }`,
    tests: [{ tool: 'search', input: { query: 'Clax' }, expected: [{ title: 'Clax', url: 'https://example.com', content: 'Fixture' }], responses: [{ request: { url: 'https://api.tavily.com/search', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"query":"Clax","max_results":5}' }, response: { status: 200, body: '{"results":[{"title":"Clax","url":"https://example.com","content":"Fixture"}]}' } }] }],
  }
  throw new Error('Examples: search, gmail')
}
