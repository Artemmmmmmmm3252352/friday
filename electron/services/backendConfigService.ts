import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { BackendConfig } from '@contracts'

const DEFAULT_BACKEND_CONFIG: BackendConfig = {
  baseUrl: 'http://127.0.0.1:3010',
}

export class BackendConfigService {
  private readonly configPath: string

  constructor(userDataPath: string) {
    this.configPath = path.join(userDataPath, 'state', 'backend-config.json')
  }

  async load(): Promise<BackendConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as BackendConfig
      return {
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
      }
    } catch {
      return DEFAULT_BACKEND_CONFIG
    }
  }

  async save(config: BackendConfig): Promise<BackendConfig> {
    const normalized = {
      baseUrl: normalizeBaseUrl(config.baseUrl),
    }
    await mkdir(path.dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    return normalized
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const normalized = (value ?? '').trim().replace(/\/+$/, '')
  return normalized || DEFAULT_BACKEND_CONFIG.baseUrl
}
