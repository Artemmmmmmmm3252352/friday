export function createMusicInternalTrackId(providerTrackId: string): string {
  return providerTrackId.trim()
}

export function getProviderTrackId(trackId: string): string {
  return trackId.trim()
}

export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, ' ')
}

export function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
