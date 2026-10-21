import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ActivityStatus, AppSettings } from '../shared/types'
import { ActivityStore } from './activity-store'

const observation = z.object({
  time: z.number().finite().nonnegative(), app: z.string().max(500), bundleId: z.string().max(500),
  window: z.string().max(2000), idleSeconds: z.number().finite().nonnegative(),
})
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), generation: z.number().int(), trusted: z.boolean() }),
  z.object({ type: z.literal('sample'), generation: z.number().int(), trusted: z.boolean(), blocked: z.boolean().optional(), locked: z.boolean().optional() }).extend(observation.partial().shape),
  z.object({ type: z.literal('selection'), generation: z.number().int(), id: z.string(), error: z.string().optional(), text: z.string().max(8000).optional() }).extend(observation.partial().shape),
])

/** Native collection is user-controlled; models receive only already saved observations. */
export class ActivityObserver {
  private child?: ChildProcessWithoutNullStreams
  private generation = 0
  private suspended = false
  private settings: AppSettings['activity']
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private state: ActivityStatus
  private prunedDay = ''
  constructor(private store: ActivityStore, settings: AppSettings['activity'], private helper: string,
    private notify: (status: ActivityStatus) => void,
    private launch = () => spawn(helper, [], { stdio: 'pipe' })) {
    this.settings = structuredClone(settings)
    this.state = { supported: process.platform === 'darwin', enabled: settings.enabled, state: 'off', accessibility: 'unknown' }
  }
  status() { return { ...this.state } }
  private update(patch: Partial<ActivityStatus>) { Object.assign(this.state, patch); this.notify(this.status()) }
  configure(settings: AppSettings['activity']) {
    this.settings = structuredClone(settings); this.generation++; this.store.boundary(); this.cancelSelections()
    this.store.prune(settings.retentionDays)
    if (!settings.enabled || this.suspended) {
      this.stopSource(); this.update({ enabled: settings.enabled, state: settings.enabled && this.suspended ? 'locked' : 'off', currentApp: undefined, error: undefined }); return
    }
    if (!this.state.supported) { this.update({ enabled: true, state: 'error', error: '目前活动记录仅支持 macOS。' }); return }
    this.update({ enabled: true, state: 'starting', error: undefined })
    this.startSource(); this.sendConfiguration()
  }
  suspend(suspended: boolean) { this.suspended = suspended; this.configure(this.settings) }
  private startSource() {
    if (this.child) return
    const child = this.launch(); this.child = child
    const reader = createInterface({ input: child.stdout })
    reader.on('line', line => {
      if (this.child !== child || line.length > 25000) return
      try { this.receive(frameSchema.parse(JSON.parse(line))) }
      catch { this.store.boundary(); this.update({ state: 'error', error: '活动记录器返回了无效数据。' }) }
    })
    // Report native failures without echoing selected text or window contents into logs.
    child.stderr.resume()
    child.on('error', () => { if (this.child === child) { this.child = undefined; this.cancelSelections(); this.update({ state: 'error', error: '无法启动活动记录器，请运行 pnpm build。' }) } })
    child.on('exit', () => {
      reader.close()
      if (this.child !== child) return
      this.child = undefined; this.store.boundary(); this.cancelSelections()
      this.update({ state: 'error', error: '活动记录器已退出；关闭再开启活动记录可重试。' })
    })
    child.stdin.on('error', () => { /* Selection requests also have a bounded timeout. */ })
  }
  private send(value: unknown) { this.child?.stdin.write(`${JSON.stringify(value)}\n`) }
  private sendConfiguration() {
    this.send({ type: 'configure', generation: this.generation, enabled: this.settings.enabled && !this.suspended,
      ownerPid: process.pid, excludedApps: this.settings.excludedApps })
  }
  private receive(frame: z.infer<typeof frameSchema>) {
    if (frame.generation !== this.generation) return
    if (frame.type === 'ready') { this.update({ accessibility: frame.trusted ? 'granted' : 'needed' }); return }
    if (!this.settings.enabled || this.suspended) return
    if (frame.type === 'selection') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id); clearTimeout(pending.timer)
      try {
        if (frame.error) throw new Error(frame.error)
        this.store.selection(observation.parse(frame), frame.text ?? '', this.settings); pending.resolve()
      } catch (error) { pending.reject(error instanceof Error ? error : new Error('未能保存选中文字。')) }
      return
    }
    const day = new Date().toDateString()
    if (day !== this.prunedDay) { this.store.prune(this.settings.retentionDays); this.prunedDay = day }
    if (frame.blocked) { this.store.boundary(); this.update({ state: frame.locked ? 'locked' : 'excluded', currentApp: undefined, lastSampleAt: Date.now(), accessibility: frame.trusted ? 'granted' : 'needed' }); return }
    const sample = observation.parse(frame), saved = this.store.record(sample, this.settings)
    this.update({ state: sample.idleSeconds >= 60 ? 'idle' : saved ? 'recording' : 'excluded',
      accessibility: frame.trusted ? 'granted' : 'needed', lastSampleAt: sample.time, currentApp: saved ? sample.app : undefined, error: undefined })
  }
  captureSelection(): Promise<void> {
    if (!this.settings.enabled || this.suspended || !this.child) return Promise.reject(new Error('请先开启活动记录。'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('读取选中文字超时，请重试。')) }, 8000)
      this.pending.set(id, { resolve, reject, timer }); this.send({ type: 'selection', id })
    })
  }
  requestPermission() {
    if (!this.state.supported) throw new Error('这个功能目前仅支持 macOS。')
    this.startSource(); this.sendConfiguration(); this.send({ type: 'permission' })
  }
  private cancelSelections() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('活动记录已暂停或配置已更改。')) }
    this.pending.clear()
  }
  private stopSource() { const child = this.child; this.child = undefined; child?.stdin.end(); child?.kill() }
  clear(date: string) {
    // Reject in-flight responses before deletion; they cannot recreate a deleted observation.
    this.generation++; this.cancelSelections(); this.store.delete(date); this.sendConfiguration()
  }
  close() { this.cancelSelections(); this.stopSource(); this.store.boundary() }
}
