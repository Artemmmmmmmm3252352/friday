import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

import type {
  AppLanguage,
  BeamngCommandInput,
  BeamngCommandResult,
  BeamngConfig,
  BeamngDependencyInstallResult,
  BeamngSavedPlace,
  BeamngState,
  BeamngTextCommandResolution,
  BeamngWaypoint,
} from '@contracts'
import {
  buildBeamngIntentPrompt,
  createDefaultBeamngConfig,
  parseBeamngIntentReply,
  parseDeterministicBeamngCommand,
} from '../../src/shared/beamng'
import { FridayLogger } from './logger'
import { BeamngConfigService } from './beamngConfigService'
import { OpenClawService } from './openclawService'

const BRIDGE_HOST = '127.0.0.1'
const BRIDGE_PORT = 32145
const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`
const BRIDGE_VERSION = '3'
const REQUIRED_BRIDGE_COMMANDS = [
  'traffic',
  'aggressive_traffic',
  'random',
  'span',
  'stop',
  'disable',
  'lane_on',
  'lane_off',
  'go_to_place',
]
const BRIDGE_START_TIMEOUT_MS = 25_000
const BRIDGE_CONNECT_TIMEOUT_MS = 25_000
const BRIDGE_COMMAND_TIMEOUT_MS = 20_000
const PYTHON_INSTALL_TIMEOUT_MS = 300_000

type PythonTarget = {
  command: string
  argsPrefix: string[]
  displayName: string
}

type BeamngRuntimeDeps = {
  fetchImpl?: typeof fetch
  spawnImpl?: typeof spawn
  execFileImpl?: typeof execFile
}

type BridgeStatePayload = {
  bridgeStatus?: BeamngState['bridgeStatus']
  pythonStatus?: BeamngState['pythonStatus']
  installStatus?: BeamngState['installStatus']
  installPath?: string | null
  gameRunning?: boolean
  connected?: boolean
  activeMode?: string | null
  driveInLane?: boolean | null
  lastResolvedPlace?: string | null
  lastError?: string | null
  detail?: string
  vehicleId?: string | null
  beamngpyInstalled?: boolean
  bridgeVersion?: string
  supportedCommands?: string[]
  ok?: boolean
}

export class BeamngRuntimeService {
  private bridgeProcess: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private pythonTarget: PythonTarget | null = null
  private readonly appBasePath: string
  private readonly configService: BeamngConfigService
  private readonly logger: FridayLogger
  private readonly openClawService: OpenClawService
  private readonly fetchImpl: typeof fetch
  private readonly spawnImpl: typeof spawn
  private readonly execFileImpl: typeof execFile
  private state: BeamngState = createDefaultBeamngState()

  constructor(
    appBasePath: string,
    configService: BeamngConfigService,
    logger: FridayLogger,
    openClawService: OpenClawService,
    deps: BeamngRuntimeDeps = {},
  ) {
    this.appBasePath = appBasePath
    this.configService = configService
    this.logger = logger
    this.openClawService = openClawService
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.spawnImpl = deps.spawnImpl ?? spawn
    this.execFileImpl = deps.execFileImpl ?? execFile
  }

  async getConfig(): Promise<BeamngConfig> {
    return this.configService.load()
  }

  async saveConfig(config: BeamngConfig): Promise<BeamngConfig> {
    const saved = await this.configService.save(config)
    await this.refreshState()
    return saved
  }

  async detectInstalls() {
    const config = await this.configService.load()
    return this.configService.detectInstalls(config)
  }

  async installDependencies(): Promise<BeamngDependencyInstallResult> {
    try {
      const python = await this.findPythonTarget()
      const requirementsPath = await this.resolveRequirementsPath()

      this.state = {
        ...this.state,
        pythonStatus: 'ready',
        lastError: null,
        detail: 'Installing BeamNG Python dependencies.',
      }

      await this.ensurePipAvailable(python)
      await this.logger.info(`Installing BeamNG Python dependencies from ${requirementsPath}`)
      await execFileText(
        this.execFileImpl,
        python.command,
        [...python.argsPrefix, '-m', 'pip', 'install', '-r', requirementsPath],
        {
          cwd: path.dirname(requirementsPath),
          timeout: PYTHON_INSTALL_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        },
      )

      await this.stop()
      try {
        await this.ensureBridgeRunning()
      } catch (error) {
        await this.logger.error(
          `BeamNG bridge restart after dependency install failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const state = await this.refreshState()
      const detail = 'BeamNG Python dependencies are installed.'
      this.state = {
        ...state,
        lastError: null,
        detail,
      }

      return {
        ok: true,
        detail,
        state: this.state,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.state = {
        ...this.state,
        pythonStatus: this.state.pythonStatus === 'ready' ? 'error' : this.state.pythonStatus,
        lastError: detail,
        detail,
      }

      await this.logger.error(`BeamNG dependency install failed: ${detail}`)
      return {
        ok: false,
        detail,
        state: this.state,
      }
    }
  }

  async getState(): Promise<BeamngState> {
    return this.refreshState()
  }

  async connect(): Promise<BeamngState> {
    const config = await this.configService.load()
    const install = await this.configService.resolvePreferredInstall(config)
    if (!install || !install.valid) {
      this.state = {
        ...this.state,
        bridgeStatus: 'error',
        installStatus: install ? 'invalid' : 'missing',
        installPath: install?.path ?? null,
        connected: false,
        gameRunning: false,
        lastError: install?.detail ?? 'BeamNG installation path is not configured.',
        detail: install?.detail ?? 'BeamNG installation path is not configured.',
      }
      return this.state
    }

    try {
      await this.ensureBridgeRunning()
      const payload = await this.postJson<BridgeStatePayload>(
        '/connect',
        {
          gamePath: install.path,
          autoLaunch: config.autoLaunch,
          defaultVehicleId: config.defaultVehicleId,
        },
        BRIDGE_CONNECT_TIMEOUT_MS,
      )

      this.state = mergeBridgeState(this.state, payload, install.path)
      return this.state
    } catch (error) {
      const detail = await this.describeBridgeRequestError(
        error,
        'BeamNG connect timed out before the bridge returned a result.',
      )
      this.state = {
        ...this.state,
        bridgeStatus: 'error',
        installStatus: install.valid ? 'valid' : 'invalid',
        installPath: install.path,
        connected: false,
        gameRunning: this.state.gameRunning,
        lastError: detail,
        detail,
      }
      return this.state
    }
  }

  async disconnect(): Promise<BeamngState> {
    if (!(await this.isBridgeReachable())) {
      this.state = {
        ...this.state,
        connected: false,
        gameRunning: false,
        bridgeStatus: this.state.bridgeStatus === 'error' ? 'error' : 'stopped',
        detail: 'BeamNG bridge is offline.',
      }
      return this.state
    }

    const payload = await this.postJson<BridgeStatePayload>('/disconnect', {})
    this.state = mergeBridgeState(this.state, payload, this.state.installPath)
    return this.state
  }

  async listWaypoints(): Promise<BeamngWaypoint[]> {
    await this.ensureBridgeRunning()
    const payload = await this.getJson<{ waypoints?: BeamngWaypoint[] }>('/waypoints')
    return Array.isArray(payload.waypoints) ? payload.waypoints : []
  }

  async resolveTextCommand(text: string, language: AppLanguage): Promise<BeamngTextCommandResolution> {
    const config = normalizeConfig(await this.configService.load())
    const deterministic = parseDeterministicBeamngCommand(text, config)
    if (deterministic.matched || !deterministic.isBeamngRelated) {
      return deterministic
    }

    try {
      const prompt = buildBeamngIntentPrompt(text, language, config.savedPlaces)
      const replyText = await this.openClawService.resolveBeamngIntent(prompt)
      return parseBeamngIntentReply(replyText, config)
    } catch (error) {
      await this.logger.error(
        `BeamNG intent fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return deterministic
    }
  }

  async executeCommand(command: BeamngCommandInput): Promise<BeamngCommandResult> {
    const config = normalizeConfig(await this.configService.load())
    const connectState = await this.connect()
    if (!connectState.connected) {
      return {
        ok: false,
        command,
        message: connectState.lastError || connectState.detail,
        state: connectState,
      }
    }

    let place: BeamngSavedPlace | null = null
    if (command.type === 'go_to_place') {
      place = config.savedPlaces.find((candidate) => candidate.id === command.placeId) ?? null
      if (!place) {
        const message = 'The saved destination is missing from BeamNG settings.'
        this.state = {
          ...this.state,
          lastError: message,
          detail: message,
        }
        return { ok: false, command, message, state: this.state }
      }
    }

    const requestBody = {
      command,
      waypointId: place?.waypointId ?? null,
      placeName: place?.name ?? null,
    }

    let payload = await this.postJson<BridgeStatePayload>('/command', requestBody, BRIDGE_COMMAND_TIMEOUT_MS)
    if ((payload.lastError ?? '').includes('Unsupported command type.')) {
      await this.logger.info('Restarting stale BeamNG bridge after unsupported command response.')
      await this.forceRestartBridgeProcess()
      await this.ensureBridgeRunning()
      await this.connect()
      payload = await this.postJson<BridgeStatePayload>('/command', requestBody, BRIDGE_COMMAND_TIMEOUT_MS)
    }

    this.state = mergeBridgeState(this.state, payload, this.state.installPath)
    const ok = !this.state.lastError
    return {
      ok,
      command,
      message: payload.detail || (ok ? buildSuccessMessage(command, place?.name) : this.state.lastError || 'BeamNG command failed.'),
      state: this.state,
      place: place ?? undefined,
    }
  }

  async stop(): Promise<void> {
    if (!this.bridgeProcess) {
      return
    }

    const bridgeProcess = this.bridgeProcess
    this.bridgeProcess = null
    bridgeProcess.kill()
    this.state = {
      ...this.state,
      bridgeStatus: 'stopped',
      connected: false,
      gameRunning: false,
      detail: 'BeamNG bridge stopped.',
    }
  }

  private async refreshState(): Promise<BeamngState> {
    const config = await this.configService.load()
    const install = await this.configService.resolvePreferredInstall(config)
    let nextState: BeamngState = {
      ...this.state,
      installStatus: install ? (install.valid ? 'valid' : 'invalid') : 'missing',
      installPath: install?.path ?? null,
      detail:
        this.state.detail ||
        install?.detail ||
        (config.gamePath ? 'BeamNG install path is invalid.' : 'BeamNG install path is not configured.'),
    }

    const pythonTarget = await this.findPythonTarget().catch(() => null)
    nextState = {
      ...nextState,
      pythonStatus: pythonTarget ? 'ready' : 'missing',
    }

    if (await this.isBridgeReachable()) {
      try {
        const payload = await this.getJson<BridgeStatePayload>('/state')
        nextState = mergeBridgeState(nextState, payload, install?.path ?? nextState.installPath)
      } catch (error) {
        nextState = {
          ...nextState,
          bridgeStatus: 'error',
          lastError: error instanceof Error ? error.message : String(error),
          detail: 'BeamNG bridge state refresh failed.',
        }
      }
    } else {
      nextState = {
        ...nextState,
        bridgeStatus: this.bridgeProcess ? 'starting' : 'stopped',
        connected: false,
        gameRunning: false,
      }
    }

    this.state = nextState
    return nextState
  }

  private async ensureBridgeRunning(): Promise<void> {
    const health = await this.getBridgeHealth()
    if (health?.ok) {
      if (await this.shouldReplaceStaleBridge(health)) {
        await this.logger.info('Replacing stale BeamNG bridge process after compatibility check.')
        await this.forceRestartBridgeProcess()
      } else {
        this.state = {
          ...this.state,
          bridgeStatus: 'ready',
        }
        return
      }
    }

    if (await this.isBridgeReachable()) {
      this.state = {
        ...this.state,
        bridgeStatus: 'ready',
      }
      return
    }

    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.startBridge().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startBridge(): Promise<void> {
    const python = await this.findPythonTarget()
    const bridgeScriptPath = await this.resolveBridgeScriptPath()

    if (!this.bridgeProcess) {
      await this.logger.info(`Starting BeamNG bridge with ${python.displayName} from ${bridgeScriptPath}`)
      this.state = {
        ...this.state,
        bridgeStatus: 'starting',
        pythonStatus: 'ready',
        detail: 'Starting BeamNG bridge.',
      }

      this.bridgeProcess = this.spawnImpl(python.command, [...python.argsPrefix, bridgeScriptPath], {
        cwd: path.dirname(bridgeScriptPath),
        windowsHide: true,
        stdio: 'pipe',
        env: {
          ...process.env,
          FRIDAY_BEAMNG_HOST: BRIDGE_HOST,
          FRIDAY_BEAMNG_PORT: String(BRIDGE_PORT),
        },
      })

      this.bridgeProcess.stdout.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) {
          void this.logger.info(`[beamng-bridge] ${text}`)
        }
      })
      this.bridgeProcess.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) {
          void this.logger.error(`[beamng-bridge] ${text}`)
        }
      })
      this.bridgeProcess.once('exit', (code) => {
        void this.logger.info(`BeamNG bridge exited with code ${code ?? 'unknown'}`)
        this.bridgeProcess = null
      })
    }

    const timeoutAt = Date.now() + BRIDGE_START_TIMEOUT_MS
    while (Date.now() < timeoutAt) {
      if (await this.isBridgeReachable()) {
        this.state = {
          ...this.state,
          bridgeStatus: 'ready',
          pythonStatus: 'ready',
          detail: 'BeamNG bridge is ready.',
        }
        return
      }

      if (!this.bridgeProcess) {
        break
      }

      await delay(400)
    }

    this.state = {
      ...this.state,
      bridgeStatus: 'error',
      lastError: 'BeamNG bridge did not become ready in time.',
      detail: 'BeamNG bridge did not become ready in time.',
    }
    throw new Error(this.state.lastError ?? 'BeamNG bridge did not become ready in time.')
  }

  private async findPythonTarget(): Promise<PythonTarget> {
    if (this.pythonTarget) {
      return this.pythonTarget
    }

    for (const candidatePath of [
      typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'portable-python', 'python.exe') : null,
      path.join(process.cwd(), 'vendor', 'portable-python', 'python.exe'),
    ].filter((candidate): candidate is string => Boolean(candidate))) {
      if (await pathExists(candidatePath)) {
        const candidate = { command: candidatePath, argsPrefix: [], displayName: 'bundled portable Python' }
        const ok = await this.checkPythonCandidate(candidate)
        if (ok) {
          this.pythonTarget = candidate
          return candidate
        }
      }
    }

    for (const candidate of [
      { command: 'py', argsPrefix: ['-3'], displayName: 'py -3' },
      { command: 'python', argsPrefix: [], displayName: 'python' },
      { command: 'python3', argsPrefix: [], displayName: 'python3' },
    ]) {
      const ok = await this.checkPythonCandidate(candidate)
      if (ok) {
        this.pythonTarget = candidate
        return candidate
      }
    }

    throw new Error('Python 3 was not found. Install Python and the beamngpy package first.')
  }

  private async checkPythonCandidate(candidate: PythonTarget): Promise<boolean> {
    try {
      await execFileText(this.execFileImpl, candidate.command, [...candidate.argsPrefix, '--version'])
      return true
    } catch {
      return false
    }
  }

  private async resolveBridgeScriptPath(): Promise<string> {
    const candidates = [
      path.join(this.appBasePath, 'beamng-bridge', 'server.py'),
      path.join(process.cwd(), 'beamng-bridge', 'server.py'),
      typeof process.resourcesPath === 'string'
        ? path.join(process.resourcesPath, 'beamng-bridge', 'server.py')
        : null,
    ].filter((candidate): candidate is string => Boolean(candidate))

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate
      }
    }

    throw new Error('BeamNG bridge script was not found.')
  }

  private async resolveRequirementsPath(): Promise<string> {
    const candidates = [
      path.join(this.appBasePath, 'beamng-bridge', 'requirements.txt'),
      path.join(process.cwd(), 'beamng-bridge', 'requirements.txt'),
      typeof process.resourcesPath === 'string'
        ? path.join(process.resourcesPath, 'beamng-bridge', 'requirements.txt')
        : null,
    ].filter((candidate): candidate is string => Boolean(candidate))

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate
      }
    }

    throw new Error('BeamNG requirements.txt was not found.')
  }

  private async ensurePipAvailable(python: PythonTarget): Promise<void> {
    try {
      await execFileText(this.execFileImpl, python.command, [...python.argsPrefix, '-m', 'pip', '--version'])
      return
    } catch {
      await this.logger.info(`pip is missing for ${python.displayName}; trying ensurepip.`)
    }

    await execFileText(
      this.execFileImpl,
      python.command,
      [...python.argsPrefix, '-m', 'ensurepip', '--upgrade'],
      {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    await execFileText(this.execFileImpl, python.command, [...python.argsPrefix, '-m', 'pip', '--version'])
  }

  private async isBridgeReachable(): Promise<boolean> {
    const health = await this.getBridgeHealth()
    return Boolean(health?.ok)
  }

  private async getBridgeHealth(): Promise<BridgeStatePayload | null> {
    try {
      const response = await this.fetchImpl(`${BRIDGE_URL}/health`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) {
        return null
      }

      return (await response.json()) as BridgeStatePayload
    } catch {
      return null
    }
  }

  private async shouldReplaceStaleBridge(health: BridgeStatePayload): Promise<boolean> {
    if (health.bridgeVersion !== BRIDGE_VERSION) {
      return true
    }

    const supportedCommands = Array.isArray(health.supportedCommands) ? health.supportedCommands : []
    if (REQUIRED_BRIDGE_COMMANDS.some((command) => !supportedCommands.includes(command))) {
      return true
    }

    if (health.beamngpyInstalled !== false) {
      return false
    }

    try {
      const python = await this.findPythonTarget()
      return await this.checkBeamngpyImport(python)
    } catch {
      return false
    }
  }

  private async checkBeamngpyImport(python: PythonTarget): Promise<boolean> {
    try {
      await execFileText(this.execFileImpl, python.command, [...python.argsPrefix, '-c', 'import beamngpy'])
      return true
    } catch {
      return false
    }
  }

  private async forceRestartBridgeProcess(): Promise<void> {
    await this.stop()
    await this.killBridgeProcesses()
    await delay(500)
  }

  private async killBridgeProcesses(): Promise<void> {
    const script = [
      "Get-CimInstance Win32_Process",
      " | Where-Object {",
      "    ($_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe') -and",
      "    $_.CommandLine -like '*beamng-bridge\\server.py*'",
      ' }',
      ' | ForEach-Object {',
      '    Stop-Process -Id $_.ProcessId -Force',
      ' }',
    ].join(' ')

    try {
      await execFileText(this.execFileImpl, 'powershell', ['-NoProfile', '-Command', script], {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
      })
    } catch (error) {
      await this.logger.error(
        `Failed to terminate stale BeamNG bridge processes: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async getJson<T>(pathname: string): Promise<T> {
    const response = await this.fetchImpl(`${BRIDGE_URL}${pathname}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      throw new Error(await safeErrorMessage(response))
    }

    return (await response.json()) as T
  }

  private async postJson<T>(pathname: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const response = await this.fetchImpl(`${BRIDGE_URL}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(await safeErrorMessage(response))
    }

    return (await response.json()) as T
  }

  private async describeBridgeRequestError(error: unknown, fallback: string): Promise<string> {
    if (isAbortTimeoutError(error)) {
      try {
        const state = await this.getJson<BridgeStatePayload>('/state')
        return state.lastError || state.detail || fallback
      } catch {
        return fallback
      }
    }

    return error instanceof Error && error.message ? error.message : fallback
  }
}

function normalizeConfig(config: BeamngConfig) {
  return {
    ...createDefaultBeamngConfig(),
    ...config,
  }
}

function createDefaultBeamngState(): BeamngState {
  return {
    bridgeStatus: 'stopped',
    pythonStatus: 'missing',
    installStatus: 'missing',
    installPath: null,
    gameRunning: false,
    connected: false,
    activeMode: null,
    driveInLane: null,
    lastResolvedPlace: null,
    lastError: null,
    detail: 'BeamNG is not configured.',
    vehicleId: null,
  }
}

function mergeBridgeState(current: BeamngState, payload: BridgeStatePayload, installPath: string | null): BeamngState {
  const bridgeStatus = payload.bridgeStatus ?? (payload.connected ? 'ready' : current.bridgeStatus)
  const pythonStatus =
    payload.pythonStatus ?? (payload.beamngpyInstalled === false ? 'error' : current.pythonStatus)
  const installStatus = payload.installStatus ?? current.installStatus

  return {
    bridgeStatus,
    pythonStatus,
    installStatus,
    installPath: payload.installPath ?? installPath,
    gameRunning: payload.gameRunning ?? current.gameRunning,
    connected: payload.connected ?? current.connected,
    activeMode: payload.activeMode ?? current.activeMode,
    driveInLane:
      typeof payload.driveInLane === 'boolean' || payload.driveInLane === null
        ? payload.driveInLane
        : current.driveInLane,
    lastResolvedPlace: payload.lastResolvedPlace ?? current.lastResolvedPlace,
    lastError: payload.lastError ?? null,
    detail: payload.detail ?? current.detail,
    vehicleId: payload.vehicleId ?? current.vehicleId,
  }
}

function buildSuccessMessage(command: BeamngCommandInput, placeName?: string): string {
  switch (command.type) {
    case 'traffic':
      return 'BeamNG traffic autopilot is active.'
    case 'aggressive_traffic':
      return 'BeamNG AI is driving in aggressive traffic mode.'
    case 'random':
      return 'BeamNG AI is roaming the map using random destinations.'
    case 'span':
      return 'BeamNG AI is driving across the road network.'
    case 'stop':
      return 'BeamNG AI is bringing the vehicle to a stop.'
    case 'disable':
      return 'BeamNG AI was disabled.'
    case 'lane_on':
      return 'BeamNG AI will keep lane discipline while driving.'
    case 'lane_off':
      return 'BeamNG AI can now leave the lane when needed.'
    case 'go_to_place':
      return placeName ? `BeamNG AI is driving to ${placeName}.` : 'BeamNG AI is driving to the selected place.'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; detail?: string }
    return payload.error || payload.detail || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function execFileText(
  execFileImpl: typeof execFile,
  command: string,
  args: string[],
  options: {
    cwd?: string
    timeout?: number
    maxBuffer?: number
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      command,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }

        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout),
          stderr: typeof stderr === 'string' ? stderr : String(stderr),
        })
      },
    )
  })
}

function isAbortTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      /aborted due to timeout/i.test(error.message) ||
      /timeout/i.test(error.message))
  )
}
