import type { XVextaBlockInput } from './index'
import { stripXVextaHtml } from './xVextaRichText'

const PLACEHOLDER_PATTERNS = [
  /^(?:latest|recent|current)\s+news(?:\s+(?:about|on)\s+.+)?$/i,
  /^news(?:\s+(?:about|on)\s+.+)?$/i,
  /^(?:последние|актуальные)\s+новости(?:\s+(?:о|про)\s+.+)?$/iu,
  /^новости(?:\s+(?:о|про)\s+.+)?$/iu,
  /^(?:structured text|formatted note|well-formatted note)$/i,
  /^(?:структурированный\s+текст|красиво\s+оформленная\s+заметка)$/iu,
]

export function flattenXVextaBlockText(blocks: XVextaBlockInput[] | undefined | null): string {
  if (!blocks || blocks.length === 0) {
    return ''
  }

  return blocks
    .flatMap((block) => {
      const chunks: string[] = []
      const content = typeof block.content === 'string' ? stripXVextaHtml(block.content).trim() : ''
      if (content) {
        chunks.push(content)
      }

      if (block.type === 'table' && block.metadata) {
        const columns = Array.isArray(block.metadata.columns) ? block.metadata.columns.map(String).join(' | ') : ''
        const rows = Array.isArray(block.metadata.rows) ? block.metadata.rows.map(String).join('\n') : ''
        if (columns) {
          chunks.push(columns)
        }
        if (rows) {
          chunks.push(rows)
        }
      }

      return chunks
    })
    .join('\n')
    .trim()
}

export function isXVextaPlaceholderNoteContent(input: {
  title?: string | null
  summary?: string | null
  blocks?: XVextaBlockInput[] | null
}): boolean {
  const title = normalizeForMatch(input.title ?? '')
  const summary = stripXVextaHtml(input.summary ?? '').trim()
  const blockText = flattenXVextaBlockText(input.blocks)
  const signalText = [summary, blockText].filter(Boolean).join('\n').trim()

  if (!signalText) {
    return true
  }

  const normalizedSignal = normalizeForMatch(signalText)
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(signalText))) {
    return true
  }

  if (title && normalizedSignal === title) {
    return true
  }

  if (
    title &&
    normalizedSignal.includes(title) &&
    signalText.length < 120 &&
    /(?:news|новост|structured|оформ|формат)/iu.test(signalText)
  ) {
    return true
  }

  return false
}

function normalizeForMatch(value: string): string {
  return stripXVextaHtml(value).replace(/\s+/g, ' ').trim().toLowerCase()
}
