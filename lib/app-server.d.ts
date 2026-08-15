/**
 * dsh-subagent-codex app-server client type declarations.
 */

export const THREAD_STATUS: Readonly<{
  NOT_LOADED: 'notLoaded'
  IDLE: 'idle'
  ACTIVE: 'active'
  SYSTEM_ERROR: 'systemError'
}>

export type ThreadStatusType = 'notLoaded' | 'idle' | 'active' | 'systemError'

export class AppServerError extends Error {
  code: number
  detail?: unknown
}

export interface AppServerSpawnHandle {
  stdin: { write(data: string): unknown }
  stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown }
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown }
  on?(event: 'exit', listener: (code: number) => void): unknown
  kill(): unknown
  waitForExit?(): Promise<unknown>
}

export interface AppServerClientOptions {
  spawn: (argv: string[], opts: { cwd?: string }) => AppServerSpawnHandle
  node: string
  js: string
  cwd?: string
  requestTimeoutMs?: number
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
}

export interface TrackedThreadState {
  status?: ThreadStatusType
  activeTurnId?: string
  managed?: boolean
}

export interface ThreadListItem {
  id?: string
  name?: string
  preview?: string
  cwd?: string
  source?: string
  status?: ThreadStatusType
  activeFlags?: string[]
  updatedAt?: number
  createdAt?: number
}

export class AppServerClient {
  constructor(options: AppServerClientOptions)
  get initialized(): boolean
  get closed(): boolean
  onNotification(handler: (method: string, params?: unknown) => void): () => boolean
  threadState(threadId: string): TrackedThreadState | undefined
  isManaged(threadId: string): boolean
  ensureStarted(): Promise<void>
  request(method: string, params?: object, opts?: { timeoutMs?: number }): Promise<any>
  threadList(options?: {
    cwd?: string | string[]
    limit?: number
    sourceKinds?: string[]
    sortKey?: string
    cursor?: string
  }): Promise<{ threads: ThreadListItem[]; nextCursor: string | null; backwardsCursor: string | null }>
  threadRead(threadId: string, options?: { includeTurns?: boolean }): Promise<any>
  threadStart(options?: { cwd?: string; model?: string }): Promise<any>
  threadResume(threadId: string, options?: { model?: string }): Promise<any>
  turnStart(options: {
    threadId: string
    input: Array<{ type: string; text?: string }>
    model?: string
    effort?: string
    cwd?: string
  }): Promise<any>
  turnSteer(options: {
    threadId: string
    input: Array<{ type: string; text?: string }>
    expectedTurnId: string
  }): Promise<any>
  dispose(): Promise<void>
}

export function classifyThreadStatus(
  statusType: ThreadStatusType | undefined,
  isManaged: boolean,
): 'active_managed' | 'idle_managed' | 'external_or_idle' | 'system_error'
