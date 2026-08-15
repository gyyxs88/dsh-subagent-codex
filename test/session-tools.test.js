import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyThreadStatus, deliveryCapabilities, listSessions, readSession, sendMessage, startManagedSession, summarizeThread, truncate } from '../lib/session-tools.js'

/** Fake AppServerClient-shaped object with scriptable responses. */
function makeFakeClient(overrides = {}) {
  const calls = []
  const state = { managed: new Set(), threadStates: new Map() }
  const client = {
    calls,
    threadList: async (params) => {
      calls.push(['threadList', params])
      if (overrides.threadList) return overrides.threadList(params)
      return { threads: [], nextCursor: null, backwardsCursor: null }
    },
    threadRead: async (threadId, opts) => {
      calls.push(['threadRead', threadId, opts])
      if (overrides.threadRead) return overrides.threadRead(threadId, opts)
      return { id: threadId, status: { type: 'notLoaded' }, turns: [] }
    },
    threadStart: async (params) => {
      calls.push(['threadStart', params])
      if (overrides.threadStart) return overrides.threadStart(params)
      return { thread: { id: 'thr_new', status: { type: 'idle' } } }
    },
    threadResume: async (threadId, opts) => {
      calls.push(['threadResume', threadId, opts])
      if (overrides.threadResume) return overrides.threadResume(threadId, opts)
      return { thread: { id: threadId, status: { type: 'idle' } } }
    },
    turnStart: async (params) => {
      calls.push(['turnStart', params])
      if (overrides.turnStart) return overrides.turnStart(params)
      return { turn: { id: 'turn-x', status: 'inProgress' } }
    },
    turnSteer: async (params) => {
      calls.push(['turnSteer', params])
      if (overrides.turnSteer) return overrides.turnSteer(params)
      return { turnId: params.expectedTurnId }
    },
    isManaged: (threadId) => state.managed.has(threadId),
    threadState: (threadId) => state.threadStates.get(threadId),
    _markManaged(threadId) {
      state.managed.add(threadId)
    },
    _markActive(threadId, turnId) {
      state.threadStates.set(threadId, { status: 'active', activeTurnId: turnId, managed: true })
      state.managed.add(threadId)
    },
  }
  return client
}

test('truncate caps text and marks truncation', () => {
  assert.equal(truncate('short', 100), 'short')
  const long = 'x'.repeat(300)
  const out = truncate(long, 100)
  assert.equal(out.length, 100 + '…[truncated]'.length)
  assert.match(out, /…\[truncated\]$/)
})

test('summarizeThread bounds fields and drops junk', () => {
  const s = summarizeThread({
    id: 'thr_1',
    preview: 'p'.repeat(500),
    cwd: 'C:/ws',
    sourceKind: 'appServer',
    status: { type: 'active', activeFlags: [] },
    updatedAt: 123,
  })
  assert.equal(s.id, 'thr_1')
  assert.equal(s.preview.length, 200 + '…[truncated]'.length)
  assert.equal(s.status, 'active')
  assert.deepEqual(s.activeFlags, [])
  assert.equal(summarizeThread(null), undefined)
})

test('listSessions filters by cwd by default and honors includeAll', async () => {
  const client = makeFakeClient({
    threadList: async (params) => ({
      threads: [
        { id: 'a', preview: 'A', cwd: 'C:/ws', status: { type: 'idle' } },
        { id: 'b', preview: 'B', cwd: 'D:/other', status: { type: 'notLoaded' } },
      ],
      nextCursor: 'cur',
      backwardsCursor: null,
    }),
  })
  client._markManaged('a')
  const filtered = await listSessions({ client, cwd: 'C:/ws', includeAll: false })
  // session-tools passes through to client.threadList; the client layer adds
  // sortKey/sourceKinds defaults (see app-server.test.js).
  assert.deepEqual(client.calls[0][1], { cwd: 'C:/ws', limit: 50 })
  assert.equal(filtered.cwd, 'C:/ws')
  assert.equal(filtered.includeAll, false)
  assert.equal(filtered.truncated, true)
  // Honest delivery + capabilities per row.
  assert.equal(filtered.threads[0].delivery, 'idle_managed')
  assert.equal(filtered.threads[0].steer, false)
  assert.equal(filtered.threads[0].start_managed_turn, true)
  assert.equal(filtered.threads[0].resume_unmanaged, true)
  assert.equal(filtered.threads[1].delivery, 'external_or_idle')
  assert.equal(filtered.threads[1].steer, false)

  const all = await listSessions({ client, cwd: 'C:/ws', includeAll: true })
  assert.equal(all.includeAll, true)
  assert.equal(all.cwd, undefined)
  assert.ok(!('cwd' in client.calls[1][1]), 'no cwd filter when includeAll')
})

test('listSessions steer reflects known owned activeTurnId from client state', async () => {
  const client = makeFakeClient({
    threadList: async () => ({
      threads: [
        { id: 'active_with_turn', status: { type: 'active' } },
        { id: 'active_no_turn', status: { type: 'active' } },
      ],
      nextCursor: null,
      backwardsCursor: null,
    }),
  })
  client._markActive('active_with_turn', 'turn_1')
  client._markManaged('active_no_turn')
  const result = await listSessions({ client, cwd: 'C:/ws' })
  const withTurn = result.threads.find((t) => t.id === 'active_with_turn')
  const noTurn = result.threads.find((t) => t.id === 'active_no_turn')
  assert.equal(withTurn.delivery, 'active_managed')
  assert.equal(withTurn.steer, true)
  assert.equal(noTurn.delivery, 'active_managed')
  assert.equal(noTurn.steer, false, 'active_managed without known turn must not claim steer')
})

test('readSession steer reflects known owned activeTurnId from client state', async () => {
  const client = makeFakeClient()
  client._markActive('t1', 'turn_1')
  client.threadRead = async () => ({ id: 't1', status: { type: 'active' }, turns: [] })
  const result = await readSession({ client, threadId: 't1' })
  assert.equal(result.delivery, 'active_managed')
  assert.equal(result.steer, true)

  const client2 = makeFakeClient()
  client2._markManaged('t2')
  client2.threadRead = async () => ({ id: 't2', status: { type: 'active' }, turns: [] })
  const result2 = await readSession({ client: client2, threadId: 't2' })
  assert.equal(result2.delivery, 'active_managed')
  assert.equal(result2.steer, false, 'active_managed without known turn must not claim steer')
})

test('readSession returns bounded history with delivery capabilities', async () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({
    id: `turn_${i}`,
    items: [{ type: 'userMessage', content: [{ type: 'text', text: `msg ${i}` }] }],
  }))
  const client = makeFakeClient({
    threadRead: async () => ({ id: 't1', status: { type: 'idle' }, turns }),
  })
  client._markManaged('t1')
  const result = await readSession({ client, threadId: 't1', maxTurns: 5, maxChars: 1000 })
  assert.equal(result.turns.length, 5)
  assert.equal(result.truncated, true)
  assert.ok(result.chars <= 1000, `chars ${result.chars} must fit the global budget`)
  assert.equal(client.calls[0][0], 'threadRead')
  assert.equal(result.delivery, 'idle_managed')
  assert.equal(result.view, true)
  assert.equal(result.resume_unmanaged, true)
  assert.equal(result.steer, false)
})

test('readSession honors a GLOBAL char budget across all turns, newest first', async () => {
  // 10 turns, each ~100 chars; budget 250 fits newest 2 fully + truncates the 3rd.
  const turns = Array.from({ length: 10 }, (_, i) => ({
    id: `turn_${i}`,
    items: [{ type: 'userMessage', content: [{ type: 'text', text: `X`.repeat(100) }] }],
  }))
  const client = makeFakeClient({
    threadRead: async () => ({ id: 't1', status: { type: 'idle' }, turns }),
  })
  const result = await readSession({ client, threadId: 't1', maxTurns: 20, maxChars: 250 })
  const totalChars = result.turns.reduce((s, t) => s + t.chars, 0)
  assert.ok(totalChars <= 250, `total chars ${totalChars} must not exceed budget`)
  assert.ok(result.turns.length >= 2)
  assert.equal(result.truncated, true, 'char budget exhaustion must set truncated')
  // The newest turn is present; older turns beyond budget are dropped.
  assert.equal(result.turns[result.turns.length - 1].id, 'turn_9')
  assert.ok(result.turns.length < 10)
})

test('readSession keeps newest turns even when total chars exceed budget', async () => {
  // 5 turns of 50 chars each; budget 90 → newest 1 full + up to 90 chars total.
  const turns = Array.from({ length: 5 }, (_, i) => ({
    id: `turn_${i}`,
    items: [{ type: 'agentMessage', text: `Y`.repeat(50) }],
  }))
  const client = makeFakeClient({
    threadRead: async () => ({ id: 't1', status: { type: 'idle' }, turns }),
  })
  const result = await readSession({ client, threadId: 't1', maxTurns: 5, maxChars: 90 })
  const totalChars = result.turns.reduce((s, t) => s + t.chars, 0)
  assert.ok(totalChars <= 90, `total chars ${totalChars} must not exceed budget`)
  assert.equal(result.turns[result.turns.length - 1].id, 'turn_4')
  assert.equal(result.truncated, true)
})

test('readSession truncation marker counts toward the budget', async () => {
  // One turn of 100 chars, budget 60 → marker must fit inside the budget.
  const turns = [
    { id: 'turn_0', items: [{ type: 'agentMessage', text: `Z`.repeat(100) }] },
  ]
  const client = makeFakeClient({
    threadRead: async () => ({ id: 't1', status: { type: 'idle' }, turns }),
  })
  const result = await readSession({ client, threadId: 't1', maxTurns: 5, maxChars: 60 })
  const totalChars = result.turns.reduce((s, t) => s + t.chars, 0)
  assert.ok(totalChars <= 60, `total chars ${totalChars} must not exceed budget even with marker`)
  assert.match(result.turns[0].text, /…\[truncated\]$/)
  assert.equal(result.truncated, true)
})

test('deliveryCapabilities only allows steer on active_managed WITH a known owned turn', () => {
  // active_managed without canSteer → steer must be false.
  assert.deepEqual(deliveryCapabilities('active', true, false), {
    delivery: 'active_managed',
    view: true,
    resume_unmanaged: true,
    steer: false,
    start_managed_turn: false,
  })
  // active_managed with a known owned turn → steer true.
  assert.deepEqual(deliveryCapabilities('active', true, true), {
    delivery: 'active_managed',
    view: true,
    resume_unmanaged: true,
    steer: true,
    start_managed_turn: false,
  })
  assert.deepEqual(deliveryCapabilities('notLoaded', false).delivery, 'external_or_idle')
  assert.equal(deliveryCapabilities('notLoaded', false).steer, false)
  assert.equal(deliveryCapabilities('notLoaded', false).start_managed_turn, false)
  assert.equal(deliveryCapabilities('idle', false).start_managed_turn, false)
  assert.equal(deliveryCapabilities('idle', true).start_managed_turn, true)
  // active unmanaged never steerable even with canSteer.
  assert.equal(deliveryCapabilities('active', false, true).steer, false)
  assert.equal(deliveryCapabilities('active', false, true).delivery, 'external_or_idle')
})

test('deliveryCapabilities systemError forbids resume_unmanaged', () => {
  const caps = deliveryCapabilities('systemError', true)
  assert.equal(caps.delivery, 'system_error')
  assert.equal(caps.resume_unmanaged, false)
  assert.equal(caps.steer, false)
  assert.equal(caps.start_managed_turn, false)
})

test('sendMessage steers an active managed turn with expectedTurnId', async () => {
  const client = makeFakeClient()
  client._markActive('t1', 'turn_1')
  client.threadRead = async () => ({ id: 't1', status: { type: 'active' }, turns: [] })
  const result = await sendMessage({ client, threadId: 't1', input: 'focus on tests' })
  assert.equal(result.kind, 'steered')
  assert.equal(result.turnId, 'turn_1')
  const [, params] = client.calls.find(([m]) => m === 'turnSteer')
  assert.equal(params.expectedTurnId, 'turn_1')
  assert.deepEqual(params.input, [{ type: 'text', text: 'focus on tests' }])
})

test('sendMessage starts a managed turn on an idle managed thread', async () => {
  const client = makeFakeClient()
  client._markManaged('t1')
  // Override threadRead to report idle managed.
  client.threadRead = async () => ({ id: 't1', status: { type: 'idle' }, turns: [] })
  const result = await sendMessage({
    client,
    threadId: 't1',
    input: 'continue',
    turnOverrides: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  })
  assert.equal(result.kind, 'managed_turn_started')
  const [, params] = client.calls.find(([m]) => m === 'turnStart')
  assert.equal(params.model, 'gpt-5.6-sol')
  assert.equal(params.effort, 'high')
  // approvalPolicy/sandboxPolicy are added by AppServerClient.turnStart, not
  // here — see app-server.test.js for the fixed no-approval/no-sandbox check.
})

test('sendMessage refuses notLoaded unless explicit resume, and never auto-resumes', async () => {
  const client = makeFakeClient()
  const refused = await sendMessage({ client, threadId: 't1', input: 'hi' })
  assert.equal(refused.kind, 'refused_not_loaded')
  assert.equal(refused.may_be_concurrent, true)
  assert.ok(!client.calls.some(([m]) => m === 'turnSteer' || m === 'turnStart'))
  assert.ok(!client.calls.some(([m]) => m === 'turnSteer' || m === 'turnStart'))

  // Explicit mode:resume sends via the resume sender and is marked concurrent.
  let resumed = false
  const result = await sendMessage({
    client,
    threadId: 't1',
    input: 'hi',
    mode: 'resume',
    resumeSender: async () => {
      resumed = true
      return { sessionId: 's1', output: 'done' }
    },
  })
  assert.equal(result.kind, 'resume_unmanaged')
  assert.equal(result.may_be_concurrent, true)
  assert.equal(result.sessionId, 's1')
  assert.equal(resumed, true)
})

test('sendMessage refuses active but unmanaged thread (external process)', async () => {
  const client = makeFakeClient()
  client.threadRead = async () => ({ id: 't1', status: { type: 'active' }, turns: [] })
  const result = await sendMessage({ client, threadId: 't1', input: 'hi' })
  assert.equal(result.kind, 'refused_external_active')
  assert.equal(result.managed, false)
  assert.ok(!client.calls.some(([m]) => m === 'turnSteer'))
})

test('sendMessage fails hard on systemError for auto AND resume', async () => {
  const client = makeFakeClient()
  client.threadRead = async () => ({ id: 't1', status: { type: 'systemError' }, turns: [] })
  let resumed = 0
  const resumeSender = async () => {
    resumed++
    return { sessionId: 's1', output: 'x' }
  }
  const auto = await sendMessage({ client, threadId: 't1', input: 'hi' })
  assert.equal(auto.kind, 'failed_system_error')
  assert.equal(auto.delivery, 'system_error')
  assert.equal(auto.resume_unmanaged, false, 'systemError must not claim resume capability')
  assert.equal(auto.steer, false)
  assert.ok(!client.calls.some(([m]) => m === 'turnStart' || m === 'turnSteer'))

  const explicit = await sendMessage({ client, threadId: 't1', input: 'hi', mode: 'resume', resumeSender })
  assert.equal(explicit.kind, 'failed_system_error')
  assert.equal(explicit.resume_unmanaged, false)
  assert.equal(resumed, 0, 'resumeSender must never run on systemError')
})

test('sendMessage rejects model/reasoning overrides on steer (no silent ignore, no fallback)', async () => {
  const client = makeFakeClient()
  client._markActive('t1', 'turn_1')
  client.threadRead = async () => ({ id: 't1', status: { type: 'active' }, turns: [] })
  const result = await sendMessage({
    client,
    threadId: 't1',
    input: 'more',
    turnOverrides: { model: 'gpt-5.6-sol' },
  })
  assert.equal(result.kind, 'rejected_steer_overrides')
  assert.ok(!client.calls.some(([m]) => m === 'turnSteer'), 'steer must not be attempted')
  assert.ok(!client.calls.some(([m]) => m === 'threadResume'), 'no fallback to resume')
  assert.ok(!client.calls.some(([m]) => m === 'turnStart'), 'no fallback to turn/start')
})

test('sendMessage refused_active_no_turn reports steer:false; steered reports steer:true', async () => {
  // active managed but no known turn id → refused, steer:false.
  const client = makeFakeClient()
  client._markManaged('t1')
  client.threadRead = async () => ({ id: 't1', status: { type: 'active' }, turns: [] })
  const refused = await sendMessage({ client, threadId: 't1', input: 'hi' })
  assert.equal(refused.kind, 'refused_active_no_turn')
  assert.equal(refused.delivery, 'active_managed')
  assert.equal(refused.steer, false, 'must not claim steer without a known owned turn')

  // active managed with known owned turn → steered, steer:true.
  const client2 = makeFakeClient()
  client2._markActive('t2', 'turn_2')
  client2.threadRead = async () => ({ id: 't2', status: { type: 'active' }, turns: [] })
  const steered = await sendMessage({ client: client2, threadId: 't2', input: 'go' })
  assert.equal(steered.kind, 'steered')
  assert.equal(steered.steer, true)
})

test('sendMessage passes overrides to resumeSender for mode=resume', async () => {
  const client = makeFakeClient()
  let received
  const resumeSender = async (_threadId, _input, overrides) => {
    received = overrides
    return { sessionId: 's1', output: 'done' }
  }
  const result = await sendMessage({
    client,
    threadId: 't1',
    input: 'hi',
    mode: 'resume',
    turnOverrides: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    resumeSender,
  })
  assert.equal(result.kind, 'resume_unmanaged')
  assert.equal(result.may_be_concurrent, true)
  assert.deepEqual(received, { model: 'gpt-5.6-sol', reasoningEffort: 'high' })
})

test('startManagedSession creates a managed steerable session (thread/start then turn/start)', async () => {
  const client = makeFakeClient()
  const result = await startManagedSession({
    client,
    cwd: 'C:/ws',
    input: 'hello',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  })
  assert.equal(result.kind, 'managed_turn_started')
  assert.equal(result.threadId, 'thr_new')
  assert.equal(result.steerable, true)
  assert.equal(result.delivery, 'active_managed')
  const methods = client.calls.map(([m]) => m)
  assert.deepEqual(methods, ['threadStart', 'turnStart'])
  const startIdx = methods.indexOf('threadStart')
  const turnIdx = methods.indexOf('turnStart')
  assert.ok(startIdx < turnIdx, 'thread/start precedes turn/start')
  const turnParams = client.calls.find(([m]) => m === 'turnStart')[1]
  assert.equal(turnParams.model, 'gpt-5.6-sol')
  assert.equal(turnParams.effort, 'high')
  assert.deepEqual(turnParams.input, [{ type: 'text', text: 'hello' }])
  const startParams = client.calls.find(([m]) => m === 'threadStart')[1]
  assert.equal(startParams.cwd, 'C:/ws')
})

test('startManagedSession requires input', async () => {
  const client = makeFakeClient()
  await assert.rejects(
    startManagedSession({ client, cwd: 'C:/ws', input: '   ' }),
    /input is required/,
  )
})

test('sendMessage never calls thread/resume (no adopt path exists)', async () => {
  const client = makeFakeClient()
  // Default threadRead returns notLoaded; sendMessage must refuse and never
  // attempt to load/own the thread.
  const result = await sendMessage({ client, threadId: 't1', input: 'hi' })
  assert.equal(result.kind, 'refused_not_loaded')
  assert.equal(result.may_be_concurrent, true)
  assert.ok(!client.calls.some(([m]) => m === 'threadResume'))
  assert.ok(!client.calls.some(([m]) => m === 'threadStart'))
  assert.ok(!client.calls.some(([m]) => m === 'turnStart'))
})

test('sendMessage rejects invalid mode values', async () => {
  const client = makeFakeClient()
  await assert.rejects(
    sendMessage({ client, threadId: 't1', input: 'hi', mode: 'managed' }),
    /mode must be "auto" or "resume"/,
  )
})

test('sendMessage refuses active unmanaged thread', async () => {
  const client = makeFakeClient()
  client.threadRead = async () => ({ id: 't1', status: { type: 'active' }, turns: [] })
  const result = await sendMessage({ client, threadId: 't1', input: 'hi' })
  assert.equal(result.kind, 'refused_external_active')
  assert.ok(!client.calls.some(([m]) => m === 'turnSteer'))
})

test('a failed steer is NOT auto-fallen back to resume', async () => {
  const client = makeFakeClient()
  client._markActive('t1', 'turn_1')
  client.threadRead = async () => ({ id: 't1', status: { type: 'active' }, turns: [] })
  client.turnSteer = async () => {
    throw new Error('expectedTurnId mismatch — active turn changed')
  }
  await assert.rejects(
    sendMessage({ client, threadId: 't1', input: 'more' }),
    /expectedTurnId mismatch/,
  )
  assert.ok(!client.calls.some(([m]) => m === 'threadResume'))
  assert.equal(classifyThreadStatus('active', true), 'active_managed')
})
