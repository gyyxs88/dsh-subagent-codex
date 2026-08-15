# dsh-subagent-codex

Run [OpenAI Codex CLI](https://github.com/openai/codex) as a **subagent backend** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

> 把 Codex CLI 注册为 DSH 的子代理后端：任何启用了 `tool-subagent-codex` 行的会话，都可以通过
> 普通的 `subagent_codex` 工具把编码子任务委托给 Codex（一个独立进程、一个全新的 Codex 会话）。

## How it works / 工作原理

- **Plane: host.** The plugin registers a `SubagentProvider` named `codex` on the host's
  `subagents` registry (a process singleton — providers must live here, never in an agent preset).
- **Delegation.** A preset's `dsh-subagent-codex/tool` row exposes the `subagent_codex`
  tool; each call can override `model` and `reasoning_effort`, then spawns
  `node <codex.js> exec --json …` with the prompt delivered on **stdin**,
  parses the **JSONL event stream** from stdout (`item.completed` / `agent_message` is the final
  answer), collects stderr for diagnostics, and maps the exit to DSH's
  `completed | aborted | error` stop reasons.
- **Working directory.** Codex runs in the delegating parent session's workspace cwd (or a
  configured `cwd` override).
- **Sandbox policy — fixed, not configurable.** Every `codex exec` run passes
  `--dangerously-bypass-approvals-and-sandbox` exactly once: the Codex approval flow and the
  Codex sandbox are **always bypassed**. The parent session's DSH sandbox mode is never
  mirrored onto the child, and no alternative approval mode (`--approve-for-me`, `-s read-only`,
  `-s workspace-write`, …) can be selected. The child is spawned through the `subprocess`
  service, which does **not** confine the process tree — a confined Windows sandbox blocks the
  IPC channels Codex needs.
- **Windows note.** `codex.cmd` shims cannot be spawned directly by Node (`EINVAL`), so the
  provider resolves and spawns `node.exe` + the real `bin/codex.js` instead.

> ⚠️ **DANGER — read before deploying.** Because approvals and the Codex sandbox are always
> bypassed, every delegated Codex run can read and modify any file the DSH process can reach,
> execute arbitrary shell/tool commands, and act without asking for confirmation. This is a
> deliberate deployment decision for this copy of the plugin; it cannot be relaxed through
> configuration. Only delegate tasks you fully trust, and only from a machine/user account whose
> filesystem reach and privileges you are willing to expose to the model. The parent session's
> DSH sandbox settings do **not** apply to Codex runs.

## Requirements / 环境要求

- A DeepSeek Harness deployment (host composition; `subagents`, `subprocess` services).
- [Node.js](https://nodejs.org/) ≥ 18 on PATH.
- Codex CLI installed and logged in:

  ```bash
  npm install -g @openai/codex
  codex login status   # should report "Logged in"
  ```

## Install / 安装

Add the package to your DSH profile and list it as a bundle (its `cordis.patch.yml`
registers the provider row):

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-subagent-codex": "github:gyyxs88/dsh-subagent-codex"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-subagent-codex"]
    }
  }
}
```

Alternatively, add the row manually to your host composition (e.g. a `--patch` overlay):

```yaml
- id: codex-subagent
  name: 'dsh-subagent-codex'
```

## Expose the tool in a preset / 在预设中暴露工具

The provider alone is inert — sessions need this package's Codex-specific delegation tool row:

```yaml
# inside your preset's agent.cordis.yml, delegation group
- id: tool-subagent-codex
  name: 'dsh-subagent-codex/tool'
  config:
    provider: codex
    toolName: subagent_codex
    enableRunInBackground: true
    maxDepth: provider-managed
```

Sessions composed from that preset can then call `subagent_codex`.

Each call may select its own model and reasoning effort. Omitting either field preserves the
corresponding value from the Codex CLI configuration:

```json
{
  "description": "review auth flow",
  "prompt": "Review the authentication flow and report concrete defects.",
  "model": "gpt-5.6-sol",
  "reasoning_effort": "xhigh",
  "run_in_background": true
}
```

Supported `reasoning_effort` values are `low`, `medium`, `high`, `xhigh`, `ultra`, and `max`.

### Resuming a stored session / 续跑已有会话

Pass `resume_session_id` to continue a stored Codex session instead of starting a fresh one.
The plugin runs `codex exec resume <id> - --json …` (prompt via stdin) with the same fixed
bypass policy and per-call model/reasoning overrides. The result includes the session id from
the `thread.started` event:

```json
{
  "description": "continue refactor",
  "prompt": "Continue the refactor from where we left off.",
  "resume_session_id": "thr_abc123",
  "model": "gpt-5.6-sol"
}
```

## Session tools / 会话工具

The tool row also registers four session tools that talk to a long-lived
`codex app-server` child (JSON-RPC 2.0 over stdio, two-phase `initialize` handshake):

- `codex_sessions_list` — list local sessions. Defaults to the caller's cwd; pass
  `include_all: true` to span projects (explicitly). Returns bounded
  `id/name/preview/cwd/source/status/updatedAt` plus honest delivery state
  (`active_managed | idle_managed | external_or_idle | system_error`) and
  capabilities (`view`, `resume_unmanaged`, `steer`, `start_managed_turn`).
- `codex_session_read` — read a stored session via `thread/read` (never resumes). Returns bounded
  recent history: a **global** character budget across the whole returned history (default
  ≤ `MAX_HISTORY_CHARS`, newest turns kept first, chronological order within the kept set) and a
  turn cap; `truncated` is set when either limit is hit. Also returns the honest
  state/capabilities.
- `codex_session_start` — **start a NEW managed session** on the shared app-server:
  `thread/start` then `turn/start` with the first message. Fixed
  `approvalPolicy: "never"` + `sandboxPolicy: { type: "dangerFullAccess" }`; per-call
  `model`/`reasoning_effort`/`cwd` supported. Returns
  `threadId`/`turnId` with `kind: "managed_turn_started"` and `steerable: true`.
- `codex_session_send` — send a message to a session:
  - `mode: "auto"` (default): steer an active turn this plugin started (`turn/steer` with
    `expectedTurnId`), or start a new managed turn on an idle managed session. Sessions that are
    not loaded by this plugin (including `notLoaded`, which may be idle OR actively running in
    another Codex process) are refused — the plugin never guesses active, and never auto-loads a
    thread. A failed steer never falls back to resume.
  - `mode: "resume"`: explicitly send via `codex exec resume`; the result is marked
    `resume_unmanaged` + `may_be_concurrent: true` because another process may own the session.
  - Per-call `model` / `reasoning_effort`: forwarded to `turn/start` (auto + idle managed) or to
    the `codex exec resume` run (mode resume, fixed bypass preserved). They are **rejected** when
    steering an active managed turn, because `turn/steer` cannot change the in-flight turn's
    settings — never silently ignored, never a fallback.
  - `systemError` sessions fail hard in both modes (resume is not allowed on an errored thread).

> ⚠️ **Honest steering boundary.** Only sessions created by `codex_session_start` (loaded into
> this plugin's shared app-server, with a turn this plugin started) can ever be
> `steered`. `codex exec` / `codex exec resume` runs are separate one-shot processes; their
> sessions remain unmanaged and are never claimed steerable. `thread/status/changed` and
> `turn/started` notifications are tracked per connection, and only turns recorded by this
> plugin's `turn/start` are considered steerable.

### Background runs / 后台任务

One-shot background delegation works out of the box — the tool gains a
`run_in_background` parameter (results collected with `job_output`, cancelled
with `job_kill`). Enable it with `enableRunInBackground: true` in the tool row:

```yaml
- id: tool-subagent-codex
  name: 'dsh-subagent-codex/tool'
  config:
    provider: codex
    toolName: subagent_codex
    enableRunInBackground: true
    maxDepth: provider-managed
```

A background `codex exec` runs as a plain task under the `jobs` service; killing
the job aborts the request signal and terminates the Codex process tree.
Continuable conversations (`backgroundMode: continuable`) are **not** supported —
Codex is a one-shot CLI backend, not a DSH agent session.

## Configuration / 配置

| Field | Default | Description |
| --- | --- | --- |
| `providerName` | `codex` | Registry name of the provider; must match a tool-subagent row's `provider`. |
| `nodeExecutable` | `node` on PATH | Absolute path to `node.exe`. |
| `codexJs` | auto-discovered | Absolute path to the Codex CLI entry (`bin/codex.js`). |
| `cwd` | parent session cwd | Absolute working directory override for codex runs. |

Tool-row configuration (`dsh-subagent-codex/tool`):

| Field | Default | Description |
| --- | --- | --- |
| `enableSessionTools` | `true` | Register `codex_sessions_list` / `codex_session_read` / `codex_session_start` / `codex_session_send`. |
| `appServerRequestTimeoutMs` | `30000` | Per-request timeout for the long-lived app-server JSON-RPC child. |

There is **no sandbox configuration**: every run is executed with the fixed
`--dangerously-bypass-approvals-and-sandbox` flag (see the danger notice above). A previously
configured `sandboxMode` key is ignored — the fixed policy wins regardless of the parent
session's sandbox mode or any legacy config.

The model-facing tool additionally accepts per-call `model` and `reasoning_effort` fields.
They are passed as separate argv entries (`-m <model>` and
`-c model_reasoning_effort="<effort>"`), never through a shell.

## Capabilities / 能力边界

- One-shot foreground and one-shot background delegations are supported; continuable
  conversations are not.
- `persona` is supported (prepended to the prompt); `outputSchema`, `depthLimit` and
  `toolFilter` are declared unsupported and rejected loudly at start.
- Each call may override the Codex CLI model and reasoning effort. Omitted values continue to
  come from `~/.codex/config.toml`; DSH does not meter the Codex model usage.
- `resume_session_id` resumes a stored session via `codex exec resume` (unmanaged, one-shot).
- Managed sessions (created by `codex_session_start` on the shared app-server) support
  in-place `turn/steer` for active turns and new managed turns for idle ones. External
  sessions are never claimed active; `notLoaded` is never auto-loaded.
- The app-server child is spawned through the `subprocess` service; it is terminated on tool
  disposal. Session history and previews are truncated to bounded sizes; the plugin never
  reads keys or credentials.

## License

MIT
