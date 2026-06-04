import type { AppLanguage } from './contracts'

export type ScheduledActionId = 'calculator' | 'explorer' | 'vscode' | 'notepad' | 'create-text-file'
type ScheduledFileLocation = 'desktop' | 'documents'

type AppAction = {
  id: Exclude<ScheduledActionId, 'create-text-file'>
  kind: 'app'
}

type FileAction = {
  id: 'create-text-file'
  kind: 'file'
  fileName: string
  location: ScheduledFileLocation
  content: string | null
}

export type ScheduledActionDefinition = AppAction | FileAction

export interface ParsedScheduleRequest {
  delayMs: number
  delayArg: string
  quantity: number
  unitLabel: string
  action: ScheduledActionDefinition
  sourceText: string
}

const SCHEDULE_PATTERNS: RegExp[] = [
  /^через\s+(\d+)\s*(секунд(?:у|ы)?|секунд|минут(?:у|ы)?|минут|час(?:а|ов)?)\s+(.+)$/i,
  /^in\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)\s+(.+)$/i,
]

const FILE_CREATION_PATTERNS: RegExp[] = [
  /^(?:создай|сделай)\s+(?:пустой\s+)?(?:текстовый\s+)?файл\s+(.+?)\s+(?:на\s+рабочем\s+столе|на\s+рабочий\s+стол|на\s+desktop|на\s+десктопе)(?:\s+и\s+запиши\s+в\s+него\s+текст\s+(.+))?$/i,
  /^(?:создай|сделай)\s+(?:пустой\s+)?(?:текстовый\s+)?файл\s+(.+?)\s+(?:в\s+документах|в\s+документы|in\s+documents)(?:\s+и\s+запиши\s+в\s+него\s+текст\s+(.+))?$/i,
  /^create\s+(?:an?\s+)?(?:empty\s+)?text\s+file\s+(.+?)\s+(?:on\s+the\s+desktop|on\s+desktop)(?:\s+and\s+write\s+(.+?)\s+(?:to\s+it|inside\s+it))?$/i,
  /^create\s+(?:an?\s+)?(?:empty\s+)?text\s+file\s+(.+?)\s+in\s+documents(?:\s+and\s+write\s+(.+?)\s+(?:to\s+it|inside\s+it))?$/i,
]

export function parseScheduledActionRequest(text: string): ParsedScheduleRequest | null {
  const trimmed = text.trim()

  for (const pattern of SCHEDULE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (!match) {
      continue
    }

    const quantity = Number.parseInt(match[1] ?? '', 10)
    const unit = (match[2] ?? '').toLowerCase()
    const actionText = (match[3] ?? '').trim()
    const action = resolveAction(actionText)
    const delayMs = quantityToDelayMs(quantity, unit)
    const delayArg = quantityToDelayArg(quantity, unit)

    if (!quantity || delayMs <= 0 || !delayArg || !action) {
      return null
    }

    return {
      delayMs,
      delayArg,
      quantity,
      unitLabel: normalizeUnitLabel(quantity, unit),
      action,
      sourceText: trimmed,
    }
  }

  return null
}

export function actionAgentMessage(action: ScheduledActionDefinition, language: AppLanguage): string {
  if (action.kind === 'file') {
    const locationText = action.location === 'desktop'
      ? language === 'en'
        ? 'on the Desktop'
        : 'на рабочем столе'
      : language === 'en'
        ? 'in Documents'
        : 'в документах'
    const baseMessage = language === 'en'
      ? `create a text file "${action.fileName}" ${locationText}`
      : `создай текстовый файл "${action.fileName}" ${locationText}`

    if (!action.content) {
      return baseMessage
    }

    return language === 'en'
      ? `${baseMessage} and write "${action.content}" into it`
      : `${baseMessage} и запиши в него текст "${action.content}"`
  }

  if (language === 'en') {
    if (action.id === 'calculator') {
      return 'open calculator'
    }

    if (action.id === 'explorer') {
      return 'open explorer'
    }

    if (action.id === 'notepad') {
      return 'open notepad'
    }

    return 'open Visual Studio Code'
  }

  if (action.id === 'calculator') {
    return 'открой калькулятор'
  }

  if (action.id === 'explorer') {
    return 'открой проводник'
  }

  if (action.id === 'notepad') {
    return 'открой блокнот'
  }

  return 'открой Visual Studio Code'
}

export function actionLabel(
  action: ScheduledActionDefinition,
  language: AppLanguage,
  grammaticalCase: 'nominative' | 'genitive',
): string {
  if (action.kind === 'file') {
    if (language === 'en') {
      return `text file ${action.fileName}`
    }

    return grammaticalCase === 'genitive'
      ? `файла ${action.fileName}`
      : `файл ${action.fileName}`
  }

  if (language === 'en') {
    if (action.id === 'calculator') {
      return 'calculator'
    }

    if (action.id === 'explorer') {
      return 'Explorer'
    }

    if (action.id === 'notepad') {
      return 'Notepad'
    }

    return 'Visual Studio Code'
  }

  if (action.id === 'calculator') {
    return grammaticalCase === 'genitive' ? 'калькулятора' : 'калькулятор'
  }

  if (action.id === 'explorer') {
    return grammaticalCase === 'genitive' ? 'проводника' : 'проводник'
  }

  if (action.id === 'notepad') {
    return grammaticalCase === 'genitive' ? 'блокнота' : 'блокнот'
  }

  return 'Visual Studio Code'
}

function resolveAction(text: string): ScheduledActionDefinition | null {
  const normalized = text.toLowerCase()
  const fileCreation = resolveTextFileCreation(text)
  if (fileCreation) {
    return fileCreation
  }

  if (/(запусти|открой|open|launch|start).*(калькулятор|calculator|calc)/i.test(normalized)) {
    return { id: 'calculator', kind: 'app' }
  }

  if (/(запусти|открой|open|launch|start).*(проводник|explorer|file explorer)/i.test(normalized)) {
    return { id: 'explorer', kind: 'app' }
  }

  if (/(запусти|открой|open|launch|start).*(visual studio code|vs code|vscode|code)/i.test(normalized)) {
    return { id: 'vscode', kind: 'app' }
  }

  if (/(запусти|открой|open|launch|start).*(блокнот|notepad)/i.test(normalized)) {
    return { id: 'notepad', kind: 'app' }
  }

  return null
}

function resolveTextFileCreation(text: string): FileAction | null {
  for (const pattern of FILE_CREATION_PATTERNS) {
    const match = text.trim().match(pattern)
    if (!match) {
      continue
    }

    const rawName = stripQuotes(match[1] ?? '')
    const rawContent = stripQuotes(match[2] ?? '')
    const location: ScheduledFileLocation = /documents|документ/i.test(match[0]) ? 'documents' : 'desktop'
    const fileName = normalizeTextFileName(rawName)

    if (!fileName) {
      return null
    }

    return {
      id: 'create-text-file',
      kind: 'file',
      fileName,
      location,
      content: rawContent || null,
    }
  }

  return null
}

function normalizeTextFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')

  if (!cleaned) {
    return ''
  }

  return /\.txt$/i.test(cleaned) ? cleaned : `${cleaned}.txt`
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["'«]+|["'»]+$/g, '').trim()
}

function quantityToDelayMs(quantity: number, unit: string): number {
  if (/^сек|^second/.test(unit)) {
    return quantity * 1_000
  }

  if (/^мин|^minute/.test(unit)) {
    return quantity * 60_000
  }

  if (/^час|^hour/.test(unit)) {
    return quantity * 3_600_000
  }

  return 0
}

function quantityToDelayArg(quantity: number, unit: string): string {
  if (/^сек|^second/.test(unit)) {
    return `${quantity}s`
  }

  if (/^мин|^minute/.test(unit)) {
    return `${quantity}m`
  }

  if (/^час|^hour/.test(unit)) {
    return `${quantity}h`
  }

  return ''
}

function normalizeUnitLabel(quantity: number, unit: string): string {
  if (/^second/.test(unit)) {
    return quantity === 1 ? 'second' : 'seconds'
  }

  if (/^minute/.test(unit)) {
    return quantity === 1 ? 'minute' : 'minutes'
  }

  if (/^hour/.test(unit)) {
    return quantity === 1 ? 'hour' : 'hours'
  }

  if (/^сек/.test(unit)) {
    return russianPlural(quantity, ['секунду', 'секунды', 'секунд'])
  }

  if (/^мин/.test(unit)) {
    return russianPlural(quantity, ['минуту', 'минуты', 'минут'])
  }

  return russianPlural(quantity, ['час', 'часа', 'часов'])
}

function russianPlural(quantity: number, forms: [string, string, string]): string {
  const mod10 = quantity % 10
  const mod100 = quantity % 100

  if (mod10 === 1 && mod100 !== 11) {
    return forms[0]
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return forms[1]
  }

  return forms[2]
}
