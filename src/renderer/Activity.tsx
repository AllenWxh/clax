import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import type { ActivityReport, AppSettings, AppSnapshot } from '../shared/types'

const api = window.clax
const dateToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const duration = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60000)} 分钟`
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const states = { off: '已暂停', starting: '正在启动', recording: '记录中', idle: '闲置，暂停计时', excluded: '当前应用已跳过', locked: '锁屏或休眠，已暂停', error: '记录器异常' }

export function ActivityPanel({ snapshot, onRefresh }: { snapshot: AppSnapshot; onRefresh: () => Promise<void> }) {
  const [date, setDate] = useState(dateToday), [query, setQuery] = useState('')
  const [report, setReport] = useState<ActivityReport | null>(null)
  const [exclusions, setExclusions] = useState(snapshot.settings.activity.excludedApps.join('\n'))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(''), [confirmDelete, setConfirmDelete] = useState(false)
  const request = useRef(0)
  const config = snapshot.settings.activity, status = snapshot.activityStatus
  useEffect(() => { setExclusions(config.excludedApps.join('\n')) }, [config.excludedApps.join('\n')])
  async function load() {
    const id = ++request.current
    const result = await api.activityReport(date, query)
    if (id === request.current) setReport(result)
  }
  useEffect(() => {
    void load().catch(e => setError(String(e)))
    const timer = setInterval(() => { void load().catch(() => {}) }, 10000)
    return () => { clearInterval(timer); request.current++ }
  }, [date, query])
  async function operation(fn: () => Promise<unknown>, message = '', reload = true) {
    setBusy(true); setError(''); setSaved('')
    try { await fn(); await onRefresh(); if (reload) await load(); setSaved(message) }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)) }
    finally { setBusy(false) }
  }
  function settings(patch: Partial<AppSettings['activity']>) { return operation(() => api.saveSettings({ ...snapshot.settings, activity: { ...config, ...patch } })) }
  return <><h2>记下今天的电脑活动。</h2><p className="settings-intro">开启后记录前台应用、窗口标题和活跃时段。文字只在你点击“记录选中文字”时保存。记录先保存在本机；提问时可把相关记录交给当前模型。</p>
    <div className="activity-status" role="status"><span className={`activity-dot ${config.enabled ? 'on' : ''}`} />{states[status.state]}{status.currentApp ? ` · ${status.currentApp}` : ''}</div>
    <div className="setting-row"><div><strong>活动记录</strong><small>窗口隐藏后继续记录；闲置超过 60 秒、锁屏或休眠时暂停。约每 3 秒采样，时长为估算。</small></div><button className={`switch ${config.enabled ? 'on' : ''}`} role="switch" aria-label="活动记录" aria-checked={config.enabled} disabled={busy || !status.supported} onClick={() => { void settings({ enabled: !config.enabled }) }}><span /></button></div>
    {!status.supported && <p className="settings-error">目前仅支持 macOS。</p>}
    {status.error && <p className="settings-error">{status.error}</p>}
    <div className="setting-row"><div><strong>辅助功能权限</strong><small>{status.accessibility === 'granted' ? '已授权；窗口标题和选中文字仍取决于应用是否支持。' : '未授权时可记录应用和时间；读取窗口标题、选中文字需要辅助功能权限。'}</small></div><button className="secondary-button" disabled={busy || !status.supported} onClick={() => { void operation(() => api.requestActivityPermission()) }}>打开权限设置</button></div>
    <button className="secondary-button" disabled={busy || !config.enabled} onClick={() => { void operation(() => api.captureSelection(), '选中文字已保存。') }}>记录选中文字</button>
    <p className="muted">先在其他应用中选中文字，再右键菜单栏的 C → 记录选中文字。也可以唤出 Clax 后点击此按钮；仅尝试读取最近的应用，不读取剪贴板或未选正文。</p>
    <div className="setting-row"><div><strong>记忆检索使用活动</strong><small>开启后，询问当天活动时把相关应用、窗口和已保存选文送给当前模型。关闭可继续本机记录与查看。</small></div><button className={`switch ${config.useInMemory ? 'on' : ''}`} role="switch" aria-label="记忆检索使用活动" aria-checked={config.useInMemory} disabled={busy} onClick={() => { void settings({ useInMemory: !config.useInMemory }) }}><span /></button></div>
    <div className="setting-row"><div><strong>保留时间</strong><small>超过保留时间的本机活动记录自动删除。</small></div><select aria-label="活动保留时间" value={config.retentionDays} disabled={busy} onChange={e => { void settings({ retentionDays: Number(e.target.value) }) }}>{[7, 30, 90, 365].map(days => <option key={days} value={days}>{days} 天</option>)}</select></div>
    <details className="activity-exclusions"><summary>排除应用</summary><p className="muted">每行一个应用名或 bundle ID，精确匹配，从现在起跳过。默认跳过密码管理器和系统设置；识别到密码框或隐私窗口时也跳过。</p><textarea aria-label="排除应用" rows={5} value={exclusions} onChange={e => setExclusions(e.target.value)} spellCheck={false} /><button className="secondary-button" disabled={busy} onClick={() => { void settings({ excludedApps: [...new Set(exclusions.split('\n').map(v => v.trim()).filter(Boolean))] }) }}>保存排除列表</button></details>
    <div className="activity-filter"><input type="date" aria-label="活动日期" value={date} onChange={e => { setDate(e.target.value); setConfirmDelete(false) }} /><input aria-label="搜索活动" value={query} onChange={e => setQuery(e.target.value)} placeholder="应用、窗口、选中文字…" /><button className="icon-button" aria-label="刷新活动" onClick={() => { void operation(load) }}><RefreshCw size={14} /></button></div>
    {report && <><p className="muted">{report.date} · 估算活跃 {duration(report.totalActiveMs)} · 保存选文 {report.selections} 条</p><div className="activity-apps">{report.apps.map(app => <span key={app.app}>{app.app} · {duration(app.activeMs)}</span>)}</div>
      <div className="activity-timeline">{report.items.map(item => <article key={item.id} className="activity-entry"><small>{time(item.startedAt)}{item.kind === 'focus' ? ` – ${time(item.endedAt)} · ${duration(item.activeMs)}` : ' · 主动保存选文'}</small><strong>{item.app}</strong><span>{item.window || '窗口标题不可用'}</span>{item.text && <p>{item.text}</p>}</article>)}{!report.items.length && <p className="empty-settings">这一天还没有符合条件的记录。</p>}</div>
      {report.nextBefore && <button className="secondary-button" onClick={() => { void operation(async () => { const next = await api.activityReport(date, query, report.nextBefore); setReport({ ...next, items: [...report.items, ...next.items] }) }, '', false) }}>更多记录</button>}
      <div className="form-actions"><span className="muted">删除本机活动；已发送到聊天的内容单独保留。</span><button className="danger-button" disabled={busy} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return }; void operation(() => api.deleteActivity(date), '这一天的活动记录已删除。'); setConfirmDelete(false) }}>{confirmDelete ? '确认删除这一天' : '删除这一天'}</button></div></>}
    {error && <div className="settings-error" role="alert">{error}</div>}{saved && <div className="success-line"><Check size={14} />{saved}</div>}
  </>
}
