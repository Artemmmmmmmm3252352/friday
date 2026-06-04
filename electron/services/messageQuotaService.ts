import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  MessageQuotaConsumeInput,
  MessageQuotaConsumeResult,
  MessageQuotaState,
  SubscriptionPlan,
} from '../../src/shared/contracts'
import { BackendSessionService } from './backendSessionService'
import { FridayLogger } from './logger'

type QuotaUsageStore = {
  records: Record<string, number>
}

const PLAN_LIMITS: Record<SubscriptionPlan, number | null> = {
  standard: 35,
  pro: 150,
  early: null,
  unknown: 35,
}

export class MessageQuotaService {
  private readonly statePath: string
  private readonly sessionService: BackendSessionService
  private readonly logger: FridayLogger

  constructor(userDataPath: string, sessionService: BackendSessionService, logger: FridayLogger) {
    this.statePath = path.join(userDataPath, 'state', 'message-quota.json')
    this.sessionService = sessionService
    this.logger = logger
  }

  async getState(): Promise<MessageQuotaState> {
    const session = await this.sessionService.load()
    const userId = session.session?.user.id ?? 'anonymous'
    const plan = normalizeSubscriptionPlan(session.subscriptionPlan)
    const usage = await this.loadUsage()
    const period = getCurrentPeriod()
    const used = usage.records[recordKey(userId, period.key)] ?? 0
    return buildQuotaState(plan, used, period)
  }

  async consume(input: MessageQuotaConsumeInput): Promise<MessageQuotaConsumeResult> {
    const session = await this.sessionService.load()
    if (!session.session) {
      const state = buildQuotaState('unknown', 0, getCurrentPeriod(), 'unknown')
      return {
        allowed: false,
        state,
        message: 'Войдите в аккаунт Экосистемы, чтобы отправлять сообщения агенту.',
      }
    }

    const plan = normalizeSubscriptionPlan(session.subscriptionPlan)
    const period = getCurrentPeriod()
    const key = recordKey(session.session.user.id, period.key)
    const usage = await this.loadUsage()
    const used = usage.records[key] ?? 0
    const currentState = buildQuotaState(plan, used, period)

    if (currentState.status === 'exceeded') {
      await this.logger.info(`Message quota exceeded: user=${session.session.user.id} route=${input.route} plan=${plan}`)
      return {
        allowed: false,
        state: currentState,
        message: buildExceededMessage(currentState),
      }
    }

    const nextUsed = currentState.unlimited ? used : used + 1
    usage.records[key] = nextUsed
    await this.saveUsage(usage)

    return {
      allowed: true,
      state: buildQuotaState(plan, nextUsed, period),
      message: 'Сообщение принято.',
    }
  }

  private async loadUsage(): Promise<QuotaUsageStore> {
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<QuotaUsageStore>
      return {
        records: isRecord(parsed.records) ? normalizeRecords(parsed.records) : {},
      }
    } catch {
      return { records: {} }
    }
  }

  private async saveUsage(usage: QuotaUsageStore): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    await writeFile(this.statePath, `${JSON.stringify(usage, null, 2)}\n`, 'utf8')
  }
}

export function normalizeSubscriptionPlan(value: unknown): SubscriptionPlan {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized.includes('early')) {
    return 'early'
  }
  if (normalized.includes('pro')) {
    return 'pro'
  }
  if (normalized.includes('standard') || normalized === 'std') {
    return 'standard'
  }
  return 'unknown'
}

function buildQuotaState(
  plan: SubscriptionPlan,
  used: number,
  period: ReturnType<typeof getCurrentPeriod>,
  forcedStatus?: MessageQuotaState['status'],
): MessageQuotaState {
  const limit = PLAN_LIMITS[plan]
  const unlimited = limit === null
  const remaining = unlimited ? null : Math.max(0, limit - used)
  const status = forcedStatus ?? (unlimited || used < limit ? 'ready' : 'exceeded')
  return {
    plan,
    limit,
    used,
    remaining,
    unlimited,
    periodStart: period.start,
    periodEnd: period.end,
    resetAt: period.end,
    status,
  }
}

function buildExceededMessage(state: MessageQuotaState): string {
  const limit = state.limit ?? 0
  return `Лимит сообщений агента на этот месяц исчерпан: ${state.used}/${limit}. Следующее обновление: ${formatDate(state.resetAt)}.`
}

function getCurrentPeriod() {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return {
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

function recordKey(userId: string, periodKey: string): string {
  return `${userId}:${periodKey}`
}

function normalizeRecords(value: Record<string, unknown>): Record<string, number> {
  const records: Record<string, number> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    const count = typeof rawValue === 'number' && Number.isFinite(rawValue) ? Math.max(0, Math.floor(rawValue)) : 0
    records[key] = count
  }
  return records
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
