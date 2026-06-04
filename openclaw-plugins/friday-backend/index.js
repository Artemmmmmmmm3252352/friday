import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3010'
const DEFAULT_ECOSYSTEM_BASE_URL = (process.env.FRIDAY_ECOSYSTEM_API_BASE_URL || 'https://xvexta.ru/api').replace(/\/+$/, '')
const DEFAULT_APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const DEFAULT_STATE_DIR = path.join(DEFAULT_APPDATA, 'friday', 'state')
const DEFAULT_SESSION_PATH = path.join(DEFAULT_STATE_DIR, 'backend-session.json')
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_STATE_DIR, 'backend-config.json')
const DEFAULT_SNAPSHOT_PATH = path.join(DEFAULT_STATE_DIR, 'ecosystem-user-data-snapshot.json')

const GUIDANCE = [
  'You have native Friday backend tools for the user workspace.',
  'Use them when the user wants to read, create, or edit real data in Friday or X Vexta Notes.',
  'You also have native Friday mail tools backed by AgentMail.',
  'When the user asks to send an email, check the Friday mail account first and then use friday_mail_send instead of refusing or suggesting unrelated local mail tools.',
  'If the user names a recipient like "boss", "Andrey", or another saved contact instead of giving an exact address, use Friday mail contact tools to resolve the email first.',
  'When the user asks to read the agent mailbox, use friday_mail_list or friday_mail_read.',
  'If a listed email preview looks incomplete, call friday_mail_read before saying the message body is empty or unavailable.',
  'You also have a persistent 2nd-brain memory knowledge base for people, places, games, tech, events, media, ideas, and organizations.',
  'Use friday_memory_search, friday_memory_get, friday_memory_remember, and friday_memory_list when the user asks you to remember something, asks what you know already, or asks about durable facts from earlier chats.',
  'In a new chat, treat Friday memory as real cross-chat context, not as optional trivia.',
  'Before answering self-referential questions like "как меня зовут", "что я люблю", "что ты помнишь обо мне", "где я работаю", or "какая у меня команда", check memory first.',
  'Do not claim that you do not know something durable about the user until friday_memory_search or friday_memory_list returned no relevant result.',
  'Think normally first. Tools are for real side effects, not for planning.',
  'If the user asks for research, latest information, summaries, stories, or polished writing, gather and synthesize the final content first, then save it.',
  'For regular Friday notes, use friday_note_read, friday_note_create, and friday_note_update. Use body/content/summary for the final note text.',
  'For beautiful notes, write rich markdown-like content in body/content/summary: use # headings, bullet lists, numbered lists, todo syntax, blockquotes, fenced code blocks, and markdown tables.',
  'Before replacing an existing note body, prefer friday_note_read unless the user clearly asked to overwrite everything. When the user says "добавь" or "добавив", use friday_note_update with mode=append.',
  'If several synced notes have the same title, ask a short clarification question or use the exact noteId from context.',
  'For tasks with duplicate titles, ask which task unless the user explicitly says "все", "all", or "каждую". Then call friday_task_update with taskTitle and allMatching=true.',
  'Never say that data was changed unless a Friday tool actually succeeded.',
].join('\n')

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const projectTargetSchema = {
  projectId: { type: 'string', description: 'Exact project id if already known.' },
  projectCode: { type: 'string', description: 'Project code like legs or work.' },
  projectName: { type: 'string', description: 'Project name if you know it.' },
}

const noteTargetSchema = {
  noteId: { type: 'string', description: 'Exact note id if already known.' },
  noteTitle: { type: 'string', description: 'Note title if the id is unknown.' },
  ...projectTargetSchema,
}

const memoryCategories = ['people', 'places', 'games', 'tech', 'events', 'media', 'ideas', 'orgs']
const memoryCategorySchema = {
  type: 'string',
  enum: memoryCategories,
}

const memoryLookupSchema = {
  memoryId: { type: 'string', description: 'Exact memory id if known.' },
  category: { ...memoryCategorySchema, description: 'Optional memory category.' },
  title: { type: 'string', description: 'Exact memory title if known.' },
  slug: { type: 'string', description: 'Memory slug if known.' },
}

const plugin = {
  id: 'friday-backend',
  name: 'Friday Backend',
  description: 'Friday workspace tools for notes, projects, tasks, reminders, and inbox actions.',
  register(api) {
    const runtimeConfig = resolveRuntimeConfig(api.pluginConfig)

    api.registerTool(createWorkspaceContextTool(runtimeConfig))
    api.registerTool(createNoteReadTool(runtimeConfig))
    api.registerTool(createNoteCreateTool(runtimeConfig))
    api.registerTool(createNoteUpdateTool(runtimeConfig))
    api.registerTool(createProjectCreateTool(runtimeConfig))
    api.registerTool(createProjectUpdateTool(runtimeConfig))
    api.registerTool(createTaskCreateTool(runtimeConfig))
    api.registerTool(createTaskUpdateTool(runtimeConfig))
    api.registerTool(createReminderCreateTool(runtimeConfig))
    api.registerTool(createInboxDismissTool(runtimeConfig))
    api.registerTool(createMemorySearchTool(runtimeConfig))
    api.registerTool(createMemoryGetTool(runtimeConfig))
    api.registerTool(createMemoryRememberTool(runtimeConfig))
    api.registerTool(createMemoryListTool(runtimeConfig))
    api.on('before_prompt_build', async () => ({
      prependSystemContext: await buildPromptContext(runtimeConfig),
    }))
  },
}

export default plugin

function createWorkspaceContextTool(runtimeConfig) {
  return {
    name: 'friday_workspace_context',
    label: 'Friday Workspace Context',
    description:
      'Read the current Friday workspace context: profile, tasks, reminders, note previews, projects, X Vexta note previews, unread inbox items, and derived signals. Use this before asking about or editing user data when you need targets or IDs.',
    parameters: emptyObjectSchema,
    execute: async () => {
      const context = await getAgentContext(runtimeConfig)
      return jsonToolResult(compactContext(context))
    },
  }
}

function createMailAccountTool(runtimeConfig) {
  return {
    name: 'friday_mail_account_get',
    label: 'Friday Mail Account',
    description:
      'Read the configured Friday agent mailbox, including address, inbox id, and connection status.',
    parameters: emptyObjectSchema,
    execute: async () => {
      const account = await authedRequest(runtimeConfig, '/mail/account')
      return jsonToolResult({
        ok: true,
        account,
      })
    },
  }
}

function createMailListTool(runtimeConfig) {
  return {
    name: 'friday_mail_list',
    label: 'Friday Mail List',
    description:
      'List messages from the Friday agent mailbox. Use folder=inbox to read incoming mail, sent to inspect sent mail, or drafts for drafts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        folder: {
          type: 'string',
          enum: ['inbox', 'sent', 'drafts'],
        },
        limit: {
          type: 'number',
          description: 'Optional result limit. Defaults to 20.',
        },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const folder = readOptionalString(params.folder)
      const limit = readOptionalNumber(params.limit) || 20
      const suffix = folder ? `?folder=${encodeURIComponent(folder)}` : ''
      const messages = await authedRequest(runtimeConfig, `/mail/messages${suffix}`)
      const result = Array.isArray(messages) ? messages.slice(0, limit) : []

      return jsonToolResult({
        ok: true,
        count: result.length,
        messages: result,
      })
    },
  }
}

function createMailReadTool(runtimeConfig) {
  return {
    name: 'friday_mail_read',
    label: 'Friday Mail Read',
    description:
      'Read one exact message from the Friday agent mailbox by message id. This also marks inbox messages as read.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: { type: 'string', description: 'Exact Friday mail message id.' },
      },
      required: ['messageId'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const messageId = readRequiredString(params.messageId, 'messageId')
      const messages = await authedRequest(runtimeConfig, '/mail/messages')
      const message = Array.isArray(messages) ? messages.find((entry) => entry?.id === messageId) : null

      if (!message) {
        throw new Error('Could not find that Friday mail message.')
      }

      let finalMessage = await authedRequest(runtimeConfig, `/mail/messages/${messageId}`)
      if (message.folder === 'inbox' && !message.isRead) {
        finalMessage = await authedRequest(runtimeConfig, `/mail/messages/${message.id}/read`, {
          method: 'POST',
        })
      }

      return jsonToolResult({
        ok: true,
        message: finalMessage,
      })
    },
  }
}

function createMailSendTool(runtimeConfig) {
  return {
    name: 'friday_mail_send',
    label: 'Friday Mail Send',
    description:
      'Send a real email from the configured Friday agent mailbox. Use this when the user asks you to send an email.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recipient email addresses.',
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
        },
        subject: {
          type: 'string',
          description: 'Final subject line.',
        },
        body: {
          type: 'string',
          description: 'Final plain-text body.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const account = await authedRequest(runtimeConfig, '/mail/account')
      if (!account?.id) {
        throw new Error('Friday agent mailbox is not configured yet.')
      }

      const payload = await authedRequest(runtimeConfig, '/mail/messages', {
        method: 'POST',
        body: JSON.stringify({
          accountId: account.id,
          folder: 'sent',
          toAddresses: readRequiredStringArray(params.to, 'to'),
          ccAddresses: readOptionalStringArray(params.cc) || [],
          subject: readRequiredString(params.subject, 'subject'),
          bodyText: readRequiredString(params.body, 'body'),
        }),
      })

      return jsonToolResult({
        ok: true,
        message: 'Email sent from the Friday agent mailbox.',
        payload,
      })
    },
  }
}

function createMailMarkReadTool(runtimeConfig) {
  return {
    name: 'friday_mail_mark_read',
    label: 'Friday Mail Mark Read',
    description:
      'Mark a Friday inbox message as read by exact message id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: { type: 'string' },
      },
      required: ['messageId'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const result = await authedRequest(runtimeConfig, `/mail/messages/${readRequiredString(params.messageId, 'messageId')}/read`, {
        method: 'POST',
      })

      return jsonToolResult({
        ok: true,
        message: result,
      })
    },
  }
}

function createMailContactsListTool(runtimeConfig) {
  return {
    name: 'friday_mail_contacts_list',
    label: 'Friday Mail Contacts',
    description:
      'List saved Friday mail contacts. Use this when the user refers to a person or alias instead of saying the exact email address.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Optional search text for contact name, alias, or email.',
        },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const query = readOptionalString(params.query)
      const suffix = query ? `?query=${encodeURIComponent(query)}` : ''
      const contacts = await authedRequest(runtimeConfig, `/mail/contacts${suffix}`)
      return jsonToolResult({
        ok: true,
        count: Array.isArray(contacts) ? contacts.length : 0,
        contacts: Array.isArray(contacts) ? contacts : [],
      })
    },
  }
}

function createMailContactLookupTool(runtimeConfig) {
  return {
    name: 'friday_mail_contact_lookup',
    label: 'Friday Mail Contact Lookup',
    description:
      'Resolve one saved Friday mail contact by name, alias, or email before sending an email.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Name, alias, or email to look up.',
        },
      },
      required: ['query'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const query = readRequiredString(params.query, 'query')
      const contacts = await authedRequest(runtimeConfig, `/mail/contacts?query=${encodeURIComponent(query)}`)
      const entries = Array.isArray(contacts) ? contacts : []
      const normalizedQuery = normalizeLookup(query)
      const exact =
        entries.find((entry) => normalizeLookup(entry.name) === normalizedQuery) ||
        entries.find((entry) => normalizeLookup(entry.email) === normalizedQuery) ||
        entries.find((entry) => (readOptionalStringArray(entry.aliases) || []).some((alias) => normalizeLookup(alias) === normalizedQuery)) ||
        entries[0] ||
        null

      return jsonToolResult({
        ok: Boolean(exact),
        contact: exact,
        matches: entries.slice(0, 10),
      })
    },
  }
}

function createNoteReadTool(runtimeConfig) {
  return {
    name: 'friday_note_read',
    label: 'Friday Note Read',
    description:
      'Read a synced Friday note from the local user-data snapshot. Falls back to X Vexta note reads when the target is an X Vexta document.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...noteTargetSchema,
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const syncedNote = await resolveSyncedNoteTarget(runtimeConfig, params)
      if (syncedNote) {
        return jsonToolResult({
          ok: true,
          source: 'synced_snapshot',
          note: syncedNote,
        })
      }

      const note = await resolveNoteTarget(runtimeConfig, params)
      const result = await runAgentAction(runtimeConfig, {
        action: {
          type: 'get_x_vexta_note',
          payload: {
            noteId: note.id,
          },
        },
      })
      return jsonToolResult({
        ok: true,
        note: result.payload,
      })
    },
  }
}

async function resolveSyncedNoteTarget(runtimeConfig, params) {
  const snapshot = await readUserDataSnapshot(runtimeConfig)
  const entities = snapshot?.entities || {}
  const notes = Array.isArray(entities.notes) ? entities.notes : []
  const pool = notes
    .map((entry) => ({
      id: readOptionalString(entry?.id) || '',
      title: readOptionalString(entry?.title) || 'Untitled note',
      body: readOptionalString(entry?.body) || readOptionalString(entry?.content) || readOptionalString(entry?.summary) || '',
      source: 'friday_note',
      raw: entry,
    }))
    .filter((entry) => entry.id || entry.title)

  const directId = readOptionalString(params.noteId)
  if (directId) {
    const byId = pool.find((entry) => entry.id === directId)
    if (byId) {
      return byId
    }
  }

  const desiredTitle = normalizeLookup(readOptionalString(params.noteTitle) || readOptionalString(params.title) || '')
  if (!desiredTitle) {
    return null
  }

  const exactMatches = pool.filter((entry) => normalizeLookup(entry.title) === desiredTitle)
  if (exactMatches.length === 1) {
    return exactMatches[0]
  }
  if (exactMatches.length > 1) {
    throw new Error(`Found ${exactMatches.length} synced Friday notes named "${readOptionalString(params.noteTitle) || readOptionalString(params.title)}". Ask the user which one to use, or pass noteId.`)
  }

  const containsMatches = pool.filter((entry) => normalizeLookup(entry.title).includes(desiredTitle))
  if (containsMatches.length === 1) {
    return containsMatches[0]
  }
  if (containsMatches.length > 1) {
    throw new Error(`Found ${containsMatches.length} synced Friday notes matching "${readOptionalString(params.noteTitle) || readOptionalString(params.title)}". Ask the user which one to use, or pass noteId.`)
  }

  return null
}

function readNoteBodyParams(params) {
  return (
    readOptionalString(params.body) ||
    readOptionalString(params.content) ||
    readOptionalString(params.summary) ||
    readOptionalString(params.text)
  )
}

function createNoteCreateTool(runtimeConfig) {
  return {
    name: 'friday_note_create',
    label: 'Friday Note Create',
    description:
      'Create a new Friday note in the ecosystem backend. If a project target is provided, create an X Vexta note inside that project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...projectTargetSchema,
        title: {
          type: 'string',
          description: 'Final note title.',
        },
        summary: {
          type: 'string',
          description:
            'Final note body. You can use markdown-like formatting such as headings, bullet lists, numbered lists, quotes, fenced code, and markdown tables.',
        },
        body: {
          type: 'string',
          description: 'Final note body for regular Friday notes.',
        },
        content: {
          type: 'string',
          description: 'Final note body alias.',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in-review', 'done'],
        },
        dueDate: {
          type: 'string',
          description: 'Optional due date in ISO format or yyyy-mm-dd format accepted by the backend.',
        },
      },
      required: ['title'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const title = readRequiredString(params.title, 'title')
      const body = readNoteBodyParams(params)
      const hasProjectTarget = Boolean(readOptionalString(params.projectId) || readOptionalString(params.projectCode) || readOptionalString(params.projectName))
      const project = hasProjectTarget ? await resolveProjectTarget(runtimeConfig, params, { optional: true }) : null
      if (!project) {
        if (!body) {
          throw new Error('Creating a regular Friday note requires body, content, or summary.')
        }
        const result = await runAgentAction(runtimeConfig, {
          action: {
            type: 'create_note',
            payload: {
              title,
              body,
            },
          },
        })
        return jsonToolResult({
          ok: true,
          source: 'ecosystem_user_data_action',
          message: result.message,
          payload: result.payload,
        })
      }

      const result = await runAgentAction(runtimeConfig, {
        action: {
          type: 'create_x_vexta_note',
            payload: {
              projectId: project?.id ?? null,
              title,
              summary: body,
              status: readOptionalString(params.status),
              dueDate: readOptionalString(params.dueDate),
            },
        },
      })
      return jsonToolResult({
        ok: true,
        message: result.message,
        payload: result.payload,
      })
    },
  }
}

function createNoteUpdateTool(runtimeConfig) {
  return {
    name: 'friday_note_update',
    label: 'Friday Note Update',
    description:
      'Update an existing Friday note. Use mode=append to add content and mode=replace to overwrite the body. Falls back to X Vexta document updates only when no regular Friday note matches.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...noteTargetSchema,
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'replace overwrites the note body, append adds content to the existing body.',
        },
        title: {
          type: 'string',
          description: 'Optional new note title.',
        },
        summary: {
          type: 'string',
          description:
            'New note body using markdown-like formatting. For append mode, pass only the new content to add.',
        },
        body: {
          type: 'string',
          description: 'New regular Friday note body. For append mode, pass only the new content to add.',
        },
        content: {
          type: 'string',
          description: 'New note body alias.',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in-review', 'done'],
        },
        dueDate: {
          type: 'string',
        },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const mode = readOptionalString(params.mode) || 'replace'
      const summary = readNoteBodyParams(params)
      const syncedNote = await resolveSyncedNoteTarget(runtimeConfig, params)
      if (syncedNote) {
        const changes = {}
        const newTitle = (readOptionalString(params.noteId) || readOptionalString(params.noteTitle))
          ? readOptionalString(params.title)
          : undefined
        if (newTitle) {
          changes.title = newTitle
        }
        if (summary) {
          changes.body = mode === 'append'
            ? [syncedNote.body, summary].filter(Boolean).join('\n')
            : summary
        }
        if (Object.keys(changes).length === 0) {
          throw new Error('Update mode requires a new title, body, content, or summary.')
        }

        const result = await runAgentAction(runtimeConfig, {
          action: {
            type: 'update_note',
            payload: {
              noteId: syncedNote.id,
              changes,
            },
          },
        })
        return jsonToolResult({
          ok: true,
          source: 'ecosystem_user_data_action',
          message: result.message,
          payload: result.payload,
        })
      }

      const note = await resolveNoteTarget(runtimeConfig, params)
      let result
      if (mode === 'append') {
        const blocks = buildTextBlocks(summary)
        if (!blocks) {
          throw new Error('Append mode requires summary content.')
        }
        result = await runAgentAction(runtimeConfig, {
          action: {
            type: 'append_x_vexta_blocks',
            payload: {
              noteId: note.id,
              blocks,
            },
          },
        })
      } else {
        result = await runAgentAction(runtimeConfig, {
          action: {
            type: 'update_x_vexta_note',
            payload: {
              noteId: note.id,
              changes: {
                title: readOptionalString(params.title),
                summary,
                status: readOptionalString(params.status),
                dueDate: readOptionalString(params.dueDate),
              },
            },
          },
        })
      }
      return jsonToolResult({
        ok: true,
        message: result.message,
        payload: result.payload,
      })
    },
  }
}

function createProjectCreateTool(runtimeConfig) {
  return {
    name: 'friday_project_create',
    label: 'Friday Project Create',
    description: 'Create a new X Vexta project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        code: { type: 'string' },
        color: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['name'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const result = await runAgentAction(runtimeConfig, {
        action: {
          type: 'create_x_vexta_project',
          payload: {
            name: readRequiredString(params.name, 'name'),
            code: readOptionalString(params.code),
            color: readOptionalString(params.color),
            summary: readOptionalString(params.summary),
          },
        },
      })
      return jsonToolResult({
        ok: true,
        message: result.message,
        payload: result.payload,
      })
    },
  }
}

function createProjectUpdateTool(runtimeConfig) {
  return {
    name: 'friday_project_update',
    label: 'Friday Project Update',
    description: 'Rename or update an existing X Vexta project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...projectTargetSchema,
        name: { type: 'string' },
        code: { type: 'string' },
        color: { type: 'string' },
        summary: { type: 'string' },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const project = await resolveProjectTarget(runtimeConfig, params)
      const result = await runAgentAction(runtimeConfig, {
        action: {
          type: 'update_x_vexta_project',
          payload: {
            projectId: project.id,
            changes: {
              name: readOptionalString(params.name),
              code: readOptionalString(params.code),
              color: readOptionalString(params.color),
              summary: readOptionalString(params.summary),
            },
          },
        },
      })
      return jsonToolResult({
        ok: true,
        message: result.message,
        payload: result.payload,
      })
    },
  }
}

function createTaskCreateTool(runtimeConfig) {
  return {
    name: 'friday_task_create',
    label: 'Friday Task Create',
    description: 'Create a Friday task.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        dueAt: { type: 'string' },
      },
      required: ['title'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const result = await runAgentAction(runtimeConfig, {
        action: {
          type: 'create_task',
          payload: {
            title: readRequiredString(params.title, 'title'),
            description: readOptionalString(params.description),
            dueAt: readOptionalString(params.dueAt),
          },
        },
      })
      return jsonToolResult({
        ok: true,
        message: result.message,
        payload: result.payload,
      })
    },
  }
}

function createTaskUpdateTool(runtimeConfig) {
  return {
    name: 'friday_task_update',
    label: 'Friday Task Update',
    description:
      'Update one or more Friday tasks by id or exact title from the current workspace context. Use allMatching=true when the user confirms that every task with that title should be updated.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string' },
        taskTitle: { type: 'string' },
        allMatching: {
          type: 'boolean',
          description: 'Update every active task matching taskTitle. Use only when the user explicitly says all/every matching task.',
        },
        title: { type: 'string' },
        description: { type: 'string' },
        dueAt: { type: 'string' },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done', 'canceled'],
        },
        completedAt: { type: 'string' },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const tasks = await resolveTaskTargets(runtimeConfig, params)
      const results = []
      for (const task of tasks) {
        const result = await runAgentAction(runtimeConfig, {
          action: {
            type: 'update_task',
            payload: {
              taskId: task.id,
              changes: {
                title: readOptionalString(params.title),
                description: readOptionalString(params.description),
                dueAt: readOptionalString(params.dueAt),
                status: readOptionalString(params.status),
                completedAt: readOptionalString(params.completedAt),
              },
            },
          },
        })
        results.push(result)
      }

      return jsonToolResult({
        ok: true,
        message: tasks.length === 1 ? results[0]?.message : `Updated ${tasks.length} matching tasks.`,
        count: tasks.length,
        payload: tasks.length === 1 ? results[0]?.payload : results.map((result) => result.payload ?? result),
      })
    },
  }
}

function createReminderCreateTool(runtimeConfig) {
  return {
    name: 'friday_reminder_create',
    label: 'Friday Reminder Create',
    description: 'Create a Friday reminder.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        scheduledAt: { type: 'string' },
        recurrence: {
          type: 'string',
          enum: ['none', 'daily', 'weekly'],
        },
        timezone: { type: 'string' },
      },
      required: ['title', 'scheduledAt', 'recurrence'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const result = await runAgentAction(runtimeConfig, {
        action: {
          type: 'create_reminder',
          payload: {
            title: readRequiredString(params.title, 'title'),
            body: readOptionalString(params.body),
            scheduledAt: readRequiredString(params.scheduledAt, 'scheduledAt'),
            recurrence: readRequiredString(params.recurrence, 'recurrence'),
            timezone: readOptionalString(params.timezone),
          },
        },
      })
      return jsonToolResult({
        ok: true,
        message: result.message,
        payload: result.payload,
      })
    },
  }
}

function createInboxDismissTool(runtimeConfig) {
  return {
    name: 'friday_inbox_dismiss',
    label: 'Friday Inbox Dismiss',
    description: 'Dismiss or hide an unread Friday inbox item by id or title.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inboxItemId: { type: 'string' },
        inboxTitle: { type: 'string' },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const inboxItem = await resolveInboxTarget(runtimeConfig, params)
      const result = await runAgentAction(runtimeConfig, {
        action: {
          type: 'dismiss_inbox_item',
          payload: {
            inboxItemId: inboxItem.id,
          },
        },
      })
      return jsonToolResult({
        ok: true,
        message: result.message,
        payload: result.payload,
      })
    },
  }
}

function createMemorySearchTool(runtimeConfig) {
  return {
    name: 'friday_memory_search',
    label: 'Friday Memory Search',
    description:
      'Search the persistent 2nd-brain knowledge base for people, places, games, tech, events, media, ideas, and organizations.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Name, phrase, or natural-language lookup.' },
        category: { ...memoryCategorySchema, description: 'Optional category filter.' },
        limit: { type: 'number', description: 'Optional result limit. Defaults to 8.' },
      },
      required: ['query'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const memories = await listMemories(runtimeConfig, {
        query: readRequiredString(params.query, 'query'),
        category: readOptionalString(params.category),
        limit: readOptionalNumber(params.limit) || 8,
      })

      return jsonToolResult({
        ok: true,
        count: memories.length,
        memories,
      })
    },
  }
}

function createMemoryGetTool(runtimeConfig) {
  return {
    name: 'friday_memory_get',
    label: 'Friday Memory Get',
    description: 'Read one exact memory entry from the persistent 2nd-brain knowledge base.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: memoryLookupSchema,
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const memory = await resolveMemoryTarget(runtimeConfig, params)
      return jsonToolResult({
        ok: true,
        memory,
      })
    },
  }
}

function createMemoryRememberTool(runtimeConfig) {
  return {
    name: 'friday_memory_remember',
    label: 'Friday Memory Remember',
    description:
      'Create or update a persistent 2nd-brain memory entry. Use this when the user says to remember someone, a place, an idea, or another named entity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...memoryLookupSchema,
        summary: { type: 'string', description: 'Short summary for quick recall.' },
        content: { type: 'string', description: 'Full body with structured notes and context.' },
        tags: { type: 'array', items: { type: 'string' } },
        aliases: { type: 'array', items: { type: 'string' } },
        links: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object', additionalProperties: true },
      },
      required: ['category', 'title'],
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const explicitId = readOptionalString(params.memoryId)
      const existing = explicitId ? await getMemory(runtimeConfig, explicitId) : await findMemoryByIdentity(runtimeConfig, params)
      const payload = {
        category: readRequiredString(params.category, 'category'),
        title: readRequiredString(params.title, 'title'),
        slug: readOptionalString(params.slug),
        summary: readOptionalString(params.summary),
        content: readOptionalString(params.content),
        tags: readOptionalStringArray(params.tags),
        aliases: readOptionalStringArray(params.aliases),
        links: readOptionalStringArray(params.links),
        metadata: readOptionalObject(params.metadata),
        lastRememberedAt: new Date().toISOString(),
      }

      const result = await runAgentAction(runtimeConfig, existing
        ? {
            action: {
              type: 'update_memory',
              payload: {
                memoryId: existing.id,
                changes: payload,
              },
            },
          }
        : {
            action: {
              type: 'create_memory',
              payload,
            },
          })
      const memory = result?.payload || result

      return jsonToolResult({
        ok: true,
        mode: existing ? 'updated' : 'created',
        memory,
      })
    },
  }
}

function createMemoryListTool(runtimeConfig) {
  return {
    name: 'friday_memory_list',
    label: 'Friday Memory List',
    description: 'List recent 2nd-brain memory entries, optionally filtered by category.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { ...memoryCategorySchema, description: 'Optional category filter.' },
        limit: { type: 'number', description: 'Optional result limit. Defaults to 20.' },
      },
    },
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams)
      const memories = await listMemories(runtimeConfig, {
        category: readOptionalString(params.category),
        limit: readOptionalNumber(params.limit) || 20,
      })

      return jsonToolResult({
        ok: true,
        count: memories.length,
        memories,
      })
    },
  }
}

function resolveRuntimeConfig(pluginConfig) {
  const config = asRecord(pluginConfig)
  return {
    baseUrl: normalizeBaseUrl(readOptionalString(config.baseUrl)),
    ecosystemBaseUrl: normalizeBaseUrl(readOptionalString(config.ecosystemBaseUrl) || DEFAULT_ECOSYSTEM_BASE_URL),
    sessionPath: readOptionalString(config.sessionPath) || DEFAULT_SESSION_PATH,
    configPath: readOptionalString(config.configPath) || DEFAULT_CONFIG_PATH,
    snapshotPath: readOptionalString(config.snapshotPath) || DEFAULT_SNAPSHOT_PATH,
  }
}

async function readUserDataSnapshot(runtimeConfig) {
  try {
    const raw = await readFile(runtimeConfig.snapshotPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.entities ? parsed : null
  } catch {
    return null
  }
}

function snapshotToContext(snapshot) {
  const entities = snapshot.entities || {}
  const tasks = Array.isArray(entities.tasks) ? entities.tasks : []
  const today = new Date().toISOString().slice(0, 10)
  const activeTasks = tasks.filter((task) => task?.status !== 'done' && task?.status !== 'canceled')
  const overdueTasks = activeTasks.filter((task) => task?.dueAt && String(task.dueAt).slice(0, 10) < today)
  const todayTasks = activeTasks.filter((task) => !overdueTasks.some((overdue) => overdue.id === task.id))

  return {
    profile: snapshot.profile || emptyProfile(),
    todayTasks,
    overdueTasks,
    activeReminders: Array.isArray(entities.reminders) ? entities.reminders : [],
    recentNotes: Array.isArray(entities.notes) ? entities.notes : [],
    recentMemories: Array.isArray(entities.memory) ? entities.memory : [],
    mailContacts: [],
    xVextaProjects: Array.isArray(entities.xVextaProjects) ? entities.xVextaProjects : [],
    xVextaNotes: Array.isArray(entities.xVextaNotes) ? entities.xVextaNotes : [],
    unreadInbox: Array.isArray(entities.inbox) ? entities.inbox.filter((item) => item?.status !== 'read') : [],
    derivedSignals: Array.isArray(snapshot.recommendations) ? snapshot.recommendations : [],
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
  }
}

function emptySnapshotContext() {
  return snapshotToContext({
    profile: emptyProfile(),
    entities: {},
    recommendations: [],
    generatedAt: new Date().toISOString(),
  })
}

function emptyProfile() {
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

async function getAgentContext(runtimeConfig) {
  const snapshot = await readUserDataSnapshot(runtimeConfig)
  if (!snapshot) {
    return emptySnapshotContext()
  }

  return snapshotToContext(snapshot)
}

async function buildPromptContext(runtimeConfig) {
  const parts = [GUIDANCE]

  try {
    const context = await getAgentContext(runtimeConfig)
    const digest = buildWorkspaceContextDigest(context)
    if (digest) {
      parts.push(digest)
    }
  } catch {
    // The local desktop agent must keep working even if user-data context is temporarily unavailable.
  }

  try {
    const memories = await listMemories(runtimeConfig, { limit: 12 })
    const digest = buildMemoryDigest(memories)
    if (digest) {
      parts.push(digest)
    }
  } catch {
    // Keep prompt construction resilient even if memory is temporarily unavailable.
  }

  return parts.join('\n\n')
}

function buildWorkspaceContextDigest(context) {
  if (!context || typeof context !== 'object') {
    return ''
  }

  const notes = Array.isArray(context.recentNotes) ? context.recentNotes : []
  const todayTasks = Array.isArray(context.todayTasks) ? context.todayTasks : []
  const overdueTasks = Array.isArray(context.overdueTasks) ? context.overdueTasks : []
  const reminders = Array.isArray(context.activeReminders) ? context.activeReminders : []
  const projects = Array.isArray(context.xVextaProjects) ? context.xVextaProjects : []
  const documents = Array.isArray(context.xVextaNotes) ? context.xVextaNotes : []
  const inbox = Array.isArray(context.unreadInbox) ? context.unreadInbox : []
  const profile = asRecord(context.profile)
  const settings = asRecord(profile.settings)

  const lines = [
    'Friday authenticated user-data context snapshot.',
    'Use this only as context for the current user. For fresh reads or edits, call the Friday tools. Do not write private context into local files unless the user explicitly asks.',
    `User: ${readOptionalString(profile.displayName) || readOptionalString(profile.email) || 'signed-in user'}${readOptionalString(profile.email) ? ` <${readOptionalString(profile.email)}>` : ''}`,
    `Timezone: ${readOptionalString(settings.timezone) || 'unknown'}`,
    `Counts: notes=${notes.length}, tasks=${todayTasks.length + overdueTasks.length}, reminders=${reminders.length}, projects=${projects.length}, documents=${documents.length}, inbox=${inbox.length}`,
  ]

  appendPreviewLines(lines, 'Recent notes', notes, (note) => {
    const title = readOptionalString(note?.title) || 'Untitled note'
    const body = readOptionalString(note?.body) || readOptionalString(note?.summary) || ''
    return `${title}: ${trimForPrompt(body)}`
  })
  appendPreviewLines(lines, 'Tasks', [...overdueTasks, ...todayTasks], (task) => {
    const title = readOptionalString(task?.title) || 'Untitled task'
    const status = readOptionalString(task?.status) || 'unknown'
    const due = readOptionalString(task?.dueAt) || readOptionalString(task?.due_at)
    return `${title} (${status}${due ? `, due ${due}` : ''})`
  })
  appendPreviewLines(lines, 'Documents', documents, (note) => {
    const title = readOptionalString(note?.title) || 'Untitled document'
    const summary = readOptionalString(note?.summary) || readOptionalString(note?.status) || ''
    return `${title}: ${trimForPrompt(summary)}`
  })

  return lines.join('\n')
}

function appendPreviewLines(lines, label, values, formatter) {
  const items = values.slice(0, 6).map(formatter).filter(Boolean)
  if (items.length === 0) {
    return
  }

  lines.push(`${label}:`)
  for (const item of items) {
    lines.push(`- ${item}`)
  }
}

function trimForPrompt(value, limit = 180) {
  const normalized = readOptionalString(value)
  if (!normalized) {
    return ''
  }

  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function buildMemoryDigest(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return ''
  }

  const merged = mergeMemoriesForPrompt(memories)
  if (merged.length === 0) {
    return ''
  }

  const lines = [
    'Friday persistent memory snapshot. These facts may come from earlier chats and still matter in this new conversation.',
  ]

  for (const memory of merged.slice(0, 8)) {
    const details = []
    if (memory.summary) {
      details.push(memory.summary)
    }
    if (memory.aliases.length > 0) {
      details.push(`aliases: ${memory.aliases.join(', ')}`)
    }
    if (memory.links.length > 0) {
      details.push(`links: ${memory.links.join(', ')}`)
    }

    lines.push(`- [${memory.category}] ${memory.title}: ${details.join(' | ') || 'stored memory'}`)
  }

  return lines.join('\n')
}

function mergeMemoriesForPrompt(memories) {
  const merged = new Map()

  for (const memory of memories) {
    if (!memory || typeof memory !== 'object') {
      continue
    }

    const category = readOptionalString(memory.category) || 'unknown'
    const title = readOptionalString(memory.title) || readOptionalString(memory.slug) || readOptionalString(memory.id)
    if (!title) {
      continue
    }

    const key = `${category}:${normalizeLookup(title)}`
    const current = merged.get(key)
    const summary = readOptionalString(memory.summary)
    const aliases = readOptionalStringArray(memory.aliases) || []
    const links = readOptionalStringArray(memory.links) || []

    if (!current) {
      merged.set(key, {
        category,
        title,
        summary: summary || '',
        aliases: [...aliases],
        links: [...links],
      })
      continue
    }

    current.summary = mergeSnippet(current.summary, summary)
    current.aliases = mergeUniqueStrings(current.aliases, aliases)
    current.links = mergeUniqueStrings(current.links, links)
  }

  return Array.from(merged.values())
}

function mergeSnippet(left, right) {
  const values = []

  for (const value of [left, right]) {
    const normalized = readOptionalString(value)
    if (!normalized) {
      continue
    }
    if (!values.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
      values.push(normalized)
    }
  }

  return values.join(' | ')
}

function mergeUniqueStrings(left, right) {
  const values = []

  for (const value of [...left, ...right]) {
    const normalized = readOptionalString(value)
    if (!normalized) {
      continue
    }
    if (!values.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
      values.push(normalized)
    }
  }

  return values
}

function isIrreversibleAction(type) {
  return /^(delete|remove|destroy)_/i.test(String(type || '')) || /_(delete|remove|destroy)$/i.test(String(type || ''))
}

async function runAgentAction(runtimeConfig, payload) {
  const result = await authedRequest(runtimeConfig, '/friday/user-data/actions', {
    method: 'POST',
    body: JSON.stringify({
      action: payload.action,
      confirmed: !isIrreversibleAction(payload.action?.type),
    }),
  })
  if (result?.confirmationRequired || result?.confirmation_required) {
    throw new Error(result.confirmationText || result.confirmation_text || 'This action requires confirmation in Friday.')
  }

  if (result?.snapshot && typeof result.snapshot === 'object') {
    await writeUserDataSnapshot(runtimeConfig, result.snapshot).catch(() => undefined)
  }

  return result?.result || result
}

async function writeUserDataSnapshot(runtimeConfig, snapshot) {
  await mkdir(path.dirname(runtimeConfig.snapshotPath), { recursive: true })
  await writeFile(runtimeConfig.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

async function listMemories(runtimeConfig, options = {}) {
  const query = readOptionalString(options.query)
  const category = readOptionalString(options.category)
  const limit = readOptionalNumber(options.limit)
  const snapshot = await readUserDataSnapshot(runtimeConfig)
  const memories = Array.isArray(snapshot?.entities?.memory) ? snapshot.entities.memory : []
  const normalizedQuery = normalizeLookup(query || '')
  const normalizedCategory = normalizeLookup(category || '')
  return memories
    .filter((memory) => !normalizedCategory || normalizeLookup(memory.category) === normalizedCategory)
    .filter((memory) => {
      if (!normalizedQuery) {
        return true
      }
      return [memory.title, memory.summary, memory.content, ...(memory.aliases || []), ...(memory.tags || [])]
        .map((value) => normalizeLookup(value))
        .some((value) => value.includes(normalizedQuery))
    })
    .slice(0, limit || 50)
}

async function getMemory(runtimeConfig, memoryId) {
  const snapshot = await readUserDataSnapshot(runtimeConfig)
  const memory = (snapshot?.entities?.memory || []).find((entry) => entry?.id === memoryId)
  if (!memory) {
    throw new Error('Could not find that memory entry in the synced Friday snapshot.')
  }

  return memory
}

async function authedRequest(runtimeConfig, pathname, init = {}) {
  const token = await readSessionToken(runtimeConfig)
  const baseUrl = await resolveBaseUrl(runtimeConfig)

  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers || {}),
        },
      })

      if (!response.ok) {
        const message = await safeErrorMessage(response)
        if (response.status >= 500 && attempt < 2) {
          lastError = new Error(message)
          await delay(250 * (attempt + 1))
          continue
        }

        throw new Error(message)
      }

      return response.json()
    } catch (error) {
      lastError = error
      if (attempt >= 2) {
        break
      }

      await delay(250 * (attempt + 1))
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Friday backend request failed')
}

async function resolveBaseUrl(runtimeConfig) {
  if (await hasEcosystemSessionToken(runtimeConfig)) {
    return runtimeConfig.ecosystemBaseUrl
  }

  try {
    const raw = await readFile(runtimeConfig.configPath, 'utf8')
    const parsed = JSON.parse(raw)
    return normalizeBaseUrl(readOptionalString(parsed.baseUrl))
  } catch {
    return runtimeConfig.baseUrl
  }
}

async function readSessionToken(runtimeConfig) {
  const session = await readSessionState(runtimeConfig)
  const token = readOptionalString(session.appToken) || readOptionalString(session.session?.token)
  if (!token) {
    throw new Error('Friday backend session is missing. Ask the user to log in to the Friday account first.')
  }
  if (readOptionalString(session.appToken) && isJwtExpiringSoon(token)) {
    const refreshed = await refreshEcosystemAccessToken(runtimeConfig, session)
    if (refreshed) {
      return refreshed
    }
  }
  return token
}

async function hasEcosystemSessionToken(runtimeConfig) {
  try {
    const session = await readSessionState(runtimeConfig)
    return Boolean(readOptionalString(session.appToken))
  } catch {
    return false
  }
}

async function readSessionState(runtimeConfig) {
  let raw
  try {
    raw = await readFile(runtimeConfig.sessionPath, 'utf8')
  } catch {
    throw new Error('Friday backend session is missing. Ask the user to log in to the Friday account first.')
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Friday backend session file is invalid. Ask the user to log in again.')
  }

  return parsed
}

async function refreshEcosystemAccessToken(runtimeConfig, session) {
  const refreshToken = readOptionalString(session.appRefreshToken)
  if (!refreshToken) {
    return null
  }

  const attempts = [
    { refreshToken },
    { token: refreshToken },
    { refresh_token: refreshToken },
  ]

  for (const body of attempts) {
    try {
      const response = await fetch(`${runtimeConfig.ecosystemBaseUrl}/auth/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        continue
      }

      const payload = await response.json()
      const accessToken = readOptionalString(payload?.accessToken)
      if (!accessToken) {
        continue
      }

      const nextSession = {
        ...session,
        appToken: accessToken,
        appRefreshToken: readOptionalString(payload?.refreshToken) || refreshToken,
        updatedAt: new Date().toISOString(),
      }
      await mkdir(path.dirname(runtimeConfig.sessionPath), { recursive: true })
      await writeFile(runtimeConfig.sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`, 'utf8')
      return accessToken
    } catch {
      // Try the next common refresh payload shape.
    }
  }

  return null
}

async function resolveProjectTarget(runtimeConfig, params, options = { optional: false }) {
  const context = await getAgentContext(runtimeConfig)
  const directId = readOptionalString(params.projectId)
  if (directId) {
    const byId = context.xVextaProjects.find((entry) => entry.id === directId)
    if (byId) {
      return byId
    }
  }

  const desiredCode = normalizeLookup(readOptionalString(params.projectCode) || '')
  const desiredName = normalizeLookup(readOptionalString(params.projectName) || '')
  const match =
    context.xVextaProjects.find((entry) => desiredCode && normalizeLookup(entry.code) === desiredCode) ||
    context.xVextaProjects.find((entry) => desiredName && normalizeLookup(entry.name) === desiredName)

  if (match) {
    return match
  }

  if (options.optional) {
    return null
  }

  throw new Error('Could not resolve the target project from the current Friday workspace context.')
}

async function resolveNoteTarget(runtimeConfig, params) {
  const context = await getAgentContext(runtimeConfig)
  const directId = readOptionalString(params.noteId)
  if (directId) {
    const byId = context.xVextaNotes.find((entry) => entry.id === directId)
    if (byId) {
      return byId
    }
  }

  const project = await resolveProjectTarget(runtimeConfig, params, { optional: true })
  const desiredTitle = normalizeLookup(readOptionalString(params.noteTitle) || '')
  const candidates = context.xVextaNotes.filter((entry) => !project || entry.projectId === project.id)
  const match = candidates.find((entry) => desiredTitle && normalizeLookup(entry.title) === desiredTitle)
  if (match) {
    return match
  }

  throw new Error('Could not resolve the target note from the current Friday workspace context.')
}

async function resolveTaskTargets(runtimeConfig, params) {
  const context = await getAgentContext(runtimeConfig)
  const directId = readOptionalString(params.taskId)
  const taskPool = [...context.todayTasks, ...context.overdueTasks]
  if (directId) {
    const byId = taskPool.find((entry) => entry.id === directId)
    if (byId) {
      return [byId]
    }
  }

  const desiredTitle = normalizeLookup(readOptionalString(params.taskTitle) || '')
  const exactMatches = taskPool.filter((entry) => desiredTitle && normalizeLookup(entry.title) === desiredTitle)
  if (exactMatches.length === 1) {
    return exactMatches
  }
  if (exactMatches.length > 1) {
    if (readOptionalBoolean(params.allMatching)) {
      return exactMatches
    }

    throw new Error(
      `Found ${exactMatches.length} active Friday tasks named "${readOptionalString(params.taskTitle)}". Ask which one to update, or call friday_task_update with allMatching=true if the user explicitly said all.`,
    )
  }

  throw new Error('Could not resolve the target task from the current Friday workspace context.')
}

async function resolveInboxTarget(runtimeConfig, params) {
  const context = await getAgentContext(runtimeConfig)
  const directId = readOptionalString(params.inboxItemId)
  if (directId) {
    const byId = context.unreadInbox.find((entry) => entry.id === directId)
    if (byId) {
      return byId
    }
  }

  const desiredTitle = normalizeLookup(readOptionalString(params.inboxTitle) || '')
  const match = context.unreadInbox.find((entry) => desiredTitle && normalizeLookup(entry.title) === desiredTitle)
  if (match) {
    return match
  }

  throw new Error('Could not resolve the target inbox item from the current Friday workspace context.')
}

async function resolveMemoryTarget(runtimeConfig, params) {
  const directId = readOptionalString(params.memoryId)
  if (directId) {
    return getMemory(runtimeConfig, directId)
  }

  const match = await findMemoryByIdentity(runtimeConfig, params)
  if (match) {
    return match
  }

  throw new Error('Could not resolve the target memory entry from the current Friday memory knowledge base.')
}

async function findMemoryByIdentity(runtimeConfig, params) {
  const title = readOptionalString(params.title)
  const slug = readOptionalString(params.slug)
  const category = readOptionalString(params.category)
  const query = title || slug

  if (!query) {
    return null
  }

  const normalizedTitle = normalizeLookup(title || '')
  const normalizedSlug = normalizeLookup((slug || '').replace(/-/g, ' '))
  const queriedMemories = await listMemories(runtimeConfig, {
    query,
    category,
    limit: 25,
  })
  const directMatch = findNormalizedMemoryMatch(queriedMemories, { title, slug, normalizedTitle, normalizedSlug })
  if (directMatch) {
    return directMatch
  }

  const fallbackMemories = await listMemories(runtimeConfig, {
    category,
    limit: 50,
  })
  return findNormalizedMemoryMatch(fallbackMemories, { title, slug, normalizedTitle, normalizedSlug })
}

function findNormalizedMemoryMatch(memories, identity) {
  return (
    memories.find(
      (entry) =>
        identity.slug &&
        normalizeLookup(String(entry.slug || '').replace(/-/g, ' ')) === identity.normalizedSlug,
    ) ||
    memories.find((entry) => identity.title && normalizeLookup(entry.title) === identity.normalizedTitle) ||
    memories.find((entry) =>
      (readOptionalStringArray(entry.aliases) || []).some(
        (alias) => identity.title && normalizeLookup(alias) === identity.normalizedTitle,
      ),
    ) ||
    null
  )
}

function compactContext(context) {
  return {
    profile: {
      id: context.profile.id,
      email: context.profile.email,
      displayName: context.profile.displayName,
      timezone: context.profile.settings.timezone,
      locale: context.profile.settings.locale,
    },
    projects: context.xVextaProjects.map((project) => ({
      id: project.id,
      name: project.name,
      code: project.code,
      color: project.color,
      updatedAt: project.updatedAt,
    })),
    xVextaNotes: context.xVextaNotes.map((note) => ({
      id: note.id,
      projectId: note.projectId,
      title: note.title,
      summary: note.summary,
      updatedAt: note.updatedAt,
    })),
    recentNotes: (context.recentNotes || []).map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body || note.content || note.summary || '',
      updatedAt: note.updatedAt,
    })),
    todayTasks: context.todayTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
    })),
    overdueTasks: context.overdueTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
    })),
    activeReminders: context.activeReminders.map((reminder) => ({
      id: reminder.id,
      title: reminder.title,
      scheduledAt: reminder.scheduledAt,
      recurrence: reminder.recurrence,
    })),
    mailContacts: (context.mailContacts || []).map((contact) => ({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      aliases: contact.aliases || [],
      notes: contact.notes || '',
    })),
    recentMemories: (context.recentMemories || []).map((memory) => ({
      id: memory.id,
      category: memory.category,
      title: memory.title,
      slug: memory.slug,
      summary: memory.summary,
      updatedAt: memory.updatedAt,
    })),
    unreadInbox: context.unreadInbox.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      signalCode: item.signalCode,
    })),
    derivedSignals: context.derivedSignals,
    generatedAt: context.generatedAt,
  }
}

function jsonToolResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  }
}

function buildTextBlocks(value) {
  const text = readOptionalString(value)
  if (!text) {
    return undefined
  }

  return [{ type: 'text', content: text }]
}

function normalizeBaseUrl(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  return normalized || DEFAULT_BASE_URL
}

function normalizeLookup(value) {
  return expandSpokenDigits(String(value || ''))
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function expandSpokenDigits(value) {
  return [
    [/\b\u043d\u043e\u043b\u044c\b/giu, '0'],
    [/\b\u043e\u0434\u0438\u043d\b/giu, '1'],
    [/\b\u0434\u0432\u0430\b/giu, '2'],
    [/\b\u0442\u0440\u0438\b/giu, '3'],
    [/\b\u0447\u0435\u0442\u044b\u0440\u0435\b/giu, '4'],
    [/\b\u043f\u044f\u0442\u044c\b/giu, '5'],
    [/\b\u0448\u0435\u0441\u0442\u044c\b/giu, '6'],
    [/\b\u0441\u0435\u043c\u044c\b/giu, '7'],
    [/\b\u0432\u043e\u0441\u0435\u043c\u044c\b/giu, '8'],
    [/\b\u0434\u0435\u0432\u044f\u0442\u044c\b/giu, '9'],
  ].reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value)
}

function readRequiredString(value, fieldName) {
  const normalized = readOptionalString(value)
  if (!normalized) {
    throw new Error(`${fieldName} is required.`)
  }
  return normalized
}

function readRequiredStringArray(value, fieldName) {
  const normalized = readOptionalStringArray(value)
  if (!normalized || normalized.length === 0) {
    throw new Error(`${fieldName} is required.`)
  }
  return normalized
}

function readOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readOptionalBoolean(value) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'string') {
    return false
  }

  return /^(?:true|1|yes|y|да|все|all)$/iu.test(value.trim())
}

function isJwtExpiringSoon(token) {
  const parts = token.split('.')
  if (parts.length < 2) {
    return false
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const exp = readOptionalNumber(payload?.exp)
    if (!exp) {
      return false
    }
    return exp * 1000 <= Date.now() + 5 * 60_000
  } catch {
    return false
  }
}

function readOptionalStringArray(value) {
  if (!Array.isArray(value)) {
    return undefined
  }

  const normalized = value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
  return normalized.length > 0 ? normalized : undefined
}

function readOptionalObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value
}

function extractCollection(raw, keys) {
  if (Array.isArray(raw)) {
    return raw
  }

  const record = readOptionalObject(raw)
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

  if (readOptionalObject(data)) {
    return extractCollection(data, keys)
  }

  return []
}

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value
}

async function safeErrorMessage(response) {
  try {
    const payload = await response.json()
    const error = readOptionalString(payload?.error)
    return error || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
