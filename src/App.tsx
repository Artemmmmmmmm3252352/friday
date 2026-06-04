import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import './App.css'
import { PushToTalkRecorder, checkMicrophoneSupport, type VoiceRecorder } from './lib/audio'
import type {
  AgentContext,
  AgentActionResult,
  AgentMailConfigState,
  AgentMailAccount,
  AgentMailContact,
  AgentMailFolder,
  AgentMailMessage,
  AgentPendingAction,
  AgentProgressEvent,
  AgentUserDataEntitySummary,
  AgentUserDataOverview,
  AiRuntimeConfig,
  AppLanguage,
  BackendSessionState,
  BeamngConfig,
  BeamngDetectedInstall,
  BeamngState,
  ChatMessage,
  DesktopWindowState,
  Diagnostics,
  DiagnosticItem,
  DiagnosticStatus,
  MemoryEntry,
  MessageQuotaState,
  MessageSource,
  PersistedAppState,
  RequestStatus,
  SystemSnapshot,
  TelegramPairCode,
  TelegramRemoteConfig,
  TelegramRemoteState,
  ThemeMode,
  UiDensity,
  UiPreferences,
  VpnConfig,
  VpnLocation,
  VpnState,
  VoiceRuntimeConfig,
  VoiceRuntimeEvent,
} from '@shared/contracts'
import { createDefaultBeamngConfig } from '@shared/beamng'
import { isUnusableAgentReply } from '@shared/openclaw'
import { isBusy } from '@shared/requestState'
import {
  appendMessages,
  createDefaultPreferences,
  createEmptyState,
  createMessage,
  normalizeTheme,
  withDraft,
  withLastTranscript,
  withPreferences,
  withRemoteSessionId,
} from '@shared/persistence'

type ViewId = 'chat' | 'settings' | 'user-data'
type CopyMap = Record<string, string>

const LEGACY_MAIL_VIEW_ENABLED = import.meta.env.VITE_ENABLE_LEGACY_MAIL === 'true'

interface FridayAppProps {
  recorderFactory?: () => VoiceRecorder
}

interface ActivityLogItem {
  id: string
  label: string
  detail: string
  status: DiagnosticStatus
}

interface SystemMetric {
  id: string
  label: string
  value: string
  progress: number
  tone: 'ready' | 'warning' | 'error'
}

type VisibleMemoryEntry = MemoryEntry & {
  mergedIds: string[]
}

interface AgentProgressState {
  requestId: string
  startedAt: string
  latest: AgentProgressEvent
  events: AgentProgressEvent[]
}

interface UserDataItem {
  id: string
  kind: string
  kindLabel: string
  title: string
  summary: string
  detail: string
  updatedAt: string
  memory?: VisibleMemoryEntry
}

interface UserDataStat {
  label: string
  value: string
}

interface AgentCapabilitySection {
  id: string
  title: string
  tone: 'ready' | 'warning' | 'locked'
  items: string[]
}

const DEFAULT_RECORDER_FACTORY = () => new PushToTalkRecorder()

const DEFAULT_SYSTEM_SNAPSHOT: SystemSnapshot = {
  cpuPercent: 0,
  ramPercent: 0,
  ramUsedGb: 0,
  ramTotalGb: 0,
  gpuPercent: null,
}

const STRINGS = {
  ru: {
    memory: 'Данные',
    mainSettings: 'Главные настройки',
    mainSettingsTitle: 'Главные настройки',
    memoryTitle: 'Данные пользователя',
    memoryBody: 'Профиль, заметки, задачи, напоминания, память и проекты подгружаются с backend Экосистемы.',
    memorySearch: 'Поиск по данным',
    memorySearchPlaceholder: 'Найти заметку, задачу, память, проект или сигнал...',
    memoryEmpty: 'Данные пользователя пока не загружены.',
    memoryNoResults: 'По запросу ничего не найдено.',
    memoryUpdated: 'Обновлено',
    memoryCategory: 'Категория',
    memorySummaryLabel: 'Кратко',
    memoryContentLabel: 'Детали',
    memoryCount: 'Объектов данных',
    mail: 'Почта',
    mailTitle: 'Почта агента',
    mailBody:
      'Здесь отображается отдельный email агента: входящие письма, отправленные сообщения и черновики. Вкладка подготовлена под AgentMail и локально хранит состояние ящика внутри Friday.',
    mailSetupTitle: 'Подключение AgentMail',
    mailSetupBody:
      'Укажите адрес агента и, если он уже создан в AgentMail, добавьте inbox ID. После этого Friday сохранит профиль почты и покажет входящие письма в этой вкладке.',
    mailAddress: 'Email агента',
    mailDisplayName: 'Имя отправителя',
    mailInboxId: 'Inbox ID',
    mailStatus: 'Статус',
    mailLastSync: 'Последняя синхронизация',
    mailFolderInbox: 'Входящие',
    mailFolderSent: 'Отправленные',
    mailFolderDrafts: 'Черновики',
    mailUnread: 'Непрочитанные',
    mailRecipient: 'Кому',
    mailSubject: 'Тема',
    mailMessage: 'Сообщение',
    mailComposerTitle: 'Новое письмо',
    mailComposerBody:
      'Friday может отправлять исходящие письма из этого ящика и показывать входящие. Получение verification-писем поддерживается, обход защит и антибот-проверок не поддерживается.',
    mailEmpty: 'В выбранной папке пока нет писем.',
    mailNoAccount: 'Почта агента ещё не настроена.',
    mailInstallHint: 'Для живой интеграции установите AgentMail skill и добавьте реальный inbox ID.',
    mailSave: 'Сохранить почту',
    mailConnect: 'Подключить',
    mailConnected: 'Подключено',
    mailDisconnected: 'Не подключено',
    mailSendNow: 'Отправить письмо',
    mailMarkRead: 'Прочитать',
    mailOpenMessage: 'Открыть письмо',
    appName: 'FRIDAY',
    appTagline: 'Рабочее пространство',
    chat: 'Чат',
    settings: 'Настройки',
    newChat: 'Новый чат',
    overview: 'Обзор',
    activity: 'Активность',
    agentLabel: 'Агент',
    recoveryLabel: 'Восстановление',
    onlineAgent: 'онлайн',
    attentionState: 'требует внимания',
    checkingState: 'проверка',
    readyState: 'готово',
    lastActivity: 'Последняя активность',
    totalMessages: 'Всего',
    textMessages: 'Текст',
    voiceMessages: 'Голос',
    systemMessages: 'Система',
    send: 'Отправить',
    retry: 'Повторить',
    copyReply: 'Копировать ответ',
    messageLabel: 'Сообщение',
    messagePlaceholder: 'Напишите сообщение Пятнице...',
    voiceInput: 'Голосовой ввод',
    stopVoice: 'Остановить запись',
    holdToTalk: 'Зажмите микрофон и говорите',
    releaseToTranscribe: 'Отпустите, чтобы расшифровать',
    transcriptReady: 'Текст из голоса добавлен в поле ввода.',
    refresh: 'Обновить',
    welcomeTitle: 'Чат готов к работе',
    welcomeBody:
      'Слева только основные разделы. Главный экран сосредоточен на переписке, а настройки вынесены отдельно, чтобы не перегружать чат.',
    suggestionStatus: 'Проверь готовность ассистента и микрофона.',
    suggestionPlan: 'Составь план задач на сегодня.',
    suggestionAction: 'Открой калькулятор.',
    settingsTitle: 'Настройки интерфейса',
    settingsBody:
      'Тема, язык и поведение интерфейса собраны в одном месте. Здесь же можно управлять видом ленты, отправкой по Enter и обработкой нестабильных ответов.',
    theme: 'Тема',
    language: 'Язык',
    density: 'Плотность',
    enterToSend: 'Enter отправляет сообщение',
    showTimestamps: 'Показывать время сообщений',
    autoRecover: 'Умное восстановление ответа',
    dark: 'Темная',
    light: 'Светлая',
    russian: 'Русский',
    english: 'English',
    comfortable: 'Свободно',
    compact: 'Компактно',
    lastTranscript: 'Последняя расшифровка',
    noMessages: 'История появится после первого сообщения.',
    settingsCompactTitle: 'Быстрые настройки',
    diagnosticsCompactTitle: 'Статус компонентов',
    agentCapabilitiesTitle: 'Функционал агента',
    agentCapabilitiesBody:
      'Здесь видно, с чем Пятница умеет взаимодействовать локально, что доступно через данные Экосистемы, и какие действия всегда требуют подтверждения.',
    agentCapabilitiesShow: 'Показать функционал',
    agentCapabilitiesHide: 'Скрыть функционал',
    agentCapabilitiesCollapsedHint: 'Нажмите кнопку, чтобы открыть полный список возможностей и ограничений агента.',
    agentCapabilitiesLocalStatus: 'Локальный агент',
    agentCapabilitiesDataStatus: 'Данные Экосистемы',
    agentCapabilitiesDesktopStatus: 'Windows и файлы',
    agentCapabilitiesSafetyStatus: 'Опасные действия',
    agentCapabilitiesLoginRequired: 'Нужен вход',
    agentCapabilitiesConfirmationOnly: 'Только с подтверждением',
    telegramRemoteTitle: 'Telegram remote',
    telegramRemoteBody:
      'Подключите Telegram-бота, чтобы писать агенту и управлять этим ПК удалённо, пока Friday запущена.',
    telegramRemoteToken: 'Bot Token',
    telegramRemoteShowToken: 'Показать Telegram token',
    telegramRemoteHideToken: 'Скрыть Telegram token',
    telegramRemoteEnabled: 'Включить Telegram remote',
    telegramRemoteStart: 'Запустить бота',
    telegramRemoteStop: 'Остановить бота',
    telegramRemoteSave: 'Сохранить Telegram',
    telegramRemotePair: 'Создать код привязки',
    telegramRemoteUsers: 'Привязанные пользователи',
    telegramRemoteNoUsers: 'Пока нет привязанных Telegram пользователей.',
    telegramRemotePairHint: 'Отправьте боту команду /pair {code}. Код действует 5 минут.',
    telegramRemoteRemoveUser: 'Удалить',
    telegramRemoteStatus: 'Статус',
    telegramRemoteRunning: 'Работает',
    telegramRemoteStopped: 'Остановлен',
    telegramRemoteCapabilities:
      'Команды: обычный текст агенту, /screen, /key enter, /type текст, /open calc, /lock, /shutdown, /restart.',
    appearanceTitle: 'Оформление',
    behaviorTitle: 'Поведение',
    transcriptTitle: 'Голос и история',
    aiKeyTitle: 'ENV ключ ИИ',
    aiKeyBody:
      'Здесь можно поменять активную ENV-переменную и ее значение для модели. После сохранения локальное подключение будет пересоздано на следующем запросе.',
    envVariable: 'ENV переменная',
    envKeyValue: 'Значение ключа',
    showKey: 'Показать ключ',
    hideKey: 'Скрыть ключ',
    saveKey: 'Сохранить ключ',
    keySaved: 'ENV ключ обновлен.',
    agentMailKeyTitle: 'AgentMail',
    agentMailKeyBody:
      'Здесь хранится API-ключ AgentMail для агента Friday. Ключ записывается в конфигурацию локального агента, а официальный skill можно установить прямо отсюда.',
    agentMailKeyValue: 'API ключ AgentMail',
    agentMailSkillState: 'Skill',
    agentMailConfigPath: 'Путь конфига',
    agentMailConfigManaged: 'Локальная конфигурация агента',
    agentMailInstallSkill: 'Установить skill',
    agentMailSaveKey: 'Сохранить AgentMail',
    agentMailInstalled: 'Установлен',
    agentMailNotInstalled: 'Не установлен',
    agentMailReady: 'AgentMail готов',
    agentMailNeedKey: 'Добавьте API-ключ, чтобы включить живую интеграцию.',
    agentMailShowKey: 'Показать ключ AgentMail',
    agentMailHideKey: 'Скрыть ключ AgentMail',
    legalTitle: 'README / FAQ',
    legalBody:
      'FRIDAY является программным продуктом студии X-VEXTA. Все права на интерфейс, логику взаимодействия, сопроводительные материалы и связанные элементы пользовательского опыта защищены применимым законодательством. Ассистент использует вероятностные модели и автоматизированные процедуры, поэтому может ошибаться, давать неполные ответы, предлагать неточные действия, некорректно интерпретировать формулировки или пропускать существенные условия задачи. Пользователь самостоятельно принимает любые решения, проверяет команды, код, тексты, системные изменения, действия с файлами, запуск программ, сетевые запросы и иные результаты работы ассистента. Ни студия X-VEXTA, ни разработчики, ни правообладатели, ни партнеры, ни лица, участвующие в сопровождении продукта, не несут ответственности за прямые или косвенные последствия использования FRIDAY, за потерю данных, финансовые потери, простой, ошибки конфигурации, нарушения политик, некорректные действия в системе, результаты генерации кода, текста или команд, а также за решения, принятые пользователем на основании ответов ассистента. Используя FRIDAY, вы подтверждаете, что действуете по собственной инициативе, оцениваете риски самостоятельно и принимаете на себя полную ответственность за любые действия, выполняемые вручную или с участием автоматизации. Мы ценим open-source экосистему и используем открытый агентный runtime как одну из технологических основ, но итоговый сценарий применения, контроль доступа, проверка результатов и соответствие вашим задачам всегда остаются на стороне пользователя.',
    transcriptEmpty: 'Пока нет голосовых расшифровок.',
    enabled: 'Включено',
    disabled: 'Выключено',
    errorState: 'Ошибка',
    assistantState: 'Ассистент',
    connectionState: 'Подключение',
    voiceState: 'Голос',
    microphoneState: 'Микрофон',
    noReplyToCopy: 'Пока нечего копировать.',
    copyReady: 'Последний ответ скопирован.',
    bridgeError:
      'Сервис ответа вернул служебный ответ вместо сообщения. Подключение обновлено, попробуйте ещё раз.',
    bridgeErrorNoRecovery:
      'Сервис ответа вернул служебный ответ. Включите умное восстановление или начните новый чат.',
    fallbackError: 'Непредвиденная ошибка прервала выполнение команды.',
    updatedNow: 'Только что обновлено',
    activeNow: 'Онлайн',
    ambientVoiceTitle: 'Голосовой режим',
    ambientVoiceIdle: 'Голосовой режим выключен.',
    ambientVoiceListening: 'Слушаю обращение "Пятница".',
    ambientVoiceHearing: 'Слышу речь, распознаю фразу.',
    ambientVoiceWake: 'Услышала обращение, готовлю запрос.',
    ambientVoiceQuery: 'Отправляю голосовой запрос в чат.',
    ambientVoiceSpeaking: 'Озвучиваю ответ.',
    ambientVoiceFollowUp: 'Жду follow-up без повторного wake word.',
    ambientVoiceNoTranscript: 'Пока нет распознанной речи.',
    ambientVoiceWakeLogged: 'Услышала обращение: {wake}.',
    ambientVoiceQueryLogged: 'Голосовой запрос: {query}',
    ambientVoiceEnable: 'Включить',
    ambientVoiceDisable: 'Выключить',
    ambientVoicePrepare: 'Подготовить',
    ambientVoiceBusy: 'Подключаю голосовой режим...',
    gameMode: 'Игра',
    gameModeOn: 'BeamNG режим включён',
    gameModeOff: 'Обычный чат',
    gameModePlaceholder: 'BeamNG.drive: включи автопилот, агрессивный режим, исследуй карту, езжай в <точка>...',
    gameModeNoMatch:
      'Игровой режим включён. Я жду команды для BeamNG.drive: "включи автопилот", "агрессивный режим", "держись полосы", "не держись полосы", "остановись", "выключи автопилот", "исследуй карту", "катайся случайно" или "езжай в <точка>".',
  },
  en: {
    memory: 'Data',
    mainSettings: 'Main settings',
    mainSettingsTitle: 'Main settings',
    memoryTitle: 'User data',
    memoryBody: 'Profile, notes, tasks, reminders, memory, and projects are loaded from the Ecosystem backend.',
    memorySearch: 'Data search',
    memorySearchPlaceholder: 'Search notes, tasks, memories, projects, or signals...',
    memoryEmpty: 'User data has not been loaded yet.',
    memoryNoResults: 'No memory entries match this search.',
    memoryUpdated: 'Updated',
    memoryCategory: 'Category',
    memorySummaryLabel: 'Summary',
    memoryContentLabel: 'Details',
    memoryCount: 'Data objects',
    mail: 'Mail',
    mailTitle: 'Agent mailbox',
    mailBody:
      'This tab shows the agent own email address, inbox, sent mail, and drafts. The UI is prepared for AgentMail and keeps mailbox state inside Friday.',
    mailSetupTitle: 'Connect AgentMail',
    mailSetupBody:
      'Enter the agent email address and, if you already created it in AgentMail, add the inbox ID. Friday will save the mailbox profile and surface incoming mail here.',
    mailAddress: 'Agent email',
    mailDisplayName: 'Sender name',
    mailInboxId: 'Inbox ID',
    mailStatus: 'Status',
    mailLastSync: 'Last sync',
    mailFolderInbox: 'Inbox',
    mailFolderSent: 'Sent',
    mailFolderDrafts: 'Drafts',
    mailUnread: 'Unread',
    mailRecipient: 'Recipient',
    mailSubject: 'Subject',
    mailMessage: 'Message',
    mailComposerTitle: 'New email',
    mailComposerBody:
      'Friday can send outgoing mail from this inbox and display incoming messages here. Receiving verification emails is supported; bypassing protections or anti-bot checks is not.',
    mailEmpty: 'There are no messages in this folder yet.',
    mailNoAccount: 'The agent mailbox is not configured yet.',
    mailInstallHint: 'For live sync, install the AgentMail skill and attach a real inbox ID.',
    mailSave: 'Save mailbox',
    mailConnect: 'Connect',
    mailConnected: 'Connected',
    mailDisconnected: 'Not connected',
    mailSendNow: 'Send email',
    mailMarkRead: 'Mark read',
    mailOpenMessage: 'Open message',
    appName: 'FRIDAY',
    appTagline: 'Workspace',
    chat: 'Chat',
    settings: 'Settings',
    newChat: 'New chat',
    overview: 'Overview',
    activity: 'Activity',
    agentLabel: 'Agent',
    recoveryLabel: 'Recovery',
    onlineAgent: 'online',
    attentionState: 'needs attention',
    checkingState: 'checking',
    readyState: 'ready',
    lastActivity: 'Last activity',
    totalMessages: 'Total',
    textMessages: 'Text',
    voiceMessages: 'Voice',
    systemMessages: 'System',
    send: 'Send',
    retry: 'Retry',
    copyReply: 'Copy reply',
    messageLabel: 'Message',
    messagePlaceholder: 'Ask Friday something...',
    voiceInput: 'Voice input',
    stopVoice: 'Stop recording',
    holdToTalk: 'Hold the mic and speak',
    releaseToTranscribe: 'Release to transcribe',
    transcriptReady: 'Voice text was added to the composer.',
    refresh: 'Refresh',
    welcomeTitle: 'Chat is ready',
    welcomeBody:
      'The main menu stays intentionally small. The main screen focuses on conversation, while settings live in a separate panel instead of crowding the chat.',
    suggestionStatus: 'Check assistant and microphone readiness.',
    suggestionPlan: 'Draft today plan.',
    suggestionAction: 'Open calculator.',
    settingsTitle: 'Interface settings',
    settingsBody:
      'Theme, language, and behavior controls live in one place. You can also manage timestamps, Enter-to-send, and recovery for unstable replies.',
    theme: 'Theme',
    language: 'Language',
    density: 'Density',
    enterToSend: 'Enter sends message',
    showTimestamps: 'Show timestamps',
    autoRecover: 'Smart reply recovery',
    dark: 'Dark',
    light: 'Light',
    russian: 'Russian',
    english: 'English',
    comfortable: 'Comfortable',
    compact: 'Compact',
    lastTranscript: 'Last transcript',
    noMessages: 'History will appear after the first message.',
    settingsCompactTitle: 'Quick controls',
    diagnosticsCompactTitle: 'Component status',
    agentCapabilitiesTitle: 'Agent capabilities',
    agentCapabilitiesBody:
      'See what Friday can interact with locally, what is available through Ecosystem data, and which actions always require confirmation.',
    agentCapabilitiesShow: 'Show capabilities',
    agentCapabilitiesHide: 'Hide capabilities',
    agentCapabilitiesCollapsedHint: 'Press the button to open the full capability and limitation list.',
    agentCapabilitiesLocalStatus: 'Local agent',
    agentCapabilitiesDataStatus: 'Ecosystem data',
    agentCapabilitiesDesktopStatus: 'Windows and files',
    agentCapabilitiesSafetyStatus: 'Risky actions',
    agentCapabilitiesLoginRequired: 'Sign-in required',
    agentCapabilitiesConfirmationOnly: 'Confirmation only',
    telegramRemoteTitle: 'Telegram remote',
    telegramRemoteBody:
      'Connect a Telegram bot to message the agent and control this PC remotely while Friday is running.',
    telegramRemoteToken: 'Bot Token',
    telegramRemoteShowToken: 'Show Telegram token',
    telegramRemoteHideToken: 'Hide Telegram token',
    telegramRemoteEnabled: 'Enable Telegram remote',
    telegramRemoteStart: 'Start bot',
    telegramRemoteStop: 'Stop bot',
    telegramRemoteSave: 'Save Telegram',
    telegramRemotePair: 'Create pair code',
    telegramRemoteUsers: 'Linked users',
    telegramRemoteNoUsers: 'No linked Telegram users yet.',
    telegramRemotePairHint: 'Send /pair {code} to the bot. The code is valid for 5 minutes.',
    telegramRemoteRemoveUser: 'Remove',
    telegramRemoteStatus: 'Status',
    telegramRemoteRunning: 'Running',
    telegramRemoteStopped: 'Stopped',
    telegramRemoteCapabilities:
      'Commands: normal text to agent, /screen, /key enter, /type text, /open calc, /lock, /shutdown, /restart.',
    appearanceTitle: 'Appearance',
    behaviorTitle: 'Behavior',
    transcriptTitle: 'Voice and history',
    aiKeyTitle: 'AI runtime',
    aiKeyBody:
      'NVIDIA NIM is managed by Friday. The API key is hidden and cannot be edited from the interface.',
    envVariable: 'ENV variable',
    envKeyValue: 'Key value',
    showKey: 'Show key',
    hideKey: 'Hide key',
    saveKey: 'Save key',
    keySaved: 'ENV key updated.',
    agentMailKeyTitle: 'AgentMail',
    agentMailKeyBody:
      'This stores the AgentMail API key for the Friday agent. The key is written to the local agent configuration, and the official skill can be installed right from here.',
    agentMailKeyValue: 'AgentMail API key',
    agentMailSkillState: 'Skill',
    agentMailConfigPath: 'Config path',
    agentMailConfigManaged: 'Local agent configuration',
    agentMailInstallSkill: 'Install skill',
    agentMailSaveKey: 'Save AgentMail',
    agentMailInstalled: 'Installed',
    agentMailNotInstalled: 'Not installed',
    agentMailReady: 'AgentMail is ready',
    agentMailNeedKey: 'Add the API key to enable the live integration.',
    agentMailShowKey: 'Show AgentMail key',
    agentMailHideKey: 'Hide AgentMail key',
    legalTitle: 'README / FAQ',
    legalBody:
      'FRIDAY is a software product of X-VEXTA. All rights related to the interface, interaction logic, supporting materials, and associated user experience elements are reserved under applicable law. The assistant relies on probabilistic models and automated procedures, which means it may produce inaccurate, incomplete, or contextually incorrect responses, misunderstand instructions, or omit important conditions. Users must independently review commands, code, generated text, file operations, application launches, system changes, network activity, and any other outputs before relying on them. Neither X-VEXTA, nor the developers, rightsholders, partners, or contributors involved in maintaining the product accept liability for direct or indirect consequences of using FRIDAY, including data loss, financial losses, downtime, configuration errors, policy violations, incorrect system actions, generated code or text, or decisions taken based on assistant output. By using FRIDAY, you acknowledge that you act on your own initiative, assess risk independently, and assume full responsibility for all actions performed manually or through automation. We are also glad to build on open-source work and use an open agent runtime as part of the technical foundation, but validation, access control, and suitability for a specific task always remain the user responsibility.',
    transcriptEmpty: 'No voice transcripts yet.',
    enabled: 'Enabled',
    disabled: 'Disabled',
    errorState: 'Error',
    assistantState: 'Assistant',
    connectionState: 'Connection',
    voiceState: 'Voice',
    microphoneState: 'Microphone',
    noReplyToCopy: 'There is no reply to copy yet.',
    copyReady: 'Last reply copied.',
    bridgeError:
      'The reply service returned a utility response instead of chat text. The connection was refreshed, please try again.',
    bridgeErrorNoRecovery:
      'The reply service returned a utility response. Turn on smart recovery or start a new chat.',
    fallbackError: 'An unexpected error interrupted the request.',
    updatedNow: 'Updated just now',
    activeNow: 'Online',
    ambientVoiceTitle: 'Voice mode',
    ambientVoiceIdle: 'Voice mode is off.',
    ambientVoiceListening: 'Listening for "Friday".',
    ambientVoiceHearing: 'Hearing speech and transcribing.',
    ambientVoiceWake: 'Wake word heard, preparing the request.',
    ambientVoiceQuery: 'Sending the voice query to chat.',
    ambientVoiceSpeaking: 'Speaking the reply.',
    ambientVoiceFollowUp: 'Waiting for a follow-up without the wake word.',
    ambientVoiceNoTranscript: 'No speech has been recognized yet.',
    ambientVoiceWakeLogged: 'Wake word heard: {wake}.',
    ambientVoiceQueryLogged: 'Voice query: {query}',
    ambientVoiceEnable: 'Enable',
    ambientVoiceDisable: 'Disable',
    ambientVoicePrepare: 'Prepare',
    ambientVoiceBusy: 'Connecting voice mode...',
    gameMode: 'Game',
    gameModeOn: 'BeamNG mode is on',
    gameModeOff: 'Regular chat',
    gameModePlaceholder: 'BeamNG.drive: enable autopilot, aggressive traffic, explore the map, go to <place>...',
    gameModeNoMatch:
      'Game mode is on. I am waiting for BeamNG.drive commands such as "enable autopilot", "aggressive traffic", "keep lane", "disable lane hold", "stop", "disable autopilot", "explore the map", "drive randomly", or "go to <place>".',
  },
} satisfies Record<AppLanguage, CopyMap>

const EMPTY_DIAGNOSTICS: Diagnostics = {
  openclaw: { label: 'Assistant', status: 'checking', detail: 'Подготавливаем сервис ответа...' },
  gateway: { label: 'Connection', status: 'checking', detail: 'Проверяем локальное подключение...' },
  whisper: { label: 'Voice', status: 'checking', detail: 'Компоненты голоса подготавливаются.' },
  mic: { label: 'Микрофон', status: 'checking', detail: 'Проверяем доступ к записи.' },
}

const INITIAL_WINDOW_STATE: DesktopWindowState = { isMaximized: false, isFullScreen: false }
const DEFAULT_AI_RUNTIME_CONFIG: AiRuntimeConfig = {
  provider: 'nvidia',
  model: 'nvidia/mistralai/mistral-large-3-675b-instruct-2512',
  envVariable: 'NVIDIA_API_KEY',
  managed: true,
  status: 'checking',
  detail: 'Preparing managed NVIDIA runtime.',
}
const DEFAULT_MESSAGE_QUOTA: MessageQuotaState = {
  plan: 'unknown',
  limit: 35,
  used: 0,
  remaining: 35,
  unlimited: false,
  periodStart: new Date(0).toISOString(),
  periodEnd: new Date(0).toISOString(),
  resetAt: new Date(0).toISOString(),
  status: 'unknown',
}
const EMPTY_BACKEND_SESSION: BackendSessionState = {
  session: null,
  appToken: null,
  updatedAt: new Date(0).toISOString(),
}
const DEFAULT_BEAMNG_CONFIG: BeamngConfig = createDefaultBeamngConfig()
const DEFAULT_BEAMNG_STATE: BeamngState = {
  bridgeStatus: 'stopped',
  pythonStatus: 'missing',
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
}
const DEFAULT_VPN_CONFIG: VpnConfig = {
  mode: 'tun',
  autoConnect: false,
  profileSource: 'catalog',
  locationId: 'usa-new-jersey',
  tunInterfaceName: 'FridayTun',
  mtu: 1500,
  rawProfileJson: '',
}
const DEFAULT_VPN_STATE: VpnState = {
  status: 'disconnected',
  enabled: false,
  mode: 'tun',
  detail: 'VPN is turned off.',
  requiresAdmin: false,
  runtimeInstalled: false,
  connectedAt: null,
  lastError: null,
  profileName: 'VPN profile',
  locationId: 'usa-new-jersey',
  serverAddress: null,
  serverPort: null,
}
const DEFAULT_AGENTMAIL_CONFIG: AgentMailConfigState = {
  apiKey: '',
  enabled: true,
  installed: false,
  configPath: '',
}
const DEFAULT_TELEGRAM_CONFIG: TelegramRemoteConfig = {
  botToken: '',
  enabled: false,
  linkedUsers: [],
}
const DEFAULT_TELEGRAM_STATE: TelegramRemoteState = {
  enabled: false,
  running: false,
  linkedUsers: [],
  lastUpdateAt: null,
  lastError: null,
  pairCode: null,
  pairCodeExpiresAt: null,
}
const DEFAULT_VOICE_RUNTIME_CONFIG: VoiceRuntimeConfig = {
  ambientEnabled: false,
  wakeWord: 'пятница',
  wakeAliases: ['friday', 'фрайдей', 'пятница', 'пятницу', 'пятница ответь'],
  wakeFuzzyRatio: 0.78,
  hotWindowSeconds: 3,
  sttModel: 'small',
  whisperDevice: 'cpu',
  whisperComputeType: 'int8',
  ttsVoice: 'M1',
  ttsLanguage: 'na',
  ttsSpeed: 1.05,
  ollamaUrl: 'http://127.0.0.1:11434',
  intentJudgeModel: '',
}
function FridayApp({ recorderFactory = DEFAULT_RECORDER_FACTORY }: FridayAppProps) {
  if (!window.friday) {
    return (
      <div className="window-frame">
        <div className="boot-shell">
          <section className="boot-panel">
            <span className="orb orb-small" />
            <h1>Friday</h1>
            <p className="boot-copy">
              Desktop bridge unavailable. Open Friday through the Electron desktop client so the agent, VPN,
              voice, and ecosystem APIs can be loaded through preload.
            </p>
          </section>
        </div>
      </div>
    )
  }

  return <FridayAppShell recorderFactory={recorderFactory} />
}

function FridayAppShell({ recorderFactory = DEFAULT_RECORDER_FACTORY }: FridayAppProps) {
  const [activeView, setActiveView] = useState<ViewId>('chat')
  const [appState, setAppState] = useState<PersistedAppState | null>(null)
  const [draftInput, setDraftInput] = useState('')
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(EMPTY_DIAGNOSTICS)
  const [requestStatus, setRequestStatus] = useState<RequestStatus>('checking_gateway')
  const [agentProgress, setAgentProgress] = useState<AgentProgressState | null>(null)
  const [agentProgressClock, setAgentProgressClock] = useState(0)
  const [agentCapabilitiesOpen, setAgentCapabilitiesOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [windowState, setWindowState] = useState<DesktopWindowState>(INITIAL_WINDOW_STATE)
  const [aiRuntimeConfig, setAiRuntimeConfig] = useState<AiRuntimeConfig>(DEFAULT_AI_RUNTIME_CONFIG)
  const [agentMailConfig, setAgentMailConfig] = useState<AgentMailConfigState>(DEFAULT_AGENTMAIL_CONFIG)
  const [agentMailKeyDraft, setAgentMailKeyDraft] = useState('')
  const [showAgentMailKey, setShowAgentMailKey] = useState(false)
  const [agentMailInstalling, setAgentMailInstalling] = useState(false)
  const [telegramConfig, setTelegramConfig] = useState<TelegramRemoteConfig>(DEFAULT_TELEGRAM_CONFIG)
  const [telegramTokenDraft, setTelegramTokenDraft] = useState('')
  const [telegramState, setTelegramState] = useState<TelegramRemoteState>(DEFAULT_TELEGRAM_STATE)
  const [telegramPairCode, setTelegramPairCode] = useState<TelegramPairCode | null>(null)
  const [telegramBusy, setTelegramBusy] = useState(false)
  const [showTelegramToken, setShowTelegramToken] = useState(false)
  const [backendSession, setBackendSession] = useState<BackendSessionState | null>(null)
  const [messageQuota, setMessageQuota] = useState<MessageQuotaState>(DEFAULT_MESSAGE_QUOTA)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [mailAccount, setMailAccount] = useState<AgentMailAccount | null>(null)
  const [mailMessages, setMailMessages] = useState<AgentMailMessage[]>([])
  const [mailContacts, setMailContacts] = useState<AgentMailContact[]>([])
  const [mailFolder, setMailFolder] = useState<AgentMailFolder>('inbox')
  const [mailLoading, setMailLoading] = useState(false)
  const [mailSaving, setMailSaving] = useState(false)
  const [mailSending, setMailSending] = useState(false)
  const [mailReading, setMailReading] = useState(false)
  const [mailError, setMailError] = useState<string | null>(null)
  const [selectedMailMessageId, setSelectedMailMessageId] = useState<string | null>(null)
  const [mailInspectorMode, setMailInspectorMode] = useState<'message' | 'compose' | 'settings' | 'contacts'>('message')
  const [mailAddressInput, setMailAddressInput] = useState('')
  const [mailDisplayNameInput, setMailDisplayNameInput] = useState('')
  const [mailInboxIdInput, setMailInboxIdInput] = useState('')
  const [mailRecipientInput, setMailRecipientInput] = useState('')
  const [mailSubjectInput, setMailSubjectInput] = useState('')
  const [mailBodyInput, setMailBodyInput] = useState('')
  const [mailContactNameInput, setMailContactNameInput] = useState('')
  const [mailContactEmailInput, setMailContactEmailInput] = useState('')
  const [mailContactAliasesInput, setMailContactAliasesInput] = useState('')
  const [mailContactNotesInput, setMailContactNotesInput] = useState('')
  const [editingMailContactId, setEditingMailContactId] = useState<string | null>(null)
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])
  const [memoryFilter, setMemoryFilter] = useState('')
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const [deletingMemoryIds, setDeletingMemoryIds] = useState<string[]>([])
  const [userDataOverview, setUserDataOverview] = useState<AgentUserDataOverview | null>(null)
  const [userDataLoading, setUserDataLoading] = useState(false)
  const [userDataError, setUserDataError] = useState<string | null>(null)
  const [pendingAgentAction, setPendingAgentAction] = useState<AgentPendingAction | null>(null)
  const [confirmingAgentAction, setConfirmingAgentAction] = useState(false)
  const [beamngConfig, setBeamngConfig] = useState<BeamngConfig>(DEFAULT_BEAMNG_CONFIG)
  const [beamngDraft, setBeamngDraft] = useState<BeamngConfig>(DEFAULT_BEAMNG_CONFIG)
  const [beamngState, setBeamngState] = useState<BeamngState>(DEFAULT_BEAMNG_STATE)
  const [beamngDetectedInstalls, setBeamngDetectedInstalls] = useState<BeamngDetectedInstall[]>([])
  const [beamngBusy, setBeamngBusy] = useState(false)
  const [vpnConfig, setVpnConfig] = useState<VpnConfig>(DEFAULT_VPN_CONFIG)
  const [vpnState, setVpnState] = useState<VpnState>(DEFAULT_VPN_STATE)
  const [vpnLocations, setVpnLocations] = useState<VpnLocation[]>([])
  const [vpnBusy, setVpnBusy] = useState(false)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const chatFeedRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const activeVoicePointerIdRef = useRef<number | null>(null)
  const keyboardVoiceHoldRef = useRef(false)
  const pendingVoiceStopRef = useRef(false)
  const voiceSessionIdRef = useRef<string | null>(null)
  const voiceChunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  const voiceDraftBaseRef = useRef('')
  const liveTranscriptRef = useRef('')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [voiceRuntimeConfig, setVoiceRuntimeConfig] = useState<VoiceRuntimeConfig>(DEFAULT_VOICE_RUNTIME_CONFIG)
  const [voiceRuntimeBusy, setVoiceRuntimeBusy] = useState(false)
  const [ambientTranscript, setAmbientTranscript] = useState('')
  const [ambientVoiceDetail, setAmbientVoiceDetail] = useState('Ambient voice is off.')
  const voiceQueryHandlerRef = useRef<(query: string) => void>(() => undefined)
  const ambientWakeLoggedRef = useRef<string | null>(null)
  const latestStateRef = useRef<PersistedAppState | null>(null)
  const activeAgentRequestRef = useRef<string | null>(null)
  const clearAgentProgressTimerRef = useRef<number | null>(null)
  const [systemSnapshot, setSystemSnapshot] = useState<SystemSnapshot>(DEFAULT_SYSTEM_SNAPSHOT)

  const safeState = appState ? hydrateState(appState) : null
  latestStateRef.current = safeState
  const preferences = safeState?.preferences ?? createDefaultPreferences()
  const copy = STRINGS[preferences.language]
  const deferredMessages = useDeferredValue(safeState?.messages ?? [])
  const deferredMemoryFilter = useDeferredValue(memoryFilter)
  const busy = isBusy(requestStatus)
  const composerLocked = requestStatus === 'sending' || requestStatus === 'transcribing'
  const agentMailConfigDirty = agentMailKeyDraft !== agentMailConfig.apiKey
  const telegramConfigDirty =
    telegramTokenDraft !== telegramConfig.botToken || telegramState.enabled !== telegramConfig.enabled
  const beamngDirty = JSON.stringify(beamngDraft) !== JSON.stringify(beamngConfig)
  const composerValue =
    requestStatus === 'recording' || requestStatus === 'transcribing'
      ? mergeDraftWithTranscript(voiceDraftBaseRef.current, liveTranscript)
      : draftInput

  const lastUserMessage = useMemo(
    () => [...deferredMessages].reverse().find((message) => message.role === 'user'),
    [deferredMessages],
  )
  const lastAssistantMessage = useMemo(
    () => [...deferredMessages].reverse().find((message) => message.role === 'assistant'),
    [deferredMessages],
  )
  const diagnosticCards = useMemo(
    () => buildDiagnosticCards(diagnostics, copy, preferences.language),
    [copy, diagnostics, preferences.language],
  )
  const agentCapabilitySections = useMemo(
    () => buildAgentCapabilitySections(preferences.language),
    [preferences.language],
  )
  const tone = resolveTone(requestStatus, diagnostics.gateway.status)
  const brandTitle = preferences.language === 'ru' ? 'Пятница' : copy.appName
  const gameModeStatusLabel = preferences.gameMode ? copy.gameModeOn : copy.gameModeOff
  const ambientVoiceEnabled = voiceRuntimeConfig.ambientEnabled
  const ambientVoiceTranscriptLabel = ambientTranscript.trim() || copy.ambientVoiceNoTranscript
  const composerPlaceholder = preferences.gameMode ? copy.gameModePlaceholder : copy.messagePlaceholder
  const memoryLabel = copy.memory
  const mailComposeActionLabel = preferences.language === 'ru' ? 'Написать' : 'Compose'
  const mailSetupActionLabel = preferences.language === 'ru' ? 'Настроить ящик' : 'Mailbox settings'
  const mailFoldersLabel = preferences.language === 'ru' ? 'Папки' : 'Folders'
  const mailMessagesLabel = preferences.language === 'ru' ? 'Письма' : 'Messages'
  const mailConnectedAsLabel = preferences.language === 'ru' ? 'Подключено как' : 'Connected as'
  const mailFromLabel = preferences.language === 'ru' ? 'От' : 'From'
  const mailToLabel = preferences.language === 'ru' ? 'Кому' : 'To'
  const mailPreviewLabel = preferences.language === 'ru' ? 'Кратко' : 'Preview'
  const mailEmptySelectionTitle = preferences.language === 'ru' ? 'Выберите письмо' : 'Select an email'
  const mailEmptySelectionBody =
    preferences.language === 'ru'
      ? 'Список писем находится по центру. Справа будет открыт полный текст выбранного письма.'
      : 'Pick a message from the center list to open its full contents here.'
  const mailContactsLabel = preferences.language === 'ru' ? 'Контакты' : 'Contacts'
  const mailContactAliasLabel = preferences.language === 'ru' ? 'Алиасы' : 'Aliases'
  const mailContactNotesLabel = preferences.language === 'ru' ? 'Заметка' : 'Notes'
  const mailContactSaveLabel = preferences.language === 'ru' ? 'Сохранить контакт' : 'Save contact'
  const mailContactUpdateLabel = preferences.language === 'ru' ? 'Обновить контакт' : 'Update contact'
  const mailContactEditLabel = preferences.language === 'ru' ? 'Изменить' : 'Edit'
  const mailContactAddLabel = preferences.language === 'ru' ? 'Добавить контакт' : 'Add contact'
  const mailContactCancelLabel = preferences.language === 'ru' ? 'Сбросить' : 'Reset'
  const mailContactUseLabel = preferences.language === 'ru' ? 'В письмо' : 'Use in compose'
  const mailContactEmptyLabel =
    preferences.language === 'ru' ? 'Контактов пока нет. Добавьте босса, коллегу или клиента.' : 'No contacts yet.'
  const homeLabel = preferences.language === 'ru' ? 'Главная' : 'Home'
  const chatHeading = preferences.language === 'ru' ? 'Чем могу помочь?' : 'How can I help?'
  const agentLogsLabel = preferences.language === 'ru' ? 'Логи агента' : 'Agent logs'
  const systemLabel = preferences.language === 'ru' ? 'Система' : 'System'
  const agentCapabilityLocalValue =
    diagnostics.gateway.status === 'ready'
      ? copy.readyState
      : diagnostics.gateway.status === 'error'
        ? copy.errorState
        : copy.checkingState
  const agentCapabilityDataValue = backendSession?.session
    ? userDataError
      ? copy.errorState
      : copy.readyState
    : copy.agentCapabilitiesLoginRequired
  const agentCapabilityDesktopValue =
    diagnostics.gateway.status === 'ready'
      ? copy.readyState
      : preferences.language === 'ru'
        ? 'Ждет агента'
        : 'Waiting for agent'
  const railStatusLabel =
    preferences.language === 'ru'
      ? tone === 'error'
        ? 'Агент требует внимания'
        : 'Агент активен'
      : tone === 'error'
        ? 'Agent needs attention'
        : 'Agent active'
  const activityLogItems = useMemo(
    () =>
      buildActivityLogItems({
        requestStatus,
        diagnosticCards,
        lastUserMessage,
        language: preferences.language,
      }),
    [diagnosticCards, lastUserMessage, preferences.language, requestStatus],
  )
  const systemMetrics = useMemo(
    () =>
      buildSystemMetrics({
        snapshot: systemSnapshot,
        language: preferences.language,
      }),
    [preferences.language, systemSnapshot],
  )
  const visibleMemories = useMemo(() => mergeVisibleMemories(memoryEntries), [memoryEntries])
  const userDataContext = userDataOverview?.context ?? null
  const userDataCounts = userDataOverview?.counts
  const filteredUserDataItems = useMemo(
    () => filterUserDataItems(userDataContext, visibleMemories, deferredMemoryFilter, preferences.language),
    [deferredMemoryFilter, preferences.language, userDataContext, visibleMemories],
  )
  const filteredMailMessages = useMemo(
    () => mailMessages.filter((message) => message.folder === mailFolder),
    [mailFolder, mailMessages],
  )
  const selectedMailMessage = useMemo(
    () => filteredMailMessages.find((message) => message.id === selectedMailMessageId) ?? filteredMailMessages[0] ?? null,
    [filteredMailMessages, selectedMailMessageId],
  )
  const unreadMailCount = useMemo(
    () => mailMessages.filter((message) => message.folder === 'inbox' && !message.isRead).length,
    [mailMessages],
  )
  const mailCounts = useMemo(
    () => ({
      inbox: mailMessages.filter((message) => message.folder === 'inbox').length,
      sent: mailMessages.filter((message) => message.folder === 'sent').length,
      drafts: mailMessages.filter((message) => message.folder === 'drafts').length,
    }),
    [mailMessages],
  )
  const vpnCopy =
    preferences.language === 'ru'
      ? {
          title: 'VPN',
          body:
            'Встроенный VPN работает через локальный runtime и TUN-режим. Для системного маршрута Windows может потребоваться запуск Friday от имени администратора.',
          profile: 'Профиль',
          mode: 'Режим',
          runtime: 'Runtime',
          config: 'Конфигурация JSON',
          detail: 'Статус',
          autoConnect: 'Автоподключение при старте',
          interfaceName: 'Имя TUN-интерфейса',
          mtu: 'MTU',
          save: 'Сохранить VPN',
          connect: 'Включить VPN',
          disconnect: 'Выключить VPN',
          adminHint: 'TUN-режим требует запуск Friday от имени администратора.',
          installed: 'Установлен',
          notInstalled: 'Не установлен',
        }
        : {
          title: 'VPN',
          body:
            'Built-in VPN runs through a local runtime and TUN mode. Windows system-wide routing may require running Friday as Administrator.',
          profile: 'Profile',
          mode: 'Mode',
          runtime: 'Runtime',
          config: 'JSON config',
          detail: 'Status',
          autoConnect: 'Auto-connect on launch',
          interfaceName: 'TUN interface name',
          mtu: 'MTU',
          save: 'Save VPN',
          connect: 'Turn VPN on',
          disconnect: 'Turn VPN off',
          adminHint: 'TUN mode requires running Friday as Administrator.',
          installed: 'Installed',
          notInstalled: 'Not installed',
        }
  const vpnStatusLabel = labelForVpnStatus(vpnState.status, preferences.language)
  const vpnRuntimeLabel = vpnState.runtimeInstalled ? vpnCopy.installed : vpnCopy.notInstalled
  const beamngCopy =
    preferences.language === 'ru'
      ? {
          title: 'BeamNG.drive',
          body:
            'Friday управляет встроенным AI BeamNG через локальный Python bridge. Укажите путь к игре, настройте основную машину и сохранённые точки маршрута.',
          gamePath: 'Путь к игре',
          autoLaunch: 'Автозапуск игры при подключении',
          vehicleId: 'ID машины',
          bridge: 'Bridge',
          python: 'Python',
          install: 'Установка',
          installDependencies: 'Установить зависимости',
          aiMode: 'AI режим',
          lane: 'Полоса',
          destination: 'Точка',
          connect: 'Подключить / проверить',
          disconnect: 'Отключить',
          detect: 'Автопоиск',
          save: 'Сохранить BeamNG',
          savedPlaces: 'Сохранённые точки',
          addPlace: 'Добавить точку',
          placeName: 'Название',
          waypointId: 'Waypoint ID',
          aliases: 'Алиасы',
          aliasesHint: 'Через запятую',
          remove: 'Удалить',
          installHint: 'Приоритет: сохранённый путь, BNG_HOME, Steam, стандартные директории.',
          dependencyHint: 'Friday установит beamngpy через системный Python и перезапустит локальный bridge.',
          scanWaypoints: 'Сканировать waypoint',
        }
      : {
          title: 'BeamNG.drive',
          body:
            'Friday controls the built-in BeamNG AI through a local Python bridge. Set the game path, default vehicle, and saved destinations here.',
          gamePath: 'Game path',
          autoLaunch: 'Launch the game automatically on connect',
          vehicleId: 'Vehicle ID',
          bridge: 'Bridge',
          python: 'Python',
          install: 'Install',
          installDependencies: 'Install dependencies',
          aiMode: 'AI mode',
          lane: 'Lane',
          destination: 'Destination',
          connect: 'Connect / test',
          disconnect: 'Disconnect',
          detect: 'Autodetect',
          save: 'Save BeamNG',
          savedPlaces: 'Saved places',
          addPlace: 'Add place',
          placeName: 'Name',
          waypointId: 'Waypoint ID',
          aliases: 'Aliases',
          aliasesHint: 'Comma separated',
          remove: 'Remove',
          installHint: 'Priority: saved path, BNG_HOME, Steam, then common directories.',
          dependencyHint: 'Friday will install beamngpy with your system Python and restart the local bridge.',
          scanWaypoints: 'Scan waypoints',
        }
  const beamngBridgeLabel = labelForBeamngBridgeStatus(beamngState.bridgeStatus, preferences.language)
  const beamngPythonLabel = labelForBeamngPythonStatus(beamngState.pythonStatus, preferences.language)
  const beamngInstallLabel = labelForBeamngInstallStatus(beamngState.installStatus, preferences.language)
  const beamngLaneLabel =
    beamngState.driveInLane === null
      ? preferences.language === 'ru'
        ? 'Неизвестно'
        : 'Unknown'
      : beamngState.driveInLane
        ? copy.enabled
        : copy.disabled

  useEffect(() => {
    recorderRef.current = recorderFactory()
    let disposed = false

    async function boot() {
      setRequestStatus('checking_gateway')

      try {
        const [
          storedState,
          storedBackendSession,
          storedAiRuntimeConfig,
          storedMessageQuota,
          storedAgentMailConfig,
          storedTelegramConfig,
          storedTelegramState,
          storedVoiceRuntimeConfig,
          nextWindowState,
          nextSystemSnapshot,
          storedBeamngConfig,
          storedBeamngState,
          storedVpnConfig,
          storedVpnState,
          storedVpnLocations,
        ] = await Promise.all([
          window.friday.app.getState(),
          window.friday.backend.getSessionState(),
          window.friday.app.getAiRuntimeConfig(),
          window.friday.backend.getMessageQuota(),
          window.friday.agentmail.getConfig(),
          window.friday.telegram.getConfig(),
          window.friday.telegram.getState(),
          window.friday.voice.getRuntimeConfig(),
          window.friday.window.getState(),
          window.friday.app.getSystemSnapshot(),
          window.friday.beamng.getConfig(),
          window.friday.beamng.getState(),
          window.friday.vpn.getConfig(),
          window.friday.vpn.getState(),
          window.friday.vpn.listLocations(),
        ])

        const hydratedState = hydrateState(storedState)
        let nextBackendSession = storedBackendSession

        if (storedBackendSession.session && !storedBackendSession.appToken) {
          nextBackendSession = await window.friday.backend.clearSessionState()
        } else if (storedBackendSession.session) {
          try {
            const profile = await window.friday.backend.getMe()
            nextBackendSession = {
              ...storedBackendSession,
              session: {
                ...storedBackendSession.session,
                user: profile,
              },
              updatedAt: new Date().toISOString(),
            }
            await window.friday.backend.saveSessionState(nextBackendSession)
          } catch {
            nextBackendSession = await window.friday.backend.clearSessionState()
          }
        }

        if (disposed) {
          return
        }

        setAppState(hydratedState)
        setAiRuntimeConfig(storedAiRuntimeConfig)
        setMessageQuota(storedMessageQuota)
        setAgentMailConfig(storedAgentMailConfig)
        setAgentMailKeyDraft(storedAgentMailConfig.apiKey)
        setTelegramConfig(storedTelegramConfig)
        setTelegramTokenDraft(storedTelegramConfig.botToken)
        setTelegramState(storedTelegramState)
        setVoiceRuntimeConfig(storedVoiceRuntimeConfig)
        setAmbientVoiceDetail(
          storedVoiceRuntimeConfig.ambientEnabled ? copy.ambientVoiceListening : copy.ambientVoiceIdle,
        )
        setWindowState(nextWindowState)
        setBackendSession(nextBackendSession)
        setBeamngConfig(storedBeamngConfig)
        setBeamngDraft(storedBeamngConfig)
        setBeamngState(storedBeamngState)
        setVpnConfig(storedVpnConfig)
        setVpnState(storedVpnState)
        setVpnLocations(storedVpnLocations)
        setSystemSnapshot(nextSystemSnapshot)
        setRequestStatus('idle')

        if (storedVoiceRuntimeConfig.ambientEnabled) {
          window.setTimeout(() => {
            void window.friday.voice
              .startAmbient()
              .then(() => {
                if (!disposed) {
                  setAmbientVoiceDetail(copy.ambientVoiceListening)
                }
              })
              .catch((error) => {
                if (!disposed) {
                  setAmbientVoiceDetail(getErrorMessage(error, copy.fallbackError))
                }
              })
          }, 50)
        }

        window.setTimeout(() => {
          if (disposed) {
            return
          }

          void refreshDiagnostics().catch(() => {
            // Diagnostics are best-effort on boot and should not block the UI.
          })
        }, 250)
      } catch (error) {
        if (disposed) {
          return
        }

        setRequestStatus('error')
        setAppState(hydrateState(createEmptyState()))
        setBackendSession(EMPTY_BACKEND_SESSION)
        setErrorMessage(getErrorMessage(error, STRINGS.ru.fallbackError))
      }
    }

    void boot()

    return () => {
      disposed = true
      if (voiceSessionIdRef.current) {
        void window.friday.voice.cancelSession({ sessionId: voiceSessionIdRef.current })
        voiceSessionIdRef.current = null
      }
      recorderRef.current?.dispose()
      recorderRef.current = null
    }
  }, [recorderFactory])

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
    document.documentElement.dataset.density = preferences.density
    document.documentElement.lang = preferences.language
  }, [preferences.density, preferences.language, preferences.theme])

  useEffect(() => {
    const unsubscribe = window.friday.chat.onProgress((event) => {
      if (activeAgentRequestRef.current && event.requestId !== activeAgentRequestRef.current) {
        return
      }

      if (clearAgentProgressTimerRef.current) {
        window.clearTimeout(clearAgentProgressTimerRef.current)
        clearAgentProgressTimerRef.current = null
      }

      setAgentProgress((current) => {
        const startedAt = current?.requestId === event.requestId ? current.startedAt : event.at
        const previousEvents = current?.requestId === event.requestId ? current.events : []
        return {
          requestId: event.requestId,
          startedAt,
          latest: event,
          events: [...previousEvents, event].slice(-5),
        }
      })

      if (event.status === 'completed' || event.status === 'error') {
        clearAgentProgressTimerRef.current = window.setTimeout(() => {
          setAgentProgress((current) => (current?.requestId === event.requestId ? null : current))
          if (activeAgentRequestRef.current === event.requestId) {
            activeAgentRequestRef.current = null
          }
          clearAgentProgressTimerRef.current = null
        }, 900)
      }
    })

    return () => {
      unsubscribe()
      if (clearAgentProgressTimerRef.current) {
        window.clearTimeout(clearAgentProgressTimerRef.current)
        clearAgentProgressTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!agentProgress || agentProgress.latest.status !== 'active') {
      return
    }

    setAgentProgressClock(0)
    const timer = window.setInterval(() => setAgentProgressClock((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [agentProgress?.requestId, agentProgress?.latest.status])

  useEffect(() => {
    if (requestStatus === 'recording' || requestStatus === 'transcribing') {
      return
    }

    setDraftInput(safeState?.draft ?? '')
    if (composerRef.current && composerRef.current.value !== (safeState?.draft ?? '')) {
      composerRef.current.value = safeState?.draft ?? ''
    }
  }, [requestStatus, safeState?.draft, safeState?.sessionId])

  useEffect(() => {
    if (!chatFeedRef.current || activeView !== 'chat') {
      return
    }

    chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight
  }, [activeView, agentProgress, deferredMessages])

  useEffect(() => {
    if (!backendSession?.session) {
      setMailAccount(null)
      setMailMessages([])
      setMailError(null)
      setMailLoading(false)
      setMailAddressInput('')
      setMailDisplayNameInput('')
      setMailInboxIdInput('')
      setMemoryEntries([])
      setMemoryFilter('')
      setMemoryError(null)
      setUserDataOverview(null)
      setUserDataError(null)
      setUserDataLoading(false)
      setPendingAgentAction(null)
      return
    }

    void refreshUserData(undefined, true).catch(() => {
      // User data is non-blocking for the rest of the interface.
    })
  }, [backendSession?.session?.token])

  useEffect(() => {
    if (!backendSession?.session) {
      return
    }

    void window.friday.gateway.ensureRunning().catch(() => {
      // Warm the gateway in the background so the first chat request is faster.
    })

    if (activeView === 'user-data') {
      void refreshUserData(memoryFilter.trim() || undefined).catch(() => {
        // User data is non-blocking for the rest of the interface.
      })
    }
  }, [activeView, backendSession?.session?.token])

  useEffect(() => {
    if (!toastMessage) {
      return
    }

    const timeout = window.setTimeout(() => setToastMessage(null), 2400)
    return () => window.clearTimeout(timeout)
  }, [toastMessage])

  useEffect(() => {
    return window.friday.voice.onRuntimeEvent(handleVoiceRuntimeEvent)
  }, [])

  useEffect(() => {
    if (selectedMailMessage?.id && selectedMailMessageId !== selectedMailMessage.id) {
      setSelectedMailMessageId(selectedMailMessage.id)
      return
    }

    if (!selectedMailMessage && selectedMailMessageId) {
      setSelectedMailMessageId(null)
    }
  }, [selectedMailMessage, selectedMailMessageId])

  useEffect(() => {
    if (requestStatus !== 'recording' || !pendingVoiceStopRef.current) {
      return
    }

    pendingVoiceStopRef.current = false
    void handleStopRecording()
  }, [requestStatus])

  async function persist(nextState: PersistedAppState) {
    const savedState = (await window.friday.app.saveState(nextState)) ?? nextState
    const saved = hydrateState(savedState)
    setAppState(saved)
    return saved
  }

  async function appendSystemFeedMessage(text: string, source: MessageSource = 'voice') {
    const currentState = latestStateRef.current
    if (!currentState || !text.trim()) {
      return
    }

    await persist(
      appendMessages(
        currentState,
        createMessage({
          sessionId: currentState.sessionId,
          role: 'system',
          text: text.trim(),
          source,
        }),
      ),
    )
  }

  async function refreshDiagnostics() {
    const [gatewayDiagnostics, microphone, nextSystemSnapshot, nextBeamngState] = await Promise.all([
      window.friday.app.getDiagnostics(),
      checkMicrophoneSupport(),
      window.friday.app.getSystemSnapshot(),
      window.friday.beamng.getState(),
    ])

    setDiagnostics({ ...gatewayDiagnostics, mic: microphone })
    setSystemSnapshot(nextSystemSnapshot)
    setBeamngState(nextBeamngState)
  }

  async function refreshUserData(_query?: string, forceSync = false) {
    if (!backendSession?.session) {
      setUserDataOverview(null)
      setMemoryEntries([])
      return null
    }

    setUserDataLoading(true)
    setUserDataError(null)
    try {
      const sync = forceSync ? await window.friday.backend.syncUserDataNow() : null
      const overview = await window.friday.backend.getUserDataOverview()
      setUserDataOverview(overview)
      setMemoryEntries(overview.context.recentMemories)
      if (sync && !sync.ok && sync.error) {
        if (sync.snapshot) {
          setToastMessage(
            preferences.language === 'ru'
              ? 'Сервер не ответил на ручное обновление, но локальная синхронизация уже сохранена.'
              : 'The server did not answer the manual refresh, but the local snapshot is still available.',
          )
        } else {
          setUserDataError(
            preferences.language === 'ru'
              ? `Не удалось обновить данные с сервера. Показываю последнюю синхронизацию: ${sync.error}`
              : `Could not refresh server data. Showing the last synced snapshot: ${sync.error}`,
          )
        }
      }
      return overview
    } catch (error) {
      const message = getErrorMessage(error, copy.fallbackError)
      setUserDataError(message)
      throw error
    } finally {
      setUserDataLoading(false)
    }
  }

  async function refreshMailData() {
    if (!backendSession?.session) {
      setMailAccount(null)
      setMailMessages([])
      setMailContacts([])
      return { account: null, messages: [], contacts: [] }
    }

    setMailLoading(true)
    setMailError(null)
    try {
      const [accountResult, messagesResult, contactsResult] = await Promise.allSettled([
        window.friday.backend.getAgentMailAccount(),
        window.friday.backend.listAgentMailMessages(),
        window.friday.backend.listAgentMailContacts(),
      ])

      if (accountResult.status === 'fulfilled') {
        const account = accountResult.value
        setMailAccount(account)
        if (account) {
          setMailAddressInput(account.address)
          setMailDisplayNameInput(account.displayName)
          setMailInboxIdInput(account.inboxId ?? '')
        } else if (!mailDisplayNameInput.trim()) {
          setMailDisplayNameInput(backendSession.session.user.displayName || 'Friday')
        }
      }

      if (messagesResult.status === 'fulfilled') {
        setMailMessages(messagesResult.value)
      }

      if (contactsResult.status === 'fulfilled') {
        setMailContacts(contactsResult.value)
      }

      const blockingError =
        accountResult.status === 'rejected'
          ? accountResult.reason
          : contactsResult.status === 'rejected'
            ? contactsResult.reason
            : null

      if (blockingError) {
        const message = getErrorMessage(blockingError, copy.fallbackError)
        setMailError(message)
        throw blockingError instanceof Error ? blockingError : new Error(message)
      }

      return {
        account: accountResult.status === 'fulfilled' ? accountResult.value : mailAccount,
        messages: messagesResult.status === 'fulfilled' ? messagesResult.value : mailMessages,
        contacts: contactsResult.status === 'fulfilled' ? contactsResult.value : mailContacts,
      }
    } catch (error) {
      const message = getErrorMessage(error, copy.fallbackError)
      setMailError(message)
      throw error
    } finally {
      setMailLoading(false)
    }
  }

  function scheduleMemoryRefresh(query?: string) {
    if (!backendSession?.session) {
      return
    }

    void refreshUserData(query).catch(() => {
      // User data is non-blocking for the rest of the interface.
    })
  }

  async function handleSaveMailAccount() {
    if (!backendSession?.session) {
      return
    }

    setMailSaving(true)
    setMailError(null)
    setToastMessage(null)

    try {
      const nextAccount = await window.friday.backend.upsertAgentMailAccount({
        address: mailAddressInput.trim(),
        displayName: mailDisplayNameInput.trim() || 'Friday',
        inboxId: mailInboxIdInput.trim() || null,
        status: mailInboxIdInput.trim() ? 'ready' : 'disconnected',
        detail: mailInboxIdInput.trim()
          ? 'AgentMail inbox linked from the Friday mail tab.'
          : 'Mailbox profile saved locally. Add the real AgentMail inbox ID when it is ready.',
      })

      setMailAccount(nextAccount)
      try {
        const nextMessages = await window.friday.backend.listAgentMailMessages()
        setMailMessages(nextMessages)
      } catch {
        // Keep the saved mailbox visible even if inbox sync is temporarily unavailable.
      }
      setToastMessage(
        preferences.language === 'ru'
          ? 'Почта агента сохранена.'
          : 'The agent mailbox was saved.',
      )
    } catch (error) {
      setMailError(getErrorMessage(error, copy.fallbackError))
    } finally {
      setMailSaving(false)
    }
  }

  async function handleSendMailMessage() {
    if (!mailAccount) {
      setMailError(copy.mailNoAccount)
      return
    }

    setMailSending(true)
    setMailError(null)
    setToastMessage(null)

    try {
      const created = await window.friday.backend.createAgentMailMessage({
        accountId: mailAccount.id,
        folder: 'sent',
        fromName: mailAccount.displayName,
        fromAddress: mailAccount.address,
        toAddresses: mailRecipientInput
          .split(/[,\n;]/)
          .map((value) => value.trim())
          .filter(Boolean),
        subject: mailSubjectInput.trim(),
        bodyText: mailBodyInput.trim(),
        labels: ['outgoing'],
      })

      setMailMessages((current) => [created, ...current])
      setMailFolder('sent')
      setSelectedMailMessageId(created.id)
      setMailInspectorMode('message')
      setMailRecipientInput('')
      setMailSubjectInput('')
      setMailBodyInput('')
      setToastMessage(
        preferences.language === 'ru'
          ? 'Письмо добавлено в отправленные.'
          : 'The email was added to Sent.',
      )
    } catch (error) {
      setMailError(getErrorMessage(error, copy.fallbackError))
    } finally {
      setMailSending(false)
    }
  }

  function resetMailContactForm() {
    setEditingMailContactId(null)
    setMailContactNameInput('')
    setMailContactEmailInput('')
    setMailContactAliasesInput('')
    setMailContactNotesInput('')
  }

  function handleCreateMailContact() {
    resetMailContactForm()
    setMailInspectorMode('contacts')
  }

  function handleEditMailContact(contact: AgentMailContact) {
    setEditingMailContactId(contact.id)
    setMailContactNameInput(contact.name)
    setMailContactEmailInput(contact.email)
    setMailContactAliasesInput(contact.aliases.join(', '))
    setMailContactNotesInput(contact.notes)
    setMailInspectorMode('contacts')
  }

  function handleUseMailContact(contact: AgentMailContact) {
    setMailRecipientInput((current) => {
      const tokens = current
        .split(/[,\n;]/)
        .map((value) => value.trim())
        .filter(Boolean)
      if (tokens.some((token) => token.toLowerCase() === contact.email.toLowerCase())) {
        return current
      }
      return [...tokens, contact.email].join(', ')
    })
    setMailInspectorMode('compose')
  }

  async function handleSaveMailContact() {
    if (!mailAccount) {
      setMailError(copy.mailNoAccount)
      return
    }

    setMailSaving(true)
    setMailError(null)
    setToastMessage(null)
    try {
      const saved = await window.friday.backend.upsertAgentMailContact({
        id: editingMailContactId ?? undefined,
        accountId: mailAccount.id,
        name: mailContactNameInput.trim(),
        email: mailContactEmailInput.trim(),
        aliases: mailContactAliasesInput
          .split(/[,\n;]/)
          .map((value) => value.trim())
          .filter(Boolean),
        notes: mailContactNotesInput.trim(),
      })
      setMailContacts((current) => {
        const existing = current.some((entry) => entry.id === saved.id)
        return existing ? current.map((entry) => (entry.id === saved.id ? saved : entry)) : [saved, ...current]
      })
      resetMailContactForm()
      setToastMessage(
        preferences.language === 'ru' ? 'Контакт сохранён в адресной книге.' : 'Contact saved to the mail address book.',
      )
    } catch (error) {
      setMailError(getErrorMessage(error, copy.fallbackError))
    } finally {
      setMailSaving(false)
    }
  }

  async function handleDeleteMailContact(contact: AgentMailContact) {
    const confirmed = window.confirm(
      preferences.language === 'ru'
        ? `Удалить контакт "${contact.name}" из почты?`
        : `Delete "${contact.name}" from mail contacts?`,
    )
    if (!confirmed) {
      return
    }

    setMailError(null)
    setToastMessage(null)
    try {
      await window.friday.backend.deleteAgentMailContact(contact.id)
      setMailContacts((current) => current.filter((entry) => entry.id !== contact.id))
      if (editingMailContactId === contact.id) {
        resetMailContactForm()
      }
      setToastMessage(preferences.language === 'ru' ? 'Контакт удалён.' : 'Contact deleted.')
    } catch (error) {
      setMailError(getErrorMessage(error, copy.fallbackError))
    }
  }

  async function hydrateMailMessage(messageId: string) {
    const hydrated = await window.friday.backend.getAgentMailMessage(messageId)
    setMailMessages((current) => current.map((entry) => (entry.id === hydrated.id ? hydrated : entry)))
    return hydrated
  }

  async function handleSelectMailMessage(message: AgentMailMessage) {
    setSelectedMailMessageId(message.id)
    setMailInspectorMode('message')
    setMailError(null)

    const needsHydration =
      Boolean(message.externalId) &&
      (!message.metadata?.remoteHydrated || !message.bodyText.trim() || message.bodyText.trim() === message.preview.trim())
    if (!needsHydration && (message.folder !== 'inbox' || message.isRead)) {
      return
    }

    setMailReading(true)
    try {
      let detailed = message
      if (needsHydration) {
        try {
          detailed = await hydrateMailMessage(message.id)
        } catch {
          detailed = message
        }
      }

      if (detailed.folder === 'inbox' && !detailed.isRead) {
        try {
          const updated = await window.friday.backend.markAgentMailMessageRead(detailed.id)
          setMailMessages((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)))
        } catch {
          // Keep the current message visible even if marking as read fails.
        }
      }
    } finally {
      setMailReading(false)
    }
  }

  async function handleDeleteMemory(memory: VisibleMemoryEntry) {
    const deletingIds = [...memory.mergedIds]
    const confirmed = window.confirm(
      preferences.language === 'ru'
        ? `Удалить запись "${memory.title}" из памяти?${deletingIds.length > 1 ? ' Будут удалены и все её объединённые дубли.' : ''}`
        : `Delete "${memory.title}" from memory?${deletingIds.length > 1 ? ' All merged duplicates will be removed too.' : ''}`,
    )

    if (!confirmed) {
      return
    }

    setMemoryError(null)
    setToastMessage(null)
    setDeletingMemoryIds((current) => mergeMemoryList(current, deletingIds))

    try {
      await Promise.all(deletingIds.map((id) => window.friday.backend.deleteMemory(id)))
      setMemoryEntries((current) => current.filter((entry) => !deletingIds.includes(entry.id)))
      setToastMessage(
        preferences.language === 'ru'
          ? `Запись "${memory.title}" удалена из памяти.`
          : `"${memory.title}" was removed from memory.`,
      )
    } catch (error) {
      setMemoryError(getErrorMessage(error, copy.fallbackError))
    } finally {
      setDeletingMemoryIds((current) => current.filter((id) => !deletingIds.includes(id)))
    }
  }

  async function refreshVpnState() {
    const nextState = await window.friday.vpn.getState()
    setVpnState(nextState)
    return nextState
  }

  async function handleSaveBeamngConfig() {
    setBeamngBusy(true)
    setErrorMessage(null)

    try {
      const saved = await window.friday.beamng.saveConfig(beamngDraft)
      setBeamngConfig(saved)
      setBeamngDraft(saved)
      setBeamngState(await window.friday.beamng.getState())
      setToastMessage(preferences.language === 'ru' ? 'Настройки BeamNG сохранены.' : 'BeamNG settings saved.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setBeamngBusy(false)
    }
  }

  async function handleDetectBeamngInstalls() {
    setBeamngBusy(true)
    setErrorMessage(null)

    try {
      const installs = await window.friday.beamng.detectInstalls()
      setBeamngDetectedInstalls(installs)
      const preferred = installs.find((entry) => entry.valid) ?? installs[0]
      if (preferred?.path) {
        setBeamngDraft((current) => ({
          ...current,
          gamePath: preferred.path,
        }))
      }
      setBeamngState(await window.friday.beamng.getState())
      setToastMessage(
        installs.length > 0
          ? preferences.language === 'ru'
            ? 'Поиск BeamNG завершён.'
            : 'BeamNG detection finished.'
          : preferences.language === 'ru'
            ? 'Установки BeamNG не найдены.'
            : 'No BeamNG installations were found.',
      )
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setBeamngBusy(false)
    }
  }

  async function handleInstallBeamngDependencies() {
    setBeamngBusy(true)
    setErrorMessage(null)

    try {
      const result = await window.friday.beamng.installDependencies()
      setBeamngState(result.state)
      setToastMessage(result.detail)
      if (!result.ok) {
        setErrorMessage(result.detail)
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setBeamngBusy(false)
    }
  }

  async function handleBeamngConnectToggle() {
    setBeamngBusy(true)
    setErrorMessage(null)

    try {
      const nextState = beamngState.connected
        ? await window.friday.beamng.disconnect()
        : await window.friday.beamng.connect()
      setBeamngState(nextState)
      setToastMessage(nextState.detail)
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setBeamngBusy(false)
    }
  }

  async function handleScanBeamngWaypoints() {
    setBeamngBusy(true)
    setErrorMessage(null)

    try {
      const waypoints = await window.friday.beamng.listWaypoints()
      setToastMessage(
        preferences.language === 'ru'
          ? `Найдено waypoint: ${waypoints.length}.`
          : `Waypoints found: ${waypoints.length}.`,
      )
      setBeamngState(await window.friday.beamng.getState())
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setBeamngBusy(false)
    }
  }

  function handleBeamngDraftChange<K extends keyof BeamngConfig>(key: K, value: BeamngConfig[K]) {
    setBeamngDraft((current) => ({
      ...current,
      [key]: value,
    }))
  }

  function handleBeamngPlaceChange(
    placeId: string,
    key: keyof BeamngConfig['savedPlaces'][number],
    value: string | string[],
  ) {
    setBeamngDraft((current) => ({
      ...current,
      savedPlaces: current.savedPlaces.map((place) => (place.id === placeId ? { ...place, [key]: value } : place)),
    }))
  }

  function handleAddBeamngPlace() {
    const nextIndex = beamngDraft.savedPlaces.length + 1
    setBeamngDraft((current) => ({
      ...current,
      savedPlaces: [
        ...current.savedPlaces,
        {
          id: `place-${nextIndex}`,
          name: '',
          waypointId: '',
          aliases: [],
        },
      ],
    }))
  }

  function handleRemoveBeamngPlace(placeId: string) {
    setBeamngDraft((current) => ({
      ...current,
      savedPlaces: current.savedPlaces.filter((place) => place.id !== placeId),
    }))
  }

  async function handleVpnToggle(enable: boolean) {
    if (enable && vpnState.requiresAdmin) {
      setErrorMessage(vpnCopy.adminHint)
      return
    }

    setVpnBusy(true)
    setErrorMessage(null)

    try {
      const nextState = enable ? await window.friday.vpn.connect() : await window.friday.vpn.disconnect()
      setVpnState(nextState)
      if (nextState.status === 'error') {
        setErrorMessage(nextState.detail || nextState.lastError || vpnCopy.adminHint)
      } else {
        setToastMessage(
          enable
            ? preferences.language === 'ru'
              ? 'VPN подключается.'
              : 'VPN is connecting.'
            : preferences.language === 'ru'
              ? 'VPN отключен.'
              : 'VPN is disconnected.',
        )
      }
    } catch (error) {
      setErrorMessage(
        getErrorMessage(
          error,
          enable
            ? preferences.language === 'ru'
              ? 'Не удалось включить VPN.'
              : 'Failed to enable VPN.'
            : preferences.language === 'ru'
              ? 'Не удалось выключить VPN.'
              : 'Failed to disable VPN.',
        ),
      )
      await refreshVpnState().catch(() => {
        // Best-effort state refresh after a failed VPN operation.
      })
    } finally {
      setVpnBusy(false)
    }
  }

  async function handleVpnLocationChange(locationId: string) {
    const location = vpnLocations.find((item) => item.id === locationId)
    if (!location) {
      return
    }

    setVpnBusy(true)
    setErrorMessage(null)
    try {
      const saved = await window.friday.vpn.saveConfig({
        ...vpnConfig,
        profileSource: 'catalog',
        locationId: location.id,
        rawProfileJson: location.rawProfileJson,
      })
      setVpnConfig(saved)
      setVpnState(await window.friday.vpn.getState())
      setToastMessage(
        preferences.language === 'ru'
          ? `VPN-локация выбрана: ${location.name}.`
          : `VPN location selected: ${location.name}.`,
      )
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setVpnBusy(false)
    }
  }

  async function handleRestartAsAdmin() {
    setVpnBusy(true)
    setErrorMessage(null)
    try {
      await window.friday.app.restartAsAdmin()
      setToastMessage(
        preferences.language === 'ru'
          ? 'Перезапускаю Friday от имени администратора. Подтвердите запрос Windows.'
          : 'Restarting Friday as Administrator. Confirm the Windows prompt.',
      )
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
      setVpnBusy(false)
    }
  }

  async function handleWindowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
    if (action === 'close') {
      await window.friday.window.close()
      return
    }

    const nextState =
      action === 'minimize' ? await window.friday.window.minimize() : await window.friday.window.toggleMaximize()
    setWindowState(nextState)
  }

  async function handleLogin() {
    setAuthBusy(true)
    setErrorMessage(null)
    setToastMessage(null)

    try {
      const session = await window.friday.backend.login({
        email: loginEmail.trim(),
        password: loginPassword,
      })
      const nextBackendSession = await window.friday.backend.getSessionState()

      const currentPreferences = (appState ? hydrateState(appState) : safeState)?.preferences ?? createDefaultPreferences()
      const { sessionId } = await window.friday.chat.newSession()
      const freshState = hydrateState({
        ...createEmptyState(sessionId),
        preferences: currentPreferences,
      })

      await persist(freshState)
      setBackendSession(nextBackendSession.session ? nextBackendSession : { session, appToken: null, updatedAt: new Date().toISOString() })
      void window.friday.backend.getMessageQuota().then(setMessageQuota).catch(() => undefined)
      setLoginPassword('')
      setActiveView('chat')
      void window.friday.gateway.ensureRunning().catch(() => {
        // Keep sign-in responsive even if gateway warmup fails.
      })
      setToastMessage(preferences.language === 'ru' ? 'Вход выполнен.' : 'Signed in successfully.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleLogout() {
    await handleRecreateLocalSession()
  }

  async function handleRecreateLocalSession() {
    setErrorMessage(null)

    try {
      const nextBackendSession = await window.friday.backend.clearSessionState()
      setBackendSession(nextBackendSession)
      setMessageQuota(DEFAULT_MESSAGE_QUOTA)
      setLoginPassword('')
      setActiveView('chat')
      setToastMessage(
        preferences.language === 'ru' ? 'Вы вышли из аккаунта.' : 'Signed out.',
      )
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    }
  }

  async function sendWithRecovery(state: PersistedAppState, text: string, requestId: string) {
    const activeRemoteSession = state.remoteSessionId ?? state.sessionId
    let result = await window.friday.chat.sendText({ sessionId: activeRemoteSession, text, requestId })

    if (!isUnusableAgentReply(result.replyText)) {
      return { result, nextState: state }
    }

    if (!state.preferences.autoRecover) {
      throw new Error(copy.bridgeErrorNoRecovery)
    }

    const repairedState = await persist(withRemoteSessionId(state, crypto.randomUUID()))
    result = await window.friday.chat.sendText({
      sessionId: repairedState.remoteSessionId ?? repairedState.sessionId,
      text,
      requestId,
    })

    if (isUnusableAgentReply(result.replyText)) {
      throw new Error(copy.bridgeError)
    }

    return { result, nextState: repairedState }
  }

  async function handleSendText(rawText: string, source: MessageSource = 'text', speakReply = false) {
    const currentState = appState ? hydrateState(appState) : safeState
    if (!currentState || composerLocked || requestStatus === 'recording') {
      return
    }

    const text = rawText.trim()
    if (!text) {
      return
    }

    const agentRequestId = crypto.randomUUID()
    activeAgentRequestRef.current = agentRequestId
    if (clearAgentProgressTimerRef.current) {
      window.clearTimeout(clearAgentProgressTimerRef.current)
      clearAgentProgressTimerRef.current = null
    }
    setAgentProgress({
      requestId: agentRequestId,
      startedAt: new Date().toISOString(),
      latest: {
        requestId: agentRequestId,
        sessionId: currentState.sessionId,
        stage: 'queued',
        status: 'active',
        label: 'Queued',
        detail: 'The message is being added to the local chat.',
        progress: 2,
        at: new Date().toISOString(),
      },
      events: [],
    })
    setRequestStatus('sending')
    setErrorMessage(null)
    startTransition(() => setActiveView('chat'))
    setDraftInput('')
    if (composerRef.current) {
      composerRef.current.value = ''
    }

    const optimisticUserMessage = createMessage({
      sessionId: currentState.sessionId,
      role: 'user',
      text,
      source,
    })
    const pendingState = await persist(withDraft(appendMessages(currentState, optimisticUserMessage), ''))

    try {
      if (currentState.preferences.gameMode) {
        const beamngResolution = await window.friday.beamng.resolveTextCommand({
          text,
          language: preferences.language,
        })
        if (beamngResolution.matched && beamngResolution.command) {
          const beamngResult = await window.friday.beamng.executeCommand(beamngResolution.command)
          setBeamngState(beamngResult.state)
          const assistantMessage = createMessage({
            sessionId: pendingState.sessionId,
            role: 'assistant',
            text: beamngResult.message,
            source,
          })

          await persist(appendMessages(pendingState, assistantMessage))
          if (speakReply) {
            void window.friday.voice
              .speak({ text: assistantMessage.text, interrupt: true })
              .catch((error) => setErrorMessage(getErrorMessage(error, copy.fallbackError)))
          }
          setRequestStatus(beamngResult.ok ? 'completed' : 'error')
          if (!beamngResult.ok) {
            setErrorMessage(beamngResult.message)
          }
          setAgentProgress((current) => (current?.requestId === agentRequestId ? null : current))
          return
        }

        const assistantMessage = createMessage({
          sessionId: pendingState.sessionId,
          role: 'assistant',
          text: copy.gameModeNoMatch,
          source,
        })

        await persist(appendMessages(pendingState, assistantMessage))
        if (speakReply) {
          void window.friday.voice
            .speak({ text: assistantMessage.text, interrupt: true })
            .catch((error) => setErrorMessage(getErrorMessage(error, copy.fallbackError)))
        }
        setRequestStatus('completed')
        setAgentProgress((current) => (current?.requestId === agentRequestId ? null : current))
        return
      }

      const scheduled = await window.friday.scheduler.scheduleText({
        text,
        language: preferences.language,
      })

      if (scheduled.matched && scheduled.replyText) {
        const assistantMessage = createMessage({
          sessionId: pendingState.sessionId,
          role: 'assistant',
          text: scheduled.replyText,
          source,
        })

        await persist(appendMessages(pendingState, assistantMessage))
        if (speakReply) {
          void window.friday.voice
            .speak({ text: assistantMessage.text, interrupt: true })
            .catch((error) => setErrorMessage(getErrorMessage(error, copy.fallbackError)))
        }
        setRequestStatus('completed')
        setAgentProgress((current) => (current?.requestId === agentRequestId ? null : current))
        return
      }

      const { result, nextState } = await sendWithRecovery(pendingState, text, agentRequestId)
      void window.friday.backend.getMessageQuota().then(setMessageQuota).catch(() => undefined)
      if (result.agent?.confirmationRequired && result.agent.pendingAction) {
        setPendingAgentAction(result.agent.pendingAction)
      } else {
        setPendingAgentAction(null)
      }
      const assistantMessage = createMessage({
        sessionId: nextState.sessionId,
        role: 'assistant',
        text: result.replyText,
        source,
        id: result.messageId,
      })

      await persist(appendMessages(nextState, assistantMessage))
      if (speakReply) {
        void window.friday.voice
          .speak({ text: assistantMessage.text, interrupt: true })
          .catch((error) => setErrorMessage(getErrorMessage(error, copy.fallbackError)))
      }
      setRequestStatus('completed')
      scheduleMemoryRefresh()
    } catch (error) {
      const message = getErrorMessage(error, copy.fallbackError)
      await persist(
        appendMessages(
          pendingState,
          createMessage({
            sessionId: pendingState.sessionId,
            role: 'system',
            text: message,
            source,
          }),
        ),
      )
      setRequestStatus('error')
      setErrorMessage(message)
      setAgentProgress((current) => {
        if (!current || current.requestId !== agentRequestId) {
          return current
        }
        const event: AgentProgressEvent = {
          requestId: agentRequestId,
          sessionId: pendingState.sessionId,
          stage: 'error',
          status: 'error',
          label: 'Failed',
          detail: message,
          progress: 100,
          at: new Date().toISOString(),
        }
        return {
          ...current,
          latest: event,
          events: [...current.events, event].slice(-5),
        }
      })
      clearAgentProgressTimerRef.current = window.setTimeout(() => {
        setAgentProgress((current) => (current?.requestId === agentRequestId ? null : current))
        clearAgentProgressTimerRef.current = null
      }, 1200)
    } finally {
      activeAgentRequestRef.current = null
    }
  }

  async function handleConfirmAgentAction() {
    const pending = pendingAgentAction
    const currentState = latestStateRef.current
    if (!pending || !currentState || confirmingAgentAction) {
      return
    }

    setConfirmingAgentAction(true)
    setErrorMessage(null)
    try {
      const startedAt = performance.now()
      const result = await window.friday.backend.confirmAgentAction({ pendingAction: pending })
      const elapsedMs = Math.round(performance.now() - startedAt)
      const verifiedEntity = await rereadAgentActionEntity(result).catch(() => null)
      const assistantMessage = createMessage({
        sessionId: currentState.sessionId,
        role: 'assistant',
        text: formatConfirmedActionReply(result, verifiedEntity, elapsedMs, preferences.language),
        source: 'text',
      })

      await persist(appendMessages(currentState, assistantMessage))
      setPendingAgentAction(null)
      setToastMessage(preferences.language === 'ru' ? 'Действие подтверждено и применено.' : 'Action confirmed and applied.')
      await refreshUserData(memoryFilter.trim() || undefined, true).catch(() => {
        // The applied action is already reported; data refresh can be retried manually.
      })
    } catch (error) {
      const message = getErrorMessage(error, copy.fallbackError)
      setErrorMessage(message)
    } finally {
      setConfirmingAgentAction(false)
    }
  }

  function handleCancelAgentAction() {
    setPendingAgentAction(null)
    setToastMessage(preferences.language === 'ru' ? 'Действие отменено.' : 'Action canceled.')
  }

  async function rereadAgentActionEntity(result: AgentActionResult): Promise<AgentUserDataEntitySummary | null> {
    const kind = getEntityKindForAgentAction(result.type)
    if (!kind || !result.entityId) {
      return null
    }

    return window.friday.backend.getUserDataEntity({ kind, id: result.entityId })
  }

  voiceQueryHandlerRef.current = (query: string) => {
    void handleSendText(query, 'voice', true)
  }

  function handleVoiceRuntimeEvent(event: VoiceRuntimeEvent) {
    if (event.event === 'transcript') {
      setAmbientTranscript(event.text)
      setAmbientVoiceDetail(
        event.echo
          ? preferences.language === 'ru'
            ? 'Похоже на эхо, не отправляю это в чат.'
            : 'Looks like echo, not sending it to chat.'
          : copy.ambientVoiceHearing,
      )
      return
    }

    if (event.event === 'listening') {
      setAmbientVoiceDetail(event.detail ?? copy.ambientVoiceListening)
      return
    }

    if (event.event === 'audio-level') {
      setAmbientVoiceDetail(
        event.speech
          ? copy.ambientVoiceHearing
          : preferences.language === 'ru'
            ? 'Микрофон активен, жду обращение "Пятница".'
            : 'Microphone is active, waiting for "Friday".',
      )
      return
    }

    if (event.event === 'speech-start') {
      setAmbientVoiceDetail(copy.ambientVoiceHearing)
      return
    }

    if (event.event === 'speech-end') {
      setAmbientVoiceDetail(preferences.language === 'ru' ? 'Речь закончилась, распознаю текст.' : 'Speech ended, transcribing.')
      return
    }

    if (event.event === 'wake') {
      const matchedWake = event.matched ?? voiceRuntimeConfig.wakeWord
      setAmbientVoiceDetail(copy.ambientVoiceWake)
      if (ambientWakeLoggedRef.current !== matchedWake) {
        ambientWakeLoggedRef.current = matchedWake
        void appendSystemFeedMessage(copy.ambientVoiceWakeLogged.replace('{wake}', matchedWake))
      }
      return
    }

    if (event.event === 'query') {
      setAmbientTranscript(event.query || event.text)
      setAmbientVoiceDetail(event.hotWindow ? copy.ambientVoiceFollowUp : copy.ambientVoiceQuery)
      ambientWakeLoggedRef.current = null
      if (event.query.trim()) {
        void appendSystemFeedMessage(copy.ambientVoiceQueryLogged.replace('{query}', event.query.trim()))
      }
      if (event.directed && event.query.trim()) {
        voiceQueryHandlerRef.current(event.query)
      }
      return
    }

    if (event.event === 'ready') {
      setAmbientVoiceDetail(event.detail ?? copy.ambientVoiceListening)
      return
    }

    if (event.event === 'diagnostics') {
      setAmbientVoiceDetail(event.detail)
      return
    }

    if (event.event === 'tts-start') {
      setAmbientVoiceDetail(copy.ambientVoiceSpeaking)
      return
    }

    if (event.event === 'tts-end') {
      setAmbientVoiceDetail(copy.ambientVoiceFollowUp)
      return
    }

    if (event.event === 'error') {
      setAmbientVoiceDetail(event.detail)
      setErrorMessage(event.detail)
    }
  }

  async function handleStartRecording() {
    if (!safeState || busy || requestStatus === 'recording') {
      return
    }

    setErrorMessage(null)
    setToastMessage(null)
    setLiveTranscript('')
    liveTranscriptRef.current = ''
    voiceDraftBaseRef.current = draftInput
    setRequestStatus('checking_gateway')

    try {
      const { sessionId } = await window.friday.voice.startSession()
      voiceSessionIdRef.current = sessionId
      voiceChunkQueueRef.current = Promise.resolve()

      await recorderRef.current?.start((samples, sampleRate) => {
        const activeSessionId = voiceSessionIdRef.current
        if (!activeSessionId) {
          return
        }

        voiceChunkQueueRef.current = voiceChunkQueueRef.current
          .then(async () => {
            const result = await window.friday.voice.pushAudio({
              sessionId: activeSessionId,
              samples,
              sampleRate,
            })

            if (voiceSessionIdRef.current !== activeSessionId) {
              return
            }

            const transcript = result.transcript.trim()
            if (transcript === liveTranscriptRef.current) {
              return
            }

            liveTranscriptRef.current = transcript
            setLiveTranscript(transcript)
          })
          .catch((error) => {
            setRequestStatus('error')
            setErrorMessage(getErrorMessage(error, copy.fallbackError))
          })
      })
      setRequestStatus('recording')
    } catch (error) {
      if (voiceSessionIdRef.current) {
        await window.friday.voice.cancelSession({ sessionId: voiceSessionIdRef.current })
        voiceSessionIdRef.current = null
      }

      setRequestStatus('error')
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    }
  }

  async function handleStopRecording() {
    if (!safeState || requestStatus !== 'recording') {
      return
    }

    try {
      setRequestStatus('transcribing')
      const activeSessionId = voiceSessionIdRef.current
      if (!activeSessionId) {
        throw new Error(copy.fallbackError)
      }

      await recorderRef.current?.stop()
      await voiceChunkQueueRef.current

      const result = await window.friday.voice.finishSession({ sessionId: activeSessionId })
      voiceSessionIdRef.current = null

      const transcript = result.transcript.trim() || liveTranscriptRef.current
      const nextDraft = mergeDraftWithTranscript(voiceDraftBaseRef.current, transcript)
      await persist(withDraft(withLastTranscript(safeState, transcript), nextDraft))
      setDraftInput(nextDraft)
      setLiveTranscript('')
      liveTranscriptRef.current = ''
      if (composerRef.current) {
        composerRef.current.value = nextDraft
        composerRef.current.focus()
        const caret = nextDraft.length
        composerRef.current.setSelectionRange(caret, caret)
      }

      setToastMessage(copy.transcriptReady)
      setRequestStatus('completed')
      startTransition(() => setActiveView('chat'))
    } catch (error) {
      if (voiceSessionIdRef.current) {
        await window.friday.voice.cancelSession({ sessionId: voiceSessionIdRef.current })
        voiceSessionIdRef.current = null
      }

      const message = getErrorMessage(error, copy.fallbackError)
      await persist(
        appendMessages(
          safeState,
          createMessage({
            sessionId: safeState.sessionId,
            role: 'system',
            text: message,
            source: 'voice',
          }),
        ),
      )
      setRequestStatus('error')
      setErrorMessage(message)
    }
  }

  function handleVoicePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || composerLocked || requestStatus === 'recording') {
      return
    }

    pendingVoiceStopRef.current = false
    activeVoicePointerIdRef.current = event.pointerId
    if ('setPointerCapture' in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    void handleStartRecording()
  }

  function handleVoicePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (activeVoicePointerIdRef.current !== event.pointerId) {
      return
    }

    activeVoicePointerIdRef.current = null
    if ('hasPointerCapture' in event.currentTarget && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (requestStatus === 'recording') {
      void handleStopRecording()
      return
    }

    pendingVoiceStopRef.current = true
  }

  function handleVoicePointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    if (activeVoicePointerIdRef.current !== event.pointerId) {
      return
    }

    activeVoicePointerIdRef.current = null
    if ('hasPointerCapture' in event.currentTarget && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (requestStatus === 'recording') {
      void handleStopRecording()
      return
    }

    pendingVoiceStopRef.current = true
  }

  function handleVoiceButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if ((event.key !== ' ' && event.key !== 'Enter') || keyboardVoiceHoldRef.current || composerLocked) {
      return
    }

    event.preventDefault()
    pendingVoiceStopRef.current = false
    keyboardVoiceHoldRef.current = true
    void handleStartRecording()
  }

  function handleVoiceButtonKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if ((event.key !== ' ' && event.key !== 'Enter') || !keyboardVoiceHoldRef.current) {
      return
    }

    event.preventDefault()
    keyboardVoiceHoldRef.current = false
    if (requestStatus === 'recording') {
      void handleStopRecording()
      return
    }

    pendingVoiceStopRef.current = true
  }

  async function handleNewChat() {
    const currentPreferences = safeState?.preferences ?? createDefaultPreferences()
    const { sessionId } = await window.friday.chat.newSession()
    const freshState = hydrateState({
      ...createEmptyState(sessionId),
      preferences: currentPreferences,
    })

    await persist(freshState)
    setErrorMessage(null)
    setRequestStatus('idle')
    startTransition(() => setActiveView('chat'))
  }

  async function handleRetry() {
    if (!lastUserMessage) {
      return
    }

    await handleSendText(lastUserMessage.text)
  }

  async function handleCopyLastReply() {
    if (!lastAssistantMessage) {
      setToastMessage(copy.noReplyToCopy)
      return
    }

    try {
      await navigator.clipboard.writeText(lastAssistantMessage.text)
      setToastMessage(copy.copyReady)
    } catch {
      setToastMessage(copy.noReplyToCopy)
    }
  }

  function handleDraftChange(value: string) {
    setDraftInput(value)
    setAppState((currentState) => (currentState ? withDraft(hydrateState(currentState), value) : currentState))
  }

  async function handlePreferenceChange<K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) {
    if (!safeState) {
      return
    }

    await persist(
      withPreferences(safeState, {
        ...safeState.preferences,
        [key]: value,
      }),
    )
  }

  async function handleSaveAgentMailConfig() {
    try {
      const saved = await window.friday.agentmail.saveConfig({
        apiKey: agentMailKeyDraft,
        enabled: true,
      })
      setAgentMailConfig(saved)
      setAgentMailKeyDraft(saved.apiKey)
      setToastMessage(preferences.language === 'ru' ? 'AgentMail ключ обновлен.' : 'AgentMail key updated.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    }
  }

  async function handleInstallAgentMailSkill() {
    setAgentMailInstalling(true)
    setErrorMessage(null)

    try {
      const result = await window.friday.agentmail.installSkill()
      const nextConfig = await window.friday.agentmail.getConfig()
      setAgentMailConfig(nextConfig)
      setAgentMailKeyDraft(nextConfig.apiKey)
      setToastMessage(
        result.installed
          ? (preferences.language === 'ru' ? 'AgentMail skill установлен.' : 'AgentMail skill installed.')
          : result.detail,
      )
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setAgentMailInstalling(false)
    }
  }

  async function handleSaveTelegramConfig(enabled = telegramState.enabled) {
    setTelegramBusy(true)
    setErrorMessage(null)
    try {
      const saved = await window.friday.telegram.saveConfig({
        botToken: telegramTokenDraft,
        enabled,
        linkedUsers: telegramConfig.linkedUsers,
      })
      const nextState = enabled ? await window.friday.telegram.start() : await window.friday.telegram.stop()
      setTelegramConfig(saved)
      setTelegramTokenDraft(saved.botToken)
      setTelegramState(nextState)
      setToastMessage(preferences.language === 'ru' ? 'Telegram remote обновлен.' : 'Telegram remote updated.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setTelegramBusy(false)
    }
  }

  async function handleTelegramToggle(enabled: boolean) {
    await handleSaveTelegramConfig(enabled)
  }

  async function handleCreateTelegramPairCode() {
    setTelegramBusy(true)
    setErrorMessage(null)
    try {
      const code = await window.friday.telegram.createPairCode()
      setTelegramPairCode(code)
      const nextState = await window.friday.telegram.getState()
      setTelegramState(nextState)
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setTelegramBusy(false)
    }
  }

  async function handleRemoveTelegramUser(id: number) {
    setTelegramBusy(true)
    setErrorMessage(null)
    try {
      const nextState = await window.friday.telegram.removeUser(id)
      const nextConfig = await window.friday.telegram.getConfig()
      setTelegramState(nextState)
      setTelegramConfig(nextConfig)
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setTelegramBusy(false)
    }
  }

  async function handleToggleAmbientVoice(enabled: boolean) {
    setVoiceRuntimeBusy(true)
    setErrorMessage(null)
    try {
      const nextConfig = await window.friday.voice.saveRuntimeConfig({
        ...voiceRuntimeConfig,
        ambientEnabled: enabled,
      })
      setVoiceRuntimeConfig(nextConfig)
      if (enabled) {
        await window.friday.voice.startAmbient()
        setAmbientVoiceDetail(copy.ambientVoiceListening)
      } else {
        await window.friday.voice.stopAmbient()
        setAmbientVoiceDetail(copy.ambientVoiceIdle)
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setVoiceRuntimeBusy(false)
    }
  }

  async function handleInstallVoiceRuntime() {
    setVoiceRuntimeBusy(true)
    setErrorMessage(null)
    try {
      const result = await window.friday.voice.installRuntime()
      setAmbientVoiceDetail(result.detail)
      await refreshDiagnostics()
    } catch (error) {
      setErrorMessage(getErrorMessage(error, copy.fallbackError))
    } finally {
      setVoiceRuntimeBusy(false)
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!preferences.enterToSend || event.key !== 'Enter' || event.shiftKey) {
      return
    }

    event.preventDefault()
    void handleSendText(composerRef.current?.value ?? composerValue)
  }
  if (!backendSession) {
    return (
      <div className="window-frame">
        <header className="window-bar">
          <div className="window-title" />
          <div className="window-controls">
            <button
              type="button"
              className="traffic-button traffic-close"
              aria-label="Закрыть окно"
              onClick={() => void handleWindowAction('close')}
            />
            <button
              type="button"
              className="traffic-button traffic-minimize"
              aria-label="Свернуть окно"
              onClick={() => void handleWindowAction('minimize')}
            />
            <button
              type="button"
              className={`traffic-button traffic-maximize ${windowState.isMaximized ? 'traffic-active' : ''}`}
              aria-label="Развернуть окно"
              onClick={() => void handleWindowAction('toggleMaximize')}
            />
          </div>
        </header>
        <div className="boot-shell">
          <section className="boot-panel">
            <h1>{copy.appName}</h1>
            <p className="boot-copy">
              {preferences.language === 'ru'
                ? 'Подготавливаем локальную сессию, память и подключенные сервисы Friday.'
                : 'Preparing the Friday local session, memory, and connected services.'}
            </p>
          </section>
        </div>
      </div>
    )
  }

  if (!backendSession.session) {
    return (
      <div className="window-frame">
        <header className="window-bar">
          <div className="window-title" />
          <div className="window-controls">
            <button
              type="button"
              className="traffic-button traffic-close"
              aria-label="Закрыть окно"
              onClick={() => void handleWindowAction('close')}
            />
            <button
              type="button"
              className="traffic-button traffic-minimize"
              aria-label="Свернуть окно"
              onClick={() => void handleWindowAction('minimize')}
            />
            <button
              type="button"
              className={`traffic-button traffic-maximize ${windowState.isMaximized ? 'traffic-active' : ''}`}
              aria-label="Развернуть окно"
              onClick={() => void handleWindowAction('toggleMaximize')}
            />
          </div>
        </header>
        <div className="boot-shell">
          <section className="boot-panel">
            <h1>{copy.appName}</h1>
            <p className="boot-copy">
              {preferences.language === 'ru'
                ? 'Войдите в аккаунт экосистемы. После входа Пятница будет работать только с данными этого пользователя.'
                : 'Sign in with your ecosystem account. Friday will then use only that user context.'}
            </p>

            <label className="settings-field">
              <span>Email</span>
              <input
                type="email"
                className="settings-input"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                spellCheck={false}
                autoComplete="username"
              />
            </label>

            <label className="settings-field">
              <span>{preferences.language === 'ru' ? 'Пароль' : 'Password'}</span>
              <input
                type="password"
                className="settings-input"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                autoComplete="current-password"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !authBusy) {
                    void handleLogin()
                  }
                }}
              />
            </label>

            {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

            <div className="settings-actions">
              <button type="button" className="sidebar-action" onClick={() => void handleLogin()} disabled={authBusy}>
                {authBusy ? (preferences.language === 'ru' ? 'Вход...' : 'Signing in...') : preferences.language === 'ru' ? 'Войти' : 'Sign in'}
              </button>
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="window-frame">
      <header className="window-bar">
        <div className="window-title" />
        <div className="window-controls">
          <button
            type="button"
            className="traffic-button traffic-close"
            aria-label="Закрыть окно"
            onClick={() => void handleWindowAction('close')}
          />
          <button
            type="button"
            className="traffic-button traffic-minimize"
            aria-label="Свернуть окно"
            onClick={() => void handleWindowAction('minimize')}
          />
          <button
            type="button"
            className={`traffic-button traffic-maximize ${windowState.isMaximized ? 'traffic-active' : ''}`}
            aria-label={windowState.isMaximized ? 'Восстановить окно' : 'Развернуть окно'}
            onClick={() => void handleWindowAction('toggleMaximize')}
          />
        </div>
      </header>

      <div className="friday-shell">
        <aside className="rail" aria-label="Главное меню">
          <div className="rail-brand">
            <button type="button" className="rail-logo" aria-label={copy.appName} onClick={() => setActiveView('chat')}>
              <span className="orb orb-large" />
            </button>
            <div className="rail-brand-copy">
              <h1>{brandTitle}</h1>
            </div>
          </div>

          <nav className="rail-nav">
            <NavButton
              label={homeLabel}
              active={activeView === 'chat'}
              onClick={() => setActiveView('chat')}
              icon="home"
            />
            <NavButton
              label={memoryLabel}
              active={activeView === 'user-data'}
              onClick={() => setActiveView('user-data')}
              icon="memory"
            />
            <NavButton
              label={copy.mainSettings}
              active={activeView === 'settings'}
              onClick={() => setActiveView('settings')}
              icon="settings"
            />
          </nav>

          <div className="rail-footer">
            <span className={`status-pill status-${tone}`}>
              <span className={`presence-dot dot-${diagnostics.gateway.status}`} />
              {requestStatus === 'recording' ? copy.stopVoice : railStatusLabel}
            </span>
          </div>
        </aside>

        <aside className="sidebar-panel">
          {activeView === 'chat' ? (
            <>
              <section className="sidebar-card sidebar-card-log">
                <div className="sidebar-card-head">
                  <span>{agentLogsLabel}</span>
                  <button type="button" className="ghost-action overview-refresh" onClick={() => void handleNewChat()} disabled={busy}>
                    {copy.newChat}
                  </button>
                </div>
                <div className="activity-log-list">
                  {activityLogItems.map((item) => (
                    <article key={item.id} className={`activity-log-item activity-log-${item.status}`}>
                      <span className={`activity-log-dot dot-${item.status}`} />
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.detail}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section className="sidebar-card">
                <div className="sidebar-card-head">
                  <span>{systemLabel}</span>
                  <button type="button" className="text-action" onClick={() => void refreshDiagnostics()}>
                    {copy.refresh}
                  </button>
                </div>
                <div className="metric-list">
                  {systemMetrics.map((metric) => (
                    <MetricBar key={metric.id} metric={metric} />
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {activeView === 'settings' ? (
            <>
              <div className="sidebar-header">
                <div>
                  <p className="sidebar-kicker">{copy.appTagline}</p>
                  <h1>{brandTitle}</h1>
                </div>
                <button type="button" className="sidebar-action" onClick={() => void handleNewChat()} disabled={busy}>
                  {copy.newChat}
                </button>
              </div>

              <section className="sidebar-card">
                <div className="sidebar-card-head">
                  <span>{copy.settingsCompactTitle}</span>
                </div>
                <div className="setting-mini-list">
                  <MiniSetting label={copy.theme} value={labelForTheme(preferences.theme, preferences.language)} />
                  <MiniSetting label={copy.language} value={labelForLanguage(preferences.language, preferences.language)} />
                  <MiniSetting label={copy.density} value={labelForDensity(preferences.density, preferences.language)} />
                </div>
              </section>

              <section className="sidebar-card">
                <div className="sidebar-card-head">
                  <span>{copy.transcriptTitle}</span>
                </div>
                <div className="setting-mini-list">
                  <MiniSetting
                    label={copy.autoRecover}
                    value={preferences.autoRecover ? copy.enabled : copy.disabled}
                  />
                  <MiniSetting
                    label={copy.lastTranscript}
                    value={safeState?.lastTranscript ?? copy.transcriptEmpty}
                    multiline
                  />
                </div>
                <div className="sidebar-actions-stack">
                  <button type="button" className="ghost-action" onClick={() => void refreshDiagnostics()}>
                    {copy.refresh}
                  </button>
                </div>
              </section>
            </>
          ) : null}

          {activeView === 'user-data' ? (
            <>
              <div className="sidebar-header">
                <div>
                  <p className="sidebar-kicker">{copy.appTagline}</p>
                  <h1>{copy.memory}</h1>
                </div>
                <button type="button" className="sidebar-action" onClick={() => void refreshUserData(memoryFilter.trim() || undefined, true)} disabled={userDataLoading}>
                  {copy.refresh}
                </button>
              </div>

              <section className="sidebar-card">
                <div className="sidebar-card-head">
                  <span>{copy.memoryCount}</span>
                </div>
                <div className="setting-mini-list">
                  <MiniSetting label={copy.memoryCount} value={String(countUserDataObjects(userDataOverview, visibleMemories))} />
                  <MiniSetting
                    label={copy.memorySearch}
                    value={memoryFilter.trim() ? memoryFilter : (preferences.language === 'ru' ? 'Все данные' : 'All data')}
                    multiline
                  />
                </div>
              </section>

              <section className="sidebar-card">
                <div className="sidebar-card-head">
                  <span>{copy.overview}</span>
                </div>
                <div className="setting-mini-list">
                  <MiniSetting label={preferences.language === 'ru' ? 'Задачи' : 'Tasks'} value={String(userDataCounts?.tasks ?? 0)} />
                  <MiniSetting label={preferences.language === 'ru' ? 'Заметки' : 'Notes'} value={String(userDataCounts?.notes ?? 0)} />
                  <MiniSetting label={preferences.language === 'ru' ? 'Память' : 'Memory'} value={String(userDataCounts?.memories ?? visibleMemories.length)} />
                  <MiniSetting label={preferences.language === 'ru' ? 'Сигналы' : 'Signals'} value={String(userDataOverview?.recommendations.length ?? 0)} />
                </div>
              </section>
            </>
          ) : null}

          {LEGACY_MAIL_VIEW_ENABLED ? (
            <>
              <div className="sidebar-header">
                <div>
                  <p className="sidebar-kicker">{copy.appTagline}</p>
                  <h1>{copy.mail}</h1>
                </div>
                <button type="button" className="sidebar-action" onClick={() => void refreshMailData()} disabled={mailLoading}>
                  {copy.refresh}
                </button>
              </div>

              <section className="sidebar-card">
                <div className="sidebar-card-head">
                  <span>{copy.mailStatus}</span>
                </div>
                <div className="setting-mini-list">
                  <MiniSetting
                    label={copy.mailAddress}
                    value={mailAccount?.address || copy.mailNoAccount}
                    multiline
                  />
                  <MiniSetting
                    label={copy.mailStatus}
                    value={labelForMailStatus(mailAccount?.status ?? 'disconnected', preferences.language, copy)}
                  />
                  <MiniSetting
                    label={copy.mailUnread}
                    value={String(unreadMailCount)}
                  />
                </div>
              </section>

              <section className="sidebar-card">
                <div className="sidebar-card-head">
                  <span>{copy.overview}</span>
                </div>
                <div className="setting-mini-list">
                  <MiniSetting label={copy.mailFolderInbox} value={String(mailCounts.inbox)} />
                  <MiniSetting label={copy.mailFolderSent} value={String(mailCounts.sent)} />
                  <MiniSetting label={copy.mailFolderDrafts} value={String(mailCounts.drafts)} />
                  <MiniSetting
                    label={copy.mailLastSync}
                    value={
                      mailAccount?.lastSyncedAt
                        ? formatUpdatedAt(mailAccount?.lastSyncedAt ?? undefined, preferences.language, copy)
                        : (preferences.language === 'ru' ? 'Пока не синхронизировалось' : 'No sync yet')
                    }
                    multiline
                  />
                </div>
              </section>
            </>
          ) : null}
        </aside>

        <main className="content-panel">
        {activeView === 'chat' ? (
          <>
            <header className="content-header">
              <div>
                <p className="content-kicker">{copy.agentLabel}</p>
                <h2>{chatHeading}</h2>
              </div>
              <div className="header-actions">
                <button
                  type="button"
                  className="header-chip"
                  onClick={() => void handleCopyLastReply()}
                  disabled={!lastAssistantMessage}
                >
                  {copy.copyReply}
                </button>
                <button type="button" className="header-chip" onClick={() => void handleRetry()} disabled={!lastUserMessage || busy}>
                  {copy.retry}
                </button>
              </div>
            </header>

            <section className={`ambient-voice-banner ${ambientVoiceEnabled ? 'ambient-voice-banner-on' : ''}`} aria-live="polite">
              <div className="ambient-voice-head">
                <span className={`presence-dot ${ambientVoiceEnabled ? 'dot-ready' : 'dot-unknown'}`} />
                <strong>{copy.ambientVoiceTitle}</strong>
                <div className="ambient-voice-actions">
                  <button
                    type="button"
                    className="ghost-action ambient-voice-action"
                    onClick={() => void handleToggleAmbientVoice(!ambientVoiceEnabled)}
                    disabled={voiceRuntimeBusy}
                  >
                    {voiceRuntimeBusy
                      ? copy.ambientVoiceBusy
                      : ambientVoiceEnabled
                        ? copy.ambientVoiceDisable
                        : copy.ambientVoiceEnable}
                  </button>
                  {!ambientVoiceEnabled ? (
                    <button
                      type="button"
                      className="ghost-action ambient-voice-action"
                      onClick={() => void handleInstallVoiceRuntime()}
                      disabled={voiceRuntimeBusy}
                    >
                      {copy.ambientVoicePrepare}
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="ambient-voice-status">
                {ambientVoiceEnabled ? ambientVoiceDetail || copy.ambientVoiceListening : copy.ambientVoiceIdle}
              </p>
              <p className="ambient-voice-transcript">{ambientVoiceTranscriptLabel}</p>
            </section>

            <div className="conversation-feed" ref={chatFeedRef}>
              {deferredMessages.length > 0 ? (
                <>
                  {deferredMessages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      showTimestamps={preferences.showTimestamps}
                      language={preferences.language}
                    />
                  ))}
                  {agentProgress ? (
                    <AgentProgressCard
                      progress={agentProgress}
                      language={preferences.language}
                      clock={agentProgressClock}
                    />
                  ) : null}
                </>
              ) : (
                <div className="empty-state">
                  <div className="welcome-card">
                    <span className="orb orb-small" />
                    <div>
                      <p className="welcome-title">{copy.welcomeTitle}</p>
                      <p>{copy.welcomeBody}</p>
                    </div>
                  </div>
                  <div className="prompt-grid">
                    <button type="button" className="prompt-card" onClick={() => void handleSendText(copy.suggestionStatus)}>
                      {copy.suggestionStatus}
                    </button>
                    <button type="button" className="prompt-card" onClick={() => void handleSendText(copy.suggestionPlan)}>
                      {copy.suggestionPlan}
                    </button>
                    <button type="button" className="prompt-card" onClick={() => void handleSendText(copy.suggestionAction)}>
                      {copy.suggestionAction}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {pendingAgentAction ? (
              <section className="agent-confirmation-card" aria-live="polite">
                <div>
                  <p className="section-title">
                    {preferences.language === 'ru' ? 'Нужно подтверждение' : 'Confirmation required'}
                  </p>
                  <p className="section-copy">{pendingAgentAction.description}</p>
                  <p className="memory-meta">
                    {pendingAgentAction.irreversible
                      ? preferences.language === 'ru'
                        ? 'Необратимое действие'
                        : 'Irreversible action'
                      : preferences.language === 'ru'
                        ? 'Действие ожидает ручного запуска'
                        : 'Action is waiting for manual execution'}
                  </p>
                </div>
                <div className="confirmation-actions">
                  <button
                    type="button"
                    className="sidebar-action"
                    onClick={() => void handleConfirmAgentAction()}
                    disabled={confirmingAgentAction}
                  >
                    {confirmingAgentAction
                      ? preferences.language === 'ru'
                        ? 'Применяю...'
                        : 'Applying...'
                      : preferences.language === 'ru'
                        ? 'Подтвердить'
                        : 'Confirm'}
                  </button>
                  <button type="button" className="header-chip" onClick={handleCancelAgentAction} disabled={confirmingAgentAction}>
                    {preferences.language === 'ru' ? 'Отмена' : 'Cancel'}
                  </button>
                </div>
              </section>
            ) : null}

            <footer className="composer-shell">
              <div className="presence-bar">
                <div className="presence-row">
                  <span className={`presence-dot dot-${diagnostics.gateway.status}`} />
                  <span>{copy.activeNow}</span>
                  <span>{formatUpdatedAt(safeState?.updatedAt, preferences.language, copy)}</span>
                </div>
                <ModeSwitchChip
                  label={copy.gameMode}
                  stateLabel={gameModeStatusLabel}
                  checked={preferences.gameMode}
                  onChange={(checked) => void handlePreferenceChange('gameMode', checked)}
                />
              </div>

              <form
                className="composer-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSendText(composerRef.current?.value ?? composerValue)
                }}
              >
                <label className="sr-only" htmlFor="command-input">
                  {copy.messageLabel}
                </label>
                <textarea
                  key={safeState?.sessionId ?? 'loading'}
                  ref={composerRef}
                  id="command-input"
                  className="composer-input"
                  value={composerValue}
                  onChange={(event) => handleDraftChange(event.target.value)}
                  onInput={(event) => handleDraftChange((event.target as HTMLTextAreaElement).value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={composerPlaceholder}
                  rows={preferences.density === 'compact' ? 2 : 3}
                  disabled={composerLocked || requestStatus === 'recording'}
                />

                <div className="composer-tools">
                  <button
                    type="button"
                    className={`icon-button ${requestStatus === 'recording' ? 'icon-button-live' : ''}`}
                    aria-label={requestStatus === 'recording' ? copy.stopVoice : copy.voiceInput}
                    title={requestStatus === 'recording' ? copy.releaseToTranscribe : copy.holdToTalk}
                    onPointerDown={handleVoicePointerDown}
                    onPointerUp={handleVoicePointerUp}
                    onPointerCancel={handleVoicePointerCancel}
                    onKeyDown={handleVoiceButtonKeyDown}
                    onKeyUp={handleVoiceButtonKeyUp}
                    disabled={composerLocked}
                  >
                    <Icon name="mic" />
                  </button>
                  <button
                    type="button"
                    className="send-button"
                    aria-label={copy.send}
                    onClick={() => void handleSendText(composerRef.current?.value ?? composerValue)}
                    disabled={composerLocked || requestStatus === 'recording' || !composerValue.trim()}
                  >
                    <Icon name="send" />
                  </button>
                </div>
              </form>

              {requestStatus === 'recording' ? (
                <p className="helper-line">{liveTranscript ? liveTranscript : copy.releaseToTranscribe}</p>
              ) : null}
              {safeState?.lastTranscript ? (
                <p className="helper-line">
                  {copy.lastTranscript}: {safeState.lastTranscript}
                </p>
              ) : null}
              {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
              {toastMessage ? <p className="toast-banner">{toastMessage}</p> : null}
            </footer>          </>
        ) : null}

        {activeView === 'user-data' ? (
          <>
            <header className="content-header">
              <div>
                <p className="content-kicker">{copy.memory}</p>
                <h2>{copy.memoryTitle}</h2>
              </div>
              <div className="header-actions">
                <button
                  type="button"
                  className="header-chip"
                  onClick={() => void refreshUserData(memoryFilter.trim() || undefined, true)}
                  disabled={userDataLoading}
                >
                  {copy.refresh}
                </button>
              </div>
            </header>

            <section className="panel-grid memory-grid">
              <article className="info-card memory-search-card">
                <p className="section-title">{copy.memorySearch}</p>
                <p className="section-copy">{copy.memoryBody}</p>
                <label className="settings-field">
                  <span>{copy.memorySearch}</span>
                  <input
                    type="text"
                    className="settings-input"
                    value={memoryFilter}
                    onChange={(event) => setMemoryFilter(event.target.value)}
                    placeholder={copy.memorySearchPlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
                {userDataError || memoryError ? <p className="error-banner">{userDataError ?? memoryError}</p> : null}
              </article>

              <article className="info-card user-data-profile-card">
                <p className="section-title">{preferences.language === 'ru' ? 'Профиль' : 'Profile'}</p>
                <p className="section-copy">
                  {userDataContext
                    ? userDataContext.profile.displayName
                    : preferences.language === 'ru'
                      ? 'Войдите в аккаунт Экосистемы, чтобы увидеть профиль.'
                      : 'Sign in to the Ecosystem account to see the profile.'}
                </p>
                <div className="setting-mini-list">
                  <MiniSetting label="Email" value={userDataContext?.profile.email ?? '-'} multiline />
                  <MiniSetting label={preferences.language === 'ru' ? 'Язык' : 'Language'} value={userDataContext?.profile.settings.locale ?? preferences.language} />
                  <MiniSetting label={preferences.language === 'ru' ? 'Часовой пояс' : 'Timezone'} value={userDataContext?.profile.settings.timezone ?? '-'} />
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'Сгенерировано' : 'Generated'}
                    value={userDataOverview ? formatUpdatedAt(userDataOverview.generatedAt, preferences.language, copy) : '-'}
                  />
                </div>
              </article>

              <article className="info-card user-data-summary-card">
                <p className="section-title">{preferences.language === 'ru' ? 'Обзор' : 'Overview'}</p>
                <div className="user-data-stat-grid">
                  {buildUserDataStats(userDataOverview, visibleMemories, preferences.language).map((stat) => (
                    <div key={stat.label} className="user-data-stat">
                      <strong>{stat.value}</strong>
                      <span>{stat.label}</span>
                    </div>
                  ))}
                </div>
              </article>

              <article className="info-card user-data-signals-card">
                <p className="section-title">{preferences.language === 'ru' ? 'Сигналы агента' : 'Agent signals'}</p>
                {userDataOverview?.recommendations.length ? (
                  <div className="user-data-list">
                    {userDataOverview.recommendations.slice(0, 4).map((signal) => (
                      <div key={`${signal.code}-${signal.createdAt}`} className="user-data-row">
                        <strong>{signal.title}</strong>
                        <span>{signal.body}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="section-copy">
                    {preferences.language === 'ru' ? 'Пока нет срочных рекомендаций.' : 'No urgent recommendations yet.'}
                  </p>
                )}
              </article>

              {filteredUserDataItems.length > 0 ? (
                filteredUserDataItems.map((item) => (
                  <article key={item.id} className="info-card memory-card">
                    <div className="memory-card-head">
                      <div>
                        <p className="section-title">{item.title}</p>
                        <p className="memory-meta">
                          {item.kindLabel} · {copy.memoryUpdated}: {formatUpdatedAt(item.updatedAt, preferences.language, copy)}
                        </p>
                      </div>
                      <div className="memory-card-actions">
                        <span className="memory-badge">{item.kind}</span>
                      </div>
                    </div>

                    <div className="setting-mini-list">
                      <MiniSetting label={copy.memoryCategory} value={item.kindLabel} />
                      <MiniSetting label={copy.memorySummaryLabel} value={item.summary} multiline />
                      {item.detail ? <MiniSetting label={copy.memoryContentLabel} value={item.detail} multiline /> : null}
                    </div>

                    {item.memory ? (
                      <div className="memory-card-footer">
                        <button
                          type="button"
                          className="ghost-action memory-delete-button memory-delete-button-wide"
                          onClick={() => void handleDeleteMemory(item.memory!)}
                          disabled={deletingMemoryIds.some((id) => item.memory?.mergedIds.includes(id))}
                        >
                          {preferences.language === 'ru' ? 'Удалить запись из памяти' : 'Delete memory entry'}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))
              ) : (
                <article className="info-card memory-empty-card">
                  <p className="section-title">{copy.memory}</p>
                  <p className="section-copy">
                    {memoryFilter.trim() ? copy.memoryNoResults : copy.memoryEmpty}
                  </p>
                </article>
              )}
            </section>
          </>
        ) : null}

        {LEGACY_MAIL_VIEW_ENABLED ? (
          <>
            <header className="content-header">
              <div>
                <p className="content-kicker">{copy.mail}</p>
                <h2>{copy.mailTitle}</h2>
              </div>
              <div className="header-actions">
                <button type="button" className="header-chip" onClick={() => void refreshMailData()} disabled={mailLoading}>
                  {copy.refresh}
                </button>
              </div>
            </header>

            <section className="mail-workspace">
              <aside className="info-card mail-folders-pane">
                <div className="mail-account-block">
                  <p className="section-title">{mailConnectedAsLabel}</p>
                  <p className="mail-account-address">{mailAccount?.address || copy.mailNoAccount}</p>
                  <p className="section-copy">{mailAccount?.detail || copy.mailBody}</p>
                  <div className="setting-mini-list">
                    <MiniSetting
                      label={copy.mailStatus}
                      value={labelForMailStatus(mailAccount?.status ?? 'disconnected', preferences.language, copy)}
                    />
                    <MiniSetting
                      label={copy.mailLastSync}
                      value={
                        mailAccount?.lastSyncedAt
                          ? formatUpdatedAt(mailAccount?.lastSyncedAt ?? undefined, preferences.language, copy)
                          : preferences.language === 'ru'
                            ? 'Ещё не синхронизировано'
                            : 'Not synced yet'
                      }
                    />
                  </div>
                </div>

                <div className="mail-sidebar-actions">
                  <button type="button" className="sidebar-action" onClick={() => setMailInspectorMode('compose')}>
                    {mailComposeActionLabel}
                  </button>
                  <button type="button" className="header-chip" onClick={handleCreateMailContact}>
                    {mailContactAddLabel}
                  </button>
                  <button type="button" className="header-chip" onClick={() => setMailInspectorMode('settings')}>
                    {mailSetupActionLabel}
                  </button>
                </div>

                <div className="mail-folder-nav">
                  <p className="section-title">{mailFoldersLabel}</p>
                  {(['inbox', 'sent', 'drafts'] as AgentMailFolder[]).map((folder) => (
                    <button
                      key={folder}
                      type="button"
                      className={`mail-folder-button ${mailFolder === folder ? 'mail-folder-button-active' : ''}`}
                      onClick={() => setMailFolder(folder)}
                    >
                      <span>{labelForMailFolder(folder, copy)}</span>
                      <span className="mail-folder-count">
                        {folder === 'inbox' ? unreadMailCount || mailCounts[folder] : mailCounts[folder]}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mail-sidebar-section">
                  <div className="card-title-row">
                    <div>
                      <p className="section-title">{mailContactsLabel}</p>
                      <p className="section-copy">
                        {preferences.language === 'ru'
                          ? 'Быстрые получатели для агента.'
                          : 'Saved recipients for the agent.'}
                      </p>
                    </div>
                    <button type="button" className="header-chip" onClick={() => setMailInspectorMode('contacts')}>
                      {preferences.language === 'ru' ? 'Управлять' : 'Manage'}
                    </button>
                  </div>

                  {mailContacts.length > 0 ? (
                    <div className="mail-contact-compact-list">
                      {mailContacts.slice(0, 6).map((contact) => (
                        <article key={contact.id} className="mail-contact-compact-card">
                          <div className="mail-contact-compact-top">
                            <div>
                              <p className="section-title">{contact.name}</p>
                              <p className="memory-meta">{contact.email}</p>
                            </div>
                            <button type="button" className="header-chip" onClick={() => handleUseMailContact(contact)}>
                              {mailContactUseLabel}
                            </button>
                          </div>
                          {contact.aliases.length > 0 ? (
                            <p className="section-copy">{contact.aliases.join(', ')}</p>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="mail-empty-actions">
                      <p className="section-copy">{mailContactEmptyLabel}</p>
                      <button type="button" className="sidebar-action" onClick={handleCreateMailContact}>
                        {mailContactAddLabel}
                      </button>
                    </div>
                  )}
                </div>

                {mailError ? <p className="error-banner">{mailError}</p> : null}
              </aside>

              <article className="info-card mail-list-pane">
                <div className="card-title-row">
                  <div>
                    <p className="section-title">{mailMessagesLabel}</p>
                    <p className="section-copy">{copy.mailSetupBody}</p>
                  </div>
                  <span className="memory-badge">
                    {filteredMailMessages.length} {preferences.language === 'ru' ? 'шт.' : 'items'}
                  </span>
                </div>

                {filteredMailMessages.length > 0 ? (
                  <div className="mail-thread-list">
                    {filteredMailMessages.map((message) => (
                      <button
                        key={message.id}
                        type="button"
                        className={`mail-thread-row ${
                          selectedMailMessage?.id === message.id ? 'mail-thread-row-active' : ''
                        } ${!message.isRead && message.folder === 'inbox' ? 'mail-thread-row-unread' : ''}`}
                        onClick={() => void handleSelectMailMessage(message)}
                      >
                        <div className="mail-thread-row-top">
                          <div className="mail-thread-row-author">
                            {!message.isRead && message.folder === 'inbox' ? <span className="mail-unread-dot" /> : null}
                            <span>{getPrimaryMailAddress(message)}</span>
                          </div>
                          <span className="memory-meta">
                            {formatUpdatedAt(message.receivedAt ?? message.sentAt ?? message.createdAt, preferences.language, copy)}
                          </span>
                        </div>
                        <div className="mail-thread-row-subject">{message.subject}</div>
                        <div className="mail-thread-row-preview">{getMailPreviewText(message)}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mail-empty-panel">
                    <p className="section-title">{copy.mailEmpty}</p>
                    <p className="section-copy">{copy.mailComposerBody}</p>
                  </div>
                )}
              </article>

              <article className="info-card mail-reader-pane">
                {mailInspectorMode === 'contacts' ? (
                  <div className="mail-panel-stack">
                    <div className="card-title-row">
                      <div>
                        <p className="section-title">{mailContactsLabel}</p>
                        <p className="section-copy">
                          {preferences.language === 'ru'
                            ? 'Сохраняйте имена, алиасы и почты. Агент сможет искать адрес по слову вроде "босс" или "Андрей".'
                            : 'Save names, aliases, and emails so the agent can resolve recipients like "boss" or "Andrey".'}
                        </p>
                      </div>
                    </div>

                    <div className="mail-contacts-layout">
                      <div className="mail-contacts-section">
                        <label className="settings-field">
                          <span>{preferences.language === 'ru' ? 'Имя контакта' : 'Contact name'}</span>
                          <input
                            type="text"
                            className="settings-input"
                            value={mailContactNameInput}
                            onChange={(event) => setMailContactNameInput(event.target.value)}
                            placeholder={preferences.language === 'ru' ? 'Босс' : 'Boss'}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </label>

                        <label className="settings-field">
                          <span>{preferences.language === 'ru' ? 'Email контакта' : 'Contact email'}</span>
                          <input
                            type="email"
                            className="settings-input"
                            value={mailContactEmailInput}
                            onChange={(event) => setMailContactEmailInput(event.target.value)}
                            placeholder="boss@example.com"
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </label>

                        <label className="settings-field">
                          <span>{mailContactAliasLabel}</span>
                          <input
                            type="text"
                            className="settings-input"
                            value={mailContactAliasesInput}
                            onChange={(event) => setMailContactAliasesInput(event.target.value)}
                            placeholder={preferences.language === 'ru' ? 'шеф, boss, директор' : 'chief, boss, director'}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </label>

                        <label className="settings-field">
                          <span>{mailContactNotesLabel}</span>
                          <textarea
                            className="settings-input"
                            value={mailContactNotesInput}
                            onChange={(event) => setMailContactNotesInput(event.target.value)}
                            placeholder={preferences.language === 'ru' ? 'Кто это и зачем писать' : 'Who this is and when to write'}
                            rows={4}
                          />
                        </label>

                        <div className="settings-actions">
                          <button type="button" className="sidebar-action" onClick={() => void handleSaveMailContact()} disabled={mailSaving || !mailAccount}>
                            {mailSaving ? copy.refresh : editingMailContactId ? mailContactUpdateLabel : mailContactSaveLabel}
                          </button>
                          <button type="button" className="header-chip" onClick={resetMailContactForm}>
                            {mailContactCancelLabel}
                          </button>
                        </div>
                      </div>

                      <div className="mail-contact-list">
                        {mailContacts.length > 0 ? (
                          mailContacts.map((contact) => (
                            <article key={contact.id} className="mail-contact-card">
                              <div className="mail-contact-card-top">
                                <div>
                                  <p className="section-title">{contact.name}</p>
                                  <p className="memory-meta">{contact.email}</p>
                                </div>
                                <div className="memory-card-actions">
                                  <button type="button" className="header-chip" onClick={() => handleUseMailContact(contact)}>
                                    {mailContactUseLabel}
                                  </button>
                                  <button type="button" className="header-chip" onClick={() => handleEditMailContact(contact)}>
                                    {mailContactEditLabel}
                                  </button>
                                  <button type="button" className="header-chip memory-delete-button" onClick={() => void handleDeleteMailContact(contact)}>
                                    {preferences.language === 'ru' ? 'Удалить' : 'Delete'}
                                  </button>
                                </div>
                              </div>
                              {contact.aliases.length > 0 ? (
                                <MiniSetting label={mailContactAliasLabel} value={contact.aliases.join(', ')} multiline />
                              ) : null}
                              {contact.notes ? <MiniSetting label={mailContactNotesLabel} value={contact.notes} multiline /> : null}
                            </article>
                          ))
                        ) : (
                          <div className="mail-empty-panel">
                            <p className="section-copy">{mailContactEmptyLabel}</p>
                            <button type="button" className="sidebar-action" onClick={handleCreateMailContact}>
                              {mailContactAddLabel}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : mailInspectorMode === 'settings' ? (
                  <div className="mail-panel-stack">
                    <div>
                      <p className="section-title">{copy.mailSetupTitle}</p>
                      <p className="section-copy">{copy.mailBody}</p>
                    </div>

                    <label className="settings-field">
                      <span>{copy.mailAddress}</span>
                      <input
                        type="email"
                        className="settings-input"
                        value={mailAddressInput}
                        onChange={(event) => setMailAddressInput(event.target.value)}
                        placeholder="fridayagentauto@agentmail.to"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </label>

                    <label className="settings-field">
                      <span>{copy.mailDisplayName}</span>
                      <input
                        type="text"
                        className="settings-input"
                        value={mailDisplayNameInput}
                        onChange={(event) => setMailDisplayNameInput(event.target.value)}
                        placeholder="Friday"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </label>

                    <label className="settings-field">
                      <span>{copy.mailInboxId}</span>
                      <input
                        type="text"
                        className="settings-input"
                        value={mailInboxIdInput}
                        onChange={(event) => setMailInboxIdInput(event.target.value)}
                        placeholder="fridayagentauto@agentmail.to"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </label>

                    <div className="settings-actions">
                      <button type="button" className="sidebar-action" onClick={() => void handleSaveMailAccount()} disabled={mailSaving}>
                        {mailSaving ? copy.refresh : copy.mailSave}
                      </button>
                    </div>

                    <p className="helper-line">{copy.mailInstallHint}</p>
                  </div>
                ) : mailInspectorMode === 'compose' ? (
                  <div className="mail-panel-stack">
                    <div>
                      <p className="section-title">{copy.mailComposerTitle}</p>
                      <p className="section-copy">{copy.mailComposerBody}</p>
                    </div>

                    <label className="settings-field">
                      <span>{copy.mailRecipient}</span>
                      <input
                        type="text"
                        className="settings-input"
                        value={mailRecipientInput}
                        onChange={(event) => setMailRecipientInput(event.target.value)}
                        placeholder="friend@example.com"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </label>

                    <label className="settings-field">
                      <span>{copy.mailSubject}</span>
                      <input
                        type="text"
                        className="settings-input"
                        value={mailSubjectInput}
                        onChange={(event) => setMailSubjectInput(event.target.value)}
                        placeholder={preferences.language === 'ru' ? 'Тема письма' : 'Email subject'}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </label>

                    <label className="settings-field">
                      <span>{copy.mailMessage}</span>
                      <textarea
                        className="settings-input mail-textarea"
                        value={mailBodyInput}
                        onChange={(event) => setMailBodyInput(event.target.value)}
                        placeholder={preferences.language === 'ru' ? 'Напишите письмо от лица агента...' : 'Write the message as the agent...'}
                        spellCheck={true}
                        rows={10}
                      />
                    </label>

                    {mailContacts.length > 0 ? (
                      <div className="mail-quick-contacts">
                        <p className="section-title">{mailContactsLabel}</p>
                        <div className="mail-quick-contact-chips">
                          {mailContacts.slice(0, 8).map((contact) => (
                            <button key={contact.id} type="button" className="header-chip" onClick={() => handleUseMailContact(contact)}>
                              {contact.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="settings-actions">
                      <button type="button" className="sidebar-action" onClick={() => void handleSendMailMessage()} disabled={mailSending || !mailAccount}>
                        {mailSending ? copy.refresh : copy.mailSendNow}
                      </button>
                    </div>
                  </div>
                ) : selectedMailMessage ? (
                  <div className="mail-panel-stack">
                    <div className="mail-reader-header">
                      <div>
                        <p className="section-title">{selectedMailMessage.subject}</p>
                        <p className="memory-meta">
                          {formatUpdatedAt(
                            selectedMailMessage.receivedAt ?? selectedMailMessage.sentAt ?? selectedMailMessage.createdAt,
                            preferences.language,
                            copy,
                          )}
                        </p>
                      </div>
                      {mailReading ? <span className="memory-badge">{copy.refresh}</span> : null}
                    </div>

                    <div className="mail-reader-grid">
                      <MiniSetting label={mailFromLabel} value={selectedMailMessage.fromName || selectedMailMessage.fromAddress} multiline />
                      <MiniSetting label={mailToLabel} value={selectedMailMessage.toAddresses.join(', ') || selectedMailMessage.fromAddress} multiline />
                      <MiniSetting label={copy.mailStatus} value={labelForMailFolder(selectedMailMessage.folder, copy)} />
                      <MiniSetting label={mailPreviewLabel} value={getMailPreviewText(selectedMailMessage)} multiline />
                    </div>

                    <div className="mail-body-card">
                      <p className="section-title">{copy.mailMessage}</p>
                      <div className="mail-body-text">{getMailBodyText(selectedMailMessage) || getMailPreviewText(selectedMailMessage)}</div>
                    </div>
                  </div>
                ) : (
                  <div className="mail-empty-panel">
                    <p className="section-title">{mailEmptySelectionTitle}</p>
                    <p className="section-copy">{mailEmptySelectionBody}</p>
                  </div>
                )}
              </article>
            </section>
          </>
        ) : null}

        {activeView === 'settings' ? (
          <>
            <header className="content-header">
              <div>
                <p className="content-kicker">{copy.mainSettings}</p>
                <h2>{copy.mainSettingsTitle}</h2>
              </div>
            </header>

            <section className="panel-grid settings-grid">
              <article className="info-card">
                <p className="section-title">{copy.appearanceTitle}</p>
                <p className="section-copy">{copy.settingsBody}</p>

                <div className="settings-block">
                  <span>{copy.theme}</span>
                  <SegmentedControl<ThemeMode>
                    value={preferences.theme}
                    onChange={(value) => void handlePreferenceChange('theme', value)}
                    options={[
                      { value: 'dark', label: labelForTheme('dark', preferences.language) },
                      { value: 'light', label: labelForTheme('light', preferences.language) },
                    ]}
                  />
                </div>

                <div className="settings-block">
                  <span>{copy.language}</span>
                  <SegmentedControl<AppLanguage>
                    value={preferences.language}
                    onChange={(value) => void handlePreferenceChange('language', value)}
                    options={[
                      { value: 'ru', label: labelForLanguage('ru', preferences.language) },
                      { value: 'en', label: labelForLanguage('en', preferences.language) },
                    ]}
                  />
                </div>

                <div className="settings-block">
                  <span>{copy.density}</span>
                  <SegmentedControl<UiDensity>
                    value={preferences.density}
                    onChange={(value) => void handlePreferenceChange('density', value)}
                    options={[
                      { value: 'comfortable', label: labelForDensity('comfortable', preferences.language) },
                      { value: 'compact', label: labelForDensity('compact', preferences.language) },
                    ]}
                  />
                </div>
              </article>

              <article className="info-card agent-capabilities-card">
                <div className="card-title-row">
                  <p className="section-title">{copy.agentCapabilitiesTitle}</p>
                </div>
                <p className="section-copy">{copy.agentCapabilitiesBody}</p>

                <div className="agent-capability-status-grid">
                  <MiniSetting label={copy.agentCapabilitiesLocalStatus} value={agentCapabilityLocalValue} />
                  <MiniSetting label={copy.agentCapabilitiesDataStatus} value={agentCapabilityDataValue} />
                  <MiniSetting label={copy.agentCapabilitiesDesktopStatus} value={agentCapabilityDesktopValue} />
                  <MiniSetting
                    label={copy.agentCapabilitiesSafetyStatus}
                    value={copy.agentCapabilitiesConfirmationOnly}
                  />
                </div>

                <div className="settings-actions">
                  <button
                    type="button"
                    className="ghost-action agent-capability-toggle"
                    onClick={() => setAgentCapabilitiesOpen((current) => !current)}
                  >
                    {agentCapabilitiesOpen ? copy.agentCapabilitiesHide : copy.agentCapabilitiesShow}
                  </button>
                </div>

                {agentCapabilitiesOpen ? (
                  <div className="agent-capabilities-panel">
                    {agentCapabilitySections.map((section) => (
                      <section key={section.id} className={`agent-capability-section agent-capability-${section.tone}`}>
                        <h3>{section.title}</h3>
                        <ul className="agent-capability-list">
                          {section.items.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="helper-line">{copy.agentCapabilitiesCollapsedHint}</p>
                )}
              </article>

              <article className="info-card telegram-remote-card">
                <div className="card-title-row">
                  <p className="section-title">{copy.telegramRemoteTitle}</p>
                  <span className={`status-chip ${telegramState.running ? 'status-chip-ready' : 'status-chip-warning'}`}>
                    {telegramState.running ? copy.telegramRemoteRunning : copy.telegramRemoteStopped}
                  </span>
                </div>
                <p className="section-copy">{copy.telegramRemoteBody}</p>

                <div className="toggle-list">
                  <ToggleRow
                    label={copy.telegramRemoteEnabled}
                    checked={telegramState.enabled}
                    disabled={telegramBusy}
                    onChange={(checked) => void handleTelegramToggle(checked)}
                  />
                </div>

                <label className="settings-field">
                  <span>{copy.telegramRemoteToken}</span>
                  <div className="settings-input-wrap">
                    <input
                      type={showTelegramToken ? 'text' : 'password'}
                      className="settings-input settings-input-secret"
                      value={telegramTokenDraft}
                      onChange={(event) => setTelegramTokenDraft(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="settings-eye"
                      aria-label={showTelegramToken ? copy.telegramRemoteHideToken : copy.telegramRemoteShowToken}
                      title={showTelegramToken ? copy.telegramRemoteHideToken : copy.telegramRemoteShowToken}
                      onClick={() => setShowTelegramToken((current) => !current)}
                    >
                      <Icon name={showTelegramToken ? 'eyeOff' : 'eye'} />
                    </button>
                  </div>
                </label>

                <div className="setting-mini-list">
                  <MiniSetting
                    label={copy.telegramRemoteStatus}
                    value={telegramState.lastError || (telegramState.running ? copy.readyState : copy.disabled)}
                    multiline
                  />
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'Последний update' : 'Last update'}
                    value={telegramState.lastUpdateAt ? formatTimestamp(telegramState.lastUpdateAt, preferences.language) : '-'}
                  />
                </div>

                <p className="helper-line">{copy.telegramRemoteCapabilities}</p>

                {telegramPairCode || telegramState.pairCode ? (
                  <p className="helper-line">
                    {copy.telegramRemotePairHint.replace('{code}', telegramPairCode?.code ?? telegramState.pairCode ?? '')}
                  </p>
                ) : null}

                <div className="settings-actions">
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleSaveTelegramConfig()}
                    disabled={telegramBusy || !telegramConfigDirty}
                  >
                    {copy.telegramRemoteSave}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void (telegramState.running ? window.friday.telegram.stop().then(setTelegramState) : handleTelegramToggle(true))}
                    disabled={telegramBusy}
                  >
                    {telegramState.running ? copy.telegramRemoteStop : copy.telegramRemoteStart}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleCreateTelegramPairCode()}
                    disabled={telegramBusy || !telegramTokenDraft.trim()}
                  >
                    {copy.telegramRemotePair}
                  </button>
                </div>

                <p className="section-title">{copy.telegramRemoteUsers}</p>
                <div className="telegram-user-list">
                  {telegramState.linkedUsers.length > 0 ? (
                    telegramState.linkedUsers.map((user) => (
                      <div key={user.id} className="telegram-user-row">
                        <div>
                          <strong>{formatTelegramUser(user)}</strong>
                          <span>{user.lastSeenAt ? formatTimestamp(user.lastSeenAt, preferences.language) : String(user.id)}</span>
                        </div>
                        <button
                          type="button"
                          className="text-action"
                          onClick={() => void handleRemoveTelegramUser(user.id)}
                          disabled={telegramBusy}
                        >
                          {copy.telegramRemoteRemoveUser}
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="helper-line">{copy.telegramRemoteNoUsers}</p>
                  )}
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{vpnCopy.title}</p>
                <p className="section-copy">{vpnCopy.body}</p>

                <div className="setting-mini-list">
                  <MiniSetting label={vpnCopy.profile} value={vpnState.profileName} />
                  <MiniSetting label={preferences.language === 'ru' ? 'Локация' : 'Location'} value={vpnLocations.find((location) => location.id === vpnConfig.locationId)?.name ?? vpnState.profileName} />
                  <MiniSetting label={vpnCopy.mode} value={vpnConfig.mode.toUpperCase()} />
                  <MiniSetting label={vpnCopy.runtime} value={vpnRuntimeLabel} />
                  <MiniSetting label={vpnCopy.detail} value={vpnState.detail || vpnStatusLabel} multiline />
                </div>

                {vpnLocations.length > 0 ? (
                  <label className="settings-field">
                    <span>{preferences.language === 'ru' ? 'Локация VPN' : 'VPN location'}</span>
                    <select
                      className="settings-input"
                      value={vpnConfig.locationId}
                      onChange={(event) => void handleVpnLocationChange(event.target.value)}
                      disabled={vpnBusy || vpnState.enabled}
                    >
                      {vpnLocations.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {vpnState.requiresAdmin ? (
                  <div className="vpn-admin-card">
                    <p className="helper-line">{vpnCopy.adminHint}</p>
                    <button type="button" className="sidebar-action" onClick={() => void handleRestartAsAdmin()} disabled={vpnBusy}>
                      {preferences.language === 'ru' ? 'Перезапустить от администратора' : 'Restart as Administrator'}
                    </button>
                  </div>
                ) : null}

                <div className="settings-actions">
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleVpnToggle(!vpnState.enabled)}
                    disabled={vpnBusy || (!vpnState.enabled && vpnState.requiresAdmin)}
                  >
                    {vpnBusy
                      ? preferences.language === 'ru'
                        ? 'Обработка...'
                        : 'Working...'
                      : vpnState.enabled
                        ? vpnCopy.disconnect
                        : vpnCopy.connect}
                  </button>
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{beamngCopy.title}</p>
                <p className="section-copy">{beamngCopy.body}</p>

                <div className="setting-mini-list">
                  <MiniSetting label={beamngCopy.bridge} value={beamngBridgeLabel} />
                  <MiniSetting label={beamngCopy.python} value={beamngPythonLabel} />
                  <MiniSetting label={beamngCopy.install} value={beamngInstallLabel} />
                  <MiniSetting
                    label={beamngCopy.aiMode}
                    value={beamngState.activeMode ?? (preferences.language === 'ru' ? 'Неактивен' : 'Idle')}
                  />
                  <MiniSetting label={beamngCopy.lane} value={beamngLaneLabel} />
                  <MiniSetting
                    label={beamngCopy.destination}
                    value={
                      beamngState.lastResolvedPlace ??
                      (preferences.language === 'ru' ? 'Не выбрана' : 'Not selected')
                    }
                    multiline
                  />
                </div>

                <label className="settings-field">
                  <span>{beamngCopy.gamePath}</span>
                  <input
                    type="text"
                    className="settings-input"
                    value={beamngDraft.gamePath}
                    onChange={(event) => handleBeamngDraftChange('gamePath', event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>

                <label className="settings-field">
                  <span>{beamngCopy.vehicleId}</span>
                  <input
                    type="text"
                    className="settings-input"
                    value={beamngDraft.defaultVehicleId}
                    onChange={(event) => handleBeamngDraftChange('defaultVehicleId', event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>

                <div className="toggle-list">
                  <ToggleRow
                    label={beamngCopy.autoLaunch}
                    checked={beamngDraft.autoLaunch}
                    onChange={(checked) => handleBeamngDraftChange('autoLaunch', checked)}
                  />
                </div>

                <p className="helper-line">{beamngCopy.installHint}</p>
                <p className="helper-line">{beamngCopy.dependencyHint}</p>
                {beamngState.detail ? <p className="helper-line">{beamngState.detail}</p> : null}
                {beamngDetectedInstalls.length > 0 ? (
                  <div className="beamng-install-list">
                    {beamngDetectedInstalls.map((install) => (
                      <p key={`${install.source}-${install.path}`} className="helper-line">
                        {install.source}: {install.path}
                      </p>
                    ))}
                  </div>
                ) : null}

                <div className="settings-actions">
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleInstallBeamngDependencies()}
                    disabled={beamngBusy}
                  >
                    {beamngBusy
                      ? preferences.language === 'ru'
                        ? 'Обработка...'
                        : 'Working...'
                      : beamngCopy.installDependencies}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleDetectBeamngInstalls()}
                    disabled={beamngBusy}
                  >
                    {beamngCopy.detect}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleBeamngConnectToggle()}
                    disabled={beamngBusy}
                  >
                    {beamngBusy
                      ? preferences.language === 'ru'
                        ? 'Обработка...'
                        : 'Working...'
                      : beamngState.connected
                        ? beamngCopy.disconnect
                        : beamngCopy.connect}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleScanBeamngWaypoints()}
                    disabled={beamngBusy}
                  >
                    {beamngCopy.scanWaypoints}
                  </button>
                </div>

                <p className="section-title">{beamngCopy.savedPlaces}</p>
                <div className="beamng-place-list">
                  {beamngDraft.savedPlaces.map((place) => (
                    <div key={place.id} className="beamng-place-card">
                      <label className="settings-field">
                        <span>{beamngCopy.placeName}</span>
                        <input
                          type="text"
                          className="settings-input"
                          value={place.name}
                          onChange={(event) => handleBeamngPlaceChange(place.id, 'name', event.target.value)}
                          spellCheck={false}
                        />
                      </label>
                      <label className="settings-field">
                        <span>{beamngCopy.waypointId}</span>
                        <input
                          type="text"
                          className="settings-input"
                          value={place.waypointId}
                          onChange={(event) => handleBeamngPlaceChange(place.id, 'waypointId', event.target.value)}
                          spellCheck={false}
                        />
                      </label>
                      <label className="settings-field">
                        <span>{beamngCopy.aliases}</span>
                        <input
                          type="text"
                          className="settings-input"
                          value={place.aliases.join(', ')}
                          placeholder={beamngCopy.aliasesHint}
                          onChange={(event) =>
                            handleBeamngPlaceChange(
                              place.id,
                              'aliases',
                              event.target.value
                                .split(',')
                                .map((entry) => entry.trim())
                                .filter(Boolean),
                            )
                          }
                          spellCheck={false}
                        />
                      </label>
                      <div className="settings-actions">
                        <button
                          type="button"
                          className="ghost-action"
                          onClick={() => handleRemoveBeamngPlace(place.id)}
                        >
                          {beamngCopy.remove}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="settings-actions">
                  <button type="button" className="ghost-action" onClick={() => handleAddBeamngPlace()}>
                    {beamngCopy.addPlace}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleSaveBeamngConfig()}
                    disabled={beamngBusy || !beamngDirty}
                  >
                    {beamngCopy.save}
                  </button>
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{copy.behaviorTitle}</p>
                <div className="toggle-list">
                  <ToggleRow
                    label={copy.enterToSend}
                    checked={preferences.enterToSend}
                    onChange={(checked) => void handlePreferenceChange('enterToSend', checked)}
                  />
                  <ToggleRow
                    label={copy.showTimestamps}
                    checked={preferences.showTimestamps}
                    onChange={(checked) => void handlePreferenceChange('showTimestamps', checked)}
                  />
                  <ToggleRow
                    label={copy.autoRecover}
                    checked={preferences.autoRecover}
                    onChange={(checked) => void handlePreferenceChange('autoRecover', checked)}
                  />
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{preferences.language === 'ru' ? 'Голосовой режим' : 'Voice mode'}</p>
                <p className="section-copy">
                  {preferences.language === 'ru'
                    ? 'Ambient listening работает через Python sidecar: VAD, faster-whisper, wake word и Supertonic TTS.'
                    : 'Ambient listening runs through a Python sidecar with VAD, faster-whisper, wake word, and Supertonic TTS.'}
                </p>
                <div className="toggle-list">
                  <ToggleRow
                    label={preferences.language === 'ru' ? 'Слушать обращение "Пятница"' : 'Listen for "Friday"'}
                    checked={voiceRuntimeConfig.ambientEnabled}
                    disabled={voiceRuntimeBusy}
                    onChange={(checked) => void handleToggleAmbientVoice(checked)}
                  />
                </div>
                <div className="setting-mini-list">
                  <MiniSetting label="Wake word" value={voiceRuntimeConfig.wakeWord} />
                  <MiniSetting label="STT" value={`faster-whisper ${voiceRuntimeConfig.sttModel}`} />
                  <MiniSetting label="TTS" value={`Supertonic ${voiceRuntimeConfig.ttsVoice}`} />
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'Последний текст' : 'Last transcript'}
                    value={ambientTranscript || (preferences.language === 'ru' ? 'Пока нет' : 'None yet')}
                    multiline
                  />
                  <MiniSetting label="Status" value={ambientVoiceDetail} multiline />
                </div>
                <div className="settings-actions">
                  <button type="button" className="ghost-action" onClick={() => void handleInstallVoiceRuntime()} disabled={voiceRuntimeBusy}>
                    {preferences.language === 'ru' ? 'Подготовить runtime' : 'Prepare runtime'}
                  </button>
                  <button type="button" className="ghost-action" onClick={() => void window.friday.voice.interrupt()} disabled={voiceRuntimeBusy}>
                    {preferences.language === 'ru' ? 'Остановить озвучку' : 'Interrupt speech'}
                  </button>
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{preferences.language === 'ru' ? 'Аккаунт' : 'Account'}</p>
                <div className="setting-mini-list">
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'Имя' : 'Name'}
                    value={backendSession.session?.user.displayName ?? 'Friday'}
                  />
                  <MiniSetting label="Email" value={backendSession.session?.user.email ?? '-'} />
                </div>
                <div className="settings-actions">
                  <button type="button" className="ghost-action" onClick={() => void handleLogout()}>
                    {preferences.language === 'ru' ? 'Выйти' : 'Sign out'}
                  </button>
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{copy.aiKeyTitle}</p>
                <p className="section-copy">{copy.aiKeyBody}</p>
                <div className="setting-mini-list">
                  <MiniSetting label={copy.envVariable} value={aiRuntimeConfig.envVariable} />
                  <MiniSetting label={preferences.language === 'ru' ? 'РџСЂРѕРІР°Р№РґРµСЂ' : 'Provider'} value="NVIDIA" />
                  <MiniSetting label={preferences.language === 'ru' ? 'РњРѕРґРµР»СЊ' : 'Model'} value={aiRuntimeConfig.model} />
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'РЎС‚Р°С‚СѓСЃ' : 'Status'}
                    value={labelForDiagnosticStatus(aiRuntimeConfig.status, preferences.language)}
                  />
                  <MiniSetting label={preferences.language === 'ru' ? 'Р”РµС‚Р°Р»Рё' : 'Detail'} value={aiRuntimeConfig.detail} multiline />
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{preferences.language === 'ru' ? 'Р›РёРјРёС‚ СЃРѕРѕР±С‰РµРЅРёР№' : 'Message limit'}</p>
                <p className="section-copy">
                  {preferences.language === 'ru'
                    ? 'РЎРѕРѕР±С‰РµРЅРёСЏ Р°РіРµРЅС‚Сѓ СЃС‡РёС‚Р°СЋС‚СЃСЏ РїРѕ РјРµСЃСЏС‡РЅРѕРјСѓ Р»РёРјРёС‚Сѓ РІР°С€РµР№ РїРѕРґРїРёСЃРєРё.'
                    : 'Agent messages are counted against the monthly limit for your subscription.'}
                </p>
                <div className="setting-mini-list">
                  <MiniSetting label={preferences.language === 'ru' ? 'РџР»Р°РЅ' : 'Plan'} value={formatQuotaPlan(messageQuota.plan)} />
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'РСЃРїРѕР»СЊР·РѕРІР°РЅРѕ' : 'Used'}
                    value={messageQuota.unlimited ? `${messageQuota.used} / ∞` : `${messageQuota.used} / ${messageQuota.limit ?? 0}`}
                  />
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'РћСЃС‚Р°Р»РѕСЃСЊ' : 'Remaining'}
                    value={messageQuota.unlimited ? '∞' : String(messageQuota.remaining ?? 0)}
                  />
                  <MiniSetting
                    label={preferences.language === 'ru' ? 'РЎР±СЂРѕСЃ' : 'Reset'}
                    value={formatDateTime(messageQuota.resetAt, preferences.language)}
                  />
                </div>
              </article>

              <article className="info-card">
                <p className="section-title">{copy.agentMailKeyTitle}</p>
                <p className="section-copy">{copy.agentMailKeyBody}</p>

                <div className="setting-mini-list">
                  <MiniSetting
                    label={copy.agentMailSkillState}
                    value={agentMailConfig.installed ? copy.agentMailInstalled : copy.agentMailNotInstalled}
                  />
                  <MiniSetting
                    label={copy.agentMailConfigPath}
                    value={copy.agentMailConfigManaged}
                    multiline
                  />
                </div>

                <label className="settings-field">
                  <span>{copy.agentMailKeyValue}</span>
                  <div className="settings-input-wrap">
                    <input
                      type={showAgentMailKey ? 'text' : 'password'}
                      className="settings-input settings-input-secret"
                      value={agentMailKeyDraft}
                      onChange={(event) => setAgentMailKeyDraft(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="settings-eye"
                      aria-label={showAgentMailKey ? copy.agentMailHideKey : copy.agentMailShowKey}
                      title={showAgentMailKey ? copy.agentMailHideKey : copy.agentMailShowKey}
                      onClick={() => setShowAgentMailKey((current) => !current)}
                    >
                      <Icon name={showAgentMailKey ? 'eyeOff' : 'eye'} />
                    </button>
                  </div>
                </label>

                <p className="helper-line">
                  {agentMailKeyDraft.trim() && agentMailConfig.installed ? copy.agentMailReady : copy.agentMailNeedKey}
                </p>

                <div className="settings-actions">
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleSaveAgentMailConfig()}
                    disabled={!agentMailConfigDirty}
                  >
                    {copy.agentMailSaveKey}
                  </button>
                  <button
                    type="button"
                    className="ghost-action"
                    onClick={() => void handleInstallAgentMailSkill()}
                    disabled={agentMailInstalling}
                  >
                    {agentMailInstalling ? copy.refresh : copy.agentMailInstallSkill}
                  </button>
                </div>
              </article>

              <article className="info-card diagnostics-card-compact">
                <div className="card-title-row">
                  <p className="section-title">{copy.diagnosticsCompactTitle}</p>
                  <button type="button" className="text-action" onClick={() => void refreshDiagnostics()}>
                    {copy.refresh}
                  </button>
                </div>
                <div className="diagnostic-grid">
                  {diagnosticCards.map((item) => (
                    <DiagnosticCard key={item.key} item={item} />
                  ))}
                </div>
              </article>

              <article className="info-card legal-card">
                <p className="section-title">{copy.legalTitle}</p>
                <p className="legal-copy">{copy.legalBody}</p>
              </article>
            </section>
          </>
        ) : null}
        </main>
      </div>
    </div>
  )
}

function MessageRow({
  message,
  showTimestamps,
  language,
}: {
  message: ChatMessage
  showTimestamps: boolean
  language: AppLanguage
}) {
  return (
    <article className={`message-row role-${message.role}`}>
      {message.role === 'user' ? null : (
        <div className="message-avatar">
          <span className={`orb ${message.role === 'assistant' ? 'orb-small' : 'orb-system'}`} />
        </div>
      )}

      <div className={`message-bubble bubble-${message.role}`}>
        <div className="message-meta">
          <span>{roleLabel(message.role, language)}</span>
          {showTimestamps ? <span>{formatClock(message.createdAt, language)}</span> : null}
          <span>{labelForSource(message.source, language)}</span>
        </div>
        <p>{message.text}</p>
      </div>
    </article>
  )
}

function AgentProgressCard({
  progress,
  language,
  clock,
}: {
  progress: AgentProgressState
  language: AppLanguage
  clock: number
}) {
  const latest = progress.latest
  const copy = agentProgressCopy(latest, language)
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - Date.parse(progress.startedAt)) / 1000))
  const displayedProgress =
    latest.status === 'active'
      ? Math.min(96, latest.progress + Math.min(18, Math.max(clock, elapsedSeconds) * 0.7))
      : latest.progress
  const recentEvents = progress.events
    .filter((event, index, items) => index === items.findIndex((candidate) => candidate.stage === event.stage && candidate.label === event.label))
    .slice(-3)

  return (
    <article className={`message-row role-assistant agent-progress-row agent-progress-${latest.status}`} aria-live="polite">
      <div className="message-avatar">
        <span className="orb orb-small orb-working" />
      </div>
      <div className="message-bubble bubble-assistant agent-progress-card">
        <div className="message-meta">
          <span>{language === 'ru' ? 'Пятница работает' : 'Friday is working'}</span>
          <span>{language === 'ru' ? `${elapsedSeconds} сек` : `${elapsedSeconds}s`}</span>
          <span>{Math.round(displayedProgress)}%</span>
        </div>
        <div className="agent-progress-head">
          <strong>{copy.label}</strong>
          <span>{copy.detail}</span>
        </div>
        <div className="agent-progress-track" aria-hidden="true">
          <span className="agent-progress-fill" style={{ width: `${Math.max(6, displayedProgress)}%` }} />
        </div>
        <div className="agent-progress-steps">
          {recentEvents.map((event) => {
            const eventCopy = agentProgressCopy(event, language)
            return (
              <span key={`${event.stage}-${event.at}`} className={`agent-progress-step agent-progress-step-${event.status}`}>
                {eventCopy.label}
              </span>
            )
          })}
        </div>
      </div>
    </article>
  )
}

function DiagnosticCard({ item }: { item: DiagnosticItem & { key?: string } }) {
  return (
    <article className={`diagnostic-card diagnostic-card-${item.status}`}>
      <div className="diagnostic-card-head">
        <span>{item.label}</span>
        <span className={`diagnostic-dot dot-${item.status}`} />
      </div>
      <p>{item.detail}</p>
    </article>
  )
}

function MetricBar({ metric }: { metric: SystemMetric }) {
  return (
    <article className={`metric-card metric-card-${metric.tone}`}>
      <div className="metric-head">
        <span>{metric.label}</span>
        <strong>{metric.value}</strong>
      </div>
      <div className="metric-track" aria-hidden="true">
        <span className="metric-fill" style={{ width: `${metric.progress}%` }} />
      </div>
    </article>
  )
}

function MiniSetting({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className={`mini-setting ${multiline ? 'mini-setting-multiline' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ModeSwitchChip({
  label,
  stateLabel,
  checked,
  onChange,
}: {
  label: string
  stateLabel: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label}: ${stateLabel}`}
      className={`mode-switch-chip ${checked ? 'mode-switch-chip-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="mode-switch-copy">
        <strong>{label}</strong>
        <span>{stateLabel}</span>
      </span>
      <span className={`mode-switch-track ${checked ? 'mode-switch-track-on' : ''}`} aria-hidden="true">
        <span className="mode-switch-thumb" />
      </span>
    </button>
  )
}

function ToggleRow({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle ${checked ? 'toggle-on' : ''}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-thumb" />
      </button>
    </label>
  )
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <div className="segmented-control">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segment ${option.value === value ? 'segment-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function NavButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string
  active: boolean
  onClick: () => void
  icon: IconName
}) {
  return (
    <button type="button" className={`rail-button ${active ? 'rail-button-active' : ''}`} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  )
}

type IconName = 'chat' | 'home' | 'memory' | 'mail' | 'settings' | 'mic' | 'send' | 'eye' | 'eyeOff'

function Icon({ name }: { name: IconName }) {
  switch (name) {
    case 'chat':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 6.5h14v9H9l-4 3v-12Z" />
        </svg>
      )
    case 'home':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4.5 10.5 12 4l7.5 6.5" />
          <path d="M7.5 10v9h9v-9" />
        </svg>
      )
    case 'memory':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6.5c0-1.7 1.3-3 3-3h6c1.7 0 3 1.3 3 3v11.5l-3-1.8-3 1.8-3-1.8-3 1.8V6.5Z" />
          <path d="M9 8.5h6" />
          <path d="M9 11.5h6" />
        </svg>
      )
    case 'mail':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4.5 7.5h15v9h-15z" />
          <path d="m5 8 7 5 7-5" />
        </svg>
      )
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.8 13.2 6l2.5.4-1.7 1.8.4 2.5L12 9.7l-2.4 1 .4-2.5-1.7-1.8 2.5-.4L12 3.8Z" />
          <circle cx="12" cy="15.5" r="4.3" />
        </svg>
      )
    case 'mic':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="4" width="6" height="10" rx="3" />
          <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" />
          <path d="M12 17v3" />
          <path d="M9 20h6" />
        </svg>
      )
    case 'send':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12 19 5l-3 14-4.5-5L5 12Z" />
          <path d="M11.5 14 19 5" />
        </svg>
      )
    case 'eye':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2.8 12s3.4-5.5 9.2-5.5 9.2 5.5 9.2 5.5-3.4 5.5-9.2 5.5S2.8 12 2.8 12Z" />
          <circle cx="12" cy="12" r="2.8" />
        </svg>
      )
    case 'eyeOff':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.5 3.5 20.5 20.5" />
          <path d="M10.7 6.6A9.9 9.9 0 0 1 12 6.5c5.8 0 9.2 5.5 9.2 5.5a16.2 16.2 0 0 1-3.2 3.8" />
          <path d="M6.9 9A15.6 15.6 0 0 0 2.8 12s3.4 5.5 9.2 5.5c1.6 0 3-.4 4.2-.9" />
          <path d="M9.9 9.9A2.9 2.9 0 0 0 9.2 12c0 1.5 1.3 2.8 2.8 2.8.8 0 1.5-.3 2-.8" />
        </svg>
      )
    default:
      return null
  }
}

function hydrateState(state: PersistedAppState): PersistedAppState {
  return {
    ...state,
    remoteSessionId: state.remoteSessionId ?? crypto.randomUUID(),
    activeFolderId: state.activeFolderId ?? 'inbox',
    preferences: state.preferences
      ? {
          ...createDefaultPreferences(),
          ...state.preferences,
          theme: normalizeTheme(state.preferences.theme),
        }
      : createDefaultPreferences(),
  }
}

function buildDiagnosticCards(diagnostics: Diagnostics, copy: CopyMap, language: AppLanguage) {
  return [
    {
      key: 'assistant',
      label: copy.assistantState,
      status: diagnostics.openclaw.status,
      detail: describeDiagnosticDetail('assistant', diagnostics.openclaw.status, language),
    },
    {
      key: 'connection',
      label: copy.connectionState,
      status: diagnostics.gateway.status,
      detail: describeDiagnosticDetail('connection', diagnostics.gateway.status, language),
    },
    {
      key: 'voice',
      label: copy.voiceState,
      status: diagnostics.whisper.status,
      detail: describeDiagnosticDetail('voice', diagnostics.whisper.status, language),
    },
    {
      key: 'microphone',
      label: copy.microphoneState,
      status: diagnostics.mic.status,
      detail: describeDiagnosticDetail('microphone', diagnostics.mic.status, language),
    },
  ] satisfies Array<DiagnosticItem & { key: string }>
}

function buildAgentCapabilitySections(language: AppLanguage): AgentCapabilitySection[] {
  if (language === 'ru') {
    return [
      {
        id: 'local-desktop',
        title: 'Локально на компьютере',
        tone: 'ready',
        items: [
          'Открывает приложения Windows и выполняет локальные routine-команды, если доступен агентный runtime.',
          'Работает с файлами и папками: создает, читает, сортирует, переименовывает и переносит безопасные рабочие файлы.',
          'Анализирует и помогает править документы, заметки, текстовые файлы и PDF через локальный рабочий контур.',
          'Может автоматизировать браузер: открыть сайт, прочитать страницу, заполнить форму или собрать информацию.',
          'Может помогать с кодом, командной строкой, локальными сценариями и проверкой результата.',
        ],
      },
      {
        id: 'ecosystem-data',
        title: 'Данные Экосистемы',
        tone: 'ready',
        items: [
          'Читает синхронизированный snapshot пользователя: профиль, память, заметки, задачи, проекты и документы.',
          'Может создавать и обновлять заметки, задачи, проекты и другие поддержанные сущности через server tools.',
          'Использует данные аккаунта как контекст, но не подставляет личную информацию в обычные локальные задачи без причины.',
          'После изменений перечитывает данные с сервера, чтобы показать проверенный результат, когда это возможно.',
        ],
      },
      {
        id: 'limits',
        title: 'Ограничения и подтверждения',
        tone: 'warning',
        items: [
          'Удаление, необратимые действия, массовые правки и опасные системные операции требуют подтверждения.',
          'Без входа в аккаунт агент не может читать или изменять серверные данные пользователя.',
          'VPN/TUN, системные маршруты и часть Windows-действий могут требовать запуск от имени администратора.',
          'Агент не обходит капчи, платные стены, защиту аккаунтов, чужие данные и запреты сервисов.',
          'Если runtime, браузер, голос или сеть недоступны, соответствующие возможности будут ограничены до восстановления.',
        ],
      },
    ]
  }

  return [
    {
      id: 'local-desktop',
      title: 'Local desktop',
      tone: 'ready',
      items: [
        'Opens Windows apps and runs local routine commands when the agent runtime is available.',
        'Works with files and folders: create, read, sort, rename, and move safe working files.',
        'Analyzes and helps edit documents, notes, text files, and PDFs through the local workflow.',
        'Can automate the browser: open sites, read pages, fill forms, or gather information.',
        'Can help with code, shell commands, local scripts, and result verification.',
      ],
    },
    {
      id: 'ecosystem-data',
      title: 'Ecosystem data',
      tone: 'ready',
      items: [
        'Reads the synced user snapshot: profile, memory, notes, tasks, projects, and documents.',
        'Can create and update notes, tasks, projects, and other supported entities through server tools.',
        'Uses account data as context, but does not inject personal data into normal local tasks without reason.',
        'After mutations, it rereads server data to show a verified result when possible.',
      ],
    },
    {
      id: 'limits',
      title: 'Limits and confirmations',
      tone: 'warning',
      items: [
        'Delete, irreversible actions, bulk edits, and risky system operations require confirmation.',
        'Without account sign-in, the agent cannot read or change server-side user data.',
        'VPN/TUN, system routes, and some Windows actions can require Administrator launch.',
        'The agent does not bypass captchas, paywalls, account protections, other users data, or service policies.',
        'If runtime, browser, voice, or network components are unavailable, related capabilities are limited until recovery.',
      ],
    },
  ]
}

function buildActivityLogItems({
  requestStatus,
  diagnosticCards,
  lastUserMessage,
  language,
}: {
  requestStatus: RequestStatus
  diagnosticCards: Array<DiagnosticItem & { key?: string }>
  lastUserMessage: ChatMessage | undefined
  language: AppLanguage
}) {
  const requestActivity = describeRequestActivity(requestStatus, language)
  const lastCommandLabel = language === 'ru' ? 'Последняя команда' : 'Latest command'
  const emptyCommand = language === 'ru' ? 'Ожидаю первую команду.' : 'Waiting for the first command.'

  return [
    {
      id: 'request',
      label: requestActivity.label,
      detail: requestActivity.detail,
      status: requestActivity.status,
    },
    {
      id: 'last-command',
      label: lastCommandLabel,
      detail: summarizeText(lastUserMessage?.text ?? emptyCommand, 64),
      status: lastUserMessage ? 'ready' : 'unknown',
    },
    ...diagnosticCards.slice(0, 2).map((item) => ({
      id: item.key ?? item.label,
      label: item.label,
      detail: item.detail,
      status: item.status,
    })),
  ] satisfies ActivityLogItem[]
}

function buildSystemMetrics({
  snapshot,
  language,
}: {
  snapshot: SystemSnapshot
  language: AppLanguage
}) {
  const cpuTone = snapshot.cpuPercent >= 85 ? 'error' : snapshot.cpuPercent >= 60 ? 'warning' : 'ready'
  const ramTone = snapshot.ramPercent >= 85 ? 'error' : snapshot.ramPercent >= 65 ? 'warning' : 'ready'
  const gpuValue = snapshot.gpuPercent ?? 0
  const gpuTone = gpuValue >= 85 ? 'error' : gpuValue >= 60 ? 'warning' : 'ready'

  return [
    {
      id: 'cpu',
      label: 'CPU',
      value: `${snapshot.cpuPercent}%`,
      progress: snapshot.cpuPercent,
      tone: cpuTone,
    },
    {
      id: 'ram',
      label: 'RAM',
      value: `${formatCompactGigabytes(snapshot.ramUsedGb, language)} / ${formatCompactGigabytes(snapshot.ramTotalGb, language)}`,
      progress: snapshot.ramPercent,
      tone: ramTone,
    },
    {
      id: 'gpu',
      label: 'GPU',
      value: snapshot.gpuPercent === null ? (language === 'ru' ? 'н/д' : 'n/a') : `${snapshot.gpuPercent}%`,
      progress: snapshot.gpuPercent ?? 0,
      tone: snapshot.gpuPercent === null ? 'warning' : gpuTone,
    },
  ] satisfies SystemMetric[]
}

function mergeVisibleMemories(memories: MemoryEntry[]): VisibleMemoryEntry[] {
  const merged = new Map<string, VisibleMemoryEntry>()

  for (const memory of memories) {
    const key = `${memory.category}:${normalizeMemoryIdentity(memory.title || memory.slug || memory.id)}`
    const current = merged.get(key)

    if (!current) {
      merged.set(key, {
        ...memory,
        tags: [...memory.tags],
        aliases: [...memory.aliases],
        links: [...memory.links],
        mergedIds: [memory.id],
      })
      continue
    }

    const primary = pickNewerMemory(current, memory)
    const secondary = primary.id === current.id ? memory : current

    merged.set(key, {
      ...primary,
      summary: mergeMemoryText(primary.summary, secondary.summary),
      content: mergeMemoryText(primary.content, secondary.content),
      tags: mergeMemoryList(primary.tags, secondary.tags),
      aliases: mergeMemoryList(primary.aliases, secondary.aliases),
      links: mergeMemoryList(primary.links, secondary.links),
      mergedIds: mergeMemoryList(current.mergedIds, [memory.id]),
      createdAt: primary.createdAt < secondary.createdAt ? primary.createdAt : secondary.createdAt,
      updatedAt: primary.updatedAt > secondary.updatedAt ? primary.updatedAt : secondary.updatedAt,
      lastRememberedAt: maxIsoDate(primary.lastRememberedAt, secondary.lastRememberedAt),
    })
  }

  return Array.from(merged.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function filterUserDataItems(
  context: AgentContext | null,
  memories: VisibleMemoryEntry[],
  query: string,
  language: AppLanguage,
): UserDataItem[] {
  const normalized = query.trim().toLowerCase()
  const items = buildUserDataItems(context, memories, language)

  if (!normalized) {
    return items
  }

  return items.filter((item) =>
    [item.kind, item.kindLabel, item.title, item.summary, item.detail].join(' ').toLowerCase().includes(normalized),
  )
}

function buildUserDataItems(
  context: AgentContext | null,
  memories: VisibleMemoryEntry[],
  language: AppLanguage,
): UserDataItem[] {
  const fallbackUpdatedAt = context?.generatedAt ?? new Date(0).toISOString()
  const items: UserDataItem[] = []

  if (context) {
    for (const task of [...context.overdueTasks, ...context.todayTasks]) {
      items.push({
        id: `task:${task.id}`,
        kind: 'task',
        kindLabel: language === 'ru' ? 'Задача' : 'Task',
        title: task.title,
        summary: task.description || (language === 'ru' ? 'Без описания' : 'No description'),
        detail: task.dueAt ? `${language === 'ru' ? 'Срок' : 'Due'}: ${task.dueAt}` : '',
        updatedAt: task.updatedAt,
      })
    }

    for (const note of context.recentNotes) {
      items.push({
        id: `note:${note.id}`,
        kind: 'note',
        kindLabel: language === 'ru' ? 'Заметка' : 'Note',
        title: note.title || (language === 'ru' ? 'Без названия' : 'Untitled'),
        summary: summarizeText(note.body || '', 180) || (language === 'ru' ? 'Пустая заметка' : 'Empty note'),
        detail: note.isArchived ? (language === 'ru' ? 'Архивирована' : 'Archived') : '',
        updatedAt: note.updatedAt,
      })
    }

    for (const reminder of context.activeReminders) {
      items.push({
        id: `reminder:${reminder.id}`,
        kind: 'reminder',
        kindLabel: language === 'ru' ? 'Напоминание' : 'Reminder',
        title: reminder.title,
        summary: reminder.body || (language === 'ru' ? 'Без описания' : 'No body'),
        detail: `${language === 'ru' ? 'Запланировано' : 'Scheduled'}: ${reminder.scheduledAt}`,
        updatedAt: reminder.updatedAt,
      })
    }

    for (const inboxItem of context.unreadInbox) {
      items.push({
        id: `inbox:${inboxItem.id}`,
        kind: 'inbox',
        kindLabel: language === 'ru' ? 'Входящее' : 'Inbox',
        title: inboxItem.title,
        summary: inboxItem.body,
        detail: inboxItem.signalCode || inboxItem.sourceType,
        updatedAt: inboxItem.updatedAt,
      })
    }

    for (const project of context.xVextaProjects) {
      items.push({
        id: `x-vexta-project:${project.id}`,
        kind: 'x_vexta_project',
        kindLabel: language === 'ru' ? 'Проект X Vexta' : 'X Vexta project',
        title: project.name,
        summary: project.summary || project.code,
        detail: project.color,
        updatedAt: project.updatedAt,
      })
    }

    for (const note of context.xVextaNotes) {
      items.push({
        id: `x-vexta-note:${note.id}`,
        kind: 'x_vexta_note',
        kindLabel: language === 'ru' ? 'Документ X Vexta' : 'X Vexta note',
        title: note.title,
        summary: note.summary || note.status,
        detail: note.projectId ? `${language === 'ru' ? 'Проект' : 'Project'}: ${note.projectId}` : '',
        updatedAt: note.updatedAt,
      })
    }
  }

  for (const memory of memories) {
    items.push({
      id: `memory:${memory.id}`,
      kind: 'memory',
      kindLabel: labelForMemoryCategory(memory.category, language),
      title: memory.title,
      summary: memory.summary || (language === 'ru' ? 'Без краткого описания' : 'No summary yet'),
      detail: memory.content,
      updatedAt: memory.updatedAt || fallbackUpdatedAt,
      memory,
    })
  }

  return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function countUserDataObjects(overview: AgentUserDataOverview | null, memories: VisibleMemoryEntry[]) {
  if (!overview) {
    return memories.length
  }

  const counts = overview.counts
  return (
    counts.tasks +
    counts.reminders +
    counts.notes +
    counts.memories +
    counts.inbox +
    counts.xVextaProjects +
    counts.xVextaNotes
  )
}

function buildUserDataStats(
  overview: AgentUserDataOverview | null,
  memories: VisibleMemoryEntry[],
  language: AppLanguage,
): UserDataStat[] {
  const counts = overview?.counts
  return [
    { label: language === 'ru' ? 'Задачи' : 'Tasks', value: String(counts?.tasks ?? 0) },
    { label: language === 'ru' ? 'Просрочено' : 'Overdue', value: String(counts?.overdueTasks ?? 0) },
    { label: language === 'ru' ? 'Заметки' : 'Notes', value: String(counts?.notes ?? 0) },
    { label: language === 'ru' ? 'Напоминания' : 'Reminders', value: String(counts?.reminders ?? 0) },
    { label: language === 'ru' ? 'Память' : 'Memory', value: String(counts?.memories ?? memories.length) },
    { label: language === 'ru' ? 'Входящие' : 'Inbox', value: String(counts?.inbox ?? 0) },
    { label: language === 'ru' ? 'Проекты' : 'Projects', value: String(counts?.xVextaProjects ?? 0) },
    { label: language === 'ru' ? 'Документы' : 'Docs', value: String(counts?.xVextaNotes ?? 0) },
  ]
}

function formatConfirmedActionReply(
  result: AgentActionResult,
  verifiedEntity: AgentUserDataEntitySummary | null,
  elapsedMs: number,
  language: AppLanguage,
) {
  const verifiedText =
    language === 'ru'
      ? verifiedEntity
        ? `Перечитал сущность: ${verifiedEntity.title}.`
        : isDeleteAgentAction(result.type)
          ? 'Перечитал данные: сущность больше не возвращается.'
          : 'Перечитал данные после подтверждения.'
      : verifiedEntity
        ? `Reread entity: ${verifiedEntity.title}.`
        : isDeleteAgentAction(result.type)
          ? 'Reread data: the entity is no longer returned.'
          : 'Reread data after confirmation.'

  const timingText = language === 'ru' ? `Проверено за ${elapsedMs} мс.` : `Verified in ${elapsedMs} ms.`
  return `${trimTrailingPeriod(result.message)}. ${verifiedText} ${timingText}`
}

function getEntityKindForAgentAction(type: AgentActionResult['type']) {
  if (type.includes('_note')) {
    return type.includes('x_vexta') ? 'x_vexta_note' : 'note'
  }
  if (type.includes('_task')) {
    return 'task'
  }
  if (type.includes('_reminder')) {
    return 'reminder'
  }
  if (type.includes('_memory')) {
    return 'memory'
  }
  if (type === 'dismiss_inbox_item') {
    return 'inbox'
  }
  if (type.includes('_x_vexta_project')) {
    return 'x_vexta_project'
  }
  return null
}

function isDeleteAgentAction(type: AgentActionResult['type']) {
  return type.startsWith('delete_')
}

function trimTrailingPeriod(value: string) {
  return value.trim().replace(/[.!?]+$/u, '')
}

function pickNewerMemory(left: VisibleMemoryEntry, right: MemoryEntry) {
  return left.updatedAt >= right.updatedAt ? left : right
}

function mergeMemoryText(left: string, right: string) {
  const values = [left, right].filter((value) => value.trim())
  return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()].join(' ')
}

function mergeMemoryList(left: string[], right: string[]) {
  return [...new Map([...left, ...right].map((value) => [value.toLowerCase(), value])).values()]
}

function normalizeMemoryIdentity(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function maxIsoDate(left: string | null, right: string | null) {
  if (!left) {
    return right
  }
  if (!right) {
    return left
  }
  return left >= right ? left : right
}

function labelForMemoryCategory(category: MemoryEntry['category'], language: AppLanguage) {
  if (language === 'ru') {
    switch (category) {
      case 'people':
        return 'Люди'
      case 'places':
        return 'Места'
      case 'games':
        return 'Игры'
      case 'tech':
        return 'Техника'
      case 'events':
        return 'События'
      case 'media':
        return 'Медиа'
      case 'ideas':
        return 'Идеи'
      case 'orgs':
      default:
        return 'Организации'
    }
  }

  switch (category) {
    case 'people':
      return 'People'
    case 'places':
      return 'Places'
    case 'games':
      return 'Games'
    case 'tech':
      return 'Tech'
    case 'events':
      return 'Events'
    case 'media':
      return 'Media'
    case 'ideas':
      return 'Ideas'
    case 'orgs':
    default:
      return 'Organizations'
  }
}

function labelForMailStatus(
  status: AgentMailAccount['status'],
  language: AppLanguage,
  copy: CopyMap,
) {
  if (status === 'ready') {
    return copy.mailConnected
  }

  if (status === 'error') {
    return language === 'ru' ? 'Ошибка' : 'Error'
  }

  return copy.mailDisconnected
}

function labelForMailFolder(folder: AgentMailFolder, copy: CopyMap) {
  switch (folder) {
    case 'sent':
      return copy.mailFolderSent
    case 'drafts':
      return copy.mailFolderDrafts
    case 'inbox':
    default:
      return copy.mailFolderInbox
  }
}

function getPrimaryMailAddress(message: AgentMailMessage) {
  return message.folder === 'sent'
    ? message.toAddresses[0] || message.subject
    : message.fromName || message.fromAddress || message.subject
}

function getMailPreviewText(message: AgentMailMessage) {
  return message.preview || message.bodyText || ''
}

function getMailBodyText(message: AgentMailMessage) {
  const bodyText = message.bodyText?.trim() || ''
  if (bodyText && bodyText !== message.subject.trim()) {
    return bodyText
  }

  const htmlText = stripMailHtml(message.bodyHtml)
  if (htmlText) {
    return htmlText
  }

  return bodyText || message.preview || ''
}

function stripMailHtml(html: string | null) {
  if (!html) {
    return ''
  }

  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function roleLabel(role: ChatMessage['role'], language: AppLanguage) {
  if (language === 'en') {
    return role === 'assistant' ? 'Friday' : role === 'system' ? 'System' : 'You'
  }

  return role === 'assistant' ? 'Пятница' : role === 'system' ? 'Система' : 'Вы'
}

function labelForSource(source: ChatMessage['source'], language: AppLanguage) {
  if (language === 'en') {
    return source === 'voice' ? 'voice' : 'text'
  }

  return source === 'voice' ? 'голос' : 'текст'
}

function agentProgressCopy(event: AgentProgressEvent, language: AppLanguage) {
  if (language === 'en') {
    return {
      label: event.label,
      detail: event.detail ?? 'The local agent is still working.',
    }
  }

  switch (event.stage) {
    case 'queued':
      return {
        label: 'Приняла задачу',
        detail: 'Готовлю запрос к локальному агенту.',
      }
    case 'desktop_shortcut':
      return {
        label: 'Проверяю локальные действия',
        detail: 'Смотрю, можно ли выполнить это быстро через desktop bridge.',
      }
    case 'gateway':
      return {
        label: 'Поднимаю агента',
        detail: 'Проверяю локальный сервис агента.',
      }
    case 'sync_context':
      return {
        label: 'Подгружаю контекст',
        detail: 'Обновляю память агента из локального snapshot данных пользователя.',
      }
    case 'planning':
      return {
        label: 'Агент думает',
        detail: 'Агент анализирует запрос и выбирает нужные tools.',
      }
    case 'tool_recovery':
      return {
        label: 'Исправляю tool-вызов',
        detail: 'Модель дала неидеальный формат, поэтому Friday аккуратно повторяет через native tools.',
      }
    case 'finalizing':
      return {
        label: 'Собираю ответ',
        detail: 'Проверяю результат tools и готовлю финальный ответ.',
      }
    case 'completed':
      return {
        label: 'Готово',
        detail: 'Финальный ответ получен.',
      }
    case 'error':
    default:
      return {
        label: 'Нужна пауза',
        detail: event.detail ?? 'Агент столкнулся с ошибкой.',
      }
  }
}

function describeDiagnosticDetail(
  area: 'assistant' | 'connection' | 'voice' | 'microphone',
  status: DiagnosticStatus,
  language: AppLanguage,
) {
  if (language === 'en') {
    if (area === 'assistant') {
      return describeStatus(status, {
        ready: 'Reply engine is available.',
        warning: 'Reply engine needs attention.',
        error: 'Reply engine is unavailable.',
        checking: 'Checking reply engine.',
        unknown: 'Reply engine state is unknown.',
      })
    }

    if (area === 'connection') {
      return describeStatus(status, {
        ready: 'Local connection is ready.',
        warning: 'Local connection is unstable.',
        error: 'Local connection failed.',
        checking: 'Checking local connection.',
        unknown: 'Connection state is unknown.',
      })
    }

    if (area === 'voice') {
      return describeStatus(status, {
        ready: 'Voice features are ready.',
        warning: 'Voice features need attention.',
        error: 'Voice features are unavailable.',
        checking: 'Checking voice features.',
        unknown: 'Voice state is unknown.',
      })
    }

    return describeStatus(status, {
      ready: 'Microphone access is available.',
      warning: 'Microphone access is limited.',
      error: 'Microphone access is unavailable.',
      checking: 'Checking microphone access.',
      unknown: 'Microphone state is unknown.',
    })
  }

  if (area === 'assistant') {
    return describeStatus(status, {
      ready: 'Сервис ответа доступен.',
      warning: 'Сервис ответа требует внимания.',
      error: 'Сервис ответа недоступен.',
      checking: 'Проверяем сервис ответа.',
      unknown: 'Состояние сервиса ответа неизвестно.',
    })
  }

  if (area === 'connection') {
    return describeStatus(status, {
      ready: 'Локальное подключение готово.',
      warning: 'Локальное подключение нестабильно.',
      error: 'Локальное подключение недоступно.',
      checking: 'Проверяем локальное подключение.',
      unknown: 'Состояние подключения неизвестно.',
    })
  }

  if (area === 'voice') {
    return describeStatus(status, {
      ready: 'Голосовые функции готовы.',
      warning: 'Голосовые функции требуют внимания.',
      error: 'Голосовые функции недоступны.',
      checking: 'Проверяем голосовые функции.',
      unknown: 'Состояние голосовых функций неизвестно.',
    })
  }

  return describeStatus(status, {
    ready: 'Доступ к микрофону открыт.',
    warning: 'Доступ к микрофону ограничен.',
    error: 'Доступ к микрофону недоступен.',
    checking: 'Проверяем доступ к микрофону.',
    unknown: 'Состояние микрофона неизвестно.',
  })
}

function describeStatus<T>(status: DiagnosticStatus, variants: Record<DiagnosticStatus, T>) {
  return variants[status]
}

function labelForTheme(theme: ThemeMode, language: AppLanguage) {
  const copy = STRINGS[language]
  if (theme === 'light') {
    return copy.light
  }
  return copy.dark
}

function labelForLanguage(value: AppLanguage, language: AppLanguage) {
  const copy = STRINGS[language]
  return value === 'en' ? copy.english : copy.russian
}

function labelForDensity(value: UiDensity, language: AppLanguage) {
  const copy = STRINGS[language]
  return value === 'compact' ? copy.compact : copy.comfortable
}

function labelForVpnStatus(status: VpnState['status'], language: AppLanguage) {
  if (language === 'ru') {
    switch (status) {
      case 'connected':
        return 'Подключен'
      case 'connecting':
        return 'Подключается'
      case 'disconnecting':
        return 'Отключается'
      case 'error':
        return 'Ошибка'
      default:
        return 'Отключен'
    }
  }

  switch (status) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'disconnecting':
      return 'Disconnecting'
    case 'error':
      return 'Error'
    default:
      return 'Disconnected'
  }
}

function labelForBeamngBridgeStatus(status: BeamngState['bridgeStatus'], language: AppLanguage) {
  if (language === 'ru') {
    switch (status) {
      case 'ready':
        return 'Готов'
      case 'starting':
        return 'Запускается'
      case 'error':
        return 'Ошибка'
      case 'stopped':
      default:
        return 'Остановлен'
    }
  }

  switch (status) {
    case 'ready':
      return 'Ready'
    case 'starting':
      return 'Starting'
    case 'error':
      return 'Error'
    case 'stopped':
    default:
      return 'Stopped'
  }
}

function labelForBeamngPythonStatus(status: BeamngState['pythonStatus'], language: AppLanguage) {
  if (language === 'ru') {
    switch (status) {
      case 'ready':
        return 'Найден'
      case 'error':
        return 'Ошибка'
      case 'missing':
      default:
        return 'Не найден'
    }
  }

  switch (status) {
    case 'ready':
      return 'Ready'
    case 'error':
      return 'Error'
    case 'missing':
    default:
      return 'Missing'
  }
}

function labelForBeamngInstallStatus(status: BeamngState['installStatus'], language: AppLanguage) {
  if (language === 'ru') {
    switch (status) {
      case 'valid':
        return 'Корректно'
      case 'invalid':
        return 'Неверный путь'
      case 'missing':
      default:
        return 'Не задан'
    }
  }

  switch (status) {
    case 'valid':
      return 'Valid'
    case 'invalid':
      return 'Invalid path'
    case 'missing':
    default:
      return 'Missing'
  }
}

function resolveTone(requestStatus: RequestStatus, diagnosticStatus: DiagnosticStatus) {
  if (requestStatus === 'error' || diagnosticStatus === 'error') {
    return 'error'
  }
  if (requestStatus === 'recording' || requestStatus === 'sending' || requestStatus === 'transcribing') {
    return 'warning'
  }
  if (diagnosticStatus === 'warning' || diagnosticStatus === 'checking') {
    return 'warning'
  }
  return 'ready'
}

function describeRequestActivity(requestStatus: RequestStatus, language: AppLanguage) {
  if (language === 'en') {
    switch (requestStatus) {
      case 'sending':
        return { label: 'Sending command', detail: 'Friday is preparing the response.', status: 'warning' as const }
      case 'recording':
        return { label: 'Listening', detail: 'Voice capture is active.', status: 'warning' as const }
      case 'transcribing':
        return { label: 'Transcribing voice', detail: 'Converting speech to text.', status: 'checking' as const }
      case 'checking_gateway':
        return { label: 'Checking connection', detail: 'Local services are being verified.', status: 'checking' as const }
      case 'error':
        return { label: 'Attention required', detail: 'The last action finished with an error.', status: 'error' as const }
      default:
        return { label: 'Waiting for command', detail: 'The agent is ready for the next task.', status: 'ready' as const }
    }
  }

  switch (requestStatus) {
    case 'sending':
      return { label: 'Выполняю команду', detail: 'Пятница готовит ответ.', status: 'warning' as const }
    case 'recording':
      return { label: 'Слушаю вас', detail: 'Идёт запись голосовой команды.', status: 'warning' as const }
    case 'transcribing':
      return { label: 'Распознаю голос', detail: 'Преобразую речь в текст.', status: 'checking' as const }
    case 'checking_gateway':
      return { label: 'Проверяю подключение', detail: 'Локальные сервисы проходят проверку.', status: 'checking' as const }
    case 'error':
      return { label: 'Нужно внимание', detail: 'Последнее действие завершилось ошибкой.', status: 'error' as const }
    default:
      return { label: 'Готов к команде', detail: 'Агент ждёт следующую задачу.', status: 'ready' as const }
  }
}

function formatClock(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatUpdatedAt(value: string | undefined, language: AppLanguage, copy: CopyMap) {
  if (!value) {
    return copy.updatedNow
  }

  return new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function labelForDiagnosticStatus(status: DiagnosticStatus, language: AppLanguage) {
  const ru: Record<DiagnosticStatus, string> = {
    ready: 'Готово',
    warning: 'Требует внимания',
    error: 'Ошибка',
    checking: 'Проверка',
    unknown: 'Неизвестно',
  }
  const en: Record<DiagnosticStatus, string> = {
    ready: 'Ready',
    warning: 'Needs attention',
    error: 'Error',
    checking: 'Checking',
    unknown: 'Unknown',
  }
  return (language === 'ru' ? ru : en)[status]
}

function formatQuotaPlan(plan: MessageQuotaState['plan']) {
  switch (plan) {
    case 'standard':
      return 'Ecosystem Standard'
    case 'pro':
      return 'Ecosystem Pro'
    case 'early':
      return 'Ecosystem Early'
    case 'unknown':
    default:
      return 'Ecosystem'
  }
}

function formatDateTime(value: string, language: AppLanguage) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return language === 'ru' ? 'После входа' : 'After sign-in'
  }
  return new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatTimestamp(value: string, language: AppLanguage) {
  return new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatTelegramUser(user: { id: number; username?: string; firstName?: string; lastName?: string }) {
  if (user.username) {
    return `@${user.username}`
  }

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
  return displayName || String(user.id)
}

function formatCompactGigabytes(value: number, language: AppLanguage) {
  return `${new Intl.NumberFormat(language === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(value)} GB`
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function mergeDraftWithTranscript(currentDraft: string, transcript: string) {
  const trimmedTranscript = transcript.trim()
  if (!trimmedTranscript) {
    return currentDraft
  }

  const trimmedDraft = currentDraft.trim()
  if (!trimmedDraft) {
    return trimmedTranscript
  }

  return `${trimmedDraft}\n${trimmedTranscript}`
}

function summarizeText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

export { FridayApp }
export default FridayApp

