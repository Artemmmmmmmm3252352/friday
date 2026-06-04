import type { AppLanguage } from '../../src/shared/contracts'
import {
  actionAgentMessage,
  actionLabel,
  parseScheduledActionRequest,
  type ScheduledActionDefinition,
} from '../../src/shared/scheduler'
import { OpenClawService } from './openclawService'

export interface ScheduleTextResult {
  matched: boolean
  replyText?: string
  scheduledFor?: string
}

export class SchedulerService {
  private readonly openClawService: OpenClawService

  constructor(openClawService: OpenClawService) {
    this.openClawService = openClawService
  }

  async trySchedule(text: string, language: AppLanguage): Promise<ScheduleTextResult> {
    const parsed = parseScheduledActionRequest(text)
    if (!parsed) {
      return { matched: false }
    }

    const scheduled = await this.openClawService.scheduleMessage(
      buildJobName(parsed.action, language),
      parsed.delayArg,
      actionAgentMessage(parsed.action, language),
    )

    const scheduledFor = scheduled.scheduledFor ?? new Date(Date.now() + parsed.delayMs).toISOString()

    return {
      matched: true,
      scheduledFor,
      replyText: formatReply(parsed.action, parsed.quantity, parsed.unitLabel, scheduledFor, language),
    }
  }

  dispose(): void {
    // OpenClaw cron jobs live in the Gateway, so there is nothing local to tear down here.
  }
}

function buildJobName(action: ScheduledActionDefinition, language: AppLanguage): string {
  if (action.kind === 'file') {
    return language === 'en' ? `Create ${action.fileName}` : `Создать ${action.fileName}`
  }

  if (language === 'en') {
    if (action.id === 'calculator') {
      return 'Launch Calculator'
    }

    if (action.id === 'explorer') {
      return 'Launch Explorer'
    }

    if (action.id === 'notepad') {
      return 'Launch Notepad'
    }

    return 'Launch VS Code'
  }

  if (action.id === 'calculator') {
    return 'Запуск калькулятора'
  }

  if (action.id === 'explorer') {
    return 'Запуск проводника'
  }

  if (action.id === 'notepad') {
    return 'Запуск блокнота'
  }

  return 'Запуск VS Code'
}

function formatReply(
  action: ScheduledActionDefinition,
  quantity: number,
  unitLabel: string,
  scheduledFor: string,
  language: AppLanguage,
): string {
  const when = new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(scheduledFor))

  if (language === 'en') {
    if (action.kind === 'file') {
      const location = action.location === 'desktop' ? 'on the Desktop' : 'in Documents'
      return `Scheduled creation of ${actionLabel(action, language, 'nominative')} ${location} in ${quantity} ${unitLabel} at ${when}.`
    }

    return `Scheduled ${actionLabel(action, language, 'nominative')} to launch in ${quantity} ${unitLabel} at ${when}.`
  }

  if (action.kind === 'file') {
    const location = action.location === 'desktop' ? 'на рабочем столе' : 'в документах'
    return `Запланировал создание ${actionLabel(action, language, 'genitive')} ${location} через ${quantity} ${unitLabel} в ${when}.`
  }

  return `Запланировал запуск ${actionLabel(action, language, 'genitive')} через ${quantity} ${unitLabel} в ${when}.`
}
