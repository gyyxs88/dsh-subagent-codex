/**
 * dsh-subagent-codex type declarations.
 * The runtime module exports a standard Cordis plugin (`name` / `inject` /
 * `Config` / `apply`). Types are intentionally structural and dependency-light.
 */

export interface CodexSubagentConfig {
  /** Registry name of the subagent provider. Defaults to `codex`. */
  providerName?: string
  /** Absolute path to node.exe; defaults to resolving `node` on PATH. */
  nodeExecutable?: string
  /** Absolute path to the Codex CLI entry (bin/codex.js); defaults to auto-discovery. */
  codexJs?: string
  /** Absolute working directory override for codex runs; defaults to the parent session cwd. */
  cwd?: string
  /** Sandbox policy for codex: `inherit` (default) mirrors the parent session mode. */
  sandboxMode?: 'inherit' | 'read-only' | 'workspace-write' | 'danger-full-access'
}

export declare const CODEX_REASONING_EFFORTS: readonly ['low', 'medium', 'high', 'xhigh', 'ultra', 'max']
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]

export interface CodexPerCallOptions {
  /** Optional Codex model override; omitted values use the Codex CLI configuration. */
  model?: string
  /** Optional Codex reasoning-effort override; omitted values use the Codex CLI configuration. */
  reasoningEffort?: CodexReasoningEffort
}

export interface CodexInvocationRequest {
  codexOptions?: CodexPerCallOptions
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
}

export declare const name: string
export declare const inject: string[]
export declare const Config: import('@deepseek-ai/schemastery').Schemastery<CodexSubagentConfig, CodexSubagentConfig>

export declare function codexInvocationArgs(request: CodexInvocationRequest): string[]

export declare function apply(ctx: import('@deepseek-ai/cordis').Context, config: CodexSubagentConfig): void
