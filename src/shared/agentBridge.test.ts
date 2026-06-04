import { describe, expect, it } from 'vitest'

import type { AgentContext } from '@contracts'

import {
  buildAgentContextPrompt,
  buildAgentToolRefinementPrompt,
  buildAgentToolAwarePrompt,
  buildAgentToolResultPrompt,
  buildAgentToolSelectionPrompt,
  extractAgentToolDecision,
  parseAgentToolDecision,
  parseBackendAgentAction,
  resolveAgentToolDecision,
  shouldRefineAgentToolDecision,
} from './agentBridge'

const RU_CREATE_NOTE = '\u0441\u043e\u0437\u0434\u0430\u0439 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u043a\u0443\u043f\u0438\u0442\u044c \u043c\u0430\u0433\u043d\u0438\u0439'
const RU_NOTE_BODY = '\u043a\u0443\u043f\u0438\u0442\u044c \u043c\u0430\u0433\u043d\u0438\u0439'
const RU_CREATE_PROJECT = '\u0441\u043e\u0437\u0434\u0430\u0439 \u043f\u0440\u043e\u0435\u043a\u0442 Morning Plan'
const RU_CREATE_IN_NOTES = '\u0437\u0430\u043f\u0438\u0448\u0438 \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0438 \u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043f\u0440\u043e \u0432\u0435\u0447\u0435\u0440\u043d\u044e\u044e \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0443'
const RU_CREATE_IN_NOTES_TEXT = '\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043f\u0440\u043e \u0432\u0435\u0447\u0435\u0440\u043d\u044e\u044e \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0443'
const RU_APPEND_EXPLICIT = '\u0434\u043e\u0431\u0430\u0432\u044c \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 Squat progression: \u0435\u0449\u0435 2 \u043f\u043e\u0434\u0445\u043e\u0434\u0430'
const RU_APPEND_EXPLICIT_TEXT = '\u0435\u0449\u0435 2 \u043f\u043e\u0434\u0445\u043e\u0434\u0430'
const RU_REPLACE_EXPLICIT = '\u0438\u0437\u043c\u0435\u043d\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 Squat progression: \u043d\u043e\u0432\u044b\u0439 \u0442\u0435\u043a\u0441\u0442'
const RU_REPLACE_EXPLICIT_TEXT = '\u043d\u043e\u0432\u044b\u0439 \u0442\u0435\u043a\u0441\u0442'
const RU_APPEND_IMPLICIT = '\u0434\u043e\u0431\u0430\u0432\u044c \u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430 \u0442\u0443\u0434\u0430 \u0442\u0440\u0438 \u0440\u0430\u0437\u0430 \u043d\u0430\u043f\u0438\u0448\u0438 \u0441\u0435\u043a\u0441\u0435\u043b'
const RU_APPEND_IMPLICIT_TEXT = '\u0442\u0440\u0438 \u0440\u0430\u0437\u0430 \u043d\u0430\u043f\u0438\u0448\u0438 \u0441\u0435\u043a\u0441\u0435\u043b'
const RU_NATURAL_REPLACE =
  '\u043e\u0442\u043b\u0438\u0447\u043d\u043e \u0434\u0430\u0432\u0430\u0439 \u0432\u043d\u0435\u0441\u0451\u043c \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u043e\u0434\u0438\u043d \u043e\u0434\u0438\u043d \u043e\u0434\u0438\u043d \u043d\u0430\u043f\u0438\u0448\u0438 \u0442\u0443\u0434\u0430 \u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430 \u043a\u043e\u0440\u043e\u0442\u0435\u043d\u044c\u043a\u0438\u0439 \u0440\u0430\u0441\u0441\u043a\u0430\u0437 \u043f\u0440\u043e \u0451\u0436\u0438\u043a\u0430 \u0438 \u0441\u043e\u0442\u0440\u0438 \u0432\u0441\u0435 \u0447\u0442\u043e \u0442\u0430\u043c \u0431\u044b\u043b\u043e \u0434\u043e \u044d\u0442\u043e\u0433\u043e'
const RU_NATURAL_REPLACE_TEXT = '\u043a\u043e\u0440\u043e\u0442\u0435\u043d\u044c\u043a\u0438\u0439 \u0440\u0430\u0441\u0441\u043a\u0430\u0437 \u043f\u0440\u043e \u0451\u0436\u0438\u043a\u0430'

function createContext(): AgentContext {
  return {
    profile: {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'test@example.com',
      displayName: 'Tester',
      avatarUrl: null,
      settings: {
        timezone: 'UTC',
        locale: 'ru',
        bedtimeStart: '22:00',
        quietHoursStart: null,
        quietHoursEnd: null,
      },
      createdAt: '2026-03-16T00:00:00.000Z',
      updatedAt: '2026-03-16T00:00:00.000Z',
    },
    todayTasks: [
      {
        id: 'task-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        title: 'Leg workout',
        description: null,
        status: 'todo',
        dueAt: '2026-03-16T17:00:00.000Z',
        completedAt: null,
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
    ],
    overdueTasks: [],
    activeReminders: [],
    recentNotes: [
      {
        id: 'note-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        title: 'Phone note',
        body: 'Remember to stretch',
        isPinned: false,
        isArchived: false,
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
    ],
    recentMemories: [
      {
        id: 'memory-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        category: 'people',
        slug: 'tester-coach',
        title: 'Tester Coach',
        summary: 'Prefers short check-ins.',
        content: 'Met during a product review and prefers concise updates.',
        tags: ['communication'],
        aliases: ['Coach'],
        links: [],
        metadata: {},
        lastRememberedAt: '2026-03-16T00:00:00.000Z',
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
    ],
    mailContacts: [],
    xVextaProjects: [
      {
        userId: 'x-user-1',
        id: 'project-legs',
        name: 'Leg System',
        code: 'legs',
        color: '#3b82f6',
        summary: 'Leg training project',
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
    ],
    xVextaNotes: [
      {
        userId: 'x-user-1',
        id: 'note-legs-1',
        projectId: 'project-legs',
        title: 'Squat progression',
        summary: 'Increase weight next session',
        status: 'active',
        dueDate: '',
        tagIds: [],
        linksTo: [],
        links: [],
        attachments: [],
        blocks: [],
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
      {
        userId: 'x-user-1',
        id: 'note-111',
        projectId: null,
        title: '111',
        summary: '76',
        status: 'active',
        dueDate: '',
        tagIds: [],
        linksTo: [],
        links: [],
        attachments: [],
        blocks: [],
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:01.000Z',
      },
    ],
    unreadInbox: [],
    derivedSignals: [],
    generatedAt: '2026-03-16T00:00:00.000Z',
  }
}

describe('agentBridge', () => {
  it('builds a context-enriched prompt', () => {
    const prompt = buildAgentContextPrompt(createContext(), 'What should I do today?')
    expect(prompt).toContain('Leg workout')
    expect(prompt).toContain('Remember to stretch')
    expect(prompt).toContain('Leg System')
    expect(prompt).toContain('Squat progression')
    expect(prompt).toContain('If the user asks to change data and the target is ambiguous')
    expect(prompt).toContain('What should I do today?')
  })

  it('parses create commands into typed actions', () => {
    const context = createContext()

    expect(parseBackendAgentAction(RU_CREATE_NOTE)).toEqual({
      action: {
        type: 'create_note',
        payload: {
          body: RU_NOTE_BODY,
        },
      },
    })

    expect(parseBackendAgentAction('create task leg workout today')).toEqual({
      action: {
        type: 'create_task',
        payload: {
          title: 'leg workout today',
        },
      },
    })

    expect(parseBackendAgentAction(RU_CREATE_PROJECT)).toEqual({
      action: {
        type: 'create_x_vexta_project',
        payload: {
          name: 'Morning Plan',
        },
      },
    })

    expect(parseBackendAgentAction('создай заметку в проекте legs: new warmup => do 5 minutes cardio', context)).toEqual({
      action: {
        type: 'create_x_vexta_note',
        payload: {
          projectId: 'project-legs',
          title: 'new warmup',
          summary: 'do 5 minutes cardio',
        },
      },
    })

    expect(parseBackendAgentAction(RU_CREATE_IN_NOTES, context)).toEqual({
      action: {
        type: 'create_x_vexta_note',
        payload: {
          projectId: 'project-legs',
          title: RU_CREATE_IN_NOTES_TEXT,
          summary: RU_CREATE_IN_NOTES_TEXT,
        },
      },
    })
  })

  it('parses note edit commands into typed actions', () => {
    const context = createContext()

    expect(parseBackendAgentAction(RU_APPEND_EXPLICIT, context)).toEqual({
      action: {
        type: 'append_x_vexta_blocks',
        payload: {
          noteId: 'note-legs-1',
          blocks: [{ type: 'text', content: RU_APPEND_EXPLICIT_TEXT }],
        },
      },
    })

    expect(parseBackendAgentAction(RU_REPLACE_EXPLICIT, context)).toEqual({
      action: {
        type: 'update_x_vexta_note',
        payload: {
          noteId: 'note-legs-1',
          changes: {
            summary: RU_REPLACE_EXPLICIT_TEXT,
            blocks: [{ type: 'text', content: RU_REPLACE_EXPLICIT_TEXT }],
          },
        },
      },
    })

    expect(parseBackendAgentAction(RU_APPEND_IMPLICIT, context)).toEqual({
      action: {
        type: 'append_x_vexta_blocks',
        payload: {
          noteId: 'note-111',
          blocks: [{ type: 'text', content: RU_APPEND_IMPLICIT_TEXT }],
        },
      },
    })

    expect(parseBackendAgentAction(RU_NATURAL_REPLACE, context)).toEqual({
      action: {
        type: 'update_x_vexta_note',
        payload: {
          noteId: 'note-111',
          changes: {
            summary: RU_NATURAL_REPLACE_TEXT,
            blocks: [{ type: 'text', content: RU_NATURAL_REPLACE_TEXT }],
          },
        },
      },
    })
  })

  it('parses and resolves structured tool calls', () => {
    const context = createContext()
    const decision = parseAgentToolDecision(
      '{"mode":"tool","tool":"update_x_vexta_note","arguments":{"noteTitle":"\\u043e\\u0434\\u0438\\u043d \\u043e\\u0434\\u0438\\u043d \\u043e\\u0434\\u0438\\u043d","mode":"replace","summary":"\\u043a\\u043e\\u0440\\u043e\\u0442\\u0435\\u043d\\u044c\\u043a\\u0438\\u0439 \\u0440\\u0430\\u0441\\u0441\\u043a\\u0430\\u0437 \\u043f\\u0440\\u043e \\u0451\\u0436\\u0438\\u043a\\u0430"}}',
    )

    expect(decision).toEqual({
      mode: 'tool',
      tool: 'update_x_vexta_note',
      arguments: {
        noteTitle: 'один один один',
        mode: 'replace',
        summary: 'коротенький рассказ про ёжика',
      },
    })

    expect(resolveAgentToolDecision(decision!, context)).toEqual({
      kind: 'action',
      request: {
        action: {
          type: 'update_x_vexta_note',
          payload: {
            noteId: 'note-111',
            changes: {
              title: undefined,
              summary: 'коротенький рассказ про ёжика',
              status: undefined,
              dueDate: undefined,
              projectId: undefined,
              blocks: [{ type: 'text', content: RU_NATURAL_REPLACE_TEXT }],
            },
          },
        },
      },
      successReply: 'Готово, обновила заметку "111".',
    })
  })

  it('builds a tool-selection prompt with ids and tool schema', () => {
    const prompt = buildAgentToolSelectionPrompt(createContext(), 'измени заметку 111')
    expect(prompt).toContain('"mode":"tool"')
    expect(prompt).toContain('"id": "note-111"')
    expect(prompt).toContain('update_x_vexta_note')
    expect(prompt).toContain('User request: измени заметку 111')
  })

  it('builds an in-band tool prompt that preserves normal chat behavior', () => {
    const prompt = buildAgentToolAwarePrompt(createContext(), 'напиши рецепт блинчиков')
    expect(prompt).toContain('Reply naturally for normal chat requests')
    expect(prompt).toContain('Do not use backend tools for general conversation, writing help, recipes')
    expect(prompt).toContain('structured note blocks')
    expect(prompt).toContain('<friday_tool>')
  })

  it('rejects underspecified note-save tool calls for rich-content requests', () => {
    const decision = parseAgentToolDecision(
      '{"mode":"tool","tool":"create_x_vexta_note","arguments":{"title":"Новости о Кофе","summary":"Последние новости о кофе"}}',
    )

    expect(shouldRefineAgentToolDecision('создай новую заметку про кофе, найди новости из веба и красиво оформи', decision!)).toBe(true)

    const refinementPrompt = buildAgentToolRefinementPrompt(
      'создай новую заметку про кофе, найди новости из веба и красиво оформи',
      decision!,
    )
    expect(refinementPrompt).toContain('underspecified')
    expect(refinementPrompt).toContain('Previous tool call:')
  })

  it('keeps explicit lightweight note saves when the user did not ask for generated content', () => {
    const decision = parseAgentToolDecision(
      '{"mode":"tool","tool":"create_x_vexta_note","arguments":{"title":"Кофе","summary":"арабика"}}',
    )

    expect(shouldRefineAgentToolDecision('создай заметку Кофе', decision!)).toBe(false)
  })

  it('allows substantive news notes to pass refinement', () => {
    const decision = parseAgentToolDecision(
      '{"mode":"tool","tool":"create_x_vexta_note","arguments":{"title":"Новости о видеокартах","blocks":[{"type":"text","content":"# Последние новости о видеокартах"},{"type":"text","content":"На рынке видеокарт сохраняется дефицит HBM-памяти, что влияет на цены и сроки поставок игровых GPU."},{"type":"bulleted-list","content":"Nvidia удерживает фокус на ИИ-ускорителях, из-за чего поставки GeForce остаются ограниченными."},{"type":"bulleted-list","content":"AMD продвигает линейку Radeon RX 9000 и усиливает позиции в среднем сегменте."}]}}',
    )

    expect(
      shouldRefineAgentToolDecision(
        'создай новую заметку, занеси туда последнюю новость о видеокартах и красиво оформи',
        decision!,
      ),
    ).toBe(false)
  })

  it('extracts tool calls from tagged replies and builds final-result prompt', () => {
    const decision = extractAgentToolDecision(
      'before<friday_tool>{"mode":"tool","tool":"update_x_vexta_note","arguments":{"noteTitle":"111","mode":"replace","summary":"test"}}</friday_tool>after',
    )

    expect(decision).toEqual({
      mode: 'tool',
      tool: 'update_x_vexta_note',
      arguments: {
        noteTitle: '111',
        mode: 'replace',
        summary: 'test',
      },
    })

    const prompt = buildAgentToolResultPrompt('измени заметку 111', {
      ok: true,
      tool: 'update_x_vexta_note',
      resultText: 'X Vexta note "111" updated',
      payload: { id: 'note-111' },
    })
    expect(prompt).toContain('Success: yes')
    expect(prompt).toContain('Tool: update_x_vexta_note')
    expect(prompt).toContain('Original user request: измени заметку 111')
    expect(prompt).toContain('Payload:')
  })

  it('resolves semantic block tools for notes', () => {
    const context = createContext()
    const getDecision = parseAgentToolDecision(
      '{"mode":"tool","tool":"get_x_vexta_note","arguments":{"noteTitle":"111"}}',
    )
    expect(resolveAgentToolDecision(getDecision!, context)).toEqual({
      kind: 'action',
      request: {
        action: {
          type: 'get_x_vexta_note',
          payload: {
            noteId: 'note-111',
          },
        },
      },
      successReply: 'Открыла данные заметки "111".',
    })

    const appendDecision = parseAgentToolDecision(
      '{"mode":"tool","tool":"append_x_vexta_blocks","arguments":{"noteTitle":"111","blocks":[{"type":"bulleted-list","content":"milk"},{"type":"table","metadata":{"columns":["Name","Value"],"rows":["milk|2"]}}]}}',
    )
    expect(resolveAgentToolDecision(appendDecision!, context)).toEqual({
      kind: 'action',
      request: {
        action: {
          type: 'append_x_vexta_blocks',
          payload: {
            noteId: 'note-111',
            blocks: [
              {
                type: 'bulleted-list',
                content: 'milk',
                metadata: undefined,
              },
              {
                type: 'table',
                content: undefined,
                metadata: {
                  columns: ['Name', 'Value'],
                  rows: ['milk|2'],
                },
              },
            ],
          },
        },
      },
      successReply: 'Готово, добавила блоки в заметку "111".',
    })
  })

  it('converts rich formatted note text into structured blocks', () => {
    const context = createContext()
    const decision = parseAgentToolDecision(
      '{"mode":"tool","tool":"update_x_vexta_note","arguments":{"noteTitle":"111","mode":"replace","summary":"**Новости BMW**\\n- Электромобили\\n- Neue Klasse\\n1. Проверить релиз"}}',
    )

    expect(resolveAgentToolDecision(decision!, context)).toEqual({
      kind: 'action',
      request: {
        action: {
          type: 'update_x_vexta_note',
          payload: {
            noteId: 'note-111',
            changes: {
              title: undefined,
              summary: '**Новости BMW**\n- Электромобили\n- Neue Klasse\n1. Проверить релиз',
              status: undefined,
              dueDate: undefined,
              projectId: undefined,
              blocks: [
                { type: 'heading-2', content: 'Новости BMW' },
                { type: 'bulleted-list', content: 'Электромобили' },
                { type: 'bulleted-list', content: 'Neue Klasse' },
                { type: 'numbered-list', content: 'Проверить релиз', metadata: { start: 1 } },
              ],
            },
          },
        },
      },
      successReply: 'Готово, обновила заметку "111".',
    })
  })
})
