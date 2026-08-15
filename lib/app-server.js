/**
 * dsh-subagent-codex — Codex app-server client.
 *
 * A long-lived stdio JSON-RPC 2.0 client for `codex app-server` (which speaks
 * the JSON-RPC 2.0 protocol on stdio by default; wire messages omit the
 * `jsonrpc` header, one JSON object per line).
 *
 * The client adapts to the DSH `subprocess` service handle shape:
 *   - spawn spec: `{ argv, cwd, stdio: { stdin: 'pipe', stdout: 'pipe',
 *     stderr: 'pipe' }, graceMs }`
 *   - handle: `{ pid, stdin?, stdout?, stderr?, collected, done:
 *     Promise<{exitCode, signal}>, terminate(), waitForExit() }`
 *   - there is NO `on('exit')` event and no `kill()` — process exit is
 *     observed through `done`, termination through `terminate()` +
 *     `waitForExit()`.
 *
 * Dependencies are injected so tests can drive a fake DSH handle; no real
 * Codex process or model is ever required.
 *
 * Protocol notes (verified against the rust-v0.147.0 app-server README and the
 * local generated JSON schema):
 *   - Two-phase handshake: `initialize` request, then an `initialized`
 *     notification (no id). `initialize` must be sent exactly once per
 *     connection; re-sending is an error, so failures tear down the child and
 *     force a fresh connection instead of retrying in place.
 *   - The protocol is bidirectional JSON-RPC: a message with both `id` and
 *     `method` is a SERVER REQUEST, not a response. We answer every server
 *     request we do not support with an explicit method-not-found error so a
 *     turn can never hang waiting on us.
 *   - `thread/resume` accepts `approvalPolicy` and `sandbox` (string mode),
 *     NOT `sandboxPolicy`; reasoning effort is only valid on `turn/start`
 *     (`effort`). `turn/start` takes `sandboxPolicy: { type: "dangerFullAccess" }`
 *     and `approvalPolicy: "never"`.
 *
 * Security: every managed turn this client starts ALWAYS uses
 * `approvalPolicy: "never"` + `sandboxPolicy: { type: "dangerFullAccess" }`,
 * matching the plugin-wide fixed no-approval / no-sandbox policy.
 * `turn/steer` accepts no such overrides, so only turns started through
 * `turnStart()` (recorded in `ownedTurns`) can ever be steered.
 */

import { StringDecoder } from 'node:string_decoder'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Safety caps so a misbehaving server cannot grow memory without bound. */
const MAX_LINE_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_PENDING_REQUESTS = 128

/** Wire statuses for `thread/status/changed` and `thread/read` responses. */
export const THREAD_STATUS = Object.freeze({
  NOT_LOADED: 'notLoaded',
  IDLE: 'idle',
  ACTIVE: 'active',
  SYSTEM_ERROR: 'systemError',
})

export class AppServerError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'AppServerError'
    this.code = code
    this.detail = detail
  }
}

/** Internal representation of one in-flight JSON-RPC request. */
class PendingRequest {
  constructor(id, method, resolve, reject, timer) {
    this.id = id
    this.method = method
    this.resolve = resolve
    this.reject = reject
    this.timer = timer
  }
}

export class AppServerClient {
  /**
   * @param {object} opts
   * @param {(argv: string[], opts: { cwd?: string }) => object} opts.spawn
   *   A function that returns a DSH-shaped subprocess handle
   *   (`{ stdin?, stdout?, stderr?, collected, done, terminate, waitForExit }`).
   * @param {string} opts.node
   * @param {string} opts.js
   * @param {string} [opts.cwd]
   * @param {number} [opts.requestTimeoutMs]
   * @param {{ info?: Function, warn?: Function, error?: Function }} [opts.logger]
   */
  constructor({ spawn, node, js, cwd, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, logger }) {
    if (typeof spawn !== 'function') throw new Error('AppServerClient: spawn is required')
    if (typeof node !== 'string' || typeof js !== 'string') {
      throw new Error('AppServerClient: node and js are required')
    }
    this._spawn = spawn
    this._node = node
    this._js = js
    this._cwd = cwd
    this._requestTimeoutMs = requestTimeoutMs
    this._logger = logger ?? { info() {}, warn() {}, error() {} }

    this._handle = undefined
    this._nextId = 1
    this._pending = new Map() // id -> PendingRequest
    this._decoder = new StringDecoder('utf8')
    this._lineBuffer = ''
    this._initialized = false
    this._closed = false
    this._exitInfo = undefined
    this._disposePromise = undefined

    // Managed-thread state, populated from notifications and our own calls.
    // `managed` means this client loaded the thread (thread/resume success)
    // or started a turn on it (turn/start success) — the only threads whose
    // active turn can legitimately be steered.
    this._threads = new Map() // threadId -> { status, activeTurnId, managed }
    this._ownedTurns = new Set() // turn ids created by OUR turnStart()
    this._listeners = new Set() // notification handlers
  }

  get initialized() {
    return this._initialized
  }

  get closed() {
    return this._closed
  }

  /** Register a handler for server notifications: (method, params) => void. */
  onNotification(handler) {
    if (typeof handler !== 'function') throw new Error('AppServerClient: handler must be a function')
    this._listeners.add(handler)
    return () => this._listeners.delete(handler)
  }

  /** Snapshot of tracked thread state (status, activeTurnId, managed). */
  threadState(threadId) {
    const state = this._threads.get(threadId)
    return state === undefined ? undefined : { ...state }
  }

  isManaged(threadId) {
    const state = this._threads.get(threadId)
    return state !== undefined && state.managed === true
  }

  /**
   * Lazily start the child and complete the two-phase handshake.
   * Safe to call multiple times; returns the same initialization promise
   * (single-flight), so concurrent first requests share one child.
   */
  async ensureStarted() {
    if (this._initialized) return
    if (this._closed) throw new AppServerError(-32000, 'app-server client is closed')
    if (this._startPromise === undefined) {
      this._startPromise = this._startAndInitialize()
    }
    return this._startPromise
  }

  async _startAndInitialize() {
    const handle = this._spawn(
      [this._node, this._js, 'app-server'],
      { cwd: this._cwd },
    )
    if (!handle || typeof handle.done?.then !== 'function' || !handle.stdout || typeof handle.stdout.on !== 'function') {
      throw new AppServerError(-32000, 'app-server spawn returned an invalid handle')
    }
    this._handle = handle

    handle.stdout.on('data', (chunk) => this._onData(chunk))
    if (handle.stderr && typeof handle.stderr.on === 'function') {
      handle.stderr.on('data', (chunk) => {
        // Log metadata only — stderr may carry command output or secrets.
        const len = Buffer.byteLength(String(chunk))
        this._logger.warn?.(`[app-server stderr] ${len} bytes`)
      })
    }
    // Observe exit through `done` (the DSH handle has no 'exit' event).
    handle.done.then(
      (outcome) => this._onExit(outcome?.exitCode),
      (error) => {
        this._logger.error?.('app-server done rejected:', String(error?.message ?? error))
        this._onExit(undefined)
      },
    )

    // Single initialize per connection; on failure tear down and let the next
    // ensureStarted() retry with a fresh child (never re-initialize in place).
    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'dsh-subagent-codex',
          title: 'DeepSeek Harness Codex Subagent',
          version: '0.1.0',
        },
      })
    } catch (error) {
      await this.dispose()
      throw error
    }
    // Second half of the handshake: acknowledge with an `initialized`
    // notification (no id). Must happen before any other request.
    try {
      this._handle.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    } catch (error) {
      await this.dispose()
      throw new AppServerError(-32000, `app-server initialized notification failed: ${String(error.message ?? error)}`)
    }
    this._initialized = true
    this._logger.info?.('app-server initialized')
  }

  _onData(chunk) {
    this._lineBuffer += this._decoder.write(chunk)
    if (Buffer.byteLength(this._lineBuffer) > MAX_LINE_BUFFER_BYTES) {
      this._logger.warn?.('app-server: line buffer exceeded cap; dropping connection')
      this.dispose().catch(() => {})
      return
    }
    let idx
    while ((idx = this._lineBuffer.indexOf('\n')) >= 0) {
      const line = this._lineBuffer.slice(0, idx).trim()
      this._lineBuffer = this._lineBuffer.slice(idx + 1)
      if (line) this._onLine(line)
    }
  }

  _onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this._logger.warn?.('app-server: ignoring non-JSON line')
      return
    }
    if (!msg || typeof msg !== 'object') return

    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string'
    const hasMethod = typeof msg.method === 'string'

    if (hasId && hasMethod) {
      // Server-initiated REQUEST (bidirectional JSON-RPC). We support none of
      // the server's elicitation/tool-call requests, so answer explicitly to
      // avoid leaving a turn waiting forever.
      this._answerServerRequest(msg.id, msg.method)
    } else if (hasId && 'result' in msg) {
      this._settle(msg.id, msg.result)
    } else if (hasId && msg.error !== undefined) {
      this._reject(msg.id, msg.error)
    } else if (hasId) {
      this._reject(msg.id, { code: -32603, message: 'app-server response missing result/error' })
    } else if (hasMethod) {
      this._emitNotification(msg.method, msg.params)
    }
  }

  _answerServerRequest(id, method) {
    const line = JSON.stringify({
      id,
      error: { code: -32601, message: `dsh-subagent-codex does not support server request ${method}` },
    })
    try {
      this._handle.stdin.write(line + '\n')
    } catch {}
  }

  _settle(id, result) {
    const pending = this._pending.get(id)
    if (!pending) return
    this._pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }

  _reject(id, error) {
    const pending = this._pending.get(id)
    if (!pending) return
    this._pending.delete(id)
    clearTimeout(pending.timer)
    const err = new AppServerError(
      error?.code ?? -32603,
      error?.message ?? 'app-server request failed',
      error,
    )
    pending.reject(err)
  }

  _emitNotification(method, params) {
    // Track thread/turn lifecycle so we can report honest status and know
    // which active turn (if any) belongs to a managed thread.
    if (method === 'thread/status/changed' && params && typeof params.threadId === 'string') {
      this._updateThreadStatus(params.threadId, params.status)
    } else if (method === 'turn/started' && params && params.turn && typeof params.turn.id === 'string') {
      // Only turns created by OUR turnStart() may ever be claimed steerable.
      if (this._ownedTurns.has(params.turn.id)) {
        this._markTurnStarted(params.turn.threadId ?? params.threadId, params.turn.id)
      }
    } else if (method === 'turn/completed' && params && params.turn && typeof params.turn.id === 'string') {
      this._markTurnEnded(params.turn.threadId ?? params.threadId, params.turn.id)
    }
    for (const handler of this._listeners) {
      try {
        handler(method, params)
      } catch (error) {
        this._logger.warn?.('app-server notification handler failed:', String(error.message ?? error))
      }
    }
  }

  _updateThreadStatus(threadId, status) {
    const type = status?.type
    const existing = this._threads.get(threadId) ?? { managed: false, activeTurnId: undefined }
    existing.status = type
    if (type !== THREAD_STATUS.ACTIVE) existing.activeTurnId = undefined
    this._threads.set(threadId, existing)
  }

  _markTurnStarted(threadId, turnId) {
    if (!threadId) return
    const existing = this._threads.get(threadId) ?? { managed: false }
    existing.status = THREAD_STATUS.ACTIVE
    existing.activeTurnId = turnId
    this._threads.set(threadId, existing)
  }

  _markTurnEnded(threadId, turnId) {
    if (!threadId) return
    // A completed turn is no longer steerable; drop it from the owned set so
    // the collection cannot grow without bound over a long-lived process.
    this._ownedTurns.delete(turnId)
    const existing = this._threads.get(threadId) ?? { managed: false }
    // Only clear the active turn if it matches; a stale completion for an old
    // turn must never downgrade a newer active turn.
    if (existing.activeTurnId === turnId) {
      existing.activeTurnId = undefined
      if (existing.status === THREAD_STATUS.ACTIVE) existing.status = THREAD_STATUS.IDLE
      this._threads.set(threadId, existing)
    }
  }

  _markManaged(threadId) {
    const existing = this._threads.get(threadId) ?? {}
    existing.managed = true
    this._threads.set(threadId, existing)
  }

  _onExit(code) {
    this._exitInfo = { code }
    this._closed = true
    const error = new AppServerError(-32000, `app-server process exited (code ${code})`)
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pending.clear()
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [opts]
   */
  request(method, params, { timeoutMs } = {}) {
    if (this._closed) {
      return Promise.reject(new AppServerError(-32000, 'app-server client is closed'))
    }
    if (this._pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new AppServerError(-32001, 'app-server too many in-flight requests'))
    }
    const id = this._nextId++
    const timeout = timeoutMs ?? this._requestTimeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pending.get(id)
        if (!pending) return
        this._pending.delete(id)
        const err = new AppServerError(-32001, `app-server request timed out: ${method}`)
        err.outcomeUnknown = true // mutation may still have been applied
        reject(err)
      }, timeout)
      this._pending.set(id, new PendingRequest(id, method, resolve, reject, timer))
      const line = JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })
      try {
        this._handle.stdin.write(line + '\n')
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(new AppServerError(-32000, `app-server stdin write failed: ${String(error.message ?? error)}`))
      }
    })
  }

  /**
   * List stored threads. `cwd` may be a string or array; omit to include all
   * projects. `sourceKinds` defaults to include exec/app-server sessions too
   * (the wire default is interactive-only).
   */
  async threadList({ cwd, limit = 50, sourceKinds, sortKey = 'created_at', cursor } = {}) {
    const params = {
      limit,
      sortKey,
      ...(cursor === undefined || cursor === null ? {} : { cursor }),
      ...(cwd === undefined || cwd === null || cwd === '' ? {} : { cwd }),
      ...(sourceKinds === undefined ? { sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentOther', 'unknown'] } : { sourceKinds }),
    }
    const result = await this.request('thread/list', params)
    return {
      threads: Array.isArray(result?.data) ? result.data : [],
      nextCursor: result?.nextCursor ?? null,
      backwardsCursor: result?.backwardsCursor ?? null,
    }
  }

  /** Read a stored thread without resuming it. */
  async threadRead(threadId, { includeTurns = true } = {}) {
    const result = await this.request('thread/read', { threadId, includeTurns })
    const thread = result?.thread
    if (!thread || typeof thread.id !== 'string') {
      throw new AppServerError(-32602, `app-server thread/read returned no thread for ${threadId}`)
    }
    this._updateThreadStatus(thread.id, thread.status)
    return thread
  }

  /**
   * Load a stored thread into this app-server so turns can be started.
   * ALWAYS uses the fixed no-approval / no-sandbox policy; reasoning effort is
   * NOT valid here (schema) — pass model only.
   */
  async threadResume(threadId, { model } = {}) {
    const params = {
      threadId,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }
    if (model !== undefined) params.model = model
    const result = await this.request('thread/resume', params)
    this._markManaged(threadId)
    const thread = result?.thread
    if (thread && typeof thread.status?.type === 'string') {
      this._updateThreadStatus(threadId, thread.status)
    }
    return result
  }

  /**
   * Start a fresh thread on this app-server. ALWAYS uses the fixed
   * no-approval / no-sandbox policy. Does not start a turn by itself —
   * call `turnStart` afterwards to send the first message.
   */
  async threadStart({ cwd, model } = {}) {
    const params = {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      threadSource: 'dsh-subagent-codex',
    }
    if (cwd !== undefined) params.cwd = cwd
    if (model !== undefined) params.model = model
    const result = await this.request('thread/start', params)
    const thread = result?.thread
    if (!thread || typeof thread.id !== 'string') {
      throw new AppServerError(-32602, 'app-server thread/start returned no thread')
    }
    this._markManaged(thread.id)
    this._updateThreadStatus(thread.id, thread.status)
    return result
  }

  /**
   * Start a turn on a loaded thread. ALWAYS uses the fixed no-approval /
   * no-sandbox policy; no caller-supplied override is accepted. The returned
   * turn id is recorded as owned so it can later be steered.
   */
  async turnStart({ threadId, input, model, effort, cwd } = {}) {
    if (typeof threadId !== 'string') throw new AppServerError(-32602, 'turnStart: threadId is required')
    if (!Array.isArray(input) || input.length === 0) {
      throw new AppServerError(-32602, 'turnStart: input is required')
    }
    const params = {
      threadId,
      input,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }
    if (model !== undefined) params.model = model
    if (effort !== undefined) params.effort = effort
    if (cwd !== undefined) params.cwd = cwd
    const result = await this.request('turn/start', params)
    const turn = result?.turn
    if (turn && typeof turn.id === 'string') {
      this._ownedTurns.add(turn.id)
      this._markManaged(threadId)
      this._markTurnStarted(threadId, turn.id)
    }
    return result
  }

  /**
   * Steer the currently active turn of a thread. `expectedTurnId` is required;
   * the request fails if it does not match the server's active turn.
   */
  async turnSteer({ threadId, input, expectedTurnId } = {}) {
    if (typeof threadId !== 'string' || typeof expectedTurnId !== 'string') {
      throw new AppServerError(-32602, 'turnSteer: threadId and expectedTurnId are required')
    }
    if (!Array.isArray(input) || input.length === 0) {
      throw new AppServerError(-32602, 'turnSteer: input is required')
    }
    if (!this._ownedTurns.has(expectedTurnId)) {
      throw new AppServerError(
        -32602,
        'turnSteer: refusing to steer a turn this plugin did not start',
      )
    }
    return this.request('turn/steer', { threadId, input, expectedTurnId })
  }

  /** Terminate the child and reject anything still in flight. Idempotent. */
  async dispose() {
    if (this._disposePromise !== undefined) return this._disposePromise
    this._disposePromise = this._doDispose()
    return this._disposePromise
  }

  async _doDispose() {
    this._closed = true
    const error = new AppServerError(-32000, 'app-server client disposed')
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pending.clear()
    const handle = this._handle
    this._handle = undefined
    if (handle) {
      try {
        handle.terminate()
      } catch {}
      if (typeof handle.waitForExit === 'function') {
        try {
          await handle.waitForExit()
        } catch {}
      }
    }
  }
}

/**
 * Classify a thread into the plugin's honest delivery states.
 * `notLoaded` can mean idle OR actively running in another process — we never
 * claim active from mtime or any heuristic.
 *
 * @param {string|undefined} statusType - wire ThreadStatus.type
 * @param {boolean} isManaged - whether this plugin's app-server loaded the thread
 * @returns {'active_managed'|'idle_managed'|'external_or_idle'|'system_error'}
 */
export function classifyThreadStatus(statusType, isManaged) {
  switch (statusType) {
    case THREAD_STATUS.ACTIVE:
      // Active inside THIS app-server. If it is not managed by this plugin
      // (should not happen with a private child), refuse to claim steerability.
      return isManaged ? 'active_managed' : 'external_or_idle'
    case THREAD_STATUS.IDLE:
      return isManaged ? 'idle_managed' : 'external_or_idle'
    case THREAD_STATUS.SYSTEM_ERROR:
      return 'system_error'
    case THREAD_STATUS.NOT_LOADED:
    default:
      // Not loaded here: idle, or actively running in another Codex process.
      return 'external_or_idle'
  }
}
