import type { MusicConfig } from '../config'
import { MusicApiError } from '../errors'
import type {
  MusicBrowseItem,
  MusicBrowseSection,
  MusicCollectionKind,
  MusicCollectionViewModel,
  MusicSearchMode,
  MusicSearchType,
  MusicTrack,
  MusicTrackDetails,
} from '../models'
import { createMusicInternalTrackId } from '../utils'

type YouTubeSearchResponse = {
  items?: YouTubeSearchItem[]
  error?: {
    message?: string
  }
}

type YouTubeSearchItem = {
  id?: {
    videoId?: string
    playlistId?: string
    channelId?: string
  }
  snippet?: {
    title?: string
    channelTitle?: string
    description?: string
    thumbnails?: {
      high?: { url?: string }
      medium?: { url?: string }
      default?: { url?: string }
    }
  }
}

type YouTubeVideosResponse = {
  items?: YouTubeVideoItem[]
  error?: {
    message?: string
  }
}

type YouTubePlaylistsResponse = {
  items?: YouTubePlaylistItem[]
  error?: {
    message?: string
  }
}

type YouTubePlaylistItem = {
  id?: string
  snippet?: {
    title?: string
    description?: string
    channelTitle?: string
    thumbnails?: {
      high?: { url?: string }
      medium?: { url?: string }
      default?: { url?: string }
    }
  }
  contentDetails?: {
    itemCount?: number
  }
}

type YouTubePlaylistItemsResponse = {
  items?: YouTubePlaylistTrackItem[]
  error?: {
    message?: string
  }
}

type YouTubePlaylistTrackItem = {
  snippet?: {
    title?: string
    channelTitle?: string
    description?: string
    thumbnails?: {
      high?: { url?: string }
      medium?: { url?: string }
      default?: { url?: string }
    }
    resourceId?: {
      videoId?: string
    }
  }
  contentDetails?: {
    videoId?: string
  }
}

type YouTubeVideoItem = {
  id?: string
  snippet?: {
    title?: string
    description?: string
    channelTitle?: string
    thumbnails?: {
      high?: { url?: string }
      medium?: { url?: string }
      default?: { url?: string }
    }
  }
  contentDetails?: {
    duration?: string
  }
  status?: {
    embeddable?: boolean
  }
}

const NEGATIVE_PATTERNS = [
  /\blive\b/iu,
  /\bremix\b/iu,
  /\bkaraoke\b/iu,
  /\bslowed\b/iu,
  /\breverb\b/iu,
  /\bnightcore\b/iu,
  /\bsped[\s-]?up\b/iu,
]

const STRIP_PATTERNS = [
  /\((official\s+video|official\s+music\s+video|official\s+audio|lyrics?|hd)\)/giu,
  /\[(official\s+video|official\s+music\s+video|official\s+audio|lyrics?|hd)\]/giu,
]

export class YouTubeMetadataProvider {
  private readonly trackCache = new Map<string, MusicTrackDetails>()

  constructor(private readonly config: MusicConfig) {}

  getHealth() {
    if (!this.config.youtubeDataApiKey) {
      return {
        status: 'degraded' as const,
        mode: 'youtube-data-api' as const,
        detail: 'YouTube Data API key is not configured.',
      }
    }

    return {
      status: 'ready' as const,
      mode: 'youtube-data-api' as const,
      detail: 'YouTube metadata and playback search are configured.',
    }
  }

  async search(query: string, limit: number, _type: MusicSearchType, mode: MusicSearchMode = 'default'): Promise<MusicTrack[]> {
    const payload = await this.fetchYouTubeSearch(applySearchMode(query, mode), Math.min(20, Math.max(limit * 2, limit)))
    const ids = payload.items
      ?.map((item) => item.id?.videoId?.trim() ?? '')
      .filter(Boolean)
      ?? []

    if (ids.length === 0) {
      return []
    }

    const detailedTracks = await this.fetchTracksByIds(ids)
    const detailedById = new Map(detailedTracks.map((track) => [track.id, track]))
    const resolvedTracks = ids
      .map((id) => detailedById.get(id))
      .filter((track): track is MusicTrackDetails => Boolean(track))
    const orderedTracks = resolvedTracks
      .filter((track) => !shouldFilterTrack(track, mode))
      .slice(0, limit)
    const fallbackTracks = resolvedTracks.slice(0, limit)
    const finalTracks = orderedTracks.length > 0 ? orderedTracks : fallbackTracks

    this.rememberTracks(finalTracks)
    return finalTracks
  }

  async getTrack(trackId: string): Promise<MusicTrackDetails> {
    const cached = this.trackCache.get(trackId)
    if (cached && cached.durationMs !== null && cached.description !== null) {
      return cached
    }

    const tracks = await this.fetchTracksByIds([trackId])
    const track = tracks[0]
    if (!track) {
      throw new MusicApiError(404, 'VALIDATION_ERROR', 'Track not found', false)
    }

    this.rememberTracks([track])
    return track
  }

  async getRecommendations(seedTrackId: string, limit: number): Promise<MusicTrack[]> {
    const seed = await this.getTrack(seedTrackId)
    const query = `${seed.artists[0] ?? ''} ${seed.title}`.trim()
    const tracks = await this.search(query, Math.max(limit + 1, 6), 'mixed', 'default')
    return tracks.filter((track) => track.id !== seedTrackId).slice(0, limit)
  }

  async browse(section: MusicBrowseSection, limit: number, query?: string): Promise<MusicBrowseItem[]> {
    const browseConfig = getBrowseConfig(section, query)
    const queries = Array.isArray(browseConfig.query) ? browseConfig.query : [browseConfig.query]
    const collected = new Map<string, MusicBrowseItem>()

    for (const browseQuery of queries) {
      const payload = await this.fetchYouTubeCatalog(browseQuery, browseConfig.type, Math.max(limit, 6))
      for (const item of payload.items ?? []) {
        const mapped = mapBrowseItem(item, section)
        if (mapped && !collected.has(mapped.id)) {
          collected.set(mapped.id, mapped)
        }
        if (collected.size >= limit) {
          break
        }
      }
      if (collected.size >= limit) {
        break
      }
    }

    return [...collected.values()].slice(0, limit)
  }

  async getCollection(kind: MusicCollectionKind, id: string): Promise<MusicCollectionViewModel> {
    const playlist = await this.fetchPlaylist(id)
    if (!playlist) {
      throw new MusicApiError(404, 'VALIDATION_ERROR', 'Collection not found', false)
    }

    const playlistItems = await this.fetchPlaylistItems(id)
    const videoIds = playlistItems
      .map((item) => item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId ?? '')
      .map((value) => value.trim())
      .filter(Boolean)

    const detailedTracks = await this.fetchTracksByIds(videoIds)
    const detailedById = new Map(detailedTracks.map((track) => [track.id, track]))
    const tracks = videoIds
      .map((videoId) => detailedById.get(videoId))
      .filter((track): track is MusicTrackDetails => Boolean(track))

    this.rememberTracks(tracks)

    return {
      id,
      kind,
      title: cleanTitle(playlist.snippet?.title ?? 'Untitled collection'),
      subtitle: playlist.snippet?.channelTitle ? decodeHtmlEntities(playlist.snippet.channelTitle) : null,
      description: playlist.snippet?.description ? decodeHtmlEntities(playlist.snippet.description) : null,
      coverUrl:
        playlist.snippet?.thumbnails?.high?.url ??
        playlist.snippet?.thumbnails?.medium?.url ??
        playlist.snippet?.thumbnails?.default?.url ??
        tracks[0]?.coverUrl ??
        null,
      externalUrl: `https://www.youtube.com/playlist?list=${id}`,
      tracks,
      metadata: {
        cached: false,
        provider: 'youtube',
        requestId: `collection-${Date.now().toString(36)}`,
      },
    }
  }

  private async fetchYouTubeSearch(query: string, limit: number): Promise<YouTubeSearchResponse> {
    const url = new URL('https://www.googleapis.com/youtube/v3/search')
    url.searchParams.set('key', this.config.youtubeDataApiKey)
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'video')
    url.searchParams.set('videoCategoryId', '10')
    url.searchParams.set('videoEmbeddable', 'true')
    url.searchParams.set('maxResults', String(limit))

    return this.fetchYouTube<YouTubeSearchResponse>(url)
  }

  private async fetchYouTubeCatalog(query: string, type: 'playlist' | 'channel', limit: number): Promise<YouTubeSearchResponse> {
    const url = new URL('https://www.googleapis.com/youtube/v3/search')
    url.searchParams.set('key', this.config.youtubeDataApiKey)
    url.searchParams.set('part', 'snippet')
    url.searchParams.set('q', query)
    url.searchParams.set('type', type)
    url.searchParams.set('maxResults', String(Math.min(20, Math.max(1, limit))))

    return this.fetchYouTube<YouTubeSearchResponse>(url)
  }

  private async fetchTracksByIds(ids: string[]): Promise<MusicTrackDetails[]> {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 20)
    if (uniqueIds.length === 0) {
      return []
    }

    const url = new URL('https://www.googleapis.com/youtube/v3/videos')
    url.searchParams.set('key', this.config.youtubeDataApiKey)
    url.searchParams.set('part', 'snippet,contentDetails,status')
    url.searchParams.set('id', uniqueIds.join(','))

    const payload = await this.fetchYouTube<YouTubeVideosResponse>(url)
    return payload.items
      ?.filter((item) => item.status?.embeddable !== false)
      ?.map((item) => mapYouTubeVideoItem(item))
      .filter((track) => !shouldFilterTrack(track, 'default'))
      ?? []
  }

  private async fetchPlaylist(id: string): Promise<YouTubePlaylistItem | null> {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlists')
    url.searchParams.set('key', this.config.youtubeDataApiKey)
    url.searchParams.set('part', 'snippet,contentDetails')
    url.searchParams.set('id', id)
    url.searchParams.set('maxResults', '1')

    const payload = await this.fetchYouTube<YouTubePlaylistsResponse>(url)
    return payload.items?.[0] ?? null
  }

  private async fetchPlaylistItems(id: string): Promise<YouTubePlaylistTrackItem[]> {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
    url.searchParams.set('key', this.config.youtubeDataApiKey)
    url.searchParams.set('part', 'snippet,contentDetails')
    url.searchParams.set('playlistId', id)
    url.searchParams.set('maxResults', '20')

    const payload = await this.fetchYouTube<YouTubePlaylistItemsResponse>(url)
    return payload.items ?? []
  }

  private async fetchYouTube<T extends { error?: { message?: string } }>(url: URL, allowRetry = true): Promise<T> {
    if (!this.config.youtubeDataApiKey) {
      throw new MusicApiError(503, 'PROVIDER_UNAVAILABLE', 'YouTube Data API key is not configured', false)
    }

    let response: Response
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
    } catch {
      if (allowRetry) {
        return this.fetchYouTube<T>(url, false)
      }
      throw new MusicApiError(504, 'NETWORK_TIMEOUT', 'YouTube request timed out', true)
    }

    if (response.status === 429) {
      throw new MusicApiError(429, 'YOUTUBE_RATE_LIMIT', 'YouTube temporarily limited requests', true)
    }

    if (!response.ok) {
      const detail = await response.json().catch(() => null) as T | null
      const message = detail?.error?.message ?? 'YouTube API request failed'
      throw new MusicApiError(503, 'YOUTUBE_API_ERROR', message, response.status >= 500)
    }

    return response.json() as Promise<T>
  }

  private rememberTracks(tracks: MusicTrackDetails[]): void {
    for (const track of tracks) {
      this.trackCache.set(track.id, track)
    }
  }
}

function applySearchMode(query: string, mode: MusicSearchMode): string {
  if (mode === 'remix') {
    return `${query} remix`
  }

  if (mode === 'live') {
    return `${query} live performance`
  }

  if (mode === 'acoustic') {
    return `${query} acoustic`
  }

  return query
}

function shouldFilterTrack(track: MusicTrackDetails, mode: MusicSearchMode): boolean {
  const haystack = `${track.title} ${track.artists.join(' ')} ${track.channelTitle ?? ''}`

  if (mode === 'remix') {
    if (!/\bremix\b/iu.test(haystack)) {
      return true
    }
    return /\blive\b|\bkaraoke\b|\bnightcore\b|\bslowed\b|\breverb\b|\bsped[\s-]?up\b/iu.test(haystack)
  }

  if (mode === 'live') {
    if (!/\blive\b/iu.test(haystack)) {
      return true
    }
    return /\bkaraoke\b|\bnightcore\b|\bslowed\b|\breverb\b|\bsped[\s-]?up\b/iu.test(haystack)
  }

  if (mode === 'acoustic') {
    if (!/\bacoustic\b/iu.test(haystack)) {
      return true
    }
    return /\bkaraoke\b|\bnightcore\b|\bslowed\b|\breverb\b|\bsped[\s-]?up\b/iu.test(haystack)
  }

  return NEGATIVE_PATTERNS.some((pattern) => pattern.test(haystack))
}

function mapYouTubeVideoItem(item: YouTubeVideoItem): MusicTrackDetails {
  return buildTrack({
    id: item.id ?? '',
    title: item.snippet?.title ?? 'Unknown track',
    channelTitle: item.snippet?.channelTitle ?? null,
    description: item.snippet?.description ?? null,
    coverUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? null,
    durationMs: parseIsoDuration(item.contentDetails?.duration),
  })
}

function buildTrack(input: {
  id: string
  title: string
  channelTitle: string | null
  description: string | null
  coverUrl: string | null
  durationMs: number | null
}): MusicTrackDetails {
  const cleanedTitle = cleanTitle(input.title)
  const cleanedChannelTitle = input.channelTitle ? decodeHtmlEntities(input.channelTitle) : null
  const artists = inferArtists(cleanedTitle, cleanedChannelTitle)
  const trackTitle = extractTrackTitle(cleanedTitle, artists[0] ?? cleanedChannelTitle)

  return {
    id: createMusicInternalTrackId(input.id),
    title: trackTitle,
    artists,
    album: null,
    durationMs: input.durationMs,
    coverUrl: input.coverUrl,
    externalUrl: `https://www.youtube.com/watch?v=${input.id}`,
    playbackAvailable: true,
    sourceProvider: 'youtube',
    channelTitle: cleanedChannelTitle,
    description: input.description ? decodeHtmlEntities(input.description) : null,
  }
}

function cleanTitle(title: string): string {
  return STRIP_PATTERNS.reduce((value, pattern) => value.replace(pattern, ''), decodeHtmlEntities(title))
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

function inferArtists(title: string, channelTitle: string | null): string[] {
  const separatorMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)$/u)
  if (separatorMatch) {
    return [separatorMatch[1].trim()]
  }

  const quotedTitleMatch = title.match(/^(.+?)\s+["“](.+?)["”]$/u)
  if (quotedTitleMatch) {
    return [quotedTitleMatch[1].trim()]
  }

  if (channelTitle) {
    return [channelTitle.replace(/\s*-\s*topic$/iu, '').trim()]
  }

  return ['Unknown artist']
}

function extractTrackTitle(title: string, primaryArtist?: string | null): string {
  const separatorMatch = title.match(/^(.+?)\s*[-–—]\s*(.+)$/u)
  if (separatorMatch) {
    return separatorMatch[2].trim()
  }

  const quotedTitleMatch = title.match(/^(.+?)\s+["“](.+?)["”]$/u)
  if (quotedTitleMatch) {
    const possibleArtist = quotedTitleMatch[1].trim()
    if (!primaryArtist || possibleArtist.toLowerCase() === primaryArtist.trim().toLowerCase()) {
      return quotedTitleMatch[2].trim()
    }
  }

  return title
}

function parseIsoDuration(value: string | undefined): number | null {
  if (!value) {
    return null
  }

  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u)
  if (!match) {
    return null
  }

  const hours = Number(match[1] ?? '0')
  const minutes = Number(match[2] ?? '0')
  const seconds = Number(match[3] ?? '0')
  return ((hours * 60 * 60) + (minutes * 60) + seconds) * 1000
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
}

function getBrowseConfig(section: MusicBrowseSection, query?: string) {
  const normalizedQuery = query?.trim()
  if (normalizedQuery) {
    if (section === 'artists') {
      return {
        type: 'channel' as const,
        query: normalizedQuery,
      }
    }

    return {
      type: 'playlist' as const,
      query: normalizedQuery,
    }
  }

  if (section === 'artists') {
    return {
      type: 'channel' as const,
      query: [
        'Taylor Swift official channel',
        'The Weeknd official channel',
        'Billie Eilish official channel',
        'Kendrick Lamar official channel',
      ],
    }
  }

  if (section === 'albums') {
    return {
      type: 'playlist' as const,
      query: [
        'official full album new music',
        'full album official audio',
      ],
    }
  }

  if (section === 'podcasts') {
    return {
      type: 'playlist' as const,
      query: [
        'music podcast interview',
        'artist interview podcast',
      ],
    }
  }

  return {
    type: 'playlist' as const,
    query: [
      'top hits music playlist 2026',
      'viral music playlist',
    ],
  }
}

function mapBrowseItem(item: YouTubeSearchItem, section: MusicBrowseSection): MusicBrowseItem | null {
  const title = cleanTitle(item.snippet?.title ?? '')
  const subtitle = item.snippet?.channelTitle ? decodeHtmlEntities(item.snippet.channelTitle) : null
  const coverUrl =
    item.snippet?.thumbnails?.high?.url ??
    item.snippet?.thumbnails?.medium?.url ??
    item.snippet?.thumbnails?.default?.url ??
    null

  if (section === 'artists') {
    const channelId = item.id?.channelId?.trim()
    if (!channelId || !title) {
      return null
    }

    return {
      id: channelId,
      kind: section,
      title,
      subtitle,
      coverUrl,
      externalUrl: `https://www.youtube.com/channel/${channelId}`,
      searchHint: title,
    }
  }

  const playlistId = item.id?.playlistId?.trim()
  if (!playlistId || !title) {
    return null
  }

  return {
    id: playlistId,
    kind: section,
    title,
    subtitle,
    coverUrl,
    externalUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
    searchHint: title,
  }
}
