import type { FastifyInstance, FastifyRequest } from 'fastify'

import { Database } from '../core/db'
import { InMemoryCache } from './cache/inMemoryCache'
import { loadMusicConfig } from './config'
import { MusicApiError } from './errors'
import type {
  MusicBrowseResponse,
  MusicCollectionKind,
  MusicCollectionViewModel,
  MusicHealthResponse,
  MusicPlaybackPayload,
  MusicRecommendationsResponse,
  MusicSearchMode,
  MusicSearchResponse,
  MusicBrowseSection,
  MusicSearchType,
  MusicTrack,
  MusicTrackDetails,
  MusicVoiceExecuteResponse,
} from './models'
import { YouTubeMetadataProvider } from './providers/youtubeProvider'
import { YouTubePlaybackResolver } from './providers/youtubeResolver'
import { MusicRepository } from './services/musicRepository'
import { createRequestId, normalizeQuery } from './utils'

type AuthenticatedRequest = FastifyRequest & {
  auth?: {
    tenantId: string
    userId: string
  }
}

const cache = new InMemoryCache()
const config = loadMusicConfig()
const provider = new YouTubeMetadataProvider(config)
const playbackResolver = new YouTubePlaybackResolver(config)

export function registerMusicRoutes(app: FastifyInstance, database: Database): void {
  const repository = new MusicRepository(database)

  const handleSearch = async (request: FastifyRequest) => {
    const auth = getOptionalAuth(request)
    const query = request.query as { q?: string; limit?: string; type?: MusicSearchType; mode?: MusicSearchMode }
    const q = normalizeQuery(query.q ?? '')
    const requestId = createRequestId()

    if (q.length < 2) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'Search query must be at least 2 characters long', false, requestId)
    }

    const limit = clampLimit(query.limit, 10)
    const type = query.type ?? 'mixed'
    const mode = query.mode ?? 'default'
    const cacheKey = `music:search:${type}:${mode}:${q.toLowerCase()}:${limit}`
    const cached = cache.get<MusicSearchResponse>(cacheKey)
    if (cached) {
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          cached: true,
          requestId,
        },
      }
    }

    const tracks = await provider.search(q, limit, type, mode)
    const response: MusicSearchResponse = {
      query: q,
      topResult: tracks[0] ?? null,
      tracks,
      artists: [],
      albums: [],
      metadata: {
        cached: false,
        provider: 'youtube',
        requestId,
      },
    }

    cache.set(cacheKey, response, 5 * 60_000)
    if (auth) {
      await repository.recordSearch(auth.tenantId, auth.userId, q)
    }
    return response
  }

  const handleBrowse = async (request: FastifyRequest) => {
    const query = request.query as { section?: MusicBrowseSection; q?: string; limit?: string }
    const section = query.section
    const requestId = createRequestId()

    if (!section || !['playlists', 'albums', 'artists', 'podcasts'].includes(section)) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'section must be one of playlists, albums, artists, podcasts', false, requestId)
    }

    const normalizedQuery = query.q ? normalizeQuery(query.q) : null
    const limit = clampLimit(query.limit, 12)
    const cacheKey = `music:browse:${section}:${(normalizedQuery ?? '').toLowerCase()}:${limit}`
    const cached = cache.get<MusicBrowseResponse>(cacheKey)
    if (cached) {
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          cached: true,
          requestId,
        },
      }
    }

    const items = await provider.browse(section, limit, normalizedQuery ?? undefined)
    const response: MusicBrowseResponse = {
      section,
      query: normalizedQuery,
      items,
      metadata: {
        cached: false,
        provider: 'youtube',
        requestId,
      },
    }

    cache.set(cacheKey, response, 10 * 60_000)
    return response
  }

  const handlePlaybackResolve = async (request: FastifyRequest) => {
    const auth = getOptionalAuth(request)
    const body = request.body as { track_id?: string }
    const trackId = body.track_id?.trim()
    if (!trackId) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'track_id is required')
    }

    const cacheKey = `music:playback:${trackId}`
    const cached = cache.get<MusicPlaybackPayload>(cacheKey)
    if (cached) {
      if (auth) {
        await repository.recordRecentlyPlayed(auth.tenantId, auth.userId, trackFromPlaybackPayload(cached))
      }
      return cached
    }

    const track = await provider.getTrack(trackId)
    const payload = await playbackResolver.resolve(track)
    cache.set(cacheKey, payload, 5 * 60_000)
    if (auth) {
      await repository.recordRecentlyPlayed(auth.tenantId, auth.userId, track)
    }
    return payload
  }

  app.get('/api/v1/music/search', handleSearch)
  app.get('/api/v1/music/browse', handleBrowse)
  app.get('/api/music/browse', handleBrowse)
  app.get('/api/music/search', async (request) => {
    const response = await handleSearch(request)
    return {
      tracks: response.tracks.map(toMinimalTrack),
    }
  })

  app.get('/api/v1/music/tracks/:id', async (request) => {
    const trackId = getParamId(request)
    const cacheKey = `music:track:${trackId}`
    const cached = cache.get<MusicTrackDetails>(cacheKey)
    if (cached) {
      return cached
    }

    const track = await provider.getTrack(trackId)
    cache.set(cacheKey, track, 30 * 60_000)
    return track
  })

  app.get('/api/v1/music/collections/:kind/:id', async (request) => {
    const params = request.params as { kind?: MusicCollectionKind; id?: string }
    const kind = params.kind
    const id = params.id?.trim()
    const requestId = createRequestId()

    if (!kind || !['playlists', 'albums', 'podcasts'].includes(kind)) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'kind must be one of playlists, albums, podcasts', false, requestId)
    }
    if (!id) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'Collection id is required', false, requestId)
    }

    const cacheKey = `music:collection:${kind}:${id}`
    const cached = cache.get<MusicCollectionViewModel>(cacheKey)
    if (cached) {
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          cached: true,
          requestId,
        },
      }
    }

    const collection = await provider.getCollection(kind, id)
    const response: MusicCollectionViewModel = {
      ...collection,
      metadata: {
        ...collection.metadata,
        cached: false,
        requestId,
      },
    }
    cache.set(cacheKey, response, 10 * 60_000)
    return response
  })

  app.get('/api/v1/music/recommendations', async (request) => {
    const query = request.query as { seed_track_id?: string; limit?: string }
    const seedTrackId = query.seed_track_id?.trim()
    const requestId = createRequestId()

    if (!seedTrackId) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'seed_track_id is required', false, requestId)
    }

    const limit = clampLimit(query.limit, 8)
    const cacheKey = `music:recommendations:${seedTrackId}:${limit}`
    const cached = cache.get<MusicRecommendationsResponse>(cacheKey)
    if (cached) {
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          cached: true,
          requestId,
        },
      }
    }

    const tracks = await provider.getRecommendations(seedTrackId, limit)
    const response: MusicRecommendationsResponse = {
      seedTrackId,
      tracks,
      metadata: {
        cached: false,
        provider: 'youtube',
        requestId,
      },
    }
    cache.set(cacheKey, response, 10 * 60_000)
    return response
  })

  app.post('/api/v1/music/playback/resolve', handlePlaybackResolve)
  app.post('/api/music/playback/resolve', async (request) => {
    const payload = await handlePlaybackResolve(request)
    return {
      playback_type: 'youtube',
      video_id: payload.videoId,
      embed_url: payload.embedUrl,
      external_url: payload.externalUrl,
    }
  })

  app.post('/api/v1/music/voice/execute', async (request) => {
    const body = request.body as { text?: string }
    const text = normalizeQuery(body.text ?? '')
    if (!text) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'text is required')
    }

    return executeVoiceCommand(text)
  })

  app.get('/api/v1/music/history/searches', async (request) => {
    const auth = getAuth(request)
    return repository.listRecentSearches(auth.tenantId, auth.userId)
  })

  app.get('/api/v1/music/history/recent', async (request) => {
    const auth = getAuth(request)
    return repository.listRecentlyPlayed(auth.tenantId, auth.userId)
  })

  app.get('/api/v1/music/library', async (request) => {
    const auth = getAuth(request)
    return repository.getLibrary(auth.tenantId, auth.userId)
  })

  app.post('/api/v1/music/library/playlists', async (request) => {
    const auth = getAuth(request)
    const body = request.body as { name?: string }
    const name = body.name?.trim() ?? ''
    if (!name) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'Playlist name is required')
    }
    return repository.createPlaylist(auth.tenantId, auth.userId, name)
  })

  app.delete('/api/v1/music/library/playlists/:id', async (request) => {
    const auth = getAuth(request)
    const playlistId = getParamId(request)
    return repository.removePlaylist(auth.tenantId, auth.userId, playlistId)
  })

  app.post('/api/v1/music/library/playlists/:id/tracks', async (request) => {
    const auth = getAuth(request)
    const playlistId = getParamId(request)
    const body = request.body as { track?: MusicTrack }
    if (!body.track?.id) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'track is required')
    }
    return repository.addTrackToPlaylist(auth.tenantId, auth.userId, playlistId, body.track)
  })

  app.post('/api/v1/music/library/likes/toggle', async (request) => {
    const auth = getAuth(request)
    const body = request.body as { track?: MusicTrack }
    if (!body.track?.id) {
      throw new MusicApiError(400, 'VALIDATION_ERROR', 'track is required')
    }
    return repository.toggleLikedTrack(auth.tenantId, auth.userId, body.track)
  })

  app.get('/api/v1/music/health', async () => {
    const response: MusicHealthResponse = {
      ok: true,
      cache: {
        status: 'ready',
      },
      provider: provider.getHealth(),
      token: {
        status: 'not_required',
        expiresAt: null,
      },
    }
    return response
  })
}

function getAuth(request: FastifyRequest) {
  const auth = (request as AuthenticatedRequest).auth
  if (!auth) {
    throw new MusicApiError(401, 'UNAUTHORIZED_SESSION', 'Authentication is required')
  }
  return auth
}

function getOptionalAuth(request: FastifyRequest) {
  return (request as AuthenticatedRequest).auth ?? null
}

function getParamId(request: FastifyRequest): string {
  const params = request.params as { id?: string }
  if (!params.id) {
    throw new MusicApiError(400, 'VALIDATION_ERROR', 'Track id is required')
  }
  return params.id
}

function clampLimit(raw: string | undefined, fallback: number): number {
  const value = raw ? Number.parseInt(raw, 10) : fallback
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.max(1, Math.min(20, value))
}

async function executeVoiceCommand(text: string): Promise<MusicVoiceExecuteResponse> {
  const normalized = text.toLowerCase()

  if (normalized.startsWith('пауза')) {
    return { action: 'pause', text: 'Playback paused.' }
  }

  if (normalized.startsWith('продолжи')) {
    return { action: 'resume', text: 'Playback resumed.' }
  }

  if (normalized.startsWith('останови музыку')) {
    return { action: 'stop', text: 'Playback stopped.' }
  }

  if (normalized.startsWith('открой текущий трек')) {
    return { action: 'open_current_track', text: 'Opening current track.' }
  }

  const playSimilarMatch = normalized.match(/^включи похожее на\s+(.+)$/u)
  if (playSimilarMatch) {
    const searchResponse = await buildSearchResponse(playSimilarMatch[1], 'mixed')
    if (!searchResponse.topResult) {
      return { action: 'search_results', text: 'No matching tracks found.', searchResponse }
    }
    const tracks = await provider.getRecommendations(searchResponse.topResult.id, 6)
    if (!tracks[0]) {
      return { action: 'search_results', text: 'No similar tracks found.' }
    }
    return {
      action: 'disambiguation_required',
      text: 'Choose one of the similar tracks.',
      matches: tracks,
    }
  }

  const findArtistMatch = normalized.match(/^найди\s+(.+)$/u)
  if (findArtistMatch) {
    return {
      action: 'search_results',
      text: 'Search results ready.',
      searchResponse: await buildSearchResponse(findArtistMatch[1], 'mixed'),
    }
  }

  const playMatch = normalized.match(/^включи\s+(.+)$/u)
  if (playMatch) {
    const searchResponse = await buildSearchResponse(playMatch[1], 'mixed')
    const topResult = searchResponse.topResult
    if (!topResult) {
      return {
        action: 'search_results',
        text: 'No matching tracks found.',
        searchResponse,
      }
    }

    return {
      action: 'playback_ready',
      text: `Ready to play ${topResult.title}.`,
      searchResponse,
      playbackPayload: await playbackResolver.resolve(topResult),
    }
  }

  return {
    action: 'search_results',
    text: 'Command recognized as a search request.',
    searchResponse: await buildSearchResponse(text, 'mixed'),
  }
}

async function buildSearchResponse(query: string, type: MusicSearchType): Promise<MusicSearchResponse> {
  const requestId = createRequestId()
  const tracks = await provider.search(query, 6, type)
  return {
    query,
    topResult: tracks[0] ?? null,
    tracks,
    artists: [],
    albums: [],
    metadata: {
      cached: false,
      provider: 'youtube',
      requestId,
    },
  }
}

function toMinimalTrack(track: MusicTrack) {
  return {
    id: track.id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    cover: track.coverUrl,
    duration: track.durationMs,
  }
}

function trackFromPlaybackPayload(payload: MusicPlaybackPayload): MusicTrack {
  return {
    id: payload.trackId,
    title: payload.title,
    artists: payload.artists,
    album: null,
    durationMs: null,
    coverUrl: payload.coverUrl,
    externalUrl: payload.externalUrl,
    playbackAvailable: true,
    sourceProvider: 'youtube',
  }
}
