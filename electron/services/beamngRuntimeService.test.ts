import { describe, expect, it, vi } from 'vitest'

import type { BeamngConfig } from '@contracts'
import { BeamngRuntimeService } from './beamngRuntimeService'

function createConfig(overrides: Partial<BeamngConfig> = {}): BeamngConfig {
  return {
    gamePath: 'C:\\Games\\BeamNG.drive',
    autoLaunch: false,
    defaultVehicleId: 'ego',
    savedPlaces: [
      {
        id: 'garage',
        name: 'Garage',
        waypointId: 'wp_garage',
        aliases: ['home'],
      },
    ],
    ...overrides,
  }
}

describe('BeamngRuntimeService', () => {
  it('resolves deterministic text commands without openclaw fallback', async () => {
    const configService = {
      load: vi.fn().mockResolvedValue(createConfig()),
      save: vi.fn(),
      detectInstalls: vi.fn(),
      resolvePreferredInstall: vi.fn(),
    }
    const openClawService = {
      resolveBeamngIntent: vi.fn(),
    }
    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    }

    const service = new BeamngRuntimeService(
      'E:\\project\\friday',
      configService as never,
      logger as never,
      openClawService as never,
      {
        fetchImpl: vi.fn() as never,
        spawnImpl: vi.fn() as never,
        execFileImpl: vi.fn() as never,
      },
    )

    const resolution = await service.resolveTextCommand('включи автопилот', 'ru')

    expect(resolution.command).toEqual({ type: 'traffic' })
    expect(openClawService.resolveBeamngIntent).not.toHaveBeenCalled()
  })

  it('resolves new span mode text commands without openclaw fallback', async () => {
    const configService = {
      load: vi.fn().mockResolvedValue(createConfig()),
      save: vi.fn(),
      detectInstalls: vi.fn(),
      resolvePreferredInstall: vi.fn(),
    }
    const openClawService = {
      resolveBeamngIntent: vi.fn(),
    }
    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    }

    const service = new BeamngRuntimeService(
      'E:\\project\\friday',
      configService as never,
      logger as never,
      openClawService as never,
      {
        fetchImpl: vi.fn() as never,
        spawnImpl: vi.fn() as never,
        execFileImpl: vi.fn() as never,
      },
    )

    const resolution = await service.resolveTextCommand('исследуй карту', 'ru')

    expect(resolution.command).toEqual({ type: 'span' })
    expect(openClawService.resolveBeamngIntent).not.toHaveBeenCalled()
  })

  it('executes a BeamNG command against the bridge', async () => {
    const configService = {
      load: vi.fn().mockResolvedValue(createConfig()),
      save: vi.fn(),
      detectInstalls: vi.fn(),
      resolvePreferredInstall: vi.fn().mockResolvedValue({
        source: 'config',
        path: 'C:\\Games\\BeamNG.drive',
        exePath: 'C:\\Games\\BeamNG.drive\\Bin64\\BeamNG.drive.x64.exe',
        valid: true,
        detail: 'ok',
      }),
    }
    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    }
    let healthChecks = 0
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        healthChecks += 1
        if (healthChecks === 1) {
          throw new Error('offline')
        }

        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            ok: true,
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            beamngpyInstalled: true,
            connected: true,
            gameRunning: true,
            detail: 'BeamNG bridge ready.',
          }),
        }
      }

      if (url.endsWith('/connect')) {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            installStatus: 'valid',
            installPath: 'C:\\Games\\BeamNG.drive',
            connected: true,
            gameRunning: true,
            detail: 'Connected to BeamNG.',
            vehicleId: 'ego',
          }),
        }
      }

      if (url.endsWith('/command') && init?.method === 'POST') {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            installStatus: 'valid',
            installPath: 'C:\\Games\\BeamNG.drive',
            connected: true,
            gameRunning: true,
            activeMode: 'traffic',
            detail: 'BeamNG traffic autopilot is active.',
            vehicleId: 'ego',
          }),
        }
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })
    const spawnImpl = vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      once: vi.fn(),
      kill: vi.fn(),
    })
    const execFileImpl = vi.fn((_command, _args, _options, callback) => callback(null, 'Python 3.11.0', ''))

    const service = new BeamngRuntimeService(
      'E:\\project\\friday',
      configService as never,
      logger as never,
      { resolveBeamngIntent: vi.fn() } as never,
      {
        fetchImpl: fetchImpl as never,
        spawnImpl: spawnImpl as never,
        execFileImpl: execFileImpl as never,
      },
    )

    const result = await service.executeCommand({ type: 'traffic' })

    expect(result.ok).toBe(true)
    expect(result.message).toBe('BeamNG traffic autopilot is active.')
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('restarts a stale bridge when health is missing new command support', async () => {
    const configService = {
      load: vi.fn().mockResolvedValue(createConfig()),
      save: vi.fn(),
      detectInstalls: vi.fn(),
      resolvePreferredInstall: vi.fn().mockResolvedValue({
        source: 'config',
        path: 'C:\\Games\\BeamNG.drive',
        exePath: 'C:\\Games\\BeamNG.drive\\Bin64\\BeamNG.drive.x64.exe',
        valid: true,
        detail: 'ok',
      }),
    }
    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    }

    let healthChecks = 0
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        healthChecks += 1
        if (healthChecks === 1) {
          return {
            ok: true,
            json: vi.fn().mockResolvedValue({
              ok: true,
              bridgeStatus: 'ready',
              pythonStatus: 'ready',
              beamngpyInstalled: true,
              bridgeVersion: '1',
              supportedCommands: ['traffic', 'stop', 'disable', 'lane_on', 'lane_off', 'go_to_place'],
            }),
          }
        }

        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            ok: true,
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            beamngpyInstalled: true,
              bridgeVersion: '3',
              supportedCommands: [
                'traffic',
                'aggressive_traffic',
                'random',
                'span',
                'stop',
                'disable',
                'lane_on',
                'lane_off',
                'go_to_place',
              ],
            }),
          }
        }

      if (url.endsWith('/connect')) {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            installStatus: 'valid',
            installPath: 'C:\\Games\\BeamNG.drive',
            connected: true,
            gameRunning: true,
            detail: 'Connected to BeamNG.',
            vehicleId: 'ego',
          }),
        }
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const kill = vi.fn()
    const spawnImpl = vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      once: vi.fn(),
      kill,
    })
    const execFileImpl = vi
      .fn()
      .mockImplementation((_command, args, _options, callback) => {
        if (Array.isArray(args) && args.includes('--version')) {
          callback(null, 'Python 3.11.0', '')
          return
        }

        callback(null, '', '')
      })

    const service = new BeamngRuntimeService(
      'E:\\project\\friday',
      configService as never,
      logger as never,
      { resolveBeamngIntent: vi.fn() } as never,
      {
        fetchImpl: fetchImpl as never,
        spawnImpl: spawnImpl as never,
        execFileImpl: execFileImpl as never,
      },
    )

    const state = await service.connect()

    expect(state.connected).toBe(true)
    expect(logger.info).toHaveBeenCalledWith('Replacing stale BeamNG bridge process after compatibility check.')
  })

  it('installs BeamNG Python dependencies and refreshes the bridge state', async () => {
    const configService = {
      load: vi.fn().mockResolvedValue(createConfig()),
      save: vi.fn(),
      detectInstalls: vi.fn(),
      resolvePreferredInstall: vi.fn().mockResolvedValue({
        source: 'config',
        path: 'C:\\Games\\BeamNG.drive',
        exePath: 'C:\\Games\\BeamNG.drive\\Bin64\\BeamNG.drive.x64.exe',
        valid: true,
        detail: 'ok',
      }),
    }
    const logger = {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    }
    let healthChecks = 0
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        healthChecks += 1
        if (healthChecks === 1) {
          throw new Error('offline')
        }

        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            ok: true,
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            installStatus: 'valid',
            installPath: 'C:\\Games\\BeamNG.drive',
            connected: false,
            gameRunning: false,
            detail: 'BeamNG bridge ready.',
            beamngpyInstalled: true,
          }),
        }
      }

      if (url.endsWith('/state')) {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            installStatus: 'valid',
            installPath: 'C:\\Games\\BeamNG.drive',
            connected: false,
            gameRunning: false,
            detail: 'BeamNG bridge ready.',
            beamngpyInstalled: true,
          }),
        }
      }

      throw new Error(`Unexpected fetch call: ${url}`)
    })
    const spawnImpl = vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      once: vi.fn(),
      kill: vi.fn(),
    })
    const execFileImpl = vi
      .fn()
      .mockImplementationOnce((_command, _args, _options, callback) => callback(null, 'Python 3.11.0', ''))
      .mockImplementationOnce((_command, _args, _options, callback) => callback(null, 'pip 24.0', ''))
      .mockImplementationOnce((_command, _args, _options, callback) => callback(null, 'installed', ''))

    const service = new BeamngRuntimeService(
      'E:\\project\\friday',
      configService as never,
      logger as never,
      { resolveBeamngIntent: vi.fn() } as never,
      {
        fetchImpl: fetchImpl as never,
        spawnImpl: spawnImpl as never,
        execFileImpl: execFileImpl as never,
      },
    )

    const result = await service.installDependencies()

    expect(result.ok).toBe(true)
    expect(result.detail).toBe('BeamNG Python dependencies are installed.')
    expect(execFileImpl).toHaveBeenCalledTimes(3)
  })
})
