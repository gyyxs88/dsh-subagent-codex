/**
 * dsh-subagent-codex
 *
 * A DeepSeek Harness (DSH) subagent provider that runs OpenAI Codex CLI
 * (`codex exec`) as a one-shot, out-of-process coding subagent.
 *
 * Plane: HOST. The `subagents` registry is a process singleton; this package
 * registers the provider under `ctx.subagents` (provider name `codex` by
 * default) so any session whose preset contributes a `tool-subagent` row with
 * `provider: codex` (the shipped `tool-subagent-codex` template) can delegate
 * to Codex through the ordinary `subagent` tool layer.
 *
 * How a delegation runs:
 *   1. `provider.start(request)` spawns `node <codex.js> exec --json ...`
 *      with the prompt delivered on stdin (no argv length limits, no shell
 *      interpretation — `argv[0]` is a real executable).
 *   2. stdout is parsed as a JSONL event stream (`item.completed` /
 *      `agent_message` carries the final answer); stderr is collected for
 *      diagnostics.
 *   3. The process tree is terminated on abort (`request.signal`) and on
 *      `dispose()`. The run resolves with `completed | aborted | error` and
 *      the final answer as a text `ContentBlock`.
 *
 * Sandbox mapping: the parent session's DSH sandbox mode is mirrored onto
 * Codex's own sandbox flags (`-s read-only` / `--approve-for-me` which
 * implies workspace-write / `--dangerously-bypass-approvals-and-sandbox`).
 * The child is spawned through the `subprocess` service, which does NOT
 * confine the process tree — Codex needs to open its own IPC channels that a
 * confined Windows sandbox would block.
 *
 * Windows note: `codex.cmd` shims cannot be spawned directly by Node's
 * `child_process.spawn` (EINVAL), so the provider resolves and spawns
 * `node.exe` + the real `codex.js` entry instead.
 */

import path from 'node:path'
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-subagent-codex'

export const inject = ['subagents', 'subprocess']

export const Config = z.object({
  providerName: z
    .string()
    .default('codex')
    .description('Registry name of the subagent provider (must match the `provider` of a tool-subagent row).'),
  nodeExecutable: z
    .string()
    .description('Absolute path to node.exe. Defaults to resolving `node` on PATH.'),
  codexJs: z
    .string()
    .description('Absolute path to the Codex CLI entry (bin/codex.js). Defaults to auto-discovery from the `codex` shim on PATH.'),
  cwd: z
    .string()
    .description('Absolute working directory override for codex runs. Defaults to the delegating parent session cwd.'),
  sandboxMode: z
    .union([z.const('inherit'), z.const('read-only'), z.const('workspace-write'), z.const('danger-full-access')])
    .default('inherit')
    .description('Sandbox policy for codex: `inherit` mirrors the parent session mode; others force a mode.'),
})

const PREFIX = 'dsh-subagent-codex'

export const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'ultra', 'max'])

function normalizeModel(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${PREFIX}: model must be a string`)
  const model = value.trim()
  if (!model) throw new Error(`${PREFIX}: model must be a non-empty string`)
  if (model.length > 200 || /[\0\r\n]/u.test(model)) throw new Error(`${PREFIX}: model contains invalid characters`)
  return model
}

function normalizeReasoningEffort(value) {
  if (value === undefined) return undefined
  if (!CODEX_REASONING_EFFORTS.includes(value)) {
    throw new Error(`${PREFIX}: reasoning effort must be one of ${CODEX_REASONING_EFFORTS.join(', ')}`)
  }
  return value
}

/** Build per-call Codex CLI overrides without using a shell. */
export function codexInvocationArgs(request) {
  const model = normalizeModel(request.codexOptions?.model ?? request.agentOptions?.model)
  const reasoningEffort = normalizeReasoningEffort(request.codexOptions?.reasoningEffort)
  return [
    ...(model === undefined ? [] : ['-m', model]),
    ...(reasoningEffort === undefined
      ? []
      : ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]),
  ]
}

/** Validate the configured cwd override once at load; `undefined` means "inherit parent cwd". */
function validateConfiguredCwd(cwd) {
  if (cwd === undefined) return undefined
  if (cwd === '') throw new Error(`${PREFIX}: config cwd must not be empty — omit the key to inherit the parent session cwd`)
  if (!path.isAbsolute(cwd)) throw new Error(`${PREFIX}: config cwd must be an absolute path: ${cwd}`)
  assertEnterableDirectory(`${PREFIX}: config cwd`, cwd)
  return cwd
}

/** Resolve the child working directory at start: config override, else parent session cwd. */
function resolveChildCwd(configured, parentCwd) {
  if (configured !== undefined) return configured
  if (parentCwd === undefined) {
    throw new Error(`${PREFIX}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`)
  }
  assertEnterableDirectory(`${PREFIX}: parent session cwd`, parentCwd)
  return parentCwd
}

function assertEnterableDirectory(label, dir) {
  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    throw new Error(`${label} is not an accessible directory: ${dir}`)
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`)
}

export function apply(ctx, config) {
  const configuredCwd = validateConfiguredCwd(config.cwd)

  let invocationPromise
  function resolveInvocation() {
    if (!invocationPromise) {
      invocationPromise = (async () => {
        const node = config.nodeExecutable || (await resolveNode())
        const js = config.codexJs || (await resolveCodexJs())
        return { node, js }
      })()
    }
    return invocationPromise
  }

  async function resolveNode() {
    try {
      return await ctx.subprocess.resolveExecutable('node')
    } catch {
      throw new Error(`${PREFIX}: cannot locate node.exe — set config \`nodeExecutable\` or put Node.js on PATH`)
    }
  }

  async function resolveCodexJs() {
    // Prefer deriving bin/codex.js from the `codex` shim location so the npm
    // global install layout is discovered rather than hard-coded.
    try {
      const shim = await ctx.subprocess.resolveExecutable('codex')
      const sep = Math.max(shim.lastIndexOf('\\'), shim.lastIndexOf('/'))
      const dir = sep >= 0 ? shim.slice(0, sep) : ''
      if (dir) {
        const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
        if (fs.existsSync(js)) return js
      }
    } catch {}
    throw new Error(
      `${PREFIX}: cannot locate the Codex CLI (bin/codex.js) — install it with \`npm install -g @openai/codex\` and log in with \`codex login status\`, or set config \`codexJs\``,
    )
  }

  function childSandboxArgs(parent) {
    let mode = config.sandboxMode
    if (mode === 'inherit') {
      mode = 'workspace-write'
      try {
        const policy = ctx.get('sandboxPolicy')
        if (policy !== undefined) mode = policy.overrideOf(parent.session) ?? policy.defaultMode
      } catch {}
    }
    switch (mode) {
      case 'read-only':
        return ['-s', 'read-only']
      case 'danger-full-access':
        ctx.logger.warn(`${PREFIX}: sandbox mode is danger-full-access — running codex with --dangerously-bypass-approvals-and-sandbox`)
        return ['--dangerously-bypass-approvals-and-sandbox']
      default:
        // workspace-write: `--approve-for-me` implies the workspace-write sandbox
        // and routes approval requests through automatic review.
        return ['--approve-for-me']
    }
  }

  function promptTextOf(request) {
    const text = (request.prompt || [])
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (!text || !text.trim()) throw new Error(`${PREFIX}: the delegation prompt is empty`)
    const persona = typeof request.persona === 'string' && request.persona.trim() ? request.persona.trim() : ''
    return persona ? `${persona}\n\n${text}` : text
  }

  function parentCwdOf(request) {
    const session = request.parent && request.parent.session
    const header = session && session.header
    const meta = session && session.meta
    const cwd = (header && header.cwd) || (meta && meta.cwd)
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  }

  function textBlocks(text) {
    return text ? [{ type: 'text', text }] : []
  }

  function runId() {
    return `${config.providerName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  const provider = {
    name: config.providerName,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: true },
    inheritsParentContext: false,
    async start(request) {
      const cwd = resolveChildCwd(configuredCwd, parentCwdOf(request))
      const prompt = promptTextOf(request)
      const { node, js } = await resolveInvocation()
      const argv = [node, js, 'exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', cwd]
        .concat(codexInvocationArgs(request), childSandboxArgs(request.parent))
      const signal = request.signal
      let resolveResult
      const result = new Promise((resolve) => {
        resolveResult = resolve
      })
      let finalText = ''
      let sawThreadCompleted = false
      let lineBuffer = ''
      let aborted = false

      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd,
          stdio: {
            stdin: { data: prompt },
            stdout: 'pipe',
            stderr: { maxBytes: 65536 },
          },
          graceMs: 2000,
          signal,
        })
      } catch (error) {
        throw new Error(`${PREFIX}: codex spawn failed: ${String((error && error.message) || error)}`)
      }

      const parseLine = (line) => {
        if (!line) return
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return // stray non-JSON log line on stdout — ignore
        }
        if (!event || typeof event !== 'object') return
        if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
          finalText = finalText ? `${finalText}\n${event.item.text}` : event.item.text
        } else if (event.type === 'thread.completed') {
          sawThreadCompleted = true
        } else if (event.type === 'error') {
          const message =
            (typeof event.message === 'string' && event.message) ||
            (event.error && String(event.error)) ||
            'codex reported an error'
          finalText = finalText ? `${finalText}\n[codex error] ${message}` : `[codex error] ${message}`
        }
      }

      if (handle.stdout) {
        handle.stdout.on('data', (chunk) => {
          lineBuffer += chunk.toString('utf8')
          let idx
          while ((idx = lineBuffer.indexOf('\n')) >= 0) {
            parseLine(lineBuffer.slice(0, idx).trim())
            lineBuffer = lineBuffer.slice(idx + 1)
          }
        })
      }

      const onAbort = () => {
        aborted = true
        handle.terminate()
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort)
      }

      handle.done.then(
        (outcome) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          let stderrTail = ''
          const reader = handle.collected && handle.collected.stderr
          if (reader) {
            try {
              stderrTail = reader.readFrom(0).text
            } catch {}
          }
          if (aborted) {
            resolveResult({ output: textBlocks(finalText), stopReason: 'aborted' })
          } else if (outcome.exitCode === 0 && (sawThreadCompleted || finalText.length > 0)) {
            resolveResult({ output: textBlocks(finalText), stopReason: 'completed' })
          } else {
            const tail = (stderrTail || '').trim()
            const extra = tail ? `\n\n[codex stderr]\n${tail.slice(-4000)}` : ''
            resolveResult({ output: textBlocks(finalText + extra), stopReason: 'error' })
          }
        },
        (error) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          resolveResult({
            output: textBlocks(`${PREFIX}: [codex spawn failure] ${String((error && error.message) || error)}`),
            stopReason: 'error',
          })
        },
      )

      return {
        id: runId(),
        localAgent: undefined,
        result,
        async dispose() {
          if (signal) signal.removeEventListener('abort', onAbort)
          handle.terminate()
          try {
            await handle.waitForExit()
          } catch {}
        },
      }
    },
  }

  ctx.effect(() => ctx.subagents.registerProvider(provider))
  ctx.logger.info(`${PREFIX}: subagent provider "${config.providerName}" registered`)
}
