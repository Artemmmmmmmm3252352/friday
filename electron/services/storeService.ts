import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { createDefaultPreferences, createEmptyState, normalizeTheme } from '../../src/shared/persistence'
import type { PersistedAppState } from '../../src/shared/contracts'

export class StoreService {
  private readonly statePath: string

  constructor(userDataPath: string) {
    this.statePath = path.join(userDataPath, 'state', 'friday-state.json')
  }

  async loadState(): Promise<PersistedAppState> {
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as PersistedAppState

      if (!parsed.sessionId || !Array.isArray(parsed.messages)) {
        throw new Error('Invalid stored state')
      }

      return {
        ...parsed,
        remoteSessionId: parsed.remoteSessionId || randomUUID(),
        activeFolderId: parsed.activeFolderId ?? 'inbox',
        preferences: parsed.preferences
          ? {
              ...createDefaultPreferences(),
              ...parsed.preferences,
              theme: normalizeTheme(parsed.preferences.theme),
            }
          : createDefaultPreferences(),
      }
    } catch {
      const initial = createEmptyState(randomUUID())
      await this.saveState(initial)
      return initial
    }
  }

  async saveState(state: PersistedAppState): Promise<PersistedAppState> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    await writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8')
    return state
  }

  async createNewSession(): Promise<PersistedAppState> {
    const fresh = createEmptyState(randomUUID())
    await this.saveState(fresh)
    return fresh
  }
}
