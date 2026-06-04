export type MusicSearchType = 'track' | 'artist' | 'album' | 'mixed'
export type MusicSearchMode = 'default' | 'remix' | 'live' | 'acoustic'
export type MusicBrowseSection = 'playlists' | 'albums' | 'artists' | 'podcasts'
export type MusicCollectionKind = 'playlists' | 'albums' | 'podcasts'
export type MusicPlaybackType = 'embed' | 'external_url' | 'provider_sdk'
export type MusicPlaybackProvider = 'youtube' | 'soundcloud' | 'spotify_sdk'
export type MusicErrorType =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED_SESSION'
  | 'YOUTUBE_RATE_LIMIT'
  | 'YOUTUBE_API_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'PLAYBACK_SOURCE_NOT_FOUND'
  | 'NETWORK_TIMEOUT'
  | 'MALFORMED_RESPONSE'
  | 'INTERNAL_ERROR'

export interface MusicTrack {
  id: string
  title: string
  artists: string[]
  album: string | null
  durationMs: number | null
  coverUrl: string | null
  externalUrl: string | null
  playbackAvailable: boolean
  sourceProvider: 'youtube'
}

export interface MusicTrackDetails extends MusicTrack {
  channelTitle: string | null
  description: string | null
}

export interface MusicSearchResponse {
  query: string
  topResult: MusicTrack | null
  tracks: MusicTrack[]
  artists: []
  albums: []
  metadata: {
    cached: boolean
    provider: 'youtube'
    requestId: string
  }
}

export interface MusicBrowseItem {
  id: string
  kind: MusicBrowseSection
  title: string
  subtitle: string | null
  coverUrl: string | null
  externalUrl: string | null
  searchHint: string
}

export interface MusicBrowseResponse {
  section: MusicBrowseSection
  query: string | null
  items: MusicBrowseItem[]
  metadata: {
    cached: boolean
    provider: 'youtube'
    requestId: string
  }
}

export interface MusicCollectionViewModel {
  id: string
  kind: MusicCollectionKind
  title: string
  subtitle: string | null
  description: string | null
  coverUrl: string | null
  externalUrl: string | null
  tracks: MusicTrack[]
  metadata: {
    cached: boolean
    provider: 'youtube'
    requestId: string
  }
}

export interface MusicRecommendationsResponse {
  seedTrackId: string
  tracks: MusicTrack[]
  metadata: {
    cached: boolean
    provider: 'youtube'
    requestId: string
  }
}

export interface MusicPlaybackPayload {
  trackId: string
  provider: MusicPlaybackProvider
  playbackType: MusicPlaybackType
  playbackUrl: string
  videoId: string
  embedUrl: string
  title: string
  artists: string[]
  coverUrl: string | null
  startPositionMs: number
  ready: boolean
  playbackQuery: string
  externalUrl: string
}

export interface MusicHealthResponse {
  ok: boolean
  cache: {
    status: 'ready'
  }
  provider: {
    status: 'ready' | 'degraded' | 'error'
    mode: 'youtube-data-api'
    detail: string
  }
  token: {
    status: 'not_required'
    expiresAt: null
  }
}

export interface MusicRecentSearch {
  id: string
  query: string
  lastUsedAt: string
  useCount: number
}

export interface MusicRecentlyPlayed {
  id: string
  playedAt: string
  track: MusicTrack
}

export interface MusicLibraryPlaylist {
  id: string
  name: string
  subtitle: string
  createdAt: string
  tracks: MusicTrack[]
  pinned?: boolean
  isSystem?: boolean
}

export interface MusicLibraryResponse {
  playlists: MusicLibraryPlaylist[]
  likedTracks: MusicTrack[]
}

export interface MusicVoiceExecuteResponse {
  action:
    | 'search_results'
    | 'playback_ready'
    | 'pause'
    | 'resume'
    | 'stop'
    | 'open_current_track'
    | 'disambiguation_required'
  text: string
  searchResponse?: MusicSearchResponse
  playbackPayload?: MusicPlaybackPayload
  matches?: MusicTrack[]
}

export interface MusicErrorEnvelope {
  error: {
    code: MusicErrorType
    type: MusicErrorType
    message: string
    retryable: boolean
    requestId?: string
  }
}
