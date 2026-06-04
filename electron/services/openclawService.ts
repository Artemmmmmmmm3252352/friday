import { constants } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'

import type { AgentProgressEvent, DiagnosticItem, EcosystemUserDataSnapshot, SendTextResult } from '../../src/shared/contracts'
import {
  buildCronAddArgs,
  buildAgentArgs,
  buildGatewayRunArgs,
  getDefaultOpenClawPaths,
  isUnusableAgentReply,
  parseAgentStdout,
} from '../../src/shared/openclaw'
import { FridayLogger } from './logger'

const APP_PROXY_SOCKS_PORT = 18108
const APP_PROXY_HTTP_PORT = 18109
const APP_PROXY_METRICS_PORT = 18111
const APP_PROXY_HTTP_URL = `http://127.0.0.1:${APP_PROXY_HTTP_PORT}`
const APP_PROXY_SOCKS_URL = `socks5://127.0.0.1:${APP_PROXY_SOCKS_PORT}`
const SOURCE_PROXY_FILES = [
  'C:\\Users\\ernes\\Documents\\123.txt',
  'C:\\Users\\ernes\\Documents\\123 — копия.txt',
  'C:\\Users\\ernes\\Documents\\123 — копия (2).txt',
  'C:\\Users\\ernes\\Documents\\123 — копия (3).txt',
]

type OpenClawProgressEvent = Pick<AgentProgressEvent, 'stage' | 'status' | 'label' | 'detail' | 'progress'>
type OpenClawProgressSink = (event: OpenClawProgressEvent) => void

type ProxyProfile = {
  name: string
  path: string
  content: Record<string, unknown>
}

type AgentToolProfile = 'chat' | 'desktop' | 'user-data' | 'browser' | 'files' | 'general'

export class OpenClawService {
  private cliTarget: CliTarget | null = null
  private managedGateway: ChildProcessWithoutNullStreams | null = null
  private apiProxyProcess: ChildProcessWithoutNullStreams | null = null
  private ensureRunningPromise: Promise<{ ok: boolean; url: string; managedByApp: boolean }> | null = null
  private lastMemorySyncAt = 0
  private activeProxyProfileIndex = 0
  private readonly logger: FridayLogger
  private readonly userDataPath: string

  constructor(userDataPath: string, logger: FridayLogger) {
    this.userDataPath = userDataPath
    this.logger = logger
  }

  async getDiagnostics(): Promise<{ openclaw: DiagnosticItem; gateway: DiagnosticItem }> {
    const resolvedCli = await this.findCli()

    if (!resolvedCli) {
      return {
        openclaw: {
          label: 'Сервис агента',
          status: 'error',
          detail: 'Локальный агентный runtime не найден ни по известному npm-пути, ни в PATH.',
        },
        gateway: {
          label: 'Локальный агент',
          status: 'error',
          detail: 'Проверка локального агента недоступна, пока runtime не найден.',
        },
      }
    }

    const gatewayReady = await this.isGatewayReachable()

    return {
      openclaw: {
        label: 'Сервис агента',
        status: 'ready',
        detail: `Используется ${resolvedCli.displayPath}`,
        path: resolvedCli.displayPath,
      },
      gateway: {
        label: 'Локальный агент',
        status: gatewayReady ? 'ready' : 'warning',
        detail: gatewayReady
          ? 'Локальный сервис агента доступен.'
          : 'Локальный сервис агента пока недоступен. Friday может запустить его автоматически.',
        path: 'ws://127.0.0.1:18789',
      },
    }
  }

  async ensureRunning(toolProfile: AgentToolProfile = 'chat'): Promise<{ ok: boolean; url: string; managedByApp: boolean }> {
    if (this.ensureRunningPromise) {
      return this.ensureRunningPromise
    }

    this.ensureRunningPromise = this.ensureRunningInternal(toolProfile).finally(() => {
      this.ensureRunningPromise = null
    })
    return this.ensureRunningPromise
  }

  private async ensureRunningInternal(toolProfile: AgentToolProfile): Promise<{ ok: boolean; url: string; managedByApp: boolean }> {
    const cli = await this.requireCli()
    await this.ensureApiProxyRunning()
    await mkdir(OPENCLAW_WORKSPACE_DIR, { recursive: true })
    await ensureManagedWorkspaceBaseFiles()
    await ensureWorkspaceToolsPolicy()
    const pluginSync = await this.ensureFridayPluginConfigured(toolProfile)
    if (pluginSync.configChanged || pluginSync.pluginChanged) {
      await this.restartGatewayForPluginChange(cli)
    }

    if (!this.managedGateway) {
      const staleGatewayPids = await findFridayGatewayRunPids()
      if (staleGatewayPids.length > 0) {
        for (const pid of staleGatewayPids) {
          await terminateProcessTree(pid, this.logger)
        }
        await this.logger.info(`Reclaimed ${staleGatewayPids.length} stale Friday gateway process(es) before startup.`)
        await delay(1_000)
      }
    }

    if (await this.isGatewayReachable()) {
      await this.syncWorkspaceMemoryContext()
      if (pluginSync.pluginChanged && pluginSync.pluginFingerprint) {
        await persistPluginFingerprint(pluginSync.pluginFingerprint)
      }
      return {
        ok: true,
        url: GATEWAY_URL,
        managedByApp: this.managedGateway !== null,
      }
    }

    const startupLog: string[] = []
    if (!this.managedGateway) {
      await this.logger.info(`Starting OpenClaw gateway via ${cli.displayPath}`)
      this.managedGateway = spawn(...resolveSpawnCommand(cli, buildGatewayRunArgs()), {
        cwd: process.cwd(),
        env: this.buildProxyEnv(),
        windowsHide: true,
        stdio: 'pipe',
      })

      this.managedGateway.stdout.on('data', (chunk) => {
        const text = String(chunk).trim()
        pushStartupLogLine(startupLog, text)
        void this.logger.info(`[gateway] ${text}`)
      })
      this.managedGateway.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        pushStartupLogLine(startupLog, text)
        void this.logger.error(`[gateway] ${text}`)
      })
      this.managedGateway.once('exit', (code) => {
        void this.logger.info(`Gateway process exited with code ${code ?? 'unknown'}`)
        this.managedGateway = null
      })
    }

    const timeoutAt = Date.now() + GATEWAY_START_TIMEOUT_MS
    while (Date.now() < timeoutAt) {
      if (await this.isGatewayReachable()) {
        await this.syncWorkspaceMemoryContext()
        if (pluginSync.pluginChanged && pluginSync.pluginFingerprint) {
          await persistPluginFingerprint(pluginSync.pluginFingerprint)
        }
        return {
          ok: true,
          url: GATEWAY_URL,
          managedByApp: this.managedGateway !== null,
        }
      }

      if (!this.managedGateway) {
        throw new Error(buildGatewayStartupError(this.getOpenClawLogPath(), startupLog))
      }

      await delay(1_000)
    }

    const graceUntil = Date.now() + GATEWAY_START_FINAL_GRACE_MS
    while (Date.now() < graceUntil) {
      if (await this.isGatewayReachable()) {
        await this.syncWorkspaceMemoryContext()
        if (pluginSync.pluginChanged && pluginSync.pluginFingerprint) {
          await persistPluginFingerprint(pluginSync.pluginFingerprint)
        }
        return {
          ok: true,
          url: GATEWAY_URL,
          managedByApp: this.managedGateway !== null,
        }
      }

      await delay(1_000)
    }

    throw new Error(`Не удалось запустить шлюз за ${(GATEWAY_START_TIMEOUT_MS + GATEWAY_START_FINAL_GRACE_MS) / 1000} секунд.`)
  }

  async sendMessage(sessionId: string, text: string, progress?: OpenClawProgressSink): Promise<SendTextResult> {
    progress?.({
      stage: 'gateway',
      status: 'active',
      label: 'Preparing local agent',
      detail: 'Finding the local agent runtime and preparing the service.',
      progress: 12,
    })
    const cli = await this.requireCli()
    const toolProfile = selectAgentToolProfile(text)
    progress?.({
      stage: 'gateway',
      status: 'active',
      label: 'Choosing agent tools',
      detail: describeAgentToolProfile(toolProfile),
      progress: 20,
    })
    await this.ensureRunning(toolProfile)
    progress?.({
      stage: 'sync_context',
      status: 'active',
      label: 'Syncing user context',
      detail: 'Writing the latest local ecosystem snapshot into agent memory.',
      progress: 32,
    })
    await this.syncWorkspaceMemoryContext()
    progress?.({
      stage: 'planning',
      status: 'active',
      label: 'Preparing agent run',
      detail: `Building the message with the ${toolProfile} tool profile.`,
      progress: 42,
    })
    const preparedText = await augmentMessageWithResolvedMailContact(text, this.logger)
    const desktopActionVerification = looksLikeDesktopActionRequest(text)
      ? await captureDesktopActionVerification(text).catch(async (error) => {
          await this.logger.error(`Desktop verification snapshot failed: ${formatError(error)}`)
          return null
        })
      : null
    const attempts = [preparedText]
    if (looksLikeDesktopActionRequest(text)) {
      attempts.push(buildDesktopActionRetryPrompt(preparedText))
    }

    const startedAt = Date.now()
    let lastError: unknown = null

    for (let index = 0; index < attempts.length; index += 1) {
      const message = attempts[index]!
      try {
        progress?.({
          stage: index === 0 ? 'planning' : 'tool_recovery',
          status: 'active',
          label: index === 0 ? 'Agent is working' : 'Retrying with stronger desktop-tool guidance',
          detail: index === 0 ? 'The local agent is reasoning and may call tools.' : 'The first answer looked unusable, so Friday is asking the agent to execute the action.',
          progress: index === 0 ? 55 : 62,
        })
        const { stdout, stderr } = await execCli(cli, buildAgentArgs(sessionId, message), {
          timeout: 600_000,
          windowsHide: true,
          maxBuffer: 20 * 1024 * 1024,
          env: this.buildProxyEnv(),
          resolveOnJsonStdout: true,
        })

        if (stderr?.trim()) {
          await this.logger.info(`[agent stderr] ${stderr.trim()}`)
        }

        progress?.({
          stage: 'finalizing',
          status: 'active',
          label: 'Reading agent result',
          detail: 'Parsing agent output and checking whether a recovery pass is needed.',
          progress: 82,
        })
        const parsed = parseAgentStdout(stdout)
        if (isAgentErrorReply(parsed.replyText)) {
          throw new Error(parsed.replyText)
        }

        if (looksLikeDesktopActionRequest(text) && isRawToolEchoReply(parsed.replyText)) {
          const verifiedReply = await verifyDesktopActionCompleted(desktopActionVerification).catch(async (error) => {
            await this.logger.error(`Desktop verification after raw tool echo failed: ${formatError(error)}`)
            return null
          })
          if (verifiedReply) {
            progress?.({
              stage: 'completed',
              status: 'completed',
              label: 'Agent action verified',
              detail: 'The desktop action completed through tools; Friday cleaned up the final reply.',
              progress: 100,
            })
            return {
              messageId: crypto.randomUUID(),
              replyText: verifiedReply,
              raw: {
                route: 'openclaw_desktop_verified_after_tool_echo',
                originalReply: parsed.replyText,
                raw: parsed.rawJson,
              },
              durationMs: Date.now() - startedAt,
            }
          }
        }

        const unusableDesktopReply = attempts.length > 1 && isUnusableAgentReply(parsed.replyText)
        if (unusableDesktopReply) {
          const verifiedReply = await verifyDesktopActionCompleted(desktopActionVerification).catch(async (error) => {
            await this.logger.error(`Desktop verification after unusable reply failed: ${formatError(error)}`)
            return null
          })
          if (verifiedReply) {
            progress?.({
              stage: 'completed',
              status: 'completed',
              label: 'Agent action verified',
              detail: 'The desktop action completed through tools; Friday is stopping retries.',
              progress: 100,
            })
            return {
              messageId: crypto.randomUUID(),
              replyText: verifiedReply,
              raw: {
                route: 'openclaw_desktop_verified_after_tool',
                originalReply: parsed.replyText,
                raw: parsed.rawJson,
              },
              durationMs: Date.now() - startedAt,
            }
          }
        }

        if (index === 0 && unusableDesktopReply) {
          await this.logger.info('Retrying desktop action with explicit pc-apps/pc-shell guidance after capability refusal.')
          progress?.({
            stage: 'tool_recovery',
            status: 'active',
            label: 'Agent needs a retry',
            detail: 'The first answer did not execute the desktop action, so Friday is retrying with explicit tool routing.',
            progress: 58,
          })
          continue
        }

        progress?.({
          stage: 'completed',
          status: 'completed',
          label: 'Agent finished',
          detail: 'Final answer is ready.',
          progress: 100,
        })
        return {
          messageId: crypto.randomUUID(),
          replyText: parsed.replyText,
          raw: parsed.rawJson,
          durationMs: Date.now() - startedAt,
        }
      } catch (error) {
        lastError = error
        if (await this.tryRotateProxyAndRecover(error)) {
          progress?.({
            stage: 'tool_recovery',
            status: 'active',
            label: 'Switching provider route',
            detail: 'The previous provider route failed, so Friday is rotating the local API proxy and trying again.',
            progress: 48,
          })
          return this.sendMessage(sessionId, text, progress)
        }

        const hasRetryAttempt = index + 1 < attempts.length
        if (looksLikeDesktopActionRequest(text)) {
          const verifiedReply = await verifyDesktopActionCompleted(desktopActionVerification).catch(async (verifyError) => {
            await this.logger.error(`Desktop verification after agent failure failed: ${formatError(verifyError)}`)
            return null
          })
          if (verifiedReply) {
            progress?.({
              stage: 'completed',
              status: 'completed',
              label: 'Agent action verified',
              detail: 'The desktop action completed through tools even though the text response failed.',
              progress: 100,
            })
            return {
              messageId: crypto.randomUUID(),
              replyText: verifiedReply,
              raw: {
                route: 'openclaw_desktop_verified_after_error',
                error: formatError(error),
              },
              durationMs: Date.now() - startedAt,
            }
          }
        }

        if (hasRetryAttempt && looksLikeDesktopActionRequest(text)) {
          await this.logger.info(`Retrying desktop action after agent failure: ${formatError(error)}`)
          continue
        }

        await this.logger.error(`Agent command failed: ${formatError(error)}`)
        throw new Error(toUserFacingAgentError(error))
      }
    }

    await this.logger.error(`Agent command failed after retries: ${formatError(lastError)}`)
    progress?.({
      stage: 'error',
      status: 'error',
      label: 'Agent failed',
      detail: formatError(lastError),
      progress: 100,
    })
    throw new Error(toUserFacingAgentError(lastError))
  }

  async resolveBeamngIntent(prompt: string): Promise<string> {
    const cli = await this.requireCli()
    await this.ensureRunning()

    const startedAt = Date.now()
    try {
      const { stdout, stderr } = await execCli(cli, buildAgentArgs(crypto.randomUUID(), prompt), {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: this.buildProxyEnv(),
        resolveOnJsonStdout: true,
      })

      if (stderr?.trim()) {
        await this.logger.info(`[beamng intent stderr] ${stderr.trim()}`)
      }

      const parsed = parseAgentStdout(stdout)
      await this.logger.info(`BeamNG intent resolved in ${Date.now() - startedAt}ms`)
      return parsed.replyText
    } catch (error) {
      await this.logger.error(`BeamNG intent resolution failed: ${formatError(error)}`)
      throw error
    }
  }

  async scheduleMessage(name: string, delayArg: string, message: string): Promise<{ scheduledFor?: string }> {
    const cli = await this.requireCli()
    await this.ensureRunning()

    try {
      const { stdout, stderr } = await execCli(cli, buildCronAddArgs(name, delayArg, message), {
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: this.buildProxyEnv(),
      })

      if (stderr?.trim()) {
        await this.logger.info(`[cron stderr] ${stderr.trim()}`)
      }

      const parsed = JSON.parse(stdout) as { schedule?: { at?: string } }
      return {
        scheduledFor: parsed.schedule?.at,
      }
    } catch (error) {
      await this.logger.error(`Cron command failed: ${formatError(error)}`)
      throw new Error('Не удалось создать задачу планирования.')
    }
  }

  async getAgentMailSkillInstalled(): Promise<boolean> {
    const cli = await this.findCli()
    if (!cli) {
      return false
    }

    try {
      const { stdout } = await execCli(cli, ['skills', 'list', '--eligible'], {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      return /\bagentmail\b/i.test(stdout)
    } catch {
      return false
    }
  }

  async installAgentMailSkill(): Promise<{ installed: boolean; detail: string }> {
    try {
      await execFileText(
        'cmd.exe',
        ['/c', 'npx', 'clawhub@latest', 'install', 'agentmail'],
        {
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        },
      )
    } catch (error) {
      await this.logger.error(`Failed to install AgentMail skill via ClawHub: ${formatError(error)}`)
      const cli = await this.findCli()
      if (!cli) {
        return {
          installed: false,
          detail: 'Local agent runtime was not found, and ClawHub installation also failed.',
        }
      }

      try {
        await execCli(cli, ['skills', 'install', 'agentmail-to/agentmail-skills/agentmail'], {
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        })
      } catch (fallbackError) {
        await this.logger.error(`Failed to install AgentMail skill via local agent CLI: ${formatError(fallbackError)}`)
        return {
          installed: false,
          detail: `AgentMail skill installation failed: ${formatError(fallbackError)}`,
        }
      }
    }

    const installed = await this.getAgentMailSkillInstalled()
    return {
      installed,
      detail: installed ? 'AgentMail skill is installed and eligible.' : 'AgentMail skill install finished, but the skill was not detected yet.',
    }
  }

  async stopManagedProcess(): Promise<void> {
    if (!this.managedGateway) {
      await this.stopApiProxy()
      return
    }

    this.managedGateway.kill()
    this.managedGateway = null
    await this.stopApiProxy()
  }

  getOpenClawLogPath(): string {
    const today = new Date().toISOString().slice(0, 10)
    return path.join(os.tmpdir(), 'openclaw', `openclaw-${today}.log`)
  }

  private buildProxyEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (process.env.FRIDAY_FORCE_OPENCLAW_PROXY !== '1') {
      delete env.HTTP_PROXY
      delete env.HTTPS_PROXY
      delete env.ALL_PROXY
      delete env.http_proxy
      delete env.https_proxy
      delete env.all_proxy
      env.NO_PROXY = '127.0.0.1,localhost'
      env.no_proxy = '127.0.0.1,localhost'
      return env
    }

    env.NODE_USE_ENV_PROXY = '1'
    env.HTTP_PROXY = APP_PROXY_HTTP_URL
    env.HTTPS_PROXY = APP_PROXY_HTTP_URL
    env.ALL_PROXY = APP_PROXY_SOCKS_URL
    env.NO_PROXY = '127.0.0.1,localhost'
    env.http_proxy = APP_PROXY_HTTP_URL
    env.https_proxy = APP_PROXY_HTTP_URL
    env.all_proxy = APP_PROXY_SOCKS_URL
    env.no_proxy = '127.0.0.1,localhost'
    return env
  }

  private async ensureApiProxyRunning(): Promise<void> {
    if (process.env.FRIDAY_FORCE_OPENCLAW_PROXY !== '1') {
      return
    }

    const profiles = await this.ensureBundledProxyProfiles()
    if (profiles.length === 0) {
      return
    }

    if (this.apiProxyProcess && !this.apiProxyProcess.killed && (await this.isApiProxyReachable())) {
      return
    }

    const xrayPath = path.join(this.userDataPath, 'vpn', 'xray-core', 'xray.exe')
    if (!(await exists(xrayPath))) {
      await this.logger.error(`Built-in API proxy runtime is missing: ${xrayPath}`)
      return
    }

    const profile = profiles[this.activeProxyProfileIndex] ?? profiles[0]
    const runtimeConfigPath = path.join(this.userDataPath, 'proxy', 'active-profile.json')
    await mkdir(path.dirname(runtimeConfigPath), { recursive: true })
    await writeFile(runtimeConfigPath, `${JSON.stringify(profile.content, null, 2)}\n`, 'utf8')

    const staleProxyPids = await findFridayApiProxyPids(runtimeConfigPath)
    if (staleProxyPids.length > 0) {
      for (const pid of staleProxyPids) {
        await terminateProcessTree(pid, this.logger)
      }
      await this.logger.info(`Reclaimed ${staleProxyPids.length} stale Friday API proxy process(es) before startup.`)
      await delay(500)
    }

    await this.logger.info(`Starting API proxy via ${profile.name}`)
    this.apiProxyProcess = spawn(xrayPath, ['run', '-config', runtimeConfigPath], {
      cwd: path.dirname(xrayPath),
      windowsHide: true,
      stdio: 'pipe',
    })

    this.apiProxyProcess.stdout.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) {
        void this.logger.info(`[api-proxy] ${text}`)
      }
    })
    this.apiProxyProcess.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) {
        void this.logger.error(`[api-proxy] ${text}`)
      }
    })
    this.apiProxyProcess.once('exit', (code) => {
      void this.logger.info(`API proxy exited with code ${code ?? 'unknown'}`)
      this.apiProxyProcess = null
    })

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await this.isApiProxyReachable()) {
        return
      }
      if (!this.apiProxyProcess) {
        break
      }
      await delay(500)
    }
  }

  private async stopApiProxy(): Promise<void> {
    if (!this.apiProxyProcess) {
      return
    }

    const processToStop = this.apiProxyProcess
    this.apiProxyProcess = null
    processToStop.kill()
  }

  private async isApiProxyReachable(): Promise<boolean> {
    return canConnectToPort('127.0.0.1', APP_PROXY_HTTP_PORT, 800)
  }

  private async ensureBundledProxyProfiles(): Promise<ProxyProfile[]> {
    const targetDir = path.join(this.userDataPath, 'proxy', 'profiles')
    await mkdir(targetDir, { recursive: true })

    const profiles: ProxyProfile[] = []
    for (let index = 0; index < SOURCE_PROXY_FILES.length; index += 1) {
      const sourcePath = SOURCE_PROXY_FILES[index]
      try {
        const raw = await readFile(sourcePath, 'utf8')
        const parsed = normalizeProxyProfile(JSON.parse(raw) as Record<string, unknown>)
        const normalizedName = `profile-${index + 1}.json`
        const targetPath = path.join(targetDir, normalizedName)
        await writeFile(targetPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
        profiles.push({
          name: String(parsed.remarks || normalizedName),
          path: targetPath,
          content: parsed,
        })
      } catch (error) {
        await this.logger.error(`Failed to import proxy profile from ${sourcePath}: ${formatError(error)}`)
      }
    }

    return profiles
  }

  private async tryRotateProxyAndRecover(error: unknown): Promise<boolean> {
    if (!isRetryableProxyError(error)) {
      return false
    }

    const profiles = await this.ensureBundledProxyProfiles()
    if (profiles.length <= 1) {
      return false
    }

    this.activeProxyProfileIndex = (this.activeProxyProfileIndex + 1) % profiles.length
    await this.logger.info(`Rotating API proxy to profile #${this.activeProxyProfileIndex + 1} after provider failure.`)
    await this.stopManagedProcess()
    await this.ensureApiProxyRunning()
    return true
  }

  private async syncWorkspaceMemoryContext(): Promise<void> {
    const now = Date.now()
    if (this.lastMemorySyncAt > 0 && now - this.lastMemorySyncAt < 15_000) {
      return
    }

    try {
      const userDataSnapshot = await loadFridayUserDataSnapshot()
      const sessionUser = await readFridaySessionUser()
      const memories = userDataSnapshot ? [] : await loadFridayMemories()
      const snapshot = userDataSnapshot
        ? renderWorkspaceUserDataSnapshot(userDataSnapshot, sessionUser)
        : renderWorkspaceMemorySnapshot(memories, sessionUser)

      await mkdir(OPENCLAW_WORKSPACE_DIR, { recursive: true })
      await ensureManagedWorkspaceBaseFiles()
      await ensureWorkspaceToolsPolicy()

      const currentUserDoc = await safeReadUtf8(OPENCLAW_USER_PATH)
      const nextUserDoc = applyWorkspaceMemorySnapshot(currentUserDoc, snapshot)
      if (nextUserDoc === currentUserDoc) {
        this.lastMemorySyncAt = now
        return
      }

      await writeFile(OPENCLAW_USER_PATH, nextUserDoc, 'utf8')

      await rm(OPENCLAW_BOOTSTRAP_PATH, { force: true })
      this.lastMemorySyncAt = now
    } catch (error) {
      this.lastMemorySyncAt = now
      await this.logger.error(`Failed to sync OpenClaw workspace memory context: ${formatError(error)}`)
    }
  }

  private async findCli(): Promise<CliTarget | null> {
    if (this.cliTarget) {
      return this.cliTarget
    }

    const bundledCli = await findBundledCli().catch(() => null)
    if (bundledCli) {
      this.cliTarget = bundledCli
      return this.cliTarget
    }

    const candidates: CliTarget[] = []

    for (const candidate of getDefaultOpenClawPaths({
      homeDir: os.homedir(),
      appDataDir: process.env.APPDATA,
    })) {
      if (await exists(candidate)) {
        candidates.push({
          command: candidate,
          argsPrefix: [],
          displayPath: candidate,
          version: await readInstalledOpenClawVersion(candidate),
        })
      }
    }

    if (candidates.length === 0) {
      try {
        const { stdout } = await execFileText('where', ['openclaw'], {
          windowsHide: true,
        })
        const discovered = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)

        if (discovered) {
          candidates.push({
            command: discovered,
            argsPrefix: [],
            displayPath: discovered,
            version: await readInstalledOpenClawVersion(discovered),
          })
        }
      } catch {
        // Ignore PATH lookup errors; we'll fall back to any already collected candidates.
      }
    }

    if (candidates.length === 0) {
      return null
    }

    candidates.sort(compareCliTargets).reverse()
    this.cliTarget = candidates[0]
    return this.cliTarget
  }

  private async requireCli(): Promise<CliTarget> {
    const cli = await this.findCli()
    if (!cli) {
      throw new Error('Локальный агентный runtime не найден.')
    }

    return cli
  }

  private async isGatewayReachable(): Promise<boolean> {
    return canConnectToPort(GATEWAY_HOST, GATEWAY_PORT, 1_500)
  }

  private async ensureFridayPluginConfigured(toolProfile: AgentToolProfile = 'general'): Promise<{
    configChanged: boolean
    pluginChanged: boolean
    pluginFingerprint: string | null
  }> {
    const pluginLocation = await resolveManagedPluginLocation()
    const pluginRoot = pluginLocation?.root ?? null
    const availablePluginIds = pluginLocation?.availablePluginIds ?? []
    const pluginFingerprint = pluginRoot ? await buildDirectoryFingerprint(pluginRoot) : null
    const previousFingerprint = pluginFingerprint ? await readPluginFingerprint() : null
    const pluginChanged = pluginFingerprint !== previousFingerprint

    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
    let currentConfig: Record<string, unknown> = {}
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        currentConfig = parsed as Record<string, unknown>
      }
    } catch {
      currentConfig = {}
    }

    const nextConfig = structuredClone(currentConfig)
    const plugins = ensureObject(nextConfig, 'plugins')
    const pluginAllow = Array.isArray(plugins.allow) ? plugins.allow.filter((entry) => typeof entry === 'string') : []

    const load = ensureObject(plugins, 'load')
    const configuredLoadPaths = Array.isArray(load.paths) ? load.paths.filter((entry) => typeof entry === 'string') : []
    const loadPaths: string[] = []
    for (const configuredPath of configuredLoadPaths) {
      const normalizedPath = configuredPath.trim()
      if (!normalizedPath) {
        continue
      }

      const containsManagedPlugin = await pathContainsManagedPlugin(normalizedPath)
      if (containsManagedPlugin && pluginRoot && !samePath(normalizedPath, pluginRoot)) {
        await this.logger.info(`Removing duplicate OpenClaw plugin path from config: ${normalizedPath}`)
        continue
      }

      if (await exists(normalizedPath)) {
        if (!loadPaths.some((entry) => samePath(entry, normalizedPath))) {
          loadPaths.push(normalizedPath)
        }
        continue
      }

      await this.logger.info(`Removing stale OpenClaw plugin path from config: ${normalizedPath}`)
    }

    if (pluginRoot) {
      for (const pluginId of availablePluginIds) {
        if (!pluginAllow.includes(pluginId)) {
          pluginAllow.push(pluginId)
        }
      }
      if (!loadPaths.some((entry) => samePath(entry, pluginRoot))) {
        loadPaths.push(pluginRoot)
      }
    } else {
      await this.logger.error('Friday OpenClaw plugin bundle was not found. Friday plugin hooks will be disabled until the app is rebuilt.')
    }

    plugins.allow = pluginRoot
      ? pluginAllow
      : pluginAllow.filter((entry) => !MANAGED_OPENCLAW_PLUGIN_IDS.includes(entry))
    load.paths = loadPaths

    const profileConfig = buildAgentToolProfileConfig(toolProfile)

    const entries = ensureObject(plugins, 'entries')
    for (const pluginId of MANAGED_OPENCLAW_PLUGIN_IDS) {
      if (pluginRoot && availablePluginIds.includes(pluginId) && profileConfig.plugins.includes(pluginId)) {
        const pluginEntry = ensureObject(entries, pluginId)
        pluginEntry.enabled = true
        continue
      }

      const pluginEntry = ensureObject(entries, pluginId)
      pluginEntry.enabled = false
    }

    const tools = ensureObject(nextConfig, 'tools')
    const toolAllow = [...profileConfig.tools]
    if (pluginRoot && availablePluginIds.includes(FRIDAY_PLUGIN_ID) && profileConfig.plugins.includes(FRIDAY_PLUGIN_ID)) {
      for (const toolName of FRIDAY_TOOL_NAMES) {
        if (!toolAllow.includes(toolName)) {
          toolAllow.push(toolName)
        }
      }
    }
    if (pluginRoot && availablePluginIds.includes(PLAYWRIGHT_PLUGIN_ID) && profileConfig.plugins.includes(PLAYWRIGHT_PLUGIN_ID)) {
      for (const toolName of PLAYWRIGHT_TOOL_NAMES) {
        if (!toolAllow.includes(toolName)) {
          toolAllow.push(toolName)
        }
      }
      if (!toolAllow.includes(PLAYWRIGHT_PLUGIN_ID)) {
        toolAllow.push(PLAYWRIGHT_PLUGIN_ID)
      }
    }
    tools.allow = toolAllow
    const toolDeny = Array.isArray(tools.deny) ? tools.deny.filter((entry) => typeof entry === 'string') : []
    for (const deniedTool of [
      'tts',
      'message',
      'web_search',
      'web_fetch',
      'sessions_list',
      'sessions_history',
      'sessions_send',
      'sessions_spawn',
      'sessions_yield',
      'agents_list',
      'session_status',
    ]) {
      if (!toolDeny.includes(deniedTool)) {
        toolDeny.push(deniedTool)
      }
    }
    if (pluginRoot && availablePluginIds.includes(PLAYWRIGHT_PLUGIN_ID) && !toolDeny.includes('browser')) {
      toolDeny.push('browser')
    }
    tools.deny = toolDeny

    const skills = ensureObject(nextConfig, 'skills')
    skills.allowBundled = profileConfig.skills
    applySkillProfile(skills, profileConfig.skills)

    if (JSON.stringify(nextConfig) !== JSON.stringify(currentConfig)) {
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')
      await this.logger.info(`Configured OpenClaw plugin "${FRIDAY_PLUGIN_ID}" via ${configPath}`)
      return {
        configChanged: true,
        pluginChanged,
        pluginFingerprint,
      }
    }

    if (pluginChanged) {
      await this.logger.info(`Detected updated OpenClaw plugin "${FRIDAY_PLUGIN_ID}". Gateway restart required.`)
    }

    return {
      configChanged: false,
      pluginChanged,
      pluginFingerprint,
    }
  }

  private async restartGatewayForPluginChange(cli: CliTarget): Promise<void> {
    if (this.managedGateway) {
      await this.stopManagedProcess()
    }

    const staleGatewayPids = await findFridayGatewayRunPids()
    for (const pid of staleGatewayPids) {
      await terminateProcessTree(pid, this.logger)
    }

    if (staleGatewayPids.length > 0) {
      await this.logger.info(`Stopped ${staleGatewayPids.length} stale OpenClaw gateway process(es) before plugin reload.`)
      await delay(1_000)
    }

    if (!(await this.isGatewayReachable())) {
      return
    }

    try {
      await execCli(cli, ['gateway', 'stop'], {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      await this.logger.info('Restarted OpenClaw gateway after Friday plugin config update.')
    } catch (error) {
      await this.logger.error(`Failed to stop gateway after plugin config update: ${formatError(error)}`)
    }
  }
}

async function resolveManagedPluginLocation(): Promise<{ root: string; availablePluginIds: string[] } | null> {
  const candidateRoots = [
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'openclaw-plugins') : '',
    path.join(process.cwd(), 'openclaw-plugins'),
  ].filter(Boolean)

  for (const root of candidateRoots) {
    const availablePluginIds: string[] = []
    for (const pluginId of MANAGED_OPENCLAW_PLUGIN_IDS) {
      const manifestPath = path.join(root, pluginId, 'openclaw.plugin.json')
      if (await exists(manifestPath)) {
        availablePluginIds.push(pluginId)
      }
    }

    if (availablePluginIds.length > 0) {
      return { root, availablePluginIds }
    }
  }

  return null
}

async function pathContainsManagedPlugin(rootPath: string): Promise<boolean> {
  for (const pluginId of MANAGED_OPENCLAW_PLUGIN_IDS) {
    if (await exists(path.join(rootPath, pluginId, 'openclaw.plugin.json'))) {
      return true
    }
  }

  return false
}

function samePath(left: string, right: string) {
  return path.resolve(left).replace(/\//g, '\\').toLowerCase() === path.resolve(right).replace(/\//g, '\\').toLowerCase()
}

type CliTarget = {
  command: string
  argsPrefix: string[]
  displayPath: string
  version: string | null
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function buildDirectoryFingerprint(rootDir: string): Promise<string> {
  const entries = await collectDirectoryEntries(rootDir)
  return entries.sort((left, right) => left.localeCompare(right)).join('\n')
}

async function collectDirectoryEntries(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const dirEntries = await readdir(currentDir, { withFileTypes: true })
  const fingerprints: string[] = []

  for (const entry of dirEntries) {
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      fingerprints.push(...(await collectDirectoryEntries(rootDir, fullPath)))
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const details = await stat(fullPath)
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')
    fingerprints.push(`${relativePath}:${details.size}:${details.mtimeMs}`)
  }

  return fingerprints
}

async function readPluginFingerprint(): Promise<string | null> {
  try {
    const raw = await readFile(FRIDAY_PLUGIN_FINGERPRINT_PATH, 'utf8')
    return raw.trim() || null
  } catch {
    return null
  }
}

async function persistPluginFingerprint(fingerprint: string): Promise<void> {
  await mkdir(path.dirname(FRIDAY_PLUGIN_FINGERPRINT_PATH), { recursive: true })
  await writeFile(FRIDAY_PLUGIN_FINGERPRINT_PATH, `${fingerprint}\n`, 'utf8')
}

async function findFridayGatewayRunPids(): Promise<number[]> {
  if (process.platform === 'win32') {
    const script = [
      "Get-CimInstance Win32_Process",
      " | Where-Object {",
      "    $_.Name -eq 'node.exe'",
      "    -and $_.CommandLine -like '*openclaw.mjs*gateway run*'",
      "    -and $_.CommandLine -like '*--allow-unconfigured*'",
      "    -and $_.CommandLine -like '*--bind loopback*'",
      "  }",
      ' | Select-Object -ExpandProperty ProcessId',
    ].join('')

    try {
      const { stdout } = await execFileText('powershell.exe', ['-NoProfile', '-Command', script], {
        windowsHide: true,
      })
      return stdout
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    } catch {
      return []
    }
  }

  try {
    const { stdout } = await execFileText('pgrep', ['-f', 'openclaw.*gateway run.*--allow-unconfigured.*--bind loopback'], {
      windowsHide: true,
    })
    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

async function findFridayApiProxyPids(runtimeConfigPath: string): Promise<number[]> {
  if (process.platform !== 'win32') {
    return []
  }

  const configPathPattern = runtimeConfigPath.replace(/'/g, "''")
  const script = [
    "Get-CimInstance Win32_Process",
    " | Where-Object {",
    "    $_.Name -eq 'xray.exe'",
    "    -and $_.CommandLine -like '* run -config *'",
    `    -and $_.CommandLine -like '*${configPathPattern}*'`,
    "  }",
    ' | Select-Object -ExpandProperty ProcessId',
  ].join('')

  try {
    const { stdout } = await execFileText('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
    })
    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

async function terminateProcessTree(pid: number, logger: FridayLogger): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }

  try {
    if (process.platform === 'win32') {
      await execFileText('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
      })
      return
    }

    process.kill(pid, 'SIGTERM')
  } catch (error) {
    await logger.error(`Failed to stop stale OpenClaw gateway process ${pid}: ${formatError(error)}`)
  }
}

const GATEWAY_HOST = '127.0.0.1'
const GATEWAY_PORT = 18_789
const GATEWAY_URL = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`
const GATEWAY_START_TIMEOUT_MS = 240_000
const GATEWAY_START_FINAL_GRACE_MS = 15_000
const ECOSYSTEM_API_BASE_URL = (process.env.FRIDAY_ECOSYSTEM_API_BASE_URL ?? 'https://xvexta.ru/api').replace(/\/+$/, '')
const FRIDAY_PLUGIN_ID = 'friday-backend'
const PLAYWRIGHT_PLUGIN_ID = 'playwright-mcp'
const MANAGED_OPENCLAW_PLUGIN_IDS = [FRIDAY_PLUGIN_ID, PLAYWRIGHT_PLUGIN_ID]
const FRIDAY_STATE_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'friday', 'state')
const FRIDAY_PLUGIN_FINGERPRINT_PATH = path.join(FRIDAY_STATE_DIR, 'openclaw-plugin-fingerprint.txt')
const FRIDAY_BACKEND_SESSION_PATH = path.join(FRIDAY_STATE_DIR, 'backend-session.json')
const FRIDAY_BACKEND_CONFIG_PATH = path.join(FRIDAY_STATE_DIR, 'backend-config.json')
const ECOSYSTEM_USER_DATA_SNAPSHOT_PATH = path.join(FRIDAY_STATE_DIR, 'ecosystem-user-data-snapshot.json')
const OPENCLAW_WORKSPACE_DIR = path.join(FRIDAY_STATE_DIR, 'openclaw-workspace')
const OPENCLAW_USER_PATH = path.join(OPENCLAW_WORKSPACE_DIR, 'USER.md')
const OPENCLAW_TOOLS_PATH = path.join(OPENCLAW_WORKSPACE_DIR, 'TOOLS.md')
const OPENCLAW_BOOTSTRAP_PATH = path.join(OPENCLAW_WORKSPACE_DIR, 'BOOTSTRAP.md')
const USER_MEMORY_BLOCK_START = '<!-- friday-memory:start -->'
const USER_MEMORY_BLOCK_END = '<!-- friday-memory:end -->'
const FRIDAY_DESKTOP_POLICY_START = '<!-- friday-desktop-policy:start -->'
const FRIDAY_DESKTOP_POLICY_END = '<!-- friday-desktop-policy:end -->'
const FRIDAY_TOOL_NAMES = [
  'friday_workspace_context',
  'friday_note_read',
  'friday_note_create',
  'friday_note_update',
  'friday_project_create',
  'friday_project_update',
  'friday_task_create',
  'friday_task_update',
  'friday_reminder_create',
  'friday_inbox_dismiss',
  'friday_mail_account_get',
  'friday_mail_list',
  'friday_mail_read',
  'friday_mail_send',
  'friday_mail_mark_read',
  'friday_mail_contacts_list',
  'friday_mail_contact_lookup',
  'friday_memory_search',
  'friday_memory_get',
  'friday_memory_remember',
  'friday_memory_list',
]
const PLAYWRIGHT_TOOL_NAMES = [
  'playwright_browser_open',
  'playwright_browser_snapshot',
  'playwright_browser_click',
  'playwright_browser_fill_form',
  'playwright_browser_form_snapshot',
  'playwright_browser_form_answer',
  'playwright_browser_extract',
  'playwright_browser_close',
]
const CORE_DESKTOP_TOOLS = ['exec', 'process', 'read', 'write', 'edit']
const CORE_WEB_TOOLS = ['web_search', 'web_fetch']
const CHAT_NOOP_TOOLS = ['session_status']
const CHAT_BUNDLED_SKILLS = ['adaptive-reasoning']
const DESKTOP_BUNDLED_SKILLS = ['agent-os', 'pc-apps', 'pc-files', 'pc-shell', 'terminal']
const USER_DATA_BUNDLED_SKILLS = ['friday-backend', 'semantic-memory', 'task-manager', 'planning-with-files']
const BROWSER_BUNDLED_SKILLS = ['agent-browser', 'browser-search', 'pc-web', 'web-scraping', 'Playwright (Automation + MCP + Scraper)']
const FILE_BUNDLED_SKILLS = ['pc-files', 'pdf', 'planning-with-files', 'python-executor', 'terminal']
const GENERAL_BUNDLED_SKILLS = [
  'adaptive-reasoning',
  'agent-os',
  'browser-search',
  'pc-apps',
  'pc-files',
  'pc-planner',
  'pc-shell',
  'pc-web',
  'planning-with-files',
  'semantic-memory',
  'task-manager',
  'terminal',
]
const MANAGED_SKILL_KEYS = [
  ...new Set([
    ...CHAT_BUNDLED_SKILLS,
    ...DESKTOP_BUNDLED_SKILLS,
    ...USER_DATA_BUNDLED_SKILLS,
    ...BROWSER_BUNDLED_SKILLS,
    ...FILE_BUNDLED_SKILLS,
    ...GENERAL_BUNDLED_SKILLS,
    'API (Stripe, OpenAI, Notion &amp; 100+ more)',
    'Coding',
    'Deep Research',
    'Docker',
    'Notes (Local, Apple, Notion, Obsidian &amp; more)',
    'Vision — Image Processing, Resize, Convert &amp; Watermark',
    'agentmail',
    'automation-workflows',
    'brain',
    'cron-setup',
    'email',
    'extract',
    'friday-context-optimizer',
    'friday-document-analysis',
    'friday-download-manager',
    'friday-mcpo-proxy',
    'friday-openapi-tools',
    'friday-tool-router',
    'gmail',
    'google-calendar',
    'google-docs',
    'google-drive',
    'google-sheets',
    'habit-tracker',
    'mcp-builder',
    'multi-agent',
    'openapi',
    'pc-automations',
    'pc-calendar',
    'pc-coding',
    'pc-email',
    'proactive-agent',
    'slack',
    'telegram',
  ]),
]

function buildAgentToolProfileConfig(profile: AgentToolProfile): {
  tools: string[]
  skills: string[]
  plugins: string[]
} {
  switch (profile) {
    case 'chat':
      return {
        // OpenClaw treats an empty allow-list as the default tool set. Allow one
        // globally denied tool so small talk is exposed to no callable tools.
        tools: CHAT_NOOP_TOOLS,
        skills: CHAT_BUNDLED_SKILLS,
        plugins: [],
      }
    case 'desktop':
      return {
        tools: CORE_DESKTOP_TOOLS,
        skills: DESKTOP_BUNDLED_SKILLS,
        plugins: [],
      }
    case 'user-data':
      return {
        tools: [...CORE_DESKTOP_TOOLS, ...CORE_WEB_TOOLS],
        skills: USER_DATA_BUNDLED_SKILLS,
        plugins: [FRIDAY_PLUGIN_ID],
      }
    case 'browser':
      return {
        tools: [...CORE_DESKTOP_TOOLS, ...CORE_WEB_TOOLS],
        skills: BROWSER_BUNDLED_SKILLS,
        plugins: [PLAYWRIGHT_PLUGIN_ID],
      }
    case 'files':
      return {
        tools: [...CORE_DESKTOP_TOOLS, ...CORE_WEB_TOOLS],
        skills: FILE_BUNDLED_SKILLS,
        plugins: [PLAYWRIGHT_PLUGIN_ID],
      }
    case 'general':
    default:
      return {
        tools: [...CORE_DESKTOP_TOOLS, ...CORE_WEB_TOOLS],
        skills: GENERAL_BUNDLED_SKILLS,
        plugins: [],
      }
  }
}

function selectAgentToolProfile(text: string): AgentToolProfile {
  const normalized = text.trim().toLowerCase().replace(/ё/g, 'е')
  if (looksLikeSmallTalkRequest(normalized)) {
    return 'chat'
  }

  if (looksLikeDesktopActionRequest(text)) {
    return 'desktop'
  }

  if (/(?:заметк|задач|проект|памят|данн(?:ые|ых)|профил|напоминан|inbox|note|task|project|memory|profile|reminder)/iu.test(normalized)) {
    return 'user-data'
  }

  if (/(?:браузер|сайт|страниц|поиск|найди в интернете|открой ссыл|browser|website|web|google|chrome|edge|url|http)/iu.test(normalized)) {
    return 'browser'
  }

  if (/(?:файл|папк|документ|pdf|docx|xlsx|сортир|удали .*файл|создай .*файл|file|folder|document|sort)/iu.test(normalized)) {
    return 'files'
  }

  return 'general'
}

function describeAgentToolProfile(profile: AgentToolProfile): string {
  switch (profile) {
    case 'desktop':
      return 'The agent will receive only local desktop, shell, and file tools for this request.'
    case 'chat':
      return 'The agent will receive a minimal chat profile without unrelated tools.'
    case 'user-data':
      return 'The agent will receive Friday user-data tools plus a compact local runtime context.'
    case 'browser':
      return 'The agent will receive browser and web tools without unrelated user-data schemas.'
    case 'files':
      return 'The agent will receive file, document, shell, and web tools for local productivity work.'
    case 'general':
    default:
      return 'The agent will receive a compact general Friday tool profile.'
  }
}

function looksLikeSmallTalkRequest(normalized: string): boolean {
  return /^(?:привет|здравствуй|здравствуйте|хай|hello|hi|hey|как дела|ты тут|проверка|test|ping)[\s!.?]*$/iu.test(normalized)
}

async function loadFridayMemories(): Promise<FridayMemoryRecord[]> {
  const token = await readFridayBackendToken()
  const baseUrl = await readFridayBackendBaseUrl()
  const response = await fetch(`${baseUrl}/memory?limit=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to load Friday memory: HTTP ${response.status}`)
  }

  const payload = await response.json()
  return extractCollection(payload, ['value', 'memory', 'memories', 'items']) as FridayMemoryRecord[]
}

async function loadFridayUserDataSnapshot(): Promise<EcosystemUserDataSnapshot | null> {
  try {
    const raw = await readFile(ECOSYSTEM_USER_DATA_SNAPSHOT_PATH, 'utf8')
    const parsed = JSON.parse(raw) as EcosystemUserDataSnapshot
    if (!parsed?.profile || !parsed.entities) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

type FridayMailContactRecord = {
  id: string
  name: string
  email: string
  aliases?: string[]
  notes?: string
}

type FridaySessionUser = {
  id: string
  email: string
  displayName: string
  timezone: string | null
}

async function loadFridayMailContacts(): Promise<FridayMailContactRecord[]> {
  const token = await readFridayBackendToken()
  const baseUrl = await readFridayBackendBaseUrl()
  const response = await fetch(`${baseUrl}/mail/contacts`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to load Friday mail contacts: HTTP ${response.status}`)
  }

  const payload = (await response.json()) as unknown
  return Array.isArray(payload) ? (payload as FridayMailContactRecord[]) : []
}

async function readFridaySessionUser(): Promise<FridaySessionUser | null> {
  try {
    const raw = await readFile(FRIDAY_BACKEND_SESSION_PATH, 'utf8')
    const parsed = JSON.parse(raw) as {
      session?: {
        user?: Partial<FridaySessionUser> & {
          settings?: {
            timezone?: string
          }
        }
      }
    }
    const user = parsed.session?.user
    if (!user || typeof user !== 'object') {
      return null
    }

    const email = typeof user.email === 'string' ? user.email.trim() : ''
    const displayName = typeof user.displayName === 'string' ? user.displayName.trim() : ''
    const id = typeof user.id === 'string' ? user.id.trim() : ''
    const timezone =
      typeof user.settings?.timezone === 'string' && user.settings.timezone.trim() ? user.settings.timezone.trim() : null
    if (!email && !displayName) {
      return null
    }

    return {
      id,
      email,
      displayName: displayName || email,
      timezone,
    }
  } catch {
    return null
  }
}

async function augmentMessageWithResolvedMailContact(text: string, logger: FridayLogger): Promise<string> {
  if (!looksLikeMailSendRequest(text)) {
    return text
  }

  try {
    const sender = await readFridaySessionUser()
    const contacts = await loadFridayMailContacts()
    const matched = findReferencedMailContacts(text, contacts)
    const primary = matched[0] ?? null
    if (primary) {
      await logger.info(`Resolved mail contact "${primary.name}" -> ${primary.email} before agent send.`)
    }

    const guidanceBlocks: string[] = []
    if (primary && !hasExplicitEmailAddress(text)) {
      guidanceBlocks.push(
        `[Friday resolved mail recipient]
Saved contact match: ${primary.name} <${primary.email}>.
Aliases: ${(primary.aliases ?? []).join(', ') || 'none'}.
If the user is asking to send an email to this person, use this exact email address.
Do not ask the user to repeat the recipient email unless sending fails or the recipient is ambiguous.`,
      )
    }

    if (sender) {
      guidanceBlocks.push(
        `[Friday sender profile]
User display name: ${sender.displayName}.
User email: ${sender.email}.
When drafting or sending an email, never leave placeholders like [Ваше имя], [Ваше имя/позиция], [company], or similar.
If the user's role or position is unknown, omit it and sign only with ${sender.displayName}.`,
      )
    }

    if (guidanceBlocks.length === 0) {
      return text
    }

    return `${text}

${guidanceBlocks.join('\n\n')}`
  } catch (error) {
    await logger.error(`Failed to prepare Friday mail preflight context: ${formatError(error)}`)
    return text
  }
}

function looksLikeMailSendRequest(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    /\b(email|e-mail|mail|gmail)\b/u.test(normalized) ||
    /\b(send|write|reply|email)\b/u.test(normalized) ||
    /письм|емейл|почт|почту|напиши|отправ/u.test(normalized)
  )
}

function hasExplicitEmailAddress(text: string): boolean {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text)
}

function findReferencedMailContacts(text: string, contacts: FridayMailContactRecord[]): FridayMailContactRecord[] {
  const normalizedText = normalizeLookupText(text)
  const matches: FridayMailContactRecord[] = []

  for (const contact of contacts) {
    const variants = [contact.name, contact.email, ...(contact.aliases ?? [])]
      .map((entry) => entry.trim())
      .filter(Boolean)

    if (variants.some((variant) => textMentionsContact(normalizedText, variant))) {
      matches.push(contact)
    }
  }

  return matches
}

function textMentionsContact(normalizedText: string, rawVariant: string): boolean {
  const variant = normalizeLookupText(rawVariant)
  if (!variant) {
    return false
  }

  if (normalizedText.includes(variant)) {
    return true
  }

  if (variant.length >= 3 && /[а-я]/u.test(variant)) {
    return normalizedText.includes(`${variant}у`) || normalizedText.includes(`${variant}а`) || normalizedText.includes(`${variant}ом`)
  }

  return false
}

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readFridayBackendToken(): Promise<string> {
  const raw = await readFile(FRIDAY_BACKEND_SESSION_PATH, 'utf8')
  const parsed = JSON.parse(raw) as { appToken?: unknown; appRefreshToken?: unknown; session?: { token?: unknown } }
  const appToken = typeof parsed.appToken === 'string' ? parsed.appToken.trim() : ''
  if (appToken && isJwtExpiringSoon(appToken)) {
    const refreshed = await refreshFridayEcosystemToken(parsed)
    if (refreshed) {
      return refreshed
    }
  }

  const token = appToken || (typeof parsed.session?.token === 'string' ? parsed.session.token.trim() : '')
  if (!token) {
    throw new Error('Friday backend session token is missing.')
  }
  return token
}

async function refreshFridayEcosystemToken(sessionState: { appToken?: unknown; appRefreshToken?: unknown; session?: unknown }) {
  const refreshToken = typeof sessionState.appRefreshToken === 'string' ? sessionState.appRefreshToken.trim() : ''
  if (!refreshToken) {
    return null
  }

  for (const body of [{ refreshToken }, { token: refreshToken }, { refresh_token: refreshToken }]) {
    try {
      const response = await fetch(`${ECOSYSTEM_API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        continue
      }

      const payload = await response.json() as { accessToken?: unknown; refreshToken?: unknown }
      const accessToken = typeof payload.accessToken === 'string' ? payload.accessToken.trim() : ''
      if (!accessToken) {
        continue
      }

      await writeFile(
        FRIDAY_BACKEND_SESSION_PATH,
        `${JSON.stringify({
          ...sessionState,
          appToken: accessToken,
          appRefreshToken: typeof payload.refreshToken === 'string' && payload.refreshToken.trim() ? payload.refreshToken.trim() : refreshToken,
          updatedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        'utf8',
      )
      return accessToken
    } catch {
      // Try the next common refresh payload shape.
    }
  }

  return null
}

async function readFridayBackendBaseUrl(): Promise<string> {
  if (await hasFridayEcosystemToken()) {
    return ECOSYSTEM_API_BASE_URL
  }

  try {
    const raw = await readFile(FRIDAY_BACKEND_CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as { baseUrl?: unknown }
    if (typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()) {
      return parsed.baseUrl.trim().replace(/\/+$/, '')
    }
  } catch {
    // Fall back to the local desktop backend URL.
  }

  return 'http://127.0.0.1:3010'
}

async function hasFridayEcosystemToken(): Promise<boolean> {
  try {
    const raw = await readFile(FRIDAY_BACKEND_SESSION_PATH, 'utf8')
    const parsed = JSON.parse(raw) as { appToken?: unknown }
    return typeof parsed.appToken === 'string' && parsed.appToken.trim().length > 0
  } catch {
    return false
  }
}

function extractCollection(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) {
    return raw
  }

  if (!raw || typeof raw !== 'object') {
    return []
  }

  const record = raw as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value
    }
  }

  const data = record.data
  if (Array.isArray(data)) {
    return data
  }

  if (data && typeof data === 'object') {
    return extractCollection(data, keys)
  }

  return []
}

function isJwtExpiringSoon(token: string): boolean {
  const parts = token.split('.')
  if (parts.length < 2) {
    return false
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown }
    if (typeof payload.exp !== 'number') {
      return false
    }
    return payload.exp * 1000 <= Date.now() + 5 * 60_000
  } catch {
    return false
  }
}

function renderWorkspaceMemorySnapshot(memories: FridayMemoryRecord[], sessionUser: FridaySessionUser | null) {
  const merged = mergeWorkspaceMemories(memories)
  const userName = sessionUser?.displayName || selectUserName(merged)
  const timezone = sessionUser?.timezone ?? null
  const lines = [USER_MEMORY_BLOCK_START, '## Friday Session Context', '']

  if (sessionUser) {
    lines.push(`- Authenticated user: ${sessionUser.displayName} <${sessionUser.email}>`)
    if (timezone) {
      lines.push(`- Timezone: ${timezone}`)
    }
    lines.push('- Scope rule: use only this authenticated user context. Never assume or expose data from other users.')
    lines.push('')
  }

  lines.push('## Durable Memory Snapshot', '')

  for (const memory of merged.slice(0, 12)) {
    const parts = []
    if (memory.summary) {
      parts.push(memory.summary)
    }
    if (memory.aliases.length > 0) {
      parts.push(`Aliases: ${memory.aliases.join(', ')}`)
    }
    if (memory.links.length > 0) {
      parts.push(`Links: ${memory.links.join(', ')}`)
    }
    lines.push(`- [${memory.category}] ${memory.title}: ${parts.join(' | ') || 'Stored memory.'}`)
  }

  if (merged.length === 0) {
    lines.push('- No durable memory records for the current authenticated user yet.')
  }

  lines.push('', USER_MEMORY_BLOCK_END)

  return {
    userName,
    timezone,
    block: lines.join('\n'),
  }
}

function renderWorkspaceUserDataSnapshot(snapshot: EcosystemUserDataSnapshot, sessionUser: FridaySessionUser | null) {
  const profile = snapshot.profile
  const userName = profile.displayName || sessionUser?.displayName || profile.email || null
  const timezone = profile.settings?.timezone ?? sessionUser?.timezone ?? null
  const lines = [USER_MEMORY_BLOCK_START, '## Friday Synced User Data', '']

  lines.push(`- Authenticated user: ${userName || 'signed-in user'}${profile.email ? ` <${profile.email}>` : ''}`)
  if (timezone) {
    lines.push(`- Timezone: ${timezone}`)
  }
  lines.push(`- Snapshot generated: ${snapshot.generatedAt}`)
  lines.push(`- Source: ${snapshot.source}`)
  lines.push('- Scope rule: use only this authenticated user context. Never assume or expose data from other users.')
  lines.push('- Local rule: use this synced snapshot for read-only questions; call Friday tools only when fresh reads or edits are needed.')
  lines.push('')
  lines.push('## Counts', '')
  lines.push(
    `- notes=${snapshot.counts.notes}, tasks=${snapshot.counts.tasks}, memory=${snapshot.counts.memory}, projects=${snapshot.counts.projects + snapshot.counts.xVextaProjects}, documents=${snapshot.counts.documents + snapshot.counts.xVextaNotes}, inbox=${snapshot.counts.inbox}`,
  )
  lines.push('')

  appendSnapshotPreview(lines, 'Notes', snapshot.entities.notes, (note) => `${note.title || 'Untitled'}: ${trimWorkspaceText(note.body)}`)
  appendSnapshotPreview(lines, 'Tasks', snapshot.entities.tasks, (task) => {
    const due = task.dueAt ? `, due ${task.dueAt}` : ''
    return `${task.title} (${task.status}${due})`
  })
  appendSnapshotPreview(lines, 'Memory', snapshot.entities.memory, (memory) => `[${memory.category}] ${memory.title}: ${trimWorkspaceText(memory.summary || memory.content)}`)
  appendSnapshotPreview(lines, 'Projects', snapshot.entities.xVextaProjects, (project) => `${project.name}: ${trimWorkspaceText(project.summary || project.code)}`)
  appendSnapshotPreview(lines, 'Documents', snapshot.entities.xVextaNotes, (note) => `${note.title}: ${trimWorkspaceText(note.summary || note.status)}`)
  appendSnapshotPreview(lines, 'Recommendations', snapshot.recommendations, (signal) => `${signal.title}: ${trimWorkspaceText(signal.body)}`)

  if (snapshot.errors.length > 0) {
    lines.push('## Sync Warnings', '')
    for (const error of snapshot.errors.slice(0, 6)) {
      lines.push(`- ${error}`)
    }
    lines.push('')
  }

  lines.push(USER_MEMORY_BLOCK_END)

  return {
    userName,
    timezone,
    block: lines.join('\n'),
  }
}

function appendSnapshotPreview<T>(lines: string[], title: string, items: T[], format: (item: T) => string) {
  const preview = items.slice(0, 12).map(format).filter(Boolean)
  if (preview.length === 0) {
    return
  }

  lines.push(`## ${title}`, '')
  for (const item of preview) {
    lines.push(`- ${item}`)
  }
  lines.push('')
}

function trimWorkspaceText(value: unknown, limit = 180) {
  const normalized = normalizeNonEmptyText(value)?.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function mergeWorkspaceMemories(memories: FridayMemoryRecord[]) {
  const merged = new Map<string, WorkspaceMemorySnapshot>()

  for (const memory of memories) {
    const title = normalizeWorkspaceLookup(memory.title || memory.slug || memory.id)
    if (!title) {
      continue
    }

    const key = `${memory.category}:${normalizeWorkspaceLookup(memory.title || memory.slug || memory.id)}`
    const current = merged.get(key)
    const summary = normalizeNonEmptyText(memory.summary)
    const aliases = normalizeStringList(memory.aliases)
    const links = normalizeStringList(memory.links)

    if (!current) {
      merged.set(key, {
        category: memory.category || 'unknown',
        title: normalizeNonEmptyText(memory.title) || normalizeNonEmptyText(memory.slug) || memory.id,
        summary: summary || '',
        aliases,
        links,
      })
      continue
    }

    current.summary = mergeWorkspaceSnippet(current.summary, summary)
    current.aliases = mergeWorkspaceList(current.aliases, aliases)
    current.links = mergeWorkspaceList(current.links, links)
  }

  return Array.from(merged.values())
}

function selectUserName(memories: WorkspaceMemorySnapshot[]): string | null {
  const explicitProfile = memories.find(
    (memory) =>
      memory.category === 'people' &&
      /(?:\u0438\u043c\u044f \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f|\u0432\u0430\u0436\u043d\u043e \u0434\u043b\u044f \u043e\u0431\u0449\u0435\u043d\u0438\u044f|user)/i.test(
        memory.summary,
      ),
  )
  if (explicitProfile) {
    return explicitProfile.title
  }

  return memories.find((memory) => memory.category === 'people')?.title ?? null
}

function applyWorkspaceMemorySnapshot(
  currentDoc: string,
  snapshot: {
    userName: string | null
    timezone: string | null
    block: string
  },
) {
  const baseDoc = currentDoc.trim()
    ? currentDoc
    : ['# USER.md - About Your Human', '', '- **Name:**', '- **What to call them:**', '- **Pronouns:** _(optional)_', '- **Timezone:**', '- **Notes:**', '', '## Context', '', '- Durable details should accumulate here over time.', ''].join('\n')

  const withName = snapshot.userName
    ? baseDoc
        .replace(/^- \*\*Name:\*\*.*$/m, `- **Name:** ${snapshot.userName}`)
        .replace(/^- \*\*What to call them:\*\*.*$/m, `- **What to call them:** ${snapshot.userName}`)
    : baseDoc

  const withTimezone = snapshot.timezone
    ? withName.replace(/^- \*\*Timezone:\*\*.*$/m, `- **Timezone:** ${snapshot.timezone}`)
    : withName

  const blockPattern = new RegExp(`${escapeRegExp(USER_MEMORY_BLOCK_START)}[\\s\\S]*?${escapeRegExp(USER_MEMORY_BLOCK_END)}`, 'm')
  const nextDoc = blockPattern.test(withTimezone)
    ? withTimezone.replace(blockPattern, snapshot.block)
    : `${withTimezone.trimEnd()}\n\n${snapshot.block}\n`

  return `${nextDoc.trimEnd()}\n`
}

async function ensureManagedWorkspaceBaseFiles() {
  const files = new Map<string, string>([
    [
      'AGENTS.md',
      [
        '# Friday Agent',
        '',
        'You are Friday, a local Windows desktop agent. Help the user through the available tools and answer briefly when no tool is needed.',
        'This is a direct one-to-one desktop chat. Always return a visible user-facing answer in the same language as the user.',
        'Never output NO_REPLY, never use message/session delivery tools, and never forward a normal user message to another session.',
        'After a successful tool call, describe the completed result in past tense instead of saying what will happen.',
        'Use synced user data from USER.md as context, but do not leak private context unless the user asks about it.',
        '',
      ].join('\n'),
    ],
    ['SOUL.md', '# Friday Style\n\nBe concise, practical, and friendly.\n'],
    ['IDENTITY.md', '# Identity\n\nName: Friday\nRuntime: local desktop agent\n'],
    ['HEARTBEAT.md', '# Heartbeat\n\nNo proactive heartbeat instructions.\n'],
  ])

  for (const [fileName, content] of files) {
    const filePath = path.join(OPENCLAW_WORKSPACE_DIR, fileName)
    const current = await safeReadUtf8(filePath)
    if (current.trim() !== content.trim()) {
      await writeFile(filePath, content, 'utf8')
    }
  }
}

async function ensureWorkspaceToolsPolicy() {
  const currentDoc = await safeReadUtf8(OPENCLAW_TOOLS_PATH)
  const baseDoc = currentDoc.trim()
    ? currentDoc
    : [
        '# TOOLS.md - Local Notes',
        '',
        'This file contains environment-specific tool guidance for this desktop agent.',
        '',
      ].join('\n')
  const policy = [
    FRIDAY_DESKTOP_POLICY_START,
    '## Friday Desktop Runtime',
    '',
    '- This is a local desktop agent running on the user machine. Do not claim that local apps, files, shell, or browser automation are impossible when the matching tools are available.',
    '- For requests like opening Calculator, Notepad, Explorer, a browser, or local files, use the real callable tools named exec or process with Windows commands such as PowerShell Start-Process, notepad.exe, explorer.exe, or start.',
    '- For Calculator on Windows, prefer PowerShell: Start-Process calc.exe.',
    '- Tool arguments must match the schema types: booleans are true/false, numbers are numbers, and omitted optional values should not be sent as the string "null".',
    '- Do not call a tool named pc-apps, pc-shell, pc-files, or pc-web: those are skill/workflow names, not callable tool names in this request.',
    '- Safe local actions such as opening apps, reading files, creating user-requested files, sorting files in a provided folder, and browser automation are allowed without extra confirmation.',
    '- Ask for confirmation before destructive or irreversible actions, deleting user files outside an explicit temporary/test folder, sending external messages, payments, or publishing content.',
    '- If a tool fails, report the real failure and try a safe alternate local route when one exists; never say success unless the action actually completed.',
    '',
    FRIDAY_DESKTOP_POLICY_END,
  ].join('\n')
  const blockPattern = new RegExp(`${escapeRegExp(FRIDAY_DESKTOP_POLICY_START)}[\\s\\S]*?${escapeRegExp(FRIDAY_DESKTOP_POLICY_END)}`, 'm')
  const nextDoc = blockPattern.test(baseDoc)
    ? baseDoc.replace(blockPattern, policy)
    : `${baseDoc.trimEnd()}\n\n${policy}\n`

  if (nextDoc !== currentDoc) {
    await writeFile(OPENCLAW_TOOLS_PATH, `${nextDoc.trimEnd()}\n`, 'utf8')
  }
}

function mergeWorkspaceSnippet(left: string, right: string | undefined) {
  const values = [left, right].map((entry) => normalizeNonEmptyText(entry)).filter(Boolean) as string[]
  return [...new Map(values.map((entry) => [entry.toLowerCase(), entry])).values()].join(' | ')
}

function mergeWorkspaceList(left: string[], right: string[]) {
  const values = [...left, ...right].map((entry) => normalizeNonEmptyText(entry)).filter(Boolean) as string[]
  return [...new Map(values.map((entry) => [entry.toLowerCase(), entry])).values()]
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[]
  }

  return value
    .map((entry) => normalizeNonEmptyText(entry))
    .filter((entry): entry is string => Boolean(entry))
}

function normalizeWorkspaceLookup(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeNonEmptyText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function safeReadUtf8(filePath: string) {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type FridayMemoryRecord = {
  id: string
  category?: string
  title?: string
  slug?: string
  summary?: string
  aliases?: unknown
  links?: unknown
}

type WorkspaceMemorySnapshot = {
  category: string
  title: string
  summary: string
  aliases: string[]
  links: string[]
}

function ensureObject(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = root[key]
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>
  }

  const created: Record<string, unknown> = {}
  root[key] = created
  return created
}

function applySkillProfile(skills: Record<string, unknown>, allowedSkills: string[]): void {
  const entries = ensureObject(skills, 'entries')
  const allowed = new Set(allowedSkills)

  for (const skillKey of MANAGED_SKILL_KEYS) {
    const entry = ensureObject(entries, skillKey)
    entry.enabled = allowed.has(skillKey)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pushStartupLogLine(target: string[], chunk: string) {
  for (const line of chunk.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    target.push(line)
    if (target.length > 12) {
      target.shift()
    }
  }
}

function buildGatewayStartupError(logPath: string, startupLog: string[]) {
  const details = startupLog.length > 0 ? ` Последние строки: ${startupLog.join(' | ')}` : ''
  return `Не удалось запустить локальный сервис агента. Лог агента: ${logPath}.${details}`
}

function looksLikeDesktopActionRequest(message: string) {
  const value = message.trim().toLowerCase()
  if (!value) {
    return false
  }

  return DESKTOP_ACTION_PATTERNS.some((pattern) => pattern.test(value))
}

function buildDesktopActionRetryPrompt(message: string) {
  return [
    message,
    '',
    'Important desktop execution note:',
    '- This is a local Windows machine and you do have desktop/runtime tools in this session.',
    '- For application launch or switching tasks, call a real available tool such as exec or process.',
    '- Prefer a real Windows launch command, for example PowerShell Start-Process calc.exe, notepad.exe, explorer.exe, or Start-Process when appropriate.',
    '- Tool arguments must use real booleans/numbers/nulls, not string values like "false" or "null".',
    '- Do not call a tool named pc-apps or pc-shell; those are skill names, not callable tool names.',
    '- Do not answer with a capability refusal unless a real tool call failed and you can name that exact failure.',
  ].join('\n')
}

type DesktopActionVerification = {
  kind: 'calculator'
  beforeCount: number
}

async function captureDesktopActionVerification(message: string): Promise<DesktopActionVerification | null> {
  const normalized = message.trim().toLowerCase().replace(/ё/g, 'е')
  if (/\b(calc|calculator)\b/i.test(normalized) || normalized.includes('калькулятор')) {
    return {
      kind: 'calculator',
      beforeCount: await countWindowsProcesses(['CalculatorApp', 'calc']),
    }
  }

  return null
}

async function verifyDesktopActionCompleted(snapshot: DesktopActionVerification | null): Promise<string | null> {
  if (!snapshot) {
    return null
  }

  if (snapshot.kind === 'calculator') {
    const afterCount = await countWindowsProcesses(['CalculatorApp', 'calc'])
    return afterCount > snapshot.beforeCount || afterCount > 0 ? 'Калькулятор открыт.' : null
  }

  return null
}

async function countWindowsProcesses(processNames: string[]): Promise<number> {
  const quotedNames = processNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(',')
  const { stdout } = await execFileText(
    'powershell.exe',
    ['-NoProfile', '-Command', `@($ErrorActionPreference='SilentlyContinue'; Get-Process -Name ${quotedNames}).Count`],
    {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    },
  )
  const count = Number.parseInt(stdout.trim(), 10)
  return Number.isFinite(count) ? count : 0
}

const DESKTOP_ACTION_PATTERNS = [
  /\bopen\b.*\b(calculator|calc|notepad|browser|chrome|edge|firefox|terminal|cmd|powershell|explorer)\b/i,
  /\blaunch\b.*\b(app|application|calculator|browser|terminal)\b/i,
  /\bstart\b.*\b(app|application|calculator|browser|terminal)\b/i,
  /\bclose\b.*\b(app|application|window|browser)\b/i,
  /\bswitch\b.*\b(app|application|window)\b/i,
  /открой.*(калькулятор|браузер|терминал|проводник|блокнот)/i,
  /запусти.*(калькулятор|браузер|терминал|проводник|блокнот)/i,
  /закрой.*(приложение|окно|браузер|калькулятор)/i,
]

async function canConnectToPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })

    const finish = (value: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function findBundledCli(): Promise<CliTarget | null> {
  const searchRoots = [
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'openclaw-runtime') : '',
    path.join(process.cwd(), 'vendor', 'openclaw-runtime'),
  ].filter(Boolean)

  for (const root of searchRoots) {
    const nodePath = path.join(root, 'node.exe')
    const nodeBinaryPath = path.join(root, 'node.bin')
    const scriptPath = path.join(root, 'node_modules', 'openclaw', 'openclaw.mjs')
    const version = await readOpenClawVersion(path.join(root, 'node_modules', 'openclaw', 'package.json'))
    if ((await exists(nodePath)) && (await isBundledRuntimeRootValid(root))) {
      return {
        command: nodePath,
        argsPrefix: [scriptPath],
        displayPath: scriptPath,
        version,
      }
    }

    if ((await exists(nodeBinaryPath)) && (await isBundledRuntimeRootValid(root))) {
      const extractedNodePath = await materializeBundledNodeExecutable(nodeBinaryPath)
      return {
        command: extractedNodePath,
        argsPrefix: [scriptPath],
        displayPath: scriptPath,
        version,
      }
    }
  }

  const bundledArchivePath = typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'openclaw-runtime.zip') : ''
  if (await exists(bundledArchivePath)) {
    const extractedRoot = await ensureBundledRuntimeExtracted(bundledArchivePath)
    const nodeBinaryPath = path.join(extractedRoot, 'node.bin')
    const scriptPath = path.join(extractedRoot, 'node_modules', 'openclaw', 'openclaw.mjs')
    const version = await readOpenClawVersion(path.join(extractedRoot, 'node_modules', 'openclaw', 'package.json'))
    if ((await exists(nodeBinaryPath)) && (await exists(scriptPath))) {
      const extractedNodePath = await materializeBundledNodeExecutable(nodeBinaryPath)
      return {
        command: extractedNodePath,
        argsPrefix: [scriptPath],
        displayPath: scriptPath,
        version,
      }
    }
  }

  return null
}

async function materializeBundledNodeExecutable(binaryPath: string): Promise<string> {
  const targetDir = path.join(os.tmpdir(), 'friday-runtime')
  const binaryStat = await stat(binaryPath)
  const safeVersion = `${binaryStat.size}-${Math.trunc(binaryStat.mtimeMs)}`.replace(/[^0-9-]/g, '')
  const targetPath = path.join(targetDir, `node-${safeVersion}.exe`)
  await mkdir(targetDir, { recursive: true })
  if (!(await exists(targetPath))) {
    await copyFile(binaryPath, targetPath)
  }
  return targetPath
}

async function ensureBundledRuntimeExtracted(archivePath: string): Promise<string> {
  const targetDir = path.join(os.tmpdir(), 'friday-runtime', 'openclaw-runtime')
  const markerPath = path.join(targetDir, '.bundle-version')
  const archiveStat = await stat(archivePath)
  const bundleVersion = `${archiveStat.size}:${archiveStat.mtimeMs}`

  if ((await isBundledRuntimeRootValid(targetDir)) && (await hasMatchingBundleVersion(markerPath, bundleVersion))) {
    return targetDir
  }

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  const archive = new AdmZip(archivePath)
  archive.extractAllTo(targetDir, true)
  if (!(await isBundledRuntimeRootValid(targetDir))) {
    await rm(markerPath, { force: true })
    throw new Error(
      `Bundled agent runtime extraction is incomplete at ${targetDir}. ` +
        'Expected agent runtime build output was not found after extracting the bundled archive.',
    )
  }
  await writeFile(markerPath, bundleVersion, 'utf8')
  return targetDir
}

async function isBundledRuntimeRootValid(root: string): Promise<boolean> {
  const requiredPaths = [
    path.join(root, 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(root, 'node_modules', 'openclaw', 'package.json'),
    path.join(root, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'),
  ]

  for (const requiredPath of requiredPaths) {
    if (!(await exists(requiredPath))) {
      return false
    }
  }

  return (
    (await exists(path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.js'))) ||
    (await exists(path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.mjs')))
  )
}

async function hasMatchingBundleVersion(markerPath: string, bundleVersion: string) {
  try {
    const current = await readFile(markerPath, 'utf8')
    return current.trim() === bundleVersion
  } catch {
    return false
  }
}

async function readOpenClawVersion(packageJsonPath: string): Promise<string | null> {
  try {
    const raw = await readFile(packageJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

async function readInstalledOpenClawVersion(commandPath: string): Promise<string | null> {
  const installRoot = path.dirname(commandPath)
  const candidates = [
    path.join(installRoot, 'package.json'),
    path.join(installRoot, 'node_modules', 'openclaw', 'package.json'),
  ]

  for (const candidate of candidates) {
    const version = await readOpenClawVersion(candidate)
    if (version) {
      return version
    }
  }

  return null
}

function compareCliTargets(left: CliTarget, right: CliTarget): number {
  const versionDiff = compareVersions(left.version, right.version)
  if (versionDiff !== 0) {
    return versionDiff
  }

  const leftIsCmd = left.command.toLowerCase().endsWith('.cmd')
  const rightIsCmd = right.command.toLowerCase().endsWith('.cmd')
  if (leftIsCmd !== rightIsCmd) {
    return leftIsCmd ? 1 : -1
  }

  const leftIsBundled = isBundledCliTarget(left)
  const rightIsBundled = isBundledCliTarget(right)
  if (leftIsBundled !== rightIsBundled) {
    return leftIsBundled ? 1 : -1
  }

  return 0
}

function isBundledCliTarget(target: CliTarget): boolean {
  const normalized = target.displayPath.replace(/\//g, path.sep).toLowerCase()
  return (
    normalized.includes(`${path.sep}vendor${path.sep}openclaw-runtime${path.sep}`) ||
    normalized.includes(`${path.sep}resources${path.sep}openclaw-runtime${path.sep}`)
  )
}

function compareVersions(left: string | null, right: string | null): number {
  const leftParts = normalizeVersion(left)
  const rightParts = normalizeVersion(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart !== rightPart) {
      return leftPart - rightPart
    }
  }

  return 0
}

function normalizeVersion(value: string | null): number[] {
  if (!value) {
    return [0]
  }

  const parts = value
    .split(/[^0-9]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))

  return parts.length > 0 ? parts : [0]
}

function resolveSpawnCommand(target: CliTarget, args: string[]): [string, string[]] {
  const fullArgs = [...target.argsPrefix, ...args]
  if (target.command.toLowerCase().endsWith('.cmd')) {
    return ['cmd.exe', ['/c', target.command, ...fullArgs]]
  }

  return [target.command, fullArgs]
}

function execCli(
  target: CliTarget,
  args: string[],
  options: ExecTextOptions,
): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = [...target.argsPrefix, ...args]
  if (target.command.toLowerCase().endsWith('.cmd')) {
    return execFileText('cmd.exe', ['/c', target.command, ...fullArgs], options)
  }

  return execFileText(target.command, fullArgs, options)
}

type ExecTextOptions = {
  timeout?: number
  windowsHide?: boolean
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  resolveOnJsonStdout?: boolean
}

function execFileText(command: string, args: string[], options: ExecTextOptions): Promise<{ stdout: string; stderr: string }> {
  if (options.resolveOnJsonStdout) {
    return execFileTextStreaming(command, args, options)
  }

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...options,
        encoding: 'utf8',
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

function execFileTextStreaming(
  command: string,
  args: string[],
  options: ExecTextOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      windowsHide: options.windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let jsonReadyTimer: NodeJS.Timeout | null = null
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024

    const cleanup = () => {
      if (jsonReadyTimer) {
        clearTimeout(jsonReadyTimer)
        jsonReadyTimer = null
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
    }

    const finish = (result: { stdout: string; stderr: string }) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (!child.killed) {
        child.kill()
      }
      resolve(result)
    }

    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (!child.killed) {
        child.kill()
      }
      reject(error)
    }

    const timeoutTimer =
      options.timeout && options.timeout > 0
        ? setTimeout(() => fail(new Error(`Command timed out after ${options.timeout}ms`)), options.timeout)
        : null

    const scheduleJsonFinish = () => {
      if (!isCompleteJsonStdout(stdout) || jsonReadyTimer) {
        return
      }
      jsonReadyTimer = setTimeout(() => finish({ stdout, stderr }), 250)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > maxBuffer) {
        fail(new Error(`Command stdout exceeded maxBuffer (${maxBuffer} bytes)`))
        return
      }
      scheduleJsonFinish()
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > maxBuffer) {
        fail(new Error(`Command stderr exceeded maxBuffer (${maxBuffer} bytes)`))
      }
    })
    child.once('error', fail)
    child.once('close', (code) => {
      if (settled) {
        return
      }
      cleanup()
      if (code && code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function isCompleteJsonStdout(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') {
      return false
    }
    const record = parsed as Record<string, unknown>
    return Array.isArray(record.payloads) || Boolean(record.result) || record.status === 'ok'
  } catch {
    return false
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function isRetryableProxyError(error: unknown): boolean {
  const message = formatError(error).toLowerCase()
  return (
    message.includes('user location is not supported for the api use') ||
    message.includes('failed_precondition') ||
    message.includes('llm request timed out') ||
    message.includes('fetch failed') ||
    message.includes('gateway closed')
  )
}

function normalizeProxyProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>
  const inbounds = Array.isArray(clone.inbounds) ? clone.inbounds : []
  for (const entry of inbounds) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const inbound = entry as Record<string, unknown>
    const protocol = String(inbound.protocol ?? '')
    const tag = String(inbound.tag ?? '')
    if (protocol === 'socks' || tag === 'socks') {
      inbound.listen = '127.0.0.1'
      inbound.port = APP_PROXY_SOCKS_PORT
      continue
    }
    if (protocol === 'http' || tag === 'http') {
      inbound.listen = '127.0.0.1'
      inbound.port = APP_PROXY_HTTP_PORT
      continue
    }
    if (protocol === 'dokodemo-door' || tag === 'metrics_in') {
      inbound.listen = '127.0.0.1'
      inbound.port = APP_PROXY_METRICS_PORT
    }
  }
  clone.inbounds = inbounds
  return clone
}

function isAgentErrorReply(replyText: string): boolean {
  if (
    /request timed out before a response was generated/i.test(replyText) ||
    /LLM request timed out/i.test(replyText) ||
    /failed to call a function/i.test(replyText) ||
    /API rate limit reached/i.test(replyText) ||
    /HTTP 403:\s*Forbidden/i.test(replyText)
  ) {
    return true
  }

  return (
    replyText.includes('Провайдер модели отклонил запрос по региону') ||
    replyText.includes('User location is not supported for the API use.')
  )
}

function isRawToolEchoReply(replyText: string): boolean {
  const normalized = replyText.trim()
  return (
    /function call/i.test(normalized) ||
    /"name"\s*:\s*"exec"/i.test(normalized) ||
    /"parameters"\s*:\s*\{/i.test(normalized)
  )
}

function toUserFacingAgentError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    if (/HTTP 403:\s*Forbidden/i.test(error.message)) {
      return 'Провайдер модели отклонил запрос. Friday попробует обновить подключение; если ошибка повторится, нужно заменить managed API key.'
    }
    if (/API rate limit reached|Request too large|tokens per minute|TPM/i.test(error.message)) {
      return 'Провайдер модели достиг лимита. Попробуйте ещё раз через минуту.'
    }
    if (/request timed out before a response was generated|LLM request timed out/i.test(error.message)) {
      return 'Агент не успел завершить ответ вовремя. Если это была команда для ПК, Friday проверила результат действия.'
    }
    return error.message
  }

  return 'Не удалось выполнить команду агента.'
}
