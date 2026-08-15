import assert from 'node:assert/strict'
import test from 'node:test'

import { codexExecArgv, codexExecResumeArgv, codexInvocationArgs, CODEX_FIXED_SANDBOX_ARGV } from '../lib/index.js'
import { apply as applyCodexTool, buildCodexStartRequest } from '../lib/tool.js'

const BYPASS = '--dangerously-bypass-approvals-and-sandbox'

test('omitted per-call options keep Codex CLI defaults', () => {
  assert.deepEqual(codexInvocationArgs({}), [])
})

test('model and reasoning effort become separate safe argv entries', () => {
  assert.deepEqual(
    codexInvocationArgs({ codexOptions: { model: ' gpt-5.6-sol ', reasoningEffort: 'xhigh' } }),
    ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"'],
  )
})

test('tool request carries per-call overrides to the provider', () => {
  const parent = { id: 'parent' }
  assert.deepEqual(
    buildCodexStartRequest(
      {
        description: 'focused check',
        prompt: 'Reply with ok.',
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
      },
      { maxDepth: 'provider-managed' },
      parent,
    ),
    {
      label: 'focused check',
      prompt: [{ type: 'text', text: 'Reply with ok.' }],
      parent,
      agentOptions: { model: 'gpt-5.6-sol' },
      codexOptions: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    },
  )
})

test('resume_session_id is forwarded to the provider request', () => {
  const parent = { id: 'parent' }
  const request = buildCodexStartRequest(
    {
      description: 'continue work',
      prompt: 'Keep going.',
      resume_session_id: '  thr_abc  ',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
    },
    { maxDepth: 'provider-managed' },
    parent,
  )
  assert.equal(request.resumeSessionId, 'thr_abc')
  assert.equal(request.codexOptions.model, 'gpt-5.6-sol')
})

test('resume argv runs codex exec resume with fixed bypass and per-call args', () => {
  const argv = codexExecResumeArgv({
    node: 'node',
    js: 'codex.js',
    sessionId: 'thr_abc',
    request: { codexOptions: { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' } },
  })
  assert.deepEqual(argv, [
    'node',
    'codex.js',
    'exec',
    'resume',
    'thr_abc',
    '-',
    '--json',
    '--skip-git-repo-check',
    '-m',
    'gpt-5.6-sol',
    '-c',
    'model_reasoning_effort="xhigh"',
    BYPASS,
  ])
  assert.equal(argv.filter((a) => a === BYPASS).length, 1)
})

test('resume argv rejects an empty session id', () => {
  assert.throws(
    () => codexExecResumeArgv({ node: 'node', js: 'codex.js', sessionId: '', request: {} }),
    /non-empty session id/,
  )
})

test('fresh exec argv is unchanged by resume fields', () => {
  const argv = codexExecArgv({ node: 'node', js: 'codex.js', cwd: 'C:/ws', request: {} })
  assert.equal(argv.filter((a) => a === BYPASS).length, 1)
  assert.deepEqual(CODEX_FIXED_SANDBOX_ARGV, [BYPASS])
})

test('invalid direct provider effort is rejected', () => {
  assert.throws(
    () => codexInvocationArgs({ codexOptions: { reasoningEffort: 'impossible' } }),
    /reasoning effort must be one of/u,
  )
})

test('registered tool exposes and forwards per-call selection', async () => {
  let definitions = new Map()
  let started
  const parent = { id: 'parent' }
  const provider = {
    name: 'codex',
    capabilities: { depthLimit: false },
    inheritsParentContext: false,
  }
  const ctx = {
    tools: {
      register(value) {
        definitions.set(value.name, value)
        return () => {}
      },
    },
    subagents: {
      getProvider: () => provider,
      async start(_name, request) {
        started = request
        return {
          id: 'run-1',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
          async dispose() {},
        }
      },
    },
    on() {},
    get() {
      return undefined
    },
    logger: { info() {} },
  }

  applyCodexTool(ctx, {
    provider: 'codex',
    toolName: 'subagent_codex',
    enableRunInBackground: true,
    maxDepth: 'provider-managed',
  })

  const definition = definitions.get('subagent_codex')
  assert.ok(definition, 'subagent_codex tool must be registered')
  assert.deepEqual(definition.parameters.properties.reasoning_effort.enum, [
    'low',
    'medium',
    'high',
    'xhigh',
    'ultra',
    'max',
  ])
  // Session tools are registered too.
  assert.ok(definitions.has('codex_sessions_list'))
  assert.ok(definitions.has('codex_session_read'))
  assert.ok(definitions.has('codex_session_send'))
  const result = await definition.execute(
    {
      description: 'focused check',
      prompt: 'Reply with ok.',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'medium',
    },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.equal(result.kind, 'foreground')
  assert.deepEqual(started.codexOptions, {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  })
})
