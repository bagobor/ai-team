# AI Team M1: Engine Skeleton + Claude Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hand-written ticket runs in a fresh git worktree with a logged manifest, in an isolated agent home on the subscription login; checks run; the attempt FSM, event log and crash recovery work; a minimal Task detail UI shows the live log. This is spec §16's M1 and nothing beyond it.

**Architecture:** One Node daemon (`aiteamd`) owns SQLite and is the only writer. A deterministic scheduler moves tasks through pure FSM tables and spawns one `claude -p` process per attempt in a new worktree. Worker output is normalized into an append-only event log, which the REST + SSE server and the React UI read.

**Tech Stack:** TypeScript (strict, ESM), Hono + `@hono/node-server`, SQLite via `better-sqlite3` + Kysely, `yaml`, `ajv`, `picomatch`, React + Vite + TanStack Query, Vitest, `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-19-ai-team-orchestrator-design.md` (mockups: `2026-10-19-ai-team-ui-mockups.html`, same folder). Executors read both.

**Scope of this plan.** M1 of 8. Spec §16's milestones are sequential and each depends on what the previous one proves, so each gets its own plan, written when the previous one lands. See "After M1" at the end.

## Global Constraints

- "TypeScript end to end, on Node 22 LTS." `"engines": {"node": ">=22"}`. This machine has v25.9.0, so use no Node API newer than 22. `better-sqlite3@13` + Kysely + FTS5 were verified to load on 25.9.0.
- "The UI binds to `127.0.0.1` only. v1 has no authentication on the UI."
- "Code runs the workflow; models never route." Models never pick the next state, retry, merge or skip a gate.
- "Each attempt spawns a new CLI process in a new git worktree, with a manifest built for that attempt." "Sessions are never reused across tasks."
- "Output that doesn't match the role's schema becomes `invalid_output`. It's a failed attempt, never a partial success."
- "Raw transcripts are for debugging only. They're stored as JSONL files and never fed to another worker."
- "A retry attempt receives the *previous attempt's Change Report and the failure evidence*, never its transcript."
- "Cost figures are estimates unless the provider reports exact billing. The UI labels them that way."
- "Workers inherit an allow-listed set of environment variables." "Secrets never enter prompts or artifacts."
- "Workers only change their own worktree. The engine is the only writer to integration branches, `main` and the project state repo."
- "Stop with SIGINT; SIGTERM records no result."
- Budgets: `max_turns: 60, max_usd: 3.00, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000`; charter ≤ 600 tokens.
- Default parallelism 3 workers; attempt cap 3; failed attempts' worktrees kept 7 days.
- Project root is `/Users/ps/dev/ai-team`; run every command from there. No new dependency beyond those each task names.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **The daemon dies while a worker is alive, and the old PID may now belong to something else.** Our orphan worker is killed, the attempt becomes `interrupted`, and a new attempt runs in a new worktree; an unrelated process holding that PID survives. *(Task 11)*
2. **Claude's stream isn't what we expect:** non-JSON lines, unknown event types, lines after `result`, exit with no `result`, or `subtype:"success"` with `is_error:true`. The attempt ends with a named failure kind, the daemon stays up, and none of these counts as success. *(Task 7)*
3. **The agent home's login expires, or the usage window runs out mid-attempt.** Neither burns retries: an auth failure escalates with the exact login command; a usage limit makes the attempt `interrupted`, pauses the vendor until reset and doesn't count against the cap. *(Tasks 7, 9, 10)*
4. **The stakeholder keeps working in the target repo during a run:** dirty tree, staged files, another branch checked out, new commits on `main`. Their HEAD, index and working tree stay byte-identical, and their uncommitted changes never reach a worktree. *(Task 5)*
5. **Another page in the stakeholder's browser posts to the daemon** (CSRF or DNS rebinding). Tickets carry shell commands, so a forged ticket is code execution. Requests with a foreign `Host` or `Origin` get 403 and non-JSON writes get 415. *(Task 12)*

## File Structure

```
package.json  tsconfig.json  vitest.config.ts  .gitignore
seed/knowledge/roles/engineer/{role.yaml,charter.md}   seed/knowledge/schemas/change_report.json
scripts/probe-claude.ts   scripts/demo.ts   scripts/smoke-m1.ts
src/paths.ts              all ~/.aiteam path rules
src/config.ts             config.yaml + defaults
src/proc.ts               process groups, graceful kill, start-time check
src/events.ts             append-only event log + in-process subscribe
src/db/{schema,migrations,open}.ts
src/setup/{setup,doctor,isolation}.ts
src/git/{git,workspace,state-repo}.ts
src/roles/role.ts         src/tickets/ticket.ts
src/manifest/{tokens,build}.ts
src/adapters/{types,env,claude-args,claude-stream,claude-code}.ts
src/checks/run-checks.ts
src/engine/{fsm,store,intake,runner,scheduler,recovery,retention}.ts
src/server/app.ts         src/daemon.ts         src/cli.ts
web/{index.html,vite.config.ts}   web/src/{main.tsx,App.tsx,api.ts,logState.ts,styles.css}
web/src/pages/{TaskList,TaskDetail}.tsx   web/src/components/{LiveLog,ManifestTab,EvidenceTab}.tsx
test/...                  mirrors src/; test/fixtures/{fake-claude.mjs,claude/*.jsonl,tickets/*.md}; test/helpers/
```

---

### Task 1: Project skeleton, config and `aiteam setup`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/paths.ts`, `src/config.ts`, `src/setup/setup.ts`, `src/cli.ts`, `seed/knowledge/roles/engineer/role.yaml`, `seed/knowledge/roles/engineer/charter.md`, `seed/knowledge/schemas/change_report.json`
- Test: `test/config.test.ts`, `test/setup.test.ts`

**Interfaces:**
- Produces:
  - `resolvePaths(env?: NodeJS.ProcessEnv): Paths`, with `Paths = { root, db, config, knowledge, projects, worktrees, transcripts, claudeHome }`; root is `env.AITEAM_HOME ?? ~/.aiteam`
  - `stateRepoDir(p, project)`, `worktreePath(p, project, ticketId, k)`, `transcriptPath(p, project, attemptId)`, `manifestDir(p, project, ticketId, k)`, following spec §13; manifests go in `projects/<project>/manifests/<ticket>-a<k>/`
  - `loadConfig(p: Paths): Config`, with `Config = { port, maxWorkers, maxAttempts, attemptTimeoutS, checkTimeoutS, cancelGraceS, worktreeRetentionDays, claude: { binary: string; mode: 'subscription' | 'api-key'; extraEnv?: Record<string, string> } }`; YAML keys are snake_case, and `claude.extra_env` exists for tests
  - `runSetup(p: Paths, seedDir?: string): Promise<{ created: string[]; loginCommand: string }>`
  - `src/cli.ts`: `aiteam setup`, parsed with `node:util` `parseArgs`, printing the login command; later tasks add commands

- [ ] **Step 1: Create the branch and baseline commit**

The repo has no commits. Keep `main` unborn and start on a branch:

```bash
git switch -c m1-engine-skeleton
git add docs
git commit -m "docs: add AI Team spec, mockups, research and M1 plan"
```

- [ ] **Step 2: Add the toolchain**

`npm init` with `"type": "module"`, `"private": true`, `"engines": {"node": ">=22"}`, scripts `test: vitest run`, `typecheck: tsc`, `aiteam: tsx src/cli.ts`. M1 runs from source with `tsx`; packaging waits until there's something to distribute. Install `yaml`, and dev deps `typescript tsx vitest @types/node`. `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `module: NodeNext`, `target: ES2023`, `noEmit: true`, `include: ["src", "test", "scripts"]`. `.gitignore`: `node_modules/ web/dist/`.

- [ ] **Step 3: Write the failing tests**

```ts
// test/config.test.ts
it('applies spec defaults', () => {
  expect(loadConfig(resolvePaths({ AITEAM_HOME: emptyTmp }))).toEqual({
    port: 4780, maxWorkers: 3, maxAttempts: 3, attemptTimeoutS: 3600, checkTimeoutS: 600,
    cancelGraceS: 10, worktreeRetentionDays: 7, claude: { binary: 'claude', mode: 'subscription' } });
});
it('overlays snake_case keys', () => { /* config.yaml "max_workers: 5" */ expect(cfg.maxWorkers).toBe(5); });
it('rejects unknown keys by name', () => { /* "max_wrkers: 5" */ expect(load).toThrow(/max_wrkers/); });

// test/setup.test.ts
it('creates the knowledge repo and an empty agent home', async () => {
  const r = await runSetup(p);
  expect(existsSync(join(p.knowledge, '.git'))).toBe(true);
  expect(existsSync(join(p.knowledge, 'roles/engineer/role.yaml'))).toBe(true);
  expect(statSync(p.claudeHome).mode & 0o777).toBe(0o700);
  expect(readdirSync(p.claudeHome)).toEqual([]);
  expect(r.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${p.claudeHome} claude auth login`);
});
it('never overwrites a curated charter on re-run', async () => { /* edit charter, re-run, content unchanged */ });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run test/config.test.ts test/setup.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 5: Implement**

`role.yaml` is the spec §5.2 example verbatim. `charter.md` is written in plain language from the role's mission, and also says: don't commit (the engine snapshots your changes), don't touch `.aiteam/`, never push, and report evidence in the output schema (Task 6 tests the ≤ 600 token limit). `change_report.json`: required `summary` (string), `files_changed` (string[]), `commands_run` (array of `{ command: string, exit_code: integer }`); optional `notes` (string); `additionalProperties: false` at both levels. `runSetup` copies `seed/knowledge` only when `knowledge/` is absent, runs `git init` plus one commit there, and creates `agent-home/claude` with mode `0700`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run test/config.test.ts test/setup.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src seed test
git commit -m "feat: add project skeleton, config and setup command"
```

### Task 2: Isolation gate on the real CLI

Spec §6.2 names this M1's main risk. **If this task fails, stop and report; the fallback is API keys, which is the stakeholder's call.**

Already observed on CLI 2.1.109 (from a sandboxed shell, with no model call completed):
- `--max-turns` and `--append-system-prompt-file` are accepted though `--help` omits them. `--json-schema` takes a JSON **string**.
- `--allowedTools` only auto-approves: `init.tools` still listed every tool. `--tools` is needed too.
- The default home's `init` shows what must not leak: 18 plugins, 27 skills, 8 agents, `hook_started` events, and `memory_paths.auto` under `~/.claude`.
- An auth failure arrives as `subtype:"success"`, `is_error:true`, `result:"Not logged in · Please run /login"`, with exit code 1 and `error:"authentication_failed"` on the assistant message. Lines follow the `result` line.
- **The sandboxed agent shell reports `loggedIn:false` even for the default home,** so a login check from there proves nothing. Run this task's probe from the app's Terminal panel or with the sandbox off.

**Files:**
- Create: `src/setup/isolation.ts`, `scripts/probe-claude.ts`, `test/fixtures/claude/{success,max-turns,max-budget,auth-failed,sigint}.jsonl`, `docs/superpowers/notes/2026-10-30-claude-cli-contract.md`
- Test: `test/isolation.test.ts`

**Interfaces:**
- Consumes: `resolvePaths`, `runSetup`.
- Produces: `isolationViolations(init: ClaudeInit, ctx: { agentHome: string; allowedTools: string[]; userSkillNames: string[]; hookEventsSeen: boolean }): string[]`; the fixtures; the contract notes. **Where the notes contradict a flag or field in Task 7, the notes win and Task 7 is updated.**

- [ ] **Step 1: Write the failing test**

```ts
const clean = { apiKeySource: 'none', mcp_servers: [], plugins: [], skills: ['simplify'], agents: ['Explore'],
  slash_commands: [], tools: ['Read', 'StructuredOutput'], memory_paths: {} };
const ctx = { agentHome: '/h/agent-home/claude', allowedTools: ['Read', 'StructuredOutput'], userSkillNames: ['mine'], hookEventsSeen: false };
it('accepts a clean init', () => expect(isolationViolations(clean, ctx)).toEqual([]));
it('names each leak', () => {
  expect(isolationViolations({ ...clean, plugins: [{ name: 'p' }], skills: ['mine', 'plug:x'],
    memory_paths: { auto: '/Users/ps/.claude/projects/x/memory/' }, tools: ['Read', 'Task'], apiKeySource: 'ANTHROPIC_API_KEY' },
    { ...ctx, hookEventsSeen: true }).sort()).toEqual(['apiKeySource', 'hooks', 'memory_paths.auto', 'plugins', 'skills', 'tools']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/isolation.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `isolationViolations` and the probe**

A skill, agent or slash-command name violates when it contains `:` (plugin scoped) or appears in `userSkillNames`. `memory_paths.auto` is allowed only if absent or under `agentHome`. The probe reads `userSkillNames` from `~/.claude/skills/*` and never prints file contents.

`scripts/probe-claude.ts` calls `runSetup`, creates a throwaway git repo under `$AITEAM_HOME/probe-repo`, and spawns with only the env named in Task 7's `workerEnv`. The argv is:

```
claude -p --output-format stream-json --verbose --model haiku
  --append-system-prompt-file <tmp>/system.md --json-schema '<schema>'
  --tools Read,Glob,Grep,Edit,Write,Bash --allowedTools Read,Glob,Grep,Edit,Write,Bash
  --permission-mode dontAsk --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --max-turns 6 --max-budget-usd 0.25
  --settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":[]}}}'
```

Runs, with fixtures written after replacing the home path with `/HOME` and the temp path with `/WORK`:
1. `success`: prompt "Read README.md, run `echo canary > <root>/outside-bash.txt` with Bash, create `<root>/outside-write.txt` with Write, then return `{ok:true}`", where `<root>` is outside the throwaway repo.
2. `max-turns` (`--max-turns 1`, prompt needing a tool).
3. `max-budget` (`--max-budget-usd 0.0001`).
4. `auth-failed` (an empty temp config dir).
5. `sigint` (SIGINT after the first `assistant` line; record whether a `result` line arrives).

Pass criteria, each printed: `auth status` reports `loggedIn:true` under the agent home (print only that and `authMethod`, never account details); `isolationViolations` is `[]` for the success run; `subtype:"success"`, `is_error:false`, and `structured_output` is present; neither outside file exists. §14 says engineers write inside the worktree only, and the sandbox covers Bash but may not cover Edit and Write. If only `outside-write.txt` exists, scope the rules to `Edit(./**)` and `Write(./**)`, update Task 7's pinned argv, and re-run. The last line is `ISOLATION PASS` or `ISOLATION FAIL: <names>`, with a matching exit code.

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run test/isolation.test.ts`
Expected: PASS.

- [ ] **Step 5: Stakeholder logs in (Human Task)**

Ask the stakeholder to run this once in their own terminal; agents never handle credentials:

```bash
npm run aiteam -- setup
```

```bash
CLAUDE_CONFIG_DIR=~/.aiteam/agent-home/claude claude auth login
```

- [ ] **Step 6: Run the probe outside the sandbox**

Run: `npx tsx scripts/probe-claude.ts`
Expected: last line `ISOLATION PASS`, estimated spend under $0.50. On `ISOLATION FAIL`, stop and report the printed names to the stakeholder.

- [ ] **Step 7: Record the contract and commit**

Write what was verified into the notes file: flags, every `result.subtype` seen, the field holding structured output, the cost and usage fields, the `init` fields, and SIGINT behavior.

```bash
git add src/setup/isolation.ts scripts/probe-claude.ts test docs/superpowers/notes
git commit -m "feat: prove worker isolation on the subscription login and record the CLI contract"
```

### Task 3: SQLite store and append-only event log

**Files:**
- Create: `src/db/schema.ts`, `src/db/migrations.ts`, `src/db/open.ts`, `src/events.ts`
- Test: `test/events.test.ts`

**Interfaces:**
- Produces:
  - `openDb(path: string): Promise<Kysely<DB>>`: WAL, `foreign_keys=ON`, `busy_timeout=5000`, runs Kysely `Migrator` with an in-code provider
  - `class EventLog { constructor(db); append(e: NewEvent): Promise<EventRow>; list(q: { taskId?: number; afterSeq?: number; limit?: number }): Promise<EventRow[]>; subscribe(fn: (e: EventRow) => void): () => void; subscriberCount(): number }`
  - `EventRow = { seq, ts, projectId, taskId, attemptId, type: EventType, payload }`
  - `EventType = 'task.state' | 'attempt.state' | 'manifest.built' | 'worker.init' | 'worker.message' | 'worker.tool_call' | 'worker.tool_result' | 'worker.usage' | 'worker.error' | 'check.started' | 'check.finished' | 'vendor.paused' | 'recovery.interrupted'`

Schema (JSON columns are TEXT):

```
projects(id PK, name UNIQUE, repo_path, base_branch, created_at)
tasks(id PK, project_id FK, ticket_id, title, milestone, role_id, state, blocked_on NULL, escalation_reason NULL,
      ticket_path, ticket_sha, touches, depends_on, dod, created_at, updated_at, UNIQUE(project_id, ticket_id))
attempts(id PK, task_id FK, k, state, adapter, model, session_id NULL, pid NULL, pid_started_at NULL, worktree_path,
         branch, base_sha NULL, manifest NULL, output NULL, failure_kind NULL, failure_evidence NULL, usage NULL,
         started_at, ended_at NULL, worktree_removed_at NULL, UNIQUE(task_id, k))
events(seq INTEGER PK AUTOINCREMENT, ts, project_id NULL, task_id NULL, attempt_id NULL, type, payload)
vendor_pauses(vendor PK, until, backoff_s, reason)
```

Triggers `BEFORE UPDATE` and `BEFORE DELETE ON events` raise `events are append-only`.

- [ ] **Step 1: Write the failing test**

```ts
it('assigns increasing seq and filters by task and afterSeq', async () => {
  const a = await log.append({ taskId: 1, type: 'task.state', payload: { to: 'ready' } });
  const b = await log.append({ taskId: 2, type: 'task.state', payload: { to: 'ready' } });
  const c = await log.append({ taskId: 1, type: 'task.state', payload: { to: 'running' } });
  expect(b.seq).toBeGreaterThan(a.seq);
  expect((await log.list({ taskId: 1, afterSeq: a.seq })).map(e => e.seq)).toEqual([c.seq]);
});
it('refuses update and delete', async () => {
  await expect(sql`update events set type = 'x'`.execute(db)).rejects.toThrow(/append-only/);
  await expect(sql`delete from events`.execute(db)).rejects.toThrow(/append-only/);
});
it('notifies subscribers after commit and stops after unsubscribe', async () => { /* row is readable inside the callback */ });
it('keeps rows across reopen and migrates idempotently', async () => { /* close, openDb same file, list */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/events.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the schema, migration, `openDb` and `EventLog`**

Install `better-sqlite3 kysely`, dev `@types/better-sqlite3`. A subscriber that throws must not break `append` or other subscribers.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db src/events.ts test/events.test.ts package.json package-lock.json
git commit -m "feat: add SQLite store and append-only event log"
```

### Task 4: State machines and the single-writer store

**Files:**
- Create: `src/engine/fsm.ts`, `src/engine/store.ts`
- Test: `test/fsm.test.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: `openDb`, `EventLog`.
- Produces:
  - `TaskState`, `AttemptState`, `TASK_TRANSITIONS`, `ATTEMPT_TRANSITIONS`, `class IllegalTransition`, `assertTaskTransition(from, to)`, `assertAttemptTransition(from, to)`
  - `class Store` with `createProject`, `getProject(name)`, `listProjects`, `createTask(NewTask)`, `getTask(id)`, `getTaskByTicket(projectId, ticketId)`, `listTasks(projectId?)`, `setTaskState(id, to, detail?: { blockedOn?: string; reason?: string })`, `createAttempt(NewAttempt)`, `setAttemptState(id, to, patch?: Partial<AttemptRow>)`, `patchAttempt(id, patch)`, `listAttempts(taskId)`, `listLiveAttempts()`, `failedAttemptCount(taskId)`, `getVendorPause(vendor)`, `setVendorPause(p: { vendor: string; until: string; backoff_s: number; reason: string })`, `clearVendorPause(vendor)`

Transitions, from spec §7.2:

| From | To |
|---|---|
| queued | ready, blocked, escalated, cancelled |
| ready | running, blocked, escalated, cancelled |
| running | checks, ready, blocked, escalated, cancelled |
| checks | review, ready, blocked, escalated, cancelled |
| review | qa, done, ready, blocked, escalated, cancelled |
| qa | done, ready, blocked, escalated, cancelled |
| blocked | ready, escalated, cancelled |
| escalated | ready, cancelled |
| done, cancelled | (terminal) |

Attempts: `starting → running | failed | cancelled | interrupted`; `running → succeeded | failed | timeout | budget_exceeded | invalid_output | cancelled | interrupted`; the rest are terminal. **An attempt stays `running` while its task is in `checks`,** and becomes `succeeded` only when checks pass, because §7.2 says any check failure means the attempt failed.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([['running','checks'],['checks','review'],['escalated','ready'],['blocked','ready'],['review','done']])
  ('allows %s → %s', (a, b) => expect(() => assertTaskTransition(a, b)).not.toThrow());
it.each([['done','ready'],['queued','done'],['cancelled','ready'],['escalated','running']])
  ('rejects %s → %s', (a, b) => expect(() => assertTaskTransition(a, b)).toThrow(IllegalTransition));
it('attempt succeeded is terminal', () => expect(() => assertAttemptTransition('succeeded', 'failed')).toThrow(IllegalTransition));
it('interrupted reachable from running', () => expect(() => assertAttemptTransition('running', 'interrupted')).not.toThrow());

// store
it('writes state and event atomically', async () => { /* setTaskState → row updated and one task.state {from,to} event */ });
it('illegal transition changes nothing', async () => { /* state and event count unchanged */ });
it('numbers attempts per task from 1', async () => { /* k = 1, 2; other task starts at 1 */ });
it('counts only real failures', async () => {
  // failed, timeout, budget_exceeded, invalid_output count; interrupted and cancelled do not
  expect(await store.failedAttemptCount(task.id)).toBe(4);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/fsm.test.ts test/store.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `fsm.ts` and `store.ts`**

State change and its event go in one transaction. The FSM check reads the current state inside that transaction.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/fsm.test.ts test/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine test/fsm.test.ts test/store.test.ts
git commit -m "feat: add task and attempt state machines and the engine store"
```

### Task 5: Workspace manager and project state repo

**Files:**
- Create: `src/git/git.ts`, `src/git/workspace.ts`, `src/git/state-repo.ts`, `test/helpers/repo.ts`
- Test: `test/workspace.test.ts`, `test/state-repo.test.ts`

**Interfaces:**
- Produces:
  - `git(cwd: string, args: string[], opts?): Promise<{ stdout: string; stderr: string; code: number }>`
  - `prepareRepo(repoPath: string, opts: { create: boolean }): Promise<{ baseBranch: string }>`
  - `ensureIntegrationBranch(repoPath, milestone: number, baseBranch): Promise<{ branch: string; headSha: string }>`
  - `addAttemptWorktree(repoPath, wtPath, branch, baseSha): Promise<void>`
  - `snapshotAttempt(wtPath, message): Promise<{ headSha: string }>`
  - `changedPaths(wtPath, baseSha): Promise<string[]>`
  - `removeAttemptWorktree(repoPath, wtPath, branch): Promise<void>`
  - `pruneGitWorktrees(repoPath): Promise<void>`
  - `initStateRepo(dir): Promise<void>`, `commitArtifact(dir, relPath, content, message): Promise<{ sha: string }>`
  - `makeRepo(): Promise<{ path: string; headSha: string }>` (test helper)

Pinned: the integration branch is `aiteam/m<n>`; attempt branches are `aiteam/attempt/<ticket>-a<k>`. The engine never runs `checkout` or `switch` in the target repo: branches come from `git branch <name> <sha>`, worktrees from `git worktree add`. Engine commits run as `git -c user.name=aiteam -c user.email=aiteam@localhost -c core.hooksPath=/dev/null`. `changedPaths` uses `--no-renames` so both sides of a rename are checked.

- [ ] **Step 1: Write the failing tests**

```ts
// Review Focus 4
it('leaves a working repo byte-identical through a full attempt', async () => {
  // on branch "feature", with one staged file, one modified file, one untracked file
  const before = [await porcelain(repo), await symbolicHead(repo), await revParse(repo)];
  const { headSha } = await ensureIntegrationBranch(repo, 1, 'main');
  await addAttemptWorktree(repo, wt, 'aiteam/attempt/T-1-a1', headSha);
  writeFileSync(join(wt, 'new.txt'), 'x');
  await snapshotAttempt(wt, 'aiteam: T-1 a1');
  await removeAttemptWorktree(repo, wt, 'aiteam/attempt/T-1-a1');
  expect([await porcelain(repo), await symbolicHead(repo), await revParse(repo)]).toEqual(before);
});
it('worktree never contains uncommitted stakeholder changes', async () => { /* dirty file has committed content in wt */ });
it('does not move the integration branch when main advances', async () => { /* second ensure returns same sha */ });
it('snapshots modified, deleted and untracked files, honouring .gitignore', async () => {
  expect((await changedPaths(wt, base)).sort()).toEqual(['deleted.txt', 'edited.txt', 'new.txt']);
});
it('snapshot survives a failing repo pre-commit hook', async () => { /* .git/hooks/pre-commit exits 1 */ });
it('reports both sides of a rename', async () => { expect(paths.sort()).toEqual(['a.txt', 'b.txt']); });
it('prepareRepo: non-git path without create throws', async () => { await expect(p).rejects.toThrow(/not a git repository/); });
it('prepareRepo: create makes a repo with a root commit', async () => { /* git log has 1 commit; baseBranch returned */ });
it('prepareRepo: an existing repo with no commits gets an empty root commit', async () => { /* no files added */ });
it('removeAttemptWorktree is idempotent and deletes the branch', async () => { /* second call resolves */ });

// test/state-repo.test.ts
it('commitArtifact returns the HEAD sha', async () => { expect(sha).toBe(await revParse(dir)); });
it('identical content is not an error and returns HEAD', async () => { /* same sha, one commit */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/workspace.test.ts test/state-repo.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`snapshotAttempt` is `git add -A`, then a commit only if the index differs from HEAD. A worker running in the sandbox can't commit from a worktree, since the git metadata lives in the main repo, which is why the charter says the engine commits.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/workspace.test.ts test/state-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git test/workspace.test.ts test/state-repo.test.ts test/helpers
git commit -m "feat: add attempt worktrees and the project state repo"
```

### Task 6: Roles, tickets, intake and the budgeted manifest

**Files:**
- Create: `src/roles/role.ts`, `src/tickets/ticket.ts`, `src/manifest/tokens.ts`, `src/manifest/build.ts`, `src/engine/intake.ts`, `test/fixtures/tickets/T-1.md`
- Test: `test/ticket.test.ts`, `test/role.test.ts`, `test/manifest.test.ts`, `test/intake.test.ts`

**Interfaces:**
- Consumes: `Store`, `initStateRepo`, `commitArtifact`, `prepareRepo`, `stateRepoDir`.
- Produces:
  - `estimateTokens(s: string): number`, which is `Math.ceil(s.length / 3.5)` (deliberately conservative; there's no offline tokenizer)
  - `Role`, `Budgets` (keys as in §5.2), `RoleTool = 'read_repo' | 'edit_repo' | 'run_commands' | { network: 'restricted' }`, `loadRole(knowledgeDir, roleId): Promise<{ role: Role; charter: string; schema: object }>`
  - `Ticket = { id, title, milestone: number, ac_refs: string[], specialty, touches: string[], depends_on: string[], definition_of_done: string[], inputs: string[], size: 'S'|'M'|'L', body: string }`, `parseTicket(markdown): Ticket`, `class TicketError`
  - `TaskManifest = { project, ticketId, attemptK, roleId, adapter, model, budgets, tools, system, task, outputSchema, writeScope, parts: ManifestPart[], totalTokens, contextBudget, flags?: readonly string[] }`
  - `ManifestPart = { name: 'charter'|'playbook'|'memory'|'task_inputs'|'output_contract'|'repo_instructions'; tokens: number; budget: number | null; sources: string[] }`
  - `buildManifest(i: BuildInput): BuildResult`, with `BuildResult = { ok: true; manifest } | { ok: false; reason: 'context_over_budget'; parts; totalTokens }`
  - `readRepoInstructions(worktree): Promise<{ path: string; content: string }[]>` and `findAncestorInstructions(dir): Promise<string[]>`
  - `addProject(deps, { name, repoPath, create }): Promise<ProjectRow>`, `addTicket(deps, projectName, markdown): Promise<TaskRow>`

Pinned rules:
- Ticket and project IDs match `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`, since they become paths and branch names.
- A non-empty `inputs` is rejected in M1 with `inputs are not supported until M2`.
- `definition_of_done` and `touches` must be non-empty.
- `depends_on` must name tickets already imported, which rules out cycles.
- Playbook and memory parts are present with `tokens: 0` and their §8.5 budgets. M4 fills them.
- `repo_instructions` counts `CLAUDE.md`, `.claude/CLAUDE.md` and `AGENTS.md` in the worktree, plus any `CLAUDE.md` or `AGENTS.md` in ancestor directories. Those files load by themselves, so they count against the budget but aren't copied into the prompt.
- Retry evidence is cut from its start to fit the remaining budget, with the marker `[… N chars trimmed]`. It can never push a manifest over budget.

- [ ] **Step 1: Write the failing tests**

```ts
it('estimates tokens', () => expect(estimateTokens('abcdefg')).toBe(2));
it('seed charter is within 600 tokens', async () => {
  const { charter } = await loadRole(seedKnowledge, 'engineer');
  expect(estimateTokens(charter)).toBeLessThanOrEqual(600);
});
it('rejects an oversized charter', async () => { /* 3000 chars */ await expect(p).rejects.toThrow(/charter.*600/); });
it('loads §5.2 budgets', async () => expect(role.defaults.budgets).toEqual(
  { max_turns: 60, max_usd: 3, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000 }));

it('parses required ticket fields', () => expect(parseTicket(t1).definition_of_done).toEqual(['node --test']));
it.each(['ac_refs','specialty','touches','depends_on','definition_of_done','inputs','size'])
  ('requires %s', f => expect(() => parseTicket(without(t1, f))).toThrow(new RegExp(f)));
it('rejects a path-traversing id', () => expect(() => parseTicket(withId(t1, '../x'))).toThrow(TicketError));
it('rejects inputs until M2', () => expect(() => parseTicket(withInputs(t1, ['SPEC-M1']))).toThrow(/until M2/));

it('reports each part with budget', () => {
  const r = buildManifest(input); if (!r.ok) throw 0;
  const by = Object.fromEntries(r.manifest.parts.map(p => [p.name, p]));
  expect(by.playbook).toMatchObject({ tokens: 0, budget: 2000 });
  expect(by.memory).toMatchObject({ tokens: 0, budget: 1000 });
  expect(by.charter.budget).toBe(600);
  expect(r.manifest.contextBudget).toBe(12000);
});
it('fails when the ticket is too large', () => expect(buildManifest({ ...input, ticketMarkdown: 'x'.repeat(60000) })).toMatchObject({ ok: false, reason: 'context_over_budget' }));
it('counts repo instructions without copying them', () => { /* 70000-char CLAUDE.md → over budget; 700 chars → tokens 200, not in task or system */ });
it('fits 5 MB of evidence and keeps its tail', () => {
  const r = buildManifest({ ...input, retry: { evidence: 'a'.repeat(5e6) + 'LAST', changeReport: { summary: 's' } } });
  if (!r.ok) throw 0;
  expect(r.manifest.totalTokens).toBeLessThanOrEqual(12000);
  expect(r.manifest.task).toContain('LAST'); expect(r.manifest.task).toMatch(/chars trimmed/);
});
it('finds instruction files above the worktree', async () => { /* CLAUDE.md in tmp parent */ expect(found).toContain(parentFile); });

// intake
it('commits the ticket first, then records its sha', async () => {
  const t = await addTicket(deps, 'p', t1);
  expect(t.ticket_sha).toBe(await revParse(stateRepoDir(paths, 'p')));
  expect(t.state).toBe('queued');
});
it('rejects a duplicate ticket without a new commit', async () => { /* TicketError, HEAD unchanged */ });
it('rejects an unknown dependency', async () => { await expect(p).rejects.toThrow(/T-9/); });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/ticket.test.ts test/role.test.ts test/manifest.test.ts test/intake.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`system` is the charter plus an `## Output contract` section naming the schema, the write scope and the definition of done. `task` is the ticket, plus `## Previous attempt` (Change Report and evidence) on a retry. Install `ajv` for schema compile checks at role load. `addProject` runs `prepareRepo`, then `initStateRepo`; `addTicket` writes `artifacts/ticket/<id>.md`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/ticket.test.ts test/role.test.ts test/manifest.test.ts test/intake.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/roles src/tickets src/manifest src/engine/intake.ts test package.json package-lock.json
git commit -m "feat: add roles, ticket intake and the budgeted manifest"
```

### Task 7: Claude Code adapter

**Files:**
- Create: `src/proc.ts`, `src/adapters/types.ts`, `src/adapters/env.ts`, `src/adapters/claude-args.ts`, `src/adapters/claude-stream.ts`, `src/adapters/claude-code.ts`, `test/fixtures/fake-claude.mjs`, `test/fixtures/claude/{usage-limit,garbled}.synthetic.jsonl`
- Test: `test/adapters/args.test.ts`, `test/adapters/stream.test.ts`, `test/adapters/process.test.ts`

**Interfaces:**
- Consumes: `TaskManifest`, the Task 2 fixtures and contract notes.
- Produces (spec §6.1, with the additions marked):
  ```ts
  interface WorkerAdapter {
    id: string; vendor: string;                                     // + vendor
    capabilities: { repoTools: boolean; structuredOutput: boolean; resume: boolean;
                    costReport: 'exact' | 'estimate' | 'none'; sandbox: 'os' | 'flags' | 'none' };
    preflight(): Promise<{ ok: true } | { ok: false; reason: string; fix: string }>;   // +
    start(m: TaskManifest, ws: Workspace): AttemptHandle;
  }
  interface AttemptHandle { events: AsyncIterable<WorkerEvent>; cancel(): Promise<void>;
                            result: Promise<AttemptResult>; pid?: number; argv: readonly string[] }  // + pid, argv
  type Workspace = { path: string; transcriptPath: string; manifestDir: string };
  type Usage = { inTok: number; outTok: number; cachedTok?: number; usdEst?: number };
  type FailureKind = 'auth_required' | 'max_turns' | 'no_result' | 'no_structured_output' | 'worker_error' | 'spawn_error';
  type AttemptResult = { status: 'succeeded' | 'failed' | 'timeout' | 'budget_exceeded' | 'cancelled' | 'invalid_output'
                               | 'usage_limited';                   // + maps to attempt state `interrupted`
                         output?: unknown; usage: Usage; sessionId?: string;
                         failureKind?: FailureKind; message?: string; resetAt?: string };   // +
  ```
  `WorkerEvent` is exactly as in §6.1.
  - `workerEnv(parent: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string>`: allow-list `PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, LC_CTYPE, TERM`
  - `buildClaudeInvocation(m, ws, cfg): { argv: string[]; env: Record<string, string> }`
  - `class ClaudeStreamParser { constructor(schema: object); push(line: string): WorkerEvent[]; finish(exit: { code: number | null; signal: string | null; stderrTail: string }): AttemptResult }`
  - `class ClaudeCodeAdapter implements WorkerAdapter`, constructed with `ClaudeAdapterConfig = { binary, agentHome, mode, graceS, timeoutS, parentEnv?, extraEnv? }`
  - `spawnGroup`, `killGroup(pid, graceS): Promise<void>`, `processStartTime(pid): Promise<string | null>` (from `ps -o lstart= -p <pid>`) in `src/proc.ts`
  - `test/fixtures/fake-claude.mjs`: answers `auth status` from `FAKE_AUTH` (default `{"loggedIn":true,"authMethod":"claude.ai"}`). Otherwise it appends to `FAKE_SPAWN_LOG`, picks `steps[spawnCount]` from the JSON at `FAKE_SCRIPT`, and does what it says: `{ writeFiles?: Record<string,string>, lines?: string[] | fixture?: string, delayMs?, ignoreSigint?, spawnChild?, dumpEnvTo?, dumpStdinTo?, exitCode? }`

Result mapping:

| Stream | `AttemptResult` |
|---|---|
| `success`, not `is_error`, `structured_output` valid | `succeeded`, `output` set |
| `success`, valid JSON failing the role schema | `invalid_output` |
| `success`, no `structured_output` | `failed` / `no_structured_output` |
| `is_error` with `/not logged in\|please run \/login/i`, or `assistant.error == "authentication_failed"` | `failed` / `auth_required` |
| `rate_limit_event` with `status:"rejected"`, or `is_error` with `/usage limit\|hit your limit/i`, or `api_error_status: 429` | `usage_limited`, `resetAt` as ISO when given |
| `error_max_turns` | `failed` / `max_turns` |
| `error_max_budget_usd` | `budget_exceeded` |
| `error_max_structured_output_retries` | `invalid_output` |
| any other `error_*`, or `is_error` | `failed` / `worker_error`, `message` set |
| exit with no `result` line | `failed` / `no_result`, `message` = stderr tail |
| spawn error (ENOENT) | `failed` / `spawn_error` |

`capabilities` for M1: `{ repoTools: true, structuredOutput: true, resume: false, costReport: 'estimate', sandbox: 'os' }`. Turn-cap continuation arrives with M3.

- [ ] **Step 1: Write the failing tests**

```ts
// args
it('builds the §6.2 subscription invocation', () => {
  const { argv, env } = buildClaudeInvocation(manifest, ws, cfg);
  expect(argv).toEqual(['-p', '--output-format', 'stream-json', '--verbose',
    '--model', 'claude-sonnet-5-5',
    '--append-system-prompt-file', `${ws.manifestDir}/system.md`,
    '--json-schema', JSON.stringify(manifest.outputSchema),
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep,Edit,Write,Bash', '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--max-turns', '60', '--max-budget-usd', '3',
    '--settings', '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":[]}}}']);
  expect(env.CLAUDE_CONFIG_DIR).toBe(cfg.agentHome);
  expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
});
it('adds --bare only in api-key mode', () => { /* subscription: absent; api-key: present */ });
it('strips secrets and nesting vars', () => {
  const e = workerEnv({ PATH: '/b', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', AWS_SECRET_ACCESS_KEY: 's' });
  expect(e).toEqual({ PATH: '/b' });
});

// stream: Review Focus 2 and 3
it('normalizes the real success stream', () => {
  const { events, result } = replay('success.jsonl');
  expect(events[0]).toMatchObject({ t: 'init' });
  expect(events.some(e => e.t === 'tool_call' && e.name === 'Read')).toBe(true);
  expect(events.some(e => e.t === 'tool_result' && e.name === 'Read')).toBe(true);
  expect(result.status).toBe('succeeded');
  expect(result.usage.usdEst).toBeGreaterThanOrEqual(0);
});
it('treats real auth failure as auth_required', () => expect(replay('auth-failed.jsonl').result).toMatchObject({ status: 'failed', failureKind: 'auth_required' }));
it('maps real max-turns and max-budget', () => { /* failed/max_turns; budget_exceeded */ });
it('survives garbage', () => {
  // garbled.synthetic: non-JSON line, unknown type, hook_started, 1 MB line, success result, lines after result
  const { events, result } = replay('garbled.synthetic.jsonl');
  expect(events.filter(e => e.t === 'error').length).toBe(1);
  expect(result.status).toBe('succeeded');
});
it('first result wins', () => { /* a second result line does not overwrite */ });
it('no result line means failure', () => {
  const p = new ClaudeStreamParser(schema);
  expect(p.finish({ code: 1, signal: null, stderrTail: 'boom' })).toMatchObject({ status: 'failed', failureKind: 'no_result', message: 'boom' });
});
it('rejects schema-invalid output', () => { /* success + structured_output {nope:1} → invalid_output */ });
it('maps a usage limit with its reset time', () => expect(replay('usage-limit.synthetic.jsonl').result).toMatchObject({ status: 'usage_limited', resetAt: '2026-10-30T15:00:00.000Z' }));

// process (fake-claude)
it('runs in the worktree, feeds task.md on stdin, keeps a raw transcript', async () => { /* cwd, stdin dump, transcript line count */ });
it('passes only the allow-listed env', async () => { /* parentEnv has ANTHROPIC_API_KEY, dump lacks it */ });
it('cancel sends SIGINT and reports cancelled', async () => { /* fake records SIGINT */ });
it('escalates to SIGKILL after grace', async () => { /* ignoreSigint, graceS: 1, resolves within 3 s */ });
it('kills grandchildren', async () => { /* spawnChild pid is gone after cancel */ });
it('reports timeout', async () => { /* timeoutS: 1, delayMs: 60000 → status timeout */ });
it('handles a missing binary', async () => { /* failed/spawn_error, events iterable ends */ });
it('preflight reports logged out with the login command', async () => {
  expect(await a.preflight()).toMatchObject({ ok: false, fix: `CLAUDE_CONFIG_DIR=${home} claude auth login` });
});
it('preflight reports a missing binary', async () => { /* ok:false, reason mentions the binary */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/adapters`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`usage-limit.synthetic.jsonl` is hand-written, because a real limit can't be provoked on demand, and its filename says so. When a real one is first observed, replace it. Spawn with `detached: true` so the worker leads its own process group; `killGroup` signals `-pid`. Stdin comes from `<manifestDir>/task.md`. Read stdout by line, append each raw line to the transcript, and feed the parser. The parser keeps a `tool_use_id → name` map and caps `tool_result.summary` at 500 chars.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/adapters`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proc.ts src/adapters test/adapters test/fixtures
git commit -m "feat: add the Claude Code adapter with normalized events"
```

### Task 8: Deterministic checks

**Files:**
- Create: `src/checks/run-checks.ts`
- Test: `test/checks.test.ts`

**Interfaces:**
- Consumes: `changedPaths`, `workerEnv`, `spawnGroup`, `killGroup`.
- Produces:
  - `CheckRun = { command: string; exitCode: number | null; timedOut: boolean; durationMs: number; outputTail: string }`
  - `ChecksResult = { ok: true; runs: CheckRun[] } | { ok: false; kind: 'no_changes' | 'scope_violation' | 'check_failed'; runs: CheckRun[]; evidence: string; violations?: string[] }`
  - `runChecks(i: { worktree: string; baseSha: string; writeScope: { allow: string[]; deny: string[] }; commands: string[]; timeoutS: number; onEvent: (type: EventType, payload: unknown) => void; onSpawn?: (pid: number) => void; signal?: AbortSignal }): Promise<ChecksResult>`

Order: changed paths (empty means `no_changes`, since an engineer ticket that changes nothing hasn't been done), then write scope, then commands, stopping at the first failure. `.aiteam/**` always violates, whatever the role allows. `picomatch` runs with `{ dot: true }`, and deny beats allow. `outputTail` is the last 8,000 chars of merged stdout and stderr, kept in a bounded buffer. `onSpawn` reports each command's process group so the attempt can record it for crash recovery. Aborting `signal` kills the running command and stops.

- [ ] **Step 1: Write the failing test**

```ts
it('passes when commands pass and paths are in scope', async () => { expect(r.ok).toBe(true); expect(r.runs[0].exitCode).toBe(0); });
it('fails on no changes without running commands', async () => { expect(r).toMatchObject({ ok: false, kind: 'no_changes', runs: [] }); });
it('.aiteam is always a violation', async () => {
  expect(r).toMatchObject({ ok: false, kind: 'scope_violation', violations: ['.aiteam/x.md'] });
});
it('deny beats allow; dotfiles match', async () => { /* allow ** deny secrets/** */ });
it('stops at the first failing command', async () => { /* second command would create a sentinel; sentinel absent */ });
it('kills a command at the timeout', async () => {
  // "sleep 100", timeoutS: 1
  expect(r.runs[0].timedOut).toBe(true); expect(r.kind).toBe('check_failed');
});
it('aborting stops the running command', async () => { /* "sleep 100", abort after onSpawn → resolves within 3 s, pid gone */ });
it('keeps only the tail of huge output', async () => {
  // prints 5 MB then END
  expect(r.runs[0].outputTail.length).toBeLessThanOrEqual(8000); expect(r.runs[0].outputTail).toContain('END');
});
it('runs with the allow-listed env', async () => { /* parent ANTHROPIC_API_KEY not visible to the command */ });
it('emits check.started and check.finished', async () => { /* onEvent order */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/checks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `runChecks` in `src/checks/run-checks.ts`**

Install `picomatch` and `@types/picomatch`. Commands run through `sh -c` in the worktree as their own process group.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/checks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/checks test/checks.test.ts package.json package-lock.json
git commit -m "feat: add definition-of-done and write-scope checks"
```

### Task 9: Attempt runner

**Files:**
- Create: `src/engine/runner.ts`, `test/helpers/engine.ts`
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–8.
- Produces:
  - `EngineDeps = { db, store, log, paths, config, adapters: Record<string, WorkerAdapter>, now?: () => Date }`
  - `class Runner { constructor(deps); begin(taskId): Promise<void>; execute(taskId): Promise<void>; cancel(taskId): Promise<void>; retry(taskId): Promise<void>; shutdown(): Promise<void>; liveCount(): number }`
  - `AttemptFailureKind = FailureKind | 'check_failed' | 'scope_violation' | 'no_changes' | 'context_over_budget' | 'engine_error'`
  - Test helpers in `test/helpers/engine.ts`, over a temp `AITEAM_HOME`, a `makeRepo` target and `fake-claude`: `makeEngine(opts: { steps: unknown[]; config?: Partial<Config> }): Promise<EngineDeps & { runner: Runner; spawnCount(): number; addTicket(markdown: string): Promise<TaskRow>; cleanup(): Promise<void> }>`; `runToSettled(e, taskId)`, which drives `begin` and `execute` until the task is `review`, `escalated` or `cancelled`; `okStep(files: Record<string, string>)`, a fake-claude step that writes the files and ends with a valid Change Report; `ticket(overrides)`, which returns ticket Markdown; `eventTypes(e, taskId)`

`begin` moves `ready → running` and is awaited by the scheduler, so the live count is right before the next start. `execute` is everything else and never rejects:

1. `adapter.preflight()`. On failure the task goes `escalated`, reason `agent_home_not_logged_in`, carrying the fix. No attempt row.
2. `loadRole`, `ensureIntegrationBranch`. On failure: `escalated`, reason `workspace_error` (a retry can't fix a moved repo).
3. Create the attempt (`starting`) and `addAttemptWorktree`, then read repo instructions and build the manifest. Over budget: attempt `failed` / `context_over_budget`, task `escalated`, no worker spawned.
4. Write `system.md`, `task.md`, and `manifest.built`. `start`; store `pid`, `pid_started_at`, and the manifest with `flags = handle.argv`; attempt → `running`. Pump events into `worker.*`, capping any string in a payload at 4,000 chars (the transcript keeps everything).
5. Act on the result:

| Result | Attempt | Task |
|---|---|---|
| `succeeded` | stays `running` | `checks` → snapshot → `runChecks` |
| checks pass | `succeeded` | `review` (parks here until M2 adds the Code Reviewer) |
| checks fail | `failed`, kind and evidence stored | retry-or-escalate |
| `failed`, `timeout`, `budget_exceeded`, `invalid_output` | same status | retry-or-escalate |
| `failed` / `auth_required` | `failed` | `escalated`, with the login fix; no retry |
| `usage_limited` | `interrupted` | `ready`; vendor paused (below) |
| `cancelled` during `cancel()` | `cancelled` | `cancelled`; worktree and branch removed |
| `cancelled` during `shutdown()` | `interrupted` | `ready` |

Retry-or-escalate: `failedAttemptCount ≥ maxAttempts` means `escalated`, reason `attempts_exhausted`; otherwise `ready`. A human `retry` moves `escalated → ready` and doesn't reset the count, so each human retry grants one more attempt. An exception anywhere in `execute` means attempt `failed` / `engine_error` and task `escalated`, so a task can never stick in `running`.

During checks, `onSpawn` overwrites the attempt's `pid` and `pid_started_at`, so recovery kills a running check too. `cancel` and `shutdown` abort the check's `signal` the way they stop a worker. `cancel` with no live attempt moves the task straight to `cancelled`.

Vendor pause: `setVendorPause` plus a `vendor.paused` event, with `until = resetAt`, or `now + backoff_s` with `backoff_s` starting at 300 and doubling to at most 3600 when no reset time is given. A successful attempt clears the row.

- [ ] **Step 1: Write the failing test**

```ts
it('runs a ticket to review with a logged manifest', async () => {
  const e = await makeEngine({ steps: [okStep({ 'src/a.mjs': 'export {}' })] });
  const t = await e.addTicket(ticket({ definition_of_done: ['test -f src/a.mjs'] }));
  await runToSettled(e, t.id);
  expect((await e.store.getTask(t.id)).state).toBe('review');
  const [a] = await e.store.listAttempts(t.id);
  expect(a.state).toBe('succeeded'); expect(a.k).toBe(1);
  expect(a.worktree_path).toBe(worktreePath(e.paths, 'p', t.ticket_id, 1));
  expect(JSON.parse(a.manifest).flags).toContain('--json-schema');
  expect(existsSync(transcriptPath(e.paths, 'p', a.id))).toBe(true);
  expect(eventTypes(e, t.id)).toEqual(expect.arrayContaining(['manifest.built', 'worker.init', 'check.finished']));
});
it('retries a failed check in a fresh worktree with evidence, never the transcript', async () => {
  // step 1 writes a wrong file and says FAKE_TRANSCRIPT_ONLY_MARKER; the check fails; step 2 fixes it
  const [a1, a2] = await e.store.listAttempts(t.id);
  expect(a1).toMatchObject({ state: 'failed', failure_kind: 'check_failed' });
  expect(a2.worktree_path).not.toBe(a1.worktree_path);
  const task2 = readFileSync(join(manifestDir(e.paths, 'p', t.ticket_id, 2), 'task.md'), 'utf8');
  expect(task2).toContain('check-output-marker');           // failure evidence
  expect(task2).toContain(a1Output.summary);                // previous Change Report
  expect(task2).not.toContain('FAKE_TRANSCRIPT_ONLY_MARKER');
});
it('escalates at the attempt cap of 3 and spawns no fourth worker', async () => {
  expect(task).toMatchObject({ state: 'escalated', escalation_reason: 'attempts_exhausted' });
  expect(e.spawnCount()).toBe(3);
});
it('a human retry grants exactly one more attempt', async () => { /* retry → ready → a4 fails → escalated */ });
it('schema-invalid output and scope violations count as failed attempts', async () => { /* invalid_output; failed/scope_violation */ });
// Review Focus 3
it('auth failure escalates at once with the login command', async () => {
  expect(e.spawnCount()).toBe(1);
  expect(task.escalation_reason).toMatch(/auth login/);
});
it('logged-out preflight creates no attempt', async () => { expect(await e.store.listAttempts(t.id)).toEqual([]); });
it('usage limit interrupts without using up an attempt', async () => {
  expect(attempt.state).toBe('interrupted');
  expect(await e.store.failedAttemptCount(t.id)).toBe(0);
  expect(await e.store.getVendorPause('anthropic')).toMatchObject({ until: '2026-10-30T15:00:00.000Z' });
  expect(task.state).toBe('ready');
});
it('context over budget spawns nothing', async () => { expect(e.spawnCount()).toBe(0); expect(a.failure_kind).toBe('context_over_budget'); });
it('cancel stops the worker and abandons the worktree', async () => {
  expect(task.state).toBe('cancelled'); expect(attempt.state).toBe('cancelled');
  expect(existsSync(attempt.worktree_path)).toBe(false);
});
it('cancel during checks kills the check', async () => { /* DoD "sleep 100" → cancelled within grace, pid gone */ });
it('cancel with no live attempt goes straight to cancelled', async () => { /* queued → cancelled, spawnCount 0 */ });
it('shutdown interrupts instead of cancelling', async () => { expect(attempt.state).toBe('interrupted'); expect(task.state).toBe('ready'); });
it('an engine exception cannot leave a task running', async () => { /* adapter.start throws → escalated, engine_error */ });
it('caps large payloads in the event log but not the transcript', async () => { /* 100 KB message */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `Runner` in `src/engine/runner.ts`**

The retry input is the most recent earlier attempt with evidence: its `failure_evidence` and its `output` as the Change Report. Failed attempts' worktrees stay for retention (Task 11).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/runner.ts test/runner.test.ts test/helpers
git commit -m "feat: add the attempt runner with retry and escalation"
```

### Task 10: Scheduler

**Files:**
- Create: `src/engine/scheduler.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `Store`, `Runner`, `EngineDeps`.
- Produces: `globsMayOverlap(a: string, b: string): boolean`; `class Scheduler { constructor(deps, runner); tick(): Promise<void>; start(intervalMs?: number): void; stop(): Promise<void> }`, default interval 1000 ms.

Rules, from §7.2–7.3. Each tick, for every `queued` or `blocked` task:
- Dependencies not all `done`: `blocked` on `dependency`.
- Overlaps a task in `running` or `checks`: `blocked` on `path_lock`.
- Otherwise: `ready`.

Write only on a change. Then start `ready` tasks oldest first while live < `maxWorkers`, skipping paused vendors, re-checking locks against tasks started in this same tick. A pause whose `until` has passed lets the next attempt through as the probe.

`globsMayOverlap`: compare the complete path segments before the first segment containing any of `*?[{!(`. They overlap when one segment list is a prefix of the other. It's deliberately conservative: a false positive only serializes two tickets.

Not in M1, because nothing can use them yet: the §7.3 priority classes (no bugs or human prerequisites exist until M2) and the smoke pre-flight (no Environment Profile until M2). Nothing moves a task to `done` until M2's reviewer exists, so an M1 ticket with dependencies stays `blocked`; M1 tickets are expected to be independent. A task parked in `review` holds no path lock.

- [ ] **Step 1: Write the failing test**

```ts
it.each([
  ['src/a/**', 'src/b/**', false], ['src/**', 'src/a/x.ts', true], ['**', 'anything', true],
  ['src/a.ts', 'src/a.ts', true], ['src/a.ts', 'src/b.ts', false], ['src/*.ts', 'src/a/x.ts', true],
  ['src/ab*', 'src/ac/x', true], ['docs/x.md', 'src/x.md', false],
])('globsMayOverlap(%s, %s) = %s', (a, b, want) => expect(globsMayOverlap(a, b)).toBe(want));

it('never exceeds 3 live workers across 5 tickets', async () => { /* max observed live = 3; all reach review */ });
it('serializes overlapping touches', async () => {
  // A touches src/**, B touches src/a.ts
  expect(b.state).toBe('blocked'); expect(b.blocked_on).toBe('path_lock');
  // after A reaches review, B runs
});
it('waits for dependencies to be done, not just in review', async () => { /* B blocked/dependency while A in review; store moves A to done; B ready */ });
it('holds a paused vendor until its reset, then probes', async () => {
  await e.store.setVendorPause({ vendor: 'anthropic', until: later, backoff_s: 300, reason: 'usage' });
  await sched.tick(); expect(e.spawnCount()).toBe(0);
  clock.set(afterLater); await sched.tick(); expect(e.spawnCount()).toBe(1);
});
it('doubles backoff to 3600 when no reset time is given', async () => { /* 300, 600 ... 3600, 3600 */ });
it('writes one event per real state change', async () => { /* 10 ticks while blocked → 1 task.state event */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/scheduler.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `globsMayOverlap` and `Scheduler`**

`tick` must not run concurrently with itself; `stop` waits for the current tick. Live attempts' promises are tracked by the `Runner`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/scheduler.ts test/scheduler.test.ts
git commit -m "feat: add the scheduler with dependencies, path locks and vendor pauses"
```

### Task 11: Crash recovery, retention and the daemon

**Files:**
- Create: `src/engine/recovery.ts`, `src/engine/retention.ts`, `src/daemon.ts`
- Test: `test/recovery.test.ts`, `test/retention.test.ts`, `test/daemon.test.ts`

**Interfaces:**
- Consumes: `Store`, `Runner`, `Scheduler`, `processStartTime`, `killGroup`, `removeAttemptWorktree`, `pruneGitWorktrees`, `createApp` (Task 12; until then `startDaemon` serves only `GET /api/health` through a local Hono app).
- Produces:
  - `recover(deps): Promise<{ interrupted: number; killed: number }>`
  - `pruneWorktrees(deps): Promise<number>`
  - `startDaemon(opts: { paths: Paths; config: Config }): Promise<{ port: number; stop(): Promise<void> }>`
  - `class DaemonAlreadyRunning`

Startup order is fixed: **bind the port, then touch the database.** `EADDRINUSE` throws `DaemonAlreadyRunning` before any write, so a second daemon can't mark the first one's attempts `interrupted`. Requests that arrive before startup finishes get 503. Then `recover`, `pruneWorktrees`, `scheduler.start`, and an hourly `pruneWorktrees`. SIGINT or SIGTERM call `runner.shutdown()`, then exit 0.

`recover`: for each attempt in `starting` or `running`: if `processStartTime(pid) === pid_started_at`, kill the group with SIGINT then SIGKILL after `cancelGraceS`; mark the attempt `interrupted`; move a task in `running` or `checks` to `ready`; append `recovery.interrupted { attemptId, killed }`. Run `pruneGitWorktrees` once per project. The other §7.7 restart duties have nothing to act on until M2: half-done merges, state-repo reconciliation, pending Inbox items.

`pruneWorktrees` removes the worktree and branch of attempts in a failed or interrupted state whose `ended_at` is older than `worktreeRetentionDays`, and sets `worktree_removed_at`. It never touches the latest attempt of a task in `review`.

- [ ] **Step 1: Write the failing tests**

```ts
// daemon: real processes, SIGKILL, fake-claude. Review Focus 1
it('recovers from SIGKILL mid-attempt in a new worktree', async () => {
  const d = await spawnDaemon(home);                 // tsx src/cli.ts daemon
  const t = await addTicketViaDb(/* slow step, then ok step */);
  await waitForAttempt('running');
  const workerPid = attempt.pid;
  d.kill('SIGKILL');
  expect(isAlive(workerPid)).toBe(true);             // orphan really exists
  const d2 = await spawnDaemon(home);
  await waitFor(() => !isAlive(workerPid));
  await waitForTask('review');
  const [a1, a2] = await listAttempts();
  expect(a1.state).toBe('interrupted'); expect(a2.state).toBe('succeeded');
  expect(a2.worktree_path).not.toBe(a1.worktree_path);
  expect(await failedAttemptCount()).toBe(0);
});
it('a second daemon exits non-zero and leaves the first alone', async () => {
  const d2 = await spawnDaemon(home, { expectExit: true });
  expect(d2.exitCode).not.toBe(0);
  expect((await getAttempt()).state).toBe('running');
});
it('SIGTERM interrupts cleanly', async () => { /* exit 0, worker gone, attempt interrupted, task ready */ });

// recovery
it('leaves an unrelated process holding a reused pid alone', async () => {
  const other = spawn('sleep', ['60']);
  await store.patchAttempt(a.id, { pid: other.pid, pid_started_at: 'Mon Jan  1 00:00:00 2024' });
  expect(await recover(deps)).toMatchObject({ interrupted: 1, killed: 0 });
  expect(isAlive(other.pid)).toBe(true);
});
it('a dead pid is interrupted without a kill', async () => { /* killed: 0 */ });
it('a crash during checks kills the check and returns the task to ready', async () => { /* attempt.pid is the check's group; killed: 1; checks → ready */ });
it('a crash before the worktree existed still recovers', async () => { /* starting, no pid, no dir */ });

// retention
it('removes failed worktrees after 7 days, not before', async () => { /* 8 days: gone; 6 days: kept */ });
it('never removes the latest attempt of a task in review', async () => { /* 30 days old, kept */ });
it('tolerates a directory already gone', async () => { /* worktree_removed_at set */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/recovery.test.ts test/retention.test.ts test/daemon.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `recover`, `pruneWorktrees`, `startDaemon`**

Install `hono` and `@hono/node-server`. Add a minimal `daemon` command to `src/cli.ts` (Task 12 adds the rest). Daemon tests use `AITEAM_HOME` temp dirs, a free port written to `config.yaml`, and `claude.binary` pointing at `fake-claude`, with `FAKE_*` passed through `claude.extra_env`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/recovery.test.ts test/retention.test.ts test/daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/recovery.ts src/engine/retention.ts src/daemon.ts src/cli.ts test package.json package-lock.json
git commit -m "feat: add crash recovery, worktree retention and the daemon"
```

### Task 12: REST + SSE API and the CLI

**Files:**
- Create: `src/server/app.ts`, `src/setup/doctor.ts`
- Modify: `src/cli.ts`, `src/daemon.ts`
- Test: `test/server.test.ts`, `test/sse.test.ts`, `test/doctor.test.ts`

**Interfaces:**
- Consumes: `Store`, `EventLog`, `Runner`, `addProject`, `addTicket`, `findAncestorInstructions`.
- Produces:
  - `createApp(deps: EngineDeps & { runner: Runner }): Hono`
  - `runDoctor(paths, config): Promise<{ name: string; ok: boolean; detail: string }[]>`: Node ≥ 22, git, claude binary, agent-home login, no instruction files above the worktree root
  - CLI: `aiteam setup | doctor | daemon | project add <name> <repoPath> [--create] | ticket add <project> <file.md>`, parsed with `node:util` `parseArgs`. `project` and `ticket` call the daemon over HTTP

Routes:

| Route | Behavior |
|---|---|
| `GET /api/health` | `{ ok: true }` |
| `GET /api/projects`, `POST /api/projects` `{ name, repoPath, create? }` | 201; bad repo 400; duplicate 409 |
| `POST /api/projects/:name/tickets` `{ markdown }` | 201 task; `TicketError` 400; duplicate 409; unknown project 404 |
| `GET /api/tasks?project=` | list |
| `GET /api/tasks/:id` | task + attempts, without manifest text |
| `GET /api/attempts/:id/manifest` | the stored manifest |
| `GET /api/tasks/:id/events` | SSE; honors `Last-Event-ID` and `?after=`; `id: <seq>`, `event: <type>`, `data: <json>`; `: ping` every 15 s |
| `POST /api/tasks/:id/cancel`, `POST /api/tasks/:id/retry` | 202; wrong state 409; unknown 404 |

Every route first passes a guard: `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; `Origin`, when present, must be `http://` plus one of those; any non-GET needs `Content-Type: application/json`. SSE subscribes **before** replaying and de-duplicates by `seq`, so nothing is lost or repeated between the two.

- [ ] **Step 1: Write the failing tests**

```ts
// Review Focus 5
it.each([['evil.example:4780'], ['127.0.0.1.evil.example:4780'], ['localhost:9999']])
  ('refuses Host %s', async h => expect((await req('/api/tasks', { headers: { host: h } })).status).toBe(403));
it('refuses a foreign Origin on write', async () => {
  expect((await post('/api/projects', body, { origin: 'https://evil.example' })).status).toBe(403);
});
it('refuses a simple cross-site POST', async () => {
  expect((await req('/api/projects', { method: 'POST', headers: { host, 'content-type': 'text/plain' }, body })).status).toBe(415);
});
it('binds to 127.0.0.1 only', async () => { expect(daemon.address.address).toBe('127.0.0.1'); });

it('creates a task from a ticket and reports errors plainly', async () => { /* 201; 400 names the field; 409; 404 */ });
it('retry on a non-escalated task is 409', async () => { /* … */ });
it('task detail omits manifest text; the manifest route returns it', async () => { /* … */ });

// sse
it('replays then streams with no gap or repeat', async () => { /* append while connecting; seqs strictly increasing, complete */ });
it('resumes from Last-Event-ID without duplicates', async () => { /* … */ });
it('unsubscribes when the client disconnects', async () => { expect(log.subscriberCount()).toBe(0); });

// doctor
it('flags a CLAUDE.md above the worktree root', async () => { /* failing check names the file */ });
it('flags a logged-out agent home with the login command', async () => { /* fake-claude FAKE_AUTH loggedIn:false */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/server.test.ts test/sse.test.ts test/doctor.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

Use `streamSSE` from `hono/streaming`. The guard reads the port from `config.port`. `startDaemon` now mounts `createApp` and serves `web/dist` when it exists. Tests use `app.request()`, except the bind test.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/server.test.ts test/sse.test.ts test/doctor.test.ts && npm test && npm run typecheck`
Expected: PASS across the whole suite; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src test package.json package-lock.json
git commit -m "feat: add the REST and SSE API, CLI commands and doctor"
```

### Task 13: Task detail UI

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/logState.ts`, `web/src/styles.css`, `web/src/pages/TaskList.tsx`, `web/src/pages/TaskDetail.tsx`, `web/src/components/LiveLog.tsx`, `web/src/components/ManifestTab.tsx`, `web/src/components/EvidenceTab.tsx`, `scripts/demo.ts`, `.claude/launch.json`
- Modify: `package.json`, `tsconfig.json`
- Test: `test/logState.test.ts`

**Interfaces:**
- Consumes: the Task 12 routes.
- Produces: `applyEvent(s: LogState, e: EventRow): LogState` and `LogState = { lastSeq: number; rows: LogRow[]; evidence: CheckRun[] }` in `web/src/logState.ts`; `scripts/demo.ts`, which runs a daemon on a temp `AITEAM_HOME` with `fake-claude`, a throwaway repo and a slow ticket, so the UI can be checked without spending anything.

Screens, from the mockups' Task detail (`T-15`), reusing its CSS tokens (mockup lines 17–44, light and dark) and fonts:
- **Task list** at `/`: ticket ID, title, state pill, attempts, estimated cost.
- **Task detail** at `/tasks/:id`:
  - header with ticket ID, title and state pill
  - attempt timeline (`a1 failed`, `a2 running`)
  - banner on `escalated` showing the reason and fix, with a Retry button; Cancel while running
  - when in `review`: "Waiting for review. The Code Reviewer arrives in M2."
  - tabs **Live log**, **Manifest** (budget meter per part, sources, flags, model) and **Evidence** (check runs, labelled as worker-run information)
  - cost shown as `~$0.12 (estimate)`

Diff and Judgments tabs wait for M2 and M5; don't add placeholders. Live log uses `EventSource`; it auto-scrolls unless the reader has scrolled up, and shows a "Reconnecting…" line while the connection is down.

- [ ] **Step 1: Write the failing test**

```ts
it('renders each event type as a row', () => { /* worker.message, tool_call, tool_result, usage, check.finished, task.state */ });
it('ignores an already-seen seq', () => { /* applyEvent twice → one row; lastSeq stable */ });
it('collects check.finished into evidence', () => { expect(s.evidence[0].exitCode).toBe(1); });
it('sums usage into an estimate', () => { /* two usage events → usdEst sum */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/logState.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the UI and demo**

Install `react react-dom @tanstack/react-query vite @vitejs/plugin-react @types/react @types/react-dom`. Scripts: `web:dev`, `web:build`, `demo: tsx scripts/demo.ts`. In `vite.config.ts`, proxy `/api` to `http://127.0.0.1:4780` with `changeOrigin: true` and `headers: { origin: 'http://127.0.0.1:4780' }` so dev traffic passes the guard. `.claude/launch.json` gets configuration `aiteam-demo` (`npm run demo`, port 4780). Hand-roll a small path router; no router dependency.

- [ ] **Step 4: Run the tests and build**

Run: `npx vitest run test/logState.test.ts && npm run web:build && npm run typecheck`
Expected: PASS; `web/dist/index.html` exists.

- [ ] **Step 5: Verify in the browser**

Start `aiteam-demo` with `preview_start`, then on `/tasks/<id>`:
- `read_page`: live log rows grow while the fake worker runs.
- Manifest tab: `charter`, `task_inputs` and `context_tokens: 12000` meters.
- Click Cancel: the state pill becomes `cancelled`.
- `read_console_messages`: no errors.
- `resize_window` with `colorScheme: dark`: tokens switch.
- Take a screenshot as proof.

- [ ] **Step 6: Commit**

```bash
git add web scripts/demo.ts .claude/launch.json test/logState.test.ts package.json package-lock.json tsconfig.json
git commit -m "feat: add the minimal Task detail UI with live log"
```

### Task 14: M1 acceptance on the real CLI

Spec §16's "done when" for M1, run for real. Run outside the sandbox, as in Task 2. Expected spend is under $3.

**Files:**
- Create: `scripts/smoke-m1.ts`, `test/fixtures/tickets/T-SMOKE-1.md`, `test/fixtures/tickets/T-SMOKE-2.md`, `docs/superpowers/notes/2026-10-30-m1-acceptance.md`

**Interfaces:**
- Consumes: the CLI, the REST API, `isolationViolations`.
- Produces: the acceptance record.

`T-SMOKE-1`: "Add `add(a, b)` to `src/add.mjs` with a test at `src/add.test.mjs`", `touches: ["src/**"]`, `definition_of_done: ["node --test src/"]`, `size: S`. `T-SMOKE-2`: the same shape with `mul(a, b)`, `touches: ["lib/**"]`, used for the crash drill.

- [ ] **Step 1: Write `scripts/smoke-m1.ts`**

Against a real `~/.aiteam` agent home but a temp project repo, with the real `claude` binary. Each line prints `PASS` or `FAIL`, and the script exits non-zero on any `FAIL`:

1. `aiteam doctor` has no failing checks.
2. Start the daemon, `project add smoke <tmp> --create`, `ticket add T-SMOKE-1`.
3. The task reaches `review` within 10 minutes.
4. `worktree_path` matches `worktrees/smoke/T-SMOKE-1-a1`, and the base is `aiteam/m1`.
5. The manifest is stored with every part, `totalTokens ≤ 12000`, and flags include `--strict-mcp-config`.
6. `isolationViolations` is `[]` for the attempt's `init` (read from the transcript).
7. `check.finished` shows `node --test src/` exiting 0.
8. `usdEst ≤ 3.00`, and the repo's base branch hasn't moved.
9. Crash drill: `ticket add T-SMOKE-2`, wait for `worker.init`, SIGKILL the daemon, restart it; the old worker's PID is gone, `a1` is `interrupted`, `a2` reaches `review` in a different worktree.

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/smoke-m1.ts`
Expected: all lines `PASS`, exit 0.

- [ ] **Step 3: Verify the live UI on a real run**

With the daemon from the smoke run still up, or a fresh `T-SMOKE-1` in a new project, open `http://127.0.0.1:4780/tasks/<id>` with `preview_start` and `url`. Confirm real worker messages and tool calls stream, the Manifest tab shows real budgets, and cost is labelled as an estimate. Take a screenshot.

- [ ] **Step 4: Record and commit**

Write attempt IDs, spend, isolation results, the crash-drill timings and the screenshot path to the acceptance notes.

```bash
git add scripts/smoke-m1.ts test/fixtures/tickets docs/superpowers/notes
git commit -m "test: add M1 acceptance run on the real Claude CLI"
```

---

## Spec coverage for M1

| Spec | Where | Left for later |
|---|---|---|
| §3 stack, auth, network | Tasks 1, 2, 12, 13 | Codex home: M3 |
| §5.2 role file | Tasks 1, 6 | Other roles: M2 |
| §6.1–6.2 adapter contract, Claude adapter | Tasks 2, 7 | Turn-cap `--resume`: M3. Codex, model API: M3 |
| §7.2 task and attempt FSM | Tasks 4, 9 | Reviewer and QA behavior behind `review`/`qa`: M2 |
| §7.3 scheduling | Task 10 | Priority classes, smoke pre-flight: M2 |
| §7.4 attempt cap | Task 9 | Judge stall and failure classes, replan: M5 |
| §7.6 budgets | Attempt caps and usage-window pause, Tasks 7, 9, 10 | Task, milestone, project caps, warnings, weekly caps, cost views: M3 |
| §7.7 crash safety | Attempts, worktrees, event log, Task 11 | Merges, state-repo reconciliation, Inbox: M2 |
| §8.5 manifest | Budgets, logging, repo instruction counting, Task 6 | Playbook and memory selection: M4 |
| §11.1 artifacts | Tickets in the state repo, Tasks 5, 6 | Everything else: M2 |
| §11.2 workspace | Worktrees, scope check, retention, env, Tasks 5, 7, 8, 11 | Merges, CP4: M2. Apple sandbox exceptions: M6 |
| §12 Task detail | Live log, Manifest, Evidence, Task 13 | Diff: M2. Judgments: M5. Other screens: M2+ |
| §13 persistence | Tasks 1, 3, 5 | `.aiteam/` snapshot at CP4: M2 |
| §14 security | Bind, guard, permissions, isolation, Tasks 2, 7, 12 | Dangerous-op gating: M5. `--bare` for untrusted repos ships as `api-key` mode only |

## After M1

Each milestone gets its own plan, written when the previous one lands and informed by what it found: M2 Artifacts + roles, M3 Agnostic workers + budgets, M4 Knowledge v1, M5 Judge layer, M6 Human tasks + Apple toolchain, M7 Knowledge hardening, M8 Adopt existing repos.

To carry forward:
- **M2:** definition-of-done commands run unsandboxed in M1, which is fine for hand-written tickets. They must run sandboxed before a model can write a ticket.
- **M2:** `network: restricted` gives workers no network at all in M1. Package installs need a per-project allow-list.
- **M6:** this machine's active developer directory is Command Line Tools, so `xcodebuild` doesn't run. The stakeholder needs Xcode installed and selected before M6.
