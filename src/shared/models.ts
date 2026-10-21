import type { ModelInfo, ReasoningEffort } from './types'

export const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const reasoningLabels: Record<ReasoningEffort, string> = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
const families = [
  /^anthropic\/claude-sonnet-/, /^anthropic\/claude-opus-/, /^anthropic\/claude-haiku-/,
  /^openai\/gpt-[\d.]+-sol$/, /^openai\/gpt-[\d.]+-luna$/, /^openai\/gpt-[\d.]+-astra$/,
  /^deepseek\/deepseek-.*flash$/, /^deepseek\/deepseek-.*pro(?:-\d+)?$/,
  /^google\/gemini-.*pro$/, /^google\/gemini-.*flash$/,
  /^moonshotai\/kimi-k\d+(?:\.\d+)?$/, /^qwen\/qwen.*max(?:-prime)?$/, /^x-ai\/grok-[\d.]+$/,
]
// Choose current catalogue entries rather than inventing or pinning expired model IDs.
export function commonModels(models: ModelInfo[]): ModelInfo[] {
  const used = new Set<string>()
  return families.flatMap(pattern => {
    const model = models.find(m => pattern.test(m.id) && !used.has(m.id))
    if (!model) return []
    used.add(model.id); return [model]
  })
}
export function mergeReasoning(previous: Record<string, unknown>[], delta: Record<string, unknown>[]) {
  const result = previous.map(item => ({ ...item }))
  for (const item of delta) {
    const existing = result.find(value => value.index === item.index && value.type === item.type && (item.index !== undefined || value.id === item.id))
    if (!existing) { result.push({ ...item }); continue }
    for (const [key, value] of Object.entries(item)) {
      if (['text', 'summary', 'data', 'signature'].includes(key) && typeof value === 'string') existing[key] = String(existing[key] ?? '') + value
      else if (value !== null) existing[key] = value
    }
  }
  return result
}
