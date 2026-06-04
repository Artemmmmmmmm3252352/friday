import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

import type { DiagnosticItem, VoiceRuntimeConfig, VoiceRuntimeEvent, VoiceSpeakInput } from '@contracts'

import { FridayLogger } from './logger'

const DEFAULT_CONFIG: VoiceRuntimeConfig = {
  ambientEnabled: false,
  wakeWord: 'пятница',
  wakeAliases: ['friday', 'фрайдей', 'пятница', 'пятницу', 'пятница ответь'],
  wakeFuzzyRatio: 0.78,
  hotWindowSeconds: 3,
  sttModel: 'small',
  whisperDevice: 'cpu',
  whisperComputeType: 'int8',
  ttsVoice: 'M1',
  ttsLanguage: 'na',
  ttsSpeed: 1.05,
  ollamaUrl: 'http://127.0.0.1:11434',
  intentJudgeModel: '',
}

const SUPERTONIC_HOST = '127.0.0.1'
const SUPERTONIC_PORT = 7788
const SUPERTONIC_MODEL = 'supertonic-3'
const SUPERTONIC_BASE_URL = `http://${SUPERTONIC_HOST}:${SUPERTONIC_PORT}`

type PythonCommand = {
  command: string
  args: string[]
}

export class VoiceRuntimeService {
  private readonly runtimeDir: string
  private readonly configPath: string
  private readonly venvDir: string
  private process: ChildProcessWithoutNullStreams | null = null
  private ttsServerProcess: ChildProcessWithoutNullStreams | null = null
  private lastEvent: VoiceRuntimeEvent | null = null
  private readonly logger: FridayLogger
  private readonly emitEvent: (event: VoiceRuntimeEvent) => void

  constructor(
    appRoot: string,
    userDataPath: string,
    logger: FridayLogger,
    emitEvent: (event: VoiceRuntimeEvent) => void,
  ) {
    this.runtimeDir = path.basename(appRoot) === 'voice-runtime' ? appRoot : path.join(appRoot, 'voice-runtime')
    this.configPath = path.join(userDataPath, 'state', 'voice-runtime.json')
    this.venvDir = path.join(userDataPath, 'voice-runtime', '.venv')
    this.logger = logger
    this.emitEvent = emitEvent
  }

  async getConfig(): Promise<VoiceRuntimeConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const normalized = normalizeConfig(JSON.parse(raw) as Partial<VoiceRuntimeConfig>)
      await this.saveConfig(normalized)
      return normalized
    } catch {
      return DEFAULT_CONFIG
    }
  }

  async saveConfig(config: VoiceRuntimeConfig): Promise<VoiceRuntimeConfig> {
    const normalized = normalizeConfig(config)
    await mkdir(path.dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return normalized
  }

  async installRuntime(): Promise<{ ok: boolean; detail: string }> {
    const python = await this.resolvePythonCommand(false)
    const pythonEnv = createPythonEnv()
    await this.shutdownRuntimeProcesses()
    await this.removeVenvWithRetries()
    await runCommand(python.command, [...python.args, '-m', 'venv', this.venvDir], this.runtimeDir, pythonEnv)
    const venvPython = await this.resolvePythonCommand(true)
    const pipArgs = ['-m', 'pip', '--isolated', '--no-cache-dir', '--timeout', '60', '--retries', '10']
    await runCommand(venvPython.command, [...venvPython.args, ...pipArgs, 'install', '--upgrade', 'pip'], this.runtimeDir, pythonEnv)
    await runCommand(
      venvPython.command,
      [...venvPython.args, ...pipArgs, 'install', '-r', path.join(this.runtimeDir, 'requirements.txt')],
      this.runtimeDir,
      pythonEnv,
    )
    await this.assertRuntimePackages(venvPython)
    return { ok: true, detail: 'Voice runtime dependencies installed.' }
  }

  async startAmbient(): Promise<{ ok: boolean }> {
    const config = await this.saveConfig({ ...(await this.getConfig()), ambientEnabled: true })
    await this.ensureProcess({ ensureTts: true })
    this.send({ type: 'start', config })
    return { ok: true }
  }

  async stopAmbient(): Promise<{ ok: boolean }> {
    await this.saveConfig({ ...(await this.getConfig()), ambientEnabled: false })
    this.send({ type: 'stop' })
    return { ok: true }
  }

  async speak(input: VoiceSpeakInput): Promise<{ ok: boolean }> {
    await this.ensureProcess({ ensureTts: true })
    if (input.interrupt) {
      this.send({ type: 'interrupt' })
    }
    this.send({ type: 'speak', text: input.text })
    return { ok: true }
  }

  async interrupt(): Promise<{ ok: boolean }> {
    this.send({ type: 'interrupt' })
    return { ok: true }
  }

  async getDiagnostics(): Promise<DiagnosticItem> {
    if (!existsSync(this.runtimeDir)) {
      return {
        label: 'Voice runtime',
        status: 'error',
        detail: `Voice runtime is missing at ${this.runtimeDir}.`,
      }
    }

    if (this.process) {
      return {
        label: 'Voice runtime',
        status: this.lastEvent?.event === 'error' ? 'warning' : 'ready',
        detail: this.lastEvent?.event === 'error' ? this.lastEvent.detail : 'Ambient voice sidecar is running.',
      }
    }

    return {
      label: 'Voice runtime',
      status: existsSync(path.join(this.venvDir, 'Scripts', 'python.exe')) ? 'ready' : 'warning',
      detail: existsSync(path.join(this.venvDir, 'Scripts', 'python.exe'))
        ? 'Voice dependencies are installed. Ambient mode is off.'
        : 'Voice dependencies are not installed yet.',
    }
  }

  dispose(): void {
    this.process?.kill()
    this.process = null
    this.ttsServerProcess?.kill()
    this.ttsServerProcess = null
  }

  private async ensureProcess(options: { ensureTts?: boolean } = {}): Promise<void> {
    if (this.process && !this.process.killed) {
      if (options.ensureTts) {
        const python = await this.resolvePythonCommand(true)
        await this.ensureSupertonicServer(python)
      }
      return
    }

    if (!(await this.isPreferredVenvReady())) {
      await this.installRuntime()
    }

    const python = await this.resolvePythonCommand(true)
    await this.assertRuntimePackages(python)
    if (options.ensureTts) {
      await this.ensureSupertonicServer(python)
    }
    const child = spawn(python.command, [...python.args, '-m', 'friday_voice.sidecar'], {
      cwd: this.runtimeDir,
      env: {
        ...createPythonEnv(),
        PYTHONUTF8: '1',
        SUPERTONIC_BASE_URL,
        SUPERTONIC_MODEL,
      },
      windowsHide: true,
    })
    this.process = child

    const stdout = readline.createInterface({ input: child.stdout })
    stdout.on('line', (line) => this.handleSidecarLine(line))
    child.stderr.on('data', (chunk) => {
      const detail = String(chunk).trim()
      void this.logger.error(`Voice runtime stderr: ${detail}`)
      if (detail) {
        this.emitRuntimeDiagnostic('warning', detail.slice(0, 500))
      }
    })
    child.on('exit', (code) => {
      this.process = null
      const event: VoiceRuntimeEvent = {
        event: 'diagnostics',
        timestamp: Date.now() / 1000,
        status: 'warning',
        detail: `Voice runtime exited with code ${code ?? 'unknown'}.`,
      }
      this.lastEvent = event
      this.emitEvent(event)
    })
  }

  private async ensureSupertonicServer(python: PythonCommand): Promise<void> {
    if (await this.isSupertonicHealthy()) {
      return
    }

    this.emitRuntimeDiagnostic('warning', 'Preparing voice playback...')
    await this.ensureSupertonicModelReady(python)

    if (!this.ttsServerProcess || this.ttsServerProcess.killed) {
      const child = spawn(
        python.command,
        [
          ...python.args,
          '-X',
          'utf8',
          '-m',
          'supertonic.cli',
          'serve',
          '--host',
          SUPERTONIC_HOST,
          '--port',
          String(SUPERTONIC_PORT),
          '--model',
          SUPERTONIC_MODEL,
          '--log-level',
          'warning',
        ],
        {
          cwd: this.runtimeDir,
          env: {
            ...createPythonEnv(),
            PYTHONUTF8: '1',
          },
          windowsHide: true,
        },
      )
      this.ttsServerProcess = child

      child.stderr.on('data', (chunk) => {
        const detail = String(chunk).trim()
        void this.logger.error(`Supertonic server stderr: ${detail}`)
        if (detail && !detail.includes('Fetching')) {
          this.emitRuntimeDiagnostic('warning', detail.slice(0, 500))
        }
      })
      child.on('exit', (code) => {
        this.ttsServerProcess = null
        const event: VoiceRuntimeEvent = {
          event: 'diagnostics',
          timestamp: Date.now() / 1000,
          status: 'warning',
          detail: `Supertonic server exited with code ${code ?? 'unknown'}.`,
        }
        this.lastEvent = event
        this.emitEvent(event)
      })
    }

    const ready = await waitFor(async () => this.isSupertonicHealthy(), 90_000, 500)
    if (!ready) {
      throw new Error(`Supertonic server did not become healthy at ${SUPERTONIC_BASE_URL}.`)
    }
    this.emitRuntimeDiagnostic('ready', 'Voice playback is ready.')
  }

  private async ensureSupertonicModelReady(python: PythonCommand): Promise<void> {
    await runCommand(
      python.command,
      [
        ...python.args,
        '-X',
        'utf8',
        '-c',
        [
          'from supertonic.pipeline import TTS',
          `TTS(model=${JSON.stringify(SUPERTONIC_MODEL)})`,
          "print('ready')",
        ].join('\n'),
      ],
      this.runtimeDir,
      {
        ...createPythonEnv(),
        PYTHONUTF8: '1',
      },
    )
  }

  private async isSupertonicHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${SUPERTONIC_BASE_URL}/v1/health`)
      if (!response.ok) {
        return false
      }
      const payload = (await response.json()) as { status?: string }
      return payload.status === 'ok'
    } catch {
      return false
    }
  }

  private handleSidecarLine(line: string): void {
    try {
      const event = JSON.parse(line) as VoiceRuntimeEvent
      this.lastEvent = event
      this.emitEvent(event)
    } catch {
      void this.logger.error(`Voice runtime emitted invalid JSON: ${line}`)
    }
  }

  private emitRuntimeDiagnostic(status: DiagnosticItem['status'], detail: string): void {
    const event: VoiceRuntimeEvent = {
      event: 'diagnostics',
      timestamp: Date.now() / 1000,
      status,
      detail,
    }
    this.lastEvent = event
    this.emitEvent(event)
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.process || this.process.killed) {
      return
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private async resolvePythonCommand(preferVenv: boolean): Promise<PythonCommand> {
    const venvPython = path.join(this.venvDir, 'Scripts', 'python.exe')
    if (preferVenv && existsSync(venvPython)) {
      return { command: venvPython, args: [] }
    }

    const bundledPython = [
      path.join(path.dirname(this.runtimeDir), 'portable-python', 'python.exe'),
      path.join(process.cwd(), 'vendor', 'portable-python', 'python.exe'),
    ].find((candidate) => existsSync(candidate))
    if (bundledPython) {
      return { command: bundledPython, args: [] }
    }

    if (process.platform === 'win32') {
      try {
        await runCommand('py', ['-3.13', '--version'], this.runtimeDir)
        return { command: 'py', args: ['-3.13'] }
      } catch {
        // Fall through to 3.12.
      }

      try {
        await runCommand('py', ['-3.12', '--version'], this.runtimeDir)
        return { command: 'py', args: ['-3.12'] }
      } catch {
        // Fall back to the default interpreter.
      }
    }

    return { command: process.env.PYTHON || 'python', args: [] }
  }

  private async isPreferredVenvReady(): Promise<boolean> {
    const venvPython = path.join(this.venvDir, 'Scripts', 'python.exe')
    if (!existsSync(venvPython)) {
      return false
    }

    const pyvenvPath = path.join(this.venvDir, 'pyvenv.cfg')
    try {
      const preferred = await this.resolvePythonCommand(false)
      const preferredVersion = await getPythonVersion(preferred.command, preferred.args, this.runtimeDir)
      const raw = await readFile(pyvenvPath, 'utf8')
      const versionLine = raw
        .split(/\r?\n/)
        .find((line) => line.trim().toLowerCase().startsWith('version ='))
      const venvVersion = versionLine?.split('=')[1]?.trim()
      if (!venvVersion || !preferredVersion || !venvVersion.startsWith(preferredVersion)) {
        return false
      }
      return await canImportRuntimePackages(venvPython, this.runtimeDir)
    } catch {
      return false
    }
  }

  private async assertRuntimePackages(python: PythonCommand): Promise<void> {
    const pythonExecutable = python.args.length > 0 ? null : python.command
    const executable = pythonExecutable ?? path.join(this.venvDir, 'Scripts', 'python.exe')
    const importsOk = await canImportRuntimePackages(executable, this.runtimeDir)
    if (!importsOk) {
      throw new Error('Voice runtime packages are incomplete. Retry preparation to reinstall supertonic/STT dependencies.')
    }
  }

  private async shutdownRuntimeProcesses(): Promise<void> {
    this.process?.kill()
    this.process = null
    this.ttsServerProcess?.kill()
    this.ttsServerProcess = null

    if (process.platform !== 'win32') {
      return
    }

    const escapedVenvDir = this.venvDir.replace(/'/g, "''")
    await runOptionalCommand(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        [
          `$venv = '${escapedVenvDir}'`,
          "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($venv + '\\\\*') } | ForEach-Object {",
          '  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}',
          '}',
        ].join(' '),
      ],
      this.runtimeDir,
    )

    await delay(500)
  }

  private async removeVenvWithRetries(): Promise<void> {
    const attempts = 5
    for (let index = 0; index < attempts; index += 1) {
      try {
        await rm(this.venvDir, { recursive: true, force: true })
        return
      } catch (error) {
        if (index === attempts - 1) {
          throw error
        }
        await delay(700 * (index + 1))
      }
    }
  }
}

function normalizeConfig(input: Partial<VoiceRuntimeConfig>): VoiceRuntimeConfig {
  const wakeWord = normalizeWakeWord(input.wakeWord)
  const wakeAliases = normalizeWakeAliases(input.wakeAliases)
  return {
    ...DEFAULT_CONFIG,
    ...input,
    wakeWord,
    wakeAliases,
    wakeFuzzyRatio: Number(input.wakeFuzzyRatio ?? DEFAULT_CONFIG.wakeFuzzyRatio),
    hotWindowSeconds: Number(input.hotWindowSeconds ?? DEFAULT_CONFIG.hotWindowSeconds),
    sttModel: normalizeSttModel(input.sttModel),
    whisperDevice: normalizeWhisperDevice(input.whisperDevice),
    ttsSpeed: Number(input.ttsSpeed ?? DEFAULT_CONFIG.ttsSpeed),
  }
}

function normalizeWakeWord(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return looksLikeMojibake(text) || !text ? DEFAULT_CONFIG.wakeWord : text
}

function normalizeWakeAliases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((alias) => looksLikeMojibake(String(alias)))) {
    return DEFAULT_CONFIG.wakeAliases
  }
  return value.map((alias) => String(alias).trim()).filter(Boolean)
}

function normalizeSttModel(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text === 'medium') {
    return DEFAULT_CONFIG.sttModel
  }
  return text
}

function normalizeWhisperDevice(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!text || text === 'auto') {
    return DEFAULT_CONFIG.whisperDevice
  }
  return text
}

function looksLikeMojibake(value: string): boolean {
  return /[РС][\u0400-\u04ff]/.test(value)
}

function runCommand(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr.trim() || `${command} exited with ${code ?? 'unknown'}`))
      }
    })
  })
}

function runOptionalCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    child.on('error', () => resolve())
    child.on('exit', () => resolve())
  })
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

function getPythonVersion(command: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
      cwd,
      windowsHide: true,
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      resolve(code === 0 ? stdout.trim() || null : null)
    })
  })
}

function canImportRuntimePackages(pythonExecutable: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const importCheck = [
      'import importlib',
      "modules = ('supertonic', 'webrtcvad', 'faster_whisper')",
      'for name in modules:',
      '    importlib.import_module(name)',
      "print('ok')",
    ].join('\n')
    const child = spawn(
      pythonExecutable,
      ['-c', importCheck],
      { cwd, windowsHide: true },
    )
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.PIP_CERT
  delete env.REQUESTS_CA_BUNDLE
  delete env.SSL_CERT_FILE
  delete env.CURL_CA_BUNDLE
  delete env.PIP_CONFIG_FILE
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1'
  env.PIP_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
  return env
}
