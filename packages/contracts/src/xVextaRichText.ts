import type { XVextaBlockInput, XVextaNoteStatus } from './index'

export type ParsedXVextaContent = {
  blocks: XVextaBlockInput[]
  status?: XVextaNoteStatus
}

export function formatXVextaInlineText(value: string): string {
  let result = escapeHtml(value)
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  return result
}

export function parseXVextaRichText(value: string): ParsedXVextaContent {
  const lines = value.replace(/\r\n/g, '\n').split('\n')
  const blocks: XVextaBlockInput[] = []
  let detectedStatus: XVextaNoteStatus | undefined

  const pushParagraph = (content: string) => {
    const trimmed = content.trim()
    if (!trimmed) {
      return
    }

    blocks.push({
      type: 'text',
      content: formatXVextaInlineText(trimmed),
    })
  }

  let index = 0
  while (index < lines.length) {
    const rawLine = lines[index]
    const line = rawLine.trim()

    if (!line) {
      index += 1
      continue
    }

    const statusMatch = line.match(/^(?:status|статус)\s*:\s*(draft|active|in-review|done)$/iu)
    if (statusMatch) {
      detectedStatus = statusMatch[1].toLowerCase() as XVextaNoteStatus
      index += 1
      continue
    }

    if (/^```/.test(line)) {
      const language = line.replace(/^```/, '').trim() || 'txt'
      const codeLines: string[] = []
      index += 1

      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        codeLines.push(lines[index])
        index += 1
      }

      blocks.push({
        type: 'code',
        content: codeLines.join('\n'),
        metadata: { language },
      })
      index += 1
      continue
    }

    const table = parseTable(lines, index)
    if (table) {
      blocks.push(table.block)
      index = table.nextIndex
      continue
    }

    if (/^---+$/.test(line)) {
      blocks.push({ type: 'divider' })
      index += 1
      continue
    }

    const imageMatch = line.match(/^!\[[^\]]*]\((https?:\/\/[^\s)]+)\)$/)
    if (imageMatch) {
      blocks.push({
        type: 'image',
        metadata: {
          src: imageMatch[1],
          caption: '',
          alt: '',
        },
      })
      index += 1
      continue
    }

    const embedMatch = line.match(/^(?:embed|mded)\s*:\s*(https?:\/\/\S+)$/i)
    if (embedMatch) {
      blocks.push({
        type: 'embed',
        metadata: {
          url: embedMatch[1],
        },
      })
      index += 1
      continue
    }

    const calloutMatch = line.match(/^>\s*\[!(NOTE|TIP|WARNING|INFO)]\s*(.+)$/i)
    if (calloutMatch) {
      blocks.push({
        type: 'callout',
        content: formatXVextaInlineText(calloutMatch[2]),
        metadata: {
          icon: iconForCallout(calloutMatch[1]),
        },
      })
      index += 1
      continue
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      blocks.push({
        type: level === 1 ? 'heading-1' : level === 2 ? 'heading-2' : 'heading-3',
        content: formatXVextaInlineText(headingMatch[2]),
      })
      index += 1
      continue
    }

    const boldHeadingMatch = line.match(/^\*\*(.+?)\*\*:?\s*$/u)
    if (boldHeadingMatch) {
      blocks.push({
        type: 'heading-2',
        content: formatXVextaInlineText(boldHeadingMatch[1]),
      })
      index += 1
      continue
    }

    const todoMatch = line.match(/^[-*]\s+\[( |x|X)]\s+(.+)$/)
    if (todoMatch) {
      blocks.push({
        type: 'todo',
        content: formatXVextaInlineText(todoMatch[2]),
        metadata: {
          checked: todoMatch[1].toLowerCase() === 'x',
        },
      })
      index += 1
      continue
    }

    const numberedMatch = line.match(/^(\d+)[.)]\s+(.+)$/)
    if (numberedMatch) {
      blocks.push({
        type: 'numbered-list',
        content: formatXVextaInlineText(numberedMatch[2]),
        metadata: {
          start: Number.parseInt(numberedMatch[1], 10) || 1,
        },
      })
      index += 1
      continue
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)$/u)
    if (bulletMatch) {
      blocks.push({
        type: 'bulleted-list',
        content: formatXVextaInlineText(bulletMatch[1]),
      })
      index += 1
      continue
    }

    const quoteMatch = line.match(/^>\s+(.+)$/)
    if (quoteMatch) {
      blocks.push({
        type: 'quote',
        content: formatXVextaInlineText(quoteMatch[1]),
      })
      index += 1
      continue
    }

    pushParagraph(rawLine)
    index += 1
  }

  return {
    blocks:
      blocks.length > 0
        ? blocks
        : [
            {
              type: 'text',
              content: formatXVextaInlineText(value.trim()),
            },
          ],
    status: detectedStatus,
  }
}

export function summarizeXVextaBlockInputs(blocks: XVextaBlockInput[]): string {
  for (const block of blocks) {
    const content = typeof block.content === 'string' ? stripXVextaHtml(block.content).trim() : ''
    if (content) {
      return content.slice(0, 140)
    }

    if (block.type === 'table' && block.metadata && Array.isArray(block.metadata.columns) && block.metadata.columns.length > 0) {
      return block.metadata.columns.map(String).join(' | ').slice(0, 140)
    }
  }

  return ''
}

export function stripXVextaHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parseTable(lines: string[], startIndex: number): { nextIndex: number; block: XVextaBlockInput } | null {
  const rows: string[] = []
  let index = startIndex

  while (index < lines.length && /^\|.+\|$/.test(lines[index].trim())) {
    rows.push(lines[index].trim())
    index += 1
  }

  if (rows.length < 2) {
    return null
  }

  const header = rows[0].slice(1, -1).split('|').map((cell) => cell.trim())
  const bodyRows = rows.slice(2).map((row) => row.slice(1, -1).split('|').map((cell) => cell.trim()).join('|'))

  return {
    nextIndex: index,
    block: {
      type: 'table',
      metadata: {
        columns: header,
        rows: bodyRows.length > 0 ? bodyRows : [header.map(() => '').join('|')],
      },
    },
  }
}

function iconForCallout(value: string): string {
  switch (value.toUpperCase()) {
    case 'NOTE':
      return '\u{1F4DD}'
    case 'TIP':
      return '\u{1F4A1}'
    case 'WARNING':
      return '\u26A0\uFE0F'
    case 'INFO':
      return '\u2139\uFE0F'
    default:
      return '\u{1F4A1}'
  }
}
