// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EnvConfigService } from './envConfigService'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((target) => rm(target, { recursive: true, force: true })))
})

describe('EnvConfigService', () => {
  it('keeps NVIDIA as a managed AI runtime and does not expose the key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'friday-env-'))
    tempRoots.push(root)
    await writeFile(
      path.join(root, '.env'),
      'NVIDIA_API_KEY=top-secret\nGROQ_API_KEY=old-groq\nOPENAI_API_KEY=old-key\nGEMINI_API_KEY=old-gemini\n',
      'utf8',
    )

    const service = new EnvConfigService(root)
    const runtime = await service.loadAiRuntimeConfig()

    expect(runtime).toEqual({
      provider: 'nvidia',
      model: 'nvidia/mistralai/mistral-large-3-675b-instruct-2512',
      envVariable: 'NVIDIA_API_KEY',
      managed: true,
      status: 'ready',
      detail: 'NVIDIA NIM is configured by Friday and hidden from the interface.',
    })
    expect(JSON.stringify(runtime)).not.toContain('top-secret')

    const openClawConfig = JSON.parse(await readFile(path.join(root, 'openclaw.json'), 'utf8')) as {
      auth?: {
        profiles?: Record<string, { provider?: string; mode?: string }>
      }
      agents?: {
        defaults?: {
          model?: { primary?: string }
          models?: Record<string, unknown>
          memorySearch?: { enabled?: boolean }
        }
      }
      tools?: {
        exec?: {
          host?: string
          security?: string
          ask?: string
        }
      }
      models?: {
        providers?: Record<string, unknown>
      }
      skills?: {
        allowBundled?: string[]
      }
    }

    const envRaw = await readFile(path.join(root, '.env'), 'utf8')
    const authProfiles = JSON.parse(
      await readFile(path.join(root, 'agents', 'main', 'agent', 'auth-profiles.json'), 'utf8'),
    ) as {
      profiles?: Record<string, { provider?: string; key?: string; type?: string }>
      lastGood?: Record<string, string>
    }
    expect(envRaw).toContain('NVIDIA_API_KEY=top-secret')
    expect(envRaw).toContain('FRIDAY_MANAGED_NVIDIA_API_KEY=top-secret')
    expect(envRaw).not.toContain('GEMINI_API_KEY')
    expect(envRaw).not.toContain('GROQ_API_KEY')
    expect(envRaw).not.toContain('OPENAI_API_KEY')
    expect(openClawConfig.auth?.profiles?.['nvidia:default']).toEqual({
      provider: 'nvidia',
      mode: 'api_key',
    })
    expect(openClawConfig.agents?.defaults?.model?.primary).toBe('nvidia/mistralai/mistral-large-3-675b-instruct-2512')
    expect(openClawConfig.agents?.defaults?.memorySearch?.enabled).toBe(false)
    expect(openClawConfig.agents?.defaults?.models?.['nvidia/mistralai/mistral-large-3-675b-instruct-2512']).toEqual({})
    const agentsConfig = openClawConfig.agents as typeof openClawConfig.agents & {
      list?: Array<{ params?: unknown }>
    }
    expect(agentsConfig?.list?.[0]?.params).toEqual({
      maxTokens: 768,
      contextTokens: 6000,
    })
    expect(openClawConfig.agents?.defaults?.models?.['groq/meta-llama/llama-4-scout-17b-16e-instruct']).toBeUndefined()
    expect(openClawConfig.agents?.defaults?.models?.['groq/llama-3.1-8b-instant']).toBeUndefined()
    expect(openClawConfig.agents?.defaults?.models?.['google/gemini-2.5-flash-lite']).toBeUndefined()
    expect(openClawConfig.models?.providers?.nvidia).toMatchObject({
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: '${NVIDIA_API_KEY}',
      api: 'openai-completions',
      authHeader: true,
    })
    expect(openClawConfig.tools?.exec).toMatchObject({
      host: 'gateway',
      security: 'full',
      ask: 'off',
    })
    expect(openClawConfig.skills?.allowBundled).toContain('pc-apps')
    expect(openClawConfig.skills?.allowBundled).toContain('pc-shell')
    expect(openClawConfig.skills?.allowBundled).not.toContain('github')
    expect(authProfiles.profiles?.['nvidia:default']).toEqual({
      type: 'api_key',
      provider: 'nvidia',
      key: 'top-secret',
    })
    expect(authProfiles.profiles?.['google:default']).toBeUndefined()
    expect(authProfiles.profiles?.['groq:default']).toBeUndefined()
    expect(authProfiles.lastGood?.nvidia).toBe('nvidia:default')
    expect(authProfiles.lastGood?.groq).toBeUndefined()
    expect(authProfiles.lastGood?.google).toBeUndefined()
  })

  it('rewrites copied absolute OpenClaw paths to the current user profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'friday-env-'))
    tempRoots.push(root)

    await writeFile(
      path.join(root, '.env'),
      'NVIDIA_API_KEY=test-key\n',
      'utf8',
    )
    await writeFile(
      path.join(root, 'openclaw.json'),
      JSON.stringify(
        {
          agents: {
            defaults: {
              workspace: 'C:\\Users\\ernes\\.openclaw\\workspace',
              model: {
                primary: 'anthropic/claude-opus-4-6',
              },
            },
            list: [
              {
                id: 'coding',
                workspace: 'C:\\Users\\ernes\\.openclaw\\workspace',
                agentDir: 'C:\\Users\\ernes\\.openclaw\\agents\\coding\\agent',
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const service = new EnvConfigService(root)
    await service.loadAiRuntimeConfig()

    const openClawConfig = JSON.parse(await readFile(path.join(root, 'openclaw.json'), 'utf8')) as {
      agents?: {
        defaults?: {
          workspace?: string
          model?: { primary?: string }
        }
        list?: Array<{
          id?: string
          workspace?: string
          agentDir?: string
        }>
      }
    }

    const managedWorkspace = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'friday', 'state', 'openclaw-workspace')
    expect(openClawConfig.agents?.defaults?.workspace).toBe(managedWorkspace)
    expect(openClawConfig.agents?.defaults?.model?.primary).toBe('nvidia/mistralai/mistral-large-3-675b-instruct-2512')
    expect(openClawConfig.agents?.list?.[0]?.workspace).toBe(managedWorkspace)
    expect(openClawConfig.agents?.list?.[0]?.agentDir).toBe(path.join(root, 'agents', 'coding', 'agent'))
  })
})
