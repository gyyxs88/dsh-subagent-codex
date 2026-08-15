import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply as applyCodexTool } from '../lib/tool.js'

/** Temp dirs created by makeCtx, cleaned up in test.after. */
const contexts = []

/**
 * Assemble the tool plugin with a fake ctx whose subprocess service can be
 * scripted. No real app-server process is ever spawned; the codex shim layout
 * is materialized in a temp dir so fs.existsSync discovery succeeds.
 *
 * `state.spawnBehaviors` is a queue of behavior descriptors consumed per
 * spawn: `'fail'` throws, `'hang'` returns a handle that never answers
 * initialize (timeout), `'ok'` returns a handle that answers initialize
 * (id 1) and then answers thread/list with an empty page.
 */
function makeCtx(overrides = {}) {
  // Materialize `.../bin/codex.cmd` + `.../bin/node_modules/@openai/codex/bin/codex.js`
  // (tool.js derives the codex.js path from the shim's directory).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-test-'))
  const binDir = path.join(tmp, 'bin')
  const jsDir = path.join(binDir, 'node_modules', '@openai', 'codex', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(jsDir, { recursive: true })
  const shim = path.join(binDir, 'codex.cmd')
  fs.writeFileSync(shim, '@echo off\n')
  fs.writeFileSync(path.join(jsDir, 'codex.js'), '// fake\n')

  const state = {
    spawnCount: 0,
    spawnBehaviors: [], // queue of 'fail' | 'hang' | 'ok'
    resolveExecutableCalls: [],
    toolNames: [],
    registered: new Map(),
    terminated: 0,
    tmp,
  }

  const makeHandle = (mode) => {
    let stdoutDataHandler
    const handle = {
      stdin: {
        write(line) {
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            return true
          }
          if (msg.id === undefined || typeof msg.method !== 'string') return true
          // Respond synchronously from the request line; the client's stdout
          // data handler is wired up once ensureStarted attaches it.
          if (typeof stdoutDataHandler !== 'function') return true
          const respond = (result) => {
            stdoutDataHandler(Buffer.from(JSON.stringify({ id: msg.id, result }) + '\n'))
          }
          if (msg.method === 'initialize') respond({})
          else if (msg.method === 'thread/list') respond({ data: [], nextCursor: null, backwardsCursor: null })
          else respond({})
          return true
        },
      },
      stdout: {
        on(event, fn) {
          if (event === 'data') stdoutDataHandler = fn
        },
      },
      stderr: { on() {} },
      collected: {},
      done: new Promise(() => {}),
      terminate() {
        state.terminated++
      },
      async waitForExit() {},
    }
    if (mode === 'hang') {
      // Never respond to any request.
      handle.stdout.on = (event, fn) => {
        if (event === 'data') stdoutDataHandler = fn
      }
      handle.stdin.write = () => true
    }
    return handle
  }

  const ctx = {
    tools: {
      register(value) {
        state.toolNames.push(value.name)
        state.registered.set(value.name, value)
        return () => {}
      },
    },
    subagents: {
      getProvider: () => ({
        name: 'codex',
        capabilities: { depthLimit: false },
        inheritsParentContext: false,
      }),
      async start() {
        return {
          id: 'run',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
          async dispose() {},
        }
      },
    },
    subprocess: {
      async resolveExecutable(name) {
        state.resolveExecutableCalls.push(name)
        if (name === 'node') return 'C:/fake/node.exe'
        return shim
      },
      spawn(spec) {
        state.spawnCount++
        const mode = state.spawnBehaviors.shift() ?? 'ok'
        if (mode === 'fail') throw new Error('spawn failed: boom')
        if (mode === 'hang') return makeHandle('hang')
        return makeHandle('ok')
      },
    },
    on() {},
    get() {
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  }
  contexts.push({ state })
  return { ctx, state }
}

test('session tools are registered alongside subagent_codex', () => {
  const { ctx, state } = makeCtx()
  applyCodexTool(ctx, {})
  for (const n of [
    'subagent_codex',
    'codex_sessions_list',
    'codex_session_read',
    'codex_session_start',
    'codex_session_send',
  ]) {
    assert.ok(state.toolNames.includes(n), `${n} must be registered`)
  }
})

test('getAppServer spawn failure disposes the broken client so the next call retries', async () => {
  const { ctx, state } = makeCtx()
  applyCodexTool(ctx, { appServerRequestTimeoutMs: 50 })

  const listTool = state.registered.get('codex_sessions_list')
  const exec = { agent: { id: 'agent', session: { header: { cwd: 'C:/ws' } } }, signal: new AbortController().signal }

  // First call fails during spawn.
  state.spawnBehaviors.push('fail')
  await assert.rejects(listTool.execute({}, exec), /spawn failed/)

  // Second call must spawn a fresh attempt (client was disposed + cleared).
  state.spawnBehaviors.push('ok')
  const result = await listTool.execute({}, exec)
  assert.equal(state.spawnCount, 2, 'a fresh app-server spawn must be attempted')
  assert.ok(Array.isArray(result.threads))
  // No child process existed when spawn threw, so nothing needed terminating —
  // the important guarantee is that the broken client was cleared and a fresh
  // one was created on the next call (spawnCount === 2).
})

test('ensureStarted failure disposes the client and allows a retry', async () => {
  const { ctx, state } = makeCtx()
  applyCodexTool(ctx, { appServerRequestTimeoutMs: 50 })

  const listTool = state.registered.get('codex_sessions_list')
  const exec = { agent: { id: 'agent', session: { header: { cwd: 'C:/ws' } } }, signal: new AbortController().signal }

  // First call: spawn OK but initialize hangs → request times out.
  state.spawnBehaviors.push('hang')
  await assert.rejects(listTool.execute({}, exec), /timed out/)

  // Second call must succeed with a fresh client.
  state.spawnBehaviors.push('ok')
  const result = await listTool.execute({}, exec)
  assert.ok(Array.isArray(result.threads))
  assert.ok(state.terminated >= 1, 'the failed client must have been disposed')
  assert.ok(state.spawnCount >= 2, 'a fresh app-server spawn must be attempted')
})

test.after(() => {
  for (const { state } of contexts) {
    if (state.tmp) {
      try {
        fs.rmSync(state.tmp, { recursive: true, force: true })
      } catch {}
    }
  }
})
