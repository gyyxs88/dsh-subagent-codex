import assert from 'node:assert/strict'
import test from 'node:test'

import { AppServerClient, AppServerError, classifyThreadStatus, THREAD_STATUS } from '../lib/app-server.js'

/**
 * Build a controllable fake DSH-shaped subprocess handle driven by a script of
 * responses. Matches the real handle shape: `{ stdin, stdout, stderr,
 * collected, done, terminate, waitForExit }` — no 'exit' event, no kill().
 */
function makeFakeHandle() {
  const state = {
    argv: undefined,
    cwd: undefined,
    stdinWrites: [],
    terminated: false,
    doneResolve: undefined,
    stdoutHandler: undefined,
    stderrHandler: undefined,
  }
  const handle = {
    stdin: {
      write(line) {
        state.stdinWrites.push(line)
        return true
      },
    },
    stdout: {
      on(event, fn) {
        if (event === 'data') state.stdoutHandler = fn
      },
    },
    stderr: {
      on(event, fn) {
        if (event === 'data') state.stderrHandler = fn
      },
    },
    collected: {},
    done: new Promise((resolve) => {
      state.doneResolve = resolve
    }),
    terminate() {
      state.terminated = true
    },
    async waitForExit() {
      return true
    },
  }
  return { handle, state }
}

/** Spawn factory that records argv/cwd and returns the fake handle. */
function makeFakeSpawn() {
  const captured = { argv: undefined, cwd: undefined, handle: undefined, state: undefined }
  const spawn = (argv, opts) => {
    captured.argv = argv
    captured.cwd = opts?.cwd
    const { handle, state } = makeFakeHandle()
    captured.handle = handle
    captured.state = state
    return handle
  }
  return { spawn, captured }
}

/** Push one JSON line into the fake stdout stream. */
function feedLine(state, msg) {
  state.stdoutHandler(Buffer.from(JSON.stringify(msg) + '\n'))
}

test('ensureStarted spawns `codex app-server`, completes two-phase handshake', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const initPromise = client.ensureStarted()
  assert.ok(captured.argv)
  assert.deepEqual(captured.argv, ['node', 'codex.js', 'app-server'])
  const initWrite = captured.state.stdinWrites.find((line) => JSON.parse(line).method === 'initialize')
  assert.ok(initWrite, 'initialize request must be sent')
  assert.deepEqual(JSON.parse(initWrite).params.clientInfo, {
    name: 'dsh-subagent-codex',
    title: 'DeepSeek Harness Codex Subagent',
    version: '0.1.0',
  })
  feedLine(captured.state, { id: JSON.parse(initWrite).id, result: {} })
  await initPromise
  assert.equal(client.initialized, true)
  // Second half of the handshake: an `initialized` notification (no id) must
  // have been written to stdin after the initialize response.
  const ack = captured.state.stdinWrites
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .find((msg) => msg && msg.method === 'initialized' && msg.id === undefined)
  assert.ok(ack, 'initialized notification must be sent after initialize response')
})

test('server requests are answered explicitly, not treated as notifications', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  const initWrite = captured.state.stdinWrites.find((l) => JSON.parse(l).method === 'initialize')
  feedLine(captured.state, { id: JSON.parse(initWrite).id, result: {} })
  await init

  // A server-initiated request (id + method) must get an explicit error reply
  // and must NOT be routed as a notification or a response to our own calls.
  let notified = false
  client.onNotification(() => {
    notified = true
  })
  feedLine(captured.state, { id: 999, method: 'item/tool/requestUserInput', params: { threadId: 't1' } })
  const reply = captured.state.stdinWrites
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return undefined
      }
    })
    .find((m) => m && m.id === 999 && m.error)
  assert.ok(reply, 'server request must be answered with an error')
  assert.equal(reply.error.code, -32601)
  assert.equal(notified, false)
})

test('initialize failure tears down the child and rejects', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  const initWrite = captured.state.stdinWrites.find((l) => JSON.parse(l).method === 'initialize')
  feedLine(captured.state, { id: JSON.parse(initWrite).id, error: { code: -32603, message: 'boom' } })
  await assert.rejects(init, /boom/)
  assert.equal(captured.state.terminated, true)
  assert.equal(client.closed, true)
})

test('request/response correlation resolves the right promise', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p1 = client.request('thread/list', { limit: 5 })
  const p2 = client.request('thread/read', { threadId: 't1' })
  const writes = captured.state.stdinWrites.filter((w) => w.includes('thread/'))
  assert.equal(writes.length, 2)
  const id1 = JSON.parse(writes[0]).id
  const id2 = JSON.parse(writes[1]).id
  assert.notEqual(id1, id2)
  // Answer out of order.
  feedLine(captured.state, { id: id2, result: { thread: { id: 't1', status: { type: 'idle' } } } })
  feedLine(captured.state, { id: id1, result: { data: [{ id: 'a' }], nextCursor: null, backwardsCursor: null } })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.data[0].id, 'a')
  assert.equal(r2.thread.id, 't1')
})

test('JSON-RPC error rejects with AppServerError carrying code', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p = client.request('thread/read', { threadId: 't1' })
  const write = captured.state.stdinWrites.at(-1)
  feedLine(captured.state, {
    id: JSON.parse(write).id,
    error: { code: -32600, message: 'thread owned by another process' },
  })
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof AppServerError)
    assert.equal(err.code, -32600)
    assert.match(err.message, /thread owned by another process/)
    return true
  })
})

test('request timeout rejects and clears the pending slot', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', requestTimeoutMs: 20, logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p = client.request('thread/read', { threadId: 't1' })
  await assert.rejects(p, /timed out/)
})

test('child exit via done rejects all pending requests and marks closed', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', requestTimeoutMs: 5000, logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p1 = client.request('thread/read', { threadId: 't1' })
  const p2 = client.request('thread/list', {})
  const err1 = p1.catch((e) => e)
  const err2 = p2.catch((e) => e)
  // Resolve `done` as the real child would on exit.
  captured.state.doneResolve({ exitCode: 1, signal: null })
  // Give the microtask that chains from done.then a chance to run.
  await new Promise((r) => setTimeout(r, 10))
  assert.match(String((await err1).message), /exited/)
  assert.match(String((await err2).message), /exited/)
  assert.equal(client.closed, true)
  await assert.rejects(client.request('thread/list', {}), /closed/)
})

test('dispose terminates the child and rejects in-flight requests', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', requestTimeoutMs: 5000, logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p = client.request('thread/read', { threadId: 't1' })
  await client.dispose()
  assert.equal(captured.state.terminated, true)
  await assert.rejects(p, /disposed/)
})

test('thread/status/changed and turn notifications track managed state', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  // Unmanaged idle thread.
  feedLine(captured.state, { method: 'thread/status/changed', params: { threadId: 't1', status: { type: 'idle' } } })
  assert.equal(client.isManaged('t1'), false)
  assert.equal(classifyThreadStatus(client.threadState('t1')?.status, client.isManaged('t1')), 'external_or_idle')

  // A turn we started marks the thread managed + active + activeTurnId.
  const tp = client.turnStart({ threadId: 't1', input: [{ type: 'text', text: 'hi' }] })
  const write = captured.state.stdinWrites.at(-1)
  const req = JSON.parse(write)
  assert.equal(req.method, 'turn/start')
  assert.equal(req.params.approvalPolicy, 'never')
  assert.deepEqual(req.params.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.deepEqual(req.params.input, [{ type: 'text', text: 'hi' }])
  feedLine(captured.state, { id: req.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [], error: null } } })
  await tp
  assert.equal(client.isManaged('t1'), true)
  assert.equal(client.threadState('t1').activeTurnId, 'turn_1')
  assert.equal(classifyThreadStatus(client.threadState('t1').status, client.isManaged('t1')), 'active_managed')

  // turn/steer must carry expectedTurnId.
  const sp = client.turnSteer({ threadId: 't1', input: [{ type: 'text', text: 'more' }], expectedTurnId: 'turn_1' })
  const steerReq = JSON.parse(captured.state.stdinWrites.at(-1))
  assert.equal(steerReq.method, 'turn/steer')
  assert.equal(steerReq.params.expectedTurnId, 'turn_1')
  feedLine(captured.state, { id: steerReq.id, result: { turnId: 'turn_1' } })
  await sp

  // turn/completed notification clears active turn (notification carries threadId).
  feedLine(captured.state, { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn_1' } } })
  assert.equal(client.threadState('t1').activeTurnId, undefined)
})

test('classifyThreadStatus is honest about notLoaded and external active', () => {
  assert.equal(classifyThreadStatus('active', true), 'active_managed')
  assert.equal(classifyThreadStatus('idle', true), 'idle_managed')
  assert.equal(classifyThreadStatus('systemError', true), 'system_error')
  assert.equal(classifyThreadStatus('notLoaded', true), 'external_or_idle')
  assert.equal(classifyThreadStatus('active', false), 'external_or_idle')
  assert.equal(classifyThreadStatus('idle', false), 'external_or_idle')
  assert.equal(classifyThreadStatus(undefined, false), 'external_or_idle')
  assert.equal(THREAD_STATUS.NOT_LOADED, 'notLoaded')
})

test('threadStart creates a managed thread with fixed no-approval policy', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p = client.threadStart({ cwd: 'C:/ws', model: 'gpt-5.6-sol' })
  const req = JSON.parse(captured.state.stdinWrites.at(-1))
  assert.equal(req.method, 'thread/start')
  assert.equal(req.params.approvalPolicy, 'never')
  assert.equal(req.params.sandbox, 'danger-full-access')
  assert.equal(req.params.cwd, 'C:/ws')
  assert.equal(req.params.model, 'gpt-5.6-sol')
  feedLine(captured.state, {
    id: req.id,
    result: { thread: { id: 'thr_new', status: { type: 'idle' } } },
  })
  await p
  assert.equal(client.isManaged('thr_new'), true)
})

test('threadResume uses schema-correct fields (no effort, sandbox string)', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p = client.threadResume('thr_x', { model: 'gpt-5.6-sol' })
  const req = JSON.parse(captured.state.stdinWrites.at(-1))
  assert.equal(req.method, 'thread/resume')
  assert.equal(req.params.threadId, 'thr_x')
  assert.equal(req.params.approvalPolicy, 'never')
  assert.equal(req.params.sandbox, 'danger-full-access')
  assert.ok(!('effort' in req.params), 'thread/resume must not carry effort')
  assert.ok(!('sandboxPolicy' in req.params), 'thread/resume uses sandbox, not sandboxPolicy')
  feedLine(captured.state, { id: req.id, result: { thread: { id: 'thr_x', status: { type: 'idle' } } } })
  await p
  assert.equal(client.isManaged('thr_x'), true)
})

test('turnSteer refuses turns this plugin did not start', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  // A turn/started notification for a turn we did NOT create must not make it
  // steerable (e.g. a review/compact turn created elsewhere).
  feedLine(captured.state, { method: 'turn/started', params: { threadId: 't1', turn: { id: 'foreign_turn' } } })
  await assert.rejects(
    client.turnSteer({ threadId: 't1', input: [{ type: 'text', text: 'x' }], expectedTurnId: 'foreign_turn' }),
    /did not start/,
  )
})

test('stale turn/completed does not downgrade a newer active turn', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p = client.turnStart({ threadId: 't1', input: [{ type: 'text', text: 'hi' }] })
  const req = JSON.parse(captured.state.stdinWrites.at(-1))
  feedLine(captured.state, { id: req.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } })
  await p

  // Old turn's completion arrives late; the active turn must stay active.
  feedLine(captured.state, { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn_0' } } })
  assert.equal(client.threadState('t1').activeTurnId, 'turn_1')

  // Matching completion clears it.
  feedLine(captured.state, { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn_1' } } })
  assert.equal(client.threadState('t1').activeTurnId, undefined)
})

test('completed owned turns are dropped from the steerable set (no unbounded growth)', async () => {
  const { spawn, captured } = makeFakeSpawn()
  const client = new AppServerClient({ spawn, node: 'node', js: 'codex.js', logger: { info() {}, warn() {} } })
  const init = client.ensureStarted()
  feedLine(captured.state, { id: 1, result: {} })
  await init

  const p = client.turnStart({ threadId: 't1', input: [{ type: 'text', text: 'hi' }] })
  const req = JSON.parse(captured.state.stdinWrites.at(-1))
  feedLine(captured.state, { id: req.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } })
  await p

  // Steer works while the turn is owned/active.
  const sp = client.turnSteer({ threadId: 't1', input: [{ type: 'text', text: 'more' }], expectedTurnId: 'turn_1' })
  feedLine(captured.state, { id: JSON.parse(captured.state.stdinWrites.at(-1)).id, result: { turnId: 'turn_1' } })
  await sp

  // Completion removes it from the owned set; a later steer is refused.
  feedLine(captured.state, { method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn_1' } } })
  await assert.rejects(
    client.turnSteer({ threadId: 't1', input: [{ type: 'text', text: 'late' }], expectedTurnId: 'turn_1' }),
    /did not start/,
  )
  assert.equal(client.threadState('t1').activeTurnId, undefined)
})
