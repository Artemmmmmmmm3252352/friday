import { describe, expect, it } from 'vitest'

import { flattenXVextaBlockText, isXVextaPlaceholderNoteContent } from './xVextaNoteContent'

describe('xVextaNoteContent', () => {
  it('detects placeholder news-style note content', () => {
    expect(
      isXVextaPlaceholderNoteContent({
        title: 'Новости о кофе',
        summary: 'Последние новости о кофе',
        blocks: [],
      }),
    ).toBe(true)
  })

  it('keeps substantive structured note content', () => {
    const blocks = [
      { type: 'heading-1', content: 'Новости о кофе' } as const,
      { type: 'bulleted-list', content: 'Starbucks обновила весеннее меню и усилила cold brew линейку.' } as const,
      { type: 'quote', content: 'Рынок specialty coffee продолжает расти в городских форматах.' } as const,
    ]

    expect(flattenXVextaBlockText(blocks)).toContain('Starbucks')
    expect(
      isXVextaPlaceholderNoteContent({
        title: 'Новости о кофе',
        summary: 'Starbucks обновила весеннее меню и усилила cold brew линейку.',
        blocks,
      }),
    ).toBe(false)
  })
})
