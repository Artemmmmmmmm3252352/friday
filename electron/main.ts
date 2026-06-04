import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import type {
  AgentMailConfigInput,
  AgentActionRequest,
  AgentConfirmationInput,
  AgentEntityReference,
  AgentProgressEvent,
  AgentMessageInput,
  AgentUserDataSearchInput,
  AuthLoginInput,
  AuthRegisterInput,
  BackendConfig,
  BackendSessionState,
  BeamngCommandInput,
  BeamngConfig,
  CreateAgentMailMessageInput,
  CreateAppTokenInput,
  CreateMemoryInput,
  EcosystemUserDataActionRequest,
  CreateNoteInput,
  CreateReminderInput,
  CreateTaskInput,
  DesktopWindowState,
    Diagnostics,
    ListAgentMailContactsInput,
    ListAgentMailMessagesInput,
  LocalSessionInput,
  PersistedAppState,
  ScheduleTextInput,
  SendTextInput,
  SendTextResult,
    SystemSnapshot,
  TelegramRemoteConfig,
    UpsertAgentMailContactInput,
    UpsertAgentMailAccountInput,
  VpnConfig,
  UpdateNoteInput,
  UpdateMemoryInput,
  UpdateReminderInput,
  UpdateSettingsInput,
  UpdateTaskInput,
  VoiceCancelSessionInput,
  VoiceFinishSessionInput,
  VoicePushAudioInput,
  VoiceRuntimeConfig,
  VoiceRuntimeEvent,
  VoiceSpeakInput,
} from '../src/shared/contracts'
import { BackendConfigService } from './services/backendConfigService'
import { BackendSessionService } from './services/backendSessionService'
import { BackendSyncService } from './services/backendSyncService'
import { BackendRuntimeService } from './services/backendRuntimeService'
import { BeamngConfigService } from './services/beamngConfigService'
import { BeamngRuntimeService } from './services/beamngRuntimeService'
import { EnvConfigService } from './services/envConfigService'
import { EcosystemUserDataSyncService } from './services/ecosystemUserDataSyncService'
import { FridayLogger } from './services/logger'
import { MessageQuotaService } from './services/messageQuotaService'
import { OpenClawService } from './services/openclawService'
import { SchedulerService } from './services/schedulerService'
import { StoreService } from './services/storeService'
import { SystemMetricsService } from './services/systemMetricsService'
import { TelegramRemoteService } from './services/telegramRemoteService'
import { VpnConfigService } from './services/vpnConfigService'
import { VpnRuntimeService } from './services/vpnRuntimeService'
import { VoiceRuntimeService } from './services/voiceRuntimeService'
import { WhisperService } from './services/whisperService'

let mainWindow: BrowserWindow | null = null

app.disableHardwareAcceleration()

const userDataPath = app.getPath('userData')
const logger = new FridayLogger(userDataPath)
const storeService = new StoreService(userDataPath)
const backendConfigService = new BackendConfigService(userDataPath)
const backendSessionService = new BackendSessionService(userDataPath)
const beamngConfigService = new BeamngConfigService(userDataPath)
const vpnConfigService = new VpnConfigService(userDataPath)
const backendRuntimeService = new BackendRuntimeService(app.getAppPath(), logger)
const backendSyncService = new BackendSyncService(backendConfigService, backendSessionService, backendRuntimeService, logger)
const ecosystemUserDataSyncService = new EcosystemUserDataSyncService(userDataPath, backendSyncService, logger)
const envConfigService = new EnvConfigService()
const messageQuotaService = new MessageQuotaService(userDataPath, backendSessionService, logger)
const openClawService = new OpenClawService(userDataPath, logger)
const beamngRuntimeService = new BeamngRuntimeService(app.getAppPath(), beamngConfigService, logger, openClawService)
const schedulerService = new SchedulerService(openClawService)
const whisperService = new WhisperService(userDataPath, logger)
const voiceRuntimeRoot = app.isPackaged ? path.join(process.resourcesPath, 'voice-runtime') : app.getAppPath()
const voiceRuntimeService = new VoiceRuntimeService(voiceRuntimeRoot, userDataPath, logger, (event) => {
  sendVoiceRuntimeEvent(event)
})
const systemMetricsService = new SystemMetricsService()
const vpnRuntimeService = new VpnRuntimeService(userDataPath, vpnConfigService, logger)
const telegramRemoteService = new TelegramRemoteService(userDataPath, logger, {
  async sendAgentText(text, sessionId) {
    const quota = await messageQuotaService.consume({ route: 'telegram_chat' })
    if (!quota.allowed) {
      return quota.message
    }
    const result = await sendViaLocalOpenClaw({ sessionId, text })
    return result?.replyText ?? 'Агент не вернул текстовый ответ.'
  },
})
const electronDir = path.dirname(fileURLToPath(import.meta.url))

function sendVoiceRuntimeEvent(event: VoiceRuntimeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  const { webContents } = mainWindow
  if (webContents.isDestroyed()) {
    return
  }

  try {
    webContents.send('voice-runtime:event', event)
  } catch (error) {
    void logger.error(
      `Failed to forward voice runtime event: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#09131b',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    title: 'Friday',
    webPreferences: {
      preload: path.join(electronDir, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    if (mainWindow?.isDestroyed()) {
      mainWindow = null
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }
}

async function buildDiagnostics(): Promise<Diagnostics> {
  const openClawDiagnostics = await openClawService.getDiagnostics()
  const whisper = await whisperService.getDiagnostics()

  return {
    ...openClawDiagnostics,
    whisper,
    mic: {
      label: 'Микрофон',
      status: 'unknown',
      detail: 'Разрешение на микрофон проверяется в интерфейсе приложения.',
    },
  }
}

async function buildSystemSnapshot(): Promise<SystemSnapshot> {
  return systemMetricsService.getSnapshot()
}

async function restartAsAdministrator(): Promise<{ ok: boolean }> {
  if (process.platform !== 'win32') {
    throw new Error('Administrator restart is only supported on Windows.')
  }

  const executable = process.execPath
  const launchArgs = app.isPackaged ? [] : [app.getAppPath()]
  const argumentList = launchArgs.length > 0 ? ` -ArgumentList ${quotePowerShell(launchArgs.join(' '))}` : ''
  const command = `Start-Process -FilePath ${quotePowerShell(executable)}${argumentList} -Verb RunAs`
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })

  child.unref()
  setTimeout(() => app.quit(), 1200)
  return { ok: true }
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function registerIpc(): void {
  ipcMain.handle('app:get-diagnostics', async () => buildDiagnostics())
  ipcMain.handle('app:get-system-snapshot', async () => buildSystemSnapshot())

  ipcMain.handle('app:get-state', async () => storeService.loadState())
  ipcMain.handle('app:save-state', async (_event, state: PersistedAppState) => storeService.saveState(state))
  ipcMain.handle('app:get-ai-runtime-config', async () => envConfigService.loadAiRuntimeConfig())
  ipcMain.handle('app:restart-as-admin', async () => restartAsAdministrator())
  ipcMain.handle('agentmail:get-config', async () => {
    const installed = await openClawService.getAgentMailSkillInstalled()
    return envConfigService.loadAgentMailConfig(installed)
  })
  ipcMain.handle('agentmail:save-config', async (_event, config: AgentMailConfigInput) => {
    const installed = await openClawService.getAgentMailSkillInstalled()
    const saved = await envConfigService.saveAgentMailConfig(config, installed)
    await openClawService.stopManagedProcess()
    return saved
  })
  ipcMain.handle('agentmail:install-skill', async () => {
    const result = await openClawService.installAgentMailSkill()
    return result
  })
  ipcMain.handle('telegram:get-config', async () => telegramRemoteService.getConfig())
  ipcMain.handle('telegram:save-config', async (_event, config: TelegramRemoteConfig) => {
    return telegramRemoteService.saveConfig(config)
  })
  ipcMain.handle('telegram:get-state', async () => telegramRemoteService.getState())
  ipcMain.handle('telegram:start', async () => telegramRemoteService.start())
  ipcMain.handle('telegram:stop', async () => telegramRemoteService.stop())
  ipcMain.handle('telegram:create-pair-code', async () => telegramRemoteService.createPairCode())
  ipcMain.handle('telegram:remove-user', async (_event, id: number) => telegramRemoteService.removeUser(id))
  ipcMain.handle('gateway:ensure-running', async () => openClawService.ensureRunning())
  ipcMain.handle('scheduler:schedule-text', async (_event, input: ScheduleTextInput) => {
    return schedulerService.trySchedule(input.text, input.language)
  })

  ipcMain.handle('chat:new-session', async () => {
    const state = await storeService.createNewSession()
    return { sessionId: state.sessionId }
  })

  ipcMain.handle('chat:send-text', async (event, input: SendTextInput) => {
    const progress = createChatProgressEmitter(input, (progressEvent) => {
      event.sender.send('chat:agent-progress', progressEvent)
    })
    progress({
      stage: 'queued',
      status: 'active',
      label: 'Request accepted',
      detail: 'Friday is routing the request to the local desktop agent.',
      progress: 4,
    })
    try {
      const quota = await messageQuotaService.consume({ route: 'desktop_chat' })
      if (!quota.allowed) {
        progress({
          stage: 'completed',
          status: 'completed',
          label: 'Message limit reached',
          detail: quota.message,
          progress: 100,
        })
        return buildToolReply(quota.message, {
          route: 'message_quota_exceeded',
          quota: quota.state,
        })
      }

      await envConfigService.ensureManagedAiConfig()
      const result = await sendViaLocalOpenClaw(input, progress)
      progress({
        stage: 'completed',
        status: 'completed',
        label: 'Done',
        detail: 'Friday received the final answer.',
        progress: 100,
      })
      return result
    } catch (error) {
      progress({
        stage: 'error',
        status: 'error',
        label: 'Failed',
        detail: error instanceof Error ? error.message : String(error),
        progress: 100,
      })
      throw error
    }
  })

  ipcMain.handle('backend:get-config', async () => backendSyncService.getConfig())
  ipcMain.handle('backend:save-config', async (_event, config: BackendConfig) => backendSyncService.saveConfig(config))
  ipcMain.handle('backend:get-session-state', async () => backendSyncService.getSessionState())
  ipcMain.handle('backend:save-session-state', async (_event, state: BackendSessionState) => {
    return backendSyncService.saveSessionState(state)
  })
  ipcMain.handle('backend:clear-session-state', async () => backendSyncService.clearSessionState())
  ipcMain.handle('backend:ensure-local-session', async (_event, input: LocalSessionInput) => {
    return backendSyncService.ensureLocalSession(input)
  })
  ipcMain.handle('backend:register', async (_event, input: AuthRegisterInput) => backendSyncService.register(input))
  ipcMain.handle('backend:login', async (_event, input: AuthLoginInput) => {
    const session = await backendSyncService.login(input)
    void ecosystemUserDataSyncService.syncNow('login').catch(async (error) => {
      await logger.error(`Failed to sync ecosystem user data after login: ${error instanceof Error ? error.message : String(error)}`)
    })
    return session
  })
  ipcMain.handle('backend:create-app-token', async (_event, input: CreateAppTokenInput) => {
    return backendSyncService.createAppToken(input)
  })
  ipcMain.handle('backend:get-me', async () => backendSyncService.getMe())
  ipcMain.handle('backend:update-settings', async (_event, input: UpdateSettingsInput) => {
    return backendSyncService.updateSettings(input)
  })
  ipcMain.handle('backend:get-message-quota', async () => messageQuotaService.getState())
  ipcMain.handle('backend:consume-message-quota', async (_event, input) => messageQuotaService.consume(input))
  ipcMain.handle('backend:get-agent-mail-account', async () => backendSyncService.getAgentMailAccount())
  ipcMain.handle('backend:get-agent-mail-message', async (_event, id: string) => {
    return backendSyncService.getAgentMailMessage(id)
  })
  ipcMain.handle('backend:upsert-agent-mail-account', async (_event, input: UpsertAgentMailAccountInput) => {
    return backendSyncService.upsertAgentMailAccount(input)
  })
  ipcMain.handle('backend:list-agent-mail-messages', async (_event, input?: ListAgentMailMessagesInput) => {
    return backendSyncService.listAgentMailMessages(input)
  })
  ipcMain.handle('backend:list-agent-mail-contacts', async (_event, input?: ListAgentMailContactsInput) => {
    return backendSyncService.listAgentMailContacts(input)
  })
  ipcMain.handle('backend:upsert-agent-mail-contact', async (_event, input: UpsertAgentMailContactInput) => {
    return backendSyncService.upsertAgentMailContact(input)
  })
  ipcMain.handle('backend:delete-agent-mail-contact', async (_event, id: string) => {
    return backendSyncService.deleteAgentMailContact(id)
  })
  ipcMain.handle('backend:create-agent-mail-message', async (_event, input: CreateAgentMailMessageInput) => {
    return backendSyncService.createAgentMailMessage(input)
  })
  ipcMain.handle('backend:mark-agent-mail-message-read', async (_event, id: string) => {
    return backendSyncService.markAgentMailMessageRead(id)
  })
  ipcMain.handle('backend:list-notes', async () => backendSyncService.listNotes())
  ipcMain.handle('backend:create-note', async (_event, input: CreateNoteInput) => backendSyncService.createNote(input))
  ipcMain.handle('backend:update-note', async (_event, id: string, input: UpdateNoteInput) => {
    return backendSyncService.updateNote(id, input)
  })
  ipcMain.handle('backend:delete-note', async (_event, id: string) => backendSyncService.deleteNote(id))
  ipcMain.handle('backend:list-tasks', async () => backendSyncService.listTasks())
  ipcMain.handle('backend:create-task', async (_event, input: CreateTaskInput) => backendSyncService.createTask(input))
  ipcMain.handle('backend:update-task', async (_event, id: string, input: UpdateTaskInput) => {
    return backendSyncService.updateTask(id, input)
  })
  ipcMain.handle('backend:delete-task', async (_event, id: string) => backendSyncService.deleteTask(id))
  ipcMain.handle('backend:list-reminders', async () => backendSyncService.listReminders())
  ipcMain.handle('backend:create-reminder', async (_event, input: CreateReminderInput) => {
    return backendSyncService.createReminder(input)
  })
  ipcMain.handle('backend:update-reminder', async (_event, id: string, input: UpdateReminderInput) => {
    return backendSyncService.updateReminder(id, input)
  })
  ipcMain.handle('backend:delete-reminder', async (_event, id: string) => backendSyncService.deleteReminder(id))
  ipcMain.handle('backend:list-inbox', async () => backendSyncService.listInbox())
  ipcMain.handle('backend:mark-inbox-read', async (_event, id: string) => backendSyncService.markInboxRead(id))
  ipcMain.handle('backend:list-memories', async (_event, query?: string) => backendSyncService.listMemories(query))
  ipcMain.handle('backend:get-memory', async (_event, id: string) => backendSyncService.getMemory(id))
  ipcMain.handle('backend:create-memory', async (_event, input: CreateMemoryInput) => backendSyncService.createMemory(input))
  ipcMain.handle('backend:update-memory', async (_event, id: string, input: UpdateMemoryInput) => {
    return backendSyncService.updateMemory(id, input)
  })
  ipcMain.handle('backend:delete-memory', async (_event, id: string) => backendSyncService.deleteMemory(id))
  ipcMain.handle('backend:get-agent-context', async () => {
    const overview = await ecosystemUserDataSyncService.getUserDataOverview()
    return overview.context
  })
  ipcMain.handle('backend:get-user-data-overview', async () => ecosystemUserDataSyncService.getUserDataOverview())
  ipcMain.handle('backend:sync-user-data-now', async () => ecosystemUserDataSyncService.syncNow('manual'))
  ipcMain.handle('backend:get-user-data-snapshot', async () => ecosystemUserDataSyncService.getSnapshot())
  ipcMain.handle('backend:search-user-data-entities', async (_event, input?: AgentUserDataSearchInput) => {
    return ecosystemUserDataSyncService.searchEntities(input)
  })
  ipcMain.handle('backend:get-user-data-entity', async (_event, input: AgentEntityReference) => {
    return ecosystemUserDataSyncService.getEntity(input)
  })
  ipcMain.handle('backend:run-ecosystem-user-data-action', async (_event, input: EcosystemUserDataActionRequest) => {
    return ecosystemUserDataSyncService.runAction(input)
  })
  ipcMain.handle('backend:send-agent-message', async (_event, input: AgentMessageInput) => {
    return backendSyncService.sendAgentMessage(input)
  })
  ipcMain.handle('backend:run-agent-action', async (_event, input: AgentActionRequest) => {
    return backendSyncService.runAgentAction(input)
  })
  ipcMain.handle('backend:confirm-agent-action', async (_event, input: AgentConfirmationInput) => {
    return backendSyncService.confirmAgentAction(input)
  })

  ipcMain.handle('voice:start-session', async () => whisperService.startSession())
  ipcMain.handle('voice:push-audio', async (_event, input: VoicePushAudioInput) => {
    return whisperService.pushAudio(input.sessionId, input.samples, input.sampleRate)
  })
  ipcMain.handle('voice:finish-session', async (_event, input: VoiceFinishSessionInput) => {
    return whisperService.finishSession(input.sessionId)
  })
  ipcMain.handle('voice:cancel-session', async (_event, input: VoiceCancelSessionInput) => {
    whisperService.cancelSession(input.sessionId)
    return { ok: true }
  })
  ipcMain.handle('voice-runtime:get-config', async () => voiceRuntimeService.getConfig())
  ipcMain.handle('voice-runtime:save-config', async (_event, config: VoiceRuntimeConfig) => voiceRuntimeService.saveConfig(config))
  ipcMain.handle('voice-runtime:install', async () => voiceRuntimeService.installRuntime())
  ipcMain.handle('voice-runtime:start-ambient', async () => voiceRuntimeService.startAmbient())
  ipcMain.handle('voice-runtime:stop-ambient', async () => voiceRuntimeService.stopAmbient())
  ipcMain.handle('voice-runtime:speak', async (_event, input: VoiceSpeakInput) => voiceRuntimeService.speak(input))
  ipcMain.handle('voice-runtime:interrupt', async () => voiceRuntimeService.interrupt())

  ipcMain.handle('logs:open-openclaw-log', async () => {
    await shell.openPath(openClawService.getOpenClawLogPath())
    return { ok: true }
  })
  ipcMain.handle('logs:open-friday-log', async () => {
    await shell.openPath(logger.getPath())
    return { ok: true }
  })
  ipcMain.handle('vpn:get-config', async () => vpnRuntimeService.getConfig())
  ipcMain.handle('vpn:save-config', async (_event, config: VpnConfig) => vpnRuntimeService.saveConfig(config))
  ipcMain.handle('vpn:get-state', async () => vpnRuntimeService.getState())
  ipcMain.handle('vpn:list-locations', async () => vpnRuntimeService.listLocations())
  ipcMain.handle('vpn:connect', async () => vpnRuntimeService.connect())
  ipcMain.handle('vpn:disconnect', async () => vpnRuntimeService.disconnect())
  ipcMain.handle('beamng:get-config', async () => beamngRuntimeService.getConfig())
  ipcMain.handle('beamng:save-config', async (_event, config: BeamngConfig) => beamngRuntimeService.saveConfig(config))
  ipcMain.handle('beamng:get-state', async () => beamngRuntimeService.getState())
  ipcMain.handle('beamng:detect-installs', async () => beamngRuntimeService.detectInstalls())
  ipcMain.handle('beamng:install-dependencies', async () => beamngRuntimeService.installDependencies())
  ipcMain.handle('beamng:connect', async () => beamngRuntimeService.connect())
  ipcMain.handle('beamng:disconnect', async () => beamngRuntimeService.disconnect())
  ipcMain.handle('beamng:list-waypoints', async () => beamngRuntimeService.listWaypoints())
  ipcMain.handle(
    'beamng:resolve-text-command',
    async (_event, input: { text: string; language: 'ru' | 'en' }) =>
      beamngRuntimeService.resolveTextCommand(input.text, input.language),
  )
  ipcMain.handle('beamng:execute-command', async (_event, input: BeamngCommandInput) => {
    return beamngRuntimeService.executeCommand(input)
  })

  ipcMain.handle('window:get-state', () => getWindowState())
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
    return getWindowState()
  })
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) {
      return getWindowState()
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }

    return getWindowState()
  })
  ipcMain.handle('window:close', () => {
    mainWindow?.close()
    return { ok: true }
  })
}

function getWindowState(): DesktopWindowState {
  return {
    isMaximized: mainWindow?.isMaximized() ?? false,
    isFullScreen: mainWindow?.isFullScreen() ?? false,
  }
}

type ChatProgressUpdate = Omit<AgentProgressEvent, 'requestId' | 'sessionId' | 'at'>
type ChatProgressSink = (event: ChatProgressUpdate) => void

function createChatProgressEmitter(input: SendTextInput, send: (event: AgentProgressEvent) => void): ChatProgressSink {
  const requestId = input.requestId || `${input.sessionId}:${Date.now()}`
  return (event) => {
    send({
      ...event,
      requestId,
      sessionId: input.sessionId,
      at: new Date().toISOString(),
      progress: Math.max(0, Math.min(100, Math.round(event.progress))),
    })
  }
}

async function sendViaLocalOpenClaw(input: SendTextInput, progress?: ChatProgressSink) {
  progress?.({
    stage: 'gateway',
    status: 'active',
    label: 'Preparing local agent',
    detail: 'Friday is preparing the local agent runtime and tools.',
    progress: 8,
  })

  try {
    const reply = await openClawService.sendMessage(input.sessionId, input.text, progress)
    if (looksLikeDesktopActionFailure(reply.replyText)) {
      const toolRetryReply = await openClawService.sendMessage(crypto.randomUUID(), buildDesktopToolRetryPromptForMain(input.text), progress)
      if (toolRetryReply && !looksLikeDesktopActionFailure(toolRetryReply.replyText)) {
        return toolRetryReply
      }
      throw new Error(toolRetryReply?.replyText || reply.replyText)
      const recoveredShortcut = looksLikeEcosystemDataIntent(input.text)
        ? buildToolReply('', { route: 'disabled_desktop_bridge' })
        : buildToolReply('', { route: 'disabled_desktop_bridge' })
      if (recoveredShortcut) {
        return {
          ...recoveredShortcut,
          replyText: `${recoveredShortcut.replyText}\n\nАгентный скилл не успел выполнить локальное действие, поэтому я запустила его напрямую через desktop bridge.`,
        }
      }
    }

    if (looksLikeRawToolCodeReply(reply.replyText)) {
      progress?.({
        stage: 'tool_recovery',
        status: 'active',
        label: 'Retrying raw tool output',
        detail: 'The agent printed tool code instead of executing it, so Friday is forcing a native tool-call retry.',
        progress: 86,
      })
      const retriedReply = await retryAfterRawToolCodeReply(input, reply).catch(async (retryError) => {
        await logger.error(`OpenClaw raw tool-code retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`)
        return null
      })
      if (retriedReply && !looksLikeRawToolCodeReply(retriedReply.replyText)) {
        return sanitizeUnexpectedToolReply(
          retriedReply,
          'Agent tool-call retry finished without a user-facing reply. Please repeat the request in a new session.',
        )
      }

      const recoveredFileRoutine = await runSafeLocalFileRoutineFallback(input.text).catch(async (fallbackError) => {
        await logger.error(`Safe local file fallback failed after raw tool-code reply: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`)
        return null
      })
      if (recoveredFileRoutine) {
        return {
          ...recoveredFileRoutine,
          replyText: `${recoveredFileRoutine.replyText}\n\nАгент вернул сырой tool-code вместо исполнения, поэтому я безопасно выполнила файловую рутину через desktop bridge.`,
        }
      }
    }

    return sanitizeUnexpectedToolReply(
      reply,
      'Внутренний Friday tool-вызов не был исполнен. Повтори запрос после перезапуска сессии.',
    )
  } catch (error) {
    if (isOpenClawTimeoutError(error)) {
      await openClawService.stopManagedProcess().catch(() => undefined)
      progress?.({
        stage: 'tool_recovery',
        status: 'active',
        label: 'Agent timeout',
        detail: 'The local agent service timed out, so Friday is restarting it and retrying through tools.',
        progress: 72,
      })
      const retryPrompt = looksLikeDesktopActionRequestForMain(input.text)
        ? buildDesktopToolRetryPromptForMain(input.text)
        : input.text

      try {
        return await openClawService.sendMessage(crypto.randomUUID(), retryPrompt, progress)
      } catch (retryError) {
        await logger.error(`OpenClaw retry after timeout failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`)
        return buildToolReply(
          'Агент не успел выполнить команду через LLM/tools за лимит времени. Я перезапустила локальный агентный сервис; повтори запрос, и он пойдет через свежую agent-сессию.',
          {
            route: 'openclaw_timeout_recovery',
            error: error instanceof Error ? error.message : String(error),
            retryError: retryError instanceof Error ? retryError.message : String(retryError),
          },
        )
      }
      return buildToolReply(
        'Агент не успел ответить за лимит времени. Я перезапустила локальный сервис агента; повтори запрос, и он пойдёт через agent tools, без scripted snapshot-ответа.',
        {
          route: 'openclaw_timeout_recovery',
          error: String(error),
        },
      )
    }

    throw error

    const fileRoutine = await runSafeLocalFileRoutineFallback(input.text).catch(async (fallbackError) => {
      await logger.error(`Safe local file fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`)
      return null
    })
    if (fileRoutine) {
      await logger.info(`OpenClaw file routine failed, safe local fallback completed: ${String(error)}`)
      return fileRoutine
    }

    throw error
  }
}

async function retryAfterRawToolCodeReply(input: SendTextInput, reply: SendTextResult) {
  await logger.info(`OpenClaw returned raw tool-code; retrying native tool call path. sessionId=${input.sessionId}`)
  const retryPrompt = [
    'The previous assistant response printed raw tool code instead of executing a tool.',
    'Do not print <tool_code>, default_api.*, JSON tool snippets, or code fences.',
    'Complete the original user request now.',
    'If a tool is needed, invoke the real native tool call. If no tool is needed, answer normally.',
    '',
    `Original user request: ${input.text}`,
    '',
    `Raw invalid response to fix: ${reply.replyText.slice(0, 1200)}`,
  ].join('\n')

  return openClawService.sendMessage(input.sessionId, retryPrompt)
}

function looksLikeDesktopActionRequestForMain(message: string) {
  const value = message.trim().toLowerCase().replace(/ё/g, 'е')
  return /(?:open|launch|start|открой|запусти|открыть|запустить).*(?:calculator|calc|notepad|browser|chrome|edge|explorer|калькулятор|блокнот|браузер|проводник)/iu.test(value)
}

function buildDesktopToolRetryPromptForMain(message: string) {
  return [
    message,
    '',
    'Important desktop execution note:',
    '- This is a local Windows desktop agent. Execute the request through the available desktop/tools layer.',
    '- For app launch tasks, call a real available tool such as exec or process.',
    '- Do not call a tool named pc-apps or pc-shell; those are skill/workflow names, not callable tool names.',
    '- For Calculator, prefer PowerShell Start-Process calc.exe, but do not merely say it is opened unless the tool call actually succeeded.',
    '- Tool arguments must use schema types: booleans are true/false, numbers are numbers, and optional nulls should be omitted instead of sent as the string "null".',
    '- If a tool is unavailable, report the exact tool/runtime failure.',
  ].join('\n')
}

function normalizeIntentText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"']/g, '')
    .replace(/[?!.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
}

function isOpenClawTimeoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /gateway timeout|embedded run timeout|timed out|timeoutMs/i.test(message)
}

function looksLikeEcosystemDataIntent(text: string) {
  const value = normalizeIntentText(text)
  const mentionsUserData = /(?:заметк|задач|проект|памят|документ|note|task|project|memory|document)/iu.test(value)
  const mentionsDataAction =
    /(?:что|какие|покажи|прочитай|написано|найди|список|измен|обнов|добав|созда|удали|редакт|переимен|заверши|read|show|list|find|edit|update|append|create|delete|complete)/iu.test(value)

  return mentionsUserData && mentionsDataAction
}

function resolveDesktopShortcut(text: string) {
  const value = normalizeIntentText(text)
  if (!/(?:^|\s)(?:открой|запусти|открыть|запустить|open|launch|start)\b/iu.test(value)) {
    return null
  }

  if (/(?:калькулятор|calculator|calc)\b/iu.test(value)) {
    return { kind: 'process', command: 'calc.exe', args: [], replyText: 'Калькулятор открыт.' }
  }
  if (/(?:блокнот|notepad)\b/iu.test(value)) {
    return { kind: 'process', command: 'notepad.exe', args: [], replyText: 'Блокнот открыт.' }
  }
  if (/(?:проводник|explorer|file explorer)\b/iu.test(value)) {
    return { kind: 'process', command: 'explorer.exe', args: [], replyText: 'Проводник открыт.' }
  }
  if (/(?:браузер|browser|chrome|edge)\b/iu.test(value)) {
    return { kind: 'url', url: 'https://www.google.com', replyText: 'Браузер открыт.' }
  }

  return null
}

void resolveDesktopShortcut

function looksLikeDesktopActionFailure(replyText: string) {
  return /(?:pc apps open failed|desktop action failed|application launch failed|не удалось открыть|не удалось запустить)/iu.test(replyText)
}

function looksLikeRawToolCodeReply(replyText: string) {
  return /<tool_code\b|default_api\.(?:exec|process|write|edit|read)\s*\(/iu.test(replyText)
}

async function runSafeLocalFileRoutineFallback(text: string) {
  if (!looksLikeFileRoutine(text)) {
    return null
  }

  const root = extractWindowsPath(text)
  if (!root || !isSafeUserFileRoutineRoot(root)) {
    return null
  }

  const rootStat = await stat(root).catch(() => null)
  if (!rootStat?.isDirectory()) {
    return null
  }

  const sourceDir = await pickFileRoutineSourceDir(root)
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const moved: string[] = []
  const deleted: string[] = []

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const source = path.join(sourceDir, entry.name)
    if (shouldDeleteRoutineFile(entry.name, text)) {
      await rm(source, { force: true })
      deleted.push(entry.name)
      continue
    }

    const category = classifyRoutineFile(entry.name)
    if (!category) {
      continue
    }

    const destinationDir = path.join(root, category)
    await mkdir(destinationDir, { recursive: true })
    await rename(source, path.join(destinationDir, entry.name))
    moved.push(`${entry.name} -> ${category}`)
  }

  if (moved.length === 0 && deleted.length === 0) {
    return null
  }

  return buildToolReply(
    [
      'Локальная файловая рутина выполнена.',
      moved.length > 0 ? `Перемещено: ${moved.join(', ')}.` : null,
      deleted.length > 0 ? `Удалено: ${deleted.join(', ')}.` : null,
    ].filter(Boolean).join(' '),
    {
      route: 'safe_local_file_routine_fallback',
      root,
      sourceDir,
      moved,
      deleted,
    },
  )
}

function looksLikeFileRoutine(text: string) {
  return (
    /(?:sort|organize|move|delete|cleanup|clean up).*(?:file|folder|directory|inbox)/i.test(text) ||
    /(?:сортир|разлож|перемест|удали|почист|разбер).*(?:файл|папк|директор|inbox)/i.test(text)
  )
}

function extractWindowsPath(text: string) {
  const match = text.match(/[A-Za-z]:\\[^\r\n"'<>|]+/)
  return match ? path.normalize(match[0].trim().replace(/[.,;:]+$/, '')) : null
}

function isSafeUserFileRoutineRoot(root: string) {
  const normalized = path.resolve(root)
  const home = app.getPath('home')
  const workspaceTmp = path.resolve(process.cwd(), 'tmp')
  const allowedRoots = [
    path.resolve(app.getPath('desktop')),
    path.resolve(app.getPath('documents')),
    path.resolve(app.getPath('downloads')),
  ]

  if (normalized === workspaceTmp || normalized.startsWith(`${workspaceTmp}${path.sep}`)) {
    return true
  }

  if (!normalized.startsWith(path.resolve(home))) {
    return false
  }

  return allowedRoots.some((allowedRoot) => normalized === allowedRoot || normalized.startsWith(`${allowedRoot}${path.sep}`))
}

async function pickFileRoutineSourceDir(root: string) {
  const inbox = path.join(root, 'inbox')
  const inboxStat = await stat(inbox).catch(() => null)
  return inboxStat?.isDirectory() ? inbox : root
}

function shouldDeleteRoutineFile(fileName: string, requestText: string) {
  if (!/(?:delete|remove|удали|удалить)/i.test(requestText)) {
    return false
  }

  return /\.tmp$/i.test(fileName) || /^delete-me\./i.test(fileName)
}

function classifyRoutineFile(fileName: string) {
  const value = fileName.toLowerCase()
  if (/\b(invoice|receipt|bill|finance|payment|счет|счёт|квитанц)/i.test(value)) {
    return 'finance'
  }
  if (/\b(report|отчет|отчёт|summary|q[1-4])\b/i.test(value)) {
    return 'reports'
  }
  if (/\b(meeting|notes?|заметк|встреч|plan)\b/i.test(value)) {
    return 'notes'
  }
  if (/\b(photo|image|img|picture|скрин|фото)\b|\.(?:png|jpe?g|gif|webp|svg)$/i.test(value)) {
    return 'images'
  }
  if (/\.(?:pdf|docx?|xlsx?|pptx?)$/i.test(value)) {
    return 'documents'
  }

  return null
}

function buildToolReply(replyText: string, raw: unknown) {
  return {
    messageId: crypto.randomUUID(),
    replyText,
    raw,
    durationMs: 0,
  }
}

function sanitizeUnexpectedToolReply(
  reply: { messageId: string; replyText: string; raw: unknown; durationMs: number },
  fallbackText: string,
) {
  if (/<friday_tool>\s*[\s\S]+?\s*<\/friday_tool>/i.test(reply.replyText) || looksLikeRawToolCodeReply(reply.replyText)) {
    return buildToolReply(fallbackText, { rawReply: reply.replyText, reason: 'legacy_tool_reply' })
  }

  return reply
}

app.whenReady().then(async () => {
  registerIpc()
  await envConfigService.ensureManagedAiConfig().catch(async (error) => {
    await logger.error(`Failed to prepare managed AI config: ${error instanceof Error ? error.message : String(error)}`)
  })
  ecosystemUserDataSyncService.startAutoSync()
  void ecosystemUserDataSyncService.syncNow('boot').catch(async (error) => {
    await logger.error(`Failed to sync ecosystem user data on boot: ${error instanceof Error ? error.message : String(error)}`)
  })
  void backendRuntimeService.ensureRunning().catch(async (error) => {
    await logger.error(`Failed to start Friday backend automatically: ${error instanceof Error ? error.message : String(error)}`)
  })
  void openClawService.ensureRunning().catch(async (error) => {
    await logger.error(`Failed to start OpenClaw automatically: ${error instanceof Error ? error.message : String(error)}`)
  })
  void vpnRuntimeService.getConfig().then(async (vpnConfig) => {
    if (vpnConfig.autoConnect) {
      try {
        await vpnRuntimeService.connect()
      } catch (error) {
        await logger.error(`Failed to auto-connect VPN: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
  void telegramRemoteService.getConfig().then(async (telegramConfig) => {
    if (telegramConfig.enabled) {
      await telegramRemoteService.start()
    }
  }).catch(async (error) => {
    await logger.error(`Failed to auto-start Telegram remote: ${error instanceof Error ? error.message : String(error)}`)
  })
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  ecosystemUserDataSyncService.dispose()
  schedulerService.dispose()
  whisperService.dispose()
  voiceRuntimeService.dispose()
  void vpnRuntimeService.disconnect()
  void beamngRuntimeService.stop()
  void backendRuntimeService.stop()
  void openClawService.stopManagedProcess()
  telegramRemoteService.dispose()
})
