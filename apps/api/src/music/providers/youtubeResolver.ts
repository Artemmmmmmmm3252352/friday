import type { MusicConfig } from '../config'
import { MusicApiError } from '../errors'
import type { MusicPlaybackPayload, MusicTrack } from '../models'

type YouTubeSearchResponse = {
  items?: Array<{
    id?: {
      videoId?: string
    }
    snippet?: {
      title?: string
      channelTitle?: string
      thumbnails?: {
        high?: { url?: string }
        medium?: { url?: string }
        default?: { url?: string }
      }
    }
  }>
  error?: {
    message?: string
  }
}

type YouTubeVideosResponse = {
  items?: Array<{
    id?: string
    snippet?: {
      title?: string
      channelTitle?: string
      thumbnails?: {
        high?: { url?: string }
        medium?: { url?: string }
        default?: { url?: string }
      }
    }
    status?: {
      embeddable?: boolean
    }
  }>
  error?: {
    message?: string
  }
}

const NEGATIVE_PATTERNS = [
  /\blive\b/iu,
  /\bremix\b/iu,
  /\bcover\b/iu,
  /\blyrics?\b/iu,
  /\bkaraoke\b/iu,
  /\bslowed\b/iu,
  /\breverb\b/iu,
  /\bnightcore\b/iu,
  /\bsped[\s-]?up\b/iu,
]

export class YouTubePlaybackResolver {
  constructor(private readonly config: MusicConfig) {}

  async resolve(track: MusicTrack): Promise<MusicPlaybackPayload> {
    const playbackQuery = `${track.artists.join(' ')} ${track.title}`.trim()
    const resolvedVideo = await this.findEmbeddableVideo(playbackQuery)

    if (!resolvedVideo?.videoId) {
      throw new MusicApiError(404, 'PLAYBACK_SOURCE_NOT_FOUND', 'Unable to resolve playback source for this track', false)
    }

    const videoId = resolvedVideo.videoId
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1&rel=0&playsinline=1`
    const externalUrl = `https://www.youtube.com/watch?v=${videoId}`

    return {
      trackId: track.id,
      provider: 'youtube',
      playbackType: 'embed',
      playbackUrl: embedUrl,
      videoId,
      embedUrl,
      title: track.title,
      artists: track.artists,
      coverUrl: resolvedVideo.coverUrl ?? track.coverUrl,
      startPositionMs: 0,
      ready: true,
      playbackQuery,
      externalUrl,
    }
  }

  private async findEmbeddableVideo(query: string): Promise<{ videoId: string; coverUrl: string | null } | null> {
    if (!this.config.youtubeDataApiKey) {
      throw new MusicApiError(503, 'PROVIDER_UNAVAILABLE', 'YouTube Data API key is not configured', false)
    }

    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search')
    searchUrl.searchParams.set('key', this.config.youtubeDataApiKey)
    searchUrl.searchParams.set('part', 'snippet')
    searchUrl.searchParams.set('q', `${query} official audio`)
    searchUrl.searchParams.set('type', 'video')
    searchUrl.searchParams.set('videoCategoryId', '10')
    searchUrl.searchParams.set('videoEmbeddable', 'true')
    searchUrl.searchParams.set('maxResults', '10')

    const searchResponse = await this.fetchYouTube<YouTubeSearchResponse>(searchUrl)
    const candidates = searchResponse.items
      ?.map((item) => ({
        videoId: item.id?.videoId?.trim() ?? '',
        title: `${item.snippet?.title ?? ''} ${item.snippet?.channelTitle ?? ''}`.trim(),
        coverUrl:
          item.snippet?.thumbnails?.high?.url ??
          item.snippet?.thumbnails?.medium?.url ??
          item.snippet?.thumbnails?.default?.url ??
          null,
      }))
      .filter((item) => item.videoId)
      .filter((item) => !NEGATIVE_PATTERNS.some((pattern) => pattern.test(item.title))) ?? []

    if (!candidates.length) {
      return null
    }

    const statusUrl = new URL('https://www.googleapis.com/youtube/v3/videos')
    statusUrl.searchParams.set('key', this.config.youtubeDataApiKey)
    statusUrl.searchParams.set('part', 'status,snippet')
    statusUrl.searchParams.set('id', candidates.map((item) => item.videoId).join(','))

    const videoResponse = await this.fetchYouTube<YouTubeVideosResponse>(statusUrl)
    const allowedIds = new Set(
      (videoResponse.items ?? [])
        .filter((item) => item.id && item.status?.embeddable !== false)
        .filter((item) => !NEGATIVE_PATTERNS.some((pattern) => pattern.test(`${item.snippet?.title ?? ''} ${item.snippet?.channelTitle ?? ''}`)))
        .map((item) => item.id as string),
    )

    const selected = candidates
      .filter((item) => allowedIds.has(item.videoId))
      .sort((left, right) => scoreCandidate(right.title) - scoreCandidate(left.title))[0]
    return selected ?? null
  }

  private async fetchYouTube<T extends { error?: { message?: string } }>(url: URL): Promise<T> {
    let response: Response

    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
    } catch {
      throw new MusicApiError(504, 'NETWORK_TIMEOUT', 'YouTube request timed out', true)
    }

    if (response.status === 429) {
      throw new MusicApiError(429, 'YOUTUBE_RATE_LIMIT', 'YouTube temporarily limited requests', true)
    }

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as T | null
      const message = detail?.error?.message ?? 'YouTube API request failed'
      throw new MusicApiError(503, 'YOUTUBE_API_ERROR', message, response.status >= 500)
    }

    return response.json() as Promise<T>
  }
}

function scoreCandidate(value: string): number {
  const text = value.toLowerCase()
  let score = 0

  if (text.includes('topic')) score += 5
  if (text.includes('official audio')) score += 4
  if (text.includes('official video')) score += 2
  if (text.includes('explicit')) score += 1

  return score
}
