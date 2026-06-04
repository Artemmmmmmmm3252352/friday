/// <reference types="vite/client" />

import type { FridayApi } from '@shared/contracts'

declare global {
  interface Window {
    friday: FridayApi
  }
}

export {}
