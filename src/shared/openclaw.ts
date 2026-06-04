type DefaultOpenClawPathOptions = {
  homeDir: string
  appDataDir?: string
}

export function getDefaultOpenClawPaths(options: DefaultOpenClawPathOptions): string[] {
  const normalizedHomeDir = trimTrailingSlash(options.homeDir)
  const normalizedAppDataDir = trimTrailingSlash(
    options.appDataDir ?? `${normalizedHomeDir}\\AppData\\Roaming`,
  )

  return Array.from(
    new Set([
      `${normalizedAppDataDir}\\npm\\openclaw.cmd`,
      `${normalizedAppDataDir}\\npm\\openclaw`,
      `${normalizedHomeDir}\\OpenCLO\\openclaw.cmd`,
      `${normalizedHomeDir}\\OpenCLO\\openclaw`,
      `${normalizedHomeDir}\\OpenClaw\\openclaw.cmd`,
      `${normalizedHomeDir}\\OpenClaw\\openclaw`,
    ]),
  )
}

export const DEFAULT_OPENCLAW_PATHS = getDefaultOpenClawPaths({
  homeDir: 'C:\\Users\\%USERNAME%',
})

type BuildAgentArgsOptions = {
  local?: boolean
}

export function buildAgentArgs(sessionId: string, message: string, options: BuildAgentArgsOptions = {}): string[] {
  const args = ['agent', '--json', '--session-id', sessionId]
  if (options.local ?? true) {
    args.splice(1, 0, '--local')
  }

  const executionBrief = looksLikeExecutionBrief(message.trim())
  const desktopAction = looksLikeDesktopActionBrief(message.trim())

  if (executionBrief || desktopAction) {
    args.push('--thinking', 'high')
  }

  args.push('--timeout', executionBrief ? '90' : desktopAction ? '25' : '45')
  args.push('--message', prepareAgentMessage(message))
  return args
}

function trimTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

export function buildGatewayRunArgs(): string[] {
  return ['gateway', 'run', '--allow-unconfigured', '--auth', 'none', '--bind', 'loopback', '--force']
}

export function buildHealthArgs(): string[] {
  return ['health']
}

export function buildCronAddArgs(name: string, delayArg: string, message: string): string[] {
  return [
    'cron',
    'add',
    '--name',
    name,
    '--at',
    delayArg,
    '--session',
    'isolated',
    '--agent',
    'main',
    '--message',
    message,
    '--no-deliver',
    '--delete-after-run',
    '--json',
  ]
}

export function parseAgentStdout(stdout: string): { rawJson: unknown; replyText: string } {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const meaningfulLines = lines.filter((line) => !isNoiseText(line))

  if (meaningfulLines.length === 0) {
    return {
      rawJson: null,
      replyText: 'Агент не вернул ответ в чат.',
    }
  }

  const joined = meaningfulLines.join('\n')
  const parsedPayload = parseStructuredPayload(joined, meaningfulLines)

  if (parsedPayload !== null) {
    const apiError = extractApiError(parsedPayload)
    return {
      rawJson: parsedPayload,
      replyText: apiError ?? extractReplyText(parsedPayload) ?? 'Агент вернул JSON без текста ответа.',
    }
  }

  return {
    rawJson: joined,
    replyText: joined,
  }
}

export function parseWhisperJson(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const root = payload as Record<string, unknown>
  const transcriptBlocks = Array.isArray(root.transcription) ? root.transcription : []
  const segments = transcriptBlocks
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return ''
      }

      const text = (entry as Record<string, unknown>).text
      return typeof text === 'string' ? text.trim() : ''
    })
    .filter(Boolean)

  if (segments.length > 0) {
    return segments.join(' ').replace(/\s+/g, ' ').trim()
  }

  const text = root.text
  return typeof text === 'string' ? text.trim() : ''
}

export function outputBaseForAudio(audioPath: string): string {
  return audioPath.replace(/\.wav$/i, '')
}

export function isUnusableAgentReply(replyText: string): boolean {
  const trimmed = replyText.trim()
  if (!trimmed) {
    return true
  }

  if (
    trimmed === 'Агент не вернул ответ в чат.' ||
    trimmed === 'Агент вернул JSON без текста ответа.' ||
    isNoiseText(trimmed)
  ) {
    return true
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return true
  }

  return /desktop bridge context/i.test(trimmed) || isCapabilityRefusal(trimmed) || isSpecClarificationReply(trimmed)
}

export function prepareAgentMessage(message: string): string {
  const trimmed = message.trim()
  const directReplyRules = [
    '',
    'Friday desktop direct-reply rules:',
    '- This is a direct user-facing request. Always return a visible final answer.',
    '- Never output NO_REPLY and never forward the request to another session.',
    '- Reply in the same language as the user.',
    '- If you used a tool, report the actual completed result only after the tool call.',
  ]
  if (!looksLikeExecutionBrief(trimmed)) {
    return [trimmed, ...directReplyRules].join('\n')
  }

  return [
    trimmed,
    '',
    'Важно: это уже полное ТЗ.',
    'Не задавай уточняющих вопросов и не проси повторно описать требования.',
    'Если инструменты доступны, реально создай папку и файлы, выполни или проверь команду запуска и потом сообщи фактический результат.',
    'Не ограничивайся примером кода, если пользователь попросил создать файлы на диске.',
    'Если есть один конкретный блокер, назови только его.',
    ...directReplyRules,
  ].join('\n')
}

function extractReplyText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return normalizeReplyText(payload)
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const candidate = extractReplyText(item)
      if (candidate) {
        return candidate
      }
    }

    return null
  }

  if (!payload || typeof payload !== 'object') {
    return null
  }

  const preferredKeys = [
    'replyText',
    'reply',
    'text',
    'content',
    'message',
    'output',
    'finalText',
    'body',
  ]

  const record = payload as Record<string, unknown>
  if (isHeartbeatPayload(record)) {
    return null
  }

  for (const key of preferredKeys) {
    const direct = record[key]
    if (typeof direct === 'string') {
      const normalized = normalizeReplyText(direct)
      if (normalized) {
        return normalized
      }
    }
  }

  const nestedKeys = ['result', 'data', 'response', 'assistant', 'messages', 'events', 'payloads']
  for (const key of nestedKeys) {
    if (key in record) {
      const nested = extractReplyText(record[key])
      if (nested) {
        return nested
      }
    }
  }

  return null
}

function parseStructuredPayload(joined: string, lines: string[]): unknown | null {
  try {
    return JSON.parse(joined)
  } catch {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index])
      } catch {
        continue
      }
    }

    return null
  }
}

function normalizeReplyText(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || isNoiseText(trimmed)) {
    return null
  }

  return trimmed
}

function isNoiseText(value: string): boolean {
  const normalized = value.trim().toUpperCase()
  return (
    normalized === 'HEARTBEAT' ||
    normalized === 'HEARTBEAT_OK' ||
    normalized === 'NO_REPLY' ||
    normalized === 'NO REPLY FROM AGENT.'
  )
}

function isHeartbeatPayload(payload: Record<string, unknown>): boolean {
  const kindKeys = ['type', 'event', 'kind', 'name']
  for (const key of kindKeys) {
    const value = payload[key]
    if (typeof value === 'string' && value.toLowerCase().includes('heartbeat')) {
      return true
    }
  }

  const textKeys = ['message', 'text', 'content', 'reply', 'replyText']
  return (
    Object.keys(payload).length <= 2 &&
    textKeys.some((key) => typeof payload[key] === 'string' && isNoiseText(String(payload[key])))
  )
}

function extractApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const record = payload as Record<string, unknown>
  const error = record.error
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return null
  }

  const errorRecord = error as Record<string, unknown>
  const message = typeof errorRecord.message === 'string' ? errorRecord.message.trim() : ''
  const code = typeof errorRecord.code === 'string' ? errorRecord.code.trim() : ''
  const status = typeof errorRecord.status === 'string' ? errorRecord.status.trim() : ''

  if (!message) {
    return null
  }

  if (message === 'User location is not supported for the API use.') {
    return 'Провайдер модели отклонил запрос по региону. Нужен поддерживаемый регион или другой LLM-провайдер.'
  }

  return [message, code || status ? `(${code || status})` : ''].filter(Boolean).join(' ')
}

function isCapabilityRefusal(value: string): boolean {
  return CAPABILITY_REFUSAL_PATTERNS.some((pattern) => pattern.test(value))
}

function isSpecClarificationReply(value: string): boolean {
  return SPEC_CLARIFICATION_PATTERNS.some((pattern) => pattern.test(value))
}

function looksLikeExecutionBrief(value: string): boolean {
  if (!value) {
    return false
  }

  return EXECUTION_BRIEF_PATTERNS.filter((pattern) => pattern.test(value)).length >= 3
}

function looksLikeDesktopActionBrief(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/ё/g, 'е')
  return /(?:open|launch|start|открой|запусти|открыть|запустить).*(?:calculator|calc|notepad|browser|chrome|edge|explorer|калькулятор|блокнот|браузер|проводник)/iu.test(normalized)
}

const CAPABILITY_REFUSAL_PATTERNS = [
  /i am sorry,\s*i cannot open applications on your computer/i,
  /i cannot open applications on your computer/i,
  /i cannot create files on your computer/i,
  /i cannot write files on your computer/i,
  /i cannot (search|browse).*(real time|latest news|internet)/i,
  /i do not have the ability to (search|browse|open applications|create files)/i,
  /я не могу открывать приложения на (?:этом )?компьютере/i,
  /я не могу создавать файлы/i,
  /я не могу записывать .* в файл/i,
  /я (?:по-прежнему )?не могу получать доступ к информации в реальном времени/i,
  /я не могу искать (?:последние )?новости/i,
]
const SPEC_CLARIFICATION_PATTERNS = [
  /what (?:exactly|kind of) .*program .*create/i,
  /what functionality would you like/i,
  /describe,?\s*please,?\s*(?:its|the) functionality/i,
  /please provide the full technical specification/i,
  /waiting for (?:the )?technical specification/i,
  /what specific execution mode are you referring to/i,
  /how can i assist you with/i,
  /please tell me what action you would like me to take/i,
  /какую именно программу .*хотели бы создать/i,
  /предоставьте полное техническое задание/i,
  /жду техническое задание/i,
  /опишите,?\s*пожалуйста,?\s*ее функциональность/i,
  /что именно вы хотите реализовать/i,
]

const EXECUTION_BRIEF_PATTERNS = [
  /\bcreate\b/i,
  /\bbuild\b/i,
  /\bimplement\b/i,
  /\bsave\b/i,
  /\brun\b/i,
  /\bverify\b/i,
  /\bfolder\b/i,
  /\bfile\b/i,
  /\bpython\b/i,
  /\btkinter\b/i,
  /\bbutton\b/i,
  /\binput\b/i,
  /\bwindow\b/i,
  /\bcommand\b/i,
  /созда[йт]/i,
  /папк/i,
  /файл/i,
  /кнопк/i,
  /поле/i,
  /окн/i,
  /проверк/i,
  /запуск/i,
  /python/i,
  /tkinter/i,
]
