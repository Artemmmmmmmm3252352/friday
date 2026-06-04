import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BeamngConfigService } from './beamngConfigService'

afterEach(async () => {
  delete process.env.BNG_HOME
})

describe('BeamngConfigService', () => {
  it('loads the default config when the file is missing', async () => {
    const userDataPath = path.join(os.tmpdir(), `friday-beamng-config-${crypto.randomUUID()}`)
    const service = new BeamngConfigService(userDataPath)

    await expect(service.load()).resolves.toEqual({
      gamePath: '',
      autoLaunch: false,
      defaultVehicleId: 'ego',
      savedPlaces: [],
    })
  })

  it('detects installs from BNG_HOME', async () => {
    const userDataPath = path.join(os.tmpdir(), `friday-beamng-config-${crypto.randomUUID()}`)
    const installPath = path.join(userDataPath, 'BeamNG.drive')
    await mkdir(path.join(installPath, 'Bin64'), { recursive: true })
    await writeFile(path.join(installPath, 'Bin64', 'BeamNG.drive.x64.exe'), '')
    process.env.BNG_HOME = installPath

    const service = new BeamngConfigService(userDataPath)
    const installs = await service.detectInstalls()

    expect(installs.some((entry) => entry.source === 'env' && entry.valid && entry.path === installPath)).toBe(true)
  })
})
