import { loadRuntimeEnv } from '../core/runtimeEnv'

export interface MusicConfig {
  youtubeDataApiKey: string
  requestTimeoutMs: number
}

export function loadMusicConfig(env: NodeJS.ProcessEnv = loadRuntimeEnv()): MusicConfig {
  const timeoutSeconds = Number(env.REQUEST_TIMEOUT_SECONDS ?? '20')

  return {
    youtubeDataApiKey: env.YOUTUBE_DATA_API_KEY ?? '',
    requestTimeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 10000,
  }
}
