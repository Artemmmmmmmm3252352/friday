import { loadRuntimeEnv } from './runtimeEnv'

export interface ApiConfig {
  port: number
  host: string
  databaseUrl: string
}

export function loadApiConfig(env: NodeJS.ProcessEnv = loadRuntimeEnv()): ApiConfig {
  const databaseUrl = env.FRIDAY_DATABASE_URL ?? ''
  if (!databaseUrl) {
    throw new Error('FRIDAY_DATABASE_URL is required')
  }

  return {
    port: Number(env.FRIDAY_API_PORT ?? 3010),
    host: env.FRIDAY_API_HOST ?? '127.0.0.1',
    databaseUrl,
  }
}
