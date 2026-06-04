import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import type {
  AgentContext,
  AgentEntityReference,
  AgentSignal,
  AgentUserDataEntitySummary,
  AgentUserDataOverview,
  EcosystemSyncResult,
  EcosystemSyncState,
  EcosystemUserDataActionRequest,
  EcosystemUserDataActionResult,
  EcosystemUserDataCounts,
  EcosystemUserDataEntities,
  EcosystemUserDataSnapshot,
  InboxItem,
  MemoryEntry,
  Note,
  Reminder,
  Task,
  UserProfile,
  XVextaNote,
  XVextaProject,
} from '@contracts'

import { BackendSyncService } from './backendSyncService'
import { FridayLogger } from './logger'

const SYNC_INTERVAL_MS = 10 * 60_000
const STALE_AFTER_MS = 15 * 60_000

export class EcosystemUserDataSyncService {
  private readonly snapshotPath: string
  private readonly backendSyncService: BackendSyncService
  private readonly logger: FridayLogger
  private timer: ReturnType<typeof setInterval> | null = null
  private syncPromise: Promise<EcosystemSyncResult> | null = null
  private lastAttemptedAt: string | null = null
  private lastError: string | null = null

  constructor(userDataPath: string, backendSyncService: BackendSyncService, logger: FridayLogger) {
    this.snapshotPath = path.join(userDataPath, 'state', 'ecosystem-user-data-snapshot.json')
    this.backendSyncService = backendSyncService
    this.logger = logger
  }

  startAutoSync(): void {
    if (this.timer) {
      return
    }

    this.timer = setInterval(() => {
      void this.syncNow('interval').catch(async (error) => {
        await this.logger.error(`Scheduled ecosystem user-data sync failed: ${formatError(error)}`)
      })
    }, SYNC_INTERVAL_MS)
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async syncNow(reason = 'manual'): Promise<EcosystemSyncResult> {
    if (this.syncPromise) {
      return this.syncPromise
    }

    this.syncPromise = this.syncNowInternal(reason).finally(() => {
      this.syncPromise = null
    })
    return this.syncPromise
  }

  async getSnapshot(): Promise<EcosystemUserDataSnapshot | null> {
    return this.readCachedSnapshot()
  }

  async getSyncState(): Promise<EcosystemSyncState> {
    return this.buildState(await this.readCachedSnapshot())
  }

  async getUserDataOverview(): Promise<AgentUserDataOverview> {
    const snapshot = (await this.readCachedSnapshot()) ?? (await this.createEmptySnapshotFromSession())
    return snapshotToOverview(snapshot)
  }

  async searchEntities(input: { query?: string; kinds?: Array<string>; limit?: number } = {}): Promise<AgentUserDataEntitySummary[]> {
    const snapshot = await this.readCachedSnapshot()
    if (!snapshot) {
      return []
    }

    const query = input.query?.trim().toLowerCase() ?? ''
    const kinds = new Set((input.kinds ?? []).map(normalizeKind))
    const limit = Math.max(1, Math.min(input.limit ?? 80, 200))

    return buildSnapshotSummaries(snapshot)
      .filter((entry) => kinds.size === 0 || kinds.has(normalizeKind(entry.kind)))
      .filter((entry) => {
        if (!query) {
          return true
        }

        return [entry.kind, entry.title, entry.summary, entry.detail].some((value) => value?.toLowerCase().includes(query))
      })
      .slice(0, limit)
  }

  async getEntity(input: AgentEntityReference): Promise<AgentUserDataEntitySummary | null> {
    const summaries = await this.searchEntities({
      kinds: [input.kind],
      limit: 200,
    })
    return summaries.find((entry) => normalizeKind(entry.kind) === normalizeKind(input.kind) && entry.id === input.id) ?? null
  }

  async runAction(input: EcosystemUserDataActionRequest): Promise<EcosystemUserDataActionResult> {
    const result = await this.backendSyncService.runEcosystemUserDataAction(input)
    if (result.ok && !result.confirmationRequired) {
      const sync = await this.syncNow('mutation').catch(async (error) => {
        await this.logger.error(`Post-mutation ecosystem user-data sync failed: ${formatError(error)}`)
        return null
      })
      return {
        ...result,
        snapshot: sync?.snapshot ?? result.snapshot ?? null,
      }
    }

    return result
  }

  private async syncNowInternal(reason: string): Promise<EcosystemSyncResult> {
    const startedAt = Date.now()
    this.lastAttemptedAt = new Date().toISOString()

    try {
      const snapshot = await this.backendSyncService.fetchEcosystemUserDataSnapshot()
      await this.writeSnapshot(snapshot)
      this.lastError = null
      await this.logger.info(`Ecosystem user-data snapshot synced via ${snapshot.source} (${reason}).`)
      return {
        ok: true,
        snapshot,
        state: await this.buildState(snapshot),
        durationMs: Date.now() - startedAt,
        error: null,
      }
    } catch (error) {
      const cached = await this.readCachedSnapshot()
      const message = formatError(error)
      this.lastError = message
      await this.logger.error(`Ecosystem user-data snapshot sync failed (${reason}): ${message}`)
      return {
        ok: false,
        snapshot: cached,
        state: await this.buildState(cached),
        durationMs: Date.now() - startedAt,
        error: message,
      }
    }
  }

  private async readCachedSnapshot(): Promise<EcosystemUserDataSnapshot | null> {
    try {
      const raw = await readFile(this.snapshotPath, 'utf8')
      return coerceSnapshot(JSON.parse(raw))
    } catch {
      return null
    }
  }

  private async writeSnapshot(snapshot: EcosystemUserDataSnapshot): Promise<void> {
    await mkdir(path.dirname(this.snapshotPath), { recursive: true })
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  }

  private async buildState(snapshot: EcosystemUserDataSnapshot | null): Promise<EcosystemSyncState> {
    const lastSyncedAt = snapshot?.generatedAt ?? null
    const nextSyncAt = lastSyncedAt ? new Date(new Date(lastSyncedAt).getTime() + SYNC_INTERVAL_MS).toISOString() : null
    const stale = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() > STALE_AFTER_MS : false
    const hasBlockingError = Boolean(this.lastError && (!snapshot || stale))
    return {
      status: hasBlockingError ? 'error' : snapshot ? stale ? 'stale' : 'ready' : 'idle',
      snapshot,
      lastAttemptedAt: this.lastAttemptedAt,
      lastSyncedAt,
      nextSyncAt,
      error: this.lastError,
    }
  }

  private async createEmptySnapshotFromSession(): Promise<EcosystemUserDataSnapshot> {
    const session = await this.backendSyncService.getSessionState()
    return buildEmptySnapshot(session.session?.user ?? createFallbackProfile(), 'empty', [])
  }
}

export function snapshotToOverview(snapshot: EcosystemUserDataSnapshot): AgentUserDataOverview {
  const context = snapshotToAgentContext(snapshot)
  return {
    context,
    counts: {
      tasks: snapshot.counts.tasks,
      overdueTasks: snapshot.counts.overdueTasks,
      reminders: snapshot.counts.reminders,
      notes: snapshot.counts.notes,
      memories: snapshot.counts.memory,
      inbox: snapshot.counts.inbox,
      xVextaProjects: snapshot.counts.xVextaProjects,
      xVextaNotes: snapshot.counts.xVextaNotes,
    },
    recommendations: snapshot.recommendations,
    generatedAt: snapshot.generatedAt,
  }
}

export function snapshotToAgentContext(snapshot: EcosystemUserDataSnapshot): AgentContext {
  const activeTasks = snapshot.entities.tasks.filter((task) => task.status !== 'done' && task.status !== 'canceled')
  const today = new Date().toISOString().slice(0, 10)
  const overdueTasks = activeTasks.filter((task) => task.dueAt && task.dueAt.slice(0, 10) < today)
  const todayTasks = activeTasks.filter((task) => !overdueTasks.some((overdue) => overdue.id === task.id))

  return {
    profile: snapshot.profile,
    todayTasks,
    overdueTasks,
    activeReminders: snapshot.entities.reminders,
    recentNotes: snapshot.entities.notes,
    recentMemories: snapshot.entities.memory,
    mailContacts: [],
    xVextaProjects: snapshot.entities.xVextaProjects,
    xVextaNotes: snapshot.entities.xVextaNotes,
    unreadInbox: snapshot.entities.inbox.filter((item) => item.status === 'unread'),
    derivedSignals: snapshot.recommendations,
    generatedAt: snapshot.generatedAt,
  }
}

export function buildEmptySnapshot(
  profile: UserProfile,
  source: EcosystemUserDataSnapshot['source'] = 'empty',
  errors: string[] = [],
): EcosystemUserDataSnapshot {
  const entities = createEmptyEntities()
  const generatedAt = new Date().toISOString()
  return {
    profile,
    entities,
    counts: countEntities(entities),
    recommendations: [],
    generatedAt,
    source,
    syncRevision: `empty-${Date.now()}`,
    errors,
  }
}

export function countEntities(entities: EcosystemUserDataEntities): EcosystemUserDataCounts {
  const overdueTasks = entities.tasks.filter((task) => task.status !== 'done' && task.status !== 'canceled' && task.dueAt && task.dueAt.slice(0, 10) < new Date().toISOString().slice(0, 10)).length
  const counts: EcosystemUserDataCounts = {
    notes: entities.notes.length,
    tasks: entities.tasks.length,
    overdueTasks,
    reminders: entities.reminders.length,
    inbox: entities.inbox.length,
    memory: entities.memory.length,
    documents: entities.documents.length,
    projects: entities.projects.length,
    workouts: entities.workouts.length,
    calendarEvents: entities.calendarEvents.length,
    goals: entities.goals.length,
    habits: entities.habits.length,
    financeRecords: entities.financeRecords.length,
    contentPlanItems: entities.contentPlanItems.length,
    crmContacts: entities.crmContacts.length,
    crmDeals: entities.crmDeals.length,
    formEntries: entities.formEntries.length,
    knowledgeBaseItems: entities.knowledgeBaseItems.length,
    templates: entities.templates.length,
    xVextaProjects: entities.xVextaProjects.length,
    xVextaNotes: entities.xVextaNotes.length,
    total: 0,
  }
  counts.total = Object.entries(counts)
    .filter(([key]) => key !== 'total' && key !== 'overdueTasks')
    .reduce((sum, [, value]) => sum + value, 0)
  return counts
}

export function createEmptyEntities(): EcosystemUserDataEntities {
  return {
    notes: [],
    tasks: [],
    reminders: [],
    inbox: [],
    memory: [],
    documents: [],
    projects: [],
    workouts: [],
    calendarEvents: [],
    goals: [],
    habits: [],
    financeRecords: [],
    contentPlanItems: [],
    crmContacts: [],
    crmDeals: [],
    formEntries: [],
    knowledgeBaseItems: [],
    templates: [],
    xVextaProjects: [],
    xVextaNotes: [],
  }
}

export function buildSnapshotSummaries(snapshot: EcosystemUserDataSnapshot): AgentUserDataEntitySummary[] {
  return dedupeSummaries([
    profileToSummary(snapshot.profile),
    ...snapshot.entities.notes.map(noteToSummary),
    ...snapshot.entities.tasks.map(taskToSummary),
    ...snapshot.entities.reminders.map(reminderToSummary),
    ...snapshot.entities.inbox.map(inboxToSummary),
    ...snapshot.entities.memory.map(memoryToSummary),
    ...snapshot.entities.documents,
    ...snapshot.entities.projects,
    ...snapshot.entities.workouts,
    ...snapshot.entities.calendarEvents,
    ...snapshot.entities.goals,
    ...snapshot.entities.habits,
    ...snapshot.entities.financeRecords,
    ...snapshot.entities.contentPlanItems,
    ...snapshot.entities.crmContacts,
    ...snapshot.entities.crmDeals,
    ...snapshot.entities.formEntries,
    ...snapshot.entities.knowledgeBaseItems,
    ...snapshot.entities.templates,
    ...snapshot.entities.xVextaProjects.map(xVextaProjectToSummary),
    ...snapshot.entities.xVextaNotes.map(xVextaNoteToSummary),
  ])
}

function coerceSnapshot(value: unknown): EcosystemUserDataSnapshot | null {
  const record = asRecord(value)
  const profile = asRecord(record?.profile) as UserProfile | null
  const rawEntities = asRecord(record?.entities)
  if (!record || !profile || !rawEntities) {
    return null
  }

  const entities: EcosystemUserDataEntities = {
    ...createEmptyEntities(),
    notes: arrayOf<Note>(rawEntities.notes),
    tasks: arrayOf<Task>(rawEntities.tasks),
    reminders: arrayOf<Reminder>(rawEntities.reminders),
    inbox: arrayOf<InboxItem>(rawEntities.inbox),
    memory: arrayOf<MemoryEntry>(rawEntities.memory),
    documents: arrayOf<AgentUserDataEntitySummary>(rawEntities.documents),
    projects: arrayOf<AgentUserDataEntitySummary>(rawEntities.projects),
    workouts: arrayOf<AgentUserDataEntitySummary>(rawEntities.workouts),
    calendarEvents: arrayOf<AgentUserDataEntitySummary>(rawEntities.calendarEvents),
    goals: arrayOf<AgentUserDataEntitySummary>(rawEntities.goals),
    habits: arrayOf<AgentUserDataEntitySummary>(rawEntities.habits),
    financeRecords: arrayOf<AgentUserDataEntitySummary>(rawEntities.financeRecords),
    contentPlanItems: arrayOf<AgentUserDataEntitySummary>(rawEntities.contentPlanItems),
    crmContacts: arrayOf<AgentUserDataEntitySummary>(rawEntities.crmContacts),
    crmDeals: arrayOf<AgentUserDataEntitySummary>(rawEntities.crmDeals),
    formEntries: arrayOf<AgentUserDataEntitySummary>(rawEntities.formEntries),
    knowledgeBaseItems: arrayOf<AgentUserDataEntitySummary>(rawEntities.knowledgeBaseItems),
    templates: arrayOf<AgentUserDataEntitySummary>(rawEntities.templates),
    xVextaProjects: arrayOf<XVextaProject>(rawEntities.xVextaProjects),
    xVextaNotes: arrayOf<XVextaNote>(rawEntities.xVextaNotes),
  }

  return {
    profile,
    entities,
    counts: countEntities(entities),
    recommendations: arrayOf<AgentSignal>(record.recommendations),
    generatedAt: readString(record.generatedAt) ?? new Date().toISOString(),
    source: normalizeSource(record.source),
    syncRevision: readString(record.syncRevision) ?? `snapshot-${Date.now()}`,
    errors: arrayOf<string>(record.errors).filter((entry) => typeof entry === 'string'),
  }
}

function profileToSummary(profile: UserProfile): AgentUserDataEntitySummary {
  return {
    kind: 'profile',
    id: profile.id,
    title: profile.displayName || profile.email,
    summary: profile.email,
    detail: profile.settings.timezone,
    updatedAt: profile.updatedAt,
    raw: profile,
  }
}

function noteToSummary(note: Note): AgentUserDataEntitySummary {
  return {
    kind: 'note',
    id: note.id,
    title: note.title || 'Untitled note',
    summary: note.body,
    detail: note.isArchived ? 'Archived' : note.isPinned ? 'Pinned' : 'Note',
    updatedAt: note.updatedAt,
    raw: note,
  }
}

function taskToSummary(task: Task): AgentUserDataEntitySummary {
  return {
    kind: 'task',
    id: task.id,
    title: task.title,
    summary: task.description ?? undefined,
    detail: task.dueAt ? `${task.status} · due ${task.dueAt}` : task.status,
    updatedAt: task.updatedAt,
    raw: task,
  }
}

function reminderToSummary(reminder: Reminder): AgentUserDataEntitySummary {
  return {
    kind: 'reminder',
    id: reminder.id,
    title: reminder.title,
    summary: reminder.body ?? undefined,
    detail: reminder.scheduledAt,
    updatedAt: reminder.updatedAt,
    raw: reminder,
  }
}

function inboxToSummary(item: InboxItem): AgentUserDataEntitySummary {
  return {
    kind: 'inbox',
    id: item.id,
    title: item.title,
    summary: item.body,
    detail: item.kind,
    updatedAt: item.updatedAt,
    raw: item,
  }
}

function memoryToSummary(memory: MemoryEntry): AgentUserDataEntitySummary {
  return {
    kind: 'memory',
    id: memory.id,
    title: memory.title,
    summary: memory.summary,
    detail: memory.category,
    updatedAt: memory.updatedAt,
    raw: memory,
  }
}

function xVextaProjectToSummary(project: XVextaProject): AgentUserDataEntitySummary {
  return {
    kind: 'x_vexta_project',
    id: project.id,
    title: project.name,
    summary: project.summary,
    detail: project.code,
    updatedAt: project.updatedAt,
    raw: project,
  }
}

function xVextaNoteToSummary(note: XVextaNote): AgentUserDataEntitySummary {
  return {
    kind: 'x_vexta_note',
    id: note.id,
    title: note.title,
    summary: note.summary,
    detail: note.status,
    updatedAt: note.updatedAt,
    raw: note,
  }
}

function dedupeSummaries(summaries: AgentUserDataEntitySummary[]): AgentUserDataEntitySummary[] {
  const seen = new Set<string>()
  return summaries.filter((entry) => {
    const key = `${normalizeKind(entry.kind)}:${entry.id}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function normalizeKind(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, '_')
}

function normalizeSource(value: unknown): EcosystemUserDataSnapshot['source'] {
  return value === 'ecosystem' ||
    value === 'local-backend' ||
    value === 'agent-message-fallback' ||
    value === 'cache' ||
    value === 'empty'
    ? value
    : 'cache'
}

function createFallbackProfile(): UserProfile {
  const now = new Date().toISOString()
  return {
    id: 'ecosystem-user',
    tenantId: 'ecosystem',
    email: '',
    displayName: 'Ecosystem user',
    avatarUrl: null,
    settings: {
      timezone: 'Europe/Moscow',
      locale: 'ru',
      bedtimeStart: null,
      quietHoursStart: null,
      quietHoursEnd: null,
    },
    createdAt: now,
    updatedAt: now,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
