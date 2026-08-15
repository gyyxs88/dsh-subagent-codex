import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, codexExecArgv, codexInvocationArgs, CODEX_FIXED_SANDBOX_ARGV } from '../lib/index.js'

const BYPASS = '--dangerously-bypass-approvals-and-sandbox'

function countOf(argv, needle) {
  return argv.filter((arg) => arg === needle).length
}

test('CODEX_FIXED_SANDBOX_ARGV carries exactly the fixed bypass flag', () => {
  assert.deepEqual([...CODEX_FIXED_SANDBOX_ARGV], [BYPASS])
  // Frozen so the policy cannot be mutated by callers.
  assert.throws(() => {
    CODEX_FIXED_SANDBOX_ARGV.push('--approve-for-me')
  }, TypeError)
})

test('every codex exec argv contains the bypass flag exactly once and no other sandbox flags', () => {
  const argv = codexExecArgv({ node: 'node', js: 'codex.js', cwd: 'C:/ws', request: {} })
  assert.equal(countOf(argv, BYPASS), 1)
  assert.equal(countOf(argv, '--approve-for-me'), 0)
  assert.equal(countOf(argv, '-s'), 0)
  assert.equal(countOf(argv, 'read-only'), 0)
  assert.equal(countOf(argv, 'workspace-write'), 0)
})

test('argv order places the fixed bypass flag after the base and per-call args', () => {
  const argv = codexExecArgv({
    node: 'node',
    js: 'codex.js',
    cwd: 'C:/ws',
    request: { codexOptions: { model: 'gpt-5.6-sol', reasoningEffort: 'high' } },
  })
  assert.deepEqual(argv, [
    'node',
    'codex.js',
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    'C:/ws',
    '-m',
    'gpt-5.6-sol',
    '-c',
    'model_reasoning_effort="high"',
    BYPASS,
  ])
})

test('fixed bypass flag is unaffected by a parent session sandbox mode', () => {
  // A parent session that would previously have mapped to `-s read-only` or
  // `--approve-for-me` must not change the fixed argv.
  const parentVariants = [
    { parent: { session: { header: { cwd: 'C:/ws' }, meta: { sandbox: 'read-only' } } } },
    { parent: { session: { header: { cwd: 'C:/ws' }, meta: { sandbox: 'workspace-write' } } } },
    { parent: { session: { header: { cwd: 'C:/ws' }, meta: { sandbox: 'danger-full-access' } } } },
  ]
  for (const request of parentVariants) {
    const argv = codexExecArgv({ node: 'node', js: 'codex.js', cwd: 'C:/ws', request })
    assert.equal(countOf(argv, BYPASS), 1, JSON.stringify(request))
    assert.equal(countOf(argv, '--approve-for-me'), 0, JSON.stringify(request))
    assert.equal(countOf(argv, '-s'), 0, JSON.stringify(request))
  }
})

test('Config no longer exposes a sandboxMode option', () => {
  const serialized = JSON.stringify(Config.toJSON())
  assert.ok(!serialized.includes('sandboxMode'), 'sandboxMode must not appear in the provider Config schema')
  assert.ok(!serialized.includes('--approve-for-me'), 'approval mode options must not appear in the Config schema')
})

test('per-call model/reasoning overrides still compose with the fixed bypass flag', () => {
  const argv = codexExecArgv({
    node: 'node',
    js: 'codex.js',
    cwd: 'C:/ws',
    request: {
      codexOptions: { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
      agentOptions: { model: 'gpt-5.6-sol' },
    },
  })
  assert.ok(argv.includes('-m'))
  assert.ok(argv.includes('gpt-5.6-sol'))
  assert.ok(argv.includes('-c'))
  assert.ok(argv.includes('model_reasoning_effort="xhigh"'))
  assert.equal(countOf(argv, BYPASS), 1)
})

test('codexInvocationArgs still returns no sandbox-related args', () => {
  assert.deepEqual(codexInvocationArgs({ codexOptions: { model: 'gpt-5.6-sol' } }), [
    '-m',
    'gpt-5.6-sol',
  ])
  assert.deepEqual(codexInvocationArgs({}), [])
})
