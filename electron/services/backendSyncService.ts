import type {
  AgentActionRequest,
  AgentActionResult,
  AgentActionType,
  AgentContext,
  AgentEntityReference,
  AgentConfirmationInput,
  AgentMessageEnvelope,
  AgentMessageInput,
  AgentPendingAction,
  AgentSignal,
  AgentTouchedEntity,
  AgentUserDataEntitySummary,
  AgentUserDataOverview,
  AgentUserDataSearchInput,
  EcosystemUserDataActionRequest,
  EcosystemUserDataActionResult,
  EcosystemUserDataCounts,
  EcosystemUserDataEntities,
  EcosystemUserDataSnapshot,
  AgentMailAccount,
  AgentMailContact,
  AgentMailMessage,
  AuthLoginInput,
  AuthRegisterInput,
  AuthSession,
  BackendConfig,
  BackendSessionState,
  CreateAgentMailMessageInput,
  CreateAppTokenInput,
  CreateMemoryInput,
  CreateNoteInput,
  CreateReminderInput,
  CreateTaskInput,
  InboxItem,
  ListAgentMailContactsInput,
  ListAgentMailMessagesInput,
  LocalSessionInput,
  MemoryEntry,
  Note,
  Reminder,
  Task,
  UpsertAgentMailContactInput,
  UpsertAgentMailAccountInput,
  UpdateMemoryInput,
  UpdateNoteInput,
  UpdateReminderInput,
  UpdateSettingsInput,
  UpdateTaskInput,
  SubscriptionPlan,
  UserProfile,
} from '@contracts'

import { FridayLogger } from './logger'
import { BackendConfigService } from './backendConfigService'
import { BackendRuntimeService } from './backendRuntimeService'
import { BackendSessionService } from './backendSessionService'

const ECOSYSTEM_API_BASE_URL = normalizeExternalBaseUrl(
  process.env.FRIDAY_ECOSYSTEM_API_BASE_URL ?? 'https://xvexta.ru/api',
)

type EcosystemLoginResponse = {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    email: string
    name: string
    role: string
  }
}

type EcosystemMeResponse = {
  id: string
  email: string
  name: string
  avatarUrl?: string | null
  profile?: {
    displayName?: string | null
    timezone?: string | null
    language?: string | null
  } | null
}

type EcosystemSubscriptionResponse = {
  status?: string | null
  plan?: string | null
  product?: string | null
  tier?: string | null
  name?: string | null
  slug?: string | null
}

export class BackendSyncService {
  private readonly configService: BackendConfigService
  private readonly sessionService: BackendSessionService
  private readonly runtimeService: BackendRuntimeService
  private readonly logger: FridayLogger

  constructor(
    configService: BackendConfigService,
    sessionService: BackendSessionService,
    runtimeService: BackendRuntimeService,
    logger: FridayLogger,
  ) {
    this.configService = configService
    this.sessionService = sessionService
    this.runtimeService = runtimeService
    this.logger = logger
  }

  getConfig(): Promise<BackendConfig> {
    return this.configService.load()
  }

  saveConfig(config: BackendConfig): Promise<BackendConfig> {
    return this.configService.save(config)
  }

  getSessionState(): Promise<BackendSessionState> {
    return this.sessionService.load()
  }

  saveSessionState(state: BackendSessionState): Promise<BackendSessionState> {
    return this.sessionService.save(state)
  }

  clearSessionState(): Promise<BackendSessionState> {
    return this.sessionService.clear()
  }

  async register(input: AuthRegisterInput): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    await this.sessionService.save({
      session,
      appToken: null,
      appRefreshToken: null,
      updatedAt: new Date().toISOString(),
    })
    return session
  }

  async login(input: AuthLoginInput): Promise<AuthSession> {
    const ecosystemIdentity = await this.authenticateAgainstEcosystem(input)
    const session = await this.request<AuthSession>('/auth/ecosystem-login', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email.trim(),
        password: input.password,
        displayName: ecosystemIdentity.displayName,
        timezone: ecosystemIdentity.timezone,
        locale: ecosystemIdentity.locale,
      } satisfies AuthRegisterInput),
    })
    await this.sessionService.save({
      session,
      appToken: ecosystemIdentity.accessToken,
      appRefreshToken: ecosystemIdentity.refreshToken,
      subscriptionPlan: ecosystemIdentity.subscriptionPlan,
      updatedAt: new Date().toISOString(),
    })
    return session
  }

  async ensureLocalSession(input: LocalSessionInput): Promise<BackendSessionState> {
    const stored = await this.sessionService.load()
    if (stored.session) {
      try {
        const profile = await this.getMe()
        return this.sessionService.save({
          ...stored,
          session: {
            ...stored.session,
            user: profile,
          },
          updatedAt: new Date().toISOString(),
        })
      } catch (error) {
        await this.logger.info(`Stored backend session is not reusable, creating a local session: ${formatError(error)}`)
      }
    }

    const session = await this.request<AuthSession>('/auth/local', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return this.sessionService.save({
      session,
      appToken: null,
      updatedAt: new Date().toISOString(),
    })
  }

  async createAppToken(input: CreateAppTokenInput): Promise<{ token: string }> {
    const result = await this.authedRequest<{ token: string }>('/auth/token', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    const state = await this.sessionService.load()
    await this.sessionService.save({
      ...state,
      appToken: result.token,
      updatedAt: new Date().toISOString(),
    })
    return result
  }

  getMe(): Promise<UserProfile> {
    return this.authedRequest('/me')
  }

  updateSettings(input: UpdateSettingsInput): Promise<UserProfile> {
    return this.authedRequest('/me/settings', {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  getAgentMailAccount(): Promise<AgentMailAccount | null> {
    return this.authedRequest('/mail/account')
  }

  getAgentMailMessage(id: string): Promise<AgentMailMessage> {
    return this.authedRequest(`/mail/messages/${id}`)
  }

  upsertAgentMailAccount(input: UpsertAgentMailAccountInput): Promise<AgentMailAccount> {
    return this.authedRequest('/mail/account', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  }

  listAgentMailMessages(input: ListAgentMailMessagesInput = {}): Promise<AgentMailMessage[]> {
    const params = new URLSearchParams()
    if (input.folder) {
      params.set('folder', input.folder)
    }

    const pathname = params.size > 0 ? `/mail/messages?${params.toString()}` : '/mail/messages'
    return this.authedRequest(pathname)
  }

  createAgentMailMessage(input: CreateAgentMailMessageInput): Promise<AgentMailMessage> {
    return this.authedRequest('/mail/messages', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  listAgentMailContacts(input: ListAgentMailContactsInput = {}): Promise<AgentMailContact[]> {
    const params = new URLSearchParams()
    if (input.query?.trim()) {
      params.set('query', input.query.trim())
    }

    const pathname = params.size > 0 ? `/mail/contacts?${params.toString()}` : '/mail/contacts'
    return this.authedRequest(pathname)
  }

  upsertAgentMailContact(input: UpsertAgentMailContactInput): Promise<AgentMailContact> {
    return this.authedRequest('/mail/contacts', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  }

  deleteAgentMailContact(id: string): Promise<{ ok: boolean }> {
    return this.authedRequest(`/mail/contacts/${id}`, {
      method: 'DELETE',
    })
  }

  markAgentMailMessageRead(id: string): Promise<AgentMailMessage> {
    return this.authedRequest(`/mail/messages/${id}/read`, {
      method: 'POST',
    })
  }

  async listNotes(): Promise<Note[]> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        return await this.externalAuthedCollectionFirstAvailable(
          ['/api/notes', '/notes'],
          externalToken,
          ['notes'],
          normalizeNote,
        )
      } catch (error) {
        await this.logger.error(`External notes list failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequest('/notes')
  }

  createNote(input: CreateNoteInput): Promise<Note> {
    return this.authedRequest('/notes', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  updateNote(id: string, input: UpdateNoteInput): Promise<Note> {
    return this.authedRequest(`/notes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  async deleteNote(id: string): Promise<{ ok: boolean }> {
    return this.authedRequest(`/notes/${id}`, {
      method: 'DELETE',
    })
  }

  async listTasks(): Promise<Task[]> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        return await this.externalAuthedCollectionFirstAvailable(
          ['/api/tasks', '/tasks'],
          externalToken,
          ['tasks'],
          normalizeTask,
        )
      } catch (error) {
        await this.logger.error(`External tasks list failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequest('/tasks')
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.authedRequest('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    return this.authedRequest(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  async deleteTask(id: string): Promise<{ ok: boolean }> {
    return this.authedRequest(`/tasks/${id}`, {
      method: 'DELETE',
    })
  }

  async listReminders(): Promise<Reminder[]> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        return await this.externalAuthedCollectionFirstAvailable(
          ['/api/reminders', '/reminders'],
          externalToken,
          ['reminders'],
          normalizeReminder,
        )
      } catch (error) {
        await this.logger.error(`External reminders list failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequest('/reminders')
  }

  createReminder(input: CreateReminderInput): Promise<Reminder> {
    return this.authedRequest('/reminders', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  updateReminder(id: string, input: UpdateReminderInput): Promise<Reminder> {
    return this.authedRequest(`/reminders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  async deleteReminder(id: string): Promise<{ ok: boolean }> {
    return this.authedRequest(`/reminders/${id}`, {
      method: 'DELETE',
    })
  }

  async listInbox(): Promise<InboxItem[]> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        return await this.externalAuthedCollectionFirstAvailable(
          ['/api/inbox', '/inbox'],
          externalToken,
          ['inbox', 'items'],
          normalizeInboxItem,
        )
      } catch (error) {
        await this.logger.error(`External inbox list failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequest('/inbox')
  }

  markInboxRead(id: string): Promise<InboxItem> {
    return this.authedRequest(`/inbox/${id}/read`, {
      method: 'POST',
    })
  }

  async listMemories(query?: string): Promise<MemoryEntry[]> {
    const params = new URLSearchParams()
    if (query?.trim()) {
      params.set('query', query.trim())
    }

    const pathname = params.size > 0 ? `/memory?${params.toString()}` : '/memory'
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        return await this.externalAuthedCollectionFirstAvailable(
          [`/api${pathname}`, pathname, pathname.replace('/memory', '/memories')],
          externalToken,
          ['memory', 'memories'],
          normalizeMemoryEntry,
        )
      } catch (error) {
        await this.logger.error(`External memory list failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequest(pathname)
  }

  async getMemory(id: string): Promise<MemoryEntry> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        const raw = await this.externalAuthedRequestFirstAvailable<unknown>(
          [`/api/memory/${id}`, `/memory/${id}`, `/api/memories/${id}`, `/memories/${id}`],
          externalToken,
        )
        const memory = normalizeMemoryEntry(raw)
        if (memory) {
          return memory
        }
      } catch (error) {
        await this.logger.error(`External memory read failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequest(`/memory/${id}`)
  }

  createMemory(input: CreateMemoryInput): Promise<MemoryEntry> {
    return this.authedRequest('/memory', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  updateMemory(id: string, input: UpdateMemoryInput): Promise<MemoryEntry> {
    return this.authedRequest(`/memory/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  deleteMemory(id: string): Promise<{ ok: boolean }> {
    return this.authedRequest(`/memory/${id}`, {
      method: 'DELETE',
    })
  }

  async getAgentContext(): Promise<AgentContext> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        const raw = await this.externalAuthedRequestFirstAvailable<unknown>(
          ['/api/agent/context', '/agent/context'],
          externalToken,
        )
        return normalizeAgentContextResponse(raw)
      } catch (error) {
        await this.logger.error(`External agent context failed, trying direct ecosystem collections: ${formatError(error)}`)
      }

      try {
        return await this.buildExternalAgentContextSnapshot(externalToken)
      } catch (error) {
        await this.logger.error(`External user-data snapshot failed: ${formatError(error)}`)
        throw new Error(
          'Не удалось загрузить данные Экосистемы. Если вы давно входили в аккаунт, войдите заново, чтобы обновить защищенный токен.',
        )
      }
    }

    return this.authedRequest('/agent/context')
  }

  async getUserDataOverview(): Promise<AgentUserDataOverview> {
    const context = await this.getAgentContext()
    return {
      context,
      counts: {
        tasks: context.todayTasks.length + context.overdueTasks.length,
        overdueTasks: context.overdueTasks.length,
        reminders: context.activeReminders.length,
        notes: context.recentNotes.length,
        memories: context.recentMemories.length,
        inbox: context.unreadInbox.length,
        xVextaProjects: context.xVextaProjects.length,
        xVextaNotes: context.xVextaNotes.length,
      },
      recommendations: context.derivedSignals,
      generatedAt: context.generatedAt,
    }
  }

  async fetchEcosystemUserDataSnapshot(): Promise<EcosystemUserDataSnapshot> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      let endpointError: unknown = null
      try {
        const raw = await this.fetchFridayUserDataSnapshotEndpoint(externalToken)
        return normalizeEcosystemUserDataSnapshotResponse(raw, 'ecosystem')
      } catch (error) {
        endpointError = error
        await this.logger.error(`External user-data snapshot endpoint failed: ${formatError(error)}`)
      }

      if (isMissingEndpointError(endpointError)) {
        try {
          return await this.fetchEcosystemUserDataSnapshotViaAgentMessage(externalToken)
        } catch (error) {
          await this.logger.error(`External user-data snapshot agent fallback failed: ${formatError(error)}`)
        }
      }

      throw new Error('Не удалось получить свежий snapshot данных Экосистемы. Показываю последнюю успешную синхронизацию.')
    }

    const localContext = await this.authedRequest<AgentContext>('/agent/context')
    return buildSnapshotFromAgentContext(localContext, 'local-backend', [])
  }

  async runEcosystemUserDataAction(input: EcosystemUserDataActionRequest): Promise<EcosystemUserDataActionResult> {
    if (isIrreversibleAction(input.action.type) && !input.confirmed) {
      return buildConfirmationRequiredResult(input)
    }

    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        const raw = await this.externalAuthedRequestFirstAvailable<unknown>(
          ['/api/friday/user-data/actions', '/friday/user-data/actions'],
          externalToken,
          {
            method: 'POST',
            body: input,
          },
        )
        return normalizeEcosystemActionResult(raw, input)
      } catch (error) {
        await this.logger.error(`External user-data action endpoint failed: ${formatError(error)}`)
      }

      try {
        const actionResult = await this.externalAuthedRequestFirstAvailable<AgentActionResult>(
          ['/api/agent/actions', '/agent/actions'],
          externalToken,
          {
            method: 'POST',
            body: {
              action: input.action,
            },
          },
        )
        return normalizeEcosystemActionResult(actionResult, input)
      } catch (error) {
        await this.logger.error(`External legacy agent action fallback failed: ${formatError(error)}`)
      }
    }

    const result = await this.authedRequest<AgentActionResult>('/agent/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: input.action,
      }),
    })
    return normalizeEcosystemActionResult(result, input)
  }

  private async fetchFridayUserDataSnapshotEndpoint(token: string): Promise<unknown> {
    const attempts = [15_000, 30_000, 45_000]
    let lastError: unknown = null

    for (const timeoutMs of attempts) {
      const cacheBust = `desktopSync=${Date.now()}`
      const separator = '/api/friday/user-data/snapshot'.includes('?') ? '&' : '?'
      try {
        return await this.externalAuthedRequestFirstAvailable<unknown>(
          [
            `/api/friday/user-data/snapshot${separator}${cacheBust}`,
            `/friday/user-data/snapshot${separator}${cacheBust}`,
          ],
          token,
          {
            headers: {
              'cache-control': 'no-cache',
            },
            timeoutMs,
          },
        )
      } catch (error) {
        lastError = error
        if (!isTimeoutLikeError(error)) {
          throw error
        }
        await delay(300)
      }
    }

    throw lastError instanceof Error ? lastError : new Error('External user-data snapshot endpoint failed')
  }

  async searchUserDataEntities(input: AgentUserDataSearchInput = {}): Promise<AgentUserDataEntitySummary[]> {
    const [context, memories] = await Promise.all([
      this.getAgentContext(),
      this.listMemories(input.query).catch(() => []),
    ])

    return filterEntitySummaries(buildEntitySummaries(context, memories), input)
  }

  async getUserDataEntity(input: AgentEntityReference): Promise<AgentUserDataEntitySummary | null> {
    const kind = normalizeEntityKind(input.kind)

    if (kind === 'memory') {
      try {
        return memoryToSummary(await this.getMemory(input.id))
      } catch {
        return null
      }
    }

    const [context, notes, tasks, reminders, inbox] = await Promise.all([
      this.getAgentContext(),
      kind === 'note' ? this.listNotes().catch(() => []) : Promise.resolve([]),
      kind === 'task' ? this.listTasks().catch(() => []) : Promise.resolve([]),
      kind === 'reminder' ? this.listReminders().catch(() => []) : Promise.resolve([]),
      kind === 'inbox' ? this.listInbox().catch(() => []) : Promise.resolve([]),
    ])

    return (
      buildEntitySummaries(context, context.recentMemories)
        .concat(notes.map(noteToSummary), tasks.map(taskToSummary), reminders.map(reminderToSummary), inbox.map(inboxItemToSummary))
        .find((entry) => normalizeEntityKind(entry.kind) === kind && entry.id === input.id) ?? null
    )
  }

  async sendAgentMessage(input: AgentMessageInput): Promise<AgentMessageEnvelope> {
    const startedAt = Date.now()
    const payload = {
      sessionId: input.sessionId,
      message: input.text,
      text: input.text,
      latencyMode: input.latencyMode ?? 'fast',
      confirmationPolicy: input.confirmationPolicy ?? 'auto_except_delete',
    }

    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        const raw = await this.externalAuthedRequestFirstAvailable<unknown>(
          ['/api/agent/message', '/agent/message'],
          externalToken,
          {
            method: 'POST',
            body: payload,
          },
        )
        return normalizeAgentMessageEnvelope(raw, Date.now() - startedAt)
      } catch (error) {
        await this.logger.error(`External agent message failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    const raw = await this.authedRequestFirstAvailable<unknown>(['/api/agent/message', '/agent/message'], {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    return normalizeAgentMessageEnvelope(raw, Date.now() - startedAt)
  }

  async runAgentAction(input: AgentActionRequest): Promise<AgentActionResult> {
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        return await this.externalAuthedRequestFirstAvailable<AgentActionResult>(
          ['/api/agent/actions', '/agent/actions'],
          externalToken,
          {
            method: 'POST',
            body: input,
          },
        )
      } catch (error) {
        await this.logger.error(`External agent action failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequest('/agent/actions', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async confirmAgentAction(input: AgentConfirmationInput): Promise<AgentActionResult> {
    if (input.pendingAction.action) {
      return this.runAgentAction(input.pendingAction.action)
    }

    const payload = {
      pendingAction: input.pendingAction,
      pending_action: input.pendingAction.raw ?? input.pendingAction,
    }
    const externalToken = await this.getExternalAccessToken()
    if (externalToken) {
      try {
        return await this.externalAuthedRequestFirstAvailable<AgentActionResult>(
          ['/api/agent/actions/confirm', '/agent/actions/confirm'],
          externalToken,
          {
            method: 'POST',
            body: payload,
          },
        )
      } catch (error) {
        await this.logger.error(`External agent confirmation failed, falling back to local backend: ${formatError(error)}`)
      }
    }

    return this.authedRequestFirstAvailable<AgentActionResult>(['/api/agent/actions/confirm', '/agent/actions/confirm'], {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  private async fetchEcosystemUserDataSnapshotViaAgentMessage(token: string): Promise<EcosystemUserDataSnapshot> {
    const startedAt = Date.now()
    const raw = await this.externalAuthedRequestFirstAvailable<unknown>(
      ['/api/agent/message', '/agent/message'],
      token,
      {
        method: 'POST',
        body: {
          sessionId: `friday-snapshot-${Date.now()}`,
          message: buildSnapshotAgentPrompt(),
          text: buildSnapshotAgentPrompt(),
          latencyMode: 'fast',
          confirmationPolicy: 'auto_except_delete',
        },
      },
    )
    const envelope = normalizeAgentMessageEnvelope(raw, Date.now() - startedAt)
    const parsed = parseJsonObjectFromText(envelope.reply)
    if (!parsed) {
      throw new Error('Agent snapshot fallback did not return JSON.')
    }

    return normalizeEcosystemUserDataSnapshotResponse(parsed, 'agent-message-fallback')
  }

  private async buildExternalAgentContextSnapshot(token: string): Promise<AgentContext> {
    const [profile, notes, tasks, reminders, inbox, memories, xVextaProjects, xVextaNotes] = await Promise.all([
      this.getExternalProfileSnapshot(token).catch(() => null),
      this.externalAuthedCollectionFirstAvailable(['/api/notes', '/notes'], token, ['notes'], normalizeNote).catch(() => []),
      this.externalAuthedCollectionFirstAvailable(['/api/tasks', '/tasks'], token, ['tasks'], normalizeTask).catch(() => []),
      this.externalAuthedCollectionFirstAvailable(['/api/reminders', '/reminders'], token, ['reminders'], normalizeReminder).catch(() => []),
      this.externalAuthedCollectionFirstAvailable(['/api/inbox', '/inbox'], token, ['inbox', 'items'], normalizeInboxItem).catch(() => []),
      this.externalAuthedCollectionFirstAvailable(
        ['/api/memory', '/memory', '/api/memories', '/memories', '/api/agent/memory', '/agent/memory'],
        token,
        ['memory', 'memories'],
        normalizeMemoryEntry,
      ).catch(() => []),
      this.externalAuthedCollectionFirstAvailable(
        ['/api/x-vexta/projects', '/x-vexta/projects', '/api/projects', '/projects'],
        token,
        ['projects', 'xVextaProjects', 'x_vexta_projects'],
        normalizeXVextaProject,
      ).catch(() => []),
      this.externalAuthedCollectionFirstAvailable(
        ['/api/x-vexta/notes', '/x-vexta/notes', '/api/documents', '/documents'],
        token,
        ['notes', 'documents', 'xVextaNotes', 'x_vexta_notes'],
        normalizeXVextaNote,
      ).catch(() => []),
    ])

    if (
      !profile &&
      notes.length === 0 &&
      tasks.length === 0 &&
      reminders.length === 0 &&
      inbox.length === 0 &&
      memories.length === 0 &&
      xVextaProjects.length === 0 &&
      xVextaNotes.length === 0
    ) {
      throw new Error('External ecosystem returned no readable user-data collections.')
    }

    return buildAgentContextFromCollections(
      profile ?? createFallbackProfile(),
      notes,
      tasks,
      reminders,
      inbox,
      memories,
      xVextaProjects,
      xVextaNotes,
    )
  }

  private async getExternalProfileSnapshot(token: string): Promise<UserProfile | null> {
    const raw = await this.externalAuthedRequestFirstAvailable<unknown>(['/api/me', '/me'], token)
    return normalizeUserProfile(raw)
  }

  private async getExternalAccessToken(): Promise<string | null> {
    const state = await this.sessionService.load()
    const token = state.appToken?.trim() || null
    if (token && !isJwtExpiringSoon(token)) {
      return token
    }

    const refreshToken = state.appRefreshToken?.trim()
    if (!refreshToken) {
      return token
    }

    try {
      const refreshed = await this.refreshEcosystemAccessToken(refreshToken)
      await this.sessionService.save({
        ...state,
        appToken: refreshed.accessToken,
        appRefreshToken: refreshed.refreshToken ?? refreshToken,
        updatedAt: new Date().toISOString(),
      })
      return refreshed.accessToken
    } catch (error) {
      await this.logger.error(`External token refresh failed: ${formatError(error)}`)
      return token
    }
  }

  private async refreshEcosystemAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }> {
    const attempts = [
      { refreshToken },
      { token: refreshToken },
      { refresh_token: refreshToken },
    ]

    let lastError: unknown = null
    for (const body of attempts) {
      try {
        const response = await this.externalJsonRequest<Partial<EcosystemLoginResponse>>(`${ECOSYSTEM_API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          body,
        })
        const accessToken = readString(response.accessToken)
        if (accessToken) {
          return {
            accessToken,
            refreshToken: readString(response.refreshToken) ?? undefined,
          }
        }
        lastError = new Error('Refresh response did not include accessToken')
      } catch (error) {
        lastError = error
      }
    }

    throw lastError instanceof Error ? lastError : new Error('External token refresh failed')
  }

  private async externalAuthedRequestFirstAvailable<T>(
    pathnames: string[],
    token: string,
    init: {
      method?: string
      headers?: Record<string, string>
      body?: unknown
      timeoutMs?: number
    } = {},
  ): Promise<T> {
    let lastError: unknown = null
    for (const pathname of normalizeCandidatePathnames(ECOSYSTEM_API_BASE_URL, pathnames)) {
      try {
        return await this.externalJsonRequest<T>(`${ECOSYSTEM_API_BASE_URL}${pathname}`, {
          method: init.method,
          body: init.body,
          timeoutMs: init.timeoutMs,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${token}`,
          },
        })
      } catch (error) {
        lastError = error
      }
    }

    throw lastError instanceof Error ? lastError : new Error('External ecosystem request failed')
  }

  private async externalAuthedCollectionFirstAvailable<T>(
    pathnames: string[],
    token: string,
    keys: string[],
    mapper: (value: unknown) => T | null,
  ): Promise<T[]> {
    const raw = await this.externalAuthedRequestFirstAvailable<unknown>(pathnames, token)
    return extractCollection(raw, keys).map(mapper).filter((item): item is T => item !== null)
  }

  private async authedRequest<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const state = await this.sessionService.load()
    const token = state.session?.token
    if (!token) {
      throw new Error('Backend session is missing')
    }

    return this.request<T>(pathname, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    })
  }

  private async authedRequestFirstAvailable<T>(pathnames: string[], init: RequestInit = {}): Promise<T> {
    const state = await this.sessionService.load()
    const token = state.session?.token
    if (!token) {
      throw new Error('Backend session is missing')
    }

    const config = await this.configService.load()
    await this.runtimeService.ensureRunning()

    let lastError: unknown = null
    for (const pathname of normalizeCandidatePathnames(config.baseUrl, pathnames)) {
      try {
        return await this.requestAbsolute<T>(`${config.baseUrl}${pathname}`, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${token}`,
          },
        })
      } catch (error) {
        lastError = error
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Backend request failed')
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const config = await this.configService.load()
    await this.runtimeService.ensureRunning()
    return this.requestAbsolute<T>(`${config.baseUrl}${pathname}`, init)
  }

  private async requestAbsolute<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers ?? {})
    const hasBody = init.body !== undefined && init.body !== null

    if (hasBody) {
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json')
      }
    } else {
      headers.delete('content-type')
    }

    const response = await fetch(url, {
      ...init,
      headers,
    })

    if (!response.ok) {
      const error = await safeParseError(response)
      await this.logger.error(`Backend request failed: ${url} ${error}`)
      throw new Error(error)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return response.json() as Promise<T>
  }

  private async authenticateAgainstEcosystem(input: AuthLoginInput): Promise<{
    accessToken: string
    refreshToken: string
    displayName: string
    timezone: string
    locale: 'ru' | 'en'
    subscriptionPlan: SubscriptionPlan
  }> {
    const login = await this.externalJsonRequestWithRetry<EcosystemLoginResponse>(
      `${ECOSYSTEM_API_BASE_URL}/auth/login`,
      {
        method: 'POST',
        timeoutMs: 45_000,
        body: {
          email: input.email.trim(),
          password: input.password,
        },
      },
      { attempts: 3, label: 'login' },
    )

    const headers = {
      Authorization: `Bearer ${login.accessToken}`,
    }

    const [profile, subscription] = await Promise.all([
      this.externalJsonRequestWithRetry<EcosystemMeResponse>(
        `${ECOSYSTEM_API_BASE_URL}/me`,
        {
          headers,
          timeoutMs: 20_000,
        },
        { attempts: 2, label: 'profile' },
      ),
      this.externalJsonRequestWithRetry<EcosystemSubscriptionResponse>(
        `${ECOSYSTEM_API_BASE_URL}/subscription`,
        {
          headers,
          timeoutMs: 20_000,
        },
        { attempts: 2, label: 'subscription' },
      ),
    ])

    const subscriptionStatus = (subscription.status ?? '').toUpperCase()
    if (subscriptionStatus !== 'ACTIVE' && subscriptionStatus !== 'TRIALING') {
      throw new Error('Subscription is not active')
    }

    const timezone = profile.profile?.timezone?.trim() || 'Europe/Moscow'
    const displayName = profile.profile?.displayName?.trim() || profile.name?.trim() || login.user.name?.trim() || input.email.trim()
    const rawLanguage = profile.profile?.language?.trim().toLowerCase()
    const locale: 'ru' | 'en' = rawLanguage === 'en' ? 'en' : 'ru'

    return {
      accessToken: login.accessToken,
      refreshToken: login.refreshToken,
      displayName,
      timezone,
      locale,
      subscriptionPlan: normalizeSubscriptionPlan(subscription),
    }
  }

  private async externalJsonRequestWithRetry<T>(
    url: string,
    input: {
      method?: string
      headers?: Record<string, string>
      body?: unknown
      timeoutMs?: number
    } = {},
    options: {
      attempts?: number
      label?: string
    } = {},
  ): Promise<T> {
    const attempts = Math.max(1, options.attempts ?? 3)
    let lastError: unknown = null

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.externalJsonRequest<T>(url, input)
      } catch (error) {
        lastError = error
        if (!isTimeoutLikeError(error) || attempt >= attempts) {
          break
        }

        await this.logger.info(
          `External ecosystem ${options.label ?? 'request'} timed out, retrying ${attempt + 1}/${attempts}: ${url}`,
        )
        await delay(750 * attempt)
      }
    }

    throw lastError instanceof Error ? lastError : new Error('External ecosystem request failed')
  }

  private async externalJsonRequest<T>(
    url: string,
    input: {
      method?: string
      headers?: Record<string, string>
      body?: unknown
      timeoutMs?: number
    } = {},
  ): Promise<T> {
    const method = input.method ?? 'GET'
    const serializedBody = input.body === undefined ? undefined : JSON.stringify(input.body)
    const headers: Record<string, string> = {
      accept: 'application/json',
      connection: 'close',
      ...(input.headers ?? {}),
    }
    const timeoutMs = input.timeoutMs ?? 20_000

    if (serializedBody !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json'
      headers['content-length'] = String(Buffer.byteLength(serializedBody))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
      })
      const raw = await response.text()

      if (!response.ok) {
        const error = parseErrorText(raw, response.status)
        await this.logger.error(`External ecosystem request failed: ${url} ${error}`)
        throw new Error(error)
      }

      try {
        return JSON.parse(raw) as T
      } catch (error) {
        throw new Error(`Invalid JSON from ecosystem API: ${formatError(error)}`)
      }
    } catch (error) {
      const normalized =
        error instanceof Error && error.name === 'AbortError'
          ? new Error(`External ecosystem request timed out: ${url}`)
          : error
      await this.logger.error(`External ecosystem request error: ${url} ${formatError(normalized)}`)
      throw normalized
    } finally {
      clearTimeout(timeout)
    }
  }
}

async function safeParseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingEndpointError(error: unknown): boolean {
  return /\b(?:404|not found|cannot get)\b/i.test(formatError(error))
}

function isTimeoutLikeError(error: unknown): boolean {
  return /timed out|timeout|fetch failed|socket disconnected|econnreset|etimedout/i.test(formatError(error))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeExternalBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function normalizeCandidatePathnames(baseUrl: string, pathnames: string[]): string[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/api')) {
    return pathnames.map((pathname) => pathname.replace(/^\/api(?=\/|$)/, '') || '/').filter(unique)
  }

  return pathnames.filter(unique)
}

function unique<T>(value: T, index: number, source: T[]): boolean {
  return source.indexOf(value) === index
}

function extractCollection(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) {
    return raw
  }

  const record = asRecord(raw)
  if (!record) {
    return []
  }

  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value
    }
  }

  for (const key of ['items', 'results', 'rows', 'entries']) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value
    }
  }

  const data = record.data
  if (Array.isArray(data)) {
    return data
  }
  if (asRecord(data)) {
    return extractCollection(data, keys)
  }

  return []
}

function normalizeAgentContext(value: unknown): AgentContext {
  const record = asRecord(value) ?? {}
  const profile = normalizeUserProfile(record.profile) ?? createFallbackProfile()
  const notes = extractCollection(record.recentNotes ?? record.notes, ['recentNotes', 'notes']).map(normalizeNote).filter((item): item is Note => item !== null)
  const tasks = [
    ...extractCollection(record.todayTasks, ['todayTasks']).map(normalizeTask).filter((item): item is Task => item !== null),
    ...extractCollection(record.overdueTasks, ['overdueTasks']).map(normalizeTask).filter((item): item is Task => item !== null),
  ]
  const reminders = extractCollection(record.activeReminders ?? record.reminders, ['activeReminders', 'reminders'])
    .map(normalizeReminder)
    .filter((item): item is Reminder => item !== null)
  const memories = extractCollection(record.recentMemories ?? record.memory ?? record.memories, ['recentMemories', 'memory', 'memories'])
    .map(normalizeMemoryEntry)
    .filter((item): item is MemoryEntry => item !== null)
  const inbox = extractCollection(record.unreadInbox ?? record.inbox, ['unreadInbox', 'inbox'])
    .map(normalizeInboxItem)
    .filter((item): item is InboxItem => item !== null)
  const xVextaProjects = extractCollection(record.xVextaProjects ?? record.x_vexta_projects, ['xVextaProjects', 'x_vexta_projects', 'projects'])
    .map(normalizeXVextaProject)
    .filter((item): item is AgentContext['xVextaProjects'][number] => item !== null)
  const xVextaNotes = extractCollection(record.xVextaNotes ?? record.x_vexta_notes, ['xVextaNotes', 'x_vexta_notes', 'documents', 'notes'])
    .map(normalizeXVextaNote)
    .filter((item): item is AgentContext['xVextaNotes'][number] => item !== null)
  const signals = extractCollection(record.derivedSignals ?? record.signals, ['derivedSignals', 'signals'])
    .map(normalizeAgentSignal)
    .filter((item): item is AgentContext['derivedSignals'][number] => item !== null)

  const context = buildAgentContextFromCollections(profile, notes, tasks, reminders, inbox, memories, xVextaProjects, xVextaNotes)
  return {
    ...context,
    derivedSignals: signals.length > 0 ? signals : context.derivedSignals,
    generatedAt: readString(record.generatedAt) ?? readString(record.generated_at) ?? context.generatedAt,
  }
}

function buildAgentContextFromCollections(
  profile: UserProfile,
  notes: Note[],
  tasks: Task[],
  reminders: Reminder[],
  inbox: InboxItem[],
  memories: MemoryEntry[],
  xVextaProjects: AgentContext['xVextaProjects'],
  xVextaNotes: AgentContext['xVextaNotes'],
): AgentContext {
  const activeTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'canceled')
  const today = new Date().toISOString().slice(0, 10)
  const overdueTasks = activeTasks.filter((task) => task.dueAt && task.dueAt.slice(0, 10) < today)
  const todayTasks = activeTasks.filter((task) => !overdueTasks.some((overdue) => overdue.id === task.id))

  return {
    profile,
    todayTasks: sortByUpdatedAt(todayTasks).slice(0, 80),
    overdueTasks: sortByUpdatedAt(overdueTasks).slice(0, 80),
    activeReminders: sortByUpdatedAt(reminders).slice(0, 80),
    recentNotes: sortByUpdatedAt(notes).slice(0, 80),
    recentMemories: sortByUpdatedAt(memories).slice(0, 80),
    mailContacts: [],
    xVextaProjects: sortByUpdatedAt(xVextaProjects).slice(0, 80),
    xVextaNotes: sortByUpdatedAt(xVextaNotes).slice(0, 80),
    unreadInbox: sortByUpdatedAt(inbox.filter((item) => item.status !== 'read')).slice(0, 80),
    derivedSignals: buildDerivedSignals(activeTasks, reminders),
    generatedAt: new Date().toISOString(),
  }
}

function normalizeUserProfile(value: unknown): UserProfile | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const profile = asRecord(record.profile) ?? {}
  const settings = asRecord(record.settings) ?? asRecord(profile.settings) ?? {}
  const id = readStringAt(record, ['id', 'userId', 'user_id']) ?? readStringAt(profile, ['id', 'userId', 'user_id'])
  const email = readStringAt(record, ['email']) ?? readStringAt(profile, ['email']) ?? ''
  if (!id && !email) {
    return null
  }

  const locale = readStringAt(settings, ['locale', 'language']) ?? readStringAt(profile, ['locale', 'language'])
  return {
    id: id ?? email,
    tenantId: readStringAt(record, ['tenantId', 'tenant_id']) ?? 'ecosystem',
    email,
    displayName:
      readStringAt(profile, ['displayName', 'display_name', 'name']) ??
      readStringAt(record, ['displayName', 'display_name', 'name']) ??
      email,
    avatarUrl: readStringAt(record, ['avatarUrl', 'avatar_url']) ?? readStringAt(profile, ['avatarUrl', 'avatar_url']),
    settings: {
      timezone: readStringAt(settings, ['timezone']) ?? readStringAt(profile, ['timezone']) ?? 'Europe/Moscow',
      locale: locale === 'en' ? 'en' : 'ru',
      bedtimeStart: readStringAt(settings, ['bedtimeStart', 'bedtime_start']),
      quietHoursStart: readStringAt(settings, ['quietHoursStart', 'quiet_hours_start']),
      quietHoursEnd: readStringAt(settings, ['quietHoursEnd', 'quiet_hours_end']),
    },
    createdAt: readStringAt(record, ['createdAt', 'created_at']) ?? new Date().toISOString(),
    updatedAt: readStringAt(record, ['updatedAt', 'updated_at']) ?? new Date().toISOString(),
  }
}

function normalizeNote(value: unknown): Note | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', 'noteId', 'note_id', '_id']) : null
  if (!record || !id) {
    return null
  }

  return {
    ...normalizeEntityBase(record, id),
    userId: readStringAt(record, ['userId', 'user_id', 'ownerId', 'owner_id']) ?? '',
    title: readStringAt(record, ['title', 'name']),
    body: readStringAt(record, ['body', 'content', 'text', 'summary', 'description']) ?? '',
    isPinned: readBoolean(record.isPinned ?? record.is_pinned) ?? false,
    isArchived: readBoolean(record.isArchived ?? record.is_archived ?? record.archived) ?? false,
  }
}

function normalizeTask(value: unknown): Task | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', 'taskId', 'task_id', '_id']) : null
  if (!record || !id) {
    return null
  }

  return {
    ...normalizeEntityBase(record, id),
    userId: readStringAt(record, ['userId', 'user_id', 'ownerId', 'owner_id']) ?? '',
    title: readStringAt(record, ['title', 'name']) ?? 'Untitled task',
    description: readStringAt(record, ['description', 'body', 'content', 'summary']),
    status: normalizeTaskStatus(readStringAt(record, ['status', 'state'])),
    dueAt: readStringAt(record, ['dueAt', 'due_at', 'deadline', 'scheduledAt', 'scheduled_at']),
    completedAt: readStringAt(record, ['completedAt', 'completed_at']),
  }
}

function normalizeReminder(value: unknown): Reminder | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', 'reminderId', 'reminder_id', '_id']) : null
  if (!record || !id) {
    return null
  }

  return {
    ...normalizeEntityBase(record, id),
    userId: readStringAt(record, ['userId', 'user_id', 'ownerId', 'owner_id']) ?? '',
    title: readStringAt(record, ['title', 'name']) ?? 'Reminder',
    body: readStringAt(record, ['body', 'content', 'description', 'summary']),
    scheduledAt: readStringAt(record, ['scheduledAt', 'scheduled_at', 'dueAt', 'due_at']) ?? new Date().toISOString(),
    recurrence: normalizeReminderRecurrence(readStringAt(record, ['recurrence', 'repeat'])),
    timezone: readStringAt(record, ['timezone']) ?? 'Europe/Moscow',
    lastTriggeredAt: readStringAt(record, ['lastTriggeredAt', 'last_triggered_at']),
  }
}

function normalizeInboxItem(value: unknown): InboxItem | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', 'itemId', 'item_id', '_id']) : null
  if (!record || !id) {
    return null
  }

  return {
    ...normalizeEntityBase(record, id),
    userId: readStringAt(record, ['userId', 'user_id', 'ownerId', 'owner_id']) ?? '',
    kind: readStringAt(record, ['kind', 'type']) === 'reminder' ? 'reminder' : 'signal',
    status: normalizeInboxStatus(readStringAt(record, ['status'])),
    title: readStringAt(record, ['title', 'name']) ?? 'Inbox item',
    body: readStringAt(record, ['body', 'content', 'description', 'summary']) ?? '',
    scheduledFor: readStringAt(record, ['scheduledFor', 'scheduled_for']),
    sourceType: readStringAt(record, ['sourceType', 'source_type']) ?? 'ecosystem',
    sourceId: readStringAt(record, ['sourceId', 'source_id']),
    signalCode: normalizeSignalCode(readStringAt(record, ['signalCode', 'signal_code', 'code'])),
    dedupeKey: readStringAt(record, ['dedupeKey', 'dedupe_key']),
    readAt: readStringAt(record, ['readAt', 'read_at']),
  }
}

function normalizeMemoryEntry(value: unknown): MemoryEntry | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', 'memoryId', 'memory_id', '_id']) : null
  if (!record || !id) {
    return null
  }

  const title = readStringAt(record, ['title', 'name', 'slug']) ?? 'Memory'
  const content = readStringAt(record, ['content', 'body', 'text', 'description', 'summary']) ?? ''
  return {
    ...normalizeEntityBase(record, id),
    userId: readStringAt(record, ['userId', 'user_id', 'ownerId', 'owner_id']) ?? '',
    category: normalizeMemoryCategory(readStringAt(record, ['category', 'type'])),
    slug: readStringAt(record, ['slug']) ?? title.toLowerCase().replace(/\s+/g, '-'),
    title,
    summary: readStringAt(record, ['summary', 'description']) ?? summarizePlainText(content),
    content,
    tags: readStringArray(record.tags),
    aliases: readStringArray(record.aliases),
    links: readStringArray(record.links),
    metadata: asRecord(record.metadata) ?? {},
    lastRememberedAt: readStringAt(record, ['lastRememberedAt', 'last_remembered_at']),
  }
}

function normalizeXVextaProject(value: unknown): AgentContext['xVextaProjects'][number] | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', 'projectId', 'project_id', '_id']) : null
  if (!record || !id) {
    return null
  }

  return {
    userId: readStringAt(record, ['userId', 'user_id', 'ownerId', 'owner_id']) ?? '',
    id,
    name: readStringAt(record, ['name', 'title']) ?? 'Project',
    code: readStringAt(record, ['code', 'slug']) ?? id,
    color: readStringAt(record, ['color']) ?? '#3b82f6',
    summary: readStringAt(record, ['summary', 'description']) ?? '',
    createdAt: readStringAt(record, ['createdAt', 'created_at']) ?? new Date().toISOString(),
    updatedAt: readStringAt(record, ['updatedAt', 'updated_at']) ?? new Date().toISOString(),
  }
}

function normalizeXVextaNote(value: unknown): AgentContext['xVextaNotes'][number] | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', 'noteId', 'note_id', 'documentId', 'document_id', '_id']) : null
  if (!record || !id) {
    return null
  }

  return {
    userId: readStringAt(record, ['userId', 'user_id', 'ownerId', 'owner_id']) ?? '',
    id,
    projectId: readStringAt(record, ['projectId', 'project_id']),
    title: readStringAt(record, ['title', 'name']) ?? 'Document',
    summary: readStringAt(record, ['summary', 'description', 'body', 'content']) ?? '',
    status: normalizeXVextaStatus(readStringAt(record, ['status', 'state'])),
    dueDate: readStringAt(record, ['dueDate', 'due_date', 'dueAt', 'due_at']) ?? '',
    tagIds: readStringArray(record.tagIds ?? record.tag_ids),
    linksTo: readStringArray(record.linksTo ?? record.links_to),
    links: Array.isArray(record.links) ? record.links : [],
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    blocks: Array.isArray(record.blocks) ? record.blocks : [],
    createdAt: readStringAt(record, ['createdAt', 'created_at']) ?? new Date().toISOString(),
    updatedAt: readStringAt(record, ['updatedAt', 'updated_at']) ?? new Date().toISOString(),
  }
}

function normalizeAgentSignal(value: unknown): AgentContext['derivedSignals'][number] | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  return {
    code: normalizeSignalCode(readStringAt(record, ['code', 'signalCode', 'signal_code'])) ?? 'task_due_today',
    title: readStringAt(record, ['title', 'name']) ?? 'Signal',
    body: readStringAt(record, ['body', 'content', 'description', 'summary']) ?? '',
    createdAt: readStringAt(record, ['createdAt', 'created_at']) ?? new Date().toISOString(),
    severity: readStringAt(record, ['severity']) === 'warning' ? 'warning' : 'info',
  }
}

function normalizeEntityBase(record: Record<string, unknown>, id: string) {
  const timestamp = new Date().toISOString()
  return {
    id,
    tenantId: readStringAt(record, ['tenantId', 'tenant_id', 'workspaceId', 'workspace_id']) ?? 'ecosystem',
    createdAt: readStringAt(record, ['createdAt', 'created_at']) ?? timestamp,
    updatedAt: readStringAt(record, ['updatedAt', 'updated_at', 'modifiedAt', 'modified_at']) ?? timestamp,
  }
}

function createFallbackProfile(): UserProfile {
  const timestamp = new Date().toISOString()
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
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function buildDerivedSignals(tasks: Task[], reminders: Reminder[]): AgentContext['derivedSignals'] {
  const now = new Date().toISOString()
  return [
    ...tasks
      .filter((task) => task.dueAt)
      .slice(0, 4)
      .map((task) => ({
        code: task.dueAt && task.dueAt.slice(0, 10) < now.slice(0, 10) ? 'task_overdue' as const : 'task_due_today' as const,
        title: task.title,
        body: task.description ?? '',
        createdAt: task.updatedAt,
        severity: task.dueAt && task.dueAt.slice(0, 10) < now.slice(0, 10) ? 'warning' as const : 'info' as const,
      })),
    ...reminders.slice(0, 2).map((reminder) => ({
      code: 'reminder_due_now' as const,
      title: reminder.title,
      body: reminder.body ?? '',
      createdAt: reminder.updatedAt,
      severity: 'info' as const,
    })),
  ]
}

function sortByUpdatedAt<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function normalizeAgentMessageEnvelope(raw: unknown, fallbackLatencyMs: number): AgentMessageEnvelope {
  const record = asRecord(raw) ?? {}
  const reply = readString(record.reply) || readString(record.replyText) || readString(record.message) || ''
  const actions = Array.isArray(record.actions) ? record.actions : []
  const confirmationRequired = Boolean(record.confirmationRequired ?? record.confirmation_required)
  const confirmationText =
    readString(record.confirmationText) ||
    readString(record.confirmation_text) ||
    (confirmationRequired ? 'Confirm this action to continue.' : null)

  return {
    reply,
    actions,
    confirmationRequired,
    confirmationText,
    pendingAction: normalizePendingAction(record.pendingAction ?? record.pending_action, confirmationText, actions),
    entitiesTouched: normalizeTouchedEntities(record.entitiesTouched ?? record.entities_touched),
    latencyMs: readNumber(record.latencyMs ?? record.latency_ms) ?? fallbackLatencyMs,
    toolTrace: record.toolTrace ?? record.tool_trace,
    debugMeta: asRecord(record.debugMeta ?? record.debug_meta) ?? undefined,
    raw,
  }
}

function normalizeAgentContextResponse(raw: unknown): AgentContext {
  const record = asRecord(raw) ?? {}
  const context = asRecord(record.context) ?? asRecord(record.data) ?? record
  return normalizeAgentContext(context)
}

function normalizePendingAction(value: unknown, confirmationText: string | null, actions: unknown[]): AgentPendingAction | null {
  const record = asRecord(value)
  if (!record && actions.length === 0) {
    return null
  }

  const source = record ?? asRecord(actions[0]) ?? {}
  const id = readString(source.id) || crypto.randomUUID()
  const label = readString(source.label) || readString(source.type) || 'Pending action'
  const description = readString(source.description) || confirmationText || label
  const irreversible = Boolean(source.irreversible) || /delete|remove|destroy/i.test(label)
  const action = normalizeEmbeddedAction(source.action ?? source.request)

  return {
    id,
    label,
    description,
    irreversible,
    action,
    raw: value ?? actions[0] ?? source,
  }
}

function normalizeEmbeddedAction(value: unknown): AgentActionRequest | undefined {
  const record = asRecord(value)
  if (!record?.action) {
    return undefined
  }
  return record as unknown as AgentActionRequest
}

function normalizeTouchedEntities(value: unknown): AgentTouchedEntity[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) {
        return null
      }

      const id = readString(record.id) || readString(record.entityId) || readString(record.entity_id)
      const kind = readString(record.kind) || readString(record.entityType) || readString(record.entity_type)
      if (!id || !kind) {
        return null
      }

      const touched: AgentTouchedEntity = {
        id,
        kind,
      }

      const title = readString(record.title)
      if (title) {
        touched.title = title
      }

      const action = readString(record.action)
      if (action) {
        touched.action = action
      }

      return touched
    })
    .filter((entry): entry is AgentTouchedEntity => entry !== null)
}

function buildEntitySummaries(context: AgentContext, memories: MemoryEntry[]): AgentUserDataEntitySummary[] {
  return [
    profileToSummary(context.profile),
    ...context.recentNotes.map(noteToSummary),
    ...context.todayTasks.map(taskToSummary),
    ...context.overdueTasks.map(taskToSummary),
    ...context.activeReminders.map(reminderToSummary),
    ...dedupeById([...memories, ...context.recentMemories]).map(memoryToSummary),
    ...context.unreadInbox.map(inboxItemToSummary),
    ...context.mailContacts.map(mailContactToSummary),
    ...context.xVextaProjects.map(xVextaProjectToSummary),
    ...context.xVextaNotes.map(xVextaNoteToSummary),
  ]
}

function filterEntitySummaries(
  summaries: AgentUserDataEntitySummary[],
  input: AgentUserDataSearchInput,
): AgentUserDataEntitySummary[] {
  const query = input.query?.trim().toLowerCase() ?? ''
  const allowedKinds = new Set((input.kinds ?? []).map(normalizeEntityKind))
  const limit = Math.max(1, Math.min(input.limit ?? 80, 200))

  return dedupeEntitySummaries(summaries)
    .filter((entry) => allowedKinds.size === 0 || allowedKinds.has(normalizeEntityKind(entry.kind)))
    .filter((entry) => {
      if (!query) {
        return true
      }
      return [entry.kind, entry.title, entry.summary, entry.detail].some((value) => value?.toLowerCase().includes(query))
    })
    .slice(0, limit)
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

function inboxItemToSummary(item: InboxItem): AgentUserDataEntitySummary {
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

function mailContactToSummary(contact: AgentMailContact): AgentUserDataEntitySummary {
  return {
    kind: 'crm_contact',
    id: contact.id,
    title: contact.name,
    summary: contact.email,
    detail: contact.notes,
    updatedAt: contact.updatedAt,
    raw: contact,
  }
}

function xVextaProjectToSummary(project: AgentContext['xVextaProjects'][number]): AgentUserDataEntitySummary {
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

function xVextaNoteToSummary(note: AgentContext['xVextaNotes'][number]): AgentUserDataEntitySummary {
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

function normalizeEntityKind(kind: string): string {
  return kind.trim().toLowerCase().replace(/[-\s]+/g, '_')
}

function dedupeEntitySummaries(summaries: AgentUserDataEntitySummary[]): AgentUserDataEntitySummary[] {
  const seen = new Set<string>()
  return summaries.filter((entry) => {
    const key = `${normalizeEntityKind(entry.kind)}:${entry.id}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false
    }
    seen.add(item.id)
    return true
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isJwtExpiringSoon(token: string): boolean {
  const parts = token.split('.')
  if (parts.length < 2) {
    return false
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown }
    const exp = readNumber(payload.exp)
    if (!exp) {
      return false
    }

    return exp * 1000 <= Date.now() + 5 * 60_000
  } catch {
    return false
  }
}

function readStringAt(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = readString(record[key])
    if (value) {
      return value
    }
  }

  return null
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false
    }
  }

  return null
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry) => readString(entry)).filter((entry): entry is string => entry !== null)
}

function normalizeTaskStatus(value: string | null): Task['status'] {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'in_progress' || normalized === 'in-progress' || normalized === 'active') {
    return 'in_progress'
  }
  if (normalized === 'done' || normalized === 'completed' || normalized === 'complete') {
    return 'done'
  }
  if (normalized === 'canceled' || normalized === 'cancelled') {
    return 'canceled'
  }
  return 'todo'
}

function normalizeReminderRecurrence(value: string | null): Reminder['recurrence'] {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'daily') {
    return 'daily'
  }
  if (normalized === 'weekly') {
    return 'weekly'
  }
  return 'none'
}

function normalizeInboxStatus(value: string | null): InboxItem['status'] {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'read') {
    return 'read'
  }
  if (normalized === 'dismissed') {
    return 'dismissed'
  }
  return 'unread'
}

function normalizeSignalCode(value: string | null): InboxItem['signalCode'] {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'task_overdue' || normalized === 'reminder_due_now' || normalized === 'bedtime_window_reached') {
    return normalized
  }
  if (normalized === 'task_due_today') {
    return 'task_due_today'
  }
  return null
}

function normalizeMemoryCategory(value: string | null): MemoryEntry['category'] {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === 'people' ||
    normalized === 'places' ||
    normalized === 'games' ||
    normalized === 'tech' ||
    normalized === 'events' ||
    normalized === 'media' ||
    normalized === 'ideas' ||
    normalized === 'orgs'
  ) {
    return normalized
  }

  return 'ideas'
}

function normalizeXVextaStatus(value: string | null): AgentContext['xVextaNotes'][number]['status'] {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'active' || normalized === 'in-review' || normalized === 'done') {
    return normalized
  }

  return 'draft'
}

function summarizePlainText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 179)}...` : normalized
}

function parseErrorText(raw: string, statusCode: number): string {
  try {
    const parsed = JSON.parse(raw) as { message?: string; error?: string }
    return parsed.message ?? parsed.error ?? `HTTP ${statusCode}`
  } catch {
    return raw.trim() || `HTTP ${statusCode}`
  }
}

function normalizeEcosystemUserDataSnapshotResponse(raw: unknown, source: EcosystemUserDataSnapshot['source']): EcosystemUserDataSnapshot {
  const record = asRecord(raw) ?? {}
  const payload = asRecord(record.snapshot) ?? asRecord(record.data) ?? asRecord(record.context) ?? record
  if (looksLikeAgentContext(payload)) {
    return buildSnapshotFromAgentContext(normalizeAgentContext(payload), source, readStringArray(record.errors))
  }

  const profile = normalizeUserProfile(payload.profile) ?? createFallbackProfile()
  const rawEntities = asRecord(payload.entities) ?? payload
  const entities: EcosystemUserDataEntities = {
    notes: extractCollection(rawEntities.notes, ['notes']).map(normalizeNote).filter((item): item is Note => item !== null),
    tasks: extractCollection(rawEntities.tasks, ['tasks']).map(normalizeTask).filter((item): item is Task => item !== null),
    reminders: extractCollection(rawEntities.reminders, ['reminders']).map(normalizeReminder).filter((item): item is Reminder => item !== null),
    inbox: extractCollection(rawEntities.inbox, ['inbox', 'items']).map(normalizeInboxItem).filter((item): item is InboxItem => item !== null),
    memory: extractCollection(rawEntities.memory ?? rawEntities.memories, ['memory', 'memories'])
      .map(normalizeMemoryEntry)
      .filter((item): item is MemoryEntry => item !== null),
    documents: extractCollection(rawEntities.documents, ['documents']).map((item) => normalizeGenericEntitySummary(item, 'document')).filter((item): item is AgentUserDataEntitySummary => item !== null),
    projects: extractCollection(rawEntities.projects, ['projects']).map((item) => normalizeGenericEntitySummary(item, 'project')).filter((item): item is AgentUserDataEntitySummary => item !== null),
    workouts: extractCollection(rawEntities.workouts, ['workouts']).map((item) => normalizeGenericEntitySummary(item, 'workout')).filter((item): item is AgentUserDataEntitySummary => item !== null),
    calendarEvents: extractCollection(rawEntities.calendarEvents ?? rawEntities.calendar_events, ['calendarEvents', 'calendar_events'])
      .map((item) => normalizeGenericEntitySummary(item, 'calendar_event'))
      .filter((item): item is AgentUserDataEntitySummary => item !== null),
    goals: extractCollection(rawEntities.goals, ['goals']).map((item) => normalizeGenericEntitySummary(item, 'goal')).filter((item): item is AgentUserDataEntitySummary => item !== null),
    habits: extractCollection(rawEntities.habits, ['habits']).map((item) => normalizeGenericEntitySummary(item, 'habit')).filter((item): item is AgentUserDataEntitySummary => item !== null),
    financeRecords: extractCollection(rawEntities.financeRecords ?? rawEntities.finance_records, ['financeRecords', 'finance_records'])
      .map((item) => normalizeGenericEntitySummary(item, 'finance_record'))
      .filter((item): item is AgentUserDataEntitySummary => item !== null),
    contentPlanItems: extractCollection(rawEntities.contentPlanItems ?? rawEntities.content_plan_items, ['contentPlanItems', 'content_plan_items'])
      .map((item) => normalizeGenericEntitySummary(item, 'content_plan_item'))
      .filter((item): item is AgentUserDataEntitySummary => item !== null),
    crmContacts: extractCollection(rawEntities.crmContacts ?? rawEntities.crm_contacts, ['crmContacts', 'crm_contacts'])
      .map((item) => normalizeGenericEntitySummary(item, 'crm_contact'))
      .filter((item): item is AgentUserDataEntitySummary => item !== null),
    crmDeals: extractCollection(rawEntities.crmDeals ?? rawEntities.crm_deals, ['crmDeals', 'crm_deals'])
      .map((item) => normalizeGenericEntitySummary(item, 'crm_deal'))
      .filter((item): item is AgentUserDataEntitySummary => item !== null),
    formEntries: extractCollection(rawEntities.formEntries ?? rawEntities.form_entries, ['formEntries', 'form_entries'])
      .map((item) => normalizeGenericEntitySummary(item, 'form_entry'))
      .filter((item): item is AgentUserDataEntitySummary => item !== null),
    knowledgeBaseItems: extractCollection(rawEntities.knowledgeBaseItems ?? rawEntities.knowledge_base_items, ['knowledgeBaseItems', 'knowledge_base_items'])
      .map((item) => normalizeGenericEntitySummary(item, 'knowledge_base_item'))
      .filter((item): item is AgentUserDataEntitySummary => item !== null),
    templates: extractCollection(rawEntities.templates, ['templates']).map((item) => normalizeGenericEntitySummary(item, 'template')).filter((item): item is AgentUserDataEntitySummary => item !== null),
    xVextaProjects: extractCollection(rawEntities.xVextaProjects ?? rawEntities.x_vexta_projects, ['xVextaProjects', 'x_vexta_projects'])
      .map(normalizeXVextaProject)
      .filter((item): item is AgentContext['xVextaProjects'][number] => item !== null),
    xVextaNotes: extractCollection(rawEntities.xVextaNotes ?? rawEntities.x_vexta_notes, ['xVextaNotes', 'x_vexta_notes'])
      .map(normalizeXVextaNote)
      .filter((item): item is AgentContext['xVextaNotes'][number] => item !== null),
  }

  const generatedAt = readString(payload.generatedAt) ?? readString(payload.generated_at) ?? new Date().toISOString()
  return {
    profile,
    entities,
    counts: countSnapshotEntities(entities),
    recommendations: extractCollection(payload.recommendations ?? payload.derivedSignals ?? payload.signals, ['recommendations', 'derivedSignals', 'signals'])
      .map(normalizeAgentSignal)
      .filter((item): item is AgentSignal => item !== null),
    generatedAt,
    source,
    syncRevision: readString(payload.syncRevision) ?? readString(payload.sync_revision) ?? `snapshot-${Date.parse(generatedAt) || Date.now()}`,
    errors: readStringArray(payload.errors),
  }
}

function normalizeSubscriptionPlan(value: unknown): SubscriptionPlan {
  const normalized = collectSubscriptionText(value).join(' ').trim().toLowerCase()
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

function collectSubscriptionText(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)]
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectSubscriptionText)
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectSubscriptionText)
  }
  return []
}

function buildSnapshotFromAgentContext(
  context: AgentContext,
  source: EcosystemUserDataSnapshot['source'],
  errors: string[],
): EcosystemUserDataSnapshot {
  const entities: EcosystemUserDataEntities = {
    notes: context.recentNotes,
    tasks: [...context.todayTasks, ...context.overdueTasks],
    reminders: context.activeReminders,
    inbox: context.unreadInbox,
    memory: context.recentMemories,
    documents: context.xVextaNotes.map(xVextaNoteToSummary),
    projects: context.xVextaProjects.map(xVextaProjectToSummary),
    workouts: [],
    calendarEvents: [],
    goals: [],
    habits: [],
    financeRecords: [],
    contentPlanItems: [],
    crmContacts: context.mailContacts.map(mailContactToSummary),
    crmDeals: [],
    formEntries: [],
    knowledgeBaseItems: [],
    templates: [],
    xVextaProjects: context.xVextaProjects,
    xVextaNotes: context.xVextaNotes,
  }
  return {
    profile: context.profile,
    entities,
    counts: countSnapshotEntities(entities),
    recommendations: context.derivedSignals,
    generatedAt: context.generatedAt,
    source,
    syncRevision: `context-${Date.parse(context.generatedAt) || Date.now()}`,
    errors,
  }
}

function countSnapshotEntities(entities: EcosystemUserDataEntities): EcosystemUserDataCounts {
  const today = new Date().toISOString().slice(0, 10)
  const counts: EcosystemUserDataCounts = {
    notes: entities.notes.length,
    tasks: entities.tasks.length,
    overdueTasks: entities.tasks.filter((task) => task.status !== 'done' && task.status !== 'canceled' && task.dueAt && task.dueAt.slice(0, 10) < today).length,
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

function normalizeEcosystemActionResult(raw: unknown, input: EcosystemUserDataActionRequest): EcosystemUserDataActionResult {
  const record = asRecord(raw) ?? {}
  const maybeResult = asRecord(record.result) ?? asRecord(record.actionResult) ?? record
  const actionResult = normalizeAgentActionResult(maybeResult)
  const confirmationRequired = Boolean(record.confirmationRequired ?? record.confirmation_required)
  if (confirmationRequired) {
    return {
      ok: false,
      confirmationRequired: true,
      confirmationText: readString(record.confirmationText) ?? readString(record.confirmation_text) ?? buildDeleteConfirmationText(input.action.type),
      pendingAction: normalizePendingAction(record.pendingAction ?? record.pending_action, null, []),
      result: null,
      entityId: null,
      message: readString(record.message) ?? 'Confirmation required',
      raw,
    }
  }

  return {
    ok: Boolean(record.ok ?? actionResult),
    confirmationRequired: false,
    confirmationText: null,
    pendingAction: null,
    result: actionResult,
    entityId: actionResult?.entityId ?? readString(record.entityId) ?? readString(record.entity_id),
    message: readString(record.message) ?? actionResult?.message ?? 'Action completed',
    raw,
  }
}

function normalizeAgentActionResult(value: unknown): AgentActionResult | null {
  const record = asRecord(value)
  const type = record ? readString(record.type) : null
  const entityId = record ? readString(record.entityId) ?? readString(record.entity_id) : null
  if (!record || !type || !entityId) {
    return null
  }

  return {
    type: type as AgentActionType,
    entityId,
    message: readString(record.message) ?? 'Action completed',
    payload: record.payload,
  }
}

function buildConfirmationRequiredResult(input: EcosystemUserDataActionRequest): EcosystemUserDataActionResult {
  const confirmationText = buildDeleteConfirmationText(input.action.type)
  return {
    ok: false,
    confirmationRequired: true,
    confirmationText,
    pendingAction: {
      id: input.confirmationId ?? crypto.randomUUID(),
      label: input.action.type,
      description: confirmationText,
      irreversible: true,
      action: {
        action: input.action,
      } as AgentActionRequest,
      raw: input,
    },
    result: null,
    entityId: null,
    message: confirmationText,
  }
}

function isIrreversibleAction(type: string): boolean {
  return /^(delete|remove|destroy)_/i.test(type) || /_(delete|remove|destroy)$/i.test(type)
}

function buildDeleteConfirmationText(type: string): string {
  return `Подтвердите необратимое действие: ${type}.`
}

function buildSnapshotAgentPrompt(): string {
  return [
    'Собери snapshot данных текущего пользователя для desktop-клиента Friday.',
    'Используй доступные backend tools, но не изменяй данные.',
    'Верни строго JSON без markdown и без пояснений.',
    'Схема: {"profile": object, "entities": {"notes": [], "tasks": [], "reminders": [], "inbox": [], "memory": [], "documents": [], "projects": [], "workouts": [], "calendarEvents": [], "goals": [], "habits": [], "financeRecords": [], "contentPlanItems": [], "crmContacts": [], "crmDeals": [], "formEntries": [], "knowledgeBaseItems": [], "templates": [], "xVextaProjects": [], "xVextaNotes": []}, "recommendations": [], "generatedAt": string, "syncRevision": string, "errors": []}.',
    'Если какая-то коллекция недоступна, верни для неё пустой массив и добавь краткую ошибку в errors.',
  ].join('\n')
}

function parseJsonObjectFromText(text: string): unknown | null {
  const trimmed = text.trim()
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim(),
    trimmed.match(/\{[\s\S]*\}/)?.[0] ?? '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next extracted candidate.
    }
  }

  return null
}

function normalizeGenericEntitySummary(value: unknown, fallbackKind: string): AgentUserDataEntitySummary | null {
  const record = asRecord(value)
  const id = record ? readStringAt(record, ['id', '_id', 'entityId', 'entity_id']) : null
  if (!record || !id) {
    return null
  }

  return {
    kind: readStringAt(record, ['kind', 'type', 'entityType', 'entity_type']) ?? fallbackKind,
    id,
    title: readStringAt(record, ['title', 'name', 'label']) ?? id,
    summary: readStringAt(record, ['summary', 'description', 'body', 'content']) ?? undefined,
    detail: readStringAt(record, ['detail', 'status', 'state']) ?? undefined,
    updatedAt: readStringAt(record, ['updatedAt', 'updated_at', 'modifiedAt', 'modified_at']) ?? new Date().toISOString(),
    raw: value,
  }
}

function looksLikeAgentContext(value: unknown): boolean {
  const record = asRecord(value)
  return Boolean(record?.profile && (record.todayTasks || record.overdueTasks || record.recentNotes || record.recentMemories))
}
