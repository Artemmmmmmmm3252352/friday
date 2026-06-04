import { describe, expect, it } from 'vitest'

import { parseTelegramRemoteAction } from './telegramRemoteService'

describe('telegram remote service', () => {
  it('parses pairing and remote desktop commands', () => {
    expect(parseTelegramRemoteAction('/pair 123456')).toEqual({ type: 'pair', code: '123456' })
    expect(parseTelegramRemoteAction('/screen')).toEqual({ type: 'screen' })
    expect(parseTelegramRemoteAction('/key enter')).toEqual({ type: 'key', key: 'enter' })
    expect(parseTelegramRemoteAction('/type hello world')).toEqual({ type: 'type', text: 'hello world' })
    expect(parseTelegramRemoteAction('/open calc')).toEqual({ type: 'open', target: 'calc' })
    expect(parseTelegramRemoteAction('/shutdown')).toEqual({ type: 'shutdown' })
    expect(parseTelegramRemoteAction('/restart')).toEqual({ type: 'restart' })
    expect(parseTelegramRemoteAction('/lock')).toEqual({ type: 'lock' })
  })

  it('routes normal text to the agent chat', () => {
    expect(parseTelegramRemoteAction('какие у меня задачи')).toEqual({
      type: 'chat',
      text: 'какие у меня задачи',
    })
  })

  it('parses inline keyboard callback payloads', () => {
    expect(parseTelegramRemoteAction('menu:screen')).toEqual({ type: 'screen' })
    expect(parseTelegramRemoteAction('menu:key-enter')).toEqual({ type: 'key', key: 'enter' })
    expect(parseTelegramRemoteAction('menu:key-alt-tab')).toEqual({ type: 'key', key: '%{TAB}' })
    expect(parseTelegramRemoteAction('menu:open-calc')).toEqual({ type: 'open', target: 'calculator' })
  })
})
