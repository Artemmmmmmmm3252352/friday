import { describe, expect, it } from 'vitest'

import { actionAgentMessage, parseScheduledActionRequest } from './scheduler'

describe('scheduler parser', () => {
  it('parses delayed calculator launch in russian', () => {
    const parsed = parseScheduledActionRequest('через 2 минуты запусти калькулятор')

    expect(parsed).not.toBeNull()
    expect(parsed?.action.id).toBe('calculator')
    expect(parsed?.quantity).toBe(2)
    expect(parsed?.delayMs).toBe(120000)
  })

  it('parses delayed explorer launch in english', () => {
    const parsed = parseScheduledActionRequest('in 1 hour open explorer')

    expect(parsed).not.toBeNull()
    expect(parsed?.action.id).toBe('explorer')
    expect(parsed?.quantity).toBe(1)
    expect(parsed?.delayMs).toBe(3600000)
  })

  it('parses delayed text file creation on desktop', () => {
    const parsed = parseScheduledActionRequest('через 3 минуты создай текстовый файл привет на рабочем столе')

    expect(parsed).not.toBeNull()
    expect(parsed?.action.id).toBe('create-text-file')
    expect(parsed?.action.kind).toBe('file')

    if (!parsed || parsed.action.kind !== 'file') {
      throw new Error('expected file action')
    }

    expect(parsed.action.fileName).toBe('привет.txt')
    expect(parsed.action.location).toBe('desktop')
    expect(actionAgentMessage(parsed.action, 'ru')).toBe('создай текстовый файл "привет.txt" на рабочем столе')
  })

  it('parses delayed text file creation with explicit content', () => {
    const parsed = parseScheduledActionRequest(
      'через 3 минуты создай текстовый файл привет на рабочем столе и запиши в него текст привет',
    )

    expect(parsed).not.toBeNull()

    if (!parsed || parsed.action.kind !== 'file') {
      throw new Error('expected file action')
    }

    expect(parsed.action.content).toBe('привет')
    expect(actionAgentMessage(parsed.action, 'ru')).toBe(
      'создай текстовый файл "привет.txt" на рабочем столе и запиши в него текст "привет"',
    )
  })

  it('returns null for unsupported actions', () => {
    expect(parseScheduledActionRequest('через 2 минуты запусти blender')).toBeNull()
  })
})
