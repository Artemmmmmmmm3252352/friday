// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BackendSessionService } from './backendSessionService'
import { MessageQuotaService } from './messageQuotaService'

const tempDirs: string[] = []

afterEach(async () => {
  for (const target of tempDirs.splice(0)) {
    await rm(target, { recursive: true, force: true })
  }
})

describe('MessageQuotaService', () => {
  it('blocks Standard on the 36th monthly message', async () => {
    const service = await createService('standard')

    for (let index = 0; index < 35; index += 1) {
      const result = await service.consume({ route: 'desktop_chat' })
      expect(result.allowed).toBe(true)
    }

    const denied = await service.consume({ route: 'desktop_chat' })
    expect(denied.allowed).toBe(false)
    expect(denied.state.used).toBe(35)
    expect(denied.state.remaining).toBe(0)
  })

  it('blocks Pro on the 151st monthly message', async () => {
    const service = await createService('pro')

    for (let index = 0; index < 150; index += 1) {
      expect((await service.consume({ route: 'telegram_chat' })).allowed).toBe(true)
    }

    expect((await service.consume({ route: 'telegram_chat' })).allowed).toBe(false)
  })

  it('keeps Early unlimited', async () => {
    const service = await createService('early')

    for (let index = 0; index < 180; index += 1) {
      expect((await service.consume({ route: 'desktop_chat' })).allowed).toBe(true)
    }

    const state = await service.getState()
    expect(state.unlimited).toBe(true)
    expect(state.limit).toBeNull()
    expect(state.remaining).toBeNull()
  })
})

async function createService(subscriptionPlan: 'standard' | 'pro' | 'early') {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'friday-quota-'))
  tempDirs.push(userDataPath)
  const sessionService = new BackendSessionService(userDataPath)
  await sessionService.save({
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
    subscriptionPlan,
    updatedAt: '2026-03-16T00:00:00.000Z',
  })
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  }
  return new MessageQuotaService(userDataPath, sessionService, logger as never)
}
