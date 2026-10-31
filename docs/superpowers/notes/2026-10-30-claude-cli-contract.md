# Claude CLI contract, verified on 2.1.109

From `scripts/probe-claude.ts`, run 2026-10-31 on a subscription login under `~/.aiteam/agent-home/claude`, model Haiku. The streams are in `test/fixtures/claude/`. Where these notes and the plan disagree, these notes win. Spend for one full probe is about $0.03.

## Invocation that passes

```
CLAUDE_CONFIG_DIR=<agent home> CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude -p --output-format stream-json --verbose --model <model>
  --append-system-prompt-file <path> --json-schema '<JSON string>'
  --tools Read,Glob,Grep,Edit,Write,Bash
  --allowedTools 'Read(./**),Glob(./**),Grep(./**),Bash,Edit(./**),Write(./**)'
  --permission-mode dontAsk --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --setting-sources user
  --max-turns <n> --max-budget-usd <n>
  --settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":[]},"filesystem":{"denyRead":[...]}}}'
  < task
```

The environment is only `PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, LC_CTYPE, TERM` plus the two variables above.

## What isolation was proved

| Check | Result |
|---|---|
| Login under the agent home | Works. `auth status` reports `loggedIn:true`, `authMethod:"claude.ai"`, in the stripped environment too. Credentials are not in the agent home's files: it holds only `.claude.json` and `backups/`. |
| User config in the worker | None: `plugins:[]`, `mcp_servers:[]`, `apiKeySource:"none"`, no plugin-scoped names, no `hook_*` events, no `memory_paths`. |
| Bash writes outside the cwd | Blocked by the sandbox: `operation not permitted`. |
| Write and Edit outside the cwd | **Not blocked by the sandbox.** With `--allowedTools ...,Write,...` the outside file was created. Scoping to `Edit(./**)` and `Write(./**)` under `dontAsk` denies them. |
| Writes inside the cwd | Bash, Write and Edit all work. |
| Bash network | Blocked: `curl: (56) CONNECT tunnel failed, response 403`. |
| Settings planted in the worktree | **Load unless `--setting-sources user` is passed.** Without it, in `-p` mode, hooks in `.claude/settings.json` and `.claude/settings.local.json` ran outside the Bash sandbox and wrote outside the cwd, `CLAUDE.md` reached the model, and planted skills, agents and commands appeared in `init`. With it, none of these load, and `~/.aiteam/agent-home/claude/settings.json` is still the only settings file read. The manifest delivers the repo's instructions instead, as text in the system prompt. |
| Read, Glob, Grep outside the cwd | Unscoped they all work. `Read(./**)`, `Glob(./**)`, `Grep(./**)` under `dontAsk` refuse them, and all three still work inside the cwd. |
| Symlink in the cwd pointing outside | Read, Write and Edit refuse it, through a file link and a folder link. Bash follows it unless the target is in `denyRead`. |
| Bash reads | `sandbox.filesystem.denyRead` blocks them with `Operation not permitted`. The CLI itself isn't limited by it: it still reads its own config and login under a denied agent home, and `node` and `git` still run. |
| Keychain from Bash | **Reachable until `~/Library/Keychains` is denied.** `security find-generic-password` exits 0 in the sandbox without it and 44 with it. Only the exit status was tested; no secret was read. |
| Oversized Bash output | Saved under the agent home, and `Read` can still open it under the scoped rule, so the CLI exempts its own files. |

**Not closed: other Bash reads.** `denyRead` is a list, so anything not on it stays readable by Bash: other repos, other attempts' worktrees, files in the home folder that aren't named. Network-blocked Bash limits where such a file can go, but a worker could still copy it into the diff.

`--bare` can't be proved here: it refuses OAuth, so it needs an API key. `--setting-sources user` is passed in both modes so the subscription result covers both as far as it can.

## Stream

Order is `system:init`, then usually `rate_limit_event`, then `assistant` and `user` lines, then `result`. No lines followed `result` in these runs, though hook events can on a home that has hooks. `events[0]` is `init` here, but earlier probes saw `hook_started` before it on the default home.

### `result`, per run

| Run | `subtype` | `is_error` | exit | `terminal_reason` | `stop_reason` | Message |
|---|---|---|---|---|---|---|
| success | `success` | false | 0 | `completed` | `end_turn` | `result` text |
| max-turns | `error_max_turns` | true | 1 | `max_turns` | `tool_use` | `errors[0]`: `Reached maximum number of turns (1)` |
| max-budget | `error_max_budget_usd` | true | 1 | absent | null | `errors[0]`: `Reached maximum budget ($0.0001)` |
| auth-failed | `success` | true | 1 | `completed` | `stop_sequence` | `result`: `Not logged in · Please run /login` |
| sigint | `error_during_execution` | true | **0** | `aborted_streaming` | null | `errors[0]`: `[ede_diagnostic] ...` |

- Error subtypes carry `errors: string[]` and no `result` field. Use `errors[0]` for the message.
- **Structured output:** `result.structured_output` holds the parsed object. The model delivers it through a tool named `StructuredOutput`, which appears in `init.tools`.
- **Cost:** `result.total_cost_usd`, a float.
- **Usage:** `result.usage` has `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. `result.modelUsage` is per model, camelCase.
- **Turns:** `result.num_turns`. `--max-turns 1` reports `num_turns: 2`, so don't compare the two directly.
- **Denied tools:** `result.permission_denials` lists `{tool_name, tool_use_id, tool_input}`. The tool result has `is_error:true` and tells the model it may try other tools.
- **Budget:** `--max-budget-usd` is checked after a model call, so a run can overshoot it. The 0.0001 run cost 0.0004.

### Auth failure

`assistant.error` is `"authentication_failed"` on the assistant line, and the result is `subtype:"success"`, `is_error:true`, exit 1. It reports `init` first, so `init` alone doesn't prove a login.

### `init`

Keys: `type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, apiKeySource, claude_code_version, output_style, agents, skills, plugins, uuid, fast_mode_state`. `memory_paths` is absent with auto-memory disabled.

Built-ins that are always there and aren't leaks:
- `agents`: `general-purpose, statusline-setup, Explore, Plan`
- `skills`: `update-config, debug, simplify, batch, loop, schedule, claude-api`

### `rate_limit_event`

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793728800,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}}
```

`status` is nested under `rate_limit_info` and `resetsAt` is epoch seconds. `overageStatus` can read `"rejected"` on a healthy run, so only `rate_limit_info.status` counts. A real rejection was not observed.

### `user` and `assistant` lines

- `assistant` keys: `type, message, parent_tool_use_id, session_id, uuid`. `message.content` holds `text` and `tool_use` blocks, one block per line, so one model turn can produce several lines.
- `user` keys add `timestamp, tool_use_result`. `message.content` holds `tool_result` blocks with `tool_use_id`, `content`, and `is_error`, which may be absent on success.

## SIGINT

SIGINT to the process group exits within about 250–400 ms, with exit code **0** and a `result` line of `error_during_execution`. The exit code alone can't tell a cancel from a success, so cancellation has to come from the adapter's own record that it sent the signal.

## Observations for later

- **The login check can be wrong for a moment around login.** The first probe reported logged out seconds before the agent home's files appeared, then every check passed. The likely cause is that the login hadn't landed yet; I couldn't reproduce it. Preflight should re-check on each run rather than cache a result.
- **A sandboxed shell can read this login.** `auth status` reports `loggedIn:true` for the agent home from a sandboxed Bash. The earlier "sandbox hides the keychain" note was wrong: the default home on this machine is simply logged out. The probe still needs to run outside a sandbox, for the network.
