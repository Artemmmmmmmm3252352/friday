import type {
  AgentActionRequest,
  AgentContext,
  CreateReminderInput,
  CreateTaskInput,
  ReminderRecurrence,
  Task,
  UpdateTaskInput,
  XVextaBlockInput,
  XVextaNote,
  XVextaProject,
} from '@contracts'
import { flattenXVextaBlockText, isXVextaPlaceholderNoteContent } from '../../packages/contracts/src/xVextaNoteContent'
import { parseXVextaRichText, summarizeXVextaBlockInputs } from '../../packages/contracts/src/xVextaRichText'

export type AgentToolName =
  | 'create_note'
  | 'create_task'
  | 'update_task'
  | 'create_reminder'
  | 'dismiss_inbox_item'
  | 'get_x_vexta_note'
  | 'create_x_vexta_project'
  | 'update_x_vexta_project'
  | 'create_x_vexta_note'
  | 'update_x_vexta_note'
  | 'append_x_vexta_blocks'

export type AgentToolDecision =
  | { mode: 'pass' }
  | { mode: 'clarify'; reply: string }
  | { mode: 'tool'; tool: AgentToolName; arguments: Record<string, unknown> }

export type ResolvedAgentToolDecision =
  | { kind: 'reply'; reply: string }
  | { kind: 'action'; request: AgentActionRequest; successReply: string }

export function buildAgentContextPrompt(context: AgentContext, userText: string): string {
  const noteLines = context.recentNotes.slice(0, 3).map((note) => `- ${note.title ?? 'Untitled'}: ${trimLine(note.body)}`)
  const taskLines = context.todayTasks.slice(0, 5).map((task) => `- ${task.title} (${task.status})`)
  const signalLines = context.derivedSignals.slice(0, 5).map((signal) => `- ${signal.code}: ${signal.body}`)
  const projectLines = context.xVextaProjects.slice(0, 5).map((project) => `- ${project.name} [${project.code}]`)
  const xVextaNoteLines = context.xVextaNotes
    .slice(0, 5)
    .map((note) => `- ${note.title}${note.projectId ? ` (project: ${note.projectId})` : ''}: ${trimLine(note.summary)}`)

  return [
    'Use the following server context while answering the user. Do not invent records that are not present here.',
    'Backend tools exist for create and update operations. If the user asks to change data and the target is ambiguous, ask a short clarification question.',
    `User: ${context.profile.displayName} <${context.profile.email}>`,
    `Timezone: ${context.profile.settings.timezone}`,
    'Today tasks:',
    taskLines.length > 0 ? taskLines.join('\n') : '- none',
    'Recent notes:',
    noteLines.length > 0 ? noteLines.join('\n') : '- none',
    'X Vexta projects:',
    projectLines.length > 0 ? projectLines.join('\n') : '- none',
    'X Vexta notes (preview only):',
    xVextaNoteLines.length > 0 ? xVextaNoteLines.join('\n') : '- none',
    'Signals:',
    signalLines.length > 0 ? signalLines.join('\n') : '- none',
    '',
    `User request: ${userText}`,
  ].join('\n')
}

export function buildAgentToolAwarePrompt(context: AgentContext, userText: string): string {
  return [
    buildAgentContextPrompt(context, userText),
    '',
    'You are Friday. Reply naturally for normal chat requests.',
    'You may use backend tools only when the user explicitly wants to create, update, dismiss, read, or save platform data such as notes, projects, tasks, reminders, or inbox items.',
    'Do not use backend tools for general conversation, writing help, recipes, explanations, brainstorming, roleplay, translation, or internet-style Q&A.',
    'Think through the user request first. If the user wants content to be created and then saved, emit a tool call only when you already know the final content that should be written.',
    'You may use your normal built-in reasoning and tool abilities, including web or browser tools, before emitting a Friday tool call.',
    'The X Vexta note entries shown in context are only previews. If the user asks what is inside a specific note, or wants to rewrite its body safely, call get_x_vexta_note first.',
    'When the user asks to format a note beautifully, use structured note blocks such as heading-1/2/3, bulleted-list, numbered-list, todo, quote, callout, code, table, divider, image, and embed. Do not store a monolithic markdown blob when structure can be expressed with blocks.',
    'Use backend tools only for the explicit save target. For example, if the user asks for a recipe, first write the recipe as chat unless they also asked to save it into notes.',
    'For create_x_vexta_note and update_x_vexta_note, never emit placeholder content, future promises, or generic summaries like "latest news about X". If the user asked for research, latest facts, a recipe, a story, a summary, or beautiful formatting, the tool call must already contain the full final note content in summary or blocks.',
    'If you need a backend tool, respond with this exact format and nothing else:',
    '<friday_tool>{"mode":"tool","tool":"update_x_vexta_note","arguments":{"noteTitle":"111","mode":"replace","summary":"new text"}}</friday_tool>',
    'Available tools:',
    '- get_x_vexta_note: { "noteId"? , "noteTitle"? , "projectId"? , "projectCode"? , "projectName"? }',
    '- create_x_vexta_note: { "projectId"? , "projectCode"? , "projectName"? , "title", "summary"?, "status"?, "dueDate"?, "blocks"? }',
    '- update_x_vexta_note: { "noteId"? , "noteTitle"? , "projectId"? , "projectCode"? , "projectName"? , "mode": "append"|"replace", "title"?, "summary"?, "status"?, "dueDate"?, "blocks"? }',
    '- append_x_vexta_blocks: { "noteId"? , "noteTitle"? , "projectId"? , "projectCode"? , "projectName"? , "blocks": [ ... ] }',
    '- create_x_vexta_project / update_x_vexta_project / create_task / update_task / create_reminder / dismiss_inbox_item / create_note',
    'Block format examples:',
    '- bulleted list item: { "type": "bulleted-list", "content": "milk" }',
    '- numbered list item: { "type": "numbered-list", "content": "step one", "metadata": { "start": 1 } }',
    '- todo item: { "type": "todo", "content": "buy eggs", "metadata": { "checked": false } }',
    '- quote: { "type": "quote", "content": "important excerpt" }',
    '- callout: { "type": "callout", "content": "watch this release", "metadata": { "icon": "💡" } }',
    '- divider: { "type": "divider" }',
    '- table: { "type": "table", "metadata": { "columns": ["Name","Value"], "rows": ["milk|2", "eggs|12"] } }',
    '- image: { "type": "image", "metadata": { "src": "https://...", "caption": "cover" } }',
    '- embed: { "type": "embed", "metadata": { "url": "https://..." } }',
    'If you do not need a tool, answer the user normally.',
    'If the target is ambiguous, ask a short clarification question normally.',
    'Never claim that data was changed unless a tool result is provided later.',
  ].join('\n')
}

export function buildAgentToolRefinementPrompt(userText: string, decision: AgentToolDecision): string {
  return [
    'Your previous Friday note tool call was underspecified.',
    'Do not save placeholder content. Do not describe what will be written later.',
    'If the user asked for latest information, research, news, or web-derived facts, use your normal built-in tools first, then return a corrected Friday tool call.',
    'If the user asked for beautiful formatting, return structured X Vexta note blocks, not a one-line summary.',
    'If you still do not have enough final content to save safely, ask the user a short clarification question instead of emitting any Friday tool call.',
    'Otherwise respond with a single corrected <friday_tool>...</friday_tool> block and nothing else.',
    `Original user request: ${userText}`,
    `Previous tool call: ${JSON.stringify(decision)}`,
  ].join('\n')
}

export function buildAgentToolResultPrompt(userText: string, toolResult: { ok: boolean; tool: AgentToolName; resultText: string; payload?: unknown; errorText?: string }): string {
  return [
    'You are Friday. A backend tool was already executed for the user request below.',
    'Write the final user-facing reply naturally in the same language as the user.',
    'Do not emit JSON, do not emit <friday_tool>, and do not ask to call another tool.',
    '',
    `Original user request: ${userText}`,
    `Tool: ${toolResult.tool}`,
    `Success: ${toolResult.ok ? 'yes' : 'no'}`,
    `Tool result: ${toolResult.resultText}`,
    toolResult.payload !== undefined ? `Payload: ${JSON.stringify(toolResult.payload)}` : '',
    toolResult.errorText ? `Error: ${toolResult.errorText}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildAgentToolSelectionPrompt(context: AgentContext, userText: string): string {
  const snapshot = {
    user: {
      id: context.profile.id,
      displayName: context.profile.displayName,
      email: context.profile.email,
      timezone: context.profile.settings.timezone,
      locale: context.profile.settings.locale,
    },
    tasks: context.todayTasks.slice(0, 20).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
    })),
    projects: context.xVextaProjects.slice(0, 30).map((project) => ({
      id: project.id,
      name: project.name,
      code: project.code,
      color: project.color,
      updatedAt: project.updatedAt,
    })),
    xVextaNotes: context.xVextaNotes.slice(0, 40).map((note) => ({
      id: note.id,
      projectId: note.projectId,
      title: note.title,
      summary: trimLine(note.summary),
      updatedAt: note.updatedAt,
    })),
    inbox: context.unreadInbox.slice(0, 20).map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      sourceId: item.sourceId,
    })),
  }

  return [
    'You are the hidden Friday tool planner.',
    'Decide whether the user request requires a backend tool call or should be handled by the normal chat model.',
    'Return raw JSON only. No markdown, no commentary, no code fences.',
    'Valid schemas:',
    '{"mode":"pass"}',
    '{"mode":"clarify","reply":"short clarification question for the user"}',
    '{"mode":"tool","tool":"update_x_vexta_note","arguments":{"noteId":"note-123","mode":"replace","summary":"new text"}}',
    'Available tools and arguments:',
    '- create_note: { "title"?, "body" }',
    '- create_task: { "title", "description"?, "dueAt"? }',
    '- update_task: { "taskId"?, "taskTitle"?, "title"?, "description"?, "dueAt"?, "status"?, "completedAt"? }',
    '- create_reminder: { "title", "body"?, "scheduledAt", "recurrence": "none"|"daily"|"weekly", "timezone"? }',
    '- dismiss_inbox_item: { "inboxItemId"?, "inboxTitle"? }',
    '- get_x_vexta_note: { "noteId"?, "noteTitle"?, "projectId"?, "projectCode"?, "projectName"? }',
    '- create_x_vexta_project: { "name", "code"?, "color"?, "summary"? }',
    '- update_x_vexta_project: { "projectId"?, "projectCode"?, "projectName"?, "name"?, "code"?, "color"?, "summary"? }',
    '- create_x_vexta_note: { "projectId"?, "projectCode"?, "projectName"?, "title", "summary"?, "status"?, "dueDate"?, "blocks"? }',
    '- update_x_vexta_note: { "noteId"?, "noteTitle"?, "projectId"?, "projectCode"?, "projectName"?, "mode": "append"|"replace", "title"?, "summary"?, "status"?, "dueDate"?, "blocks"? }',
    '- append_x_vexta_blocks: { "noteId"?, "noteTitle"?, "projectId"?, "projectCode"?, "projectName"?, "blocks": [ ... ] }',
    'Rules:',
    '- Use mode=tool whenever the user clearly wants to create, save, edit, rename, append, replace, schedule, or dismiss data.',
    '- Use mode=clarify only when the target is ambiguous or required fields are missing.',
    '- Use mode=pass for informational conversation that should be answered normally.',
    '- Never claim a write already happened. The write happens only after your tool decision is executed.',
    '- Prefer IDs from context when they are available.',
    '- "there", "туда", "that note", and similar pronouns usually refer to the most recently updated X Vexta note in context.',
    '',
    'Context snapshot:',
    JSON.stringify(snapshot, null, 2),
    '',
    `User request: ${userText}`,
  ].join('\n')
}

export function parseAgentToolDecision(replyText: string): AgentToolDecision | null {
  const parsed = tryParseJsonObject(replyText)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  const record = parsed as Record<string, unknown>

  const mode = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : ''
  if (mode === 'pass') {
    return { mode: 'pass' }
  }

  if (mode === 'clarify') {
    const reply = typeof record.reply === 'string' ? record.reply.trim() : ''
    return reply ? { mode: 'clarify', reply } : null
  }

  if (mode === 'tool') {
    const tool = typeof record.tool === 'string' ? record.tool.trim() : ''
    if (!isAgentToolName(tool)) {
      return null
    }

    const args = record.arguments
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return null
    }

    return { mode: 'tool', tool, arguments: args as Record<string, unknown> }
  }

  return null
}

export function extractAgentToolDecision(replyText: string): AgentToolDecision | null {
  const tagged = replyText.match(/<friday_tool>\s*([\s\S]+?)\s*<\/friday_tool>/i)
  if (!tagged) {
    return null
  }

  return parseAgentToolDecision(tagged[1].trim())
}

export function shouldRefineAgentToolDecision(userText: string, decision: AgentToolDecision): boolean {
  if (decision.mode !== 'tool') {
    return false
  }

  if (
    decision.tool !== 'create_x_vexta_note' &&
    decision.tool !== 'update_x_vexta_note' &&
    decision.tool !== 'append_x_vexta_blocks'
  ) {
    return false
  }

  if (!requestNeedsSubstantiveSavedContent(userText)) {
    return false
  }

  const summary = normalizeOptionalText(readString(decision.arguments.summary)) ?? ''
  const title =
    normalizeOptionalText(readString(decision.arguments.title)) ??
    normalizeOptionalText(readString(decision.arguments.noteTitle)) ??
    ''
  const blocks = readXVextaBlocks(decision.arguments.blocks) ?? []
  const flattenedBlockText = flattenXVextaBlockText(blocks)
  const signalText = [summary, flattenedBlockText].filter(Boolean).join('\n').trim()
  const normalizedSignal = normalizeLookup(signalText)
  const normalizedTitle = normalizeLookup(title)

  if (!signalText) {
    return true
  }

  if (blocks.length === 0 && signalText.length < 120) {
    return true
  }

  if (blocks.length === 1 && signalText.length < 160) {
    return true
  }

  if (normalizedTitle && normalizedSignal && normalizedSignal.includes(normalizedTitle) && signalText.length < 180) {
    return true
  }

  if (isXVextaPlaceholderNoteContent({ title, summary, blocks })) {
    return true
  }

  return false
}

export function resolveAgentToolDecision(decision: AgentToolDecision, context: AgentContext): ResolvedAgentToolDecision {
  if (decision.mode === 'pass') {
    return { kind: 'reply', reply: '' }
  }

  if (decision.mode === 'clarify') {
    return { kind: 'reply', reply: decision.reply }
  }

  switch (decision.tool) {
    case 'create_note': {
      const body = readString(decision.arguments.body)?.trim()
      if (!body) {
        return replyResolution(ru('Уточни, что именно нужно сохранить в заметках.'))
      }

      const title = normalizeOptionalText(readString(decision.arguments.title))
      return {
        kind: 'action',
        request: {
          action: {
            type: 'create_note',
            payload: { title, body },
          },
        },
        successReply: ru('Готово, сохранила заметку.'),
      }
    }

    case 'create_task': {
      const title = readString(decision.arguments.title)?.trim()
      if (!title) {
        return replyResolution(ru('Уточни название задачи.'))
      }

      const payload: CreateTaskInput = {
        title,
        description: normalizeOptionalText(readString(decision.arguments.description)),
        dueAt: normalizeOptionalText(readString(decision.arguments.dueAt)),
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'create_task',
            payload,
          },
        },
        successReply: `${ru('Готово, создала задачу')} "${title}".`,
      }
    }

    case 'update_task': {
      const task = resolveTaskTarget(context, decision.arguments)
      if (!task) {
        return replyResolution(ru('Не вижу, какую именно задачу нужно изменить. Уточни её название.'))
      }

      const changes: UpdateTaskInput = {}
      const nextTitle = normalizeOptionalText(readString(decision.arguments.title))
      const nextDescription = normalizeOptionalText(readString(decision.arguments.description))
      const nextDueAt = normalizeOptionalText(readString(decision.arguments.dueAt))
      const nextStatus = readTaskStatus(decision.arguments.status)
      const nextCompletedAt = normalizeOptionalText(readString(decision.arguments.completedAt))

      if (nextTitle !== undefined) changes.title = nextTitle
      if (nextDescription !== undefined) changes.description = nextDescription
      if (nextDueAt !== undefined) changes.dueAt = nextDueAt
      if (nextStatus !== undefined) changes.status = nextStatus
      if (nextCompletedAt !== undefined) changes.completedAt = nextCompletedAt

      if (Object.keys(changes).length === 0) {
        return replyResolution(ru('Для изменения задачи не хватает новых данных.'))
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'update_task',
            payload: {
              taskId: task.id,
              changes,
            },
          },
        },
        successReply: `${ru('Готово, обновила задачу')} "${changes.title ?? task.title}".`,
      }
    }

    case 'create_reminder': {
      const title = readString(decision.arguments.title)?.trim()
      const scheduledAt = readString(decision.arguments.scheduledAt)?.trim()
      const recurrence = readReminderRecurrence(decision.arguments.recurrence)
      if (!title || !scheduledAt || !recurrence) {
        return replyResolution(ru('Для напоминания нужны название, время и тип повторения.'))
      }

      const payload: CreateReminderInput = {
        title,
        body: normalizeOptionalText(readString(decision.arguments.body)),
        scheduledAt,
        recurrence,
        timezone: normalizeOptionalText(readString(decision.arguments.timezone)) ?? context.profile.settings.timezone,
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'create_reminder',
            payload,
          },
        },
        successReply: `${ru('Готово, создала напоминание')} "${title}".`,
      }
    }

    case 'dismiss_inbox_item': {
      const itemId = resolveInboxItemId(context, decision.arguments)
      if (!itemId) {
        return replyResolution(ru('Не вижу, какое уведомление нужно скрыть.'))
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'dismiss_inbox_item',
            payload: {
              inboxItemId: itemId,
            },
          },
        },
        successReply: ru('Готово, уведомление скрыла.'),
      }
    }

    case 'get_x_vexta_note': {
      const note = resolveXVextaNoteTarget(context, decision.arguments)
      if (!note) {
        return replyResolution(ru('Не вижу, какую именно заметку нужно открыть. Уточни её название или проект.'))
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'get_x_vexta_note',
            payload: {
              noteId: note.id,
            },
          },
        },
        successReply: `${ru('Открыла данные заметки')} "${note.title}".`,
      }
    }

    case 'create_x_vexta_project': {
      const name = readString(decision.arguments.name)?.trim()
      if (!name) {
        return replyResolution(ru('Уточни название проекта.'))
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'create_x_vexta_project',
            payload: {
              name,
              code: normalizeOptionalText(readString(decision.arguments.code)),
              color: normalizeOptionalText(readString(decision.arguments.color)),
              summary: normalizeOptionalText(readString(decision.arguments.summary)),
            },
          },
        },
        successReply: `${ru('Готово, создала проект')} "${name}".`,
      }
    }

    case 'update_x_vexta_project': {
      const project = resolveProjectTarget(context, decision.arguments)
      if (!project) {
        return replyResolution(ru('Не вижу, какой именно проект нужно изменить. Уточни название или код проекта.'))
      }

      const nextName = normalizeOptionalText(readString(decision.arguments.name))
      const nextCode = normalizeOptionalText(readString(decision.arguments.code))
      const nextColor = normalizeOptionalText(readString(decision.arguments.color))
      const nextSummary = normalizeOptionalText(readString(decision.arguments.summary))

      if (nextName === undefined && nextCode === undefined && nextColor === undefined && nextSummary === undefined) {
        return replyResolution(ru('Для изменения проекта не хватает новых данных.'))
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'update_x_vexta_project',
            payload: {
              projectId: project.id,
              changes: {
                name: nextName,
                code: nextCode,
                color: nextColor,
                summary: nextSummary,
              },
            },
          },
        },
        successReply: `${ru('Готово, обновила проект')} "${nextName ?? project.name}".`,
      }
    }

    case 'create_x_vexta_note': {
      const title = readString(decision.arguments.title)?.trim()
      if (!title) {
        return replyResolution(ru('Уточни название заметки.'))
      }

      const project = resolveProjectTarget(context, decision.arguments, { allowDefault: true })
      const summary = normalizeOptionalText(readString(decision.arguments.summary))
      const blocks = readXVextaBlocks(decision.arguments.blocks) ?? buildPlainTextXVextaBlocks(summary)
      return {
        kind: 'action',
        request: {
          action: {
            type: 'create_x_vexta_note',
            payload: {
              projectId: project?.id ?? null,
              title,
              summary,
              status: readXVextaNoteStatus(decision.arguments.status),
              dueDate: normalizeOptionalText(readString(decision.arguments.dueDate)),
              blocks,
            },
          },
        },
        successReply: `${ru('Готово, создала заметку')} "${title}".`,
      }
    }

    case 'update_x_vexta_note': {
      const note = resolveXVextaNoteTarget(context, decision.arguments)
      if (!note) {
        return replyResolution(ru('Не вижу, какую именно заметку нужно изменить. Уточни её название или проект.'))
      }

      const nextTitle = normalizeOptionalText(readString(decision.arguments.title))
      const rawSummary = normalizeOptionalText(readString(decision.arguments.summary))
      const mode = readString(decision.arguments.mode)?.trim().toLowerCase()
      const status = readXVextaNoteStatus(decision.arguments.status)
      const dueDate = normalizeOptionalText(readString(decision.arguments.dueDate))
      const nextProject = resolveProjectTarget(context, decision.arguments, { allowDefault: false })
      const explicitBlocks = readXVextaBlocks(decision.arguments.blocks)
      const blocks = resolveXVextaNoteUpdateBlocks(note, mode, rawSummary, explicitBlocks)
      const summary = resolveXVextaNoteUpdateSummary(note.summary, mode, rawSummary, explicitBlocks)

      if (nextTitle === undefined && summary === undefined && status === undefined && dueDate === undefined && !nextProject && blocks === undefined) {
        return replyResolution(ru('Для изменения заметки не хватает новых данных.'))
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'update_x_vexta_note',
            payload: {
              noteId: note.id,
              changes: {
                title: nextTitle,
                summary,
                status,
                dueDate,
                projectId: nextProject ? nextProject.id : undefined,
                blocks,
              },
            },
          },
        },
        successReply: `${ru('Готово, обновила заметку')} "${nextTitle ?? note.title}".`,
      }
    }

    case 'append_x_vexta_blocks': {
      const note = resolveXVextaNoteTarget(context, decision.arguments)
      if (!note) {
        return replyResolution(ru('Не вижу, в какую именно заметку нужно добавить блоки. Уточни её название или проект.'))
      }

      const blocks = readXVextaBlocks(decision.arguments.blocks)
      if (!blocks || blocks.length === 0) {
        return replyResolution(ru('Не вижу, какие именно блоки нужно добавить в заметку.'))
      }

      return {
        kind: 'action',
        request: {
          action: {
            type: 'append_x_vexta_blocks',
            payload: {
              noteId: note.id,
              blocks,
            },
          },
        },
        successReply: `${ru('Готово, добавила блоки в заметку')} "${note.title}".`,
      }
    }
  }
}

export function parseBackendAgentAction(text: string, context?: AgentContext): AgentActionRequest | null {
  const normalized = compactWhitespace(text)

  const projectCreateMatch = normalized.match(
    /^(?:create project|\u0441\u043e\u0437\u0434\u0430\u0439 \u043f\u0440\u043e\u0435\u043a\u0442)\s+(.+)$/i,
  )
  if (projectCreateMatch) {
    return {
      action: {
        type: 'create_x_vexta_project',
        payload: {
          name: projectCreateMatch[1].trim(),
        },
      },
    }
  }

  const projectRenameMatch = normalized.match(
    /^(?:rename project|\u043f\u0435\u0440\u0435\u0438\u043c\u0435\u043d\u0443\u0439 \u043f\u0440\u043e\u0435\u043a\u0442)\s+(.+?)\s+(?:to|\u0432)\s+(.+)$/i,
  )
  if (projectRenameMatch && context) {
    const project = findProject(context, projectRenameMatch[1])
    if (project) {
      return {
        action: {
          type: 'update_x_vexta_project',
          payload: {
            projectId: project.id,
            changes: {
              name: projectRenameMatch[2].trim(),
            },
          },
        },
      }
    }
  }

  const explicitProjectNoteCreate = normalized.match(
    /^(?:create note in project|\u0441\u043e\u0437\u0434\u0430\u0439 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u043f\u0440\u043e\u0435\u043a\u0442\u0435|\u0434\u043e\u0431\u0430\u0432\u044c \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u043f\u0440\u043e\u0435\u043a\u0442(?:\u0435)?|\u0437\u0430\u043f\u0438\u0448\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u043f\u0440\u043e\u0435\u043a\u0442(?:\u0435)?)\s+(.+?)\s*[:-]\s*(.+)$/i,
  )
  if (explicitProjectNoteCreate && context) {
    const project = findProject(context, explicitProjectNoteCreate[1])
    if (project) {
      const noteDraft = parseNoteDraft(explicitProjectNoteCreate[2], context)
      return {
        action: {
          type: 'create_x_vexta_note',
          payload: {
            projectId: project.id,
            title: noteDraft.title,
            summary: noteDraft.summary,
          },
        },
      }
    }
  }

  const explicitProjectNoteUpdate = normalized.match(
    /^(?:update note in project|\u043e\u0431\u043d\u043e\u0432\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u043f\u0440\u043e\u0435\u043a\u0442\u0435|\u0438\u0437\u043c\u0435\u043d\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u043f\u0440\u043e\u0435\u043a\u0442\u0435|\u043e\u0442\u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u0443\u0439 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u043f\u0440\u043e\u0435\u043a\u0442\u0435)\s+(.+?)\s*[:-]\s*(.+?)\s*(?:=>|->|\u2192)\s*(.+)$/i,
  )
  if (explicitProjectNoteUpdate && context) {
    const project = findProject(context, explicitProjectNoteUpdate[1])
    const note = findNote(context, explicitProjectNoteUpdate[2], project?.id ?? null)
    if (note) {
      return buildNoteReplaceAction(note.id, explicitProjectNoteUpdate[3].trim())
    }
  }

  const naturalNoteUpdate = context ? parseNaturalNoteUpdate(normalized, context) : null
  if (naturalNoteUpdate) {
    return naturalNoteUpdate
  }

  const noteAppendMatch = normalized.match(
    /^(?:\u0434\u043e\u0431\u0430\u0432\u044c \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443|\u0434\u043e\u043f\u043e\u043b\u043d\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443|\u043d\u0430\u043f\u0438\u0448\u0438 \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443|append to note)\s+(.+?)\s*[:,-]\s*(.+)$/i,
  )
  if (noteAppendMatch && context) {
    const note = findNote(context, noteAppendMatch[1], null)
    if (note) {
      return buildNoteAppendAction(note.id, noteAppendMatch[2].trim())
    }
  }

  const noteReplaceMatch = normalized.match(
    /^(?:\u043e\u0431\u043d\u043e\u0432\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443|\u0438\u0437\u043c\u0435\u043d\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443|\u043e\u0442\u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u0443\u0439 \u0437\u0430\u043c\u0435\u0442\u043a\u0443|update note|edit note)\s+(.+?)\s*[:=-]\s*(.+)$/i,
  )
  if (noteReplaceMatch && context) {
    const note = findNote(context, noteReplaceMatch[1], null)
    if (note) {
      return buildNoteReplaceAction(note.id, noteReplaceMatch[2].trim())
    }
  }

  const implicitNoteWriteMatch = normalized.match(
    /^(?:\u0434\u043e\u0431\u0430\u0432\u044c(?: \u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430)? \u0442\u0443\u0434\u0430|\u043d\u0430\u043f\u0438\u0448\u0438(?: \u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430)? \u0442\u0443\u0434\u0430|\u0434\u043e\u043f\u043e\u043b\u043d\u0438(?: \u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430)?(?: \u0442\u0443\u0434\u0430| \u0437\u0430\u043c\u0435\u0442\u043a\u0443| \u044d\u0442\u043e)?|append there|write there)\s+(.+)$/i,
  )
  if (implicitNoteWriteMatch && context) {
    return buildImplicitNoteWriteAction(context, implicitNoteWriteMatch[1].trim())
  }

  const notesAppCreateMatch = normalized.match(
    /^(?:\u0437\u0430\u043f\u0438\u0448\u0438 \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0438|\u0434\u043e\u0431\u0430\u0432\u044c \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0438|\u0441\u043e\u0437\u0434\u0430\u0439 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0430\u0445|create note in notes)\s+(.+)$/i,
  )
  if (notesAppCreateMatch && context) {
    const noteDraft = parseNoteDraft(notesAppCreateMatch[1], context)
    return {
      action: {
        type: 'create_x_vexta_note',
        payload: {
          projectId: findDefaultProject(context)?.id ?? null,
          title: noteDraft.title,
          summary: noteDraft.summary,
        },
      },
    }
  }

  const noteMatch = normalized.match(
    /^(?:create note|add note|\u0441\u043e\u0437\u0434\u0430\u0439 \u0437\u0430\u043c\u0435\u0442\u043a\u0443|\u0437\u0430\u043f\u0438\u0448\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443)\s+(.+)$/i,
  )
  if (noteMatch) {
    return {
      action: {
        type: 'create_note',
        payload: {
          body: noteMatch[1].trim(),
        },
      },
    }
  }

  const taskMatch = normalized.match(
    /^(?:create task|add task|\u0441\u043e\u0437\u0434\u0430\u0439 \u0437\u0430\u0434\u0430\u0447\u0443|\u0434\u043e\u0431\u0430\u0432\u044c \u0437\u0430\u0434\u0430\u0447\u0443)\s+(.+)$/i,
  )
  if (taskMatch) {
    return {
      action: {
        type: 'create_task',
        payload: {
          title: taskMatch[1].trim(),
        },
      },
    }
  }

  return null
}

function buildImplicitNoteWriteAction(context: AgentContext, content: string): AgentActionRequest | null {
  const recentNote = findDefaultNote(context)
  if (recentNote) {
    return buildNoteAppendAction(recentNote.id, content)
  }

  const defaultProject = findDefaultProject(context)
  if (!defaultProject) {
    return null
  }

  const noteDraft = parseNoteDraft(content, context)
  return {
    action: {
      type: 'create_x_vexta_note',
      payload: {
        projectId: defaultProject.id,
        title: noteDraft.title,
        summary: noteDraft.summary,
      },
    },
  }
}

function buildNoteAppendAction(noteId: string, addition: string): AgentActionRequest {
  const blocks = buildPlainTextXVextaBlocks(addition.trim())
  if (!blocks) {
    return {
      action: {
        type: 'update_x_vexta_note',
        payload: {
          noteId,
          changes: {
            summary: addition.trim(),
          },
        },
      },
    }
  }

  return {
    action: {
      type: 'append_x_vexta_blocks',
      payload: {
        noteId,
        blocks,
      },
    },
  }
}

function buildNoteReplaceAction(noteId: string, summary: string): AgentActionRequest {
  const trimmedSummary = summary.trim()
  return {
    action: {
      type: 'update_x_vexta_note',
      payload: {
        noteId,
        changes: {
          summary: trimmedSummary,
          blocks: buildPlainTextXVextaBlocks(trimmedSummary),
        },
      },
    },
  }
}

function parseNoteDraft(rawValue: string, context: AgentContext): { title: string; summary?: string } {
  const value = rawValue.trim()
  const explicitSplit = value.split(/\s*(?:=>|->|\u2192|\|)\s*/u)
  if (explicitSplit.length >= 2) {
    const title = explicitSplit.shift()?.trim() ?? fallbackImplicitTitle(value, context)
    const summary = explicitSplit.join(' ').trim()
    return {
      title: title || fallbackImplicitTitle(summary, context),
      summary: summary || undefined,
    }
  }

  return {
    title: fallbackImplicitTitle(value, context),
    summary: value,
  }
}

function findProject(context: AgentContext, rawName: string) {
  const needle = normalizeLookup(rawName)
  return findProjectCandidates(context, needle)[0] ?? null
}

function findDefaultProject(context: AgentContext) {
  return context.xVextaProjects[0] ?? null
}

function findNote(context: AgentContext, rawTitle: string, projectId: string | null) {
  const needle = normalizeLookup(rawTitle)
  return findNoteCandidates(context, needle, projectId)[0] ?? null
}

function findDefaultNote(context: AgentContext) {
  return (
    [...context.xVextaNotes].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt)
      const rightTime = Date.parse(right.updatedAt || right.createdAt)
      return rightTime - leftTime
    })[0] ?? null
  )
}

function resolveTaskTarget(context: AgentContext, args: Record<string, unknown>): Task | null {
  const taskId = readString(args.taskId)?.trim()
  if (taskId) {
    return [...context.todayTasks, ...context.overdueTasks].find((task) => task.id === taskId) ?? null
  }

  const rawTitle = readString(args.taskTitle)?.trim()
  if (!rawTitle) {
    return null
  }

  const needle = normalizeLookup(rawTitle)
  const tasks = [...context.todayTasks, ...context.overdueTasks]
  return tasks.find((task) => normalizeLookup(task.title) === needle) ?? tasks.find((task) => normalizeLookup(task.title).includes(needle)) ?? null
}

function resolveProjectTarget(
  context: AgentContext,
  args: Record<string, unknown>,
  options: { allowDefault: boolean } = { allowDefault: false },
): XVextaProject | null {
  const projectId = readString(args.projectId)?.trim()
  if (projectId) {
    return context.xVextaProjects.find((project) => project.id === projectId) ?? null
  }

  const projectCode = readString(args.projectCode)?.trim()
  if (projectCode) {
    const matches = findProjectCandidates(context, normalizeLookup(projectCode))
    if (matches.length === 1) {
      return matches[0]
    }
    if (matches.length > 1) {
      return null
    }
  }

  const projectName = readString(args.projectName)?.trim()
  if (projectName) {
    const matches = findProjectCandidates(context, normalizeLookup(projectName))
    if (matches.length === 1) {
      return matches[0]
    }
    if (matches.length > 1) {
      return null
    }
  }

  return options.allowDefault ? findDefaultProject(context) : null
}

function resolveXVextaNoteTarget(context: AgentContext, args: Record<string, unknown>): XVextaNote | null {
  const noteId = readString(args.noteId)?.trim()
  if (noteId) {
    return context.xVextaNotes.find((note) => note.id === noteId) ?? null
  }

  const project = resolveProjectTarget(context, args, { allowDefault: false })
  const noteTitle = readString(args.noteTitle)?.trim()
  if (noteTitle) {
    const matches = findNoteCandidates(context, normalizeLookup(noteTitle), project?.id ?? null)
    if (matches.length === 1) {
      return matches[0]
    }
    if (matches.length > 1) {
      return null
    }
  }

  return findDefaultNote(context)
}

function resolveInboxItemId(context: AgentContext, args: Record<string, unknown>): string | null {
  const inboxItemId = readString(args.inboxItemId)?.trim()
  if (inboxItemId) {
    return context.unreadInbox.find((item) => item.id === inboxItemId)?.id ?? null
  }

  const inboxTitle = readString(args.inboxTitle)?.trim()
  if (!inboxTitle) {
    return null
  }

  const needle = normalizeLookup(inboxTitle)
  return (
    context.unreadInbox.find((item) => normalizeLookup(item.title) === needle)?.id ??
    context.unreadInbox.find((item) => normalizeLookup(item.title).includes(needle))?.id ??
    null
  )
}

function findProjectCandidates(context: AgentContext, needle: string): XVextaProject[] {
  const exact = context.xVextaProjects.filter(
    (project) => normalizeLookup(project.name) === needle || normalizeLookup(project.code) === needle,
  )
  if (exact.length > 0) {
    return exact
  }

  return context.xVextaProjects.filter(
    (project) => normalizeLookup(project.name).includes(needle) || normalizeLookup(project.code).includes(needle),
  )
}

function findNoteCandidates(context: AgentContext, needle: string, projectId: string | null): XVextaNote[] {
  const scoped = context.xVextaNotes.filter((note) => (projectId ? note.projectId === projectId : true))
  const exact = scoped.filter((note) => normalizeLookup(note.title) === needle)
  if (exact.length > 0) {
    return exact
  }

  return scoped.filter((note) => normalizeLookup(note.title).includes(needle))
}

function normalizeLookup(value: string): string {
  return replaceWordNumbers(compactWhitespace(value).toLowerCase()).replace(/\s+/g, '')
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function appendText(currentText: string, addition: string): string {
  const trimmedCurrent = currentText.trim()
  const trimmedAddition = addition.trim()
  if (!trimmedCurrent) {
    return trimmedAddition
  }
  if (!trimmedAddition) {
    return trimmedCurrent
  }
  return `${trimmedCurrent}\n\n${trimmedAddition}`
}

function buildPlainTextXVextaBlocks(text: string | undefined): XVextaBlockInput[] | undefined {
  const normalized = text?.trim()
  if (!normalized) {
    return undefined
  }

  const blocks = parseXVextaRichText(normalized).blocks
  return blocks.length > 0 ? blocks : undefined
}

function coerceXVextaStoredBlocks(blocks: unknown[]): unknown[] {
  return blocks.filter((entry) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
}

function resolveXVextaNoteUpdateBlocks(
  note: XVextaNote,
  mode: string | undefined,
  rawSummary: string | undefined,
  explicitBlocks: XVextaBlockInput[] | undefined,
): unknown[] | undefined {
  if (mode === 'append') {
    const additionBlocks = explicitBlocks ?? buildPlainTextXVextaBlocks(rawSummary)
    if (!additionBlocks || additionBlocks.length === 0) {
      return undefined
    }

    return [...coerceXVextaStoredBlocks(note.blocks), ...additionBlocks]
  }

  if (explicitBlocks) {
    return explicitBlocks
  }

  return buildPlainTextXVextaBlocks(rawSummary)
}

function resolveXVextaNoteUpdateSummary(
  currentSummary: string,
  mode: string | undefined,
  rawSummary: string | undefined,
  explicitBlocks: XVextaBlockInput[] | undefined,
): string | undefined {
  if (rawSummary !== undefined) {
    return mode === 'append' ? appendText(currentSummary, rawSummary) : rawSummary
  }

  if (mode === 'append') {
    const appendedPreview = explicitBlocks ? summarizeXVextaBlockInputs(explicitBlocks) : ''
    return appendedPreview ? appendText(currentSummary, appendedPreview) : undefined
  }

  const preview = explicitBlocks ? summarizeXVextaBlockInputs(explicitBlocks) : ''
  return preview || undefined
}

function parseNaturalNoteUpdate(text: string, context: AgentContext): AgentActionRequest | null {
  const prefixes = [
    '\u0434\u0430\u0432\u0430\u0439 \u0432\u043d\u0435\u0441\u0435\u043c \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 ',
    '\u0434\u0430\u0432\u0430\u0439 \u0432\u043d\u0435\u0441\u0451\u043c \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 ',
    '\u0432\u043d\u0435\u0441\u0438 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 ',
    '\u0432\u043d\u0435\u0441\u0435\u043c \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 ',
    '\u0432\u043d\u0435\u0441\u0451\u043c \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 ',
  ]
  const writeMarkers = [
    ' \u043d\u0430\u043f\u0438\u0448\u0438 \u0442\u0443\u0434\u0430 ',
    ' \u0434\u043e\u0431\u0430\u0432\u044c \u0442\u0443\u0434\u0430 ',
    ' \u0437\u0430\u043f\u0438\u0448\u0438 \u0442\u0443\u0434\u0430 ',
  ]
  const replaceMarkers = [
    ' \u0438 \u0441\u043e\u0442\u0440\u0438 \u0432\u0441\u0435 \u0447\u0442\u043e \u0442\u0430\u043c \u0431\u044b\u043b\u043e \u0434\u043e \u044d\u0442\u043e\u0433\u043e',
    ' \u0438 \u0441\u043e\u0442\u0440\u0438 \u0432\u0441\u0435 \u0447\u0442\u043e \u0431\u044b\u043b\u043e \u0434\u043e \u044d\u0442\u043e\u0433\u043e',
    ' \u0438 \u0437\u0430\u043c\u0435\u043d\u0438 \u0432\u0435\u0441\u044c \u0442\u0435\u043a\u0441\u0442',
    ' \u0438 \u043f\u0435\u0440\u0435\u0437\u0430\u043f\u0438\u0448\u0438 \u0435\u0435',
  ]

  for (const prefix of prefixes) {
    const prefixIndex = text.indexOf(prefix)
    if (prefixIndex < 0) {
      continue
    }

    const remainder = text.slice(prefixIndex + prefix.length)
    const marker = writeMarkers
      .map((candidate) => ({ candidate, index: remainder.indexOf(candidate) }))
      .filter((entry) => entry.index > 0)
      .sort((left, right) => left.index - right.index)[0]

    if (!marker) {
      continue
    }

    const rawTitle = remainder.slice(0, marker.index).trim()
    let content = remainder.slice(marker.index + marker.candidate.length).trim()
    let replaceMode = false

    for (const replaceMarker of replaceMarkers) {
      const replaceIndex = content.indexOf(replaceMarker)
      if (replaceIndex >= 0) {
        content = content.slice(0, replaceIndex).trim()
        replaceMode = true
        break
      }
    }

    content = content.replace(/^(?:\u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430)\s+/u, '').trim()

    const note = findNote(context, rawTitle, null)
    if (!note || !content) {
      return null
    }

    return replaceMode ? buildNoteReplaceAction(note.id, content) : buildNoteAppendAction(note.id, content)
  }

  return null
}

function replaceWordNumbers(value: string): string {
  const tokenMap = new Map<string, string>([
    ['\u043d\u043e\u043b\u044c', '0'],
    ['\u043e\u0434\u0438\u043d', '1'],
    ['\u043e\u0434\u043d\u0430', '1'],
    ['\u0434\u0432\u0430', '2'],
    ['\u0434\u0432\u0435', '2'],
    ['\u0442\u0440\u0438', '3'],
    ['\u0447\u0435\u0442\u044b\u0440\u0435', '4'],
    ['\u043f\u044f\u0442\u044c', '5'],
    ['\u0448\u0435\u0441\u0442\u044c', '6'],
    ['\u0441\u0435\u043c\u044c', '7'],
    ['\u0432\u043e\u0441\u0435\u043c\u044c', '8'],
    ['\u0434\u0435\u0432\u044f\u0442\u044c', '9'],
  ])

  return value
    .split(' ')
    .map((token) => tokenMap.get(token) ?? token)
    .join(' ')
}

function requestNeedsSubstantiveSavedContent(value: string): boolean {
  return /(?:красив|оформ|подроб|новост|из веб|из интернета|найд|собер|истори|рассказ|рецепт|summary|summar|latest|research|web|story|recipe|table|список|таблиц|цитат)/iu.test(
    value,
  )
}

function fallbackImplicitTitle(content: string, context: AgentContext): string {
  const normalized = compactWhitespace(content)
  if (!normalized) {
    return context.profile.settings.locale === 'ru' ? ru('Новая заметка') : 'New note'
  }

  const sanitized = normalized.replace(/[.!?]+$/u, '')
  return sanitized.length <= 48 ? sanitized : `${sanitized.slice(0, 45).trimEnd()}...`
}

function trimLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readTaskStatus(value: unknown): UpdateTaskInput['status'] | undefined {
  return value === 'todo' || value === 'in_progress' || value === 'done' || value === 'canceled' ? value : undefined
}

function readReminderRecurrence(value: unknown): ReminderRecurrence | undefined {
  return value === 'none' || value === 'daily' || value === 'weekly' ? value : undefined
}

function readXVextaNoteStatus(value: unknown): XVextaNote['status'] | undefined {
  return value === 'draft' || value === 'active' || value === 'in-review' || value === 'done' ? value : undefined
}

function readXVextaBlocks(value: unknown): XVextaBlockInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const blocks = value
    .map((entry): XVextaBlockInput | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null
      }

      const record = entry as Record<string, unknown>
      const type = readString(record.type)
      if (!isXVextaBlockType(type)) {
        return null
      }

      const content = normalizeOptionalText(readString(record.content))
      const metadata = record.metadata
      return {
        type,
        content,
        metadata:
          metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, string | number | boolean | null | string[]>)
            : undefined,
      }
    })
    .filter((entry): entry is XVextaBlockInput => Boolean(entry))

  return blocks.length > 0 ? blocks : undefined
}

function tryParseJsonObject(replyText: string): unknown | null {
  const normalized = stripCodeFence(replyText.trim())
  if (!normalized) {
    return null
  }

  try {
    return JSON.parse(normalized)
  } catch {
    const firstBrace = normalized.indexOf('{')
    const lastBrace = normalized.lastIndexOf('}')
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null
    }

    try {
      return JSON.parse(normalized.slice(firstBrace, lastBrace + 1))
    } catch {
      return null
    }
  }
}

function stripCodeFence(value: string): string {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i)
  return fenced ? fenced[1].trim() : value
}

function isAgentToolName(value: string): value is AgentToolName {
  return (
    value === 'create_note' ||
    value === 'create_task' ||
    value === 'update_task' ||
    value === 'create_reminder' ||
    value === 'dismiss_inbox_item' ||
    value === 'get_x_vexta_note' ||
    value === 'create_x_vexta_project' ||
    value === 'update_x_vexta_project' ||
    value === 'create_x_vexta_note' ||
    value === 'update_x_vexta_note' ||
    value === 'append_x_vexta_blocks'
  )
}

function isXVextaBlockType(value: string | undefined): value is XVextaBlockInput['type'] {
  return (
    value === 'text' ||
    value === 'heading-1' ||
    value === 'heading-2' ||
    value === 'heading-3' ||
    value === 'bulleted-list' ||
    value === 'numbered-list' ||
    value === 'todo' ||
    value === 'quote' ||
    value === 'code' ||
    value === 'image' ||
    value === 'table' ||
    value === 'divider' ||
    value === 'callout' ||
    value === 'embed'
  )
}

function replyResolution(reply: string): ResolvedAgentToolDecision {
  return { kind: 'reply', reply }
}

function ru(value: string): string {
  return value
}
