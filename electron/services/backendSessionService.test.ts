import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BackendSessionService } from './backendSessionService'

const tempDirs: string[] = []

afterEach(async () => {
  for (const target of tempDirs.splice(0)) {
    await rm(target, { recursive: true, force: true })
  }
})

describe('BackendSessionService', () => {
  it('stores and clears backend session state', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'friday-backend-session-'))
    tempDirs.push(userDataPath)
    const service = new BackendSessionService(userDataPath)

    const saved = await service.save({
      session: {
        token: 'usr_token',
        tokenType: 'user',
        expiresAt: null,
        user: {
          id: 'user-1',
          tenantId: 'tenant-1',
          email: 'test@example.com',
          displayName: 'Test',
          avatarUrl: null,
          settings: {
            timezone: 'UTC',
            locale: 'en',
            bedtimeStart: null,
            quietHoursStart: null,
            quietHoursEnd: null,
          },
          createdAt: '2026-03-16T00:00:00.000Z',
          updatedAt: '2026-03-16T00:00:00.000Z',
        },
      },
      appToken: 'app_token',
      subscriptionPlan: 'pro',
      updatedAt: '2026-03-16T00:00:00.000Z',
    })

    expect(saved.session?.token).toBe('usr_token')
    expect((await service.load()).appToken).toBe('app_token')
    expect((await service.load()).subscriptionPlan).toBe('pro')

    const cleared = await service.clear()
    expect(cleared.session).toBeNull()
    expect(cleared.appToken).toBeNull()
  })
})
