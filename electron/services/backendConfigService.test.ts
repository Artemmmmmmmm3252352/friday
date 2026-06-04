import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BackendConfigService } from './backendConfigService'

const tempDirs: string[] = []

afterEach(async () => {
  for (const target of tempDirs.splice(0)) {
    await import('node:fs/promises').then(({ rm }) => rm(target, { recursive: true, force: true }))
  }
})

describe('BackendConfigService', () => {
  it('returns default config when file is missing', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'friday-backend-config-'))
    tempDirs.push(userDataPath)
    const service = new BackendConfigService(userDataPath)

    await expect(service.load()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:3010',
    })
  })

  it('normalizes and persists base url', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'friday-backend-config-'))
    tempDirs.push(userDataPath)
    const service = new BackendConfigService(userDataPath)

    await service.save({
      baseUrl: 'http://localhost:4000///',
    })

    await expect(service.load()).resolves.toEqual({
      baseUrl: 'http://localhost:4000',
    })
  })
})
