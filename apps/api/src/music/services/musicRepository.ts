import { randomUUID } from 'node:crypto'

import { Database } from '../../core/db'
import type { MusicLibraryPlaylist, MusicLibraryResponse, MusicRecentSearch, MusicRecentlyPlayed, MusicTrack } from '../models'

export class MusicRepository {
  constructor(private readonly database: Database) {}

  async getLibrary(tenantId: string, userId: string): Promise<MusicLibraryResponse> {
    const [likedRows, playlistRows, playlistTrackRows] = await Promise.all([
      this.database.query<{
        track_id: string
        track_snapshot: MusicTrack
      }>(
        `
        SELECT track_id, track_snapshot
        FROM music_liked_tracks
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY updated_at DESC
        `,
        [tenantId, userId],
      ),
      this.database.query<{
        id: string
        name: string
        subtitle: string
        created_at: Date
        pinned: boolean
      }>(
        `
        SELECT id, name, subtitle, created_at, pinned
        FROM music_library_playlists
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY pinned DESC, created_at ASC
        `,
        [tenantId, userId],
      ),
      this.database.query<{
        playlist_id: string
        position: number
        track_snapshot: MusicTrack
      }>(
        `
        SELECT playlist_id, position, track_snapshot
        FROM music_library_playlist_tracks
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY playlist_id ASC, position ASC, created_at ASC
        `,
        [tenantId, userId],
      ),
    ])

    const likedTracks = likedRows.map((row) => row.track_snapshot)
    const playlistTracks = new Map<string, MusicTrack[]>()

    for (const row of playlistTrackRows) {
      const entries = playlistTracks.get(row.playlist_id) ?? []
      entries.push(row.track_snapshot)
      playlistTracks.set(row.playlist_id, entries)
    }

    const playlists: MusicLibraryPlaylist[] = [
      {
        id: 'liked',
        name: 'Liked Songs',
        subtitle: `${likedTracks.length} saved tracks`,
        createdAt: new Date(0).toISOString(),
        tracks: likedTracks,
        pinned: true,
        isSystem: true,
      },
      ...playlistRows.map((row) => ({
        id: row.id,
        name: row.name,
        subtitle: row.subtitle,
        createdAt: row.created_at.toISOString(),
        tracks: playlistTracks.get(row.id) ?? [],
        pinned: row.pinned,
        isSystem: false,
      })),
    ]

    return {
      playlists,
      likedTracks,
    }
  }

  async createPlaylist(tenantId: string, userId: string, name: string): Promise<MusicLibraryResponse> {
    const trimmed = name.trim()
    if (!trimmed) {
      return this.getLibrary(tenantId, userId)
    }

    await this.database.query(
      `
      INSERT INTO music_library_playlists (id, tenant_id, user_id, name, subtitle, pinned, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
      `,
      [randomUUID(), tenantId, userId, trimmed, 'Custom playlist'],
    )

    return this.getLibrary(tenantId, userId)
  }

  async removePlaylist(tenantId: string, userId: string, playlistId: string): Promise<MusicLibraryResponse> {
    await this.database.query(
      `
      DELETE FROM music_library_playlists
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3
      `,
      [tenantId, userId, playlistId],
    )

    return this.getLibrary(tenantId, userId)
  }

  async addTrackToPlaylist(tenantId: string, userId: string, playlistId: string, track: MusicTrack): Promise<MusicLibraryResponse> {
    const positionRows = await this.database.query<{ next_position: number }>(
      `
      SELECT COALESCE(MAX(position), 0) + 1 AS next_position
      FROM music_library_playlist_tracks
      WHERE tenant_id = $1 AND user_id = $2 AND playlist_id = $3
      `,
      [tenantId, userId, playlistId],
    )

    await this.database.query(
      `
      INSERT INTO music_library_playlist_tracks (tenant_id, user_id, playlist_id, track_id, track_snapshot, position, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())
      ON CONFLICT (playlist_id, track_id)
      DO UPDATE SET track_snapshot = EXCLUDED.track_snapshot, updated_at = NOW()
      `,
      [tenantId, userId, playlistId, track.id, JSON.stringify(track), positionRows[0]?.next_position ?? 1],
    )

    return this.getLibrary(tenantId, userId)
  }

  async toggleLikedTrack(tenantId: string, userId: string, track: MusicTrack): Promise<MusicLibraryResponse> {
    const existingRows = await this.database.query<{ track_id: string }>(
      `
      SELECT track_id
      FROM music_liked_tracks
      WHERE tenant_id = $1 AND user_id = $2 AND track_id = $3
      LIMIT 1
      `,
      [tenantId, userId, track.id],
    )

    if (existingRows[0]) {
      await this.database.query(
        `
        DELETE FROM music_liked_tracks
        WHERE tenant_id = $1 AND user_id = $2 AND track_id = $3
        `,
        [tenantId, userId, track.id],
      )
    } else {
      await this.database.query(
        `
        INSERT INTO music_liked_tracks (tenant_id, user_id, track_id, track_snapshot, created_at, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())
        ON CONFLICT (tenant_id, user_id, track_id)
        DO UPDATE SET track_snapshot = EXCLUDED.track_snapshot, updated_at = NOW()
        `,
        [tenantId, userId, track.id, JSON.stringify(track)],
      )
    }

    return this.getLibrary(tenantId, userId)
  }

  async recordSearch(tenantId: string, userId: string, query: string): Promise<void> {
    await this.database.query(
      `
      INSERT INTO music_recent_searches (id, tenant_id, user_id, query, normalized_query, use_count, last_used_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, lower($4), 1, NOW(), NOW(), NOW())
      ON CONFLICT (tenant_id, user_id, normalized_query)
      DO UPDATE SET use_count = music_recent_searches.use_count + 1, last_used_at = NOW(), updated_at = NOW()
      `,
      [randomUUID(), tenantId, userId, query],
    )
  }

  async listRecentSearches(tenantId: string, userId: string): Promise<MusicRecentSearch[]> {
    return this.database.query<{
      id: string
      query: string
      last_used_at: Date
      use_count: number
    }>(
      `
      SELECT id, query, last_used_at, use_count
      FROM music_recent_searches
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY last_used_at DESC
      LIMIT 8
      `,
      [tenantId, userId],
    ).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        query: row.query,
        lastUsedAt: row.last_used_at.toISOString(),
        useCount: row.use_count,
      })),
    )
  }

  async recordRecentlyPlayed(tenantId: string, userId: string, track: MusicTrack): Promise<void> {
    await this.database.query(
      `
      INSERT INTO music_recently_played (id, tenant_id, user_id, track_id, provider_track_id, track_snapshot, played_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW(), NOW())
      `,
      [randomUUID(), tenantId, userId, track.id, track.id, JSON.stringify(track)],
    )
  }

  async listRecentlyPlayed(tenantId: string, userId: string): Promise<MusicRecentlyPlayed[]> {
    return this.database.query<{
      id: string
      played_at: Date
      track_snapshot: MusicTrack
    }>(
      `
      SELECT id, played_at, track_snapshot
      FROM music_recently_played
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY played_at DESC
      LIMIT 12
      `,
      [tenantId, userId],
    ).then((rows) =>
      rows.map((row) => ({
        id: row.id,
        playedAt: row.played_at.toISOString(),
        track: row.track_snapshot,
      })),
    )
  }
}
