import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AgentMailConfigInput, AgentMailConfigState, AiRuntimeConfig } from '../../src/shared/contracts'

const DEFAULT_AI_ENV_NAME = 'NVIDIA_API_KEY'
const DEFAULT_AI_MODEL = 'nvidia/mistralai/mistral-large-3-675b-instruct-2512'
const DEFAULT_AI_PROVIDER = 'nvidia'
const DEFAULT_AI_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const DEFAULT_AI_MAX_TOKENS = 768
const DEFAULT_AI_CONTEXT_WINDOW = 6_000
const FRIDAY_STATE_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'friday', 'state')
const FRIDAY_OPENCLAW_WORKSPACE_DIR = path.join(FRIDAY_STATE_DIR, 'openclaw-workspace')
const FRIDAY_BUNDLED_SKILL_ALLOWLIST = [
  'adaptive-reasoning',
  'agent-browser',
  'agent-os',
  'browser-search',
  'pc-apps',
  'pc-automations',
  'pc-calendar',
  'pc-coding',
  'pc-files',
  'pc-planner',
  'pc-shell',
  'pc-web',
  'pdf',
  'planning-with-files',
  'python-executor',
  'semantic-memory',
  'task-manager',
  'terminal',
  'web-scraping',
]

export class EnvConfigService {
  private readonly baseDir: string
  private readonly envPath: string
  private readonly openClawConfigPath: string
  private readonly authProfilesPath: string

  constructor(baseDir: string = path.join(os.homedir(), '.openclaw')) {
    this.baseDir = baseDir
    this.envPath = path.join(baseDir, '.env')
    this.openClawConfigPath = path.join(baseDir, 'openclaw.json')
    this.authProfilesPath = path.join(baseDir, 'agents', 'main', 'agent', 'auth-profiles.json')
  }

  async loadAiRuntimeConfig(): Promise<AiRuntimeConfig> {
    const value = await this.ensureManagedAiConfig()
    return {
      provider: DEFAULT_AI_PROVIDER,
      model: DEFAULT_AI_MODEL,
      envVariable: DEFAULT_AI_ENV_NAME,
      managed: true,
      status: value ? 'ready' : 'warning',
      detail: value
        ? 'NVIDIA NIM is configured by Friday and hidden from the interface.'
        : 'Managed NVIDIA key is missing. Set FRIDAY_MANAGED_NVIDIA_API_KEY or seed NVIDIA_API_KEY once on this device.',
    }
  }

  async ensureManagedAiConfig(): Promise<string> {
    const variables = await this.readVariables()
    const bundledVariables = await readBundledRuntimeVariables()
    const value = (
      process.env.FRIDAY_MANAGED_NVIDIA_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      variables.get('FRIDAY_MANAGED_NVIDIA_API_KEY') ??
      variables.get('NVIDIA_API_KEY') ??
      bundledVariables.get('FRIDAY_MANAGED_NVIDIA_API_KEY') ??
      bundledVariables.get('NVIDIA_API_KEY') ??
      process.env.FRIDAY_MANAGED_GROQ_API_KEY ??
      process.env.GROQ_API_KEY ??
      process.env.FRIDAY_MANAGED_GEMINI_API_KEY ??
      process.env.GEMINI_API_KEY ??
      variables.get('FRIDAY_MANAGED_GROQ_API_KEY') ??
      variables.get('GROQ_API_KEY') ??
      variables.get('FRIDAY_MANAGED_GEMINI_API_KEY') ??
      variables.get('GEMINI_API_KEY') ??
      bundledVariables.get('FRIDAY_MANAGED_GROQ_API_KEY') ??
      bundledVariables.get('GROQ_API_KEY') ??
      bundledVariables.get('FRIDAY_MANAGED_GEMINI_API_KEY') ??
      bundledVariables.get('GEMINI_API_KEY') ??
      ''
    ).trim()

    for (const key of [
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'FRIDAY_MANAGED_GEMINI_API_KEY',
      'GROQ_API_KEY',
      'FRIDAY_MANAGED_GROQ_API_KEY',
    ]) {
      variables.delete(key)
    }

    if (value) {
      variables.set('FRIDAY_MANAGED_NVIDIA_API_KEY', value)
      variables.set(DEFAULT_AI_ENV_NAME, value)
      await this.writeVariables(variables)
      await this.syncOpenClawManagedAuthProfile(value)
    }

    await this.syncOpenClawModelConfig()
    return value
  }

  async loadAgentMailConfig(installed = false): Promise<AgentMailConfigState> {
    const currentConfig = await this.readOpenClawConfig()
    const skillEntry = getSkillEntry(currentConfig, 'agentmail')
    const env = isRecord(skillEntry.env) ? skillEntry.env : {}
    const apiKey = typeof env.AGENTMAIL_API_KEY === 'string' ? env.AGENTMAIL_API_KEY : ''
    const enabled = skillEntry.enabled !== false

    return {
      apiKey,
      enabled,
      installed,
      configPath: this.openClawConfigPath,
    }
  }

  async saveAgentMailConfig(config: AgentMailConfigInput, installed = false): Promise<AgentMailConfigState> {
    const currentConfig = await this.readOpenClawConfig()
    const currentSkills = isRecord(currentConfig.skills) ? currentConfig.skills : {}
    const currentEntries = isRecord(currentSkills.entries) ? currentSkills.entries : {}
    const currentAgentMail = getSkillEntry(currentConfig, 'agentmail')
    const currentEnv = isRecord(currentAgentMail.env) ? currentAgentMail.env : {}

    const apiKey = config.apiKey.trim()
    const enabled = config.enabled ?? true

    const nextConfig = {
      ...currentConfig,
      skills: {
        ...currentSkills,
        entries: {
          ...currentEntries,
          agentmail: {
            ...currentAgentMail,
            enabled,
            env: {
              ...currentEnv,
              AGENTMAIL_API_KEY: apiKey,
            },
          },
        },
      },
    }

    await mkdir(this.baseDir, { recursive: true })
    await writeFile(this.openClawConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')

    return {
      apiKey,
      enabled,
      installed,
      configPath: this.openClawConfigPath,
    }
  }

  private async readVariables(): Promise<Map<string, string>> {
    try {
      const raw = await readFile(this.envPath, 'utf8')
      return parseEnv(raw)
    } catch {
      return new Map<string, string>()
    }
  }

  private async writeVariables(variables: Map<string, string>): Promise<void> {
    await mkdir(path.dirname(this.envPath), { recursive: true })
    const lines = [...variables.entries()].map(([key, value]) => `${key}=${value}`)
    await writeFile(this.envPath, `${lines.join('\n')}\n`, 'utf8')
  }

  private async syncOpenClawModelConfig(): Promise<void> {
    const currentConfig = await this.readOpenClawConfig()
    const currentAuth = isRecord(currentConfig.auth) ? currentConfig.auth : {}
    const currentAuthProfiles = isRecord(currentAuth.profiles) ? currentAuth.profiles : {}
    const currentAgents = isRecord(currentConfig.agents) ? currentConfig.agents : {}
    const currentDefaults = isRecord(currentAgents.defaults) ? currentAgents.defaults : {}
    const currentSkills = isRecord(currentConfig.skills) ? currentConfig.skills : {}
    const currentTools = isRecord(currentConfig.tools) ? currentConfig.tools : {}
    const currentExecTools = isRecord(currentTools.exec) ? currentTools.exec : {}
    const currentModels = isRecord(currentConfig.models) ? currentConfig.models : {}
    const currentProviders = isRecord(currentModels.providers) ? currentModels.providers : {}
    const nextConfig = {
      ...currentConfig,
      auth: {
        ...currentAuth,
        profiles: {
          ...currentAuthProfiles,
          'nvidia:default': {
            ...(isRecord(currentAuthProfiles['nvidia:default']) ? currentAuthProfiles['nvidia:default'] : {}),
            provider: DEFAULT_AI_PROVIDER,
            mode: 'api_key',
          },
        },
      },
      agents: {
        ...currentAgents,
        defaults: {
          ...currentDefaults,
          memorySearch: {
            ...(isRecord(currentDefaults.memorySearch) ? currentDefaults.memorySearch : {}),
            enabled: false,
          },
          model: {
            ...(isRecord(currentDefaults.model) ? currentDefaults.model : {}),
            primary: DEFAULT_AI_MODEL,
          },
          models: normalizeManagedModelMap(currentDefaults.models),
          workspace: FRIDAY_OPENCLAW_WORKSPACE_DIR,
        },
        list: normalizeAgentList(currentAgents.list, this.baseDir, FRIDAY_OPENCLAW_WORKSPACE_DIR),
      },
      models: {
        ...currentModels,
        mode: 'merge',
        providers: {
          ...currentProviders,
          [DEFAULT_AI_PROVIDER]: {
            ...(isRecord(currentProviders[DEFAULT_AI_PROVIDER]) ? currentProviders[DEFAULT_AI_PROVIDER] : {}),
            baseUrl: DEFAULT_AI_BASE_URL,
            apiKey: `\${${DEFAULT_AI_ENV_NAME}}`,
            api: 'openai-completions',
            authHeader: true,
            models: [
              {
                id: 'mistralai/mistral-large-3-675b-instruct-2512',
                name: 'NVIDIA Mistral Large 3',
                reasoning: false,
                compat: {
                  supportsTools: true,
                },
                input: ['text'],
                contextWindow: 128_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
      tools: {
        ...currentTools,
        exec: {
          ...currentExecTools,
          host: 'gateway',
          security: 'full',
          ask: 'off',
        },
      },
      skills: {
        ...currentSkills,
        allowBundled: FRIDAY_BUNDLED_SKILL_ALLOWLIST,
      },
    }

    await mkdir(this.baseDir, { recursive: true })
    await writeFile(this.openClawConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')
  }

  private async syncOpenClawManagedAuthProfile(apiKey: string): Promise<void> {
    const currentAuth = await this.readAuthProfiles()
    const profiles = isRecord(currentAuth.profiles) ? currentAuth.profiles : {}
    const usageStats = isRecord(currentAuth.usageStats) ? currentAuth.usageStats : {}
    const lastGood = isRecord(currentAuth.lastGood) ? currentAuth.lastGood : {}
    const nextProfiles = { ...profiles }
    delete nextProfiles['google:default']
    delete nextProfiles['groq:default']

    const nextAuth = {
      ...currentAuth,
      version: typeof currentAuth.version === 'number' ? currentAuth.version : 1,
      profiles: {
        ...nextProfiles,
        'nvidia:default': {
          ...(isRecord(profiles['nvidia:default']) ? profiles['nvidia:default'] : {}),
          type: 'api_key',
          provider: DEFAULT_AI_PROVIDER,
          key: apiKey,
        },
      },
      lastGood: {
        ...lastGood,
        google: undefined,
        groq: undefined,
        [DEFAULT_AI_PROVIDER]: 'nvidia:default',
      },
      usageStats,
    }

    await mkdir(path.dirname(this.authProfilesPath), { recursive: true })
    await writeFile(this.authProfilesPath, `${JSON.stringify(nextAuth, null, 2)}\n`, 'utf8')
  }

  private async readOpenClawConfig(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.openClawConfigPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  private async readAuthProfiles(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.authProfilesPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
}

async function readBundledRuntimeVariables(): Promise<Map<string, string>> {
  const variables = new Map<string, string>()
  const roots = [
    typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
    path.dirname(process.execPath),
    process.cwd(),
    path.join(process.cwd(), 'vendor'),
  ].filter(Boolean)

  for (const root of [...new Set(roots)]) {
    const raw = await safeReadFile(path.join(root, 'friday-runtime.env'))
    for (const [key, value] of parseEnv(raw)) {
      if (!variables.has(key)) {
        variables.set(key, value)
      }
    }
  }

  return variables
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function parseEnv(raw: string): Map<string, string> {
  const variables = new Map<string, string>()

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (key) {
      variables.set(key, stripWrappingQuotes(value))
    }
  }

  return variables
}

function stripWrappingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getSkillEntry(config: Record<string, unknown>, skillName: string) {
  const skills = isRecord(config.skills) ? config.skills : {}
  const entries = isRecord(skills.entries) ? skills.entries : {}
  const entry = entries[skillName]
  return isRecord(entry) ? entry : {}
}

function normalizeAgentList(value: unknown, baseDir: string, workspaceDir: string) {
  if (!Array.isArray(value)) {
    return [
      {
        id: 'main',
        workspace: workspaceDir,
        agentDir: path.join(baseDir, 'agents', 'main', 'agent'),
        params: {
          maxTokens: DEFAULT_AI_MAX_TOKENS,
          contextTokens: DEFAULT_AI_CONTEXT_WINDOW,
        },
      },
    ]
  }

  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
      return entry
    }

    return {
      ...entry,
      workspace: workspaceDir,
      agentDir: path.join(baseDir, 'agents', entry.id, 'agent'),
      params: {
        ...(isRecord(entry.params) ? entry.params : {}),
        maxTokens: DEFAULT_AI_MAX_TOKENS,
        contextTokens: DEFAULT_AI_CONTEXT_WINDOW,
      },
    }
  })
}

function normalizeManagedModelMap(value: unknown) {
  const models = isRecord(value) ? { ...value } : {}
  delete models['google/gemini-2.5-flash-lite']
  delete models['google/gemini-2.5-flash']
  delete models['groq/meta-llama/llama-4-scout-17b-16e-instruct']
  delete models['groq/llama-3.1-8b-instant']
  models[DEFAULT_AI_MODEL] = {}
  return models
}
