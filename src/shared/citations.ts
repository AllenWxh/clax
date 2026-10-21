import type { WebCitation } from './types'

/** Accept source metadata, never executable URLs or fabricated links from prose. */
export function parseCitations(value: unknown): WebCitation[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 50).flatMap(item => {
    if (item?.type !== 'url_citation') return []
    const raw = item.url_citation ?? item
    try {
      if (typeof raw.url !== 'string' || raw.url.length > 8192) return []
      const url = new URL(raw.url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return []
      const index = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
      return [{ url: url.href, title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : url.hostname,
        startIndex: index(raw.start_index), endIndex: index(raw.end_index),
        ...(typeof raw.content === 'string' ? { content: raw.content.slice(0, 4000) } : {}) }]
    } catch { return [] }
  })
}
export function mergeCitations(previous: WebCitation[], next: WebCitation[]): WebCitation[] {
  const result = new Map<string, WebCitation>()
  for (const citation of [...previous, ...next]) result.set(`${citation.url}:${citation.startIndex}:${citation.endIndex}`, citation)
  return [...result.values()].slice(0, 50)
}
export function citationMarkdown(text: string, citations: WebCitation[]): string {
  const edits = new Map<string, { start: number; end: number; link: string }>()
  for (const [i, citation] of citations.entries()) {
    const start = citation.startIndex, end = citation.endIndex
    // Native Claude can return 0/0 for an unpositioned source; show it in the source list only.
    if (start === undefined || end === undefined || start >= end || end > text.length) continue
    const raw = text.slice(start, end), link = `[${i + 1}](<${citation.url}>)`
    const edit = /^cite[^]+$/.test(raw) ? { start, end, link }
      : !raw.includes(citation.url) ? { start: end, end, link: ` ${link}` } : null
    if (!edit) continue
    const key = `${edit.start}:${edit.end}`, previous = edits.get(key)
    edits.set(key, previous ? { ...previous, link: `${previous.link} ${edit.link}` } : edit)
  }
  // Apply from the end so source-provided offsets remain stable; preserve the answer itself.
  let boundary = text.length
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
    if (edit.end > boundary) continue
    text = text.slice(0, edit.start) + edit.link + text.slice(edit.end); boundary = edit.start
  }
  return text
}
