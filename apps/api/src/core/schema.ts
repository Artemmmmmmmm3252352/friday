import type { PoolClient } from 'pg'

import { Database } from './db'

export async function ensureSchema(database: Database): Promise<void> {
  await database.withTransaction(async (client) => {
    await client.query(SCHEMA_SQL)
  })
}

export async function truncateAllTables(client: PoolClient): Promise<void> {
  await client.query(`
    TRUNCATE TABLE
      audit_log,
      agent_mail_messages,
      agent_mail_accounts,
      agent_memories,
      inbox_items,
      reminders,
      tasks,
      notes,
      linked_service_accounts,
      music_recently_played,
      music_recent_searches,
      music_library_playlist_tracks,
      music_library_playlists,
      music_liked_tracks,
      app_tokens,
      app_clients,
      device_sessions,
      memberships,
      user_settings,
      users,
      tenants
    RESTART IDENTITY CASCADE
  `)
}

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  locale TEXT NOT NULL,
  bedtime_start TEXT,
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES app_clients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS linked_service_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  external_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, service_name),
  UNIQUE (service_name, external_user_id)
);

CREATE TABLE IF NOT EXISTS music_recent_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, normalized_query)
);

CREATE TABLE IF NOT EXISTS music_recently_played (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  provider_track_id TEXT NOT NULL,
  track_snapshot JSONB NOT NULL,
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS music_liked_tracks (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  track_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id, track_id)
);

CREATE TABLE IF NOT EXISTS music_library_playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT 'Custom playlist',
  cover_url TEXT,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS music_library_playlist_tracks (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id UUID NOT NULL REFERENCES music_library_playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,
  track_snapshot JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playlist_id, track_id)
);

CREATE TABLE IF NOT EXISTS agent_mail_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'agentmail',
  address TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Friday',
  inbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  detail TEXT NOT NULL DEFAULT '',
  last_synced_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, provider)
);

CREATE TABLE IF NOT EXISTS agent_mail_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES agent_mail_accounts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  external_id TEXT,
  thread_id TEXT,
  from_name TEXT,
  from_address TEXT NOT NULL,
  to_addresses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cc_addresses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  subject TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  labels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_mail_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES agent_mail_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  notes TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT NOT NULL,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none',
  timezone TEXT NOT NULL,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS x_vexta_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS x_vexta_sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES x_vexta_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS x_vexta_projects (
  user_id UUID NOT NULL REFERENCES x_vexta_users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  color TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS x_vexta_tags (
  user_id UUID NOT NULL REFERENCES x_vexta_users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS x_vexta_notes (
  user_id UUID NOT NULL REFERENCES x_vexta_users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  project_id TEXT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  due_date TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tag_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  links_to TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  CONSTRAINT x_vexta_notes_project_fk
    FOREIGN KEY (user_id, project_id)
    REFERENCES x_vexta_projects(user_id, id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS x_vexta_notebooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS x_vexta_note_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id UUID REFERENCES x_vexta_notebooks(id) ON DELETE SET NULL,
  core_note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
  title TEXT,
  body TEXT NOT NULL,
  body_format TEXT NOT NULL DEFAULT 'markdown',
  summary TEXT,
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'x_vexta_notes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS x_vexta_note_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, label)
);

CREATE TABLE IF NOT EXISTS x_vexta_note_entry_tags (
  note_entry_id UUID NOT NULL REFERENCES x_vexta_note_entries(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES x_vexta_note_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS inbox_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ,
  source_type TEXT NOT NULL,
  source_id UUID,
  signal_code TEXT,
  dedupe_key TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  links TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_remembered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, category, slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_dedupe_key_idx
  ON inbox_items(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE music_library_playlist_tracks
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE music_library_playlist_tracks
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE music_library_playlists
  ADD COLUMN IF NOT EXISTS subtitle TEXT NOT NULL DEFAULT 'Custom playlist';

ALTER TABLE music_library_playlists
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE music_library_playlists
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE music_library_playlists
  ADD COLUMN IF NOT EXISTS cover_url TEXT;

ALTER TABLE audit_log
  ALTER COLUMN entity_id TYPE TEXT
  USING entity_id::text;

CREATE INDEX IF NOT EXISTS notes_tenant_user_idx ON notes(tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_tenant_user_idx ON tasks(tenant_id, user_id, due_at);
CREATE INDEX IF NOT EXISTS reminders_tenant_user_idx ON reminders(tenant_id, user_id, scheduled_at);
CREATE INDEX IF NOT EXISTS linked_service_accounts_user_idx ON linked_service_accounts(user_id, service_name);
CREATE INDEX IF NOT EXISTS agent_mail_accounts_tenant_user_idx ON agent_mail_accounts(tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_mail_messages_account_folder_idx ON agent_mail_messages(account_id, folder, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_mail_messages_tenant_user_idx ON agent_mail_messages(tenant_id, user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agent_mail_messages_external_idx
  ON agent_mail_messages(account_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_mail_contacts_account_name_idx ON agent_mail_contacts(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_mail_contacts_tenant_user_idx ON agent_mail_contacts(tenant_id, user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agent_mail_contacts_account_email_idx
  ON agent_mail_contacts(account_id, email);
CREATE INDEX IF NOT EXISTS x_vexta_projects_user_updated_idx ON x_vexta_projects(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS music_liked_tracks_tenant_user_idx ON music_liked_tracks(tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS music_library_playlists_tenant_user_idx ON music_library_playlists(tenant_id, user_id, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS music_library_playlist_tracks_playlist_idx ON music_library_playlist_tracks(playlist_id, position ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS music_library_playlist_tracks_tenant_user_idx ON music_library_playlist_tracks(tenant_id, user_id, playlist_id, position ASC);
CREATE INDEX IF NOT EXISTS x_vexta_tags_user_label_idx ON x_vexta_tags(user_id, label);
CREATE INDEX IF NOT EXISTS x_vexta_notes_user_updated_idx ON x_vexta_notes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS x_vexta_notes_user_project_idx ON x_vexta_notes(user_id, project_id);
CREATE INDEX IF NOT EXISTS x_vexta_sessions_user_idx ON x_vexta_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS x_vexta_notebooks_tenant_user_idx ON x_vexta_notebooks(tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS x_vexta_note_entries_tenant_user_idx ON x_vexta_note_entries(tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS x_vexta_note_entries_notebook_idx ON x_vexta_note_entries(notebook_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS inbox_tenant_user_idx ON inbox_items(tenant_id, user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_memories_tenant_user_idx ON agent_memories(tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_memories_category_slug_idx ON agent_memories(tenant_id, user_id, category, slug);
`
