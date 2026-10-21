import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, Clock3, Folder, Plus, Settings2, X, Square, Pause, Play, Check, LoaderCircle, Terminal, FileText, Pencil, Globe, Search, CircleAlert, RotateCcw, Sparkles, ShieldCheck } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AppSnapshot, Message, ToolActivity } from '../shared/types'
import { SettingsPanel, type SettingsTab } from './Settings'
import { shortcutLabel } from '../shared/shortcuts'
import { commonModels, reasoningLabels } from '../shared/models'
import { UsagePanel } from './Usage'
import { citationMarkdown } from '../shared/citations'

const api = window.clax
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

function IconButton({ title, children, onClick, disabled = false }: { title: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button className="icon-button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>
}
function ToolRow({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false)
  const icons: Record<string, ReactNode> = { shell: <Terminal size={15} />, read_file: <FileText size={15} />, write_file: <Pencil size={15} />, edit_file: <Pencil size={15} />, web_fetch: <Globe size={15} />, web_search: <Search size={15} /> }
  const labels: Record<string, string> = { shell: 'Ran command', read_file: 'Read', write_file: 'Created', edit_file: 'Edited', list_directory: 'Listed', search_files: 'Searched', process: 'Process', web_fetch: 'Fetched', web_search: 'Web search', remember: 'Memory' }
  const description = activity.arguments.command ?? activity.arguments.path ?? activity.arguments.query ?? activity.arguments.url ?? activity.arguments.action ?? 'Local memory'
  const running = ['running', 'awaiting'].includes(activity.status)
  return <div className={`tool-activity ${activity.status}`} data-testid="tool-activity">
    <button className="tool-row" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
      <span className="tool-state">{running ? <LoaderCircle size={13} className="spin" /> : activity.status === 'done' ? <Check size={13} /> : <CircleAlert size={13} />}</span>
      <span className="tool-kind">{icons[activity.name] ?? <Folder size={15} />}{labels[activity.name] ?? activity.name}</span>
      <span className="tool-description">{String(description)}</span>
      {activity.status === 'awaiting' && <span className="tiny-tag">Approval</span>}
      <ChevronDown size={13} className={expanded ? 'rotate' : ''} />
    </button>
    {expanded && <div className="tool-detail"><div className="detail-label">Parameters</div><pre>{JSON.stringify(activity.arguments, null, 2)}</pre>
      <div className="detail-label">{running ? 'Live output' : `Result · ${activity.status}`}</div><pre>{activity.output || (activity.status === 'awaiting' ? 'Waiting for your approval…' : 'Running…')}</pre></div>}
  </div>
}
function Reply({ message, running, onRetry }: { message: Message; running: boolean; onRetry: () => void }) {
  if (message.role === 'user') return <div className="user-message"><div>{message.content}</div></div>
  if (message.role === 'tool') return null
  return <article className="assistant-message" data-testid="assistant-message">
    <div className="reply-heading"><span className="small-mark">C</span><span>Clax</span><span className="reply-model">{message.model?.model}</span></div>
    {message.content && <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href) void api.openExternal(href) }}>{children}</a>,
      img: ({ alt, src }) => <span className="muted">[Image: {alt ?? src}]</span>,
    }}>{citationMarkdown(message.content, message.citations ?? [])}</Markdown></div>}
    {!!message.webSearchRequests && <div className="search-note" data-testid="web-search-count"><Globe size={12} />联网搜索 · {message.webSearchRequests} 次</div>}
    {!!message.citations?.length && <div className="message-sources" data-testid="web-sources"><small>参考来源</small>{[...new Map(message.citations.map(c => [c.url, c])).values()].map(citation => <a key={citation.url} href={citation.url} title={citation.url} onClick={event => { event.preventDefault(); void api.openExternal(citation.url) }}>{citation.title || new URL(citation.url).hostname}</a>)}</div>}
    {!!message.activities?.length && <div className="tool-list">{message.activities.map(a => <ToolRow key={a.id} activity={a} />)}</div>}
    {!message.content && !message.activities?.length && message.status === 'streaming' && <div className="thinking"><span /><span /><span /></div>}
    {message.status === 'stopped' && <div className="reply-note">Stopped · 已保留当前进度</div>}
    {message.status === 'paused' && <div className="reply-note">已暂停 · 点击继续接着处理</div>}
    {message.status === 'interrupted' && <div className="reply-note">已按你的补充指令调整方向</div>}
    {message.status === 'error' && <div className="reply-note error-text">请求失败，可重试或切换模型。</div>}
    {!running && message.status !== 'streaming' && <button className="retry-button" onClick={onRetry}><RotateCcw size={12} /> Retry</button>}
  </article>
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const snapshotRef = useRef<AppSnapshot | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [popover, setPopover] = useState<'models' | 'history' | 'usage' | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [showAllModels, setShowAllModels] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [addProvider, setAddProvider] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  snapshotRef.current = snapshot
  async function refresh() { const result = await api.bootstrap(); setSnapshot(result); snapshotRef.current = result }
  async function action(fn: () => Promise<unknown>) {
    try { setError(''); return await fn() } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)) }
  }
  useEffect(() => {
    void action(refresh)
    return api.onEvent(event => {
      if (event.type === 'refresh') void action(refresh)
      else if (event.type === 'settings') setSettingsTab(event.tab ?? 'General')
      else if (event.type === 'activity') setSnapshot(old => old ? { ...old, activityStatus: event.status } : old)
      else if (event.type === 'focus') requestAnimationFrame(() => { if (!document.querySelector('.settings-panel')) input.current?.focus() })
      else if (event.type === 'window_state') setSnapshot(old => old ? { ...old, windowMode: event.mode } : old)
      else if (event.type === 'session') {
        setSnapshot(old => {
          if (!old) return old
          return { ...old, session: old.session.id === event.session.id ? event.session : old.session,
            runningSessions: [...old.runningSessions.filter(id => id !== event.session.id), ...(event.running ? [event.session.id] : [])], approvals: event.approvals,
            sessions: [event.session, ...old.sessions.filter(s => s.id !== event.session.id)].map(s => ({ id: s.id, title: s.title, workspace: s.workspace, createdAt: s.createdAt, updatedAt: s.updatedAt })) }
        })
        if (event.session.id === snapshotRef.current?.session.id) {
          if (event.event?.type === 'error') setError(event.event.error)
          if (event.event?.type === 'notice') setNotice(event.event.text)
          if (event.event?.type === 'turn_finished') setNotice('')
        }
      }
    })
  }, [])
  useEffect(() => { if (snapshot?.windowMode === 'expanded' && follow.current) bottom.current?.scrollIntoView({ behavior: 'instant' }) }, [snapshot?.windowMode, snapshot?.session.messages, snapshot?.session.pendingInstructions, snapshot?.approvals])
  useEffect(() => {
    if (!popover) return
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.popover, .popover-trigger')) setPopover(null) }
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close)
  }, [popover])
  if (!snapshot) return <div className="window loading"><span className="brand-mark">C</span><span>Starting Clax…</span><span className="error-text">{error}</span></div>
  const session = snapshot.session
  const running = snapshot.runningSessions.includes(session.id)
  const paused = Boolean(session.paused) && !running
  const pausing = Boolean(session.paused) && running
  const selected = snapshot.providers.flatMap(p => p.models).find(m => m.provider === session.currentModel?.provider && m.id === session.currentModel.model)
  const configured = Boolean(selected)
  const approvals = snapshot.approvals.filter(a => a.sessionId === session.id)
  const collapsed = snapshot.windowMode === 'collapsed'
  function openProviders() { setPopover(null); setAddProvider(true); setSettingsTab('Providers') }
  async function submit(text = draft) {
    if (!text.trim() || pausing) return
    follow.current = true; setNotice(''); setDraft('')
    await action(() => api.send(session.id, text))
    input.current?.focus()
  }
  const grouping = (time: number) => {
    const date = new Date(time), today = new Date(); today.setHours(0, 0, 0, 0)
    return date >= today ? 'Today' : date.getTime() >= today.getTime() - 86400000 ? 'Yesterday' : 'Earlier'
  }
  return <div className={`window ${collapsed ? 'compact-window' : ''}`}>
    {collapsed && <button className="compact-content" aria-label="Expand Clax" onClick={() => { void api.expand() }}><span className="brand-mark small">C</span><strong>Clax</strong><span className="compact-status">{snapshot.runningSessions.length ? <><LoaderCircle size={11} className="spin" /> Working</> : paused ? 'Paused' : 'Ready'}</span><ChevronDown size={14} /></button>}
    {/* Keep forms and tool details mounted while collapsed, preserving unsaved input. */}
    <div className="expanded-content" hidden={collapsed}>
    <header className="titlebar">
      <div className="brand"><span className="brand-mark">C</span><span className="brand-name">Clax</span></div>
      <div className="model-area">
        <button className="model-button popover-trigger" data-testid="model-picker" onClick={() => setPopover(popover === 'models' ? null : 'models')}><span className={`connection-dot ${configured ? 'connected' : ''}`} /><span className="model-name">{selected?.name.replace(/^[^:]+:\s*/, '') ?? 'Select a model'}</span><ChevronDown size={13} /></button>
        {popover === 'models' && <div className="popover model-popover"><div className="popover-heading">Switch model <span>Same conversation</span></div>
          <input className="model-search" placeholder="Search models…" value={modelQuery} onChange={e => setModelQuery(e.target.value)} autoFocus />
          {selected?.reasoningEfforts?.length ? <label className="reasoning-select">推理强度<select aria-label="Reasoning effort" value={session.currentModel?.reasoningEffort ?? 'auto'} onChange={e => { void action(() => api.setModel(session.id, { ...session.currentModel!, reasoningEffort: e.target.value === 'auto' ? undefined : e.target.value as NonNullable<typeof session.currentModel>['reasoningEffort'] })) }}><option value="auto">模型默认</option>{selected.reasoningEfforts.map(effort => <option key={effort} value={effort}>{reasoningLabels[effort]}</option>)}</select></label> : null}
          {snapshot.providers.some(p => p.kind === 'openrouter') && <div className="model-catalog-controls"><button className="text-button" onClick={() => setShowAllModels(!showAllModels)}>{showAllModels ? '只看常用模型' : '全部模型'}</button><button className="text-button" onClick={() => { void action(async () => { const p = snapshot.providers.find(p => p.kind === 'openrouter')!; await api.refreshProvider(p.id); await refresh() }) }}>刷新目录</button></div>}
          <div className="model-options">{snapshot.providers.map(provider => <div key={provider.id}><div className="provider-heading">{provider.name}</div>
            {(provider.kind === 'openrouter' && !showAllModels && !modelQuery ? [...new Map([...(selected?.provider === provider.id ? [selected] : []), ...commonModels(provider.models)].map(m => [m.id, m])).values()] : provider.models).filter(m => `${m.name} ${m.id}`.toLowerCase().includes(modelQuery.toLowerCase())).map(model => <button className={`model-option ${selected?.provider === model.provider && selected.id === model.id ? 'selected' : ''}`} key={model.id}
              onClick={() => { void action(() => api.setModel(session.id, { provider: provider.id, model: model.id })); setPopover(null) }}>
              <span><b>{model.name}</b><small>{model.tools ? 'Tools' : 'Chat'}{model.contextWindow ? ` · ${(model.contextWindow / 1000).toFixed(0)}k context` : ''}</small></span>
              {selected?.provider === model.provider && selected.id === model.id && <Check size={15} />}</button>)}
            {!provider.models.length && <p className="muted model-empty">Manage provider to load or enter model IDs.</p>}</div>)}
            {!snapshot.providers.length && <p className="model-empty muted">No provider configured.</p>}</div>
          <button className="add-provider-button" onClick={openProviders}><Plus size={15} /> Add Provider</button></div>}
      </div>
      <div className="titlebar-spacer" />
      <UsagePanel snapshot={snapshot} open={popover === 'usage'} toggle={() => setPopover(popover === 'usage' ? null : 'usage')} />
      <div className="history-area"><IconButton title="History" onClick={() => { setPopover(popover === 'history' ? null : 'history') }}><Clock3 size={17} /></IconButton>
        {popover === 'history' && <div className="popover history-popover"><div className="popover-heading">Recent sessions<button className="text-button" onClick={() => { void action(async () => { setSnapshot(await api.newSession()) }); setPopover(null) }}>+ New</button></div>
          {(['Today', 'Yesterday', 'Earlier'] as const).map(group => { const rows = snapshot.sessions.filter(s => grouping(s.updatedAt) === group); return rows.length ? <div key={group}><div className="provider-heading">{group}</div>{rows.map(s => <button className={`history-option ${s.id === session.id ? 'selected' : ''}`} key={s.id} onClick={() => {
            void action(async () => { setSnapshot(await api.openSession(s.id)); setError(''); follow.current = true }); setPopover(null)
          }}><b>{s.title}</b><small>{folderName(s.workspace)}{snapshot.runningSessions.includes(s.id) ? ' · Running' : ''}</small></button>)}</div> : null })}</div>}
      </div>
      <IconButton title="New session" onClick={() => { void action(async () => { setSnapshot(await api.newSession()); follow.current = true }) }}><Plus size={18} /></IconButton>
      <IconButton title="Settings" onClick={() => { setAddProvider(false); setSettingsTab('General') }}><Settings2 size={17} /></IconButton>
      <IconButton title="Hide · Esc" onClick={() => { void api.hide() }}><X size={17} /></IconButton>
    </header>
    <div className="workspace-bar"><button className="workspace-button" title={session.workspace} disabled={running} onClick={() => { void action(() => api.chooseWorkspace(session.id)) }}><Folder size={13} /><span>{folderName(session.workspace)}</span><ChevronDown size={11} /></button>
      <span className="local-label"><span /> Local runtime</span>
      <button className="activity-indicator" aria-label="Web search settings" title="查看和配置联网搜索" onClick={() => { setAddProvider(false); setSettingsTab('Tools') }}><Globe size={12} />{snapshot.tools.some(t => t.name === 'web_search' && t.available) ? '联网搜索已启用' : '联网搜索关闭'}</button>
      <button className="activity-indicator" onClick={() => { setAddProvider(false); setSettingsTab('Activity') }} title="查看和控制电脑活动记录"><span className={`activity-dot ${snapshot.activityStatus.enabled ? 'on' : ''}`} />{snapshot.activityStatus.enabled ? '活动记录开启' : '活动记录暂停'}</button>
      <div className="permission-control" title="权限设置会跨会话和重启保留；全权授权下可用工具直接执行。"><ShieldCheck size={12} /><select aria-label="Agent permissions" value={snapshot.settings.permissionMode} onChange={e => { void action(() => api.saveSettings({ ...snapshot.settings, permissionMode: e.target.value as 'ask' | 'auto' | 'full' })) }}><option value="full">全权授权</option><option value="auto">自动判断</option><option value="ask">操作前确认</option></select></div>
    </div>
    <main className="conversation" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }}>
      {!session.messages.length && <div className="welcome"><div className="welcome-glyph"><Sparkles size={29} strokeWidth={1.4} /></div><div className="eyebrow">YOUR DESKTOP, WITH AN AGENT</div><h1>让想法，开始行动。</h1><p>读文件、跑命令、接着聊。<br />一个住在你电脑里的个人 Agent。</p>
        {configured ? <div className="suggestions">{['列出当前项目有哪些文件', '读取 package.json', '运行 node --version'].map(text => <button key={text} onClick={() => { void submit(text) }}><span>{text}</span><ArrowUp size={14} /></button>)}</div>
          : <div className="connect-card"><span>No provider configured.</span><button className="primary-button" onClick={openProviders}><Plus size={15} /> Add Provider</button><small>可直接引用环境变量里的 API Key。</small></div>}
        <div className="welcome-shortcut"><kbd>{shortcutLabel(snapshot.settings.globalShortcut)}</kbd><span>随时唤起</span></div></div>}
      {session.messages.map(message => <Reply key={message.id} message={message} running={running} onRetry={() => { void action(() => api.retry(session.id, message.id)) }} />)}
      {session.pendingInstructions.map((text, i) => <div className="queued-message" key={`${i}-${text}`}><span>Queued · 下一处安全边界生效</span><p>{text}</p></div>)}
      {!!notice && running && <div className="inline-notice">{notice}</div>}
      {approvals.map(approval => <div className="approval-card" key={approval.id} data-testid="approval"><div><ShieldCheck size={16} /><strong>允许调用 {approval.toolName}？</strong></div><p>{approval.description}</p><pre>{JSON.stringify(approval.arguments, null, 2)}</pre><div className="approval-actions"><button className="secondary-button" onClick={() => { void action(() => api.approve(approval.id, false)) }}>拒绝</button><button className="secondary-button" onClick={() => { void action(() => api.approve(approval.id, true)) }}>仅允许本次</button><button className="primary-button" title="保存全权授权，继续所有等待中的工具；后续调用不再逐次确认。" onClick={() => { void action(() => api.saveSettings({ ...snapshot.settings, permissionMode: 'full' })) }}>全权授权并继续</button></div></div>)}
      <div ref={bottom} />
    </main>
    {error && <div className="error-banner" role="alert"><CircleAlert size={15} /><span>{error}</span><button className="icon-button" title="Dismiss" onClick={() => setError('')}><X size={14} /></button></div>}
    <footer className="composer-area"><div className={`composer ${running ? 'active' : ''}`}>
      <textarea ref={input} data-testid="composer" aria-label="Ask anything" placeholder={running ? '输入补充指令，Enter / Steer 调整方向…' : paused ? '补充指令并继续，或点击继续…' : configured ? 'Ask anything…' : '连接一个 Provider，开始聊天…'} value={draft} rows={2} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }} />
      <div className="composer-bottom"><span className="composer-hint">{pausing ? '正在暂停…' : paused ? '已暂停 · 当前进度已保存' : running ? <><span className="running-dot" /> 运行中 · 可随时 Steer</> : <><span className="ready-dot" /> {configured ? 'Ready when you are' : 'Connect a provider to begin'}</>}</span>
        {running && <button className="stop-button" data-testid="pause" disabled={pausing} title="暂停保留进度；正在运行的命令会停止" onClick={() => { void action(() => api.pause(session.id)) }}><Pause size={12} /> 暂停</button>}
        {paused && <button className="stop-button" data-testid="resume" onClick={() => { void action(() => api.resume(session.id)) }}><Play size={12} /> 继续</button>}
        {(running || paused) && <button className="stop-button" data-testid="stop" disabled={pausing} onClick={() => { void action(() => api.stop(session.id)) }}><Square size={12} fill="currentColor" /> Stop</button>}
        <button className={`send-button ${running || paused ? 'steer-button' : ''}`} aria-label={running ? 'Steer agent' : paused ? 'Send and resume' : 'Send message'} title={running ? 'Steer · 调整当前任务' : 'Send · Enter'} disabled={!draft.trim() || !configured || pausing} onClick={() => { void submit() }}><ArrowUp size={16} />{running ? 'Steer' : paused ? '继续' : null}</button></div>
    </div><div className="footer-note"><span>Enter 发送 <span className="divider">/</span> Shift + Enter 换行</span><span>Esc 隐藏 <span className="divider">·</span> {shortcutLabel(snapshot.settings.globalShortcut)} 唤起</span></div></footer>
    {settingsTab && <SettingsPanel snapshot={snapshot} initialTab={settingsTab} addProvider={addProvider} onClose={() => setSettingsTab(null)} onRefresh={refresh} />}
    </div>
  </div>
}
