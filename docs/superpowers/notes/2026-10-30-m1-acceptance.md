# M1 acceptance on the real Claude CLI

Run on 2026-10-31 with `scripts/smoke-m1.ts`, the real `claude` binary (2.1.109), the subscription login in `~/.aiteam/agent-home/claude`, and a temp project repo. Model: `claude-sonnet-5-5`.

**Result: `M1 ACCEPTANCE PASS`, 0 checks failed, on the second run.** The first run failed and found a real bug, described below.

## Attempts and spend

Spend is the CLI's own estimate, taken from each attempt's final `result`.

| Run | Project | Task | Attempt | Outcome | Duration | Estimate |
|---|---|---|---|---|---|---|
| 1 | `smoke` | 1, T-SMOKE-1 | a1–a3, ids 1–3 | all `check_failed`, task escalated | 36.1s in all | $0.489 |
| 2 | `smoke-2` | 2, T-SMOKE-1 | a1, id 4 | succeeded, task in `review` | 9s (10.0s to review) | $0.147 |
| 2 | `smoke-2` | 3, T-SMOKE-2 | a1, id 5 | interrupted by the crash drill | 1s | not reported |
| 2 | `smoke-2` | 3, T-SMOKE-2 | a2, id 6 | succeeded, task in `review` | 14s | $0.174 |

Run 2 cost $0.3213, against the $3.00 limit and the $3 expected for the task. Across both runs and the probe below, about $0.91 is counted. An interrupted attempt never reports a cost, so id 5's spend is not in these figures.

## Checks on the passing run

| Check | Result |
|---|---|
| `aiteam doctor` has no failing checks | PASS |
| T-SMOKE-1 reaches `review` within 10 minutes | PASS, 10.0s, no escalation |
| The worktree is the attempt's own | PASS, `~/.aiteam/worktrees/smoke-2/T-SMOKE-1-a1` |
| The attempt is based on `aiteam/m1` | PASS, both `7fc7c936109b8e92f9b8c0c0ba8cecc81851d8de` |
| The manifest has every part | PASS: charter, playbook, memory, task_inputs, output_contract, repo_instructions |
| The manifest is within its budget | PASS, 612 of 12000 tokens |
| The flags include `--strict-mcp-config` | PASS |
| `isolationViolations` is empty for the attempt's `init` | PASS |
| `node --test src/add.test.mjs` exits 0 | PASS |
| T-SMOKE-1's estimate is at most $3 | PASS, $0.147 |
| The base branch has not moved | PASS, `main` |
| The repo's checkout is untouched | PASS |

## Isolation

- `isolationViolations` read the real transcript's `init` and found nothing: `apiKeySource` is `none`, there are no MCP servers, plugins or hook events, no skills, agents or commands leaked in, no tools outside the allowed list, and auto memory stays inside the agent home.
- **Instruction files above the worktree stay out.** Task 10 left this for Task 14. A probe put `CLAUDE.md` and `AGENTS.md` canaries in the parent of a git worktree and asked the model to list them:

  | Flags | Answer | Estimate |
  |---|---|---|
  | `--setting-sources user`, as a worker runs | `NONE` | $0.060 |
  | Default sources, the positive control | `HERON-7142`, the `CLAUDE.md` canary | $0.037 |

  This CLI doesn't read `AGENTS.md` under either setting. Neither `doctor` nor the manifest looks at files above the worktree any more, since there is nothing for a person to fix. `scripts/probe-claude.ts` plants a parent `CLAUDE.md` and re-proves this for a new CLI version (`parent_instructions_ignored`, passed on 2.1.109).

## Crash drill

SIGKILL on the daemon while T-SMOKE-2's first worker was running.

| Step | Result |
|---|---|
| T-SMOKE-2 reaches `worker.init` | PASS |
| The first attempt has a live pid | PASS, 74128 |
| The worker outlives the killed daemon | Yes, so recovery had a real orphan to deal with |
| Daemon healthy again | 0.6s after SIGKILL |
| The old worker's pid is gone | PASS, 0.6s after SIGKILL |
| a1 is `interrupted` | PASS, id 5 |
| a2 reaches `review` with no escalation | PASS, id 6, task settled 16.7s after SIGKILL |
| a2 has a different worktree | PASS, `~/.aiteam/worktrees/smoke-2/T-SMOKE-2-a2` |

After the run stopped, port 4780 was free and no daemon, script or worker process remained.

## Live UI

Checked in the browser against the real daemon. The only console errors were network ones from stopping and killing the daemon: refused connections and cut-off event streams.

- Real worker messages and tool calls stream. On the first run's task 1, rows grew from 33 to 50 in 9s while a3 ran.
- The Manifest tab shows real budgets: `context_tokens: 12000`, 612 used, charter 315 of 600, playbook 0 of 2000, memory 0 of 1000, task inputs 88 of 11476, plus the worker's real flags.
- Cost is labelled as an estimate: `~$0.17 (estimate)`.
- The recovery reads clearly in the log: "The daemon restarted and marked this attempt interrupted".

Screenshots:

- [First run, streaming while a3 ran](m1-acceptance/first-run-live-log.jpg)
- [T-SMOKE-2 live log after a2](m1-acceptance/t-smoke-2-live-log.jpg)
- [T-SMOKE-2 Manifest tab](m1-acceptance/t-smoke-2-manifest.jpg)

## The bug the first run found

All three attempts wrote working code, then failed their check with `EPERM: operation not permitted, lstat '/Users/ps/.aiteam/worktrees'`.

Denying the worktrees folder to checks (`11270d6`) also denied `lstat` on the folders above each worktree. Node resolves the path of anything it runs, so it could not start. The earlier tests never ran a path-resolving program under a denied parent, which is why only a real run showed it.

`2203df7` allows `file-read-metadata` on those exact folders. Listing them and reading other attempts stay refused, each with its own test, and both widening mutations were caught.

## What the final review changed

The whole-branch review found two things, both fixed after this run:

- **A login failure used up an attempt.** After a person logged in and pressed Retry, the task had one attempt fewer. `auth_required`, `context_over_budget` and `engine_error` escalate at once and say nothing about the work, so they no longer count. `spawn_error` still counts, because it goes round to another attempt and the runner would otherwise never stop.
- **`doctor` failed on a personal `~/.claude/CLAUDE.md`**, and the manifest charged its tokens to the budget, although workers never load it. The check and the counting are gone, and the probe guards the claim instead.

The acceptance run above predates these fixes and was not repeated. The test suite and the probe ran after them.

## What it leaves behind

- The projects `smoke` and `smoke-2` stay in the real `~/.aiteam`, because M1 has no project delete.
- Their temp repos stay too: `aiteam-smoke-OtujBW` and `aiteam-smoke-v9FCpk` in the system temp folder. Once one disappears, `pruneWorktrees` will log an error on each pass after the retention period for its ended attempts.

## Findings for later milestones

- **An environment failure in a check looks like a code failure.** The EPERM burned every attempt as `check_failed`, because the engine can't tell the two apart. The judge layer's failure classes (M5) are the natural place for this.
- **An interrupted attempt's spend isn't counted**, so the estimate runs slightly low after a crash. Budget work (M3) should account for it.
- **M2:** `network: restricted` gives workers and checks no network at all. Package installs need a per-project allow-list.
- **M2:** the plan's note that definition-of-done commands run unsandboxed is out of date. Task 8 runs them under `sandbox-exec`.
- **M6:** this machine's active developer directory is Command Line Tools, so `xcodebuild` doesn't run. Xcode needs installing and selecting first.
