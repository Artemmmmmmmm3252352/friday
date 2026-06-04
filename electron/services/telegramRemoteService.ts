import { randomInt, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type {
  TelegramLinkedUser,
  TelegramPairCode,
  TelegramRemoteConfig,
  TelegramRemoteState,
} from '../../src/shared/contracts'
import { FridayLogger } from './logger'

const execFileAsync = promisify(execFile)
const PAIR_CODE_TTL_MS = 5 * 60 * 1000
const POLL_TIMEOUT_SECONDS = 25
const DEFAULT_CONFIG: TelegramRemoteConfig = {
  botToken: '',
  enabled: false,
  linkedUsers: [],
}

type TelegramRemoteAction =
  | { type: 'start' }
  | { type: 'pair'; code: string }
  | { type: 'screen' }
  | { type: 'key'; key: string }
  | { type: 'type'; text: string }
  | { type: 'open'; target: string }
  | { type: 'shutdown' }
  | { type: 'restart' }
  | { type: 'lock' }
  | { type: 'chat'; text: string }

type TelegramRemoteCallbacks = {
  sendAgentText: (text: string, sessionId: string) => Promise<string>
}

type TelegramUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

type TelegramMessage = {
  message_id: number
  chat: { id: number }
  from?: TelegramUser
  text?: string
}

type TelegramCallbackQuery = {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
}

export class TelegramRemoteService {
  private readonly statePath: string
  private readonly logger: FridayLogger
  private readonly callbacks: TelegramRemoteCallbacks
  private config: TelegramRemoteConfig = DEFAULT_CONFIG
  private loaded = false
  private running = false
  private disposed = false
  private offset = 0
  private pollAbort: AbortController | null = null
  private lastUpdateAt: string | null = null
  private lastError: string | null = null
  private pairCode: TelegramPairCode | null = null

  constructor(userDataPath: string, logger: FridayLogger, callbacks: TelegramRemoteCallbacks) {
    this.statePath = path.join(userDataPath, 'state', 'telegram-remote.json')
    this.logger = logger
    this.callbacks = callbacks
  }

  async getConfig(): Promise<TelegramRemoteConfig> {
    await this.ensureLoaded()
    return cloneConfig(this.config)
  }

  async saveConfig(input: TelegramRemoteConfig): Promise<TelegramRemoteConfig> {
    await this.ensureLoaded()
    const nextConfig: TelegramRemoteConfig = {
      botToken: input.botToken.trim(),
      enabled: Boolean(input.enabled),
      linkedUsers: sanitizeLinkedUsers(input.linkedUsers),
    }

    this.config = nextConfig
    await this.persist()

    if (!nextConfig.enabled) {
      await this.stop()
    } else if (this.running) {
      await this.restart()
    }

    return cloneConfig(this.config)
  }

  async getState(): Promise<TelegramRemoteState> {
    await this.ensureLoaded()
    return this.buildState()
  }

  async start(): Promise<TelegramRemoteState> {
    await this.ensureLoaded()
    if (!this.config.botToken) {
      this.lastError = 'Telegram Bot Token is empty.'
      return this.buildState()
    }

    this.config = {
      ...this.config,
      enabled: true,
    }
    await this.persist()

    if (!this.running) {
      this.running = true
      this.disposed = false
      void this.pollLoop()
    }

    return this.buildState()
  }

  async stop(): Promise<TelegramRemoteState> {
    this.running = false
    this.pollAbort?.abort()
    this.pollAbort = null
    return this.buildState()
  }

  async restart(): Promise<TelegramRemoteState> {
    await this.stop()
    return this.start()
  }

  async createPairCode(): Promise<TelegramPairCode> {
    const code = String(randomInt(100_000, 999_999))
    this.pairCode = {
      code,
      expiresAt: new Date(Date.now() + PAIR_CODE_TTL_MS).toISOString(),
    }
    return this.pairCode
  }

  async removeUser(id: number): Promise<TelegramRemoteState> {
    await this.ensureLoaded()
    this.config = {
      ...this.config,
      linkedUsers: this.config.linkedUsers.filter((user) => user.id !== id),
    }
    await this.persist()
    return this.buildState()
  }

  dispose(): void {
    this.disposed = true
    this.running = false
    this.pollAbort?.abort()
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.disposed) {
      try {
        this.pollAbort = new AbortController()
        const updates = await this.callTelegram<TelegramUpdate[]>('getUpdates', {
          offset: this.offset || undefined,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message', 'callback_query'],
        }, this.pollAbort.signal)

        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1)
          await this.handleUpdate(update)
        }

        this.lastError = null
      } catch (error) {
        if (!this.running || this.disposed) {
          return
        }
        this.lastError = formatError(error)
        await this.logger.error(`Telegram remote polling failed: ${this.lastError}`)
        await delay(3_000)
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    this.lastUpdateAt = new Date().toISOString()

    if (update.callback_query) {
      await this.answerCallback(update.callback_query.id)
      const chatId = update.callback_query.message?.chat.id
      if (!chatId) {
        return
      }
      await this.handleIncoming(chatId, update.callback_query.from, update.callback_query.data ?? '')
      return
    }

    if (update.message?.from && typeof update.message.text === 'string') {
      await this.handleIncoming(update.message.chat.id, update.message.from, update.message.text)
    }
  }

  private async handleIncoming(chatId: number, from: TelegramUser, rawText: string): Promise<void> {
    const action = parseTelegramRemoteAction(rawText)
    if (action.type === 'pair') {
      await this.handlePair(chatId, from, action.code)
      return
    }

    const linkedUser = this.config.linkedUsers.find((user) => user.id === from.id)
    if (!linkedUser) {
      await this.sendMessage(
        chatId,
        'Этот Telegram аккаунт не привязан к Friday. Создайте код в настройках Friday и отправьте: /pair 123456',
      )
      return
    }

    await this.touchLinkedUser(from)
    await this.logger.info(`Telegram remote command: user=${from.id} action=${action.type}`)

    switch (action.type) {
      case 'start':
        await this.sendMessage(chatId, buildTelegramHelpText(), defaultKeyboard())
        break
      case 'screen': {
        await this.sendMessage(chatId, 'Делаю скриншот...')
        const screenshotPath = await captureScreenshot()
        try {
          await this.sendPhoto(chatId, screenshotPath, 'Скриншот ПК')
        } finally {
          await rm(screenshotPath, { force: true })
        }
        break
      }
      case 'key':
        await sendKeys(action.key)
        await this.sendMessage(chatId, `Нажала клавишу: ${action.key}`)
        break
      case 'type':
        await sendKeys(action.text)
        await this.sendMessage(chatId, 'Ввела текст в активное окно.')
        break
      case 'open': {
        const reply = await this.callbacks.sendAgentText(`Открой ${action.target}`, `telegram-${from.id}`)
        await this.sendMessage(chatId, reply || `Запросила открыть: ${action.target}`)
        break
      }
      case 'shutdown':
        await this.sendMessage(chatId, 'Выключаю ПК.')
        await execFileAsync('shutdown.exe', ['/s', '/t', '5'])
        break
      case 'restart':
        await this.sendMessage(chatId, 'Перезагружаю ПК.')
        await execFileAsync('shutdown.exe', ['/r', '/t', '5'])
        break
      case 'lock':
        await this.sendMessage(chatId, 'Блокирую ПК.')
        await execFileAsync('rundll32.exe', ['user32.dll,LockWorkStation'])
        break
      case 'chat': {
        await this.sendMessage(chatId, 'Передаю агенту...')
        const reply = await this.callbacks.sendAgentText(action.text, `telegram-${from.id}`)
        await this.sendMessage(chatId, reply || 'Агент не вернул текстовый ответ.', defaultKeyboard())
        break
      }
    }
  }

  private async handlePair(chatId: number, from: TelegramUser, code: string): Promise<void> {
    if (!this.pairCode || this.pairCode.code !== code || Date.parse(this.pairCode.expiresAt) < Date.now()) {
      await this.sendMessage(chatId, 'Код привязки неверный или истёк. Создайте новый код в настройках Friday.')
      return
    }

    const linkedUser = toLinkedUser(from)
    this.config = {
      ...this.config,
      linkedUsers: [
        ...this.config.linkedUsers.filter((user) => user.id !== linkedUser.id),
        linkedUser,
      ],
    }
    this.pairCode = null
    await this.persist()
    await this.sendMessage(chatId, 'Готово. Telegram привязан к Friday на этом ПК.', defaultKeyboard())
  }

  private async touchLinkedUser(from: TelegramUser): Promise<void> {
    const now = new Date().toISOString()
    this.config = {
      ...this.config,
      linkedUsers: this.config.linkedUsers.map((user) =>
        user.id === from.id
          ? {
              ...user,
              username: from.username ?? user.username,
              firstName: from.first_name ?? user.firstName,
              lastName: from.last_name ?? user.lastName,
              lastSeenAt: now,
            }
          : user,
      ),
    }
    await this.persist()
  }

  private async sendMessage(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
    await this.callTelegram('sendMessage', {
      chat_id: chatId,
      text: trimTelegramText(text),
      reply_markup: replyMarkup,
    })
  }

  private async sendPhoto(chatId: number, filePath: string, caption: string): Promise<void> {
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.set('chat_id', String(chatId))
    form.set('caption', caption)
    form.set('photo', new Blob([bytes], { type: 'image/png' }), path.basename(filePath))
    await this.callTelegramForm('sendPhoto', form)
  }

  private async answerCallback(callbackQueryId: string): Promise<void> {
    await this.callTelegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
    }).catch(() => undefined)
  }

  private async callTelegram<T = unknown>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.apiUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    return parseTelegramResponse<T>(response)
  }

  private async callTelegramForm<T = unknown>(method: string, form: FormData): Promise<T> {
    const response = await fetch(this.apiUrl(method), {
      method: 'POST',
      body: form,
    })
    return parseTelegramResponse<T>(response)
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.config.botToken}/${method}`
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<TelegramRemoteConfig>
      this.config = {
        botToken: typeof parsed.botToken === 'string' ? parsed.botToken : '',
        enabled: Boolean(parsed.enabled),
        linkedUsers: sanitizeLinkedUsers(parsed.linkedUsers),
      }
    } catch {
      this.config = DEFAULT_CONFIG
      await this.persist()
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    await writeFile(this.statePath, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8')
  }

  private buildState(): TelegramRemoteState {
    const activePairCode =
      this.pairCode && Date.parse(this.pairCode.expiresAt) > Date.now() ? this.pairCode : null
    if (!activePairCode) {
      this.pairCode = null
    }

    return {
      enabled: this.config.enabled,
      running: this.running,
      linkedUsers: [...this.config.linkedUsers],
      lastUpdateAt: this.lastUpdateAt,
      lastError: this.lastError,
      pairCode: activePairCode?.code ?? null,
      pairCodeExpiresAt: activePairCode?.expiresAt ?? null,
    }
  }
}

export function parseTelegramRemoteAction(rawText: string): TelegramRemoteAction {
  const text = rawText.trim()
  const [command = '', ...rest] = text.split(/\s+/)
  const argument = rest.join(' ').trim()
  const normalizedCommand = command.toLowerCase()

  switch (normalizedCommand) {
    case '/start':
    case 'menu:start':
      return { type: 'start' }
    case '/pair':
      return { type: 'pair', code: argument }
    case '/screen':
    case 'menu:screen':
    case 'скриншот':
      return { type: 'screen' }
    case '/key':
      return { type: 'key', key: argument || 'enter' }
    case 'menu:key-enter':
      return { type: 'key', key: 'enter' }
    case 'menu:key-esc':
      return { type: 'key', key: 'esc' }
    case 'menu:key-alt-tab':
      return { type: 'key', key: '%{TAB}' }
    case '/type':
      return { type: 'type', text: argument }
    case '/open':
      return { type: 'open', target: argument || 'calculator' }
    case 'menu:open-calc':
      return { type: 'open', target: 'calculator' }
    case '/shutdown':
    case 'menu:shutdown':
      return { type: 'shutdown' }
    case '/restart':
      return { type: 'restart' }
    case '/lock':
    case 'menu:lock':
      return { type: 'lock' }
    default:
      return { type: 'chat', text }
  }
}

async function parseTelegramResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.description || `Telegram API request failed with HTTP ${response.status}`)
  }
  return payload.result as T
}

async function captureScreenshot(): Promise<string> {
  const outputPath = path.join(os.tmpdir(), `friday-telegram-screen-${randomUUID()}.png`)
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
  })
  return outputPath
}

async function sendKeys(rawValue: string): Promise<void> {
  const keys = normalizeSendKeys(rawValue)
  const script = `
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('${keys.replace(/'/g, "''")}')
`
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
  })
}

function normalizeSendKeys(value: string): string {
  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case '':
    case 'enter':
      return '{ENTER}'
    case 'esc':
    case 'escape':
      return '{ESC}'
    case 'tab':
      return '{TAB}'
    case 'space':
      return ' '
    case 'backspace':
      return '{BACKSPACE}'
    case 'delete':
    case 'del':
      return '{DELETE}'
    default:
      return value
  }
}

function defaultKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Скриншот', callback_data: 'menu:screen' },
        { text: 'Enter', callback_data: 'menu:key-enter' },
        { text: 'Esc', callback_data: 'menu:key-esc' },
      ],
      [
        { text: 'Alt+Tab', callback_data: 'menu:key-alt-tab' },
        { text: 'Открыть калькулятор', callback_data: 'menu:open-calc' },
      ],
      [
        { text: 'Заблокировать ПК', callback_data: 'menu:lock' },
        { text: 'Выключить ПК', callback_data: 'menu:shutdown' },
      ],
    ],
  }
}

function buildTelegramHelpText(): string {
  return [
    'Friday remote готов.',
    '',
    'Пишите обычный текст, чтобы отправить сообщение агенту.',
    'Команды: /screen, /key enter, /type текст, /open calc, /lock, /shutdown, /restart.',
  ].join('\n')
}

function toLinkedUser(user: TelegramUser): TelegramLinkedUser {
  return {
    id: user.id,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    linkedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }
}

function sanitizeLinkedUsers(value: unknown): TelegramLinkedUser[] {
  if (!Array.isArray(value)) {
    return []
  }

  const users: TelegramLinkedUser[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Partial<TelegramLinkedUser>
    if (typeof record.id !== 'number' || !Number.isFinite(record.id)) {
      continue
    }
    users.push({
      id: record.id,
      username: typeof record.username === 'string' ? record.username : undefined,
      firstName: typeof record.firstName === 'string' ? record.firstName : undefined,
      lastName: typeof record.lastName === 'string' ? record.lastName : undefined,
      linkedAt: typeof record.linkedAt === 'string' ? record.linkedAt : new Date().toISOString(),
      lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : undefined,
    })
  }

  return users
}

function cloneConfig(config: TelegramRemoteConfig): TelegramRemoteConfig {
  return {
    botToken: config.botToken,
    enabled: config.enabled,
    linkedUsers: [...config.linkedUsers],
  }
}

function trimTelegramText(text: string): string {
  return text.length > 3900 ? `${text.slice(0, 3900)}...` : text
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
