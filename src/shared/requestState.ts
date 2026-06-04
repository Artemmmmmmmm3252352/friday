import type { RequestStatus } from './contracts'

const transitions: Record<RequestStatus, RequestStatus[]> = {
  idle: ['checking_gateway', 'recording', 'sending', 'error'],
  checking_gateway: ['idle', 'sending', 'error'],
  recording: ['transcribing', 'idle', 'error'],
  transcribing: ['sending', 'idle', 'error'],
  sending: ['completed', 'error', 'idle'],
  completed: ['idle', 'recording', 'sending', 'checking_gateway', 'error'],
  error: ['idle', 'checking_gateway', 'recording', 'sending'],
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return transitions[from].includes(to)
}

export function isBusy(status: RequestStatus): boolean {
  return ['checking_gateway', 'recording', 'transcribing', 'sending'].includes(status)
}
