export const CONTEXT_TOKEN_PRESETS = [16000, 32000, 64000, 128000, 256000]
export const MAX_CONTEXT_CHARS = 256000 * 3
export const DEFAULT_CONTEXT_CHARS = MAX_CONTEXT_CHARS
export const COMPACTION_RATIO = 0.82

/** Keep the persisted character setting compatible; UI and model limits use tokens. */
export function contextLimits(maxChars: number, contextWindow?: number) {
  const window = contextWindow && Number.isFinite(contextWindow) && contextWindow >= 1000 ? contextWindow : 32768
  const output = Math.min(8192, Math.max(256, Math.floor(window / 4)))
  return { budget: Math.max(256, Math.min(Math.floor(maxChars / 3), Math.floor(window * 0.9) - output)), output }
}
