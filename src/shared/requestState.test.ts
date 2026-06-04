import { describe, expect, it } from 'vitest'

import { canTransition, isBusy } from './requestState'

describe('request state helpers', () => {
  it('allows expected busy transition', () => {
    expect(canTransition('recording', 'transcribing')).toBe(true)
    expect(canTransition('idle', 'completed')).toBe(false)
  })

  it('flags busy statuses', () => {
    expect(isBusy('sending')).toBe(true)
    expect(isBusy('completed')).toBe(false)
  })
})
