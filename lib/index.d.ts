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
  /** When set, run `codex exec resume <id>` instead of a fresh `codex exec`. */
  resumeSessionId?: string
}

export declare const name: string
export declare const inject: string[]
export declare const Config: import('@deepseek-ai/schemastery').Schemastery<CodexSubagentConfig, CodexSubagentConfig>

/** Fixed Codex sandbox policy: every run bypasses Codex approvals and sandbox. NOT configurable. */
export declare const CODEX_FIXED_SANDBOX_ARGV: readonly ['--dangerously-bypass-approvals-and-sandbox']

export declare function codexInvocationArgs(request: CodexInvocationRequest): string[]

export interface CodexExecArgvInput {
  node: string
  js: string
  cwd: string
  request: CodexInvocationRequest
}

export interface CodexExecResumeArgvInput {
  node: string
  js: string
  sessionId: string
  request: CodexInvocationRequest
}

/**
 * Build the complete `codex exec` argv. The sandbox portion is always exactly
 * `CODEX_FIXED_SANDBOX_ARGV` — independent of the parent session, the DSH
 * sandbox policy, and any legacy `sandboxMode` config.
 */
export declare function codexExecArgv(input: CodexExecArgvInput): string[]

/** Build the complete `codex exec resume <sessionId>` argv (prompt via stdin). */
export declare function codexExecResumeArgv(input: CodexExecResumeArgvInput): string[]

export declare function apply(ctx: import('@deepseek-ai/cordis').Context, config: CodexSubagentConfig): void
