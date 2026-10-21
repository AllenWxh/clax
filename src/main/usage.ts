import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentSession, ModelRef, Usage, UsageSummary, UsageTotals } from '../shared/types'

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
export class UsageStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_requests (
      id TEXT PRIMARY KEY, session TEXT, provider TEXT, model TEXT, created_at INTEGER,
      input INTEGER, output INTEGER, cached INTEGER, cache_write INTEGER, reasoning INTEGER,
      requests INTEGER, missing INTEGER, cache_known INTEGER, cost REAL, cost_kind TEXT, web_search INTEGER);
      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY);`)
    if (!db.prepare('PRAGMA table_info(usage_requests)').all().some(column => column.name === 'web_search')) db.exec('ALTER TABLE usage_requests ADD COLUMN web_search INTEGER')
  }
  importLegacy(sessions: AgentSession[]) {
    if (this.db.prepare("SELECT 1 FROM usage_meta WHERE key='legacy-imported'").get()) return
    this.db.exec('BEGIN')
    try {
      for (const session of sessions) {
        const u = session.usage
        if (!u || !u.reportedRequests && !u.unreportedRequests) continue
        // Older session totals do not identify individual models; keep that provenance explicit.
        this.insert(`legacy:${session.id}`, session.id, { provider: 'legacy', model: '升级前历史用量（模型未细分）' }, session.updatedAt,
          u.inputTokens, u.outputTokens, u.cachedTokens, 0, 0, u.reportedRequests + u.unreportedRequests,
          u.unreportedRequests, u.cacheAvailable ? u.reportedRequests : 0, u.estimatedCost, 'estimated')
      }
      this.db.prepare("INSERT INTO usage_meta VALUES ('legacy-imported')").run(); this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private insert(id: string, session: string, model: ModelRef, at: number, input: number, output: number, cached: number, writes: number, reasoning: number, requests: number, missing: number, cacheKnown: number, cost: number | null, kind: string, searches: number | null = null) {
    this.db.prepare('INSERT INTO usage_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, session, model.provider, model.model, at, input, output, cached, writes, reasoning, requests, missing, cacheKnown, cost, kind, searches)
  }
  record(session: string, model: ModelRef | undefined, usage: Usage | null, estimate: number | null) {
    const known = usage && valid(usage.inputTokens) && valid(usage.outputTokens)
    const reported = valid(usage?.cost), cost = reported ? usage!.cost! : valid(estimate) ? estimate : null
    this.insert(randomUUID(), session, model ?? { provider: 'unknown', model: 'unknown' }, Date.now(),
      known ? usage.inputTokens : 0, known ? usage.outputTokens : 0,
      valid(usage?.cachedTokens) ? usage.cachedTokens : 0, valid(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
      valid(usage?.reasoningTokens) ? usage.reasoningTokens : 0, 1, known ? 0 : 1,
      valid(usage?.cachedTokens) ? 1 : 0, cost, reported ? 'reported' : 'estimated', valid(usage?.webSearchRequests) ? usage.webSearchRequests : null)
  }
  summary(): UsageSummary {
    const columns = `COALESCE(SUM(input),0) inputTokens, COALESCE(SUM(output),0) outputTokens,
      COALESCE(SUM(cached),0) cachedTokens, COALESCE(SUM(cache_write),0) cacheWriteTokens,
      COALESCE(SUM(reasoning),0) reasoningTokens, COALESCE(SUM(requests),0) requests,
      COALESCE(SUM(missing),0) unreportedRequests, COALESCE(SUM(cache_known),0) cacheReportedRequests,
      COALESCE(SUM(CASE WHEN cost IS NULL THEN requests ELSE 0 END),0) unpricedRequests,
      COALESCE(SUM(CASE WHEN cost_kind='reported' THEN cost ELSE 0 END),0) reportedCost,
      COALESCE(SUM(CASE WHEN cost_kind='estimated' THEN cost ELSE 0 END),0) estimatedCost,
      COALESCE(SUM(web_search),0) webSearchRequests,
      COALESCE(SUM(CASE WHEN web_search IS NOT NULL THEN requests ELSE 0 END),0) webSearchReportedRequests`
    return { total: this.db.prepare(`SELECT ${columns} FROM usage_requests`).get() as unknown as UsageTotals,
      models: this.db.prepare(`SELECT provider, model, ${columns} FROM usage_requests GROUP BY provider, model ORDER BY SUM(created_at) DESC`).all() as unknown as UsageSummary['models'] }
  }
}
