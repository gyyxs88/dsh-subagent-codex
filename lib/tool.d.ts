import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Schemastery } from '@deepseek-ai/schemastery'
import type { CodexReasoningEffort } from './index.js'

export interface CodexToolConfig {
  provider?: string
  toolName?: string
  enableRunInBackground?: boolean
  agentOptions?: AgentOptions
  persona?: string
  maxDepth?: number | 'provider-managed'
}

export interface CodexToolArgs {
  description: string
  prompt: string
  model?: string
  reasoning_effort?: CodexReasoningEffort
  run_in_background?: boolean
}

export declare const name: string
export declare const inject: string[]
export declare const Config: Schemastery<CodexToolConfig, CodexToolConfig>

export declare function buildCodexStartRequest(
  args: CodexToolArgs,
  config: CodexToolConfig,
  parent: Agent,
): Record<string, unknown>

export declare function apply(ctx: Context, config: CodexToolConfig): void
