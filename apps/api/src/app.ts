import crypto from 'node:crypto'

import Fastify, { type FastifyRequest } from 'fastify'

import type {
    AgentActionRequest,
    AgentContext,
    AuthLoginInput,
    AuthRegisterInput,
    CreateAgentMailMessageInput,
    EcosystemUserDataActionRequest,
    EcosystemUserDataCounts,
    EcosystemUserDataEntities,
    EcosystemUserDataSnapshot,
    ListAgentMailContactsInput,
    CreateAppTokenInput,
    CreateMemoryInput,
    CreateNoteInput,
  CreateReminderInput,
  CreateTaskInput,
    ListAgentMailMessagesInput,
    LocalSessionInput,
    UpsertAgentMailContactInput,
    UpsertAgentMailAccountInput,
  UpdateMemoryInput,
  UpdateNoteInput,
  UpdateReminderInput,
  UpdateSettingsInput,
  UpdateTaskInput,
} from '@contracts'

import { Database } from './core/db'
import { PlatformRepository } from './core/repository'
import { isMusicApiError, MusicApiError } from './music/errors'
import { registerMusicRoutes } from './music/routes'

type AuthenticatedRequest = FastifyRequest & {
  auth: {
    tenantId: string
    userId: string
    actorType: 'user' | 'app'
  }
}

export async function createApiApp(database: Database) {
  const app = Fastify({ logger: false })
  const repository = new PlatformRepository(database)

  app.decorateRequest('auth', null)
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin ?? '*'
    reply.header('Access-Control-Allow-Origin', origin)
    reply.header('Vary', 'Origin')
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')

    if (request.method === 'OPTIONS') {
      return reply.code(204).send()
    }
  })
  app.addHook('preHandler', async (request) => {
    if (
      request.url === '/health' ||
      request.url === '/auth/register' ||
      request.url === '/auth/login' ||
      request.url === '/auth/ecosystem-login' ||
      request.url === '/auth/local'
    ) {
      return
    }

    const isPublicMusicRoute =
      request.url.startsWith('/api/v1/music/search') ||
      request.url.startsWith('/api/v1/music/browse') ||
      request.url.startsWith('/api/v1/music/collections/') ||
      request.url.startsWith('/api/v1/music/tracks/') ||
      request.url.startsWith('/api/v1/music/recommendations') ||
      request.url.startsWith('/api/v1/music/playback/resolve') ||
      request.url.startsWith('/api/v1/music/voice/execute') ||
      request.url.startsWith('/api/v1/music/health') ||
      request.url.startsWith('/api/music/search') ||
      request.url.startsWith('/api/music/browse') ||
      request.url.startsWith('/api/music/collections/') ||
      request.url.startsWith('/api/music/playback/resolve')

    const token = readBearerToken(request.headers.authorization)
    if (!token) {
      if (isPublicMusicRoute) {
        return
      }
      if (request.url.startsWith('/api/v1/music/')) {
        throw new MusicApiError(401, 'UNAUTHORIZED_SESSION', 'Missing bearer token')
      }
      throw httpError(401, 'Missing bearer token')
    }

    const auth = await repository.authenticate(token)
    if (!auth) {
      if (isPublicMusicRoute) {
        return
      }
      if (request.url.startsWith('/api/v1/music/')) {
        throw new MusicApiError(401, 'UNAUTHORIZED_SESSION', 'Invalid bearer token')
      }
      throw httpError(401, 'Invalid bearer token')
    }

    ;(request as AuthenticatedRequest).auth = auth
  })

  app.get('/health', async () => ({ ok: true }))

  app.post('/auth/register', async (request, reply) => {
    const body = request.body as AuthRegisterInput
    validateRegister(body)
    const session = await repository.register(body)
    return reply.code(201).send(session)
  })

  app.post('/auth/login', async (request) => {
    const body = request.body as AuthLoginInput
    validateLogin(body)
    return repository.login(body.email, body.password)
  })

  app.post('/auth/ecosystem-login', async (request) => {
    const body = request.body as AuthRegisterInput
    validateRegister(body)
    return repository.loginWithTrustedIdentity(body)
  })

  app.post('/auth/local', async (request) => {
    const body = request.body as LocalSessionInput
    validateLocalSession(body)
    return repository.ensureLocalSession(body)
  })

  app.post('/auth/token', async (request, reply) => {
    const body = request.body as CreateAppTokenInput
    requireText(body.name, 'name')
    return reply.code(201).send(await repository.createAppToken(getAuth(request), body))
  })

  app.get('/me', async (request) => repository.getProfile(getAuth(request)))
  app.patch('/me/settings', async (request) => {
    const body = request.body as UpdateSettingsInput
    validateSettings(body)
    return repository.updateSettings(getAuth(request), body)
  })

  app.get('/mail/account', async (request) => repository.getAgentMailAccount(getAuth(request)))
  app.put('/mail/account', async (request) => {
    const body = request.body as UpsertAgentMailAccountInput
    validateUpsertAgentMailAccount(body)
    return repository.upsertAgentMailAccount(getAuth(request), body)
  })
  app.get('/mail/messages', async (request) => {
    const query = request.query as ListAgentMailMessagesInput
    validateAgentMailFolder(query.folder)
    return repository.listAgentMailMessages(getAuth(request), query)
  })
  app.get('/mail/messages/:id', async (request) => {
    return repository.getAgentMailMessage(getAuth(request), getParamId(request))
  })
  app.post('/mail/messages', async (request, reply) => {
    const body = request.body as CreateAgentMailMessageInput
    validateCreateAgentMailMessage(body)
    return reply.code(201).send(await repository.createAgentMailMessage(getAuth(request), body))
  })
  app.post('/mail/messages/:id/read', async (request) => {
    return repository.markAgentMailMessageRead(getAuth(request), getParamId(request))
  })
  app.get('/mail/contacts', async (request) => {
    const query = request.query as ListAgentMailContactsInput
    return repository.listAgentMailContacts(getAuth(request), query)
  })
  app.put('/mail/contacts', async (request) => {
    const body = request.body as UpsertAgentMailContactInput
    validateUpsertAgentMailContact(body)
    return repository.upsertAgentMailContact(getAuth(request), body)
  })
  app.delete('/mail/contacts/:id', async (request) => {
    await repository.deleteAgentMailContact(getAuth(request), getParamId(request))
    return { ok: true }
  })

  app.get('/notes', async (request) => repository.listNotes(getAuth(request)))
  app.post('/notes', async (request, reply) => {
    const body = request.body as CreateNoteInput
    validateCreateNote(body)
    return reply.code(201).send(await repository.createNote(getAuth(request), body))
  })
  app.patch('/notes/:id', async (request) => {
    const body = request.body as UpdateNoteInput
    validateUpdateNote(body)
    return repository.updateNote(getAuth(request), getParamId(request), body)
  })
  app.delete('/notes/:id', async (request) => {
    await repository.deleteNote(getAuth(request), getParamId(request))
    return { ok: true }
  })

  app.get('/tasks', async (request) => repository.listTasks(getAuth(request)))
  app.post('/tasks', async (request, reply) => {
    const body = request.body as CreateTaskInput
    validateCreateTask(body)
    return reply.code(201).send(await repository.createTask(getAuth(request), body))
  })
  app.patch('/tasks/:id', async (request) => {
    const body = request.body as UpdateTaskInput
    validateUpdateTask(body)
    return repository.updateTask(getAuth(request), getParamId(request), body)
  })
  app.delete('/tasks/:id', async (request) => {
    await repository.deleteTask(getAuth(request), getParamId(request))
    return { ok: true }
  })

  app.get('/reminders', async (request) => repository.listReminders(getAuth(request)))
  app.post('/reminders', async (request, reply) => {
    const body = request.body as CreateReminderInput
    validateCreateReminder(body)
    return reply.code(201).send(await repository.createReminder(getAuth(request), body))
  })
  app.patch('/reminders/:id', async (request) => {
    const body = request.body as UpdateReminderInput
    validateUpdateReminder(body)
    return repository.updateReminder(getAuth(request), getParamId(request), body)
  })
  app.delete('/reminders/:id', async (request) => {
    await repository.deleteReminder(getAuth(request), getParamId(request))
    return { ok: true }
  })

  app.get('/inbox', async (request) => repository.listInbox(getAuth(request)))
  app.post('/inbox/:id/read', async (request) => repository.markInboxRead(getAuth(request), getParamId(request)))
  app.get('/memory', async (request) => {
    const query = request.query as { query?: string; category?: string; limit?: string }
    const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined
    return repository.listMemories(getAuth(request), {
      query: query.query,
      category: query.category,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
  })
  app.get('/memory/:id', async (request) => repository.getMemory(getAuth(request), getParamId(request)))
  app.post('/memory', async (request, reply) => {
    const body = request.body as CreateMemoryInput
    validateCreateMemory(body)
    return reply.code(201).send(await repository.createMemory(getAuth(request), body))
  })
  app.patch('/memory/:id', async (request) => {
    const body = request.body as UpdateMemoryInput
    validateUpdateMemory(body)
    return repository.updateMemory(getAuth(request), getParamId(request), body)
  })
  app.delete('/memory/:id', async (request) => {
    await repository.deleteMemory(getAuth(request), getParamId(request))
    return { ok: true }
  })
  app.get('/agent/context', async (request) => repository.getAgentContext(getAuth(request)))
  app.post('/agent/actions', async (request) => {
    const body = request.body as AgentActionRequest
    validateAgentAction(body)
    return repository.runAgentAction(getAuth(request), body)
  })
  app.get('/friday/user-data/snapshot', async (request) => {
    return buildFridayUserDataSnapshot(await repository.getAgentContext(getAuth(request)))
  })
  app.post('/friday/user-data/actions', async (request) => {
    const body = request.body as EcosystemUserDataActionRequest
    const actionRequest: AgentActionRequest = { action: body.action }
    validateAgentAction(actionRequest)
    if (isIrreversibleAction(body.action.type) && !body.confirmed) {
      const confirmationText = `Подтвердите необратимое действие: ${body.action.type}.`
      return {
        ok: false,
        confirmationRequired: true,
        confirmationText,
        pendingAction: {
          id: body.confirmationId ?? crypto.randomUUID(),
          label: body.action.type,
          description: confirmationText,
          irreversible: true,
          action: actionRequest,
          raw: body,
        },
        result: null,
        entityId: null,
        message: confirmationText,
      }
    }

    const result = await repository.runAgentAction(getAuth(request), actionRequest)
    return {
      ok: true,
      confirmationRequired: false,
      confirmationText: null,
      pendingAction: null,
      result,
      entityId: result.entityId,
      message: result.message,
      snapshot: buildFridayUserDataSnapshot(await repository.getAgentContext(getAuth(request))),
    }
  })
  registerMusicRoutes(app, database)

  app.setErrorHandler((error, _request, reply) => {
    if (isMusicApiError(error)) {
      reply.code(error.statusCode).send(error.toResponse())
      return
    }

    const knownError = error as Error & { statusCode?: number }
    const statusCode = typeof knownError.statusCode === 'number' ? knownError.statusCode : 400
    reply.code(statusCode).send({
      error: knownError.message,
    })
  })

  return app
}

function getAuth(request: FastifyRequest): AuthenticatedRequest['auth'] {
  const auth = (request as AuthenticatedRequest).auth
  if (!auth) {
    throw httpError(401, 'Unauthorized')
  }
  return auth
}

function getParamId(request: FastifyRequest): string {
  const params = request.params as { id?: string }
  if (!params.id) {
    throw httpError(400, 'Missing id')
  }
  return params.id
}

function readBearerToken(value: string | undefined): string | null {
  if (!value?.startsWith('Bearer ')) {
    return null
  }
  return value.slice('Bearer '.length).trim() || null
}

function requireText(value: string | undefined, field: string): void {
  if (!value || !value.trim()) {
    throw httpError(400, `${field} is required`)
  }
}

function validateRegister(input: AuthRegisterInput): void {
  requireText(input.email, 'email')
  requireText(input.password, 'password')
  requireText(input.displayName, 'displayName')
  requireText(input.timezone, 'timezone')
}

function validateLogin(input: AuthLoginInput): void {
  requireText(input.email, 'email')
  requireText(input.password, 'password')
}

function validateLocalSession(input: LocalSessionInput): void {
  requireText(input.timezone, 'timezone')
  if (input.locale !== 'ru' && input.locale !== 'en') {
    throw httpError(400, 'Invalid locale')
  }
}

function validateSettings(input: UpdateSettingsInput): void {
  if (input.timezone !== undefined) requireText(input.timezone, 'timezone')
}

function validateAgentMailFolder(value: string | undefined): void {
  if (value === undefined) {
    return
  }

  if (value !== 'inbox' && value !== 'sent' && value !== 'drafts') {
    throw httpError(400, 'Invalid folder')
  }
}

function validateUpsertAgentMailAccount(input: UpsertAgentMailAccountInput): void {
  if (input.displayName !== undefined) requireText(input.displayName, 'displayName')
  if (input.status !== undefined && input.status !== 'disconnected' && input.status !== 'ready' && input.status !== 'error') {
    throw httpError(400, 'Invalid status')
  }
}

function validateCreateAgentMailMessage(input: CreateAgentMailMessageInput): void {
  requireText(input.accountId, 'accountId')
  validateAgentMailFolder(input.folder)
  requireText(input.subject, 'subject')
  requireText(input.bodyText, 'bodyText')
}

function validateUpsertAgentMailContact(input: UpsertAgentMailContactInput): void {
  requireText(input.accountId, 'accountId')
  requireText(input.name, 'name')
  requireText(input.email, 'email')
}

function validateCreateNote(input: CreateNoteInput): void {
  requireText(input.body, 'body')
}

function validateUpdateNote(input: UpdateNoteInput): void {
  if (input.body !== undefined) requireText(input.body, 'body')
}

function validateCreateTask(input: CreateTaskInput): void {
  requireText(input.title, 'title')
}

function validateUpdateTask(input: UpdateTaskInput): void {
  if (input.title !== undefined) requireText(input.title, 'title')
}

function validateRecurrence(value: string): void {
  if (value !== 'none' && value !== 'daily' && value !== 'weekly') {
    throw httpError(400, 'Invalid recurrence')
  }
}

function validateCreateReminder(input: CreateReminderInput): void {
  requireText(input.title, 'title')
  requireText(input.scheduledAt, 'scheduledAt')
  validateRecurrence(input.recurrence)
}

function validateUpdateReminder(input: UpdateReminderInput): void {
  if (input.title !== undefined) requireText(input.title, 'title')
  if (input.scheduledAt !== undefined) requireText(input.scheduledAt, 'scheduledAt')
  if (input.recurrence !== undefined) validateRecurrence(input.recurrence)
}

function validateMemoryCategory(value: string | undefined, field = 'category'): void {
  if (!value) {
    throw httpError(400, `${field} is required`)
  }

  const allowed = new Set(['people', 'places', 'games', 'tech', 'events', 'media', 'ideas', 'orgs'])
  if (!allowed.has(value)) {
    throw httpError(400, `Invalid ${field}`)
  }
}

function validateCreateMemory(input: CreateMemoryInput): void {
  validateMemoryCategory(input.category)
  requireText(input.title, 'title')
}

function validateUpdateMemory(input: UpdateMemoryInput): void {
  if (input.category !== undefined) validateMemoryCategory(input.category)
  if (input.title !== undefined) requireText(input.title, 'title')
}

function validateAgentAction(input: AgentActionRequest): void {
  if (!input?.action?.type) {
    throw httpError(400, 'action.type is required')
  }

  switch (input.action.type) {
    case 'create_note':
      validateCreateNote(input.action.payload)
      return
    case 'update_note':
      requireText(input.action.payload.noteId, 'noteId')
      validateUpdateNote(input.action.payload.changes)
      return
    case 'delete_note':
      requireText(input.action.payload.noteId, 'noteId')
      return
    case 'create_task':
      validateCreateTask(input.action.payload)
      return
    case 'update_task':
      requireText(input.action.payload.taskId, 'taskId')
      validateUpdateTask(input.action.payload.changes)
      return
    case 'delete_task':
      requireText(input.action.payload.taskId, 'taskId')
      return
    case 'create_reminder':
      validateCreateReminder(input.action.payload)
      return
    case 'update_reminder':
      requireText(input.action.payload.reminderId, 'reminderId')
      validateUpdateReminder(input.action.payload.changes)
      return
    case 'delete_reminder':
      requireText(input.action.payload.reminderId, 'reminderId')
      return
    case 'dismiss_inbox_item':
      requireText(input.action.payload.inboxItemId, 'inboxItemId')
      return
    case 'create_memory':
      validateCreateMemory(input.action.payload)
      return
    case 'update_memory':
      requireText(input.action.payload.memoryId, 'memoryId')
      validateUpdateMemory(input.action.payload.changes)
      return
    case 'delete_memory':
      requireText(input.action.payload.memoryId, 'memoryId')
      return
    case 'get_x_vexta_note':
      requireText(input.action.payload.noteId, 'noteId')
      return
    case 'create_x_vexta_project':
      requireText(input.action.payload.name, 'name')
      return
    case 'update_x_vexta_project':
      requireText(input.action.payload.projectId, 'projectId')
      if (input.action.payload.changes.name !== undefined) requireText(input.action.payload.changes.name, 'name')
      return
    case 'create_x_vexta_note':
      requireText(input.action.payload.title, 'title')
      return
    case 'update_x_vexta_note':
      requireText(input.action.payload.noteId, 'noteId')
      if (input.action.payload.changes.title !== undefined) requireText(input.action.payload.changes.title, 'title')
      return
    case 'append_x_vexta_blocks':
      requireText(input.action.payload.noteId, 'noteId')
      if (!Array.isArray(input.action.payload.blocks) || input.action.payload.blocks.length === 0) {
        throw httpError(400, 'blocks are required')
      }
      return
    default:
      throw httpError(400, 'Unsupported action')
  }
}

function buildFridayUserDataSnapshot(context: AgentContext): EcosystemUserDataSnapshot {
  const entities: EcosystemUserDataEntities = {
    notes: context.recentNotes,
    tasks: [...context.todayTasks, ...context.overdueTasks],
    reminders: context.activeReminders,
    inbox: context.unreadInbox,
    memory: context.recentMemories,
    documents: context.xVextaNotes.map((note) => ({
      kind: 'document',
      id: note.id,
      title: note.title,
      summary: note.summary,
      detail: note.status,
      updatedAt: note.updatedAt,
      raw: note,
    })),
    projects: context.xVextaProjects.map((project) => ({
      kind: 'project',
      id: project.id,
      title: project.name,
      summary: project.summary,
      detail: project.code,
      updatedAt: project.updatedAt,
      raw: project,
    })),
    workouts: [],
    calendarEvents: [],
    goals: [],
    habits: [],
    financeRecords: [],
    contentPlanItems: [],
    crmContacts: context.mailContacts.map((contact) => ({
      kind: 'crm_contact',
      id: contact.id,
      title: contact.name,
      summary: contact.email,
      detail: contact.notes,
      updatedAt: contact.updatedAt,
      raw: contact,
    })),
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
    counts: countFridayUserDataEntities(entities),
    recommendations: context.derivedSignals,
    generatedAt: context.generatedAt,
    source: 'ecosystem',
    syncRevision: `context-${Date.parse(context.generatedAt) || Date.now()}`,
    errors: [],
  }
}

function countFridayUserDataEntities(entities: EcosystemUserDataEntities): EcosystemUserDataCounts {
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

function isIrreversibleAction(type: string): boolean {
  return /^(delete|remove|destroy)_/i.test(type) || /_(delete|remove|destroy)$/i.test(type)
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = statusCode
  return error
}
