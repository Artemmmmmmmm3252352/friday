import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BeamngConfig, BeamngDetectedInstall } from '@contracts'
import { createDefaultBeamngConfig, normalizeBeamngConfig } from '../../src/shared/beamng'

export class BeamngConfigService {
  private readonly configPath: string

  constructor(userDataPath: string) {
    this.configPath = path.join(userDataPath, 'state', 'beamng-config.json')
  }

  async load(): Promise<BeamngConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<BeamngConfig>
      return normalizeBeamngConfig(parsed)
    } catch {
      return createDefaultBeamngConfig()
    }
  }

  async save(config: BeamngConfig): Promise<BeamngConfig> {
    const normalized = normalizeBeamngConfig(config)
    await mkdir(path.dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return normalized
  }

  async detectInstalls(config: BeamngConfig | null = null): Promise<BeamngDetectedInstall[]> {
    const effectiveConfig = config ?? (await this.load())
    const candidates = buildInstallCandidates(effectiveConfig.gamePath)
    const seen = new Set<string>()
    const detected: BeamngDetectedInstall[] = []

    for (const candidate of candidates) {
      const normalizedPath = candidate.path.trim().replace(/[\\/]+$/, '')
      if (!normalizedPath) {
        continue
      }

      const dedupeKey = normalizedPath.toLowerCase()
      if (seen.has(dedupeKey)) {
        continue
      }
      seen.add(dedupeKey)
      detected.push(await validateInstallCandidate(candidate.source, normalizedPath))
    }

    return detected
  }

  async resolvePreferredInstall(config: BeamngConfig | null = null): Promise<BeamngDetectedInstall | null> {
    const installs = await this.detectInstalls(config)
    if (installs.length === 0) {
      return null
    }

    return installs.find((entry) => entry.valid) ?? installs[0]
  }
}

type InstallSource = BeamngDetectedInstall['source']

function buildInstallCandidates(configPath: string): Array<{ source: InstallSource; path: string }> {
  const candidates: Array<{ source: InstallSource; path: string }> = []

  if (configPath.trim()) {
    candidates.push({ source: 'config', path: configPath })
  }

  if (process.env.BNG_HOME?.trim()) {
    candidates.push({ source: 'env', path: process.env.BNG_HOME })
  }

  for (const candidatePath of getSteamCandidates()) {
    candidates.push({ source: 'steam', path: candidatePath })
  }

  for (const candidatePath of getStandardCandidates()) {
    candidates.push({ source: 'standard', path: candidatePath })
  }

  return candidates
}

function getSteamCandidates(): string[] {
  const driveLetters = ['C', 'D', 'E', 'F', 'G', 'H']
  const roots = new Set<string>()
  const envRoots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => path.join(value, 'Steam'))

  for (const envRoot of envRoots) {
    roots.add(envRoot)
  }

  for (const driveLetter of driveLetters) {
    roots.add(`${driveLetter}:\\Steam`)
    roots.add(`${driveLetter}:\\SteamLibrary`)
    roots.add(`${driveLetter}:\\Games\\Steam`)
  }

  return [...roots].flatMap((root) => [
    path.join(root, 'steamapps', 'common', 'BeamNG.drive'),
    path.join(root, 'steamapps', 'common', 'BeamNG.tech'),
  ])
}

function getStandardCandidates(): string[] {
  const driveLetters = ['C', 'D', 'E', 'F', 'G', 'H']
  return driveLetters.flatMap((driveLetter) => [
    `${driveLetter}:\\Games\\BeamNG.drive`,
    `${driveLetter}:\\BeamNG.drive`,
    `${driveLetter}:\\Games\\BeamNG.tech`,
  ])
}

async function validateInstallCandidate(source: InstallSource, installPath: string): Promise<BeamngDetectedInstall> {
  const exePath = path.join(installPath, 'Bin64', 'BeamNG.drive.x64.exe')
  const valid = (await pathExists(installPath)) && (await pathExists(exePath))

  return {
    source,
    path: installPath,
    exePath,
    valid,
    detail: valid ? 'BeamNG.drive executable found.' : 'BeamNG.drive.x64.exe was not found under Bin64.',
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}
