export const BACKGROUND_SEPARATOR = '\n\n<!-- clax-background-section -->\n\n'
export const CONTEXT_TOKEN_PRESETS = [16000, 32000, 64000, 128000, 256000]
export const DEFAULT_CONTEXT_CHARS = 0 // Zero follows model capacity without a separate Clax ceiling.
export const COMPACTION_RATIO = 0.82

/** Keep the persisted character setting compatible; UI and model limits use tokens. */
export function contextLimits(maxChars: number, contextWindow?: number, maxOutputTokens?: number) {
  const window = contextWindow && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 32768
  const nativeOutput = maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.min(Math.floor(maxOutputTokens), Math.max(1, window - 1)) : undefined
  // Reserve reply space without reserving the entire advertised maximum. Actual output can use remaining capacity.
  const output = Math.min(nativeOutput ?? Infinity, Math.max(1, Math.floor(window / 4)))
  return { budget: Math.max(1, Math.min(maxChars > 0 ? Math.floor(maxChars / 3) : Infinity, Math.floor(window * 0.9) - output)), output, window, nativeOutput }
}
