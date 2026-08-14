import assert from 'node:assert/strict'
import test from 'node:test'

import { codexInvocationArgs } from '../lib/index.js'
import { apply as applyCodexTool, buildCodexStartRequest } from '../lib/tool.js'

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

test('invalid direct provider effort is rejected', () => {
  assert.throws(
    () => codexInvocationArgs({ codexOptions: { reasoningEffort: 'impossible' } }),
    /reasoning effort must be one of/u,
  )
})

test('registered tool exposes and forwards per-call selection', async () => {
  let definition
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
        definition = value
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

  assert.deepEqual(definition.parameters.properties.reasoning_effort.enum, [
    'low',
    'medium',
    'high',
    'xhigh',
    'ultra',
    'max',
  ])
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
