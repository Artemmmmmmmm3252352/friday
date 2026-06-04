import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEY_LENGTH = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, KEY_LENGTH).toString('hex')
  return `${salt}:${derived}`
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [salt, stored] = passwordHash.split(':')
  if (!salt || !stored) {
    return false
  }

  const derived = scryptSync(password, salt, KEY_LENGTH)
  const storedBuffer = Buffer.from(stored, 'hex')
  if (derived.length !== storedBuffer.length) {
    return false
  }

  return timingSafeEqual(derived, storedBuffer)
}

export function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`
}

export function hashToken(token: string): string {
  return scryptSync(token, 'friday-token', KEY_LENGTH).toString('hex')
}
