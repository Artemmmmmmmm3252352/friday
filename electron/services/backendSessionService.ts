import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BackendSessionState } from '@contracts'

const EMPTY_SESSION_STATE: BackendSessionState = {
  session: null,
  appToken: null,
  appRefreshToken: null,
  updatedAt: new Date(0).toISOString(),
}

export class BackendSessionService {
  private readonly statePath: string

  constructor(userDataPath: string) {
    this.statePath = path.join(userDataPath, 'state', 'backend-session.json')
  }

  async load(): Promise<BackendSessionState> {
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as BackendSessionState
      return {
        session: parsed.session ?? null,
        appToken: parsed.appToken ?? null,
        appRefreshToken: parsed.appRefreshToken ?? null,
        subscriptionPlan: parsed.subscriptionPlan,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      }
    } catch {
      return EMPTY_SESSION_STATE
    }
  }

  async save(state: BackendSessionState): Promise<BackendSessionState> {
    const normalized: BackendSessionState = {
      session: state.session ?? null,
      appToken: state.appToken ?? null,
      appRefreshToken: state.appRefreshToken ?? null,
      subscriptionPlan: state.subscriptionPlan,
      updatedAt: new Date().toISOString(),
    }
    await mkdir(path.dirname(this.statePath), { recursive: true })
    await writeFile(this.statePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return normalized
  }

  async clear(): Promise<BackendSessionState> {
    return this.save(EMPTY_SESSION_STATE)
  }
}
