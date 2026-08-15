import { classifyThreadStatus } from './app-server.js'

/**
 * dsh-subagent-codex — session discovery / read / send tools.
 *
 * Pure, dependency-injected logic layered on top of the app-server client
 * (lib/app-server.js). Everything here is deterministic and testable with a
 * fake client; no real Codex process or model is ever called.
 *
 * Delivery semantics (honest about concurrency):
 *   - active + managed by this plugin + known activeTurnId  → `steered`
 *     (turn/steer with expectedTurnId; requires the SAME app-server that
 *     started the turn — see `AppServerClient.isManaged`).
 *   - idle + managed → turn/start → `managed_turn_started`.
 *   - notLoaded → external or idle in another process; we never guess active.
 *     Callers may explicitly choose `mode: 'resume'` which sends via
 *     `codex exec resume` and is marked `resume_unmanaged` +
 *     `may_be_concurrent: true`. A failed steer NEVER auto-falls back to
 *     resume.
 *   - systemError → hard failure, no auto-continuation.
 */

/** Cap on characters of history/preview text returned to the model. */
export const MAX_HISTORY_CHARS = 12_000
/** Cap on number of turns returned by readSession. */
export const MAX_HISTORY_TURNS = 20

// Single source of truth for wire status → honest delivery state mapping.
export { classifyThreadStatus } from './app-server.js'

/** Truncate a string to at most `max` chars, appending an ellipsis marker. */
export function truncate(text, max = MAX_HISTORY_CHARS) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[truncated]`
}

/**
 * Summarize one thread list item into a bounded, safe shape.
 * Never includes secrets; previews are truncated.
 */
export function summarizeThread(thread) {
  if (!thread || typeof thread !== 'object') return undefined
  return {
    id: typeof thread.id === 'string' ? thread.id : undefined,
    name: typeof thread.name === 'string' && thread.name ? thread.name : undefined,
    preview: truncate(typeof thread.preview === 'string' ? thread.preview : '', 200),
    cwd: typeof thread.cwd === 'string' ? thread.cwd : undefined,
    source: typeof thread.source === 'string' ? thread.source : undefined,
    status: thread.status?.type ?? 'notLoaded',
    activeFlags: Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : undefined,
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined,
    createdAt: typeof thread.createdAt === 'number' ? thread.createdAt : undefined,
  }
}

/**
 * List sessions. `cwd` defaults to the caller's working directory; pass
 * `includeAll: true` to list across all projects (explicitly requested).
 * Every entry carries the honest delivery state and capabilities — never a
 * guess from mtime.
 */
export async function listSessions({ client, cwd, includeAll = false, limit = 50, logger }) {
  if (!client) throw new Error('listSessions: client is required')
  const log = logger ?? { info() {}, warn() {} }
  const result = await client.threadList({
    ...(includeAll ? {} : { cwd }),
    limit,
  })
  const threads = result.threads
    .map((raw) => {
      const summarized = summarizeThread(raw)
      if (summarized === undefined) return undefined
      const threadState = client.threadState(summarized.id)
      const caps = deliveryCapabilities(
        summarized.status,
        client.isManaged(summarized.id),
        typeof threadState?.activeTurnId === 'string',
      )
      return { ...summarized, ...caps }
    })
    .filter(Boolean)
  log.info?.(
    `codex sessions listed: ${threads.length} (includeAll=${includeAll}, cwd=${includeAll ? 'any' : cwd})`,
  )
  return {
    threads,
    total: threads.length,
    nextCursor: result.nextCursor ?? null,
    includeAll,
    cwd: includeAll ? undefined : cwd,
    truncated: result.nextCursor != null,
  }
}

/**
 * Read one session's bounded recent history via thread/read (never resumes).
 */
export async function readSession({ client, threadId, maxTurns = MAX_HISTORY_TURNS, maxChars = MAX_HISTORY_CHARS, logger }) {
  if (!client) throw new Error('readSession: client is required')
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('readSession: threadId is required')
  }
  const log = logger ?? { info() {}, warn() {} }
  const thread = await client.threadRead(threadId, { includeTurns: true })

  const rawTurns = Array.isArray(thread.turns) ? thread.turns : []
  // Global character budget across the WHOLE returned history (not per turn):
  // take the most recent `maxTurns` turns, then keep the newest turns that fit
  // under `maxChars` total, preserving chronological order (old → new within
  // the kept set).
  const candidateTurns = rawTurns.slice(-maxTurns)
  const budget = maxChars
  const TRUNC_MARKER = '…[truncated]'
  let used = 0
  let charTruncated = false
  const turns = []
  for (let i = candidateTurns.length - 1; i >= 0; i--) {
    const turn = candidateTurns[i]
    const items = Array.isArray(turn.items) ? turn.items : []
    const texts = items
      .map((item) => {
        if (item && item.type === 'userMessage' && Array.isArray(item.content)) {
          return item.content
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
        }
        if (item && item.type === 'agentMessage' && typeof item.text === 'string') return item.text
        return undefined
      })
      .filter((text) => typeof text === 'string' && text.length > 0)
    const fullText = texts.join('\n')
    const remaining = budget - used
    if (fullText.length > remaining) {
      // This turn does not fully fit; keep the newest prefix of it and stop —
      // older turns are dropped entirely to honor the newest-first policy.
      // The truncation marker counts toward the budget; if even the marker
      // does not fit, emit a bare slice (never exceed `remaining`).
      charTruncated = true
      if (remaining > 0) {
        let text
        if (remaining <= TRUNC_MARKER.length) {
          text = fullText.slice(0, remaining)
        } else {
          text = fullText.slice(0, remaining - TRUNC_MARKER.length) + TRUNC_MARKER
        }
        turns.unshift({
          id: typeof turn.id === 'string' ? turn.id : undefined,
          status: typeof turn.status === 'string' ? turn.status : undefined,
          text,
          chars: text.length,
        })
        used += text.length
      }
      break
    }
    turns.unshift({
      id: typeof turn.id === 'string' ? turn.id : undefined,
      status: typeof turn.status === 'string' ? turn.status : undefined,
      text: fullText,
      chars: fullText.length,
    })
    used += fullText.length
  }

  log.info?.(`codex session read: ${threadId} (${turns.length} turns, status=${thread.status?.type})`)
  const statusType = thread.status?.type ?? 'notLoaded'
  const managed = client.isManaged(threadId)
  const threadState = client.threadState(threadId)
  return {
    threadId: thread.id,
    status: statusType,
    activeFlags: Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : undefined,
    canAcceptDirectInput: thread.canAcceptDirectInput ?? null,
    turns,
    truncated: rawTurns.length > maxTurns || charTruncated,
    chars: turns.reduce((sum, turn) => sum + turn.chars, 0),
    ...deliveryCapabilities(
      statusType,
      managed,
      typeof threadState?.activeTurnId === 'string',
    ),
  }
}

/**
 * Start a NEW managed session on the shared app-server: thread/start then
 * turn/start with the first message. The thread becomes managed and steerable.
 * This is the ONLY path that establishes a steerable managed session.
 */
export async function startManagedSession({
  client,
  cwd,
  input,
  model,
  reasoningEffort,
  logger,
}) {
  if (!client) throw new Error('startManagedSession: client is required')
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('startManagedSession: input is required')
  }
  const log = logger ?? { info() {}, warn() {} }
  const started = await client.threadStart({ cwd, model })
  const threadId = started?.thread?.id
  if (typeof threadId !== 'string') {
    throw new Error('startManagedSession: thread/start returned no thread id')
  }
  const turn = await client.turnStart({
    threadId,
    input: [{ type: 'text', text: input }],
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
    ...(cwd === undefined ? {} : { cwd }),
  })
  log.info?.(`codex managed session started: ${threadId} turn=${turn?.turn?.id}`)
  return {
    kind: 'managed_turn_started',
    threadId,
    turnId: typeof turn?.turn?.id === 'string' ? turn.turn.id : undefined,
    managed: true,
    steerable: true,
    status: 'active',
    delivery: 'active_managed',
  }
}

/**
 * Delivery capabilities for a thread given its authoritative wire status and
 * whether this plugin's app-server has loaded it (managed).
 * These are honest capabilities, never guesses from mtime.
 *
 * `canSteer` must be true ONLY when an active turn owned by this client is
 * actually known (an activeTurnId is tracked). An active_managed thread with
 * no known owned turn is NOT steerable.
 *
 * @param {string|undefined} statusType - wire ThreadStatus.type
 * @param {boolean} isManaged - whether this plugin's app-server loaded the thread
 * @param {boolean} [canSteer] - whether an owned active turn id is known
 *
 * @returns {{
 *   delivery: 'active_managed'|'idle_managed'|'external_or_idle'|'system_error',
 *   view: boolean,
 *   resume_unmanaged: boolean,
 *   steer: boolean,
 *   start_managed_turn: boolean,
 * }}
 */
export function deliveryCapabilities(statusType, isManaged, canSteer = false) {
  const delivery = classifyThreadStatus(statusType, isManaged)
  const isError = statusType === 'systemError'
  return {
    delivery,
    // Any stored thread can be read via thread/read without resuming.
    view: true,
    // Explicit `codex exec resume` is available except on errored threads —
    // sendMessage hard-refuses resume on systemError, so the capability must
    // not claim otherwise.
    resume_unmanaged: !isError,
    // Steer only ever applies to an active turn this plugin started AND whose
    // turn id is currently known.
    steer: delivery === 'active_managed' && canSteer,
    // An idle thread is already loaded; a new turn may be started on it when
    // managed. (Non-managed idle cannot occur with a private app-server.)
    start_managed_turn: statusType === 'idle' && isManaged,
  }
}

/**
 * Send a message to a session.
 *
 * @param {object} deps
 * @param {import('./app-server.js').AppServerClient} deps.client
 * @param {string} deps.threadId
 * @param {string} deps.input - plain-text user message.
 * @param {'auto'|'resume'} [deps.mode]
 *   - `auto` (default): act only on threads this plugin already manages —
 *     steer an active managed turn, start a new managed turn on an idle
 *     managed thread; everything else (including notLoaded) is refused.
 *     Managed sessions are established via `codex_session_start`; this tool
 *     never loads/owns a thread on its own.
 *   - `resume`: explicit unmanaged `codex exec resume` send, marked
 *     `may_be_concurrent: true` (may race another process). NEVER an automatic
 *     fallback of a failed steer.
 * @param {object} [deps.turnOverrides] - model / reasoningEffort:
 *   - `auto` + idle managed → forwarded to `turn/start`;
 *   - `resume` → forwarded to the provider start as codexOptions (fixed bypass
 *     is preserved);
 *   - `auto` + active managed (steer) → the protocol does not support model /
 *     reasoning overrides on `turn/steer`, so supplying either override here
 *     is REJECTED (never silently ignored, never a fallback).
 * @param {(threadId: string, input: string, overrides?: object) => Promise<object>} deps.resumeSender
 *   - invoked only for explicit `mode: 'resume'`; must return
 *   `{ ok: true, sessionId?, output? }` or throw. Receives turnOverrides so
 *   the caller can pass model/reasoning_effort into the provider start.
 *
 * @returns {Promise<object>} a delivery descriptor with an honest `kind`.
 */
export async function sendMessage({ client, threadId, input, mode = 'auto', turnOverrides, resumeSender }) {
  if (!client) throw new Error('sendMessage: client is required')
  if (typeof threadId !== 'string' || threadId.length === 0) {
    throw new Error('sendMessage: threadId is required')
  }
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('sendMessage: input is required')
  }
  if (mode !== 'auto' && mode !== 'resume') {
    throw new Error('sendMessage: mode must be "auto" or "resume"')
  }
  const hasOverrides =
    turnOverrides !== undefined &&
    (turnOverrides.model !== undefined || turnOverrides.reasoningEffort !== undefined)
  const textInput = [{ type: 'text', text: input }]

  // Read without resuming — this is the source of truth for status, for BOTH
  // modes. systemError is a hard failure even for explicit resume.
  const thread = await client.threadRead(threadId, { includeTurns: false })
  const statusType = thread.status?.type ?? 'notLoaded'
  const managed = client.isManaged(threadId)
  const state = client.threadState(threadId)

  if (statusType === 'systemError') {
    return {
      kind: 'failed_system_error',
      threadId,
      status: 'systemError',
      ...deliveryCapabilities(statusType, managed, false),
      reason: 'thread is in systemError — refusing to continue automatically (mode="resume" included)',
    }
  }

  // Explicit unmanaged resume is allowed from any non-error state, but is
  // never the automatic fallback of a failed steer.
  if (mode === 'resume') {
    if (typeof resumeSender !== 'function') {
      throw new Error('sendMessage: mode "resume" requires a resumeSender')
    }
    const outcome = await resumeSender(threadId, input, turnOverrides)
    return {
      kind: 'resume_unmanaged',
      threadId,
      may_be_concurrent: true,
      sessionId: outcome?.sessionId,
      output: outcome?.output ?? undefined,
    }
  }

  const startManagedTurn = async () => {
    const started = await client.turnStart({
      threadId,
      input: textInput,
      ...(turnOverrides?.model === undefined ? {} : { model: turnOverrides.model }),
      ...(turnOverrides?.reasoningEffort === undefined ? {} : { effort: turnOverrides.reasoningEffort }),
    })
    const turnId = started?.turn?.id
    return {
      kind: 'managed_turn_started',
      threadId,
      turnId: typeof turnId === 'string' ? turnId : undefined,
      status: 'idle',
      managed: true,
      steerable: true,
    }
  }

  switch (statusType) {
    case 'active': {
      if (!managed) {
        return {
          kind: 'refused_external_active',
          threadId,
          status: 'active',
          managed: false,
          ...deliveryCapabilities(statusType, false, false),
          reason:
            'active but not managed by this plugin — cannot steer. Use mode "resume" to send via codex exec resume (may_be_concurrent: true).',
        }
      }
      const activeTurnId = state?.activeTurnId
      if (typeof activeTurnId !== 'string') {
        return {
          kind: 'refused_active_no_turn',
          threadId,
          status: 'active',
          managed: true,
          ...deliveryCapabilities(statusType, true, false),
          reason:
            'active but no known active turn id — refusing to steer blindly. Use mode "resume" to send via codex exec resume.',
        }
      }
      // turn/steer does not accept model/reasoning overrides; reject them
      // explicitly instead of silently ignoring.
      if (hasOverrides) {
        return {
          kind: 'rejected_steer_overrides',
          threadId,
          status: 'active',
          managed: true,
          ...deliveryCapabilities(statusType, true, true),
          reason:
            'steer does not support model/reasoning_effort overrides — the in-flight turn keeps its settings. Remove the overrides to steer, or use mode "resume" for a new codex exec run.',
        }
      }
      // Steer requires the SAME app-server turn; expectedTurnId guards races.
      await client.turnSteer({ threadId, input: textInput, expectedTurnId: activeTurnId })
      return {
        kind: 'steered',
        threadId,
        turnId: activeTurnId,
        status: 'active',
        managed: true,
        ...deliveryCapabilities(statusType, true, true),
      }
    }
    case 'idle': {
      // `idle` means the thread is ALREADY loaded in this app-server — no
      // thread/resume is needed. A non-managed idle thread cannot occur with a
      // private app-server (we are the only client); refuse rather than guess.
      if (!managed) {
        return {
          kind: 'refused_idle_unmanaged',
          threadId,
          status: 'idle',
          managed: false,
          ...deliveryCapabilities(statusType, false, false),
          reason:
            'idle but not loaded by this plugin. Use codex_session_start to create a new managed session, or mode "resume" to send via codex exec resume (may_be_concurrent: true).',
        }
      }
      return startManagedTurn()
    }
    case 'notLoaded':
    default: {
      // notLoaded may be idle OR actively running in another Codex process.
      return {
        kind: 'refused_not_loaded',
        threadId,
        status: 'notLoaded',
        managed: false,
        ...deliveryCapabilities(statusType, false, false),
        reason:
          'session is not loaded by this plugin (it may be idle or actively running in another Codex process) — refusing to claim steer or host. Use mode "resume" to send via codex exec resume (may_be_concurrent: true).',
        may_be_concurrent: true,
      }
    }
  }
}
