import type { MusicErrorEnvelope, MusicErrorType } from './models'

export class MusicApiError extends Error {
  readonly statusCode: number
  readonly code: MusicErrorType
  readonly retryable: boolean
  readonly requestId?: string

  constructor(statusCode: number, code: MusicErrorType, message: string, retryable = false, requestId?: string) {
    super(message)
    this.name = 'MusicApiError'
    this.statusCode = statusCode
    this.code = code
    this.retryable = retryable
    this.requestId = requestId
  }

  toResponse(): MusicErrorEnvelope {
    return {
      error: {
        code: this.code,
        type: this.code,
        message: this.message,
        retryable: this.retryable,
        requestId: this.requestId,
      },
    }
  }
}

export function isMusicApiError(value: unknown): value is MusicApiError {
  return value instanceof MusicApiError
}
