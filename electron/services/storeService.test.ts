// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { StoreService } from './storeService'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((target) => rm(target, { recursive: true, force: true })))
})

describe('StoreService', () => {
  it('creates and reloads persisted chat state', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'friday-store-'))
    tempRoots.push(userData)

    const service = new StoreService(userData)
    const initial = await service.loadState()
    expect(initial.messages).toEqual([])

    const mutated = { ...initial, draft: 'Check systems' }
    await service.saveState(mutated)

    const reloaded = await service.loadState()
    expect(reloaded.draft).toBe('Check systems')
  })
})
