# dsh-subagent-codex

Run [OpenAI Codex CLI](https://github.com/openai/codex) as a **subagent backend** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

> 把 Codex CLI 注册为 DSH 的子代理后端：任何启用了 `tool-subagent-codex` 行的会话，都可以通过
> 普通的 `subagent_codex` 工具把编码子任务委托给 Codex（一个独立进程、一个全新的 Codex 会话）。

## How it works / 工作原理

- **Plane: host.** The plugin registers a `SubagentProvider` named `codex` on the host's
  `subagents` registry (a process singleton — providers must live here, never in an agent preset).
- **Delegation.** A preset's `tool-subagent` row (`provider: codex`) exposes the `subagent_codex`
  tool; each call spawns `node <codex.js> exec --json …` with the prompt delivered on **stdin**,
  parses the **JSONL event stream** from stdout (`item.completed` / `agent_message` is the final
  answer), collects stderr for diagnostics, and maps the exit to DSH's
  `completed | aborted | error` stop reasons.
- **Working directory.** Codex runs in the delegating parent session's workspace cwd (or a
  configured `cwd` override).
- **Sandbox mirroring.** The parent session's DSH sandbox mode is mapped onto Codex's own flags:
  `read-only` → `-s read-only`; `workspace-write` → `--approve-for-me` (implies workspace-write +
  automatic review); `danger-full-access` → `--dangerously-bypass-approvals-and-sandbox`.
  The child is spawned through the `subprocess` service, which does **not** confine the tree —
  a confined Windows sandbox blocks the IPC channels Codex needs.
- **Windows note.** `codex.cmd` shims cannot be spawned directly by Node (`EINVAL`), so the
  provider resolves and spawns `node.exe` + the real `bin/codex.js` instead.

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

The provider alone is inert — sessions need a delegation tool row. Copy the shipped
`tool-subagent-codex` template from any full preset and remove `disabled`:

```yaml
# inside your preset's agent.cordis.yml, delegation group
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    enableRunInBackground: false
    maxDepth: provider-managed
```

Sessions composed from that preset can then call `subagent_codex`.

### Background runs / 后台任务

One-shot background delegation works out of the box — the tool gains a
`run_in_background` parameter (results collected with `job_output`, cancelled
with `job_kill`). Enable it with `enableRunInBackground: true` in the tool row:

```yaml
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
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
| `sandboxMode` | `inherit` | `inherit` \| `read-only` \| `workspace-write` \| `danger-full-access`. |

## Capabilities / 能力边界

- One-shot foreground delegations only (no continuable conversations, no background jobs) —
  mirror the shipped template's `enableRunInBackground: false`.
- `persona` is supported (prepended to the prompt); `outputSchema`, `depthLimit` and
  `toolFilter` are declared unsupported and rejected loudly at start.
- Codex runs its own model (whatever your `~/.codex/config.toml` selects); DSH does not
  select or meter it.

## License

MIT
