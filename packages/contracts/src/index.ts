export type RequestStatus =
  | 'idle'
  | 'checking_gateway'
  | 'recording'
  | 'transcribing'
  | 'sending'
  | 'completed'
  | 'error'

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageSource = 'text' | 'voice'
export type DiagnosticStatus = 'ready' | 'warning' | 'error' | 'checking' | 'unknown'
export type AgentProgressStatus = 'active' | 'completed' | 'error'
export type AgentProgressStage =
  | 'queued'
  | 'desktop_shortcut'
  | 'gateway'
  | 'sync_context'
  | 'planning'
  | 'tool_recovery'
  | 'finalizing'
  | 'completed'
  | 'error'
export type ThemeMode = 'dark' | 'light'
export type AppLanguage = 'ru' | 'en'
export type UiDensity = 'comfortable' | 'compact'
export type ChatFolderId = 'inbox' | 'workspace' | 'voice' | 'system'
export type VpnMode = 'tun'
export type VpnProfileSource = 'catalog' | 'manual'
export type VpnStatus = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error'
export type BeamngBridgeStatus = 'stopped' | 'starting' | 'ready' | 'error'
export type BeamngPythonStatus = 'ready' | 'missing' | 'error'
export type BeamngInstallStatus = 'missing' | 'invalid' | 'valid'
export type BeamngInstallSource = 'config' | 'env' | 'steam' | 'standard'
export type AgentMailFolder = 'inbox' | 'sent' | 'drafts'
export type AgentMailConnectionStatus = 'disconnected' | 'ready' | 'error'
export type ReminderRecurrence = 'none' | 'daily' | 'weekly'
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'canceled'
export type InboxItemKind = 'reminder' | 'signal'
export type InboxItemStatus = 'unread' | 'read' | 'dismissed'
export type XVextaNoteStatus = 'draft' | 'active' | 'in-review' | 'done'
export type MemoryCategory = 'people' | 'places' | 'games' | 'tech' | 'events' | 'media' | 'ideas' | 'orgs'
export type XVextaBlockType =
  | 'text'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bulleted-list'
  | 'numbered-list'
  | 'todo'
  | 'quote'
  | 'code'
  | 'image'
  | 'table'
  | 'divider'
  | 'callout'
  | 'embed'
export type AgentSignalCode =
  | 'task_due_today'
  | 'task_overdue'
  | 'reminder_due_now'
  | 'bedtime_window_reached'
export type AgentActionType =
  | 'create_note'
  | 'create_task'
  | 'update_task'
  | 'delete_task'
  | 'update_note'
  | 'delete_note'
  | 'create_reminder'
  | 'update_reminder'
  | 'delete_reminder'
  | 'dismiss_inbox_item'
  | 'create_memory'
  | 'update_memory'
  | 'delete_memory'
  | 'get_x_vexta_note'
  | 'create_x_vexta_project'
  | 'update_x_vexta_project'
  | 'create_x_vexta_note'
  | 'update_x_vexta_note'
  | 'append_x_vexta_blocks'

export interface DiagnosticItem {
  label: string
  status: DiagnosticStatus
  detail: string
  path?: string
}

export interface Diagnostics {
  openclaw: DiagnosticItem
  gateway: DiagnosticItem
  whisper: DiagnosticItem
  mic: DiagnosticItem
}

export interface SystemSnapshot {
  cpuPercent: number
  ramPercent: number
  ramUsedGb: number
  ramTotalGb: number
  gpuPercent: number | null
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: MessageRole
  text: string
  createdAt: string
  source: MessageSource
}

export interface UiPreferences {
  theme: ThemeMode
  language: AppLanguage
  density: UiDensity
  enterToSend: boolean
  showTimestamps: boolean
  autoRecover: boolean
  gameMode: boolean
}

export interface PersistedAppState {
  sessionId: string
  remoteSessionId?: string
  activeFolderId: ChatFolderId
  preferences: UiPreferences
  messages: ChatMessage[]
  draft: string
  lastTranscript: string | null
  updatedAt: string
}

export interface AiRuntimeConfig {
  provider: 'nvidia' | 'groq'
  model: string
  envVariable: 'NVIDIA_API_KEY' | 'GROQ_API_KEY'
  managed: boolean
  status: DiagnosticStatus
  detail: string
}

export type SubscriptionPlan = 'standard' | 'pro' | 'early' | 'unknown'
export type MessageQuotaRoute = 'desktop_chat' | 'telegram_chat'

export interface MessageQuotaState {
  plan: SubscriptionPlan
  limit: number | null
  used: number
  remaining: number | null
  unlimited: boolean
  periodStart: string
  periodEnd: string
  resetAt: string
  status: 'ready' | 'exceeded' | 'unknown'
}

export interface MessageQuotaConsumeInput {
  route: MessageQuotaRoute
}

export interface MessageQuotaConsumeResult {
  allowed: boolean
  state: MessageQuotaState
  message: string
}

export interface AgentMailConfigState {
  apiKey: string
  enabled: boolean
  installed: boolean
  configPath: string
}

export interface AgentMailConfigInput {
  apiKey: string
  enabled?: boolean
}

export interface AgentMailInstallResult {
  installed: boolean
  detail: string
}

export interface TelegramLinkedUser {
  id: number
  username?: string
  firstName?: string
  lastName?: string
  linkedAt: string
  lastSeenAt?: string
}

export interface TelegramRemoteConfig {
  botToken: string
  enabled: boolean
  linkedUsers: TelegramLinkedUser[]
}

export interface TelegramRemoteState {
  enabled: boolean
  running: boolean
  linkedUsers: TelegramLinkedUser[]
  lastUpdateAt: string | null
  lastError: string | null
  pairCode: string | null
  pairCodeExpiresAt: string | null
}

export interface TelegramPairCode {
  code: string
  expiresAt: string
}

export interface SendTextInput {
  sessionId: string
  text: string
  requestId?: string
}

export interface AgentProgressEvent {
  requestId: string
  sessionId: string
  stage: AgentProgressStage
  status: AgentProgressStatus
  label: string
  detail?: string
  progress: number
  at: string
}

export interface ScheduleTextInput {
  text: string
  language: AppLanguage
}

export interface ScheduleTextResult {
  matched: boolean
  replyText?: string
  scheduledFor?: string
}

export interface SendTextResult {
  messageId: string
  replyText: string
  raw: unknown
  durationMs: number
  agent?: AgentMessageEnvelope
}

export interface EnsureGatewayResult {
  ok: boolean
  url: string
  managedByApp: boolean
}

export interface VoiceSessionStartResult {
  sessionId: string
}

export interface VoicePushAudioInput {
  sessionId: string
  samples: Float32Array
  sampleRate: number
}

export interface VoicePushAudioResult {
  transcript: string
}

export interface VoiceFinishSessionInput {
  sessionId: string
}

export interface VoiceFinishSessionResult {
  transcript: string
}

export interface VoiceCancelSessionInput {
  sessionId: string
}

export interface VoiceTranscribeResult {
  transcript: string
}

export interface VoiceRuntimeConfig {
  ambientEnabled: boolean
  wakeWord: string
  wakeAliases: string[]
  wakeFuzzyRatio: number
  hotWindowSeconds: number
  sttModel: string
  whisperDevice: string
  whisperComputeType: string
  ttsVoice: string
  ttsLanguage: string
  ttsSpeed: number
  ollamaUrl: string
  intentJudgeModel: string
}

export type VoiceRuntimeEvent =
  | { event: 'ready'; timestamp: number; detail?: string }
  | { event: 'diagnostics'; timestamp: number; status: DiagnosticStatus; detail: string }
  | { event: 'listening'; timestamp: number; detail?: string }
  | { event: 'audio-level'; timestamp: number; level: number; speech?: boolean }
  | { event: 'speech-start'; timestamp: number; energy?: number }
  | { event: 'speech-end'; timestamp: number; durationMs?: number }
  | { event: 'transcript'; timestamp: number; text: string; duringTts?: boolean; echo?: boolean }
  | { event: 'wake'; timestamp: number; text: string; matched?: string }
  | {
      event: 'query'
      timestamp: number
      text: string
      query: string
      directed: boolean
      stop: boolean
      confidence: number
      reasoning: string
      hotWindow: boolean
    }
  | { event: 'tts-start'; timestamp: number; text?: string }
  | { event: 'tts-end'; timestamp: number; text?: string; interrupted?: boolean }
  | { event: 'error'; timestamp: number; detail: string }

export interface VoiceSpeakInput {
  text: string
  interrupt?: boolean
}

export interface DesktopWindowState {
  isMaximized: boolean
  isFullScreen: boolean
}

export interface TenantScopedEntity {
  id: string
  tenantId: string
  createdAt: string
  updatedAt: string
}

export interface UserSettings {
  timezone: string
  locale: AppLanguage
  bedtimeStart: string | null
  quietHoursStart: string | null
  quietHoursEnd: string | null
}

export interface UserProfile {
  id: string
  tenantId: string
  email: string
  displayName: string
  avatarUrl: string | null
  settings: UserSettings
  createdAt: string
  updatedAt: string
}

export interface AgentMailAccount extends TenantScopedEntity {
  userId: string
  provider: 'agentmail'
  address: string
  displayName: string
  inboxId: string | null
  status: AgentMailConnectionStatus
  detail: string
  lastSyncedAt: string | null
  metadata: Record<string, unknown>
}

export interface AgentMailMessage extends TenantScopedEntity {
  userId: string
  accountId: string
  folder: AgentMailFolder
  externalId: string | null
  threadId: string | null
  fromName: string | null
  fromAddress: string
  toAddresses: string[]
  ccAddresses: string[]
  subject: string
  preview: string
  bodyText: string
  bodyHtml: string | null
  isRead: boolean
  sentAt: string | null
  receivedAt: string | null
  labels: string[]
  metadata: Record<string, unknown>
}

export interface AgentMailContact extends TenantScopedEntity {
  userId: string
  accountId: string
  name: string
  email: string
  aliases: string[]
  notes: string
  metadata: Record<string, unknown>
}

export interface GetAgentMailMessageInput {
  hydrateRemote?: boolean
}

export interface Note extends TenantScopedEntity {
  userId: string
  title: string | null
  body: string
  isPinned: boolean
  isArchived: boolean
}

export interface Task extends TenantScopedEntity {
  userId: string
  title: string
  description: string | null
  status: TaskStatus
  dueAt: string | null
  completedAt: string | null
}

export interface Reminder extends TenantScopedEntity {
  userId: string
  title: string
  body: string | null
  scheduledAt: string
  recurrence: ReminderRecurrence
  timezone: string
  lastTriggeredAt: string | null
}

export interface InboxItem extends TenantScopedEntity {
  userId: string
  kind: InboxItemKind
  status: InboxItemStatus
  title: string
  body: string
  scheduledFor: string | null
  sourceType: string
  sourceId: string | null
  signalCode: AgentSignalCode | null
  dedupeKey: string | null
  readAt: string | null
}

export interface AgentSignal {
  code: AgentSignalCode
  title: string
  body: string
  createdAt: string
  severity: 'info' | 'warning'
}

export interface XVextaProject {
  userId: string
  id: string
  name: string
  code: string
  color: string
  summary: string
  createdAt: string
  updatedAt: string
}

export interface XVextaBlockInput {
  type: XVextaBlockType
  content?: string
  metadata?: Record<string, string | number | boolean | null | string[]>
}

export interface XVextaNote {
  userId: string
  id: string
  projectId: string | null
  title: string
  summary: string
  status: XVextaNoteStatus
  dueDate: string
  tagIds: string[]
  linksTo: string[]
  links: unknown[]
  attachments: unknown[]
  blocks: unknown[]
  createdAt: string
  updatedAt: string
}

export interface AgentContext {
  profile: UserProfile
  todayTasks: Task[]
  overdueTasks: Task[]
  activeReminders: Reminder[]
  recentNotes: Note[]
  recentMemories: MemoryEntry[]
  mailContacts: AgentMailContact[]
  xVextaProjects: XVextaProject[]
  xVextaNotes: XVextaNote[]
  unreadInbox: InboxItem[]
  derivedSignals: AgentSignal[]
  generatedAt: string
}

export type EcosystemEntityKind =
  | 'profile'
  | 'note'
  | 'task'
  | 'reminder'
  | 'inbox'
  | 'memory'
  | 'document'
  | 'project'
  | 'workout'
  | 'calendar_event'
  | 'goal'
  | 'habit'
  | 'finance_record'
  | 'content_plan_item'
  | 'crm_contact'
  | 'crm_deal'
  | 'form_entry'
  | 'knowledge_base_item'
  | 'template'
  | 'x_vexta_project'
  | 'x_vexta_note'

export interface AgentTouchedEntity {
  kind: EcosystemEntityKind | string
  id: string
  title?: string | null
  action?: AgentActionType | string
}

export interface AgentPendingAction {
  id: string
  label: string
  description: string
  irreversible: boolean
  action?: AgentActionRequest
  raw?: unknown
}

export interface AgentMessageInput {
  sessionId: string
  text: string
  latencyMode?: 'fast' | 'balanced' | 'deep'
  confirmationPolicy?: 'auto_except_delete'
}

export interface AgentMessageEnvelope {
  reply: string
  actions: unknown[]
  confirmationRequired: boolean
  confirmationText: string | null
  pendingAction: AgentPendingAction | null
  entitiesTouched: AgentTouchedEntity[]
  latencyMs: number
  toolTrace?: unknown
  debugMeta?: Record<string, unknown>
  raw?: unknown
}

export interface AgentConfirmationInput {
  pendingAction: AgentPendingAction
}

export interface AgentUserDataOverview {
  context: AgentContext
  counts: {
    tasks: number
    overdueTasks: number
    reminders: number
    notes: number
    memories: number
    inbox: number
    xVextaProjects: number
    xVextaNotes: number
  }
  recommendations: AgentSignal[]
  generatedAt: string
}

export interface EcosystemUserDataEntities {
  notes: Note[]
  tasks: Task[]
  reminders: Reminder[]
  inbox: InboxItem[]
  memory: MemoryEntry[]
  documents: AgentUserDataEntitySummary[]
  projects: AgentUserDataEntitySummary[]
  workouts: AgentUserDataEntitySummary[]
  calendarEvents: AgentUserDataEntitySummary[]
  goals: AgentUserDataEntitySummary[]
  habits: AgentUserDataEntitySummary[]
  financeRecords: AgentUserDataEntitySummary[]
  contentPlanItems: AgentUserDataEntitySummary[]
  crmContacts: AgentUserDataEntitySummary[]
  crmDeals: AgentUserDataEntitySummary[]
  formEntries: AgentUserDataEntitySummary[]
  knowledgeBaseItems: AgentUserDataEntitySummary[]
  templates: AgentUserDataEntitySummary[]
  xVextaProjects: XVextaProject[]
  xVextaNotes: XVextaNote[]
}

export interface EcosystemUserDataCounts {
  total: number
  notes: number
  tasks: number
  overdueTasks: number
  reminders: number
  inbox: number
  memory: number
  documents: number
  projects: number
  workouts: number
  calendarEvents: number
  goals: number
  habits: number
  financeRecords: number
  contentPlanItems: number
  crmContacts: number
  crmDeals: number
  formEntries: number
  knowledgeBaseItems: number
  templates: number
  xVextaProjects: number
  xVextaNotes: number
}

export interface EcosystemUserDataSnapshot {
  profile: UserProfile
  entities: EcosystemUserDataEntities
  counts: EcosystemUserDataCounts
  recommendations: AgentSignal[]
  generatedAt: string
  source: 'ecosystem' | 'local-backend' | 'agent-message-fallback' | 'cache' | 'empty'
  syncRevision: string
  errors: string[]
}

export interface EcosystemSyncState {
  status: 'idle' | 'syncing' | 'ready' | 'stale' | 'error'
  snapshot: EcosystemUserDataSnapshot | null
  lastAttemptedAt: string | null
  lastSyncedAt: string | null
  nextSyncAt: string | null
  error: string | null
}

export interface EcosystemSyncResult {
  ok: boolean
  snapshot: EcosystemUserDataSnapshot | null
  state: EcosystemSyncState
  durationMs: number
  error?: string | null
}

export interface EcosystemUserDataActionRequest {
  action: AgentActionRequest['action']
  confirmed?: boolean
  confirmationId?: string | null
  clientMutationId?: string
}

export interface EcosystemUserDataActionResult {
  ok: boolean
  confirmationRequired: boolean
  confirmationText: string | null
  pendingAction: AgentPendingAction | null
  result: AgentActionResult | null
  entityId: string | null
  message: string
  snapshot?: EcosystemUserDataSnapshot | null
  raw?: unknown
}

export interface AgentUserDataSearchInput {
  query?: string
  kinds?: Array<EcosystemEntityKind | string>
  limit?: number
}

export interface AgentEntityReference {
  kind: EcosystemEntityKind | string
  id: string
}

export interface AgentUserDataEntitySummary extends AgentEntityReference {
  title: string
  summary?: string
  detail?: string
  updatedAt?: string
  raw?: unknown
}

export interface AuthSession {
  token: string
  tokenType: 'user' | 'app'
  user: UserProfile
  expiresAt: string | null
}

export interface BackendConfig {
  baseUrl: string
}

export interface BackendSessionState {
  session: AuthSession | null
  appToken: string | null
  appRefreshToken?: string | null
  subscriptionPlan?: SubscriptionPlan
  updatedAt: string
}

export interface LocalSessionInput {
  displayName?: string
  timezone: string
  locale: AppLanguage
}

export interface VpnConfig {
  mode: VpnMode
  autoConnect: boolean
  profileSource: VpnProfileSource
  locationId: string
  tunInterfaceName: string
  mtu: number
  rawProfileJson: string
}

export interface VpnLocation {
  id: string
  name: string
  countryCode: string
  city: string
  profileName: string
  serverAddress: string | null
  serverPort: number | null
  rawProfileJson: string
}

export interface VpnState {
  status: VpnStatus
  enabled: boolean
  mode: VpnMode
  detail: string
  requiresAdmin: boolean
  runtimeInstalled: boolean
  connectedAt: string | null
  lastError: string | null
  profileName: string
  locationId: string
  serverAddress: string | null
  serverPort: number | null
}

export interface BeamngSavedPlace {
  id: string
  name: string
  waypointId: string
  aliases: string[]
}

export interface BeamngConfig {
  gamePath: string
  autoLaunch: boolean
  defaultVehicleId: string
  savedPlaces: BeamngSavedPlace[]
}

export interface BeamngDetectedInstall {
  source: BeamngInstallSource
  path: string
  exePath: string
  valid: boolean
  detail: string
}

export interface BeamngWaypoint {
  id: string
  name: string
}

export interface BeamngState {
  bridgeStatus: BeamngBridgeStatus
  pythonStatus: BeamngPythonStatus
  installStatus: BeamngInstallStatus
  installPath: string | null
  gameRunning: boolean
  connected: boolean
  activeMode: string | null
  driveInLane: boolean | null
  lastResolvedPlace: string | null
  lastError: string | null
  detail: string
  vehicleId: string | null
}

export type BeamngCommandInput =
  | { type: 'traffic' }
  | { type: 'aggressive_traffic' }
  | { type: 'random' }
  | { type: 'span' }
  | { type: 'stop' }
  | { type: 'disable' }
  | { type: 'lane_on' }
  | { type: 'lane_off' }
  | { type: 'go_to_place'; placeId: string }

export interface BeamngCommandResult {
  ok: boolean
  command: BeamngCommandInput
  message: string
  state: BeamngState
  place?: BeamngSavedPlace
}

export interface BeamngDependencyInstallResult {
  ok: boolean
  detail: string
  state: BeamngState
}

export interface BeamngTextCommandResolution {
  matched: boolean
  isBeamngRelated: boolean
  source: 'none' | 'deterministic' | 'openclaw'
  command?: BeamngCommandInput
  placeId?: string
}

export interface AuthRegisterInput {
  email: string
  password: string
  displayName: string
  timezone: string
  locale: AppLanguage
}

export interface AuthLoginInput {
  email: string
  password: string
}

export interface CreateAppTokenInput {
  name: string
}

export interface CreateNoteInput {
  title?: string | null
  body: string
  isPinned?: boolean
  isArchived?: boolean
}

export interface UpdateNoteInput {
  title?: string | null
  body?: string
  isPinned?: boolean
  isArchived?: boolean
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  dueAt?: string | null
}

export interface UpdateTaskInput {
  title?: string
  description?: string | null
  dueAt?: string | null
  status?: TaskStatus
  completedAt?: string | null
}

export interface CreateReminderInput {
  title: string
  body?: string | null
  scheduledAt: string
  recurrence: ReminderRecurrence
  timezone?: string
}

export interface UpdateReminderInput {
  title?: string
  body?: string | null
  scheduledAt?: string
  recurrence?: ReminderRecurrence
  timezone?: string
  lastTriggeredAt?: string | null
}

export interface UpdateSettingsInput {
  timezone?: string
  locale?: AppLanguage
  bedtimeStart?: string | null
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  avatarUrl?: string | null
}

export interface UpsertAgentMailAccountInput {
  address: string
  displayName?: string
  inboxId?: string | null
  status?: AgentMailConnectionStatus
  detail?: string
  metadata?: Record<string, unknown>
}

export interface ListAgentMailMessagesInput {
  folder?: AgentMailFolder
}

export interface CreateAgentMailMessageInput {
  accountId: string
  folder: AgentMailFolder
  externalId?: string | null
  threadId?: string | null
  fromName?: string | null
  fromAddress?: string
  toAddresses?: string[]
  ccAddresses?: string[]
  subject: string
  bodyText: string
  bodyHtml?: string | null
  preview?: string
  isRead?: boolean
  sentAt?: string | null
  receivedAt?: string | null
  labels?: string[]
  metadata?: Record<string, unknown>
}

export interface ListAgentMailContactsInput {
  query?: string
}

export interface UpsertAgentMailContactInput {
  id?: string
  accountId: string
  name: string
  email: string
  aliases?: string[]
  notes?: string
  metadata?: Record<string, unknown>
}

export interface MemoryEntry extends TenantScopedEntity {
  userId: string
  category: MemoryCategory
  slug: string
  title: string
  summary: string
  content: string
  tags: string[]
  aliases: string[]
  links: string[]
  metadata: Record<string, unknown>
  lastRememberedAt: string | null
}

export interface CreateMemoryInput {
  category: MemoryCategory
  title: string
  slug?: string
  summary?: string
  content?: string
  tags?: string[]
  aliases?: string[]
  links?: string[]
  metadata?: Record<string, unknown>
  lastRememberedAt?: string | null
}

export interface UpdateMemoryInput {
  category?: MemoryCategory
  title?: string
  slug?: string
  summary?: string
  content?: string
  tags?: string[]
  aliases?: string[]
  links?: string[]
  metadata?: Record<string, unknown>
  lastRememberedAt?: string | null
}

export interface CreateXVextaProjectInput {
  name: string
  code?: string
  color?: string
  summary?: string
}

export interface UpdateXVextaProjectInput {
  name?: string
  code?: string
  color?: string
  summary?: string
}

export interface CreateXVextaNoteInput {
  title: string
  summary?: string
  projectId?: string | null
  status?: XVextaNoteStatus
  dueDate?: string
  tagIds?: string[]
  linksTo?: string[]
  links?: unknown[]
  attachments?: unknown[]
  blocks?: unknown[]
}

export interface UpdateXVextaNoteInput {
  title?: string
  summary?: string
  projectId?: string | null
  status?: XVextaNoteStatus
  dueDate?: string
  tagIds?: string[]
  linksTo?: string[]
  links?: unknown[]
  attachments?: unknown[]
  blocks?: unknown[]
}

export interface AgentActionRequest {
  action:
    | {
        type: 'create_note'
        payload: CreateNoteInput
      }
    | {
        type: 'create_task'
        payload: CreateTaskInput
      }
    | {
        type: 'update_task'
        payload: {
          taskId: string
          changes: UpdateTaskInput
        }
      }
    | {
        type: 'delete_task'
        payload: {
          taskId: string
        }
      }
    | {
        type: 'update_note'
        payload: {
          noteId: string
          changes: UpdateNoteInput
        }
      }
    | {
        type: 'delete_note'
        payload: {
          noteId: string
        }
      }
    | {
        type: 'create_reminder'
        payload: CreateReminderInput
      }
    | {
        type: 'update_reminder'
        payload: {
          reminderId: string
          changes: UpdateReminderInput
        }
      }
    | {
        type: 'delete_reminder'
        payload: {
          reminderId: string
        }
      }
    | {
        type: 'dismiss_inbox_item'
        payload: {
          inboxItemId: string
        }
      }
    | {
        type: 'create_memory'
        payload: CreateMemoryInput
      }
    | {
        type: 'update_memory'
        payload: {
          memoryId: string
          changes: UpdateMemoryInput
        }
      }
    | {
        type: 'delete_memory'
        payload: {
          memoryId: string
        }
      }
    | {
        type: 'get_x_vexta_note'
        payload: {
          noteId: string
        }
      }
    | {
        type: 'create_x_vexta_project'
        payload: CreateXVextaProjectInput
      }
    | {
        type: 'update_x_vexta_project'
        payload: {
          projectId: string
          changes: UpdateXVextaProjectInput
        }
      }
    | {
        type: 'create_x_vexta_note'
        payload: CreateXVextaNoteInput
      }
    | {
        type: 'update_x_vexta_note'
        payload: {
          noteId: string
          changes: UpdateXVextaNoteInput
        }
      }
    | {
        type: 'append_x_vexta_blocks'
        payload: {
          noteId: string
          blocks: XVextaBlockInput[]
        }
      }
}

export interface AgentActionResult {
  type: AgentActionType
  entityId: string
  message: string
  payload?: unknown
}

export interface FridayApi {
  app: {
    getDiagnostics: () => Promise<Diagnostics>
    getSystemSnapshot: () => Promise<SystemSnapshot>
    getState: () => Promise<PersistedAppState>
    saveState: (state: PersistedAppState) => Promise<PersistedAppState>
    getAiRuntimeConfig: () => Promise<AiRuntimeConfig>
    restartAsAdmin: () => Promise<{ ok: boolean }>
  }
  agentmail: {
    getConfig: () => Promise<AgentMailConfigState>
    saveConfig: (config: AgentMailConfigInput) => Promise<AgentMailConfigState>
    installSkill: () => Promise<AgentMailInstallResult>
  }
  telegram: {
    getConfig: () => Promise<TelegramRemoteConfig>
    saveConfig: (config: TelegramRemoteConfig) => Promise<TelegramRemoteConfig>
    getState: () => Promise<TelegramRemoteState>
    start: () => Promise<TelegramRemoteState>
    stop: () => Promise<TelegramRemoteState>
    createPairCode: () => Promise<TelegramPairCode>
    removeUser: (id: number) => Promise<TelegramRemoteState>
  }
  gateway: {
    ensureRunning: () => Promise<EnsureGatewayResult>
  }
  scheduler: {
    scheduleText: (input: ScheduleTextInput) => Promise<ScheduleTextResult>
  }
  chat: {
    newSession: () => Promise<{ sessionId: string }>
    sendText: (input: SendTextInput) => Promise<SendTextResult>
    onProgress: (callback: (event: AgentProgressEvent) => void) => () => void
  }
  voice: {
    startSession: () => Promise<VoiceSessionStartResult>
    pushAudio: (input: VoicePushAudioInput) => Promise<VoicePushAudioResult>
    finishSession: (input: VoiceFinishSessionInput) => Promise<VoiceFinishSessionResult>
    cancelSession: (input: VoiceCancelSessionInput) => Promise<{ ok: boolean }>
    getRuntimeConfig: () => Promise<VoiceRuntimeConfig>
    saveRuntimeConfig: (config: VoiceRuntimeConfig) => Promise<VoiceRuntimeConfig>
    installRuntime: () => Promise<{ ok: boolean; detail: string }>
    startAmbient: () => Promise<{ ok: boolean }>
    stopAmbient: () => Promise<{ ok: boolean }>
    speak: (input: VoiceSpeakInput) => Promise<{ ok: boolean }>
    interrupt: () => Promise<{ ok: boolean }>
    onRuntimeEvent: (callback: (event: VoiceRuntimeEvent) => void) => () => void
  }
  logs: {
    openOpenClawLog: () => Promise<{ ok: boolean }>
    openFridayLog: () => Promise<{ ok: boolean }>
  }
  vpn: {
    getConfig: () => Promise<VpnConfig>
    saveConfig: (config: VpnConfig) => Promise<VpnConfig>
    getState: () => Promise<VpnState>
    listLocations: () => Promise<VpnLocation[]>
    connect: () => Promise<VpnState>
    disconnect: () => Promise<VpnState>
  }
  beamng: {
    getConfig: () => Promise<BeamngConfig>
    saveConfig: (config: BeamngConfig) => Promise<BeamngConfig>
    getState: () => Promise<BeamngState>
    detectInstalls: () => Promise<BeamngDetectedInstall[]>
    installDependencies: () => Promise<BeamngDependencyInstallResult>
    connect: () => Promise<BeamngState>
    disconnect: () => Promise<BeamngState>
    listWaypoints: () => Promise<BeamngWaypoint[]>
    resolveTextCommand: (input: { text: string; language: AppLanguage }) => Promise<BeamngTextCommandResolution>
    executeCommand: (input: BeamngCommandInput) => Promise<BeamngCommandResult>
  }
  window: {
    getState: () => Promise<DesktopWindowState>
    minimize: () => Promise<DesktopWindowState>
    toggleMaximize: () => Promise<DesktopWindowState>
    close: () => Promise<{ ok: boolean }>
  }
    backend: {
    getConfig: () => Promise<BackendConfig>
    saveConfig: (config: BackendConfig) => Promise<BackendConfig>
    getSessionState: () => Promise<BackendSessionState>
    saveSessionState: (state: BackendSessionState) => Promise<BackendSessionState>
    clearSessionState: () => Promise<BackendSessionState>
    ensureLocalSession: (input: LocalSessionInput) => Promise<BackendSessionState>
    register: (input: AuthRegisterInput) => Promise<AuthSession>
    login: (input: AuthLoginInput) => Promise<AuthSession>
    createAppToken: (input: CreateAppTokenInput) => Promise<{ token: string }>
    getMe: () => Promise<UserProfile>
    updateSettings: (input: UpdateSettingsInput) => Promise<UserProfile>
    getMessageQuota: () => Promise<MessageQuotaState>
    consumeMessageQuota: (input: MessageQuotaConsumeInput) => Promise<MessageQuotaConsumeResult>
      getAgentMailAccount: () => Promise<AgentMailAccount | null>
      getAgentMailMessage: (id: string, input?: GetAgentMailMessageInput) => Promise<AgentMailMessage>
      upsertAgentMailAccount: (input: UpsertAgentMailAccountInput) => Promise<AgentMailAccount>
      listAgentMailMessages: (input?: ListAgentMailMessagesInput) => Promise<AgentMailMessage[]>
      listAgentMailContacts: (input?: ListAgentMailContactsInput) => Promise<AgentMailContact[]>
      upsertAgentMailContact: (input: UpsertAgentMailContactInput) => Promise<AgentMailContact>
      deleteAgentMailContact: (id: string) => Promise<{ ok: boolean }>
    createAgentMailMessage: (input: CreateAgentMailMessageInput) => Promise<AgentMailMessage>
    markAgentMailMessageRead: (id: string) => Promise<AgentMailMessage>
    listNotes: () => Promise<Note[]>
    createNote: (input: CreateNoteInput) => Promise<Note>
    updateNote: (id: string, input: UpdateNoteInput) => Promise<Note>
    deleteNote: (id: string) => Promise<{ ok: boolean }>
    listTasks: () => Promise<Task[]>
    createTask: (input: CreateTaskInput) => Promise<Task>
    updateTask: (id: string, input: UpdateTaskInput) => Promise<Task>
    deleteTask: (id: string) => Promise<{ ok: boolean }>
    listReminders: () => Promise<Reminder[]>
    createReminder: (input: CreateReminderInput) => Promise<Reminder>
    updateReminder: (id: string, input: UpdateReminderInput) => Promise<Reminder>
    deleteReminder: (id: string) => Promise<{ ok: boolean }>
    listInbox: () => Promise<InboxItem[]>
    markInboxRead: (id: string) => Promise<InboxItem>
    listMemories: (query?: string) => Promise<MemoryEntry[]>
    getMemory: (id: string) => Promise<MemoryEntry>
    createMemory: (input: CreateMemoryInput) => Promise<MemoryEntry>
    updateMemory: (id: string, input: UpdateMemoryInput) => Promise<MemoryEntry>
    deleteMemory: (id: string) => Promise<{ ok: boolean }>
    getAgentContext: () => Promise<AgentContext>
    getUserDataOverview: () => Promise<AgentUserDataOverview>
    syncUserDataNow: () => Promise<EcosystemSyncResult>
    getUserDataSnapshot: () => Promise<EcosystemUserDataSnapshot | null>
    searchUserDataEntities: (input?: AgentUserDataSearchInput) => Promise<AgentUserDataEntitySummary[]>
    getUserDataEntity: (input: AgentEntityReference) => Promise<AgentUserDataEntitySummary | null>
    runEcosystemUserDataAction: (input: EcosystemUserDataActionRequest) => Promise<EcosystemUserDataActionResult>
    sendAgentMessage: (input: AgentMessageInput) => Promise<AgentMessageEnvelope>
    runAgentAction: (input: AgentActionRequest) => Promise<AgentActionResult>
    confirmAgentAction: (input: AgentConfirmationInput) => Promise<AgentActionResult>
  }
}

export * from './xVextaRichText'
export * from './xVextaNoteContent'
