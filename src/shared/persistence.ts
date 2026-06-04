import type {
  ChatFolderId,
  ChatMessage,
  MessageRole,
  MessageSource,
  PersistedAppState,
  ThemeMode,
  UiPreferences,
} from './contracts'

export function createDefaultPreferences(): UiPreferences {
  return {
    theme: 'dark',
    language: 'ru',
    density: 'comfortable',
    enterToSend: true,
    showTimestamps: true,
    autoRecover: true,
    gameMode: false,
  }
}

export function normalizeTheme(theme: string | undefined): ThemeMode {
  if (theme === 'light') {
    return 'light'
  }

  return 'dark'
}

export function createEmptyState(sessionId: string = crypto.randomUUID()): PersistedAppState {
  return {
    sessionId,
    remoteSessionId: crypto.randomUUID(),
    activeFolderId: 'inbox',
    preferences: createDefaultPreferences(),
    messages: [],
    draft: '',
    lastTranscript: null,
    updatedAt: new Date().toISOString(),
  }
}

export function createMessage(input: {
  sessionId: string
  role: MessageRole
  text: string
  source: MessageSource
  id?: string
  createdAt?: string
}): ChatMessage {
  return {
    id: input.id ?? crypto.randomUUID(),
    sessionId: input.sessionId,
    role: input.role,
    text: input.text,
    source: input.source,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}

export function withDraft(state: PersistedAppState, draft: string): PersistedAppState {
  return {
    ...state,
    draft,
    updatedAt: new Date().toISOString(),
  }
}

export function withLastTranscript(state: PersistedAppState, lastTranscript: string | null): PersistedAppState {
  return {
    ...state,
    lastTranscript,
    updatedAt: new Date().toISOString(),
  }
}

export function withRemoteSessionId(state: PersistedAppState, remoteSessionId: string): PersistedAppState {
  return {
    ...state,
    remoteSessionId,
    updatedAt: new Date().toISOString(),
  }
}

export function withActiveFolderId(state: PersistedAppState, activeFolderId: ChatFolderId): PersistedAppState {
  return {
    ...state,
    activeFolderId,
    updatedAt: new Date().toISOString(),
  }
}

export function withPreferences(state: PersistedAppState, preferences: UiPreferences): PersistedAppState {
  return {
    ...state,
    preferences: {
      ...preferences,
      theme: normalizeTheme(preferences.theme),
    },
    updatedAt: new Date().toISOString(),
  }
}

export function appendMessages(state: PersistedAppState, ...messages: ChatMessage[]): PersistedAppState {
  return {
    ...state,
    messages: [...state.messages, ...messages],
    updatedAt: new Date().toISOString(),
  }
}
