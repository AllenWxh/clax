import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw } from 'lucide-react'
import type { AppSnapshot, ProviderCredits, UsageSummary } from '../shared/types'

const api = window.clax
const dollars = (value: number | null | undefined) => value == null ? '—' : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}`
export function UsagePanel({ snapshot, open, toggle }: { snapshot: AppSnapshot; open: boolean; toggle: () => void }) {
  const provider = snapshot.providers.find(p => p.id === snapshot.session.currentModel?.provider && p.kind === 'openrouter') ?? snapshot.providers.find(p => p.kind === 'openrouter')
  const [credits, setCredits] = useState<ProviderCredits | null>(null), [summary, setSummary] = useState<UsageSummary | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [hovered, setHovered] = useState<{ id: string; left: number; top: number } | null>(null)
  function hover(id: string, element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    setHovered({ id, left: Math.max(8, Math.min(rect.left, window.innerWidth - 310)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 220)) })
  }
  const generation = useRef(0)
  async function refresh() {
    const current = ++generation.current
    setBusy(true)
    try {
      const [balance, usage] = await Promise.allSettled([provider ? api.providerCredits(provider.id) : Promise.resolve(null), api.usageSummary()])
      if (current !== generation.current) return
      setError(balance.status === 'rejected' ? '余额查询失败，可点击刷新。' : '')
      if (balance.status === 'fulfilled') setCredits(balance.value)
      if (usage.status === 'fulfilled') setSummary(usage.value)
      else setError('本机用量读取失败。')
    } finally { if (current === generation.current) setBusy(false) }
  }
  useEffect(() => { setCredits(null); void refresh(); return () => { generation.current++ } }, [provider?.id])
  const requests = snapshot.session.usage.reportedRequests + snapshot.session.usage.unreportedRequests
  useEffect(() => { const timer = setTimeout(() => { void refresh() }, 1200); return () => clearTimeout(timer) }, [requests])
  useEffect(() => { setHovered(null); if (open) void refresh() }, [open])
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60000); return () => clearInterval(timer) }, [provider?.id])
  const models = summary?.models.filter(model => model.requests > 0).sort((a, b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens) ?? []
  const maximum = Math.max(1, ...models.map(model => model.inputTokens + model.outputTokens))
  const rows = [
    ['账户余额', credits?.balance != null ? dollars(credits.balance) : '不可用'],
    ['Key 剩余限额', credits?.keyLimit === null ? '未设限额' : dollars(credits?.keyRemaining)],
  ]
  return <div className="usage-area">
    <button className="balance-button popover-trigger" aria-label="Session usage" data-testid="balance-button" onClick={toggle} title="查看余额和累计用量">
      <span>余额</span><strong>{credits?.balance != null ? dollars(credits.balance) : credits?.keyRemaining != null ? dollars(credits.keyRemaining) : busy ? '查询中…' : '—'}</strong>
      {credits?.balance == null && credits?.keyRemaining != null && <small>Key 限额</small>}
    </button>
    {open && <div className="popover usage-popover" data-testid="usage-panel" onScroll={() => setHovered(null)}><div className="popover-heading">余额与模型用量<button className="text-button" aria-label="Refresh usage" disabled={busy} onClick={() => { void refresh() }}><RefreshCw size={13} className={busy ? 'spin' : ''} /></button></div>
      {rows.map(([label, value]) => <div className="usage-line" key={label}><span>{label}</span><strong>{value}</strong></div>)}
      {credits?.managementKey && provider && <div className="usage-key-warning"><p>当前是管理 Key，不能聊天。可创建一把 Clax 调用 Key，累计上限 $15，由系统加密保存；管理 Key 保留查余额。</p><button className="secondary-button" disabled={busy} onClick={() => { void (async () => { try { setBusy(true); await api.provisionOpenRouter(provider.id); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false) } })() }}>创建 Clax 调用 Key（上限 $15）</button></div>}
      <div className="usage-bars" aria-label="模型累计用量">{models.map((model, index) => {
        const amount = model.inputTokens + model.outputTokens
        const name = snapshot.providers.find(p => p.id === model.provider)?.models.find(m => m.id === model.model)?.name.replace(/^[^:]+:\s*/, '') ?? model.model
        const id = `${model.provider}:${model.model}`
        return <div className="usage-bar-row" key={id} tabIndex={0} data-testid="model-usage-row" aria-label={`${name} 用量`} onMouseEnter={e => hover(id, e.currentTarget)} onMouseLeave={() => setHovered(null)} onFocus={e => hover(id, e.currentTarget)} onBlur={() => setHovered(null)}>
          <div className="usage-bar-label"><span>{name}</span><small>{amount ? amount.toLocaleString() : '未回传'} tokens</small></div>
          <div className="usage-bar-track"><div className={`usage-bar-fill shade-${index % 3}`} style={{ width: `${amount / maximum * 100}%` }} /></div>
          {hovered?.id === id && createPortal(<div className="usage-bar-tooltip" role="tooltip" style={{ left: hovered.left, top: hovered.top }}><strong>{name}</strong><span>输入 {model.inputTokens.toLocaleString()}</span><span>缓存命中 {model.cacheReportedRequests ? model.cachedTokens.toLocaleString() : '未回传'}（包含在输入中）</span><span>输出 {model.outputTokens.toLocaleString()}</span>{model.cacheWriteTokens > 0 && <span>缓存写入 {model.cacheWriteTokens.toLocaleString()}</span>}<span>API 费用 {dollars(model.reportedCost)}</span>{model.webSearchReportedRequests > 0 && <span>联网搜索 {model.webSearchRequests.toLocaleString()} 次</span>}{model.estimatedCost > 0 && <span>另有估算费用 {dollars(model.estimatedCost)}</span>}{model.unreportedRequests > 0 && <span>{model.unreportedRequests} 次未回传完整用量</span>}{model.unpricedRequests > 0 && <span>{model.unpricedRequests} 次未回传费用</span>}</div>, document.body)}
        </div>
      })}{!models.length && <p className="muted">还没有模型用量，使用后会显示在这里。</p>}</div>
      <p className="muted">条长按累计输入 + 输出 Token 比较，悬停查看明细。缓存命中包含在输入中。联网搜索费用以接口返回总费用为准。仅统计本机 Clax 用量；账户余额会受其他应用消费影响，接口记账可能延迟。</p>
      {(error || credits?.error) && <p className="error-text" role="status">{error || credits?.error}</p>}
      {credits && <small className="usage-updated">余额更新于 {new Date(credits.updatedAt).toLocaleTimeString()}</small>}
    </div>}
  </div>
}
