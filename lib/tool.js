import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSubagentMaxDepth, settleRun } from '@deepseek-ai/dsh-subagent'
import { CODEX_REASONING_EFFORTS } from './index.js'

export const name = 'tool-subagent-codex'
export const inject = ['tools', 'subagents']

export const Config = z.object({
  provider: z.string().default('codex'),
  toolName: z.string().default('subagent_codex'),
  enableRunInBackground: z.boolean().default(true),
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
      return { kind: 'foreground', runId: run.id, output: result.output }
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
  return {
    label: args.description,
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
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
  let disposeTool

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
          'Delegate a self-contained coding task to OpenAI Codex. Each call may override the Codex model and reasoning effort; omitted overrides use the Codex CLI configuration.' +
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
}
