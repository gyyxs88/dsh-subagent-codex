/**
 * dsh-subagent-codex session tools type declarations.
 */

import type { AppServerClient, ThreadListItem } from './app-server.js'

export const MAX_HISTORY_CHARS: number
export const MAX_HISTORY_TURNS: number

export { classifyThreadStatus } from './app-server.js'

export function truncate(text: string, max?: number): string

export function summarizeThread(thread: unknown): ThreadListItem | undefined

export function deliveryCapabilities(
  statusType: string | undefined,
  isManaged: boolean,
  canSteer?: boolean,
): {
  delivery: 'active_managed' | 'idle_managed' | 'external_or_idle' | 'system_error'
  view: boolean
  resume_unmanaged: boolean
  steer: boolean
  start_managed_turn: boolean
}

export interface ListSessionsOptions {
  client: AppServerClient
  cwd?: string
  includeAll?: boolean
  limit?: number
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
}

export function listSessions(options: ListSessionsOptions): Promise<{
  threads: Array<ThreadListItem & ReturnType<typeof deliveryCapabilities>>
  total: number
  nextCursor: string | null
  includeAll: boolean
  cwd?: string
  truncated: boolean
}>

export interface ReadSessionOptions {
  client: AppServerClient
  threadId: string
  maxTurns?: number
  maxChars?: number
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
}

export function readSession(options: ReadSessionOptions): Promise<{
  threadId: string
  status: string
  activeFlags?: string[]
  canAcceptDirectInput: boolean | null
  turns: Array<{ id?: string; status?: string; text: string; chars: number }>
  truncated: boolean
  chars: number
} & ReturnType<typeof deliveryCapabilities>>

export interface StartManagedSessionOptions {
  client: AppServerClient
  cwd?: string
  input: string
  model?: string
  reasoningEffort?: string
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
}

export function startManagedSession(options: StartManagedSessionOptions): Promise<{
  kind: 'managed_turn_started'
  threadId: string
  turnId?: string
  managed: true
  steerable: true
  status: 'active'
  delivery: 'active_managed'
}>

export interface SendMessageOptions {
  client: AppServerClient
  threadId: string
  input: string
  mode?: 'auto' | 'resume'
  turnOverrides?: { model?: string; reasoningEffort?: string }
  resumeSender?: (
    threadId: string,
    input: string,
    overrides?: { model?: string; reasoningEffort?: string },
  ) => Promise<{ sessionId?: string; output?: string }>
}

export function sendMessage(options: SendMessageOptions): Promise<Record<string, unknown>>
