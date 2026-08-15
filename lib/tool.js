import path from 'node:path'
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSubagentMaxDepth, settleRun } from '@deepseek-ai/dsh-subagent'
import { CODEX_REASONING_EFFORTS } from './index.js'
import { AppServerClient } from './app-server.js'
import { listSessions, readSession, sendMessage, startManagedSession } from './session-tools.js'

export const name = 'tool-subagent-codex'
export const inject = ['tools', 'subagents', 'subprocess']

export const Config = z.object({
  provider: z.string().default('codex'),
  toolName: z.string().default('subagent_codex'),
  enableRunInBackground: z.boolean().default(true),
  enableSessionTools: z.boolean().default(true),
  appServerRequestTimeoutMs: z.number().step(1).min(1000).max(300000),
  agentOptions: z
    .object({
      provider: z.string(),
      model: z.string(),
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .default(undefined),
  persona: z.string(),
  maxDepth: z
    .union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')])
    .default('provider-managed'),
})

function outputValueText(values) {
  return values
    .filter(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        value.type === 'text' &&
        typeof value.text === 'string',
    )
    .map((value) => value.text)
    .join('')
}

async function settleStart(start, signal) {
  try {
    return await settleRun(await start)
  } catch (error) {
    return signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(error) }
  }
}

function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

function withPartialText(error, output) {
  const text = output
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output,
        ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {}),
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

function normalizeCallModel(value) {
  if (value === undefined) return undefined
  const model = value.trim()
  if (!model) throw new Error('subagent_codex: model must be a non-empty string')
  return model
}

/** Clamp a model-supplied integer into [min, max]; absent → fallback. */
function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function buildCodexStartRequest(args, config, parent) {
  const model = normalizeCallModel(args.model)
  const reasoningEffort = args.reasoning_effort
  if (reasoningEffort !== undefined && !CODEX_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error(`subagent_codex: invalid reasoning_effort ${JSON.stringify(reasoningEffort)}`)
  }
  const agentOptions =
    model === undefined ? config.agentOptions : { ...(config.agentOptions ?? {}), model }
  const codexOptions = {
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
  const resumeSessionId =
    typeof args.resume_session_id === 'string' && args.resume_session_id.trim()
      ? args.resume_session_id.trim()
      : undefined
  return {
    label: args.description,
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...(Object.keys(codexOptions).length === 0 ? {} : { codexOptions }),
    ...(config.persona === undefined ? {} : { persona: config.persona }),
    ...(typeof config.maxDepth === 'number' ? { maxDepth: config.maxDepth } : {}),
  }
}

export function apply(ctx, config) {
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  const providerName = config.provider ?? 'codex'
  const toolName = config.toolName ?? 'subagent_codex'
  const backgroundEnabled = config.enableRunInBackground !== false
  const sessionToolsEnabled = config.enableSessionTools !== false
  const appServerRequestTimeoutMs = config.appServerRequestTimeoutMs
  let disposeTool
  let disposeSessionTools
  let appServer
  let appServerSpawn

  // Resolve the codex entry once and reuse it for the app-server child, so the
  // long-lived process shares the same node/codex.js discovery as exec runs.
  const resolveAppServerSpawn = async () => {
    if (appServerSpawn !== undefined) return appServerSpawn
    const ctx2 = ctx
    const spawn = (argv, opts) => {
      return ctx2.subprocess.spawn({
        argv,
        cwd: opts?.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 2000,
      })
    }
    appServerSpawn = spawn
    return spawn
  }

  const getAppServer = async () => {
    if (appServer !== undefined) return appServer
    const node = await ctx.subprocess.resolveExecutable('node').catch(() => {
      throw new Error('app-server: cannot locate node.exe')
    })
    let js
    try {
      const shim = await ctx.subprocess.resolveExecutable('codex')
      const sep = Math.max(shim.lastIndexOf('\\'), shim.lastIndexOf('/'))
      const dir = sep >= 0 ? shim.slice(0, sep) : ''
      if (dir) {
        const candidate = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
        if (fs.existsSync(candidate)) js = candidate
      }
    } catch {}
    if (js === undefined) {
      throw new Error(
        'app-server: cannot locate the Codex CLI (bin/codex.js) — install it with `npm install -g @openai/codex`',
      )
    }
    const spawn = await resolveAppServerSpawn()
    const client = new AppServerClient({
      spawn,
      node,
      js,
      requestTimeoutMs: appServerRequestTimeoutMs,
      logger: ctx.logger,
    })
    appServer = client
    try {
      await client.ensureStarted()
    } catch (error) {
      // On construction/startup failure, drop and dispose the client so the
      // NEXT tool call can create a fresh one instead of reusing a broken
      // instance forever.
      appServer = undefined
      await client.dispose().catch(() => {})
      throw error
    }
    return client
  }

  const disposeAppServer = async () => {
    const client = appServer
    appServer = undefined
    if (client !== undefined) await client.dispose()
  }

  const mount = (provider) => {
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent-codex: provider ${JSON.stringify(provider.name)} cannot enforce maxDepth; use 'provider-managed'`,
      )
    }
    disposeTool = ctx.tools.register(
      defineTool({
        name: toolName,
        description:
          'Delegate a self-contained coding task to OpenAI Codex. Each call may override the Codex model and reasoning effort; omitted overrides use the Codex CLI configuration. Pass resume_session_id to continue a stored Codex session instead of starting a fresh one (equivalent to `codex exec resume <id> <prompt>`).' +
          (backgroundEnabled
            ? ' The call waits by default. Set run_in_background to return a job id; collect with job_output and stop with job_kill.'
            : ' The call waits for the result.'),
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description:
              'The complete, self-contained task for Codex. It does not share this conversation, so include everything it needs.',
          },
          resume_session_id: {
            type: 'string',
            description:
              'Optional Codex session/thread id to resume (like `codex exec resume <id>`). The result then includes the session id from the thread.started event.',
          },
          model: {
            type: 'string',
            description:
              'Optional Codex model id for this call (for example gpt-5.6-sol). Omit to use the Codex CLI configuration.',
          },
          reasoning_effort: {
            type: 'string',
            enum: CODEX_REASONING_EFFORTS,
            description:
              'Optional reasoning effort for this call. Omit to use the Codex CLI configuration.',
          },
          ...(backgroundEnabled
            ? {
                run_in_background: {
                  type: 'boolean',
                  description:
                    'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
                },
              }
            : {}),
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  sessionId: { type: 'string' },
                  output: { type: 'array', required: true, items: { type: 'json' } },
                },
              },
            ],
          },
          render: (_args, value) => [
            {
              type: 'text',
              text:
                value.kind === 'background'
                  ? `started background subagent task ${value.jobId}`
                  : value.sessionId
                    ? `codex session ${value.sessionId}:\n${outputValueText(value.output)}`
                    : outputValueText(value.output),
            },
          ],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) throw new Error('subagent_codex requires a calling agent')
          const request = buildCodexStartRequest(args, config, parent)
          if (args.run_in_background === true) {
            if (!backgroundEnabled) throw new Error('run_in_background is disabled for subagent_codex')
            const jobs = ctx.get('jobs')
            if (jobs === undefined) {
              throw new Error(
                'background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs',
              )
            }
            return {
              kind: 'background',
              jobId: jobs.start({
                kind: 'subagent',
                label: args.description,
                owner: parent,
                run: () => {
                  const controller = new AbortController()
                  return {
                    cancel: (reason) => controller.abort(reason ?? 'background subagent task killed'),
                    done: settleStart(
                      ctx.subagents.start(providerName, { ...request, signal: controller.signal }),
                      controller.signal,
                    ),
                  }
                },
              }),
            }
          }
          return settleForegroundRun(
            await ctx.subagents.start(providerName, { ...request, signal: exec.signal }),
          )
        },
      }),
    )
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === providerName && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (removedName) => {
    if (removedName !== providerName || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(providerName)
  if (present !== undefined) mount(present)
  else ctx.logger.info(`subagent provider ${JSON.stringify(providerName)} not registered yet`)

  if (sessionToolsEnabled) {
    const sessionToolNames = [
      'codex_sessions_list',
      'codex_session_read',
      'codex_session_start',
      'codex_session_send',
    ]
    disposeSessionTools = sessionToolNames.map((n) =>
      ctx.tools.register(
        defineTool({
          name: n,
          description:
            n === 'codex_sessions_list'
              ? 'List local Codex sessions via the app-server. Defaults to the caller cwd; pass include_all to span projects. Returns bounded id/preview/cwd/source/status/updatedAt plus honest delivery state and capabilities.'
              : n === 'codex_session_read'
                ? 'Read a stored Codex session via thread/read (never resumes). Returns bounded recent history, honest delivery state and capabilities.'
                : n === 'codex_session_start'
                  ? 'Start a NEW managed Codex session on the shared app-server (thread/start + turn/start with the first message). Fixed no-approval / no-sandbox policy; per-call model/reasoning_effort/cwd supported. Returns threadId/turnId with kind=managed_turn_started and steerable=true — this is the only path that establishes a session that codex_session_send can steer.'
                  : 'Send a message to a Codex session. Managed sessions (created by codex_session_start) are steered in place while active, or get a new managed turn when idle; not-loaded sessions are refused unless mode="resume" (codex exec resume, marked may_be_concurrent). Never auto-falls back from steer to resume.',
          parameters:
            n === 'codex_sessions_list'
              ? {
                  include_all: {
                    type: 'boolean',
                    description:
                      'List sessions across all projects (defaults to the caller cwd only).',
                  },
                  limit: {
                    type: 'number',
                    description: 'Max sessions to return (default 50).',
                  },
                }
              : n === 'codex_session_read'
                ? {
                    session_id: {
                      type: 'string',
                      required: true,
                      description: 'Codex session/thread id to read.',
                    },
                    max_turns: {
                      type: 'number',
                      description: 'Max recent turns to return (default 20).',
                    },
                  }
                : n === 'codex_session_start'
                  ? {
                      prompt: {
                        type: 'string',
                        required: true,
                        description: 'First message text for the new managed session.',
                      },
                      model: {
                        type: 'string',
                        description:
                          'Optional Codex model id for this session (for example gpt-5.6-sol). Omit to use the Codex CLI configuration.',
                      },
                      reasoning_effort: {
                        type: 'string',
                        enum: CODEX_REASONING_EFFORTS,
                        description: 'Optional reasoning effort for this session.',
                      },
                      cwd: {
                        type: 'string',
                        description:
                          'Optional working directory override; defaults to the caller cwd.',
                      },
                    }
                  : {
                      session_id: {
                        type: 'string',
                        required: true,
                        description: 'Codex session/thread id to send to.',
                      },
                      prompt: {
                        type: 'string',
                        required: true,
                        description: 'Message text to send.',
                      },
                      mode: {
                        type: 'string',
                        enum: ['auto', 'resume'],
                        description:
                          'auto (default) steers managed active turns / starts managed turns on idle managed sessions; resume forces an unmanaged codex exec resume send (may_be_concurrent: true).',
                      },
                      model: {
                        type: 'string',
                        description:
                          'Optional Codex model id (applies to auto+idle turn/start and resume; REJECTED on steer since turn/steer cannot change the in-flight turn settings).',
                      },
                      reasoning_effort: {
                        type: 'string',
                        enum: CODEX_REASONING_EFFORTS,
                        description:
                          'Optional reasoning effort (applies to auto+idle turn/start and resume; REJECTED on steer).',
                      },
                    },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => [
              {
                type: 'text',
                text:
                  typeof value === 'string' ? value : JSON.stringify(value, null, 2),
              },
            ],
          },
          // Send is a read-decide-act mutation on a shared session; keep it
          // serial to avoid two callers racing thread/read + turn/start.
          isConcurrencySafe: () => n !== 'codex_session_send',
          async execute(args, exec) {
            const parent = exec.agent
            const cwdOf = () => {
              const session = parent && parent.session
              const header = session && session.header
              const meta = session && session.meta
              return (header && header.cwd) || (meta && meta.cwd) || process.cwd()
            }
            const client = await getAppServer()
            if (n === 'codex_sessions_list') {
              return listSessions({
                client,
                cwd: cwdOf(),
                includeAll: args.include_all === true,
                limit: clampInt(args.limit, 1, 100, 50),
                logger: ctx.logger,
              })
            }
            if (n === 'codex_session_read') {
              const result = await readSession({
                client,
                threadId: args.session_id,
                maxTurns: clampInt(args.max_turns, 1, 20, undefined),
                logger: ctx.logger,
              })
              return result
            }
            if (n === 'codex_session_start') {
              return startManagedSession({
                client,
                cwd: args.cwd ?? cwdOf(),
                input: args.prompt,
                model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined,
                reasoningEffort: args.reasoning_effort,
                logger: ctx.logger,
              })
            }
            // codex_session_send
            const overrides = {}
            if (typeof args.model === 'string' && args.model.trim()) overrides.model = args.model.trim()
            if (args.reasoning_effort !== undefined) overrides.reasoningEffort = args.reasoning_effort
            const resumeSender = async (threadId, input, resumeOverrides) => {
              const codexOptions = {}
              if (resumeOverrides?.model !== undefined) codexOptions.model = resumeOverrides.model
              if (resumeOverrides?.reasoningEffort !== undefined) {
                codexOptions.reasoningEffort = resumeOverrides.reasoningEffort
              }
              const run = await ctx.subagents.start(providerName, {
                label: 'codex session resume send',
                prompt: [{ type: 'text', text: input }],
                parent,
                resumeSessionId: threadId,
                ...(Object.keys(codexOptions).length === 0 ? {} : { codexOptions }),
                signal: exec.signal,
              })
              const settled = await settleForegroundRun(run)
              return {
                sessionId: settled.sessionId,
                output: outputValueText(settled.output),
              }
            }
            const result = await sendMessage({
              client,
              threadId: args.session_id,
              input: args.prompt,
              mode: args.mode === 'resume' ? 'resume' : 'auto',
              turnOverrides: Object.keys(overrides).length === 0 ? undefined : overrides,
              resumeSender,
            })
            return {
              ...result,
              status: result.status ?? 'n/a',
              managed: result.managed ?? client.isManaged(args.session_id),
            }
          },
        }),
      ),
    )
    // Dispose the app-server child with the tools.
    const originalDisposeSessionTools = disposeSessionTools
    disposeSessionTools = () => {
      originalDisposeSessionTools.forEach((fn) => {
        try {
          fn()
        } catch {}
      })
      return disposeAppServer()
    }
  }

  // Shut down the long-lived app-server child on context disposal.
  ctx.on('dispose', () => {
    const cleanup = disposeSessionTools
    disposeSessionTools = undefined
    if (typeof cleanup === 'function') cleanup().catch(() => {})
  })
}
