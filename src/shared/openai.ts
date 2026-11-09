import type { ModelInfo, ReasoningEffort } from './types'

export const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol'
// /models returns access, not capacity or reasoning levels. Keep verified model-card facts separate.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
const cards = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 1050000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 400000, efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
]
export function openAIModel(id: string): Partial<ModelInfo> {
  const card = cards.find(c => id === c.id || id.startsWith(`${c.id}-20`))
  return card ? { name: card.name, contextWindow: card.contextWindow, maxOutputTokens: 128000,
    reasoning: true, reasoningEfforts: card.efforts as ReasoningEffort[] } : {}
}
export function openAIChatModel(id: string): boolean {
  return /^(?:gpt-[4-9]|o[134](?:-|$))/.test(id) && !/audio|realtime|transcri|tts|image|search|codex|instruct/.test(id)
}
