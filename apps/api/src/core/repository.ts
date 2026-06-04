import { randomUUID } from 'node:crypto'

import type { PoolClient } from 'pg'

import type {
  AgentActionRequest,
  AgentActionResult,
  AgentContext,
  AgentMailAccount,
  AgentMailContact,
  AgentMailConnectionStatus,
  AgentMailFolder,
  AgentMailMessage,
  AppLanguage,
  AuthSession,
  CreateAgentMailMessageInput,
  CreateAppTokenInput,
  CreateMemoryInput,
  CreateNoteInput,
  CreateReminderInput,
  CreateTaskInput,
  CreateXVextaNoteInput,
  CreateXVextaProjectInput,
  InboxItem,
  ListAgentMailContactsInput,
  ListAgentMailMessagesInput,
  LocalSessionInput,
  MemoryCategory,
  MemoryEntry,
  Note,
  Reminder,
  ReminderRecurrence,
  Task,
  TaskStatus,
  UpsertAgentMailContactInput,
  UpsertAgentMailAccountInput,
  UpdateMemoryInput,
  UpdateNoteInput,
  UpdateReminderInput,
  UpdateSettingsInput,
  UpdateTaskInput,
  UpdateXVextaNoteInput,
  UpdateXVextaProjectInput,
  UserProfile,
  XVextaBlockInput,
  XVextaNote,
  XVextaNoteStatus,
  XVextaProject,
} from '@contracts'
import { isXVextaPlaceholderNoteContent } from '../../../../packages/contracts/src/xVextaNoteContent'
import {
  formatXVextaInlineText,
  parseXVextaRichText,
  stripXVextaHtml,
  summarizeXVextaBlockInputs,
} from '../../../../packages/contracts/src/xVextaRichText'

import {
  createAgentMailInbox,
  getAgentMailMessage as getRemoteAgentMailMessage,
  listAgentMailMessages as listRemoteAgentMailMessages,
  sendAgentMailMessage,
} from './agentMail'
import { Database } from './db'
import { buildAgentSignals, buildSignalInboxItem, createSignalDedupeKey, describeInboxSignalCode, isReminderDue, isTaskDueToday, isTaskOverdue } from './rules'
import { createOpaqueToken, hashPassword, hashToken, verifyPassword } from './security'

type AuthContext = {
  tenantId: string
  userId: string
  actorType: 'user' | 'app'
}

type UserRow = {
  id: string
  tenant_id: string
  email: string
  display_name: string
  avatar_url: string | null
  password_hash: string
  created_at: Date
  updated_at: Date
  timezone: AppLanguage | string
  locale: AppLanguage
  bedtime_start: string | null
  quiet_hours_start: string | null
  quiet_hours_end: string | null
}

type NoteRow = {
  id: string
  tenant_id: string
  user_id: string
  title: string | null
  body: string
  is_pinned: boolean
  is_archived: boolean
  created_at: Date
  updated_at: Date
}

type TaskRow = {
  id: string
  tenant_id: string
  user_id: string
  title: string
  description: string | null
  status: TaskStatus
  due_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

type ReminderRow = {
  id: string
  tenant_id: string
  user_id: string
  title: string
  body: string | null
  scheduled_at: Date
  recurrence: ReminderRecurrence
  timezone: string
  last_triggered_at: Date | null
  created_at: Date
  updated_at: Date
}

type InboxRow = {
  id: string
  tenant_id: string
  user_id: string
  kind: 'reminder' | 'signal'
  status: 'unread' | 'read' | 'dismissed'
  title: string
  body: string
  scheduled_for: Date | null
  source_type: string
  source_id: string | null
  signal_code: 'task_due_today' | 'task_overdue' | 'reminder_due_now' | 'bedtime_window_reached' | null
  dedupe_key: string | null
  read_at: Date | null
  created_at: Date
  updated_at: Date
}

type XVextaUserRow = {
  id: string
}

type XVextaAuthRow = {
  id: string
  email: string
  name: string
  password_hash: string
}

type XVextaProjectRow = {
  user_id: string
  id: string
  name: string
  code: string
  color: string
  summary: string
  created_at: Date
  updated_at: Date
}

type XVextaNoteRow = {
  user_id: string
  id: string
  project_id: string | null
  title: string
  summary: string
  status: XVextaNoteStatus
  due_date: string
  tag_ids: string[]
  links_to: string[]
  links: unknown[]
  attachments: unknown[]
  blocks: unknown[]
  created_at: Date
  updated_at: Date
}

type LinkedServiceAccountRow = {
  external_user_id: string
}

type AgentMailAccountRow = {
  id: string
  tenant_id: string
  user_id: string
  provider: 'agentmail'
  address: string
  display_name: string
  inbox_id: string | null
  status: AgentMailConnectionStatus
  detail: string
  last_synced_at: Date | null
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

type AgentMailMessageRow = {
  id: string
  tenant_id: string
  user_id: string
  account_id: string
  folder: AgentMailFolder
  external_id: string | null
  thread_id: string | null
  from_name: string | null
  from_address: string
  to_addresses: string[]
  cc_addresses: string[]
  subject: string
  preview: string
  body_text: string
  body_html: string | null
  is_read: boolean
  sent_at: Date | null
  received_at: Date | null
  labels: string[]
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

type AgentMailContactRow = {
  id: string
  tenant_id: string
  user_id: string
  account_id: string
  name: string
  email: string
  aliases: string[]
  notes: string
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

type MemoryRow = {
  id: string
  tenant_id: string
  user_id: string
  category: MemoryCategory
  slug: string
  title: string
  summary: string
  content: string
  tags: string[]
  aliases: string[]
  links: string[]
  metadata: Record<string, unknown>
  last_remembered_at: Date | null
  created_at: Date
  updated_at: Date
}

export class PlatformRepository {
  constructor(private readonly database: Database) {}

  async ensureLocalSession(input: LocalSessionInput): Promise<AuthSession> {
    const email = 'local@friday.local'
    const displayName = input.displayName?.trim() || 'Friday Local User'
    const timezone = input.timezone.trim() || 'UTC'
    const locale = input.locale

    return this.database.withTransaction(async (client) => {
      const existingRows = await client.query<{ id: string; tenant_id: string; display_name: string; password_hash: string }>(
        `SELECT id, tenant_id, display_name, password_hash FROM users WHERE email = $1 FOR UPDATE`,
        [email],
      )

      let tenantId: string
      let userId: string
      let passwordHash: string

      if (existingRows.rows[0]) {
        const existing = existingRows.rows[0]
        tenantId = existing.tenant_id
        userId = existing.id
        passwordHash = existing.password_hash

        await client.query(
          `UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2`,
          [displayName || existing.display_name, userId],
        )
        await client.query(
          `INSERT INTO memberships (tenant_id, user_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [tenantId, userId],
        )
        await client.query(
          `INSERT INTO user_settings (tenant_id, user_id, timezone, locale)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id)
           DO UPDATE SET timezone = EXCLUDED.timezone, locale = EXCLUDED.locale, updated_at = NOW()`,
          [tenantId, userId, timezone, locale],
        )
      } else {
        passwordHash = hashPassword(createOpaqueToken('local'))
        const tenantResult = await client.query<{ id: string }>(
          `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
          [displayName],
        )
        tenantId = tenantResult.rows[0].id

        const userResult = await client.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, display_name, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [tenantId, email, displayName, passwordHash],
        )
        userId = userResult.rows[0].id

        await client.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenantId, userId])
        await client.query(
          `INSERT INTO user_settings (tenant_id, user_id, timezone, locale) VALUES ($1, $2, $3, $4)`,
          [tenantId, userId, timezone, locale],
        )
      }

      await this.provisionXVextaIdentity(client, {
        tenantId,
        userId,
        email,
        displayName,
        passwordHash,
      })

      const token = createOpaqueToken('usr')
      await client.query(
        `INSERT INTO device_sessions (tenant_id, user_id, token_hash) VALUES ($1, $2, $3)`,
        [tenantId, userId, hashToken(token)],
      )

      const profile = await this.findProfileById(client, userId)
      await this.insertAuditLog(client, {
        tenantId,
        userId,
        actorType: 'user',
        action: 'local_session',
        entityType: 'user',
        entityId: userId,
        payload: { email },
      })

      return {
        token,
        tokenType: 'user',
        user: profile,
        expiresAt: null,
      }
    })
  }

  async register(input: {
    email: string
    password: string
    displayName: string
    timezone: string
    locale: AppLanguage
  }): Promise<AuthSession> {
    const email = input.email.trim().toLowerCase()
    const displayName = input.displayName.trim()
    const passwordHash = hashPassword(input.password)

    return this.database.withTransaction(async (client) => {
      const tenantResult = await client.query<{ id: string }>(
        `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
        [displayName || email],
      )
      const tenantId = tenantResult.rows[0].id

      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tenantId, email, displayName || email, passwordHash],
      )
      const userId = userResult.rows[0].id

      await client.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenantId, userId])
      await client.query(
        `INSERT INTO user_settings (tenant_id, user_id, timezone, locale) VALUES ($1, $2, $3, $4)`,
        [tenantId, userId, input.timezone, input.locale],
      )
      await this.provisionXVextaIdentity(client, {
        tenantId,
        userId,
        email,
        displayName: displayName || email,
        passwordHash,
      })

      const token = createOpaqueToken('usr')
      await client.query(
        `INSERT INTO device_sessions (tenant_id, user_id, token_hash) VALUES ($1, $2, $3)`,
        [tenantId, userId, hashToken(token)],
      )

      const profile = await this.findProfileById(client, userId)
      await this.insertAuditLog(client, {
        tenantId,
        userId,
        actorType: 'user',
        action: 'register',
        entityType: 'user',
        entityId: userId,
        payload: { email },
      })

      return {
        token,
        tokenType: 'user',
        user: profile,
        expiresAt: null,
      }
    })
  }

  async loginWithTrustedIdentity(input: {
    email: string
    password: string
    displayName: string
    timezone: string
    locale: AppLanguage
  }): Promise<AuthSession> {
    const email = input.email.trim().toLowerCase()
    const displayName = input.displayName.trim() || email
    const timezone = input.timezone.trim() || 'Europe/Moscow'
    const locale = input.locale
    const passwordHash = hashPassword(input.password)

    return this.database.withTransaction(async (client) => {
      const existingRows = await client.query<{ id: string; tenant_id: string; display_name: string }>(
        `SELECT id, tenant_id, display_name FROM users WHERE email = $1 FOR UPDATE`,
        [email],
      )

      let tenantId: string
      let userId: string

      if (existingRows.rows[0]) {
        const existing = existingRows.rows[0]
        tenantId = existing.tenant_id
        userId = existing.id

        await client.query(
          `
          UPDATE users
          SET display_name = $2, password_hash = $3, updated_at = NOW()
          WHERE id = $1
          `,
          [userId, displayName || existing.display_name, passwordHash],
        )
        await client.query(
          `
          INSERT INTO memberships (tenant_id, user_id, role)
          VALUES ($1, $2, 'owner')
          ON CONFLICT (tenant_id, user_id) DO NOTHING
          `,
          [tenantId, userId],
        )
        await client.query(
          `
          INSERT INTO user_settings (tenant_id, user_id, timezone, locale)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id)
          DO UPDATE SET timezone = EXCLUDED.timezone, locale = EXCLUDED.locale, updated_at = NOW()
          `,
          [tenantId, userId, timezone, locale],
        )
      } else {
        const tenantResult = await client.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [
          displayName,
        ])
        tenantId = tenantResult.rows[0].id

        const userResult = await client.query<{ id: string }>(
          `
          INSERT INTO users (tenant_id, email, display_name, password_hash)
          VALUES ($1, $2, $3, $4)
          RETURNING id
          `,
          [tenantId, email, displayName, passwordHash],
        )
        userId = userResult.rows[0].id

        await client.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenantId, userId])
        await client.query(
          `INSERT INTO user_settings (tenant_id, user_id, timezone, locale) VALUES ($1, $2, $3, $4)`,
          [tenantId, userId, timezone, locale],
        )
      }

      await this.provisionXVextaIdentity(client, {
        tenantId,
        userId,
        email,
        displayName,
        passwordHash,
      })

      const token = createOpaqueToken('usr')
      await client.query(
        `INSERT INTO device_sessions (tenant_id, user_id, token_hash) VALUES ($1, $2, $3)`,
        [tenantId, userId, hashToken(token)],
      )

      const profile = await this.findProfileById(client, userId)
      await this.insertAuditLog(client, {
        tenantId,
        userId,
        actorType: 'user',
        action: 'login_via_ecosystem',
        entityType: 'user',
        entityId: userId,
        payload: { email },
      })

      return {
        token,
        tokenType: 'user',
        user: profile,
        expiresAt: null,
      }
    })
  }

  async login(email: string, password: string): Promise<AuthSession> {
    const normalizedEmail = email.trim().toLowerCase()
    const rows = await this.database.query<UserRow>(
      `
      SELECT u.*, s.timezone, s.locale, s.bedtime_start, s.quiet_hours_start, s.quiet_hours_end
      FROM users u
      JOIN user_settings s ON s.user_id = u.id
      WHERE u.email = $1
      `,
      [normalizedEmail],
    )
    const row = rows[0]
    if (row) {
      if (!verifyPassword(password, row.password_hash)) {
        throw new Error('Invalid password')
      }

      return this.database.withTransaction(async (client) => {
        await this.provisionXVextaIdentity(client, {
          tenantId: row.tenant_id,
          userId: row.id,
          email: row.email,
          displayName: row.display_name,
          passwordHash: hashPassword(password),
        })

        const token = createOpaqueToken('usr')
        await client.query(
          `INSERT INTO device_sessions (tenant_id, user_id, token_hash) VALUES ($1, $2, $3)`,
          [row.tenant_id, row.id, hashToken(token)],
        )

        return {
          token,
          tokenType: 'user',
          user: mapUserRow(row),
          expiresAt: null,
        }
      })
    }

    const legacyRow = await this.findXVextaAuthByEmail(normalizedEmail)
    if (!legacyRow) {
      throw new Error('Account not found')
    }

    if (!verifyPassword(password, legacyRow.password_hash)) {
      throw new Error('Invalid password')
    }

    return this.database.withTransaction(async (client) => {
      const linkedUser = row
        ? await this.syncExistingFridayUserFromXVexta(client, row, legacyRow)
        : await this.createFridayUserFromXVexta(client, legacyRow)

      await this.provisionXVextaIdentity(client, {
        tenantId: linkedUser.tenantId,
        userId: linkedUser.userId,
        email: legacyRow.email,
        displayName: legacyRow.name || legacyRow.email,
        passwordHash: legacyRow.password_hash,
      })

      const token = createOpaqueToken('usr')
      await client.query(
        `INSERT INTO device_sessions (tenant_id, user_id, token_hash) VALUES ($1, $2, $3)`,
        [linkedUser.tenantId, linkedUser.userId, hashToken(token)],
      )

      const profile = await this.findProfileById(client, linkedUser.userId)
      await this.insertAuditLog(client, {
        tenantId: linkedUser.tenantId,
        userId: linkedUser.userId,
        actorType: 'user',
        action: row ? 'login_via_x_vexta_sync' : 'login_via_x_vexta_create',
        entityType: 'user',
        entityId: linkedUser.userId,
        payload: { email: legacyRow.email },
      })

      return {
        token,
        tokenType: 'user',
        user: profile,
        expiresAt: null,
      }
    })
  }

  async authenticate(token: string): Promise<AuthContext | null> {
    const tokenHash = hashToken(token)
    const sessionRows = await this.database.query<{ tenant_id: string; user_id: string }>(
      `SELECT tenant_id, user_id FROM device_sessions WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [tokenHash],
    )
    if (sessionRows[0]) {
      await this.database.query(`UPDATE device_sessions SET updated_at = NOW(), last_seen_at = NOW() WHERE token_hash = $1`, [tokenHash])
      return {
        tenantId: sessionRows[0].tenant_id,
        userId: sessionRows[0].user_id,
        actorType: 'user',
      }
    }

    const appRows = await this.database.query<{ tenant_id: string; user_id: string }>(
      `SELECT tenant_id, user_id FROM app_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    )
    if (!appRows[0]) {
      return null
    }

    return {
      tenantId: appRows[0].tenant_id,
      userId: appRows[0].user_id,
      actorType: 'app',
    }
  }

  async createAppToken(auth: AuthContext, input: CreateAppTokenInput): Promise<{ token: string }> {
    return this.database.withTransaction(async (client) => {
      const clientResult = await client.query<{ id: string }>(
        `INSERT INTO app_clients (tenant_id, created_by_user_id, name) VALUES ($1, $2, $3) RETURNING id`,
        [auth.tenantId, auth.userId, input.name.trim()],
      )

      const token = createOpaqueToken('app')
      await client.query(
        `INSERT INTO app_tokens (tenant_id, user_id, client_id, token_hash) VALUES ($1, $2, $3, $4)`,
        [auth.tenantId, auth.userId, clientResult.rows[0].id, hashToken(token)],
      )

      await this.insertAuditLog(client, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        actorType: auth.actorType,
        action: 'create_app_token',
        entityType: 'app_client',
        entityId: clientResult.rows[0].id,
        payload: { name: input.name.trim() },
      })

      return { token }
    })
  }

  async getProfile(auth: AuthContext): Promise<UserProfile> {
    const rows = await this.database.query<UserRow>(
      `
      SELECT u.*, s.timezone, s.locale, s.bedtime_start, s.quiet_hours_start, s.quiet_hours_end
      FROM users u
      JOIN user_settings s ON s.user_id = u.id
      WHERE u.id = $1 AND u.tenant_id = $2
      `,
      [auth.userId, auth.tenantId],
    )
    if (!rows[0]) {
      throw new Error('User not found')
    }

    return mapUserRow(rows[0])
  }

  async updateSettings(auth: AuthContext, input: UpdateSettingsInput): Promise<UserProfile> {
    const current = await this.getProfile(auth)
    await this.database.query(
      `
      UPDATE user_settings
      SET timezone = $3, locale = $4, bedtime_start = $5, quiet_hours_start = $6, quiet_hours_end = $7, updated_at = NOW()
      WHERE user_id = $1 AND tenant_id = $2
      `,
      [
        auth.userId,
        auth.tenantId,
        input.timezone ?? current.settings.timezone,
        input.locale ?? current.settings.locale,
        input.bedtimeStart ?? current.settings.bedtimeStart,
        input.quietHoursStart ?? current.settings.quietHoursStart,
        input.quietHoursEnd ?? current.settings.quietHoursEnd,
      ],
    )
    if (input.avatarUrl !== undefined) {
      await this.database.query(
        `
        UPDATE users
        SET avatar_url = $3, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2
        `,
        [auth.userId, auth.tenantId, normalizeNullableText(input.avatarUrl)],
      )
    }

    const profile = await this.getProfile(auth)
    await this.writeAudit(auth, 'update_settings', 'user_settings', auth.userId, input)
    return profile
  }

  async getAgentMailAccount(auth: AuthContext): Promise<AgentMailAccount | null> {
    const rows = await this.database.query<AgentMailAccountRow>(
      `
      SELECT *
      FROM agent_mail_accounts
      WHERE tenant_id = $1 AND user_id = $2 AND provider = 'agentmail'
      LIMIT 1
      `,
      [auth.tenantId, auth.userId],
    )

    return rows[0] ? mapAgentMailAccountRow(rows[0]) : null
  }

  async upsertAgentMailAccount(auth: AuthContext, input: UpsertAgentMailAccountInput): Promise<AgentMailAccount> {
    const profile = await this.getProfile(auth)
    const requestedAddress = input.address.trim().toLowerCase()
    const displayName = input.displayName?.trim() || 'Friday'
    let inboxId = normalizeNullableText(input.inboxId)
    let normalizedAddress = requestedAddress
    let status = normalizeAgentMailStatus(input.status) ?? (inboxId ? 'ready' : 'disconnected')
    let detail = normalizeNullableText(input.detail)

    if (!inboxId) {
      const liveInbox = await createAgentMailInbox({
        displayName,
        requestedAddress: requestedAddress || null,
        clientId: `friday-${auth.userId}-agentmail`,
      })
      inboxId = liveInbox.inboxId
      normalizedAddress = liveInbox.address.toLowerCase()
      status = 'ready'
      detail = detail ?? 'AgentMail inbox created and linked successfully.'
    } else if (!detail) {
      detail = status === 'ready'
        ? 'AgentMail account is configured and ready for inbox sync.'
        : 'AgentMail account is saved locally. Add the provider inbox ID to complete the link.'
    }

    const rows = await this.database.query<AgentMailAccountRow>(
      `
      INSERT INTO agent_mail_accounts (
        tenant_id, user_id, provider, address, display_name, inbox_id, status, detail, last_synced_at, metadata
      )
      VALUES ($1, $2, 'agentmail', $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (tenant_id, user_id, provider)
      DO UPDATE SET
        address = EXCLUDED.address,
        display_name = EXCLUDED.display_name,
        inbox_id = EXCLUDED.inbox_id,
        status = EXCLUDED.status,
        detail = EXCLUDED.detail,
        last_synced_at = EXCLUDED.last_synced_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
      `,
      [
        auth.tenantId,
        auth.userId,
        normalizedAddress,
        displayName,
        inboxId,
        status,
        detail,
        status === 'ready' ? new Date().toISOString() : null,
        JSON.stringify(normalizeMetadata(input.metadata)),
      ],
    )

    await this.database.query(
      `
      INSERT INTO linked_service_accounts (tenant_id, user_id, service_name, external_user_id, external_email, created_at, updated_at)
      VALUES ($1, $2, 'agentmail', $3, $4, NOW(), NOW())
      ON CONFLICT (user_id, service_name)
      DO UPDATE SET
        external_user_id = EXCLUDED.external_user_id,
        external_email = EXCLUDED.external_email,
        updated_at = NOW()
      `,
      [auth.tenantId, auth.userId, inboxId ?? normalizedAddress, normalizedAddress],
    )

    await this.seedAgentMailInboxIfEmpty(auth, rows[0], profile)
    await this.writeAudit(auth, 'upsert_agent_mail_account', 'agent_mail_account', rows[0].id, {
      address: normalizedAddress,
      inboxId,
      status,
    })
    return mapAgentMailAccountRow(rows[0])
  }

  async listAgentMailMessages(auth: AuthContext, input: ListAgentMailMessagesInput = {}): Promise<AgentMailMessage[]> {
    const account = await this.getAgentMailAccount(auth)
    if (account?.inboxId && shouldRefreshAgentMailSync(account.lastSyncedAt)) {
      try {
        const remoteMessages = await listRemoteAgentMailMessages(account.inboxId, 50)
        await this.syncRemoteAgentMailMessages(auth, account, remoteMessages)
      } catch (error) {
        await this.database.query(
          `
          UPDATE agent_mail_accounts
          SET detail = $4, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND user_id = $3
          `,
          [
            account.id,
            auth.tenantId,
            auth.userId,
            `AgentMail sync is temporarily unavailable. Showing cached messages. ${
              error instanceof Error ? error.message : 'Unknown sync error.'
            }`,
          ],
        )
      }
    }

    const folder = normalizeAgentMailFolder(input.folder)
    const values: Array<string> = [auth.tenantId, auth.userId]
    let folderSql = ''

    if (folder) {
      values.push(folder)
      folderSql = ` AND m.folder = $${values.length}`
    }

    const rows = await this.database.query<AgentMailMessageRow>(
      `
      SELECT m.*
      FROM agent_mail_messages m
      JOIN agent_mail_accounts a ON a.id = m.account_id
      WHERE m.tenant_id = $1 AND m.user_id = $2 AND a.provider = 'agentmail'${folderSql}
      ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC, m.created_at DESC
      `,
      values,
    )

    return rows.map(mapAgentMailMessageRow)
  }

  async getAgentMailMessage(auth: AuthContext, id: string): Promise<AgentMailMessage> {
    const rows = await this.database.query<AgentMailMessageRow & { inbox_id: string | null; account_address: string }>(
      `
      SELECT m.*, a.inbox_id, a.address AS account_address
      FROM agent_mail_messages m
      JOIN agent_mail_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND m.tenant_id = $2 AND m.user_id = $3 AND a.provider = 'agentmail'
      LIMIT 1
      `,
      [id, auth.tenantId, auth.userId],
    )

    const row = rows[0]
    if (!row) {
      throw new Error('Agent mail message not found')
    }

    if (row.inbox_id && row.external_id) {
      try {
        const remoteMessage = await getRemoteAgentMailMessage(row.inbox_id, row.external_id)
        const hydrated = await this.upsertRemoteAgentMailMessage(
          auth,
          {
            id: row.account_id,
            address: row.account_address,
          },
          {
            ...remoteMessage,
            metadata: {
              ...(normalizeMetadata(row.metadata) ?? {}),
              remoteHydrated: true,
            },
          },
        )
        return mapAgentMailMessageRow(hydrated)
      } catch (error) {
        await this.database.query(
          `
          UPDATE agent_mail_accounts
          SET detail = $4, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2 AND user_id = $3
          `,
          [
            row.account_id,
            auth.tenantId,
            auth.userId,
            `AgentMail message detail is temporarily unavailable. Showing cached copy. ${
              error instanceof Error ? error.message : 'Unknown detail error.'
            }`,
          ],
        )
      }
    }

    return mapAgentMailMessageRow(row)
  }

  async createAgentMailMessage(auth: AuthContext, input: CreateAgentMailMessageInput): Promise<AgentMailMessage> {
    const account = await this.requireAgentMailAccount(auth, input.accountId)
    const folder = normalizeAgentMailFolder(input.folder) ?? 'drafts'
    const subject = input.subject.trim()
    const bodyText = input.bodyText.trim()
    const toAddresses = normalizeEmailArray(input.toAddresses)
    const ccAddresses = normalizeEmailArray(input.ccAddresses)
    let externalId = normalizeNullableText(input.externalId)
    let threadId = normalizeNullableText(input.threadId)
    let sentAt = folder === 'sent' ? input.sentAt ?? new Date().toISOString() : input.sentAt ?? null
    const receivedAt = folder === 'inbox' ? input.receivedAt ?? new Date().toISOString() : input.receivedAt ?? null
    const isRead = input.isRead ?? folder !== 'inbox'

    if (folder === 'sent' && account.inboxId) {
      const result = await sendAgentMailMessage({
        inboxId: account.inboxId,
        to: toAddresses,
        cc: ccAddresses,
        subject,
        text: bodyText,
        html: normalizeNullableText(input.bodyHtml),
      })
      externalId = result.externalId ?? externalId
      threadId = result.threadId ?? threadId
      sentAt = new Date().toISOString()
    }

    const rows = await this.database.query<AgentMailMessageRow>(
      `
      INSERT INTO agent_mail_messages (
        tenant_id, user_id, account_id, folder, external_id, thread_id, from_name, from_address,
        to_addresses, cc_addresses, subject, preview, body_text, body_html, is_read, sent_at, received_at,
        labels, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12, $13, $14, $15, $16, $17, $18::text[], $19::jsonb)
      RETURNING *
      `,
      [
        auth.tenantId,
        auth.userId,
        account.id,
        folder,
        externalId,
        threadId,
        normalizeNullableText(input.fromName),
        normalizeNullableText(input.fromAddress) ?? account.address,
        toAddresses,
        ccAddresses,
        subject,
        buildAgentMailPreview(input.preview, bodyText),
        bodyText,
        normalizeNullableText(input.bodyHtml),
        isRead,
        sentAt,
        receivedAt,
        normalizeTextArray(input.labels),
        JSON.stringify(normalizeMetadata(input.metadata)),
      ],
    )

    await this.writeAudit(auth, 'create_agent_mail_message', 'agent_mail_message', rows[0].id, {
      accountId: account.id,
      folder,
      subject,
      toAddresses,
    })
    return mapAgentMailMessageRow(rows[0])
  }

  async markAgentMailMessageRead(auth: AuthContext, id: string): Promise<AgentMailMessage> {
    const rows = await this.database.query<AgentMailMessageRow>(
      `
      UPDATE agent_mail_messages
      SET is_read = TRUE, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING *
      `,
      [id, auth.tenantId, auth.userId],
    )

    if (!rows[0]) {
      throw new Error('Agent mail message not found')
    }

    await this.writeAudit(auth, 'mark_agent_mail_message_read', 'agent_mail_message', id, {})
    return mapAgentMailMessageRow(rows[0])
  }

  async listAgentMailContacts(auth: AuthContext, input: ListAgentMailContactsInput = {}): Promise<AgentMailContact[]> {
    const query = normalizeLookup(input.query ?? '')
    const hasQuery = Boolean(query)
    const rows = await this.database.query<AgentMailContactRow>(
      `
      SELECT *
      FROM agent_mail_contacts
      WHERE tenant_id = $1
        AND user_id = $2
        AND (
          $3 = ''
          OR lower(name) LIKE $4
          OR lower(email) LIKE $4
          OR EXISTS (
            SELECT 1
            FROM unnest(aliases) AS alias
            WHERE lower(alias) LIKE $4
          )
        )
      ORDER BY updated_at DESC, created_at DESC
      `,
      [auth.tenantId, auth.userId, query, hasQuery ? `%${query}%` : ''],
    )
    return rows.map(mapAgentMailContactRow)
  }

  async upsertAgentMailContact(auth: AuthContext, input: UpsertAgentMailContactInput): Promise<AgentMailContact> {
    const account = await this.requireAgentMailAccount(auth, input.accountId)
    const name = input.name.trim()
    const email = input.email.trim().toLowerCase()
    const aliases = normalizeTextArray(input.aliases)
    const notes = (input.notes ?? '').trim()
    const metadata = JSON.stringify(normalizeMetadata(input.metadata))

    if (input.id) {
      const rows = await this.database.query<AgentMailContactRow>(
        `
        UPDATE agent_mail_contacts
        SET name = $4, email = $5, aliases = $6, notes = $7, metadata = $8::jsonb, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND account_id = $9
        RETURNING *
        `,
        [input.id, auth.tenantId, auth.userId, name, email, aliases, notes, metadata, account.id],
      )

      if (!rows[0]) {
        throw new Error('Agent mail contact not found')
      }

      await this.writeAudit(auth, 'update_agent_mail_contact', 'agent_mail_contact', rows[0].id, {
        name,
        email,
        aliases,
      })
      return mapAgentMailContactRow(rows[0])
    }

    const rows = await this.database.query<AgentMailContactRow>(
      `
      INSERT INTO agent_mail_contacts (
        tenant_id,
        user_id,
        account_id,
        name,
        email,
        aliases,
        notes,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (account_id, email)
      DO UPDATE SET
        name = EXCLUDED.name,
        aliases = EXCLUDED.aliases,
        notes = EXCLUDED.notes,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
      `,
      [auth.tenantId, auth.userId, account.id, name, email, aliases, notes, metadata],
    )

    await this.writeAudit(auth, 'upsert_agent_mail_contact', 'agent_mail_contact', rows[0].id, {
      name,
      email,
      aliases,
    })
    return mapAgentMailContactRow(rows[0])
  }

  async deleteAgentMailContact(auth: AuthContext, id: string): Promise<void> {
    await this.database.query(
      `DELETE FROM agent_mail_contacts WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, auth.tenantId, auth.userId],
    )
    await this.writeAudit(auth, 'delete_agent_mail_contact', 'agent_mail_contact', id, {})
  }

  async listNotes(auth: AuthContext): Promise<Note[]> {
    const rows = await this.database.query<NoteRow>(
      `SELECT * FROM notes WHERE tenant_id = $1 AND user_id = $2 ORDER BY updated_at DESC`,
      [auth.tenantId, auth.userId],
    )
    return rows.map(mapNoteRow)
  }

  async createNote(auth: AuthContext, input: CreateNoteInput): Promise<Note> {
    const rows = await this.database.query<NoteRow>(
      `
      INSERT INTO notes (tenant_id, user_id, title, body, is_pinned, is_archived)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [auth.tenantId, auth.userId, normalizeNullableText(input.title), input.body.trim(), input.isPinned ?? false, input.isArchived ?? false],
    )
    await this.writeAudit(auth, 'create_note', 'note', rows[0].id, input)
    return mapNoteRow(rows[0])
  }

  async updateNote(auth: AuthContext, id: string, input: UpdateNoteInput): Promise<Note> {
    const current = await this.requireNote(auth, id)
    const rows = await this.database.query<NoteRow>(
      `
      UPDATE notes
      SET title = $4, body = $5, is_pinned = $6, is_archived = $7, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING *
      `,
      [
        id,
        auth.tenantId,
        auth.userId,
        input.title === undefined ? current.title : normalizeNullableText(input.title),
        input.body === undefined ? current.body : input.body.trim(),
        input.isPinned ?? current.isPinned,
        input.isArchived ?? current.isArchived,
      ],
    )
    await this.writeAudit(auth, 'update_note', 'note', id, input)
    return mapNoteRow(rows[0])
  }

  async deleteNote(auth: AuthContext, id: string): Promise<void> {
    await this.database.query(`DELETE FROM notes WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, auth.tenantId, auth.userId])
    await this.writeAudit(auth, 'delete_note', 'note', id, {})
  }

  async listTasks(auth: AuthContext): Promise<Task[]> {
    const rows = await this.database.query<TaskRow>(
      `SELECT * FROM tasks WHERE tenant_id = $1 AND user_id = $2 ORDER BY due_at NULLS LAST, updated_at DESC`,
      [auth.tenantId, auth.userId],
    )
    return rows.map(mapTaskRow)
  }

  async createTask(auth: AuthContext, input: CreateTaskInput): Promise<Task> {
    const rows = await this.database.query<TaskRow>(
      `
      INSERT INTO tasks (tenant_id, user_id, title, description, due_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [auth.tenantId, auth.userId, input.title.trim(), normalizeNullableText(input.description), input.dueAt ?? null],
    )
    await this.writeAudit(auth, 'create_task', 'task', rows[0].id, input)
    return mapTaskRow(rows[0])
  }

  async updateTask(auth: AuthContext, id: string, input: UpdateTaskInput): Promise<Task> {
    const current = await this.requireTask(auth, id)
    const rows = await this.database.query<TaskRow>(
      `
      UPDATE tasks
      SET title = $4, description = $5, due_at = $6, status = $7, completed_at = $8, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING *
      `,
      [
        id,
        auth.tenantId,
        auth.userId,
        input.title?.trim() ?? current.title,
        input.description === undefined ? current.description : normalizeNullableText(input.description),
        input.dueAt === undefined ? current.dueAt : input.dueAt,
        input.status ?? current.status,
        resolveCompletedAt(input, current),
      ],
    )
    await this.writeAudit(auth, 'update_task', 'task', id, input)
    return mapTaskRow(rows[0])
  }

  async deleteTask(auth: AuthContext, id: string): Promise<void> {
    await this.database.query(`DELETE FROM tasks WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, auth.tenantId, auth.userId])
    await this.writeAudit(auth, 'delete_task', 'task', id, {})
  }

  async listReminders(auth: AuthContext): Promise<Reminder[]> {
    const rows = await this.database.query<ReminderRow>(
      `SELECT * FROM reminders WHERE tenant_id = $1 AND user_id = $2 ORDER BY scheduled_at ASC`,
      [auth.tenantId, auth.userId],
    )
    return rows.map(mapReminderRow)
  }

  async createReminder(auth: AuthContext, input: CreateReminderInput): Promise<Reminder> {
    const profile = await this.getProfile(auth)
    const rows = await this.database.query<ReminderRow>(
      `
      INSERT INTO reminders (tenant_id, user_id, title, body, scheduled_at, recurrence, timezone)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        auth.tenantId,
        auth.userId,
        input.title.trim(),
        normalizeNullableText(input.body),
        input.scheduledAt,
        input.recurrence,
        input.timezone ?? profile.settings.timezone,
      ],
    )
    await this.writeAudit(auth, 'create_reminder', 'reminder', rows[0].id, input)
    return mapReminderRow(rows[0])
  }

  async updateReminder(auth: AuthContext, id: string, input: UpdateReminderInput): Promise<Reminder> {
    const current = await this.requireReminder(auth, id)
    const rows = await this.database.query<ReminderRow>(
      `
      UPDATE reminders
      SET title = $4, body = $5, scheduled_at = $6, recurrence = $7, timezone = $8, last_triggered_at = $9, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING *
      `,
      [
        id,
        auth.tenantId,
        auth.userId,
        input.title?.trim() ?? current.title,
        input.body === undefined ? current.body : normalizeNullableText(input.body),
        input.scheduledAt ?? current.scheduledAt,
        input.recurrence ?? current.recurrence,
        input.timezone ?? current.timezone,
        input.lastTriggeredAt ?? current.lastTriggeredAt,
      ],
    )
    await this.writeAudit(auth, 'update_reminder', 'reminder', id, input)
    return mapReminderRow(rows[0])
  }

  async deleteReminder(auth: AuthContext, id: string): Promise<void> {
    await this.database.query(`DELETE FROM reminders WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, auth.tenantId, auth.userId])
    await this.writeAudit(auth, 'delete_reminder', 'reminder', id, {})
  }

  async listXVextaProjects(auth: AuthContext): Promise<XVextaProject[]> {
    const xVextaUserId = await this.findXVextaUserId(auth)
    if (!xVextaUserId) {
      return []
    }

    const rows = await this.database.query<XVextaProjectRow>(
      `
      SELECT user_id, id, name, code, color, summary, created_at, updated_at
      FROM x_vexta_projects
      WHERE user_id = $1
      ORDER BY updated_at DESC, created_at DESC
      `,
      [xVextaUserId],
    )
    return rows.map(mapXVextaProjectRow)
  }

  async listXVextaNotes(auth: AuthContext): Promise<XVextaNote[]> {
    const xVextaUserId = await this.findXVextaUserId(auth)
    if (!xVextaUserId) {
      return []
    }

    const rows = await this.database.query<XVextaNoteRow>(
      `
      SELECT user_id, id, project_id, title, summary, status, due_date, tag_ids, links_to, links, attachments, blocks, created_at, updated_at
      FROM x_vexta_notes
      WHERE user_id = $1
      ORDER BY updated_at DESC, created_at DESC
      `,
      [xVextaUserId],
    )
    return rows.map(mapXVextaNoteRow)
  }

  async createXVextaProject(auth: AuthContext, input: CreateXVextaProjectInput): Promise<XVextaProject> {
    const xVextaUserId = await this.requireXVextaUserId(auth)
    const id = `project-${randomUUID()}`
    const name = input.name.trim()
    const rows = await this.database.query<XVextaProjectRow>(
      `
      INSERT INTO x_vexta_projects (user_id, id, name, code, color, summary, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING user_id, id, name, code, color, summary, created_at, updated_at
      `,
      [xVextaUserId, id, name, normalizeProjectCode(input.code, name), input.color ?? '#3b82f6', input.summary?.trim() ?? ''],
    )
    await this.writeAudit(auth, 'create_x_vexta_project', 'x_vexta_project', id, input)
    return mapXVextaProjectRow(rows[0])
  }

  async updateXVextaProject(auth: AuthContext, projectId: string, input: UpdateXVextaProjectInput): Promise<XVextaProject> {
    const xVextaUserId = await this.requireXVextaUserId(auth)
    const current = await this.requireXVextaProject(xVextaUserId, projectId)
    const nextName = input.name?.trim() ?? current.name
    const rows = await this.database.query<XVextaProjectRow>(
      `
      UPDATE x_vexta_projects
      SET name = $3, code = $4, color = $5, summary = $6, updated_at = NOW()
      WHERE user_id = $1 AND id = $2
      RETURNING user_id, id, name, code, color, summary, created_at, updated_at
      `,
      [
        xVextaUserId,
        projectId,
        nextName,
        normalizeProjectCode(input.code, nextName, current.code),
        input.color ?? current.color,
        input.summary?.trim() ?? current.summary,
      ],
    )
    await this.writeAudit(auth, 'update_x_vexta_project', 'x_vexta_project', projectId, input)
    return mapXVextaProjectRow(rows[0])
  }

  async createXVextaNote(auth: AuthContext, input: CreateXVextaNoteInput): Promise<XVextaNote> {
    const xVextaUserId = await this.requireXVextaUserId(auth)
    const id = `note-${randomUUID()}`
    const projectId = await this.normalizeXVextaProjectId(xVextaUserId, input.projectId ?? null)
    const normalizedBlocks = normalizeXVextaBlocksPayload(input.blocks, input.summary)
    const summary = summarizeStoredXVextaBlocks(normalizedBlocks) || input.summary?.trim() || ''
    assertXVextaNoteContentLooksReal({
      title: input.title.trim(),
      summary,
      blocks: normalizedBlocks.flatMap((block) => storedBlockToInputs(block)),
    })
    const parsedSummary = input.summary ? parseXVextaRichText(input.summary) : null
    const rows = await this.database.query<XVextaNoteRow>(
      `
      INSERT INTO x_vexta_notes (
        user_id, id, project_id, title, summary, status, due_date, created_at, updated_at,
        tag_ids, links_to, links, attachments, blocks
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8::text[], $9::text[], $10::jsonb, $11::jsonb, $12::jsonb)
      RETURNING user_id, id, project_id, title, summary, status, due_date, tag_ids, links_to, links, attachments, blocks, created_at, updated_at
      `,
      [
        xVextaUserId,
        id,
        projectId,
        input.title.trim(),
        summary,
        input.status ?? parsedSummary?.status ?? 'draft',
        input.dueDate ?? '',
        input.tagIds ?? [],
        input.linksTo ?? [],
        JSON.stringify(input.links ?? []),
        JSON.stringify(input.attachments ?? []),
        JSON.stringify(normalizedBlocks),
      ],
    )
    await this.writeAudit(auth, 'create_x_vexta_note', 'x_vexta_note', id, input)
    return mapXVextaNoteRow(rows[0])
  }

  async updateXVextaNote(auth: AuthContext, noteId: string, input: UpdateXVextaNoteInput): Promise<XVextaNote> {
    const xVextaUserId = await this.requireXVextaUserId(auth)
    const current = await this.requireXVextaNote(xVextaUserId, noteId)
    const projectId = await this.normalizeXVextaProjectId(xVextaUserId, input.projectId === undefined ? current.projectId : input.projectId)
    const nextBlocks =
      input.blocks === undefined
        ? input.summary === undefined
          ? coerceXVextaBlocks(current.blocks)
          : normalizeXVextaBlocksPayload(undefined, input.summary)
        : normalizeXVextaBlocksPayload(input.blocks, input.summary)
    const nextSummary =
      summarizeStoredXVextaBlocks(nextBlocks) ||
      input.summary?.trim() ||
      current.summary
    assertXVextaNoteContentLooksReal({
      title: input.title?.trim() ?? current.title,
      summary: nextSummary,
      blocks: nextBlocks.flatMap((block) => storedBlockToInputs(block)),
    })
    const parsedSummary = input.summary ? parseXVextaRichText(input.summary) : null
    const rows = await this.database.query<XVextaNoteRow>(
      `
      UPDATE x_vexta_notes
      SET
        project_id = $3,
        title = $4,
        summary = $5,
        status = $6,
        due_date = $7,
        tag_ids = $8::text[],
        links_to = $9::text[],
        links = $10::jsonb,
        attachments = $11::jsonb,
        blocks = $12::jsonb,
        updated_at = NOW()
      WHERE user_id = $1 AND id = $2
      RETURNING user_id, id, project_id, title, summary, status, due_date, tag_ids, links_to, links, attachments, blocks, created_at, updated_at
      `,
      [
        xVextaUserId,
        noteId,
        projectId,
        input.title?.trim() ?? current.title,
        nextSummary,
        input.status ?? parsedSummary?.status ?? current.status,
        input.dueDate ?? current.dueDate,
        input.tagIds ?? current.tagIds,
        input.linksTo ?? current.linksTo,
        JSON.stringify(input.links ?? current.links),
        JSON.stringify(input.attachments ?? current.attachments),
        JSON.stringify(nextBlocks),
      ],
    )
    await this.writeAudit(auth, 'update_x_vexta_note', 'x_vexta_note', noteId, input)
    return mapXVextaNoteRow(rows[0])
  }

  async getXVextaNote(auth: AuthContext, noteId: string): Promise<XVextaNote> {
    const xVextaUserId = await this.requireXVextaUserId(auth)
    return this.requireXVextaNote(xVextaUserId, noteId)
  }

  async appendXVextaBlocks(auth: AuthContext, noteId: string, blocks: XVextaBlockInput[]): Promise<XVextaNote> {
    const xVextaUserId = await this.requireXVextaUserId(auth)
    const current = await this.requireXVextaNote(xVextaUserId, noteId)
    const normalizedNewBlocks = normalizeXVextaBlockInputs(blocks)
    assertXVextaNoteContentLooksReal({
      title: current.title,
      summary: summarizeStoredXVextaBlocks(normalizedNewBlocks),
      blocks: normalizedNewBlocks.flatMap((block) => storedBlockToInputs(block)),
    })
    const appendedBlocks = [...coerceXVextaBlocks(current.blocks), ...normalizedNewBlocks]
    const nextSummary = summarizeStoredXVextaBlocks(normalizedNewBlocks) || current.summary

    const rows = await this.database.query<XVextaNoteRow>(
      `
      UPDATE x_vexta_notes
      SET blocks = $3::jsonb, summary = $4, updated_at = NOW()
      WHERE user_id = $1 AND id = $2
      RETURNING user_id, id, project_id, title, summary, status, due_date, tag_ids, links_to, links, attachments, blocks, created_at, updated_at
      `,
      [xVextaUserId, noteId, JSON.stringify(appendedBlocks), nextSummary],
    )
    await this.writeAudit(auth, 'append_x_vexta_blocks', 'x_vexta_note', noteId, { blocks })
    return mapXVextaNoteRow(rows[0])
  }

  async listInbox(auth: AuthContext): Promise<InboxItem[]> {
    const rows = await this.database.query<InboxRow>(
      `SELECT * FROM inbox_items WHERE tenant_id = $1 AND user_id = $2 ORDER BY CASE WHEN status = 'unread' THEN 0 ELSE 1 END, created_at DESC`,
      [auth.tenantId, auth.userId],
    )
    return rows.map(mapInboxRow)
  }

  async markInboxRead(auth: AuthContext, id: string): Promise<InboxItem> {
    const rows = await this.database.query<InboxRow>(
      `
      UPDATE inbox_items
      SET status = 'read', read_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING *
      `,
      [id, auth.tenantId, auth.userId],
    )
    if (!rows[0]) throw new Error('Inbox item not found')
    await this.writeAudit(auth, 'mark_inbox_read', 'inbox_item', id, {})
    return mapInboxRow(rows[0])
  }

  async dismissInboxItem(auth: AuthContext, id: string): Promise<InboxItem> {
    const rows = await this.database.query<InboxRow>(
      `
      UPDATE inbox_items
      SET status = 'dismissed', updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING *
      `,
      [id, auth.tenantId, auth.userId],
    )
    if (!rows[0]) throw new Error('Inbox item not found')
    await this.writeAudit(auth, 'dismiss_inbox_item', 'inbox_item', id, {})
    return mapInboxRow(rows[0])
  }

  async listMemories(
    auth: AuthContext,
    options: { query?: string; category?: string; limit?: number } = {},
  ): Promise<MemoryEntry[]> {
    const values: unknown[] = [auth.tenantId, auth.userId]
    const whereClauses = ['tenant_id = $1', 'user_id = $2']

    const category = normalizeMemoryCategory(options.category)
    if (category) {
      values.push(category)
      whereClauses.push(`category = $${values.length}`)
    }

    const query = options.query?.trim()
    let orderBy = 'updated_at DESC, created_at DESC'
    if (query) {
      values.push(`%${query}%`)
      const queryParam = `$${values.length}`
      whereClauses.push(
        `(
          title ILIKE ${queryParam}
          OR summary ILIKE ${queryParam}
          OR content ILIKE ${queryParam}
          OR EXISTS (
            SELECT 1
            FROM unnest(tags || aliases || links) AS lookup(value)
            WHERE value ILIKE ${queryParam}
          )
        )`,
      )
      orderBy = `
        CASE
          WHEN title ILIKE ${queryParam} THEN 0
          WHEN EXISTS (
            SELECT 1
            FROM unnest(aliases) AS alias(value)
            WHERE alias.value ILIKE ${queryParam}
          ) THEN 1
          WHEN summary ILIKE ${queryParam} THEN 2
          ELSE 3
        END,
        updated_at DESC,
        created_at DESC
      `
    }

    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(options.limit ?? 50, 200)) : 50
    values.push(limit)

    const rows = await this.database.query<MemoryRow>(
      `
      SELECT *
      FROM agent_memories
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${values.length}
      `,
      values,
    )

    return rows.map(mapMemoryRow)
  }

  async getMemory(auth: AuthContext, id: string): Promise<MemoryEntry> {
    const rows = await this.database.query<MemoryRow>(
      `SELECT * FROM agent_memories WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, auth.tenantId, auth.userId],
    )
    if (!rows[0]) {
      throw new Error('Memory entry not found')
    }

    return mapMemoryRow(rows[0])
  }

  async createMemory(auth: AuthContext, input: CreateMemoryInput): Promise<MemoryEntry> {
    const title = input.title.trim()
    const slug = normalizeMemorySlug(input.slug, title)
    const rows = await this.database.query<MemoryRow>(
      `
      INSERT INTO agent_memories (
        tenant_id,
        user_id,
        category,
        slug,
        title,
        summary,
        content,
        tags,
        aliases,
        links,
        metadata,
        last_remembered_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10::text[], $11::jsonb, $12)
      RETURNING *
      `,
      [
        auth.tenantId,
        auth.userId,
        input.category,
        slug,
        title,
        normalizeMemoryText(input.summary),
        normalizeMemoryText(input.content),
        normalizeTextArray(input.tags),
        normalizeTextArray(input.aliases),
        normalizeTextArray(input.links),
        JSON.stringify(normalizeMetadata(input.metadata)),
        input.lastRememberedAt ?? new Date().toISOString(),
      ],
    )
    await this.writeAudit(auth, 'create_memory', 'agent_memory', rows[0].id, input)
    return mapMemoryRow(rows[0])
  }

  async updateMemory(auth: AuthContext, id: string, input: UpdateMemoryInput): Promise<MemoryEntry> {
    const current = await this.getMemory(auth, id)
    const title = input.title?.trim() ?? current.title
    const category = input.category ?? current.category
    const slug = normalizeMemorySlug(input.slug, title, current.slug)
    const rows = await this.database.query<MemoryRow>(
      `
      UPDATE agent_memories
      SET
        category = $4,
        slug = $5,
        title = $6,
        summary = $7,
        content = $8,
        tags = $9::text[],
        aliases = $10::text[],
        links = $11::text[],
        metadata = $12::jsonb,
        last_remembered_at = $13,
        updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING *
      `,
      [
        id,
        auth.tenantId,
        auth.userId,
        category,
        slug,
        title,
        input.summary === undefined ? current.summary : normalizeMemoryText(input.summary),
        input.content === undefined ? current.content : normalizeMemoryText(input.content),
        input.tags === undefined ? current.tags : normalizeTextArray(input.tags),
        input.aliases === undefined ? current.aliases : normalizeTextArray(input.aliases),
        input.links === undefined ? current.links : normalizeTextArray(input.links),
        JSON.stringify(input.metadata === undefined ? current.metadata : normalizeMetadata(input.metadata)),
        input.lastRememberedAt === undefined ? current.lastRememberedAt : input.lastRememberedAt,
      ],
    )
    await this.writeAudit(auth, 'update_memory', 'agent_memory', id, input)
    return mapMemoryRow(rows[0])
  }

  async deleteMemory(auth: AuthContext, id: string): Promise<void> {
    await this.database.query(`DELETE FROM agent_memories WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [
      id,
      auth.tenantId,
      auth.userId,
    ])
    await this.writeAudit(auth, 'delete_memory', 'agent_memory', id, {})
  }

  async getAgentContext(auth: AuthContext): Promise<AgentContext> {
    const [profile, tasks, reminders, notes, inbox, recentMemories, mailContacts, xVextaProjects, xVextaNotes] = await Promise.all([
      this.getProfile(auth),
      this.listTasks(auth),
      this.listReminders(auth),
      this.listNotes(auth),
      this.listInbox(auth),
      this.listMemories(auth, { limit: 12 }),
      this.listAgentMailContacts(auth),
      this.listXVextaProjects(auth),
      this.listXVextaNotes(auth),
    ])
    const now = new Date()
    return {
      profile,
      todayTasks: tasks.filter((task) => isTaskDueToday(task, now)),
      overdueTasks: tasks.filter((task) => isTaskOverdue(task, now)),
      activeReminders: reminders.filter((reminder) => !reminder.lastTriggeredAt || isReminderDue(reminder, now)),
      recentNotes: notes.slice(0, 10),
      recentMemories,
      mailContacts: mailContacts.slice(0, 25),
      xVextaProjects: xVextaProjects.slice(0, 20),
      xVextaNotes: xVextaNotes.slice(0, 20),
      unreadInbox: inbox.filter((item) => item.status === 'unread').slice(0, 20),
      derivedSignals: buildAgentSignals({
        tasks,
        reminders,
        inboxItems: inbox,
        settings: profile.settings,
        now,
      }),
      generatedAt: now.toISOString(),
    }
  }

  async runAgentAction(auth: AuthContext, input: AgentActionRequest): Promise<AgentActionResult> {
    switch (input.action.type) {
      case 'create_note': {
        const note = await this.createNote(auth, input.action.payload)
        return { type: 'create_note', entityId: note.id, message: 'Note created', payload: note }
      }
      case 'update_note': {
        const note = await this.updateNote(auth, input.action.payload.noteId, input.action.payload.changes)
        return { type: 'update_note', entityId: note.id, message: 'Note updated', payload: note }
      }
      case 'delete_note': {
        await this.deleteNote(auth, input.action.payload.noteId)
        return { type: 'delete_note', entityId: input.action.payload.noteId, message: 'Note deleted' }
      }
      case 'create_task': {
        const task = await this.createTask(auth, input.action.payload)
        return { type: 'create_task', entityId: task.id, message: 'Task created', payload: task }
      }
      case 'update_task': {
        const task = await this.updateTask(auth, input.action.payload.taskId, input.action.payload.changes)
        return { type: 'update_task', entityId: task.id, message: 'Task updated', payload: task }
      }
      case 'delete_task': {
        await this.deleteTask(auth, input.action.payload.taskId)
        return { type: 'delete_task', entityId: input.action.payload.taskId, message: 'Task deleted' }
      }
      case 'create_reminder': {
        const reminder = await this.createReminder(auth, input.action.payload)
        return { type: 'create_reminder', entityId: reminder.id, message: 'Reminder created', payload: reminder }
      }
      case 'update_reminder': {
        const reminder = await this.updateReminder(auth, input.action.payload.reminderId, input.action.payload.changes)
        return { type: 'update_reminder', entityId: reminder.id, message: 'Reminder updated', payload: reminder }
      }
      case 'delete_reminder': {
        await this.deleteReminder(auth, input.action.payload.reminderId)
        return { type: 'delete_reminder', entityId: input.action.payload.reminderId, message: 'Reminder deleted' }
      }
      case 'dismiss_inbox_item': {
        const item = await this.dismissInboxItem(auth, input.action.payload.inboxItemId)
        return { type: 'dismiss_inbox_item', entityId: item.id, message: 'Inbox item dismissed', payload: item }
      }
      case 'create_memory': {
        const memory = await this.createMemory(auth, input.action.payload)
        return { type: 'create_memory', entityId: memory.id, message: 'Memory created', payload: memory }
      }
      case 'update_memory': {
        const memory = await this.updateMemory(auth, input.action.payload.memoryId, input.action.payload.changes)
        return { type: 'update_memory', entityId: memory.id, message: 'Memory updated', payload: memory }
      }
      case 'delete_memory': {
        await this.deleteMemory(auth, input.action.payload.memoryId)
        return { type: 'delete_memory', entityId: input.action.payload.memoryId, message: 'Memory deleted' }
      }
      case 'get_x_vexta_note': {
        const note = await this.getXVextaNote(auth, input.action.payload.noteId)
        return {
          type: 'get_x_vexta_note',
          entityId: note.id,
          message: `X Vexta note "${note.title}" loaded`,
          payload: note,
        }
      }
      case 'create_x_vexta_project': {
        const project = await this.createXVextaProject(auth, input.action.payload)
        return {
          type: 'create_x_vexta_project',
          entityId: project.id,
          message: `X Vexta project "${project.name}" created`,
          payload: project,
        }
      }
      case 'update_x_vexta_project': {
        const project = await this.updateXVextaProject(auth, input.action.payload.projectId, input.action.payload.changes)
        return {
          type: 'update_x_vexta_project',
          entityId: project.id,
          message: `X Vexta project "${project.name}" updated`,
          payload: project,
        }
      }
      case 'create_x_vexta_note': {
        const note = await this.createXVextaNote(auth, input.action.payload)
        return {
          type: 'create_x_vexta_note',
          entityId: note.id,
          message: `X Vexta note "${note.title}" created`,
          payload: note,
        }
      }
      case 'update_x_vexta_note': {
        const note = await this.updateXVextaNote(auth, input.action.payload.noteId, input.action.payload.changes)
        return {
          type: 'update_x_vexta_note',
          entityId: note.id,
          message: `X Vexta note "${note.title}" updated`,
          payload: note,
        }
      }
      case 'append_x_vexta_blocks': {
        const note = await this.appendXVextaBlocks(auth, input.action.payload.noteId, input.action.payload.blocks)
        return {
          type: 'append_x_vexta_blocks',
          entityId: note.id,
          message: `Blocks appended to X Vexta note "${note.title}"`,
          payload: note,
        }
      }
    }
  }

  async deliverDueReminders(now: Date = new Date()): Promise<number> {
    const reminders = await this.database.query<ReminderRow>(`SELECT * FROM reminders ORDER BY scheduled_at ASC`)
    let delivered = 0

    for (const row of reminders) {
      const reminder = mapReminderRow(row)
      if (!isReminderDue(reminder, now)) {
        continue
      }

      const inserted = await this.insertInboxIfMissing({
        tenantId: reminder.tenantId,
        userId: reminder.userId,
        kind: 'reminder',
        title: reminder.title,
        body: reminder.body ?? reminder.title,
        scheduledFor: reminder.scheduledAt,
        sourceType: 'reminder',
        sourceId: reminder.id,
        signalCode: null,
        dedupeKey: `reminder:${reminder.id}:${buildReminderOccurrenceKey(reminder, now)}`,
      })

      if (inserted) {
        delivered += 1
      }

      await this.database.query(`UPDATE reminders SET last_triggered_at = $2, updated_at = NOW() WHERE id = $1`, [reminder.id, now.toISOString()])
    }

    return delivered
  }

  async runRuleEngine(now: Date = new Date()): Promise<number> {
    const profiles = await this.database.query<UserRow>(
      `
      SELECT u.*, s.timezone, s.locale, s.bedtime_start, s.quiet_hours_start, s.quiet_hours_end
      FROM users u
      JOIN user_settings s ON s.user_id = u.id
      `,
    )

    let inserted = 0
    for (const row of profiles) {
      const profile = mapUserRow(row)
      const auth: AuthContext = {
        tenantId: profile.tenantId,
        userId: profile.id,
        actorType: 'app',
      }
      const tasks = await this.listTasks(auth)
      const reminders = await this.listReminders(auth)
      const inbox = await this.listInbox(auth)
      const signals = buildAgentSignals({
        tasks,
        reminders,
        inboxItems: inbox,
        settings: profile.settings,
        now,
      }).filter((signal) => signal.code !== 'reminder_due_now')

      for (const signal of signals) {
        const insertedSignal = await this.insertInboxIfMissing(
          buildSignalInboxItem({
            tenantId: profile.tenantId,
            userId: profile.id,
            code: signal.code,
            title: describeInboxSignalCode(signal.code, profile.settings.locale),
            body: signal.body,
            dedupeKey: createSignalDedupeKey(signal.code, profile, now),
          }),
        )
        if (insertedSignal) {
          inserted += 1
        }
      }
    }

    return inserted
  }

  async writeAudit(auth: AuthContext, action: string, entityType: string, entityId: string, payload: unknown): Promise<void> {
    await this.database.withTransaction(async (client) => {
      await this.insertAuditLog(client, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        actorType: auth.actorType,
        action,
        entityType,
        entityId,
        payload,
      })
    })
  }

  private async requireNote(auth: AuthContext, id: string): Promise<Note> {
    const rows = await this.database.query<NoteRow>(`SELECT * FROM notes WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, auth.tenantId, auth.userId])
    if (!rows[0]) throw new Error('Note not found')
    return mapNoteRow(rows[0])
  }

  private async requireTask(auth: AuthContext, id: string): Promise<Task> {
    const rows = await this.database.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, auth.tenantId, auth.userId])
    if (!rows[0]) throw new Error('Task not found')
    return mapTaskRow(rows[0])
  }

  private async requireReminder(auth: AuthContext, id: string): Promise<Reminder> {
    const rows = await this.database.query<ReminderRow>(`SELECT * FROM reminders WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, auth.tenantId, auth.userId])
    if (!rows[0]) throw new Error('Reminder not found')
    return mapReminderRow(rows[0])
  }

  private async findXVextaUserId(auth: AuthContext): Promise<string | null> {
    const linkedRows = await this.database.query<LinkedServiceAccountRow>(
      `SELECT external_user_id FROM linked_service_accounts WHERE user_id = $1 AND service_name = 'x_vexta_notes' LIMIT 1`,
      [auth.userId],
    )
    if (linkedRows[0]?.external_user_id) {
      return linkedRows[0].external_user_id
    }

    const profile = await this.getProfile(auth)
    const rows = await this.database.query<XVextaUserRow>(`SELECT id FROM x_vexta_users WHERE email = $1 LIMIT 1`, [
      profile.email.trim().toLowerCase(),
    ])
    if (!rows[0]?.id) {
      return null
    }

    await this.database.query(
      `
      INSERT INTO linked_service_accounts (tenant_id, user_id, service_name, external_user_id, external_email, created_at, updated_at)
      VALUES ($1, $2, 'x_vexta_notes', $3, $4, NOW(), NOW())
      ON CONFLICT (user_id, service_name)
      DO UPDATE SET external_user_id = EXCLUDED.external_user_id, external_email = EXCLUDED.external_email, updated_at = NOW()
      `,
      [auth.tenantId, auth.userId, rows[0].id, profile.email.trim().toLowerCase()],
    )
    return rows[0].id
  }

  private async findXVextaAuthByEmail(email: string): Promise<XVextaAuthRow | null> {
    const rows = await this.database.query<XVextaAuthRow>(
      `SELECT id, email, name, password_hash FROM x_vexta_users WHERE email = $1 LIMIT 1`,
      [email],
    )
    return rows[0] ?? null
  }

  private async requireXVextaUserId(auth: AuthContext): Promise<string> {
    const userId = await this.findXVextaUserId(auth)
    if (!userId) {
      throw new Error('Matching X Vexta Notes user was not found for this account')
    }
    return userId
  }

  private async syncExistingFridayUserFromXVexta(
    client: PoolClient,
    fridayUser: UserRow,
    xVextaUser: XVextaAuthRow,
  ): Promise<{ tenantId: string; userId: string }> {
    await client.query(
      `
      UPDATE users
      SET password_hash = $2, display_name = $3, updated_at = NOW()
      WHERE id = $1
      `,
      [fridayUser.id, xVextaUser.password_hash, fridayUser.display_name || xVextaUser.name || xVextaUser.email],
    )

    await client.query(
      `
      INSERT INTO memberships (tenant_id, user_id, role)
      VALUES ($1, $2, 'owner')
      ON CONFLICT (tenant_id, user_id) DO NOTHING
      `,
      [fridayUser.tenant_id, fridayUser.id],
    )

    await client.query(
      `
      INSERT INTO user_settings (tenant_id, user_id, timezone, locale)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id)
      DO NOTHING
      `,
      [fridayUser.tenant_id, fridayUser.id, 'Europe/Moscow', 'ru'],
    )

    return {
      tenantId: fridayUser.tenant_id,
      userId: fridayUser.id,
    }
  }

  private async createFridayUserFromXVexta(
    client: PoolClient,
    xVextaUser: XVextaAuthRow,
  ): Promise<{ tenantId: string; userId: string }> {
    const tenantResult = await client.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [
      xVextaUser.name || xVextaUser.email,
    ])
    const tenantId = tenantResult.rows[0].id

    const userResult = await client.query<{ id: string }>(
      `
      INSERT INTO users (tenant_id, email, display_name, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [tenantId, xVextaUser.email, xVextaUser.name || xVextaUser.email, xVextaUser.password_hash],
    )
    const userId = userResult.rows[0].id

    await client.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenantId, userId])
    await client.query(
      `INSERT INTO user_settings (tenant_id, user_id, timezone, locale) VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, 'Europe/Moscow', 'ru'],
    )

    return {
      tenantId,
      userId,
    }
  }

  private async requireXVextaProject(xVextaUserId: string, projectId: string): Promise<XVextaProject> {
    const rows = await this.database.query<XVextaProjectRow>(
      `SELECT user_id, id, name, code, color, summary, created_at, updated_at FROM x_vexta_projects WHERE user_id = $1 AND id = $2`,
      [xVextaUserId, projectId],
    )
    if (!rows[0]) {
      throw new Error('X Vexta project not found')
    }
    return mapXVextaProjectRow(rows[0])
  }

  private async requireXVextaNote(xVextaUserId: string, noteId: string): Promise<XVextaNote> {
    const rows = await this.database.query<XVextaNoteRow>(
      `SELECT user_id, id, project_id, title, summary, status, due_date, tag_ids, links_to, links, attachments, blocks, created_at, updated_at FROM x_vexta_notes WHERE user_id = $1 AND id = $2`,
      [xVextaUserId, noteId],
    )
    if (!rows[0]) {
      throw new Error('X Vexta note not found')
    }
    return mapXVextaNoteRow(rows[0])
  }

  private async normalizeXVextaProjectId(xVextaUserId: string, projectId: string | null): Promise<string | null> {
    if (!projectId) {
      return null
    }
    await this.requireXVextaProject(xVextaUserId, projectId)
    return projectId
  }

  private async requireAgentMailAccount(auth: AuthContext, accountId: string): Promise<AgentMailAccount> {
    const rows = await this.database.query<AgentMailAccountRow>(
      `
      SELECT *
      FROM agent_mail_accounts
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND provider = 'agentmail'
      LIMIT 1
      `,
      [accountId, auth.tenantId, auth.userId],
    )

    if (!rows[0]) {
      throw new Error('Agent mail account not found')
    }

    return mapAgentMailAccountRow(rows[0])
  }

  private async seedAgentMailInboxIfEmpty(
    auth: AuthContext,
    account: AgentMailAccountRow,
    profile: UserProfile,
  ): Promise<void> {
    const existingRows = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_mail_messages WHERE account_id = $1`,
      [account.id],
    )

    if (Number.parseInt(existingRows[0]?.count ?? '0', 10) > 0) {
      return
    }

    const seedMessages = [
      {
        fromName: 'AgentMail',
        fromAddress: 'hello@agentmail.to',
        toAddresses: [account.address],
        subject: 'Your agent inbox is ready',
        bodyText:
          'AgentMail is connected to Friday. Use this inbox for product notifications, test signups, and receiving legitimate verification emails for flows you control.',
        labels: ['welcome'],
      },
      {
        fromName: 'OpenClaw Workspace',
        fromAddress: 'noreply@openclaw.local',
        toAddresses: [account.address],
        subject: 'Inbox verification example',
        bodyText: `Mailbox linked for ${profile.displayName}. When you finish the real AgentMail setup, incoming letters will appear here instead of this placeholder example.`,
        labels: ['verification'],
      },
    ]

    for (const message of seedMessages) {
      await this.database.query(
        `
        INSERT INTO agent_mail_messages (
          tenant_id, user_id, account_id, folder, from_name, from_address, to_addresses, cc_addresses,
          subject, preview, body_text, body_html, is_read, sent_at, received_at, labels, metadata
        )
        VALUES ($1, $2, $3, 'inbox', $4, $5, $6::text[], ARRAY[]::text[], $7, $8, $9, NULL, FALSE, NULL, $10, $11::text[], $12::jsonb)
        `,
        [
          auth.tenantId,
          auth.userId,
          account.id,
          message.fromName,
          message.fromAddress,
          message.toAddresses,
          message.subject,
          buildAgentMailPreview(undefined, message.bodyText),
          message.bodyText,
          new Date().toISOString(),
          message.labels,
          JSON.stringify({ seeded: true }),
        ],
      )
    }
  }

  private async syncRemoteAgentMailMessages(
    auth: AuthContext,
    account: AgentMailAccount,
    remoteMessages: Array<{
      externalId: string | null
      threadId: string | null
      fromName: string | null
      fromAddress: string
      toAddresses: string[]
      ccAddresses: string[]
      subject: string
      preview: string
      bodyText: string
      bodyHtml: string | null
      sentAt: string | null
      receivedAt: string | null
      labels: string[]
    }>,
  ): Promise<void> {
    for (const message of remoteMessages) {
      await this.upsertRemoteAgentMailMessage(auth, account, message)
    }

    await this.database.query(
      `
      UPDATE agent_mail_accounts
      SET last_synced_at = NOW(), status = 'ready', detail = 'AgentMail sync succeeded.', updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      `,
      [account.id, auth.tenantId, auth.userId],
    )
  }

  private async upsertRemoteAgentMailMessage(
    auth: AuthContext,
    account: Pick<AgentMailAccount, 'id' | 'address'>,
    message: {
      externalId: string | null
      threadId: string | null
      fromName: string | null
      fromAddress: string
      toAddresses: string[]
      ccAddresses: string[]
      subject: string
      preview: string
      bodyText: string
      bodyHtml: string | null
      sentAt: string | null
      receivedAt: string | null
      labels: string[]
      metadata?: Record<string, unknown>
    },
  ): Promise<AgentMailMessageRow> {
    const isSentLabel = message.labels.some((label) => label.trim().toLowerCase() === 'sent')
    const folder: AgentMailFolder =
      isSentLabel || message.fromAddress.toLowerCase() === account.address.toLowerCase() ? 'sent' : 'inbox'
    const rows = await this.database.query<AgentMailMessageRow>(
      `
      INSERT INTO agent_mail_messages (
        tenant_id, user_id, account_id, folder, external_id, thread_id, from_name, from_address,
        to_addresses, cc_addresses, subject, preview, body_text, body_html, is_read, sent_at, received_at, labels, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12, $13, $14, $15, $16, $17, $18::text[], $19::jsonb)
      ON CONFLICT (account_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
        folder = EXCLUDED.folder,
        thread_id = EXCLUDED.thread_id,
        from_name = EXCLUDED.from_name,
        from_address = EXCLUDED.from_address,
        to_addresses = EXCLUDED.to_addresses,
        cc_addresses = EXCLUDED.cc_addresses,
        subject = EXCLUDED.subject,
        preview = EXCLUDED.preview,
        body_text = EXCLUDED.body_text,
        body_html = EXCLUDED.body_html,
        sent_at = EXCLUDED.sent_at,
        received_at = EXCLUDED.received_at,
        labels = EXCLUDED.labels,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
      `,
      [
        auth.tenantId,
        auth.userId,
        account.id,
        folder,
        message.externalId ?? `${folder}:${message.subject}:${message.receivedAt ?? message.sentAt ?? new Date().toISOString()}`,
        message.threadId,
        message.fromName,
        message.fromAddress,
        message.toAddresses,
        message.ccAddresses,
        message.subject,
        message.preview,
        message.bodyText,
        message.bodyHtml,
        folder !== 'inbox',
        message.sentAt,
        message.receivedAt,
        message.labels,
        JSON.stringify(normalizeMetadata({ synced: true, ...(message.metadata ?? {}) })),
      ],
    )

    return rows[0]
  }

  private async insertInboxIfMissing(record: {
    tenantId: string
    userId: string
    kind: 'reminder' | 'signal'
    title: string
    body: string
    scheduledFor: string | null
    sourceType: string
    sourceId: string | null
    signalCode: 'task_due_today' | 'task_overdue' | 'reminder_due_now' | 'bedtime_window_reached' | null
    dedupeKey: string | null
  }): Promise<boolean> {
    const rows = await this.database.query<{ inserted: boolean }>(
      `
      INSERT INTO inbox_items (
        id, tenant_id, user_id, kind, status, title, body, scheduled_for, source_type, source_id, signal_code, dedupe_key
      )
      VALUES ($1, $2, $3, $4, 'unread', $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING TRUE AS inserted
      `,
      [
        randomUUID(),
        record.tenantId,
        record.userId,
        record.kind,
        record.title,
        record.body,
        record.scheduledFor,
        record.sourceType,
        record.sourceId,
        record.signalCode,
        record.dedupeKey,
      ],
    )
    return rows.length > 0
  }

  private async findProfileById(client: PoolClient, userId: string): Promise<UserProfile> {
    const result = await client.query<UserRow>(
      `
      SELECT u.*, s.timezone, s.locale, s.bedtime_start, s.quiet_hours_start, s.quiet_hours_end
      FROM users u
      JOIN user_settings s ON s.user_id = u.id
      WHERE u.id = $1
      `,
      [userId],
    )
    return mapUserRow(result.rows[0])
  }

  private async insertAuditLog(
    client: PoolClient,
    input: {
      tenantId: string
      userId: string | null
      actorType: string
      action: string
      entityType: string
      entityId: string | null
      payload: unknown
    },
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO audit_log (tenant_id, user_id, actor_type, action, entity_type, entity_id, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [input.tenantId, input.userId, input.actorType, input.action, input.entityType, input.entityId, JSON.stringify(input.payload ?? {})],
    )
  }

  private async provisionXVextaIdentity(
    client: PoolClient,
    input: {
      tenantId: string
      userId: string
      email: string
      displayName: string
      passwordHash: string
    },
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO x_vexta_users (id, email, password_hash, name, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (email)
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        name = EXCLUDED.name,
        updated_at = NOW()
      RETURNING id
      `,
      [randomUUID(), input.email.trim().toLowerCase(), input.passwordHash, input.displayName],
    )
    const externalUserId = result.rows[0].id
    await client.query(
      `
      INSERT INTO linked_service_accounts (tenant_id, user_id, service_name, external_user_id, external_email, created_at, updated_at)
      VALUES ($1, $2, 'x_vexta_notes', $3, $4, NOW(), NOW())
      ON CONFLICT (user_id, service_name)
      DO UPDATE SET
        external_user_id = EXCLUDED.external_user_id,
        external_email = EXCLUDED.external_email,
        updated_at = NOW()
      `,
      [input.tenantId, input.userId, externalUserId, input.email.trim().toLowerCase()],
    )
    return externalUserId
  }
}

function mapUserRow(row: UserRow): UserProfile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    settings: {
      timezone: String(row.timezone),
      locale: row.locale,
      bedtimeStart: row.bedtime_start,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapAgentMailAccountRow(row: AgentMailAccountRow): AgentMailAccount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    provider: row.provider,
    address: row.address,
    displayName: row.display_name,
    inboxId: row.inbox_id,
    status: row.status,
    detail: row.detail,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapAgentMailMessageRow(row: AgentMailMessageRow): AgentMailMessage {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    accountId: row.account_id,
    folder: row.folder,
    externalId: row.external_id,
    threadId: row.thread_id,
    fromName: row.from_name,
    fromAddress: row.from_address,
    toAddresses: row.to_addresses ?? [],
    ccAddresses: row.cc_addresses ?? [],
    subject: row.subject,
    preview: row.preview,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    isRead: row.is_read,
    sentAt: row.sent_at?.toISOString() ?? null,
    receivedAt: row.received_at?.toISOString() ?? null,
    labels: row.labels ?? [],
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapAgentMailContactRow(row: AgentMailContactRow): AgentMailContact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    accountId: row.account_id,
    name: row.name,
    email: row.email,
    aliases: row.aliases ?? [],
    notes: row.notes,
    metadata: normalizeMetadata(row.metadata),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapNoteRow(row: NoteRow): Note {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    isPinned: row.is_pinned,
    isArchived: row.is_archived,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueAt: row.due_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapReminderRow(row: ReminderRow): Reminder {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    scheduledAt: row.scheduled_at.toISOString(),
    recurrence: row.recurrence,
    timezone: row.timezone,
    lastTriggeredAt: row.last_triggered_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapInboxRow(row: InboxRow): InboxItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    scheduledFor: row.scheduled_for?.toISOString() ?? null,
    sourceType: row.source_type,
    sourceId: row.source_id,
    signalCode: row.signal_code,
    dedupeKey: row.dedupe_key,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapMemoryRow(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    category: row.category,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    content: row.content,
    tags: row.tags ?? [],
    aliases: row.aliases ?? [],
    links: row.links ?? [],
    metadata: normalizeMetadata(row.metadata),
    lastRememberedAt: row.last_remembered_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapXVextaProjectRow(row: XVextaProjectRow): XVextaProject {
  return {
    userId: row.user_id,
    id: row.id,
    name: row.name,
    code: row.code,
    color: row.color,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapXVextaNoteRow(row: XVextaNoteRow): XVextaNote {
  const normalizedBlocks = coerceXVextaBlocks(Array.isArray(row.blocks) ? row.blocks : [])
  const summary = resolveXVextaSummary(row.summary, normalizedBlocks)
  return {
    userId: row.user_id,
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    summary,
    status: row.status,
    dueDate: row.due_date,
    tagIds: row.tag_ids ?? [],
    linksTo: row.links_to ?? [],
    links: Array.isArray(row.links) ? row.links : [],
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    blocks: normalizedBlocks,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function coerceXVextaBlocks(value: unknown[]): Array<Record<string, unknown>> {
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
}

function normalizeStoredXVextaBlocks(value: unknown[] | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return []
  }
  return coerceXVextaBlocks(value)
}

function normalizeXVextaBlocksPayload(value: unknown[] | undefined, fallbackSummary?: string): Array<Record<string, unknown>> {
  const normalized = normalizeStoredXVextaBlocks(value)
  if (normalized.length > 0) {
    return normalized.flatMap((entry) => normalizeXVextaBlockRecord(entry))
  }

  const summary = fallbackSummary?.trim()
  if (!summary) {
    return []
  }

  return normalizeXVextaBlockInputs(parseXVextaRichText(summary).blocks)
}

function normalizeXVextaBlockInputs(blocks: XVextaBlockInput[]): Array<Record<string, unknown>> {
  return blocks.flatMap((block) => expandXVextaBlockInput(block).map((entry) => normalizeXVextaBlockInput(entry)))
}

function normalizeXVextaBlockRecord(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  const type = typeof entry.type === 'string' ? entry.type : ''
  if (!isXVextaBlockType(type)) {
    return []
  }

  const rawBlock: XVextaBlockInput = {
    type,
    content: typeof entry.content === 'string' ? entry.content : undefined,
    metadata:
      entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
        ? (entry.metadata as Record<string, string | number | boolean | null | string[]>)
        : undefined,
  }

  const expandedBlocks = expandXVextaBlockInput(rawBlock)
  return expandedBlocks.map((block, index) => {
    const normalized = normalizeXVextaBlockInput(block)

    if (index === 0) {
      if (typeof entry.id === 'string' && entry.id.trim()) {
        normalized.id = entry.id
      }

      if (Array.isArray(entry.children)) {
        normalized.children = entry.children.filter((child) => Boolean(child) && typeof child === 'object')
      }
    }

    return normalized
  })
}

function parseStructuredXVextaLine(line: string): XVextaBlockInput {
  const headingMatch = line.match(/^(#{1,3})\s+(.+)$/u)
  if (headingMatch) {
    return {
      type: (`heading-${headingMatch[1].length}` as XVextaBlockInput['type']),
      content: headingMatch[2].trim(),
    }
  }

  const boldHeadingMatch = line.match(/^\*\*(.+?)\*\*:?\s*$/u)
  if (boldHeadingMatch) {
    return {
      type: 'heading-2',
      content: boldHeadingMatch[1].trim(),
    }
  }

  const todoMatch = line.match(/^[-*]\s+\[( |x)\]\s+(.+)$/iu)
  if (todoMatch) {
    return {
      type: 'todo',
      content: todoMatch[2].trim(),
      metadata: {
        checked: todoMatch[1].toLowerCase() === 'x',
      },
    }
  }

  const numberedMatch = line.match(/^(\d+)[.)]\s+(.+)$/u)
  if (numberedMatch) {
    return {
      type: 'numbered-list',
      content: numberedMatch[2].trim(),
      metadata: {
        start: Number.parseInt(numberedMatch[1], 10) || 1,
      },
    }
  }

  const bulletMatch = line.match(/^[-*•]\s+(.+)$/u)
  if (bulletMatch) {
    return {
      type: 'bulleted-list',
      content: bulletMatch[1].trim(),
    }
  }

  const quoteMatch = line.match(/^>\s+(.+)$/u)
  if (quoteMatch) {
    return {
      type: 'quote',
      content: quoteMatch[1].trim(),
    }
  }

  if (/^([-*_]){3,}$/u.test(line)) {
    return {
      type: 'divider',
    }
  }

  return {
    type: 'text',
    content: line,
  }
}

function normalizeStructuredXVextaInput(block: XVextaBlockInput): XVextaBlockInput {
  const trimmedContent = block.content?.trim()
  if (!trimmedContent) {
    return block
  }

  if (block.type === 'text') {
    return parseStructuredXVextaLine(trimmedContent)
  }

  return {
    ...block,
    content: formatXVextaInlineText(trimmedContent),
  }
}

function expandXVextaBlockInput(block: XVextaBlockInput): XVextaBlockInput[] {
  const trimmedContent = block.content?.trim()
  if (!trimmedContent) {
    return [block]
  }

  if (block.type === 'text') {
    return parseXVextaRichText(trimmedContent).blocks
  }

  return [
    {
      ...block,
      content: formatXVextaInlineText(trimmedContent),
    },
  ]
}

function normalizeXVextaBlockInput(block: XVextaBlockInput): Record<string, unknown> {
  const normalizedBlock = normalizeStructuredXVextaInput(block)
  const metadata = normalizedBlock.metadata ?? {}

  if (normalizedBlock.type === 'table') {
    const columns = Array.isArray(metadata.columns) && metadata.columns.length > 0 ? metadata.columns.map(String) : ['Колонка 1', 'Колонка 2']
    const rows = Array.isArray(metadata.rows) && metadata.rows.length > 0 ? metadata.rows.map(String) : ['|']
    return {
      id: `block-${randomUUID().slice(0, 8)}`,
      type: 'table',
      content: normalizedBlock.content ?? '',
      children: [],
      metadata: {
        columns,
        rows,
      },
    }
  }

  if (normalizedBlock.type === 'todo') {
    return {
      id: `block-${randomUUID().slice(0, 8)}`,
      type: 'todo',
      content: normalizedBlock.content ?? '',
      children: [],
      metadata: {
        checked: Boolean(metadata.checked),
      },
    }
  }

  if (normalizedBlock.type === 'numbered-list') {
    return {
      id: `block-${randomUUID().slice(0, 8)}`,
      type: 'numbered-list',
      content: normalizedBlock.content ?? '',
      children: [],
      metadata: {
        start: typeof metadata.start === 'number' ? metadata.start : 1,
      },
    }
  }

  if (normalizedBlock.type === 'image') {
    return {
      id: `block-${randomUUID().slice(0, 8)}`,
      type: 'image',
      content: normalizedBlock.content ?? '',
      children: [],
      metadata: {
        src: typeof metadata.src === 'string' ? metadata.src : '',
        caption: typeof metadata.caption === 'string' ? metadata.caption : '',
        alt: typeof metadata.alt === 'string' ? metadata.alt : '',
      },
    }
  }

  if (normalizedBlock.type === 'embed') {
    return {
      id: `block-${randomUUID().slice(0, 8)}`,
      type: 'embed',
      content: normalizedBlock.content ?? '',
      children: [],
      metadata: {
        url: typeof metadata.url === 'string' ? metadata.url : '',
      },
    }
  }

  if (normalizedBlock.type === 'code') {
    return {
      id: `block-${randomUUID().slice(0, 8)}`,
      type: 'code',
      content: normalizedBlock.content ?? '',
      children: [],
      metadata: {
        language: typeof metadata.language === 'string' ? metadata.language : 'txt',
      },
    }
  }

  if (normalizedBlock.type === 'callout') {
    return {
      id: `block-${randomUUID().slice(0, 8)}`,
      type: 'callout',
      content: normalizedBlock.content ?? '',
      children: [],
      metadata: {
        icon: typeof metadata.icon === 'string' ? metadata.icon : '\u{1F4A1}',
      },
    }
  }

  return {
    id: `block-${randomUUID().slice(0, 8)}`,
    type: normalizedBlock.type,
    content: normalizedBlock.content ?? '',
    children: [],
    metadata,
  }
}

function resolveXVextaSummary(currentSummary: string, blocks: Array<Record<string, unknown>>): string {
  const derived = summarizeStoredXVextaBlocks(blocks)
  return currentSummary || derived || ''
}

function assertXVextaNoteContentLooksReal(input: {
  title: string
  summary: string
  blocks: XVextaBlockInput[]
}): void {
  if (isXVextaPlaceholderNoteContent(input)) {
    throw new Error('Generated note content is too generic to save safely')
  }
}

function summarizeStoredXVextaBlocks(blocks: Array<Record<string, unknown>>): string {
  const inputs = blocks.flatMap((block) => storedBlockToInputs(block))
  return summarizeXVextaBlockInputs(inputs)
}

function storedBlockToInputs(block: Record<string, unknown>): XVextaBlockInput[] {
  const type = typeof block.type === 'string' ? block.type : ''
  if (!isXVextaBlockType(type)) {
    return []
  }

  const result: XVextaBlockInput = {
    type,
    content: typeof block.content === 'string' ? stripXVextaHtml(block.content) : undefined,
    metadata:
      block.metadata && typeof block.metadata === 'object' && !Array.isArray(block.metadata)
        ? (block.metadata as Record<string, string | number | boolean | null | string[]>)
        : undefined,
  }

  return [result]
}

function isXVextaBlockType(value: string): value is XVextaBlockInput['type'] {
  return (
    value === 'text' ||
    value === 'heading-1' ||
    value === 'heading-2' ||
    value === 'heading-3' ||
    value === 'bulleted-list' ||
    value === 'numbered-list' ||
    value === 'todo' ||
    value === 'quote' ||
    value === 'code' ||
    value === 'image' ||
    value === 'table' ||
    value === 'divider' ||
    value === 'callout' ||
    value === 'embed'
  )
}

function normalizeNullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeEmailArray(value: string[] | undefined): string[] {
  return normalizeTextArray(value).map((entry) => entry.toLowerCase())
}

function normalizeMemoryText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTextArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean),
    ),
  )
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value
}

function normalizeAgentMailStatus(value: string | undefined): AgentMailConnectionStatus | null {
  if (value === 'disconnected' || value === 'ready' || value === 'error') {
    return value
  }

  return null
}

function normalizeAgentMailFolder(value: string | undefined): AgentMailFolder | null {
  if (value === 'inbox' || value === 'sent' || value === 'drafts') {
    return value
  }

  return null
}

function buildAgentMailPreview(explicitPreview: string | undefined, bodyText: string): string {
  const preview = normalizeNullableText(explicitPreview) ?? bodyText.trim()
  if (preview.length <= 180) {
    return preview
  }

  return `${preview.slice(0, 177).trimEnd()}...`
}

function shouldRefreshAgentMailSync(lastSyncedAt: string | null, windowMs = 45_000) {
  if (!lastSyncedAt) {
    return true
  }

  const parsed = Date.parse(lastSyncedAt)
  if (Number.isNaN(parsed)) {
    return true
  }

  return Date.now() - parsed >= windowMs
}

function normalizeMemoryCategory(value: string | undefined): MemoryCategory | null {
  if (
    value === 'people' ||
    value === 'places' ||
    value === 'games' ||
    value === 'tech' ||
    value === 'events' ||
    value === 'media' ||
    value === 'ideas' ||
    value === 'orgs'
  ) {
    return value
  }

  return null
}

function normalizeMemorySlug(value: string | undefined, title: string, fallback?: string): string {
  const source = value?.trim() || fallback || title
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)

  return normalized || `memory-${randomUUID().slice(0, 8)}`
}

function normalizeProjectCode(value: string | undefined, fallbackName: string, currentCode?: string): string {
  const source = value?.trim() || currentCode || fallbackName
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return normalized || `project-${randomUUID().slice(0, 8)}`
}

function resolveCompletedAt(input: UpdateTaskInput, current: Task): string | null {
  if (input.completedAt !== undefined) {
    return input.completedAt
  }
  if (input.status === 'done') {
    return new Date().toISOString()
  }
  if (input.status === 'todo' || input.status === 'in_progress' || input.status === 'canceled') {
    return null
  }
  return current.completedAt
}

function buildReminderOccurrenceKey(reminder: Reminder, now: Date): string {
  if (reminder.recurrence === 'weekly') {
    const weekIndex = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000))
    return `week-${weekIndex}`
  }

  return now.toISOString().slice(0, 10)
}
