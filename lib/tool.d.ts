import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Schemastery } from '@deepseek-ai/schemastery'
import type { CodexReasoningEffort } from './index.js'

export interface CodexToolConfig {
  provider?: string
  toolName?: string
  enableRunInBackground?: boolean
  /** Register the codex_sessions_list / codex_session_read / codex_session_send tools. Defaults to true. */
  enableSessionTools?: boolean
  /** Per-request timeout for the long-lived app-server JSON-RPC child, in ms. */
  appServerRequestTimeoutMs?: number
  agentOptions?: AgentOptions
  persona?: string
  maxDepth?: number | 'provider-managed'
}

export interface CodexToolArgs {
  description: string
  prompt: string
  /** Optional Codex session/thread id to resume (`codex exec resume <id>`). */
  resume_session_id?: string
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
