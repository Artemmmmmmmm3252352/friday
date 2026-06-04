import { describe, expect, it } from 'vitest'

import { formatXVextaInlineText, parseXVextaRichText, stripXVextaHtml, summarizeXVextaBlockInputs } from './xVextaRichText'

describe('xVextaRichText', () => {
  it('parses rich note content into structured blocks', () => {
    const parsed = parseXVextaRichText(`# BMW News
Status: active
> [!TIP] Watch the Neue Klasse launch
- EV strategy
1. Check the release
| Model | Range |
| --- | --- |
| iX3 | 800 km |
![Cover](https://example.com/cover.png)
embed: https://example.com/report
`)

    expect(parsed.status).toBe('active')
    expect(parsed.blocks.map((block) => block.type)).toEqual([
      'heading-1',
      'callout',
      'bulleted-list',
      'numbered-list',
      'table',
      'image',
      'embed',
    ])
  })

  it('formats inline markdown and derives a plain preview', () => {
    const parsed = parseXVextaRichText('**Bold** with `code` and [link](https://example.com)')

    expect(parsed.blocks).toEqual([
      {
        type: 'text',
        content: '<strong>Bold</strong> with <code>code</code> and <a href="https://example.com">link</a>',
      },
    ])
    expect(formatXVextaInlineText('**Bold**')).toBe('<strong>Bold</strong>')
    expect(stripXVextaHtml(parsed.blocks[0].content ?? '')).toBe('Bold with code and link')
    expect(summarizeXVextaBlockInputs(parsed.blocks)).toBe('Bold with code and link')
  })
})
