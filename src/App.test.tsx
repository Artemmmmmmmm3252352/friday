import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AgentUserDataOverview, BackendSessionState, FridayApi, VoiceRuntimeEvent } from '@shared/contracts'
import { createEmptyState } from '@shared/persistence'
import { FridayApp } from './App'

describe('FridayApp', () => {
  it('updates the composer while typing', async () => {
    window.friday = createFridayMock({
      appState: createEmptyState('session-draft'),
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const commandInput = await screen.findByLabelText('Сообщение')
    fireEvent.change(commandInput, { target: { value: 'привет' } })

    expect(commandInput).toHaveValue('привет')
  })

  it('sends a text command and renders the reply', async () => {
    const saveState = vi.fn(async (state) => state)
    const chatSend = vi.fn().mockResolvedValue({
      messageId: 'assistant-1',
      replyText: 'Gateway is online.',
      raw: {},
      durationMs: 1200,
    })

    window.friday = createFridayMock({
      appState: { ...createEmptyState('session-alpha'), draft: 'Check the gateway' },
      saveState,
      chatSend,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const commandInput = await screen.findByLabelText('Сообщение')
    fireEvent.change(commandInput, { target: { value: 'Check the gateway' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))

    expect((await screen.findAllByText('Gateway is online.')).length).toBeGreaterThan(0)
    await waitFor(() => expect(chatSend).toHaveBeenCalled())
    await waitFor(() => expect(saveState).toHaveBeenCalled())
  })

  it('shows confirmation for irreversible agent actions and applies it on approval', async () => {
    const pendingAction = {
      id: 'pending-delete-note',
      label: 'Удалить заметку',
      description: 'Удалить заметку "Черновик"?',
      irreversible: true,
      action: {
        action: {
          type: 'delete_note' as const,
          payload: {
            noteId: 'note-1',
          },
        },
      },
    }
    const chatSend = vi.fn().mockResolvedValue({
      messageId: 'assistant-1',
      replyText: 'Я могу удалить заметку после подтверждения.',
      raw: {},
      durationMs: 300,
      agent: {
        reply: 'Я могу удалить заметку после подтверждения.',
        actions: [],
        confirmationRequired: true,
        confirmationText: pendingAction.description,
        pendingAction,
        entitiesTouched: [{ kind: 'note', id: 'note-1', title: 'Черновик', action: 'delete_note' }],
        latencyMs: 300,
      },
    })
    const friday = createFridayMock({
      appState: { ...createEmptyState('session-confirmation'), draft: 'удали заметку Черновик' },
      chatSend,
    })
    friday.backend.confirmAgentAction = vi.fn().mockResolvedValue({
      type: 'delete_note',
      entityId: 'note-1',
      message: 'Заметка удалена.',
    })
    window.friday = friday

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))

    expect(await screen.findByText('Удалить заметку "Черновик"?')).toBeInTheDocument()
    expect(screen.getByText('Необратимое действие')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }))

    await waitFor(() => expect(friday.backend.confirmAgentAction).toHaveBeenCalledWith({ pendingAction }))
    expect(await screen.findByText(/Заметка удалена/)).toBeInTheDocument()
  })

  it('opens the user data view and renders remembered entries', async () => {
    const friday = createFridayMock()
    const overview = createUserDataOverview()
    overview.context.recentMemories = [
      {
        id: 'memory-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        category: 'people',
        slug: 'artem',
        title: 'Артём',
        summary: 'Любит flat white в Skuratov',
        content: 'Работает в X-VEXTA.',
        tags: ['coffee'],
        aliases: ['Artem'],
        links: ['orgs/x-vexta'],
        metadata: {},
        lastRememberedAt: '2026-04-01T09:00:00.000Z',
        createdAt: '2026-04-01T09:00:00.000Z',
        updatedAt: '2026-04-01T09:00:00.000Z',
      },
    ]
    overview.counts.memories = 1
    friday.backend.getUserDataOverview = vi.fn().mockResolvedValue(overview)
    window.friday = friday

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)


    fireEvent.click(await screen.findByRole('button', { name: 'Данные' }))

    expect(await screen.findByText('Артём')).toBeInTheDocument()
    expect(screen.getByText('Любит flat white в Skuratov')).toBeInTheDocument()
    expect(friday.backend.getUserDataOverview).toHaveBeenCalled()
    expect(friday.backend.listMemories).not.toHaveBeenCalled()
  })

  it('keeps the legacy mail screen out of the visible navigation', async () => {
    const friday = createFridayMock()
    window.friday = friday

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    await screen.findByRole('button', { name: 'Данные' })

    expect(screen.queryByRole('button', { name: /Почта/i })).not.toBeInTheDocument()
    expect(screen.queryByText('boss@example.com')).not.toBeInTheDocument()
    expect(friday.backend.getAgentMailAccount).not.toHaveBeenCalled()
    expect(friday.backend.listAgentMailMessages).not.toHaveBeenCalled()
    expect(friday.backend.listAgentMailContacts).not.toHaveBeenCalled()
  })

  it('handles BeamNG commands locally without sending them to chat', async () => {
    const saveState = vi.fn(async (state) => state)
    const chatSend = vi.fn()
    const resolveBeamngTextCommand = vi.fn().mockResolvedValue({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'traffic' },
    })
    const executeBeamngCommand = vi.fn().mockResolvedValue({
      ok: true,
      command: { type: 'traffic' },
      message: 'BeamNG traffic autopilot is active.',
      state: {
        bridgeStatus: 'ready',
        pythonStatus: 'ready',
        installStatus: 'valid',
        installPath: 'C:\\Games\\BeamNG.drive',
        gameRunning: true,
        connected: true,
        activeMode: 'traffic',
        driveInLane: true,
        lastResolvedPlace: null,
        lastError: null,
        detail: 'BeamNG traffic autopilot is active.',
        vehicleId: 'ego',
      },
    })

    window.friday = createFridayMock({
      appState: { ...createEmptyState('session-beamng'), draft: 'включи автопилот' },
      saveState,
      chatSend,
      resolveBeamngTextCommand,
      executeBeamngCommand,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)
    fireEvent.click(await screen.findByRole('switch', { name: /Игра/i }))

    const commandInput = await screen.findByLabelText(/Сообщение/i)
    fireEvent.change(commandInput, { target: { value: 'включи автопилот' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /Отправить/i })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /Отправить/i }))

    expect((await screen.findAllByText('BeamNG traffic autopilot is active.')).length).toBeGreaterThan(0)
    expect(chatSend).not.toHaveBeenCalled()
    expect(resolveBeamngTextCommand).toHaveBeenCalled()
    expect(executeBeamngCommand).toHaveBeenCalledWith({ type: 'traffic' })
  })

  it('keeps commands in regular chat while game mode is off', async () => {
    const chatSend = vi.fn().mockResolvedValue({
      messageId: 'assistant-chat-1',
      replyText: 'Понял, продолжаем обычный диалог.',
      raw: {},
      durationMs: 100,
    })
    const resolveBeamngTextCommand = vi.fn()

    window.friday = createFridayMock({
      appState: { ...createEmptyState('session-regular-chat'), draft: 'РІРєР»СЋС‡Рё Р°РІС‚РѕРїРёР»РѕС‚' },
      chatSend,
      resolveBeamngTextCommand,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const commandInput = await screen.findByRole('textbox')
    fireEvent.change(commandInput, { target: { value: 'РІРєР»СЋС‡Рё Р°РІС‚РѕРїРёР»РѕС‚' } })
    fireEvent.click(screen.getByRole('button', { name: /Отправить/i }))

    expect((await screen.findAllByText('Понял, продолжаем обычный диалог.')).length).toBeGreaterThan(0)
    expect(resolveBeamngTextCommand).not.toHaveBeenCalled()
    expect(chatSend).toHaveBeenCalled()
  })

  it('toggles game mode from the main footer and routes the next command to BeamNG', async () => {
    const chatSend = vi.fn()
    const saveState = vi.fn(async (state) => state)
    const resolveBeamngTextCommand = vi.fn().mockResolvedValue({
      matched: true,
      isBeamngRelated: true,
      source: 'deterministic',
      command: { type: 'disable' },
    })
    const executeBeamngCommand = vi.fn().mockResolvedValue({
      ok: true,
      command: { type: 'disable' },
      message: 'BeamNG AI is disabled.',
      state: {
        bridgeStatus: 'ready',
        pythonStatus: 'ready',
        installStatus: 'valid',
        installPath: 'C:\\Games\\BeamNG.drive',
        gameRunning: true,
        connected: true,
        activeMode: 'disabled',
        driveInLane: false,
        lastResolvedPlace: null,
        lastError: null,
        detail: 'BeamNG AI is disabled.',
        vehicleId: 'ego',
      },
    })

    window.friday = createFridayMock({
      appState: createEmptyState('session-toggle-game-mode'),
      chatSend,
      saveState,
      resolveBeamngTextCommand,
      executeBeamngCommand,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    fireEvent.click(await screen.findByRole('switch', { name: /Игра/i }))
    await waitFor(() =>
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({ gameMode: true }),
        }),
      ),
    )

    const commandInput = await screen.findByRole('textbox')
    fireEvent.change(commandInput, { target: { value: 'РІС‹РєР»СЋС‡Рё Р°РІС‚РѕРїРёР»РѕС‚' } })
    fireEvent.click(screen.getByRole('button', { name: /Отправить/i }))

    expect((await screen.findAllByText('BeamNG AI is disabled.')).length).toBeGreaterThan(0)
    expect(resolveBeamngTextCommand).toHaveBeenCalled()
    expect(executeBeamngCommand).toHaveBeenCalledWith({ type: 'disable' })
    expect(chatSend).not.toHaveBeenCalled()
  })

  it('installs BeamNG dependencies from settings', async () => {
    const installDependencies = vi.fn().mockResolvedValue({
      ok: true,
      detail: 'BeamNG Python dependencies are installed.',
      state: {
        bridgeStatus: 'ready',
        pythonStatus: 'ready',
        installStatus: 'missing',
        installPath: null,
        gameRunning: false,
        connected: false,
        activeMode: null,
        driveInLane: null,
        lastResolvedPlace: null,
        lastError: null,
        detail: 'BeamNG Python dependencies are installed.',
        vehicleId: null,
      },
    })

    window.friday = createFridayMock({
      appState: createEmptyState('session-beamng-install'),
      installBeamngDependencies: installDependencies,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Главные настройки/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Установить зависимости/i }))

    await waitFor(() => expect(installDependencies).toHaveBeenCalled())
    expect((await screen.findAllByText('BeamNG Python dependencies are installed.')).length).toBeGreaterThan(0)
  })

  it('starts a new session from the sidebar', async () => {
    window.friday = createFridayMock({
      appState: createEmptyState('session-start'),
      newSessionId: 'session-fresh',
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const commandInput = await screen.findByLabelText('Сообщение')
    fireEvent.change(commandInput, { target: { value: 'старый текст' } })
    expect(commandInput).toHaveValue('старый текст')

    fireEvent.click(await screen.findByRole('button', { name: 'Новый чат' }))

    await waitFor(() => expect(window.friday.chat.newSession).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByLabelText('Сообщение')).toHaveValue(''))
  })

  it('schedules delayed local actions without sending them to openclaw', async () => {
    const saveState = vi.fn(async (state) => state)
    const chatSend = vi.fn()
    const scheduleText = vi.fn().mockResolvedValue({
      matched: true,
      replyText: 'Запланировал запуск калькулятора через 2 минуты в 22:41.',
      scheduledFor: '2026-03-14T19:41:00.000Z',
    })

    window.friday = createFridayMock({
      appState: { ...createEmptyState('session-schedule'), draft: 'через 2 минуты запусти калькулятор' },
      saveState,
      chatSend,
      scheduleText,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const commandInput = await screen.findByLabelText('Сообщение')
    fireEvent.change(commandInput, { target: { value: 'через 2 минуты запусти калькулятор' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))

    await waitFor(() => expect(scheduleText).toHaveBeenCalled())
    expect((await screen.findAllByText('Запланировал запуск калькулятора через 2 минуты в 22:41.')).length).toBeGreaterThan(0)
    expect(chatSend).not.toHaveBeenCalled()
  })

  it('schedules delayed file creation without sending it to openclaw chat', async () => {
    const saveState = vi.fn(async (state) => state)
    const chatSend = vi.fn()
    const scheduleText = vi.fn().mockResolvedValue({
      matched: true,
      replyText: 'Запланировал создание файла привет.txt на рабочем столе через 3 минуты в 22:53.',
      scheduledFor: '2026-03-14T19:53:00.000Z',
    })

    window.friday = createFridayMock({
      appState: { ...createEmptyState('session-file-schedule'), draft: 'через 3 минуты создай текстовый файл привет на рабочем столе' },
      saveState,
      chatSend,
      scheduleText,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const commandInput = await screen.findByLabelText('Сообщение')
    fireEvent.change(commandInput, { target: { value: 'через 3 минуты создай текстовый файл привет на рабочем столе' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))

    await waitFor(() => expect(scheduleText).toHaveBeenCalled())
    expect((await screen.findAllByText('Запланировал создание файла привет.txt на рабочем столе через 3 минуты в 22:53.')).length).toBeGreaterThan(0)
    expect(chatSend).not.toHaveBeenCalled()
  })

  it('retries with a fresh remote session when openclaw returns heartbeat noise', async () => {
    const saveState = vi.fn(async (state) => state)
    const chatSend = vi
      .fn()
      .mockResolvedValueOnce({
        messageId: 'assistant-noise',
        replyText: 'HEARTBEAT_OK',
        raw: {},
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        messageId: 'assistant-2',
        replyText: 'Привет! Чем могу помочь?',
        raw: {},
        durationMs: 200,
      })

    window.friday = createFridayMock({
      appState: { ...createEmptyState('session-alpha'), draft: 'привет' },
      saveState,
      chatSend,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const commandInput = await screen.findByLabelText('Сообщение')
    fireEvent.change(commandInput, { target: { value: 'привет' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))

    expect((await screen.findAllByText('Привет! Чем могу помочь?')).length).toBeGreaterThan(0)
    await waitFor(() => expect(chatSend).toHaveBeenCalledTimes(2))
  })

  it('holds the microphone button, transcribes speech, and puts text into the composer', async () => {
    const saveState = vi.fn(async (state) => state)
    const pushAudio = vi.fn().mockResolvedValue({
      transcript: 'голосовая',
    })
    const finishSession = vi.fn().mockResolvedValue({
      transcript: 'голосовая заметка',
    })

    window.friday = createFridayMock({
      appState: createEmptyState('session-voice'),
      saveState,
      pushAudio,
      finishSession,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    const micButton = await screen.findByLabelText('Голосовой ввод')
    fireEvent.pointerDown(micButton, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(micButton, { button: 0, pointerId: 1 })

    const commandInput = await screen.findByLabelText('Сообщение')
    await waitFor(() => expect(pushAudio).toHaveBeenCalled())
    await waitFor(() => expect(finishSession).toHaveBeenCalled())
    await waitFor(() => expect(commandInput).toHaveValue('голосовая заметка'))
  })

  it('shows only dark and light themes and hides the managed AI key from settings', async () => {
    window.friday = createFridayMock({
      appState: createEmptyState('session-settings'),
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Главные настройки/i }))

    expect(screen.getByRole('button', { name: 'Темная' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Светлая' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Графит' })).not.toBeInTheDocument()

    expect(screen.getByText('NVIDIA_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('nvidia/mistralai/mistral-large-3-675b-instruct-2512')).toBeInTheDocument()
    expect(screen.queryByLabelText('Значение ключа')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Сохранить ключ' })).not.toBeInTheDocument()
  })

  it('shows the agent capability reference from settings', async () => {
    window.friday = createFridayMock({
      appState: createEmptyState('session-agent-capabilities'),
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Главные настройки/i }))

    expect(screen.getByText('Функционал агента')).toBeInTheDocument()
    expect(screen.queryByText('Локально на компьютере')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Показать функционал' }))

    expect(screen.getByText('Локально на компьютере')).toBeInTheDocument()
    expect(screen.getAllByText('Данные Экосистемы').length).toBeGreaterThan(0)
    expect(screen.getByText('Ограничения и подтверждения')).toBeInTheDocument()
    expect(screen.getByText(/Открывает приложения Windows/i)).toBeInTheDocument()
  })

  it('shows Telegram remote settings and creates a pair code', async () => {
    const createPairCode = vi.fn().mockResolvedValue({
      code: '123456',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })
    const getState = vi.fn().mockResolvedValue({
      enabled: false,
      running: false,
      linkedUsers: [],
      lastUpdateAt: null,
      lastError: null,
      pairCode: '123456',
      pairCodeExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    })

    window.friday = {
      ...createFridayMock({
        appState: createEmptyState('session-telegram-settings'),
      }),
      telegram: {
        ...createFridayMock().telegram,
        getState,
        createPairCode,
      },
    }

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Главные настройки/i }))

    expect(screen.getByText('Telegram remote')).toBeInTheDocument()
    expect(screen.getByText(/обычный текст агенту/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: '123:token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать код привязки' }))

    await waitFor(() => expect(createPairCode).toHaveBeenCalled())
    expect(await screen.findByText(/\/pair 123456/i)).toBeInTheDocument()
  })

  it('does not expose the managed AI key in settings', async () => {
    window.friday = createFridayMock({
      appState: createEmptyState('session-settings-visibility'),
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Главные настройки/i }))

    expect(screen.getByText('NVIDIA')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('hidden-key')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Показать ключ' })).not.toBeInTheDocument()
  })

  it('shows the ecosystem sign-in screen when no backend session is stored', async () => {
    window.friday = createFridayMock({
      appState: createEmptyState('session-auth'),
      backendSessionState: {
        session: null,
        appToken: null,
        updatedAt: new Date().toISOString(),
      },
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    expect(await screen.findByText('Войдите в аккаунт экосистемы. После входа Пятница будет работать только с данными этого пользователя.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument()
  })

  it('auto-starts ambient voice on boot when voice mode is enabled', async () => {
    const startAmbient = vi.fn().mockResolvedValue({ ok: true })

    window.friday = createFridayMock({
      appState: createEmptyState('session-voice-ambient'),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        ambientEnabled: true,
        wakeWord: 'пятница',
        wakeAliases: ['friday', 'фрайдей', 'пятница', 'пятницу', 'пятница ответь'],
        wakeFuzzyRatio: 0.78,
        hotWindowSeconds: 3,
        sttModel: 'small',
        whisperDevice: 'auto',
        whisperComputeType: 'int8',
        ttsVoice: 'M1',
        ttsLanguage: 'na',
        ttsSpeed: 1.05,
        ollamaUrl: 'http://127.0.0.1:11434',
        intentJudgeModel: '',
      }),
      startAmbient,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    await screen.findByText('Чем могу помочь?')
    await waitFor(() => expect(startAmbient).toHaveBeenCalled())
  })

  it('lets the user enable ambient voice directly from the chat banner', async () => {
    const startAmbient = vi.fn().mockResolvedValue({ ok: true })

    window.friday = createFridayMock({
      appState: createEmptyState('session-voice-banner-toggle'),
      startAmbient,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    await screen.findByText('Чем могу помочь?')
    fireEvent.click(screen.getByRole('button', { name: 'Включить' }))

    await waitFor(() => expect(startAmbient).toHaveBeenCalled())
  })

  it('routes ambient voice queries into chat history and speaks the reply', async () => {
    const chatSend = vi.fn().mockResolvedValue({
      messageId: 'assistant-voice-1',
      replyText: 'Привет, я слушаю.',
      raw: {},
      durationMs: 120,
    })
    const speak = vi.fn().mockResolvedValue({ ok: true })
    let runtimeCallback: ((event: VoiceRuntimeEvent) => void) | null = null

    window.friday = createFridayMock({
      appState: createEmptyState('session-voice-query'),
      chatSend,
      speak,
      onRuntimeEvent: vi.fn((callback) => {
        runtimeCallback = callback
        return () => undefined
      }),
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)
    await screen.findByText('Чем могу помочь?')

    expect(runtimeCallback).not.toBeNull()
    runtimeCallback!({
      event: 'query',
      timestamp: Date.now() / 1000,
      text: 'Пятница, привет',
      query: 'привет',
      directed: true,
      stop: false,
      confidence: 0.99,
      reasoning: 'wake word matched',
      hotWindow: false,
    })

    await waitFor(() => expect(screen.getAllByText('привет').length).toBeGreaterThan(0))
    expect(await screen.findByText('Привет, я слушаю.')).toBeInTheDocument()
    await waitFor(() => expect(chatSend).toHaveBeenCalledWith(expect.objectContaining({ text: 'привет' })))
    await waitFor(() => expect(speak).toHaveBeenCalledWith({ text: 'Привет, я слушаю.', interrupt: true }))
  })

  it('keeps the voice reply in chat even if TTS fails', async () => {
    const chatSend = vi.fn().mockResolvedValue({
      messageId: 'assistant-voice-2',
      replyText: 'Ответ текстом уже готов.',
      raw: {},
      durationMs: 120,
    })
    const speak = vi.fn().mockRejectedValue(new Error('Supertonic is unavailable'))
    let runtimeCallback: ((event: VoiceRuntimeEvent) => void) | null = null

    window.friday = createFridayMock({
      appState: createEmptyState('session-voice-query-tts-error'),
      chatSend,
      speak,
      onRuntimeEvent: vi.fn((callback) => {
        runtimeCallback = callback
        return () => undefined
      }),
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)
    await screen.findByText('Чем могу помочь?')

    runtimeCallback!({
      event: 'query',
      timestamp: Date.now() / 1000,
      text: 'Пятница, ответь',
      query: 'ответь',
      directed: true,
      stop: false,
      confidence: 0.99,
      reasoning: 'wake word matched',
      hotWindow: false,
    })

    expect(await screen.findByText('Ответ текстом уже готов.')).toBeInTheDocument()
    await waitFor(() => expect(speak).toHaveBeenCalled())
  })

  it('shows live ambient voice status and logs wake detection to the chat feed', async () => {
    let runtimeCallback: ((event: VoiceRuntimeEvent) => void) | null = null

    window.friday = createFridayMock({
      appState: createEmptyState('session-voice-wake'),
      getRuntimeConfig: vi.fn().mockResolvedValue({
        ambientEnabled: true,
        wakeWord: 'пятница',
        wakeAliases: ['friday', 'фрайдей', 'пятница', 'пятницу', 'пятница ответь'],
        wakeFuzzyRatio: 0.78,
        hotWindowSeconds: 3,
        sttModel: 'small',
        whisperDevice: 'auto',
        whisperComputeType: 'int8',
        ttsVoice: 'M1',
        ttsLanguage: 'na',
        ttsSpeed: 1.05,
        ollamaUrl: 'http://127.0.0.1:11434',
        intentJudgeModel: '',
      }),
      onRuntimeEvent: vi.fn((callback) => {
        runtimeCallback = callback
        return () => undefined
      }),
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)
    await screen.findByText('Чем могу помочь?')
    expect(await screen.findByText('Голосовой режим')).toBeInTheDocument()

    expect(runtimeCallback).not.toBeNull()
    runtimeCallback!({
      event: 'transcript',
      timestamp: Date.now() / 1000,
      text: 'Пятница привет',
      duringTts: false,
    })
    runtimeCallback!({
      event: 'wake',
      timestamp: Date.now() / 1000,
      text: 'Пятница привет',
      matched: 'пятница',
    })

    expect(await screen.findByText('Пятница привет')).toBeInTheDocument()
    expect(await screen.findByText('Услышала обращение: пятница.')).toBeInTheDocument()
  })

  it('keeps legacy register calls out of the no-login boot path', async () => {
    const register = vi.fn()

    window.friday = createFridayMock({
      appState: createEmptyState('session-auth-register'),
      backendSessionState: {
        session: null,
        appToken: null,
        updatedAt: new Date().toISOString(),
      },
      register,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument()
    expect(register).not.toHaveBeenCalled()
  })

  it('does not show the legacy login switch when the backend has no stored session', async () => {
    const login = vi.fn().mockRejectedValue(new Error('Account not found'))

    window.friday = createFridayMock({
      appState: createEmptyState('session-auth-login-missing-account'),
      backendSessionState: {
        session: null,
        appToken: null,
        updatedAt: new Date().toISOString(),
      },
      login,
    })

    render(<FridayApp recorderFactory={() => fakeRecorder()} />)

    expect(await screen.findByRole('button', { name: 'Войти' })).toBeInTheDocument()
    expect(screen.queryByText('Friday account')).not.toBeInTheDocument()
    expect(login).not.toHaveBeenCalled()
  })
})

function createFridayMock(options?: {
  appState?: ReturnType<typeof createEmptyState>
  newSessionId?: string
  saveState?: ReturnType<typeof vi.fn>
  chatSend?: ReturnType<typeof vi.fn>
  scheduleText?: ReturnType<typeof vi.fn>
  pushAudio?: ReturnType<typeof vi.fn>
  finishSession?: ReturnType<typeof vi.fn>
  getRuntimeConfig?: ReturnType<typeof vi.fn>
  startAmbient?: ReturnType<typeof vi.fn>
  stopAmbient?: ReturnType<typeof vi.fn>
  speak?: ReturnType<typeof vi.fn>
  onRuntimeEvent?: ReturnType<typeof vi.fn>
  backendSessionState?: BackendSessionState
  ensureLocalSession?: ReturnType<typeof vi.fn>
  register?: ReturnType<typeof vi.fn>
  login?: ReturnType<typeof vi.fn>
  resolveBeamngTextCommand?: ReturnType<typeof vi.fn>
  executeBeamngCommand?: ReturnType<typeof vi.fn>
  installBeamngDependencies?: ReturnType<typeof vi.fn>
}) {
  const resolvedOptions = options ?? {}
  const backendSessionState = resolvedOptions.backendSessionState ?? createBackendSessionState()
  const appState = resolvedOptions.appState ?? createEmptyState('session-default')

  return {
    app: {
      getDiagnostics: vi.fn().mockResolvedValue(mockDiagnostics()),
      getSystemSnapshot: vi.fn().mockResolvedValue({
        cpuPercent: 24,
        ramPercent: 43,
        ramUsedGb: 6.8,
        ramTotalGb: 16,
        gpuPercent: 12,
      }),
      getState: vi.fn().mockResolvedValue(appState),
      getAiRuntimeConfig: vi.fn().mockResolvedValue({
        provider: 'nvidia',
        model: 'nvidia/mistralai/mistral-large-3-675b-instruct-2512',
        envVariable: 'NVIDIA_API_KEY',
        managed: true,
        status: 'ready',
        detail: 'NVIDIA NIM is configured by Friday and hidden from the interface.',
      }),
      saveState:
        (resolvedOptions.saveState ??
          vi.fn(async (state) => state)) as unknown as FridayApi['app']['saveState'],
      restartAsAdmin: vi.fn().mockResolvedValue({ ok: true }),
    },
    agentmail: {
      getConfig: vi.fn().mockResolvedValue({
        apiKey: '',
        enabled: true,
        installed: false,
        configPath: 'C:\\Users\\ernes\\.openclaw\\openclaw.json',
      }),
      saveConfig: vi.fn(async (config) => ({
        apiKey: config.apiKey,
        enabled: config.enabled ?? true,
        installed: false,
        configPath: 'C:\\Users\\ernes\\.openclaw\\openclaw.json',
      })),
      installSkill: vi.fn().mockResolvedValue({
        installed: true,
        detail: 'Installed',
      }),
    },
    telegram: {
      getConfig: vi.fn().mockResolvedValue({
        botToken: '',
        enabled: false,
        linkedUsers: [],
      }),
      saveConfig: vi.fn(async (config) => config),
      getState: vi.fn().mockResolvedValue({
        enabled: false,
        running: false,
        linkedUsers: [],
        lastUpdateAt: null,
        lastError: null,
        pairCode: null,
        pairCodeExpiresAt: null,
      }),
      start: vi.fn().mockResolvedValue({
        enabled: true,
        running: true,
        linkedUsers: [],
        lastUpdateAt: null,
        lastError: null,
        pairCode: null,
        pairCodeExpiresAt: null,
      }),
      stop: vi.fn().mockResolvedValue({
        enabled: true,
        running: false,
        linkedUsers: [],
        lastUpdateAt: null,
        lastError: null,
        pairCode: null,
        pairCodeExpiresAt: null,
      }),
      createPairCode: vi.fn().mockResolvedValue({
        code: '123456',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
      removeUser: vi.fn().mockResolvedValue({
        enabled: false,
        running: false,
        linkedUsers: [],
        lastUpdateAt: null,
        lastError: null,
        pairCode: null,
        pairCodeExpiresAt: null,
      }),
    },
    gateway: {
      ensureRunning: vi.fn().mockResolvedValue({ ok: true, url: 'ws://127.0.0.1:18789', managedByApp: true }),
    },
    scheduler: {
      scheduleText:
        resolvedOptions.scheduleText ??
        vi.fn().mockResolvedValue({
          matched: false,
        }),
    },
    chat: {
      newSession: vi.fn().mockResolvedValue({ sessionId: resolvedOptions.newSessionId ?? 'session-next' }),
      sendText:
        resolvedOptions.chatSend ??
        vi.fn().mockResolvedValue({
          messageId: 'assistant-1',
          replyText: 'Ready',
          raw: {},
          durationMs: 100,
        }),
      onProgress: vi.fn(() => () => undefined),
    },
    voice: {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'voice-session-1' }),
      pushAudio:
        resolvedOptions.pushAudio ??
        vi.fn().mockResolvedValue({
          transcript: 'Voice',
        }),
      finishSession:
        resolvedOptions.finishSession ??
        vi.fn().mockResolvedValue({
          transcript: 'Voice command',
        }),
      cancelSession: vi.fn().mockResolvedValue({ ok: true }),
      getRuntimeConfig:
        resolvedOptions.getRuntimeConfig ??
        vi.fn().mockResolvedValue({
          ambientEnabled: false,
          wakeWord: 'пятница',
          wakeAliases: ['friday', 'фрайдей', 'пятница', 'пятницу', 'пятница ответь'],
          wakeFuzzyRatio: 0.78,
          hotWindowSeconds: 3,
          sttModel: 'small',
          whisperDevice: 'auto',
          whisperComputeType: 'int8',
          ttsVoice: 'M1',
          ttsLanguage: 'na',
          ttsSpeed: 1.05,
          ollamaUrl: 'http://127.0.0.1:11434',
          intentJudgeModel: '',
        }),
      saveRuntimeConfig: vi.fn(async (config) => config),
      installRuntime: vi.fn().mockResolvedValue({ ok: true, detail: 'Installed' }),
      startAmbient: resolvedOptions.startAmbient ?? vi.fn().mockResolvedValue({ ok: true }),
      stopAmbient: resolvedOptions.stopAmbient ?? vi.fn().mockResolvedValue({ ok: true }),
      speak: resolvedOptions.speak ?? vi.fn().mockResolvedValue({ ok: true }),
      interrupt: vi.fn().mockResolvedValue({ ok: true }),
      onRuntimeEvent: resolvedOptions.onRuntimeEvent ?? vi.fn(() => () => undefined),
    },
    logs: {
      openOpenClawLog: vi.fn().mockResolvedValue({ ok: true }),
      openFridayLog: vi.fn().mockResolvedValue({ ok: true }),
    },
    window: {
      getState: vi.fn().mockResolvedValue({ isMaximized: false, isFullScreen: false }),
      minimize: vi.fn().mockResolvedValue({ isMaximized: false, isFullScreen: false }),
      toggleMaximize: vi.fn().mockResolvedValue({ isMaximized: true, isFullScreen: false }),
      close: vi.fn().mockResolvedValue({ ok: true }),
    },
    backend: {
      getConfig: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:3010' }),
      saveConfig: vi.fn(async (config) => config),
      getSessionState: vi.fn().mockResolvedValue(backendSessionState),
      saveSessionState: vi.fn(async (state) => state),
      clearSessionState: vi.fn().mockResolvedValue({ session: null, appToken: null, updatedAt: new Date().toISOString() }),
      ensureLocalSession: resolvedOptions.ensureLocalSession ?? vi.fn().mockResolvedValue(backendSessionState),
      register: resolvedOptions.register ?? vi.fn().mockResolvedValue(backendSessionState.session ?? createAuthSession()),
      login: resolvedOptions.login ?? vi.fn().mockResolvedValue(backendSessionState.session ?? createAuthSession()),
      createAppToken: vi.fn(),
      getMe: vi.fn().mockResolvedValue((backendSessionState.session ?? createAuthSession()).user),
      updateSettings: vi.fn(),
      getMessageQuota: vi.fn().mockResolvedValue({
        plan: 'standard',
        limit: 35,
        used: 0,
        remaining: 35,
        unlimited: false,
        periodStart: new Date(0).toISOString(),
        periodEnd: new Date(0).toISOString(),
        resetAt: new Date(0).toISOString(),
        status: 'ready',
      }),
      consumeMessageQuota: vi.fn().mockResolvedValue({
        allowed: true,
        message: 'Сообщение принято.',
        state: {
          plan: 'standard',
          limit: 35,
          used: 1,
          remaining: 34,
          unlimited: false,
          periodStart: new Date(0).toISOString(),
          periodEnd: new Date(0).toISOString(),
          resetAt: new Date(0).toISOString(),
          status: 'ready',
        },
      }),
      getAgentMailAccount: vi.fn().mockResolvedValue(null),
      getAgentMailMessage: vi.fn(async (id) => ({
        id,
        tenantId: 'tenant-1',
        userId: 'user-1',
        accountId: 'mail-account-1',
        folder: 'inbox',
        externalId: null,
        threadId: null,
        fromName: 'AgentMail',
        fromAddress: 'hello@agentmail.to',
        toAddresses: ['agent@example.com'],
        ccAddresses: [],
        subject: 'Inbox message',
        preview: 'Preview',
        bodyText: 'Full body',
        bodyHtml: null,
        isRead: false,
        sentAt: null,
        receivedAt: new Date().toISOString(),
        labels: [],
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      upsertAgentMailAccount: vi.fn(async (input) => ({
        id: 'mail-account-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'agentmail',
        address: input.address,
        displayName: input.displayName ?? 'Friday',
        inboxId: input.inboxId ?? null,
        status: input.status ?? 'disconnected',
        detail: input.detail ?? '',
        lastSyncedAt: null,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      listAgentMailMessages: vi.fn().mockResolvedValue([]),
      listAgentMailContacts: vi.fn().mockResolvedValue([]),
      upsertAgentMailContact: vi.fn(async (input) => ({
        id: input.id ?? 'mail-contact-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        accountId: input.accountId,
        name: input.name,
        email: input.email,
        aliases: input.aliases ?? [],
        notes: input.notes ?? '',
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      deleteAgentMailContact: vi.fn().mockResolvedValue({ ok: true }),
      createAgentMailMessage: vi.fn(async (input) => ({
        id: 'mail-message-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        accountId: input.accountId,
        folder: input.folder,
        externalId: input.externalId ?? null,
        threadId: input.threadId ?? null,
        fromName: input.fromName ?? null,
        fromAddress: input.fromAddress ?? 'agent@example.com',
        toAddresses: input.toAddresses ?? [],
        ccAddresses: input.ccAddresses ?? [],
        subject: input.subject,
        preview: input.preview ?? input.bodyText,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        isRead: input.isRead ?? input.folder !== 'inbox',
        sentAt: input.sentAt ?? new Date().toISOString(),
        receivedAt: input.receivedAt ?? null,
        labels: input.labels ?? [],
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      markAgentMailMessageRead: vi.fn(async (id) => ({
        id,
        tenantId: 'tenant-1',
        userId: 'user-1',
        accountId: 'mail-account-1',
        folder: 'inbox',
        externalId: null,
        threadId: null,
        fromName: 'AgentMail',
        fromAddress: 'hello@agentmail.to',
        toAddresses: ['agent@example.com'],
        ccAddresses: [],
        subject: 'Inbox message',
        preview: 'Preview',
        bodyText: 'Preview',
        bodyHtml: null,
        isRead: true,
        sentAt: null,
        receivedAt: new Date().toISOString(),
        labels: [],
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      listNotes: vi.fn().mockResolvedValue([]),
      createNote: vi.fn(),
      updateNote: vi.fn(),
      deleteNote: vi.fn(),
      listTasks: vi.fn().mockResolvedValue([]),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      deleteTask: vi.fn(),
      listReminders: vi.fn().mockResolvedValue([]),
      createReminder: vi.fn(),
      updateReminder: vi.fn(),
      deleteReminder: vi.fn(),
      listInbox: vi.fn().mockResolvedValue([]),
      markInboxRead: vi.fn(),
      listMemories: vi.fn().mockResolvedValue([]),
      getMemory: vi.fn(),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
      getAgentContext: vi.fn().mockResolvedValue(createAgentContext()),
      getUserDataOverview: vi.fn().mockResolvedValue(createUserDataOverview()),
      syncUserDataNow: vi.fn().mockResolvedValue({
        ok: true,
        snapshot: null,
        state: {
          status: 'ready',
          snapshot: null,
          lastAttemptedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
          nextSyncAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          error: null,
        },
        durationMs: 10,
        error: null,
      }),
      getUserDataSnapshot: vi.fn().mockResolvedValue(null),
      searchUserDataEntities: vi.fn().mockResolvedValue([]),
      getUserDataEntity: vi.fn().mockResolvedValue(null),
      runEcosystemUserDataAction: vi.fn(),
      sendAgentMessage: vi.fn().mockResolvedValue({
        reply: 'Ready',
        actions: [],
        confirmationRequired: false,
        confirmationText: null,
        pendingAction: null,
        entitiesTouched: [],
        latencyMs: 100,
      }),
      confirmAgentAction: vi.fn().mockResolvedValue({ ok: true }),
      runAgentAction: vi.fn(),
    },
    vpn: {
      getConfig: vi.fn().mockResolvedValue({
        mode: 'tun',
        autoConnect: false,
        profileSource: 'catalog',
        locationId: 'usa-new-jersey',
        tunInterfaceName: 'FridayTun',
        mtu: 1500,
        rawProfileJson: '',
      }),
      saveConfig: vi.fn(async (config) => config),
      getState: vi.fn().mockResolvedValue({
        status: 'disconnected',
        enabled: false,
        mode: 'tun',
        detail: 'VPN is turned off.',
        runtimeInstalled: false,
        requiresAdmin: false,
        autoConnect: false,
        profileSource: 'catalog',
        locationId: 'usa-new-jersey',
        tunInterfaceName: 'FridayTun',
        mtu: 1500,
        profileName: 'VPN profile',
        serverAddress: null,
        serverPort: null,
      }),
      listLocations: vi.fn().mockResolvedValue([
        {
          id: 'usa-new-jersey',
          name: 'USA, New Jersey',
          countryCode: 'US',
          city: 'New Jersey',
          profileName: 'VPN profile',
          serverAddress: '45.139.50.23',
          serverPort: 2053,
          rawProfileJson: '',
        },
      ]),
      connect: vi.fn().mockResolvedValue({
        status: 'connected',
        enabled: true,
        mode: 'tun',
        detail: 'VPN connected.',
        runtimeInstalled: true,
        requiresAdmin: false,
        autoConnect: false,
        profileSource: 'catalog',
        locationId: 'usa-new-jersey',
        tunInterfaceName: 'FridayTun',
        mtu: 1500,
        profileName: 'VPN profile',
        serverAddress: '45.139.50.23',
        serverPort: 2053,
      }),
      disconnect: vi.fn().mockResolvedValue({
        status: 'disconnected',
        enabled: false,
        mode: 'tun',
        detail: 'VPN is turned off.',
        runtimeInstalled: true,
        requiresAdmin: false,
        autoConnect: false,
        profileSource: 'catalog',
        locationId: 'usa-new-jersey',
        tunInterfaceName: 'FridayTun',
        mtu: 1500,
        profileName: 'VPN profile',
        serverAddress: '45.139.50.23',
        serverPort: 2053,
      }),
    },
    beamng: {
      getConfig: vi.fn().mockResolvedValue({
        gamePath: '',
        autoLaunch: false,
        defaultVehicleId: 'ego',
        savedPlaces: [],
      }),
      saveConfig: vi.fn(async (config) => config),
      getState: vi.fn().mockResolvedValue({
        bridgeStatus: 'stopped',
        pythonStatus: 'ready',
        installStatus: 'missing',
        installPath: null,
        gameRunning: false,
        connected: false,
        activeMode: null,
        driveInLane: null,
        lastResolvedPlace: null,
        lastError: null,
        detail: 'BeamNG is not configured.',
        vehicleId: null,
      }),
      detectInstalls: vi.fn().mockResolvedValue([]),
      installDependencies:
        resolvedOptions.installBeamngDependencies ??
        vi.fn().mockResolvedValue({
          ok: true,
          detail: 'BeamNG Python dependencies are installed.',
          state: {
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            installStatus: 'missing',
            installPath: null,
            gameRunning: false,
            connected: false,
            activeMode: null,
            driveInLane: null,
            lastResolvedPlace: null,
            lastError: null,
            detail: 'BeamNG Python dependencies are installed.',
            vehicleId: null,
          },
        }),
      connect: vi.fn().mockResolvedValue({
        bridgeStatus: 'ready',
        pythonStatus: 'ready',
        installStatus: 'valid',
        installPath: 'C:\\Games\\BeamNG.drive',
        gameRunning: true,
        connected: true,
        activeMode: 'traffic',
        driveInLane: true,
        lastResolvedPlace: null,
        lastError: null,
        detail: 'Connected to BeamNG.',
        vehicleId: 'ego',
      }),
      disconnect: vi.fn().mockResolvedValue({
        bridgeStatus: 'stopped',
        pythonStatus: 'ready',
        installStatus: 'valid',
        installPath: 'C:\\Games\\BeamNG.drive',
        gameRunning: false,
        connected: false,
        activeMode: null,
        driveInLane: null,
        lastResolvedPlace: null,
        lastError: null,
        detail: 'Disconnected from BeamNG.',
        vehicleId: 'ego',
      }),
      listWaypoints: vi.fn().mockResolvedValue([]),
      resolveTextCommand:
        resolvedOptions.resolveBeamngTextCommand ??
        vi.fn().mockResolvedValue({
          matched: false,
          isBeamngRelated: false,
          source: 'none',
        }),
      executeCommand:
        resolvedOptions.executeBeamngCommand ??
        vi.fn().mockResolvedValue({
          ok: true,
          command: { type: 'traffic' },
          message: 'BeamNG traffic autopilot is active.',
          state: {
            bridgeStatus: 'ready',
            pythonStatus: 'ready',
            installStatus: 'valid',
            installPath: 'C:\\Games\\BeamNG.drive',
            gameRunning: true,
            connected: true,
            activeMode: 'traffic',
            driveInLane: true,
            lastResolvedPlace: null,
            lastError: null,
            detail: 'BeamNG traffic autopilot is active.',
            vehicleId: 'ego',
          },
        }),
    },
  } as FridayApi
}

function createAuthSession() {
  return {
    token: 'usr_test_token',
    tokenType: 'user' as const,
    user: {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'ernest@example.com',
      displayName: 'Ernest',
      avatarUrl: null,
      settings: {
        timezone: 'Europe/Moscow',
        locale: 'ru' as const,
        bedtimeStart: null,
        quietHoursStart: null,
        quietHoursEnd: null,
      },
      createdAt: '2026-03-17T12:00:00.000Z',
      updatedAt: '2026-03-17T12:00:00.000Z',
    },
    expiresAt: null,
  }
}

function createBackendSessionState(): BackendSessionState {
  return {
    session: createAuthSession(),
    appToken: 'ecosystem_test_token',
    updatedAt: new Date().toISOString(),
  }
}

function createAgentContext() {
  return {
    profile: createAuthSession().user,
    todayTasks: [],
    overdueTasks: [],
    activeReminders: [],
    recentNotes: [],
    recentMemories: [],
    mailContacts: [],
    xVextaProjects: [],
    xVextaNotes: [],
    unreadInbox: [],
    derivedSignals: [],
    generatedAt: new Date().toISOString(),
  }
}

function createUserDataOverview(): AgentUserDataOverview {
  const context = createAgentContext()

  return {
    context,
    counts: {
      tasks: 0,
      overdueTasks: 0,
      reminders: 0,
      notes: 0,
      memories: 0,
      inbox: 0,
      xVextaProjects: 0,
      xVextaNotes: 0,
    },
    recommendations: [],
    generatedAt: context.generatedAt,
  }
}

function mockDiagnostics() {
  return {
    openclaw: { label: 'OpenClaw CLI', status: 'ready', detail: 'Installed' },
    gateway: { label: 'Gateway', status: 'ready', detail: 'Running' },
    whisper: { label: 'Whisper', status: 'ready', detail: 'Ready' },
    mic: { label: 'Microphone', status: 'ready', detail: 'Ready' },
  }
}

function fakeRecorder() {
  return {
    start: vi.fn().mockImplementation(async (onChunk?: (samples: Float32Array, sampleRate: number) => void) => {
      onChunk?.(new Float32Array([0.1, 0.2, 0.3]), 16000)
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  }
}


