import type {
  AgentSignal,
  AgentSignalCode,
  AppLanguage,
  InboxItem,
  Reminder,
  Task,
  UserProfile,
  UserSettings,
} from '@contracts'

const DAY_MS = 24 * 60 * 60 * 1000

export function buildAgentSignals(input: {
  tasks: Task[]
  reminders: Reminder[]
  inboxItems: InboxItem[]
  settings: UserSettings
  now?: Date
}): AgentSignal[] {
  const now = input.now ?? new Date()
  const todayTasks = input.tasks.filter((task) => isTaskDueToday(task, now))
  const overdueTasks = input.tasks.filter((task) => isTaskOverdue(task, now))
  const reminderDue = input.reminders.filter((reminder) => isReminderDue(reminder, now))
  const bedtimeReached = isBedtimeWindowReached(input.settings, now)
  const signals: AgentSignal[] = []

  if (todayTasks.length > 0) {
    signals.push({
      code: 'task_due_today',
      title: 'Tasks due today',
      body: `You have ${todayTasks.length} task(s) due today.`,
      createdAt: now.toISOString(),
      severity: 'info',
    })
  }

  if (overdueTasks.length > 0) {
    signals.push({
      code: 'task_overdue',
      title: 'Overdue tasks',
      body: `You have ${overdueTasks.length} overdue task(s).`,
      createdAt: now.toISOString(),
      severity: 'warning',
    })
  }

  if (reminderDue.length > 0 || input.inboxItems.some((item) => item.kind === 'reminder' && item.status === 'unread')) {
    signals.push({
      code: 'reminder_due_now',
      title: 'Reminder due now',
      body: 'You have an active reminder waiting in your inbox.',
      createdAt: now.toISOString(),
      severity: 'info',
    })
  }

  if (bedtimeReached) {
    signals.push({
      code: 'bedtime_window_reached',
      title: 'Bedtime window',
      body: 'It is time to wind down and prepare for sleep.',
      createdAt: now.toISOString(),
      severity: 'warning',
    })
  }

  return signals
}

export function buildSignalInboxItem(input: {
  tenantId: string
  userId: string
  code: AgentSignalCode
  title: string
  body: string
  dedupeKey: string
  scheduledFor?: string | null
}): Omit<InboxItem, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'readAt'> {
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    kind: 'signal',
    title: input.title,
    body: input.body,
    scheduledFor: input.scheduledFor ?? null,
    sourceType: 'rule_engine',
    sourceId: null,
    signalCode: input.code,
    dedupeKey: input.dedupeKey,
  }
}

export function isTaskDueToday(task: Task, now: Date): boolean {
  if (!task.dueAt || task.status === 'done' || task.status === 'canceled') {
    return false
  }

  const due = new Date(task.dueAt)
  return due.getUTCFullYear() === now.getUTCFullYear() &&
    due.getUTCMonth() === now.getUTCMonth() &&
    due.getUTCDate() === now.getUTCDate()
}

export function isTaskOverdue(task: Task, now: Date): boolean {
  if (!task.dueAt || task.status === 'done' || task.status === 'canceled') {
    return false
  }

  return new Date(task.dueAt).getTime() < now.getTime()
}

export function isReminderDue(reminder: Reminder, now: Date): boolean {
  const scheduledAt = new Date(reminder.scheduledAt)
  if (scheduledAt.getTime() > now.getTime()) {
    return false
  }

  if (!reminder.lastTriggeredAt) {
    return true
  }

  const lastTriggeredAt = new Date(reminder.lastTriggeredAt)
  if (reminder.recurrence === 'none') {
    return false
  }

  if (reminder.recurrence === 'daily') {
    return now.getTime() - lastTriggeredAt.getTime() >= DAY_MS
  }

  return now.getTime() - lastTriggeredAt.getTime() >= 7 * DAY_MS
}

export function isBedtimeWindowReached(settings: UserSettings, now: Date): boolean {
  if (!settings.bedtimeStart) {
    return false
  }

  const [hoursText, minutesText] = settings.bedtimeStart.split(':')
  const hours = Number(hoursText)
  const minutes = Number(minutesText)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return false
  }

  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes()
  const bedtimeMinute = hours * 60 + minutes
  return Math.abs(minuteOfDay - bedtimeMinute) <= 30
}

export function describeInboxSignalCode(code: AgentSignalCode, language: AppLanguage = 'en'): string {
  if (language === 'ru') {
    if (code === 'task_due_today') return 'Задачи на сегодня'
    if (code === 'task_overdue') return 'Просроченные задачи'
    if (code === 'reminder_due_now') return 'Напоминание ожидает'
    return 'Пора готовиться ко сну'
  }

  if (code === 'task_due_today') return 'Tasks due today'
  if (code === 'task_overdue') return 'Overdue tasks'
  if (code === 'reminder_due_now') return 'Reminder due now'
  return 'Bedtime window reached'
}

export function createSignalDedupeKey(code: AgentSignalCode, profile: UserProfile, now: Date): string {
  return `${code}:${profile.id}:${now.toISOString().slice(0, 10)}`
}
