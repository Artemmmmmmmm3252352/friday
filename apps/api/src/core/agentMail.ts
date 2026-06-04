import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')
const AGENTMAIL_API_BASE = 'https://api.agentmail.to/v0'

export type AgentMailRemoteInbox = {
  inboxId: string
  address: string
  displayName: string
}

export type AgentMailRemoteMessage = {
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
}

export async function createAgentMailInbox(input: {
  displayName: string
  requestedAddress?: string | null
  clientId?: string
}): Promise<AgentMailRemoteInbox> {
  const body: Record<string, unknown> = {
    display_name: input.displayName,
  }

  const parsedAddress = parseRequestedAddress(input.requestedAddress)
  if (parsedAddress?.username) {
    body.username = parsedAddress.username
  }
  if (parsedAddress?.domain) {
    body.domain = parsedAddress.domain
  }
  if (input.clientId) {
    body.client_id = input.clientId
  }

  const payload = await agentMailRequest('/inboxes', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  return mapRemoteInbox(payload)
}

export async function listAgentMailMessages(inboxId: string, limit = 50): Promise<AgentMailRemoteMessage[]> {
  const payload = await agentMailRequest(`/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${limit}`)
  const rawMessages = extractArray(payload, ['messages', 'data', 'value', 'items'])
  return rawMessages.map(mapRemoteMessage).filter((entry): entry is AgentMailRemoteMessage => Boolean(entry))
}

export async function getAgentMailMessage(inboxId: string, messageId: string): Promise<AgentMailRemoteMessage> {
  const payload = await agentMailRequest(`/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`)
  const mapped = mapRemoteMessage(payload)
  if (!mapped) {
    throw new Error('AgentMail message response was empty')
  }

  return mapped
}

export async function sendAgentMailMessage(input: {
  inboxId: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  html?: string | null
}): Promise<{ externalId: string | null; threadId: string | null }> {
  const payload = await agentMailRequest(`/inboxes/${encodeURIComponent(input.inboxId)}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      text: input.text,
      html: input.html ?? undefined,
    }),
  })

  return {
    externalId: pickString(payload, ['message_id', 'id']),
    threadId: pickString(payload, ['thread_id', 'threadId']),
  }
}

export async function readAgentMailApiKey(): Promise<string> {
  try {
    const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const skills = asRecord(parsed.skills)
    const entries = asRecord(skills?.entries)
    const agentmail = asRecord(entries?.agentmail)
    const env = asRecord(agentmail?.env)
    const apiKey = typeof env?.AGENTMAIL_API_KEY === 'string' ? env.AGENTMAIL_API_KEY.trim() : ''
    if (!apiKey) {
      throw new Error('AgentMail API key is missing in ~/.openclaw/openclaw.json')
    }
    return apiKey
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Failed to read AgentMail API key')
  }
}

async function agentMailRequest(pathname: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const apiKey = await readAgentMailApiKey()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  let response: Response
  try {
    response = await fetch(`${AGENTMAIL_API_BASE}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('AgentMail request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const payload = (await safeParseJson(response)) ?? {}
  if (!response.ok) {
    const message =
      pickString(payload, ['message', 'error']) ??
      pickString(asRecord(payload.error), ['message']) ??
      `AgentMail request failed with HTTP ${response.status}`
    throw new Error(message)
  }

  return asRecord(payload) ?? {}
}

async function safeParseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function mapRemoteInbox(payload: Record<string, unknown>): AgentMailRemoteInbox {
  const inbox = asRecord(payload.inbox) ?? payload
  const inboxId = pickString(inbox, ['inbox_id', 'id', 'email'])
  if (!inboxId) {
    throw new Error('AgentMail inbox response did not include inbox_id')
  }

  return {
    inboxId,
    address: pickString(inbox, ['email', 'address', 'inbox_id']) ?? inboxId,
    displayName: pickString(inbox, ['display_name', 'name']) ?? 'Friday',
  }
}

function mapRemoteMessage(payload: unknown): AgentMailRemoteMessage | null {
  const message = asRecord(payload)
  if (!message) {
    return null
  }

  const fromRecord = normalizeFromField(message.from)
  const subject = pickString(message, ['subject']) ?? ''

  return {
    externalId: pickString(message, ['message_id', 'id']),
    threadId: pickString(message, ['thread_id', 'threadId']),
    fromName: fromRecord?.name ?? null,
    fromAddress: fromRecord?.address ?? pickString(message, ['from_email']) ?? '',
    toAddresses: normalizeAddressList(message.to),
    ccAddresses: normalizeAddressList(message.cc),
    subject,
    preview:
      pickString(message, ['snippet', 'preview']) ??
      pickString(message, ['extracted_text', 'text'])?.slice(0, 180) ??
      subject,
    bodyText:
      pickString(message, ['text', 'extracted_text', 'body_text']) ??
      '',
    bodyHtml:
      pickString(message, ['extracted_html', 'html', 'body_html']),
    sentAt: pickString(message, ['sent_at', 'sentAt', 'timestamp', 'created_at']),
    receivedAt: pickString(message, ['received_at', 'receivedAt', 'timestamp', 'created_at']),
    labels: normalizeStringList(message.labels),
  }
}

function normalizeFromField(value: unknown): { name: string | null; address: string | null } | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized) {
      return null
    }

    const match = normalized.match(/^(.*?)<([^>]+)>$/)
    if (match) {
      const name = match[1]?.trim() || null
      const address = match[2]?.trim().toLowerCase() || null
      return { name, address }
    }

    return {
      name: null,
      address: normalized.toLowerCase(),
    }
  }

  const record = asRecord(value)
  if (!record) {
    return null
  }

  return {
    name: pickString(record, ['name']),
    address: pickString(record, ['email', 'address'])?.toLowerCase() ?? null,
  }
}

function parseRequestedAddress(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return null
  }

  const [username, domain] = normalized.split('@')
  if (!username) {
    return null
  }

  return {
    username,
    domain: domain || undefined,
  }
}

function normalizeAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry.trim().toLowerCase()
      }

      const record = asRecord(entry)
      const email = pickString(record, ['email', 'address'])
      return email?.toLowerCase() ?? ''
    })
    .filter(Boolean)
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
}

function pickString(record: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!record) {
    return null
  }

  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function extractArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value
    }
  }

  return []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
