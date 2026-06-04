// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { Reminder, Task, UserSettings } from '@contracts'

import { buildAgentSignals, isBedtimeWindowReached, isReminderDue, isTaskDueToday, isTaskOverdue } from './rules'

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    title: 'Task',
    description: null,
    status: 'todo',
    dueAt: '2026-03-16T10:00:00.000Z',
    completedAt: null,
    createdAt: '2026-03-15T10:00:00.000Z',
    updatedAt: '2026-03-15T10:00:00.000Z',
    ...overrides,
  }
}

function createReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'reminder-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    title: 'Reminder',
    body: 'Body',
    scheduledAt: '2026-03-16T19:00:00.000Z',
    recurrence: 'daily',
    timezone: 'UTC',
    lastTriggeredAt: null,
    createdAt: '2026-03-15T19:00:00.000Z',
    updatedAt: '2026-03-15T19:00:00.000Z',
    ...overrides,
  }
}

function createSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    timezone: 'UTC',
    locale: 'en',
    bedtimeStart: '22:00',
    quietHoursStart: null,
    quietHoursEnd: null,
    ...overrides,
  }
}

describe('rules', () => {
  it('detects tasks due today and overdue', () => {
    const now = new Date('2026-03-16T12:00:00.000Z')

    expect(isTaskDueToday(createTask(), now)).toBe(true)
    expect(isTaskOverdue(createTask(), now)).toBe(true)
    expect(isTaskDueToday(createTask({ dueAt: '2026-03-17T10:00:00.000Z' }), now)).toBe(false)
    expect(isTaskOverdue(createTask({ dueAt: '2026-03-17T10:00:00.000Z' }), now)).toBe(false)
  })

  it('respects reminder recurrence windows', () => {
    const now = new Date('2026-03-16T19:30:00.000Z')

    expect(isReminderDue(createReminder({ lastTriggeredAt: null }), now)).toBe(true)
    expect(
      isReminderDue(createReminder({ lastTriggeredAt: '2026-03-16T18:45:00.000Z', recurrence: 'daily' }), now),
    ).toBe(false)
    expect(
      isReminderDue(createReminder({ lastTriggeredAt: '2026-03-15T18:45:00.000Z', recurrence: 'daily' }), now),
    ).toBe(true)
  })

  it('detects bedtime window and builds derived signals', () => {
    const now = new Date('2026-03-16T22:15:00.000Z')
    expect(isBedtimeWindowReached(createSettings(), now)).toBe(true)

    const signals = buildAgentSignals({
      tasks: [createTask()],
      reminders: [createReminder({ scheduledAt: '2026-03-16T20:00:00.000Z' })],
      inboxItems: [],
      settings: createSettings(),
      now,
    })

    expect(signals.map((signal) => signal.code)).toEqual([
      'task_due_today',
      'task_overdue',
      'reminder_due_now',
      'bedtime_window_reached',
    ])
  })
})
