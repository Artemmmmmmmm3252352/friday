import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
})

Object.defineProperty(globalThis.navigator, 'permissions', {
  configurable: true,
  value: {
    query: vi.fn().mockResolvedValue({ state: 'granted' }),
  },
})

Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
})
