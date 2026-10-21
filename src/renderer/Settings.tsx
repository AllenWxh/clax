import { useEffect, useState } from 'react'
import { X, Plus, Check, LoaderCircle, ChevronLeft, RefreshCw, ExternalLink, KeyRound, SlidersHorizontal } from 'lucide-react'
import type { AppSnapshot, AppSettings, MemoryFile, MemoryHit, ProviderInput, ProviderKind, PublicProvider } from '../shared/types'
import { DEFAULT_SHORTCUT, SHORTCUTS, shortcutLabel } from '../shared/shortcuts'
import { COMPACTION_RATIO, CONTEXT_TOKEN_PRESETS, contextLimits } from '../shared/context'
import { ActivityPanel } from './Activity'
import { ExtensionsPanel } from './Extensions'

const api = window.clax
export type SettingsTab = 'General' | 'Providers' | 'Tools' | 'Memory' | 'Activity' | 'Skills' | 'Extensions' | 'About'
const tabs: SettingsTab[] = ['General', 'Providers', 'Tools', 'Memory', 'Activity', 'Skills', 'Extensions', 'About']
const allTools = ['list_directory', 'read_file', 'write_file', 'edit_file', 'search_files', 'shell', 'process', 'web_fetch', 'web_search', 'remember', 'memory_search', 'memory_get', 'memory_forget', 'session_history', 'activity_search', 'extension_manage', 'skill_manage']
const providerDefaults: Record<Exclude<ProviderKind, 'mock'>, { name: string; url: string }> = {
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  compatible: { name: 'Custom provider', url: '' }, openai: { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1' }, gemini: { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta' },
  ollama: { name: 'Ollama', url: 'http://127.0.0.1:11434' },
}

function ProviderForm({ provider, snapshot, onBack, onDone }: { provider: PublicProvider | null; snapshot: AppSnapshot; onBack: () => void; onDone: () => Promise<void> }) {
  const [kind, setKind] = useState<Exclude<ProviderKind, 'mock'>>(provider?.kind === 'mock' ? 'compatible' : provider?.kind ?? 'openrouter')
  const [name, setName] = useState(provider?.name ?? 'OpenRouter')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? 'https://openrouter.ai/api/v1')
  const [apiKey, setApiKey] = useState('')
  const [source, setSource] = useState(provider?.apiKeyEnv || !provider && snapshot.environmentKeys.includes('OPENROUTER_API_KEY') ? 'environment' : 'input')
  const [envName, setEnvName] = useState(provider?.apiKeyEnv ?? 'OPENROUTER_API_KEY')
  const [models, setModels] = useState(provider?.models.map(m => m.id).join('\n') ?? '')
  const [tools, setTools] = useState(provider?.toolCalling ?? true)
  const [context, setContext] = useState(provider?.contextWindow?.toString() ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [inputRate, setInputRate] = useState(provider?.pricing?.input.toString() ?? '')
  const [outputRate, setOutputRate] = useState(provider?.pricing?.output.toString() ?? '')
  const [cacheRate, setCacheRate] = useState(provider?.pricing?.cache?.toString() ?? '')
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('')
  function value(): ProviderInput {
    const reference = apiKey.match(/^(?:env:|\$\{?)([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1]
    return { id: provider?.id, kind, name: name || providerDefaults[kind].name, baseUrl,
      apiKey: source === 'input' && !reference ? apiKey || undefined : undefined,
      apiKeyEnv: source === 'environment' ? envName.trim() || undefined : reference,
      modelIds: models.split(/[\n,]/).map(id => id.trim()).filter(Boolean), toolCalling: tools,
      contextWindow: context ? Number(context) : undefined,
      pricing: inputRate !== '' && outputRate !== '' ? { input: Number(inputRate), output: Number(outputRate), cache: cacheRate !== '' ? Number(cacheRate) : undefined } : undefined,
    }
  }
  async function operation(fn: () => Promise<void>) { setBusy(true); setError(''); setStatus(''); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  return <div className="provider-form"><button className="back-button" onClick={onBack}><ChevronLeft size={15} /> Providers</button><h2>{provider ? 'Manage provider' : 'Add Provider'}</h2>
    <div className="field"><label htmlFor="provider-kind">Provider type</label><select id="provider-kind" value={kind} onChange={e => { const next = e.target.value as Exclude<ProviderKind, 'mock'>; setKind(next); setName(providerDefaults[next].name); setBaseUrl(providerDefaults[next].url); setModels(''); setStatus('') }}><option value="openrouter">OpenRouter · 统一模型</option><option value="compatible">OpenAI-compatible</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="ollama">Ollama · Local</option></select></div>
    <div className="field"><label htmlFor="provider-name">Name</label><input id="provider-name" value={name} placeholder="OpenRouter / Local…" onChange={e => setName(e.target.value)} /></div>
    <div className="field"><label htmlFor="provider-url">Base URL</label><input id="provider-url" value={baseUrl} placeholder="https://openrouter.ai/api/v1" onChange={e => setBaseUrl(e.target.value)} spellCheck={false} /><small>填写 API 根路径，包含所需的 /v1。Ollama 使用 http://127.0.0.1:11434。</small></div>
    {kind !== 'ollama' && <><div className="key-source"><button className={source === 'input' ? 'selected' : ''} onClick={() => setSource('input')}><KeyRound size={13} /> 输入 API Key</button><button className={source === 'environment' ? 'selected' : ''} onClick={() => setSource('environment')}>本地环境变量</button></div>
      {source === 'input' ? <div className="field"><label htmlFor="provider-key">API Key</label><input id="provider-key" type="password" autoComplete="off" value={apiKey} placeholder={provider?.hasKey ? '留空保留已保存的 Key' : 'API Key 或 env:OPENROUTER_API_KEY'} onChange={e => setApiKey(e.target.value)} /><small>{snapshot.secureStorage ? '通过系统安全存储加密保存。' : '系统加密不可用，输入的 Key 仅在本次运行中保留。'}</small></div>
        : <div className="field"><label htmlFor="provider-env">Environment variable name</label><input id="provider-env" list="environment-keys" value={envName} placeholder="OPENROUTER_API_KEY" onChange={e => setEnvName(e.target.value)} autoComplete="off" /><datalist id="environment-keys">{snapshot.environmentKeys.map(name => <option key={name} value={name} />)}</datalist><small>只保存变量名。启动环境或 workspace 的 .env / .env.local 提供实际 Key。修改进程环境后需要重新启动。</small></div>}</>}
    <button className="secondary-button" disabled={busy || !baseUrl} onClick={() => { void operation(async () => { const result = await api.testProvider(value()); setModels(result.map(m => m.id).join('\n')); setStatus(`Connected · ${result.length} models found`) }) }}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} {kind === 'ollama' ? 'Detect local models' : 'Test Connection'}</button>
    <div className="field model-ids"><label htmlFor="provider-models">Model IDs</label><textarea id="provider-models" value={models} onChange={e => setModels(e.target.value)} rows={3} placeholder="Connect 自动读取，或每行手动填写一个 model ID" spellCheck={false} /></div>
    <label className="checkbox-label"><input type="checkbox" checked={tools} onChange={e => setTools(e.target.checked)} /> Enable tool calling for these models</label>
    <button className="text-button advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}><SlidersHorizontal size={13} /> Context & pricing</button>
    {showAdvanced && <div className="advanced-fields"><div className="field"><label htmlFor="context-window">Context window (optional)</label><input id="context-window" type="number" min="1000" value={context} placeholder="Unknown" onChange={e => setContext(e.target.value)} /></div><p className="muted">价格可留空；费用会显示 Unavailable。填写每百万 token 的 USD 价格。</p><div className="rate-fields">{[['Input', inputRate, setInputRate], ['Output', outputRate, setOutputRate], ['Cache', cacheRate, setCacheRate]].map(([label, rate, setter]) => <div className="field" key={label as string}><label>{label as string}</label><input aria-label={`${label} rate`} type="number" min="0" step="0.01" value={rate as string} placeholder="—" onChange={e => (setter as (value: string) => void)(e.target.value)} /></div>)}</div></div>}
    {status && <div className="success-line"><Check size={14} />{status}</div>}{error && <div className="settings-error" role="alert">{error}</div>}
    <div className="form-actions">{provider && <button className="danger-button" disabled={busy} onClick={() => { void operation(async () => { await api.deleteProvider(provider.id); await onDone() }) }}>Remove provider</button>}<button className="primary-button" disabled={busy || !baseUrl || !models.trim()} onClick={() => { void operation(async () => { const result = await api.saveProvider(value()); setApiKey('');
      if (!snapshot.session.currentModel && result.models[0]) await api.setModel(snapshot.session.id, { provider: result.id, model: result.models[0].id }); await onDone() }) }}>Save</button></div>
  </div>
}

export function SettingsPanel({ snapshot, initialTab, addProvider, onClose, onRefresh }: { snapshot: AppSnapshot; initialTab: SettingsTab; addProvider: boolean; onClose: () => void; onRefresh: () => Promise<void> }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [editing, setEditing] = useState<PublicProvider | null | undefined>(addProvider ? null : undefined)
  const [error, setError] = useState(''), [saved, setSaved] = useState('')
  const [file, setFile] = useState<MemoryFile>('PREFERENCES.md')
  const [memory, setMemory] = useState(snapshot.memory[file])
  const [memoryQuery, setMemoryQuery] = useState(''), [memoryHits, setMemoryHits] = useState<MemoryHit[]>([]), [memorySource, setMemorySource] = useState('')
  const [searchKind, setSearchKind] = useState(snapshot.settings.search.kind)
  const [searchUrl, setSearchUrl] = useState(snapshot.settings.search.baseUrl)
  const [searchKey, setSearchKey] = useState('')
  const provider = snapshot.providers.find(p => p.id === snapshot.session.currentModel?.provider)
  const model = provider?.models.find(m => m.id === snapshot.session.currentModel?.model)
  const limits = contextLimits(snapshot.settings.maxContextChars, model?.contextWindow ?? provider?.contextWindow, model?.maxOutputTokens)
  useEffect(() => { setMemory(snapshot.memory[file]); setSaved('') }, [file])
  useEffect(() => { setTab(initialTab) }, [initialTab])
  async function operation(fn: () => Promise<unknown>, success = '') {
    try { setError(''); setSaved(''); await fn(); await onRefresh(); setSaved(success) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  function settings(patch: Partial<AppSettings>) { return operation(() => api.saveSettings({ ...snapshot.settings, ...patch })) }
  return <div className="settings-backdrop"><section className="settings-panel"><div className="settings-title"><span className="brand-mark small">C</span><h1>Settings</h1><button className="icon-button" aria-label="Close settings" onClick={onClose}><X size={18} /></button></div>
    <nav className="settings-tabs">{tabs.map(name => <button key={name} className={tab === name ? 'selected' : ''} onClick={() => { setTab(name); setError(''); setSaved('') }}>{name}</button>)}</nav>
    <div className="settings-content">
      {tab === 'General' && <><h2>Make yourself at home.</h2><p className="settings-intro">窗口可以藏起来，Agent 会继续工作。退出请使用托盘里的 Quit。</p>
        <div className="setting-row"><div><strong>Global shortcut</strong><small>{snapshot.shortcutStatus}</small><small>默认双键：{shortcutLabel(DEFAULT_SHORTCUT)}。左手拇指按 Option、中指按 C；外接键盘 Alt / Win 对调时用 Win + C。也可选择 D、V。</small></div><select aria-label="Global shortcut" value={snapshot.settings.globalShortcut} onChange={e => { void settings({ globalShortcut: e.target.value }) }}>{SHORTCUTS.map(shortcut => <option key={shortcut} value={shortcut}>{shortcutLabel(shortcut)}</option>)}</select>{!snapshot.shortcutRegistered && <button className="secondary-button" onClick={() => { void operation(() => api.enableShortcut()) }}>Retry</button>}</div>
        <div className="setting-row"><div><strong>工具权限</strong><small>默认全权授权：所有可用工具直接执行，重启后保留。也可选自动判断，或对修改、命令等操作逐次确认。切换为全权授权会继续等待中的工具。</small></div><select aria-label="Default permissions" value={snapshot.settings.permissionMode} onChange={e => { void settings({ permissionMode: e.target.value as AppSettings['permissionMode'] }) }}><option value="full">全权授权</option><option value="auto">自动判断</option><option value="ask">操作前确认</option></select></div>
        <div className="setting-row"><div><strong>Demo provider</strong><small>无需 API Key。演示回复使用脚本，文件和 Shell 工具实际执行。</small></div><button className={`switch ${snapshot.settings.demoEnabled ? 'on' : ''}`} role="switch" aria-checked={snapshot.settings.demoEnabled} aria-label="Demo provider" onClick={() => { void operation(async () => { await api.saveSettings({ ...snapshot.settings, demoEnabled: !snapshot.settings.demoEnabled }); if (!snapshot.settings.demoEnabled && !snapshot.session.currentModel) await api.setModel(snapshot.session.id, { provider: 'demo', model: 'demo-tools' }) }) }}><span /></button></div>
        <div className="setting-row"><div><strong>Local storage</strong><small className="path-text">{snapshot.storagePath}</small></div><button className="secondary-button" onClick={() => { void api.openDataFolder() }}><FolderIcon /> Open</button></div>
        <div className="setting-row"><div><strong>上下文预算</strong><small>默认按模型最大容量分配，Clax 不额外设上限。预留回复空间，约用到 82% 时压缩；完整历史留在本机。任务不限轮数，工具默认不限时长和输出。</small><small data-testid="context-budget-effective">当前模型有效预算 {limits.budget.toLocaleString()} tokens · 约 {Math.floor(limits.budget * COMPACTION_RATIO).toLocaleString()} tokens 时压缩</small></div><select aria-label="Context budget" value={snapshot.settings.maxContextChars} onChange={e => { void settings({ maxContextChars: Number(e.target.value) }) }}><option value={0}>模型最大容量（默认）</option>{snapshot.settings.maxContextChars !== 0 && !CONTEXT_TOKEN_PRESETS.some(tokens => tokens * 3 === snapshot.settings.maxContextChars) && <option value={snapshot.settings.maxContextChars}>{Math.floor(snapshot.settings.maxContextChars / 3).toLocaleString()} tokens（原设置）</option>}{CONTEXT_TOKEN_PRESETS.map(tokens => <option key={tokens} value={tokens * 3}>{tokens / 1000}k tokens</option>)}</select></div></>}
      {tab === 'Providers' && (editing !== undefined ? <ProviderForm key={editing?.id ?? 'new'} provider={editing} snapshot={snapshot} onBack={() => setEditing(undefined)} onDone={async () => { await onRefresh(); setEditing(undefined) }} />
        : <><h2>Your models, one conversation.</h2><p className="settings-intro">从顶部模型菜单直接切换。聊天记录会保留。</p>{snapshot.providers.filter(p => p.kind !== 'mock').map(provider => <div className="provider-card" key={provider.id}><div className="provider-avatar">{provider.name.slice(0, 1).toUpperCase()}</div><div><strong>{provider.name}</strong><small><span className="connection-dot connected" />{provider.apiKeyEnv ? `Environment · ${provider.apiKeyEnv}` : provider.kind === 'ollama' ? 'Local' : provider.hasKey ? 'Key saved' : 'No API Key'} · {provider.models.length} models</small></div><button className="secondary-button" onClick={() => setEditing(provider)}>Manage</button></div>)}
          {!snapshot.providers.filter(p => p.kind !== 'mock').length && <div className="empty-settings">Add an OpenAI-compatible endpoint, a native provider, or local Ollama.</div>}
          <button className="secondary-button add-provider" onClick={() => setEditing(null)}><Plus size={15} /> Add Provider</button>
          {snapshot.environmentKeys.includes('OPENROUTER_API_KEY') && !snapshot.providers.some(p => p.kind === 'openrouter') && <button className="text-button" onClick={() => { void operation(() => api.importOpenRouter(), 'OpenRouter 已接入本地环境变量。') }}>Import local OpenRouter key</button>}</>)}
      {tab === 'Tools' && <><h2>Tools on your computer.</h2><p className="settings-intro">Shell 进程支持输出、超时和 Stop。Process 管理 Clax 自己启动的进程。权限模式是确认策略，实验版没有 OS sandbox。</p><div className="tool-settings-grid">{allTools.map(name => <label className="tool-setting" key={name}><span>{name}{name === 'web_search' && snapshot.settings.search.kind === 'none' && <small>Unavailable</small>}</span><input type="checkbox" checked={!snapshot.settings.disabledTools.includes(name)} onChange={e => { void settings({ disabledTools: e.target.checked ? snapshot.settings.disabledTools.filter(n => n !== name) : [...snapshot.settings.disabledTools, name] }) }} /></label>)}</div>
        <h3>Web search</h3><div className="field"><label>Search provider</label><select aria-label="Search provider" value={searchKind} onChange={e => setSearchKind(e.target.value as AppSettings['search']['kind'])}><option value="none">关闭联网搜索</option><option value="openrouter">OpenRouter · 原生搜索优先</option><option value="tavily">Tavily</option><option value="searxng">SearXNG</option></select></div>
        {searchKind === 'openrouter' && <p className="muted">使用现有 OpenRouter 调用 Key，无需额外配置。支持的 GPT / Claude 模型使用服务商原生搜索，由模型按需调用；不支持时 OpenRouter 可能回退到其他搜索引擎。费用从 OpenRouter 余额扣除，计入对应模型用量。需要选择 OpenRouter 模型，且勾选 web_search。</p>}
        {searchKind === 'tavily' && <div className="field"><label>API Key</label><input type="password" autoComplete="off" value={searchKey} onChange={e => setSearchKey(e.target.value)} placeholder={snapshot.searchHasKey ? 'Saved · leave blank to keep' : 'Tavily API Key'} /></div>}
        {searchKind === 'searxng' && <div className="field"><label>Instance URL</label><input value={searchUrl} onChange={e => setSearchUrl(e.target.value)} placeholder="http://127.0.0.1:8080" /><small>实例需要允许 JSON format。</small></div>}
        <button className="primary-button" onClick={() => { void operation(async () => { if (searchKey) { await api.saveSearchKey(searchKey); setSearchKey('') }; await api.saveSettings({ ...snapshot.settings, search: { kind: searchKind, baseUrl: searchUrl } }) }, 'Search settings saved.') }}>Save search settings</button></>}
      {tab === 'Activity' && <ActivityPanel snapshot={snapshot} onRefresh={onRefresh} />}
      {tab === 'Memory' && <><h2>记住有用的事。</h2><p className="settings-intro">用户背景和通用偏好跨会话使用；项目记忆与每日记录按工作目录隔开。每日对话记录包含 Clax 中的聊天和工具活动；其他应用的活动记录在 Activity 中单独管理。</p>
        <div className="setting-row"><div><strong>Use memory</strong><small>{snapshot.memoryStatus.documents} 个文档 · {snapshot.memoryStatus.learned} 条已学记忆 · {snapshot.memoryStatus.daily} 条每日记录</small></div><button className={`switch ${snapshot.settings.memory.enabled ? 'on' : ''}`} role="switch" aria-label="Use memory" aria-checked={snapshot.settings.memory.enabled} onClick={() => { void settings({ memory: { ...snapshot.settings.memory, enabled: !snapshot.settings.memory.enabled } }) }}><span /></button></div>
        {snapshot.memoryStatus.lastCaptureError && <p className="settings-error">{snapshot.memoryStatus.lastCaptureError}</p>}
        <div className="setting-row"><div><strong>Automatically capture memory</strong><small>对话结束后保存每日记录，提取有用户原话支持的稳定偏好和决定。会额外请求当前模型，费用计入 Usage。</small></div><button className={`switch ${snapshot.settings.memory.autoCapture ? 'on' : ''}`} role="switch" aria-label="Automatically capture memory" aria-checked={snapshot.settings.memory.autoCapture} onClick={() => { void settings({ memory: { ...snapshot.settings.memory, autoCapture: !snapshot.settings.memory.autoCapture } }) }}><span /></button></div>
        <div className="field"><label htmlFor="memory-query">Search memory</label><input id="memory-query" value={memoryQuery} onChange={e => setMemoryQuery(e.target.value)} placeholder="偏好、项目决定、今天做了什么…" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void operation(async () => { setMemoryHits(await api.searchMemory(memoryQuery)); setMemorySource('') }) } }} /></div>
        <button className="secondary-button" onClick={() => { void operation(async () => { setMemoryHits(await api.searchMemory(memoryQuery)); setMemorySource('') }) }}>Search memory</button>
        <div className="memory-results">{memoryHits.map(hit => <div className="memory-result" key={`${hit.path}:${hit.startLine}`}><small>{hit.path}:{hit.startLine} · {hit.kind} · {new Date(hit.updatedAt).toLocaleString()}</small><p>{hit.content}</p><div className="form-actions"><button className="text-button" onClick={() => { void operation(async () => { setMemorySource(await api.readMemory(hit.path, hit.startLine, 100)) }) }}>查看来源</button>{hit.path.startsWith('entries/') && <button className="text-button" onClick={() => { void operation(async () => { await api.forgetMemory(hit.path); setMemoryHits(await api.searchMemory(memoryQuery)); setMemorySource('') }, 'Memory forgotten.') }}>忘记这条</button>}</div></div>)}</div>
        {memorySource && <details className="summary-detail" open><summary>Memory source</summary><pre>{memorySource}</pre></details>}
        <h3>手动维护全局背景与偏好</h3><div className="memory-tabs">{(['USER.md', 'PREFERENCES.md', 'MEMORY.md'] as MemoryFile[]).map(name => <button className={file === name ? 'selected' : ''} key={name} onClick={() => setFile(name)}>{name}</button>)}</div><textarea className="memory-editor" aria-label="Memory editor" value={memory} onChange={e => setMemory(e.target.value)} spellCheck={false} /><div className="form-actions"><span className="muted">Markdown · 保存在本机</span><button className="primary-button" onClick={() => { void operation(() => api.saveMemory(file, memory), 'Memory saved.') }}>Save memory</button></div>
        {snapshot.session.contextState && <p className="muted">上次请求上下文估算 {snapshot.session.contextState.estimatedTokens.toLocaleString()} / {snapshot.session.contextState.budgetTokens.toLocaleString()} tokens · 压缩 {snapshot.session.contextState.compactions} 次{snapshot.session.contextState.method === 'fallback' ? ' · 最近使用原文片段回退' : ''}</p>}
        {snapshot.session.summary && <details className="summary-detail"><summary>Current session summary</summary><pre>{snapshot.session.summary}</pre></details>}</>}
      {tab === 'Skills' && <><h2>Small instructions, useful habits.</h2><p className="settings-intro">在本地 skills/ 下，每个目录放置一个 SKILL.md。启用的内容会加入 Agent context。</p>{snapshot.skills.map(skill => <div className="setting-row" key={skill.id}><div><strong>{skill.name}</strong><small>{skill.description}</small></div><button className={`switch ${skill.enabled ? 'on' : ''}`} role="switch" aria-label={skill.name} aria-checked={skill.enabled} onClick={() => { void settings({ enabledSkills: { ...snapshot.settings.enabledSkills, [skill.id]: !skill.enabled } }) }}><span /></button></div>)}<div className="form-actions"><button className="secondary-button" onClick={() => { void api.openDataFolder() }}>Open skills folder</button><button className="secondary-button" onClick={() => { void operation(onRefresh) }}><RefreshCw size={14} /> Rescan</button></div></>}
      {tab === 'Extensions' && <ExtensionsPanel items={snapshot.extensions} refresh={onRefresh} />}
      {tab === 'About' && <><div className="about-brand"><span className="brand-mark">C</span><h2>Clax <small>{snapshot.version}</small></h2></div><p className="settings-intro">An experimental personal agent. Local first.<br />Electron · React · TypeScript · SQLite</p><div className="about-note">本版本使用独立的薄 Agent Runtime，参考 Codex 的工具事件/审批交互和 OpenClaw 的 Provider、Memory、Skills 分层。没有复制第三方源码，也没有运行 Gateway。Codex app-server Adapter 与更深的 OpenClaw 集成留待后续。</div>
        {[['Codex', 'https://github.com/openai/codex'], ['OpenClaw', 'https://github.com/openclaw/openclaw']].map(([name, url]) => <button className="text-button source-link" key={name} onClick={() => { void api.openExternal(url!) }}>{name}<ExternalLink size={13} /></button>)}<p className="muted">API Key 的环境变量引用只保存变量名；手动 Key 使用系统 safeStorage。Usage 只展示 Provider 实际返回的数字，余额和订阅配额未知时显示 Unavailable。</p></>}
      {error && <div className="settings-error" role="alert">{error}</div>}{saved && <div className="success-line"><Check size={14} />{saved}</div>}
    </div></section></div>
}
function FolderIcon() { return <ExternalLink size={13} /> }
