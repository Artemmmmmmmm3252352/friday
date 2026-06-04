import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

import { FridayLogger } from './logger'

const BACKEND_HOST = '127.0.0.1'
const BACKEND_PORT = 3010
const BACKEND_HEALTH_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}/health`
const BACKEND_START_TIMEOUT_MS = 90_000
const BACKEND_START_FINAL_GRACE_MS = 10_000

type BackendLaunchConfig = {
  command: string
  env: NodeJS.ProcessEnv
}

export class BackendRuntimeService {
  private backendProcess: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private readonly appBasePath: string
  private readonly logger: FridayLogger

  constructor(appBasePath: string, logger: FridayLogger) {
    this.appBasePath = appBasePath
    this.logger = logger
  }

  async ensureRunning(): Promise<void> {
    if (await this.isReachable()) {
      return
    }

    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.startBackend().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    if (!this.backendProcess) {
      return
    }

    const processToStop = this.backendProcess
    this.backendProcess = null
    processToStop.kill()
  }

  private async startBackend(): Promise<void> {
    const serverScriptPath = await this.resolveServerScriptPath()
    let startupError: Error | null = null
    const outputTail: string[] = []

    if (!this.backendProcess) {
      const backendEnv = await this.loadBundledRuntimeEnv()
      const launch = this.resolveBackendLaunch(backendEnv)
      await this.logger.info(`Starting Friday backend from ${serverScriptPath} via ${launch.command}`)
      this.backendProcess = spawn(launch.command, [serverScriptPath], {
        cwd: this.resolveWorkingDirectory(),
        env: launch.env,
        windowsHide: true,
        stdio: 'pipe',
      })

      this.backendProcess.stdout.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) {
          appendOutputTail(outputTail, text)
          void this.logger.info(`[backend] ${text}`)
        }
      })
      this.backendProcess.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) {
          appendOutputTail(outputTail, text)
          void this.logger.error(`[backend] ${text}`)
        }
      })
      this.backendProcess.once('exit', (code) => {
        void this.logger.info(`Friday backend exited with code ${code ?? 'unknown'}`)
        this.backendProcess = null
      })
      this.backendProcess.once('error', (error) => {
        startupError = error instanceof Error ? error : new Error(String(error))
        void this.logger.error(`Failed to spawn Friday backend: ${startupError.message}`)
        this.backendProcess = null
      })
    }

    const timeoutAt = Date.now() + BACKEND_START_TIMEOUT_MS
    while (Date.now() < timeoutAt) {
      if (startupError) {
        throw startupError
      }

      if (await this.isReachable()) {
        return
      }

      if (!this.backendProcess) {
        throw new Error(`Friday backend stopped before it became ready.${formatStartupOutput(outputTail)}`)
      }

      await delay(500)
    }

    const graceUntil = Date.now() + BACKEND_START_FINAL_GRACE_MS
    while (Date.now() < graceUntil) {
      if (await this.isReachable()) {
        return
      }

      if (!this.backendProcess) {
        throw new Error(`Friday backend stopped before it became ready.${formatStartupOutput(outputTail)}`)
      }

      await delay(500)
    }

    throw new Error(`Friday backend did not become ready within ${(BACKEND_START_TIMEOUT_MS + BACKEND_START_FINAL_GRACE_MS) / 1000}s.${formatStartupOutput(outputTail)}`)
  }

  private async resolveServerScriptPath(): Promise<string> {
    const candidates = [
      path.join(process.resourcesPath, 'dist-server', 'apps', 'api', 'src', 'server.js'),
      path.join(process.resourcesPath, 'app.asar', 'dist-server', 'apps', 'api', 'src', 'server.js'),
      path.join(this.appBasePath, 'dist-server', 'apps', 'api', 'src', 'server.js'),
      path.join(process.cwd(), 'dist-server', 'apps', 'api', 'src', 'server.js'),
    ]

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return candidate
      }
    }

    throw new Error('Bundled Friday backend entry was not found. Rebuild the app with dist-server included.')
  }

  private resolveWorkingDirectory(): string {
    const executableDir = path.dirname(process.execPath)
    if (executableDir) {
      return executableDir
    }

    return process.cwd()
  }

  private resolveBackendCommand(): string {
    const preferred = process.env.FRIDAY_BACKEND_NODE_EXECUTABLE?.trim()
    if (preferred) {
      return preferred
    }

    return process.execPath
  }

  private resolveBackendLaunch(baseEnv: NodeJS.ProcessEnv): BackendLaunchConfig {
    const command = this.resolveBackendCommand()
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      FRIDAY_API_HOST: BACKEND_HOST,
      FRIDAY_API_PORT: String(BACKEND_PORT),
    }

    if (!process.env.FRIDAY_BACKEND_NODE_EXECUTABLE?.trim()) {
      env.ELECTRON_RUN_AS_NODE = '1'
    }

    return { command, env }
  }

  private async loadBundledRuntimeEnv(): Promise<NodeJS.ProcessEnv> {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env }
    const envRoots = Array.from(
      new Set([
        typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
        path.dirname(process.execPath),
        this.appBasePath,
        process.cwd(),
      ].filter(Boolean)),
    )

    for (const root of envRoots) {
      for (const fileName of ['friday-runtime.env', '.env.local', '.env']) {
        const filePath = path.join(root, fileName)
        let raw = ''
        try {
          raw = await readFile(filePath, 'utf8')
        } catch {
          continue
        }

        for (const line of raw.split(/\r?\n/u)) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) {
            continue
          }

          const separatorIndex = trimmed.indexOf('=')
          if (separatorIndex <= 0) {
            continue
          }

          const key = trimmed.slice(0, separatorIndex).trim()
          if (!key || mergedEnv[key]) {
            continue
          }

          mergedEnv[key] = stripOptionalQuotes(trimmed.slice(separatorIndex + 1).trim())
        }
      }
    }

    return mergedEnv
  }

  private async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(BACKEND_HEALTH_URL, {
        signal: AbortSignal.timeout(2_000),
      })
      return response.ok
    } catch {
      return false
    }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appendOutputTail(outputTail: string[], text: string): void {
  outputTail.push(text)
  while (outputTail.length > 8) {
    outputTail.shift()
  }
}

function formatStartupOutput(outputTail: string[]): string {
  if (outputTail.length === 0) {
    return ''
  }

  return ` Last backend output: ${outputTail.join(' | ').slice(0, 1200)}`
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}
