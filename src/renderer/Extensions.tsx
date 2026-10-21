import { useState } from 'react'
import type { ExtensionInfo } from '../shared/extensions'

const api = window.clax
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
function ExtensionCard({ item, refresh }: { item: ExtensionInfo; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [key, setKey] = useState(''), [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState('')
  async function operation(fn: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await fn(); await refresh() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const action = (name: 'test' | 'install' | 'enable' | 'disable' | 'rollback') => operation(() => api.extensionAction(item.id, name))
  return <article className="extension-card" data-testid={`extension-${item.id}`}>
    <div className="setting-row"><div><strong>{item.name}</strong><small>{item.id} · {item.version ? `v${item.version}` : '未安装'} · {item.enabled ? '已启用' : '未启用'}</small></div>
      {item.version && <button className={`switch ${item.enabled ? 'on' : ''}`} aria-label={`Enable ${item.id}`} role="switch" aria-checked={item.enabled} disabled={busy} onClick={() => { void action(item.enabled ? 'disable' : 'enable') }}><span /></button>}</div>
    <p>{item.description}</p><small className="muted">网络：{item.hosts.join(', ') || '无'} · {item.methods.join(', ')}<br />工具：{item.tools.join(', ') || '无'}</small>
    {item.draft && <div className="form-actions"><span className="muted">草稿 v{item.draft.version} · {item.draft.tested ? '测试通过' : '待测试'}</span><button className="secondary-button" disabled={busy} onClick={() => { void action('test') }}>测试草稿</button><button className="primary-button" disabled={busy} onClick={() => { void action('install') }}>测试并安装</button></div>}
    {item.previous && <button className="text-button" disabled={busy} onClick={() => { void action('rollback') }}>回退上一版本</button>}
    {item.auth && item.version && <div className="extension-connection"><strong>{item.connected ? '账号已连接' : item.auth.type === 'google-readonly' ? '连接 Gmail（只读）' : '配置搜索 / API 服务'}</strong>
      {item.auth.type === 'google-readonly' ? <>
        <p className="muted">使用你自己的 Google Cloud 桌面应用 OAuth 客户端，在系统浏览器完成登录授权。</p>
        <label>Google OAuth Client ID<input aria-label={`Google client ID ${item.id}`} value={clientId} onChange={e => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" /></label>
        <label>Client Secret（如客户端要求）<input aria-label={`Google client secret ${item.id}`} type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} autoComplete="off" /></label>
      </> : <label>API Key<input aria-label={`Plugin API key ${item.id}`} type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" /></label>}
      <div className="form-actions"><button className="primary-button" disabled={busy || !item.enabled} onClick={() => { const input = { apiKey: key || undefined, clientId: clientId || undefined, clientSecret: clientSecret || undefined }; setKey(''); setClientSecret(''); void operation(() => api.connectExtension(item.id, input)) }}>{busy ? '正在连接…' : item.auth.type === 'google-readonly' ? '在浏览器中授权' : '保存连接'}</button>
        <button className="secondary-button" onClick={() => { void api.disconnectExtension(item.id).then(refresh).catch(e => setError(errorText(e))) }}>断开 / 取消授权流程</button></div>
    </div>}
    {(error || item.error) && <p className="settings-error" role="alert">{error || item.error}</p>}
  </article>
}

export function ExtensionsPanel({ items, refresh }: { items: ExtensionInfo[]; refresh: () => Promise<void> }) {
  return <><h2>让 Clax 学会新的能力。</h2><p className="settings-intro">对 Clax 说“给自己添加某项功能”，它会开发插件、测试并安装。插件立即成为可调用工具，已安装的版本跨重启保留。</p>
    {!items.length && <p className="muted">还没有插件。可以先说：“开发并安装一个联网搜索插件，缺少服务 Key 时告诉我怎么连接。”</p>}
    {items.map(item => <ExtensionCard key={item.id} item={item} refresh={refresh} />)}
    <button className="secondary-button" onClick={() => { void api.openExtensionsFolder() }}>打开插件源码与版本目录</button>
  </>
}
