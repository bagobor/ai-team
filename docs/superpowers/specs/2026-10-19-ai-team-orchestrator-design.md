# AI Team: Orchestrator Design

- **Date:** 2026-10-19
- **Status:** Approved 2026-10-30, revision 3 (adapter findings from the M1 planning probes folded into §6.1 and §6.2)
- **Implementation plans:** `../plans/2026-10-30-ai-team-m1-engine-skeleton.md` (M1; later milestones get their own)
- **Project dir:** `/Users/ps/dev/ai-team` (new, empty repo)
- **Companion files:**
  - UI mockups: `2026-10-19-ai-team-ui-mockups.html` (in this folder)
  - Prior-art research notes: `2026-10-19-ai-team-prior-art-research.md` (in this folder), summarized in §17

Decisions are tagged **[user]** when they come from the stakeholder and **[call]** when they are the designer's default. A builder may revisit any **[call]**. Changing a **[user]** decision means going back to the user. Where a [call] rests on prior-art evidence, the evidence is cited in short form; §17 has the details.

---

## 1. Intent

A single coding agent working on a big project accumulates context until it **drifts off the goal, its quality drops abruptly, and the task is never finished**. **[user]** That's the problem this system exists to solve.

**AI Team** is a standalone app with a web UI. It runs a reusable pipeline of specialised AI agents organised like a big-company product team: **PM, Product/UX Design, Engineering (Tech), and QA**. **[user]** ("let's not invent the wheel, the typical big company org structure is pretty good")

- **Specialisation.** Each agent is focused on one type of work.
- **Expertise.** Each role accumulates expertise as it works: knowledge about its tasks and its tools, so it's more efficient the next time. **[user]**
- **Bounded context.** Because each agent sees only its slice of the work, no single context ever has to hold the whole project. **[user]**

How this design delivers that intent:

1. **The goal lives in documents, not in an agent's memory.** Roles hand work to each other through typed, versioned documents. The milestone spec's acceptance criteria are *locked*: no worker can quietly change what "done" means.
2. **Every task runs in a fresh worker session.** It is loaded only with the role's charter, a small budget of the role's playbook, and the specific documents that task needs. No worker ever inherits another task's history.
3. **Code runs the workflow; models do the work and the judging.** A deterministic engine decides what happens next. LLM "managers" routing work failed in both CrewAI and MetaGPT.
4. **Expertise accumulates in curated role playbooks** that travel across projects. They grow only through small, evidence-backed edits, are pruned by usage, and are bounded in size, so the playbooks never become the new context problem.
5. **You are the stakeholder, not the babysitter.** The team decides what it needs from you (approvals, decisions, hands-on tasks like recording sensor data) and asks through a single Inbox. **[user]** ("ideally the team must decide this and tell me what is required")

**Model and agent agnostic.** Workers are external coding agents behind adapters. In v1 these are Claude Code (headless) and Codex (exec), plus a plain model-API adapter. **[user]** ("ideally should be agent / model agnostic but could be compatible with codex / claude cli mode")

**First real project (dogfood):** an Apple Watch app that uses the watch's sensors to assist Snap SPECS AR glasses with hand tracking and gesture detection. It integrates with the user's `ar-hud` project. **[user]** It shapes several requirements:
- hands-on human tasks
- datasets as QA evidence
- specialist engineers
- feasibility spikes
- native Apple toolchains
- interfaces that cross repos

---

## 2. Goals, non-goals, anti-goals

### Goals

| # | Goal | Measure |
|---|------|---------|
| G1 | **The goal can't drift.** What "done" means changes only with the stakeholder's approval. | Acceptance-criteria text changes only through an approved Change Request. Every merged change traces to a ticket, and every ticket traces to at least one acceptance criterion. |
| G2 | **Context stays bounded regardless of project size.** | Every worker's injected context is ≤ its role budget (default 12k tokens). A worker never receives another task's transcript. Both are enforced by the engine and visible in the task's manifest. |
| G3 | **Work finishes or escalates; it never spirals.** | Every task ends as `done`, `failed` or `escalated` within its attempt and dollar budget. Stalls are detected and replanned or escalated (§7.4). |
| G4 | **Roles get better with experience.** | Playbooks change only through evidence-linked edits. Per role, the app reports attempts per ticket, cost per ticket and first-pass review rate across projects, so improvement (or its absence) is visible. |
| G5 | **Agent and model agnostic.** | Any role can run on Claude Code or Codex by changing configuration only. A new CLI agent is a new adapter, with no changes to roles, knowledge or the engine. |
| G6 | **Low, predictable load on the human.** | The stakeholder is asked for things only through the Inbox. Every item says who is asking, why, what it blocks, and the team's recommendation. Mandatory checkpoints are few (§9.2). |
| G7 | **Crash-safe.** | Killing the app at any moment loses no approvals or answers and corrupts no branches. On restart, interrupted attempts re-run cleanly. |
| G8 | **Honest verification.** | Each acceptance criterion is marked passing only by QA, with attached evidence that comes from actually running something: tests, dataset replay metrics, scripted UI runs, or a human test result. |

### Non-goals (v1)

- **Multi-user, hosted or cloud deployment.** The app is local and single-user on the stakeholder's Mac. **[call]**
- **Building our own coding agent.** We wrap strong existing agents. **[call]**
- **Adopting existing codebases.** v1 runs greenfield projects. Taking over an existing repo (discovery over its code, inferring its Environment Profile) is milestone M8. **[user]**
- **Free-form agent-to-agent chat.** Roles communicate only through artifacts and structured requests (§5).
- **Auto-merging to the project's main branch.** That always requires milestone acceptance by the stakeholder.
- **Fine-tuning or training models.**
- **Building embedding or vector infrastructure in v1.** Retrieval is tag filtering plus full-text search plus Judge scoring (§8.5). Embeddings are a later option.
- **Remote notifications** such as Telegram or Slack. Browser notifications only.
- **Running Apple builds on Linux or cloud workers.**
- **A mobile UI.**

### Anti-goals (failure even if it technically works)

- **Chat soup.** Roles talk to each other in open-ended conversation, and the goal dissolves into transcripts (ChatDev's failure mode).
- **An LLM in the control loop.** An LLM decides routing, retries or merges.
- **Playbook rot.** Playbooks are rewritten wholesale by a model, grow without limit, or absorb unverified lessons. Research shows each of these makes agents *worse* than having no playbook.
- **Silent goal change.** Any path where acceptance criteria, a spec or a design change without lineage and approval.
- **Rubber-stamp QA.** "It compiles" or "the agent says it works" counted as done.
- **Human as babysitter.** If the stakeholder has to watch logs to keep the team on track, the system has failed.
- **Runaway spend.** Loops or retries that burn budget without a hard stop.
- **Dashboard as product.** A pretty board with no real process or knowledge underneath. Thin wrapper UIs were the first casualties of 2026.

---

## 3. Constraints

- **Host.** The stakeholder's Mac (Apple silicon, current macOS). Apple toolchains (Xcode, `xcodebuild`, simulators) must be available to workers. **[user]** (watchOS dogfood) Linux hosts are a later concern. **[call]**
- **Workers.**
  - Claude Code CLI (`claude -p`, headless) **[user]**
  - Codex CLI (`codex exec`) **[user]**
  - a direct model API for non-repository roles (reflection, judge fallback) **[call]**
- **Auth.** **[user]** Workers run on the stakeholder's Claude and Codex **subscription logins**, in an isolated agent home (§6.2), so the stakeholder's own CLI setup never leaks into a worker.
  - Budgets therefore track estimated dollars *and* the plans' usage windows (§7.6).
  - The app is for personal use. A shared or distributed build must switch to API keys, because Anthropic requires API-key auth for third-party products built on Claude Code. Adapters support both modes. **[call]**
  - Secrets never enter prompts or artifacts.
- **Judge model.** Jev from TypeSafe AI, via its REST API, with a fallback to an LLM (§10). **[user]** ("can we incorporate Jev") Jev is proprietary, in early access, and its performance claims haven't been independently verified, so it must always be swappable. The stakeholder has no Jev key yet **[user]**, so v1 runs the LLM judge as primary and ships the Jev provider ready to switch on (§10.1). v1 acceptance doesn't depend on Jev.
- **Repositories.** A project has one primary git repository. Others can be attached read-only as reference repos (§11.4). **[call]**
- **Network.** The UI binds to `127.0.0.1` only. v1 has no authentication on the UI because it runs on localhost for a single user. **[call]**
- **Implementation stack.** **[call]**
  - TypeScript end to end, on Node 22 LTS.
  - Server: Hono or Fastify.
  - Store: SQLite, accessed through Drizzle or Kysely.
  - Live updates: server-sent events.
  - Frontend: React with Vite and TanStack Query.
  - Rationale:
    - The Claude Agent SDK and the Codex SDK are both TypeScript.
    - One language across UI and engine.
    - It matches the stack choice in the stakeholder's `ar-hud` design.

---

## 4. Architecture

```
┌──────────────────────────── Web UI (React, localhost) ─────────────────────────────────────────────┐
│ Projects · Overview · Flow · Inbox · Board · Task detail · Documents · Team & Knowledge · Settings │
└───────────────▲─────────────────────────────── REST + SSE ─────────────────────────────────────────┘
                │
┌───────────────┴──────────────────── aiteamd (Node daemon) ───────────────────────────────┐
│                                                                                          │
│  Engine (deterministic)            Artifact store             Knowledge service          │
│   ├─ Project/milestone FSM          ├─ typed docs + schemas    ├─ role playbooks (git)    │
│   ├─ Task/attempt FSM               ├─ versions + lineage      ├─ project memory          │
│   ├─ Scheduler (deps, path locks)   ├─ AC registry + status    ├─ delta applier (code)    │
│   ├─ Budget guard                   └─ staleness propagation   ├─ selector (budgeted)     │
│   └─ Checkpoint/Inbox manager                                  └─ stats (counters)        │
│                                                                                          │
│  Context builder → Task manifest     Judge layer                Event log (append-only)  │
│                                       ├─ Jev provider            + run ledger (SQLite)    │
│  Workspace manager                    ├─ LLM fallback provider                            │
│   ├─ git worktree per attempt         └─ thresholds + calibration log                     │
│   ├─ integration branch per milestone                                                    │
│   └─ check runner (build/lint/test)  Adapters: claude-code · codex · model-api            │
└───────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                │ spawn per attempt (fresh session)
              ┌─────────────────────────────────┼───────────────────────────────┐
              ▼                                 ▼                               ▼
    claude -p --output-format          codex exec --json              Model API call
    stream-json … (in worktree)         … (in worktree)                (no repo access)
```

### Load-bearing decisions

- **D1. Code runs the workflow; models never route.** **[call]** Project, milestone, task and attempt lifecycles are explicit state machines in the engine. Models produce artifacts and answer bounded questions (the Judge). They never pick the next state, retry, merge, or skip a gate. *Evidence:* the hierarchical-manager delegation failures in CrewAI, MetaGPT's own note that its LLM team leader "doesn't understand the message well", and the Berkeley MAST failure taxonomy.

- **D2. One fresh worker session per attempt.** **[user]** (intent) **[call]** (mechanism)
  - Each attempt spawns a new CLI process in a new git worktree, with a manifest built for that attempt.
  - Sessions are never reused across tasks.
  - The one exception: within a single attempt, the adapter may continue a session that hit its turn cap (`--resume`), as long as it stays within that attempt's budget.
  - *Evidence:* Factory Missions, Anthropic's long-running-agent harness and Cursor all converged on this pattern.

- **D3. Artifacts are the only interface between roles.** **[call]**
  - Every handoff is a typed document with a schema, a version, an owner role, and lineage (`derived_from`).
  - Handoffs carry evidence (test output, diffs, metrics), not just summaries.
  - *Evidence:* MetaGPT's documents produced fewer spec failures than ChatDev's chat. Cognition's critique of multi-agent setups is that summaries lose context.

- **D4. Two knowledge tiers, with gated promotion between them.** **[user]** (accumulate expertise) **[call]** (mechanism)
  - *Role playbooks* are cross-project and live in the app's knowledge repo.
  - *Project memory* is per project and lives in the project state repo (§13). The target repo gets a snapshot at CP4.
  - Lessons enter only from evidence, start in project memory, and are promoted to a role playbook only after confirmation (§8).

- **D5. Our own small engine, not a framework.** **[call]** LangGraph, CrewAI and Microsoft Agent Framework orchestrate in-process LLM calls and checkpoint at node boundaries. A long CLI worker is one opaque node to them: a crash replays it, side effects included (open issues in all three). We need a task state machine, an event log and persisted pending requests, roughly a few hundred lines. Worktrees make attempts idempotent.

- **D6. Judge layer with calibrated confidence gating.** **[user]** (Jev) **[call]** (shape) Many small decisions are made by a fast, cheap, calibrated judge. Low confidence escalates to a stronger model, then to the human. The judge is behind an interface, with Jev as the primary provider and an LLM as fallback (§10).

- **D7. Adapters normalise workers.** **[call]** One event model and one result contract across Claude Code, Codex and the model API (§6). The roles, the engine and the knowledge system never see vendor-specific details.

- **D8. The human is the stakeholder and field operator.** **[user]** The team decides which approvals, decisions and physical tasks it needs from you, and asks through the Inbox. Hands-on tasks such as "wear the watch and record 50 pinches" are first-class work items that block the work that depends on them (§9).

---

## 5. Organisation model

### 5.1 Departments and roles

| Department | Role | Mission | Consumes | Produces |
|---|---|---|---|---|
| Product | **PM** **[user]** | Own the goal: turn the Brief into a roadmap and milestone specs; decide scope; file what the team needs from the human | Brief, Spike Reports, Milestone Reviews, Change Requests | Roadmap, Team Proposal, Human Requirements, Milestone Spec (with ACs), Spike definitions, Milestone Review, CR decisions |
| Design | **UX Designer** **[user]** (product/UX) | Turn spec into flows, screens and interaction details (incl. non-visual: gestures, haptics) | Milestone Spec | UX Design (+ clickable HTML prototype when visual) |
| Engineering | **Tech Lead** **[call]** | Technical design, interfaces, ticket breakdown, environment profile | Spec, UX Design, Spike Reports | Tech Design, Interface Contracts, Tickets, Environment Profile, ADRs |
| Engineering | **Engineer · ‹specialty›** **[call]** | Implement one ticket | Ticket + referenced sections | Change Report (+ diff in worktree) |
| Engineering | **Code Reviewer** **[call]** | Independent review against ticket + design | Ticket, Change Report, diff | Review Report (approve / changes requested) |
| QA | **QA Engineer** **[user]** | Own "done": test plan from ACs *before* code; verify with evidence; file bugs; request human tests | Spec, UX Design, Tech Design, integration build | Test Plan, test code/harnesses, QA Report, Bugs, Human Test Tasks |
| (staff) | **Reflector** **[call]** | Turn outcomes into proposed playbook/memory deltas | Attempt manifest, outcome, evidence | Retro (deltas) |

- **Specialties.** **[call]** Engineers (and optionally QA) carry a specialty such as `watchos`, `signal-ml`, `web-frontend` or `backend`. A specialty playbook *extends* the base role playbook: at selection time the two are unioned and filtered by tag. The Tech Lead proposes the specialties a project needs in the Team Proposal. A new specialty starts with an empty playbook plus the base role's.
- **Cross-model review.** **[call]** The Code Reviewer defaults to a different vendor or model from the author of the change, for example Codex reviewing Claude's work. This avoids blind spots the two would share. It's configurable.

### 5.2 Role definition (file format)

Roles live in the knowledge repo (§8.2) as `roles/<role-id>/role.yaml`:

```yaml
id: engineer
specialty_of: null            # e.g. engineer.watchos has specialty_of: engineer
department: engineering
mission: >
  Implement exactly one ticket. Satisfy its definition of done. Report evidence.
consumes: [ticket, tech_design#sections, interface_contract, ux_design#sections]
produces: [change_report]
write_scope:                  # enforced by post-run diff validation (§11.2)
  allow: ["**"]
  deny: [".aiteam/**"]        # artifacts and memory are engine-owned
tools:                        # adapter-mapped capability names
  - read_repo
  - edit_repo
  - run_commands
  - network: restricted
defaults:
  adapter: claude-code
  model: claude-sonnet-5-5
  budgets: { max_turns: 60, max_usd: 3.00, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000 }
output_schema: schemas/change_report.json
```

**Charter text.** The fixed instructions every attempt of this role gets live in `roles/<role-id>/charter.md`. The charter is short (≤ 600 tokens) and **human-curated**. Agents never edit it.

---

## 6. Workers and adapters

### 6.1 Adapter contract **[call]**

```ts
interface WorkerAdapter {
  id: 'claude-code' | 'codex' | 'model-api' | string;
  vendor: string;                       // usage windows pause per vendor (§7.6)
  capabilities: { repoTools: boolean; structuredOutput: boolean; resume: boolean;
                  costReport: 'exact' | 'estimate' | 'none'; sandbox: 'os' | 'flags' | 'none' };
  preflight(): Promise<{ ok: true } | { ok: false; reason: string; fix: string }>;   // logged in, binary present
  start(m: TaskManifest, ws: Workspace): AttemptHandle;
}
interface AttemptHandle {
  events: AsyncIterable<WorkerEvent>;   // normalized
  cancel(): Promise<void>;              // graceful (SIGINT for claude), then SIGKILL after grace
  result: Promise<AttemptResult>;
  pid?: number;                         // for crash recovery (§7.7)
  argv: readonly string[];              // recorded in the manifest
}
type WorkerEvent =
  | { t: 'init'; sessionId: string; model: string }
  | { t: 'message'; text: string }
  | { t: 'tool_call'; name: string; input: unknown }
  | { t: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { t: 'usage'; inTok: number; outTok: number; cachedTok?: number; usdEst?: number }
  | { t: 'error'; message: string };
type AttemptResult = { status: 'succeeded' | 'failed' | 'timeout' | 'budget_exceeded' | 'cancelled' | 'invalid_output'
                             | 'usage_limited';   // the engine records the attempt as `interrupted` (§7.6)
                       output?: unknown /* validated against role output_schema */; usage: Usage; sessionId?: string;
                       failureKind?: string; message?: string; resetAt?: string };
```

**Rules for every adapter:**
- **Output validation.** Output that doesn't match the role's schema becomes `invalid_output`. It's a failed attempt, never a partial success.
- **Raw transcripts are for debugging only.** They're stored as JSONL files and never fed to another worker.
- **Cost figures are estimates** unless the provider reports exact billing. The UI labels them that way.

### 6.2 Claude Code adapter **[call]**

```
CLAUDE_CONFIG_DIR=~/.aiteam/agent-home/claude \
claude -p --output-format stream-json --verbose
  --append-system-prompt-file <manifest/system.md>
  --json-schema <role output schema, as a JSON string>
  --permission-mode <per role, dontAsk by default>
  --tools <mapped from role.tools> --allowedTools <same list>
  --settings <sandbox JSON for network: restricted>
  --strict-mcp-config --mcp-config <role MCP config, usually empty>
  --max-turns <budget> --max-budget-usd <budget>
  [--bare]   # API-key mode only
  < manifest/task.md
```

- **Isolation in subscription mode.** **[call]** `--bare` needs an API key, so subscription mode isolates workers by giving them their own **agent home**: a clean `CLAUDE_CONFIG_DIR` with no user CLAUDE.md, plugins, skills, hooks or auto-memory. It's logged in once, as a setup Human Task. `--strict-mcp-config` limits MCP servers to the ones the role declares. The target repo's own `CLAUDE.md` and `AGENTS.md` still load; the context builder counts their tokens against the role budget and records them in the manifest. *Risk:* M1 must prove this isolation works with subscription login, since keychain-stored credentials may not follow the config dir. If it doesn't, repo workers fall back to API keys.
- **Session and results.** Capture `session_id` from `init`. A result whose `subtype` isn't `success`, a `success` with `is_error: true` (a failed login arrives this way), or a `success` with no `structured_output` means the attempt failed. Keep reading past `result`, because hook events can follow it, and ignore unknown event types.
- **Flags, from probing CLI 2.1.109.** `--allowedTools` only auto-approves, so `--tools` is what limits the tool list. `--json-schema` takes a JSON string, not a file. `--max-turns` and `--append-system-prompt-file` work though `--help` omits them. M1 records the verified result fields.
- **Environment.** Workers get an allow-listed environment. `ANTHROPIC_API_KEY` would override the subscription login and `CLAUDECODE` blocks nested runs, so neither passes through.
- **Stopping.** Stop with SIGINT; SIGTERM records no result.
- **Turn-cap continuation.** Continue with `--resume <id>` only inside the same attempt.
- **What not to use:**
  - Claude's experimental agent teams: interactive only, and about 7× the tokens.
  - In-worker subagents for cross-role work. Subagents are allowed only *inside* a worker, for its own exploration.

### 6.3 Codex adapter **[call]**

```
codex exec --json --output-schema <schema.json> -o <out.json>
  --sandbox workspace-write  [-m <model>]   < manifest/task.md
```

- Parse JSONL events, capture `thread_id`, and read usage from `turn.completed`.
- Inject the role charter and playbook through the prompt file, not through `AGENTS.md`. Codex concatenates `AGENTS.md` files up to a 32 KiB cap, which would bypass our budget.
- **Isolation:** run with `CODEX_HOME=~/.aiteam/agent-home/codex`, logged in once, with no user `AGENTS.md` or MCP config.

### 6.4 Model-API adapter **[call]**

This is a direct provider call with structured output and no repository access. It's used for the Reflector, the Judge's LLM fallback and short summaries. A thin provider layer (Anthropic, OpenAI and OpenAI-compatible endpoints) keeps it agnostic. In subscription mode it runs as `claude -p` with no tools and a JSON schema, from the same agent home, so no API key is needed. **[call]**

### 6.5 Model assignment **[call]**

Each role has a default adapter and model, which can be overridden per project and per ticket. The Tech Lead can tag a ticket `size:S|M|L`, and small tickets can route to a cheaper model. The defaults ship in configuration, not code:

| Role | Adapter | Model |
|---|---|---|
| PM | claude-code | claude-opus-5-5 |
| UX Designer | claude-code | claude-sonnet-5-5 |
| Tech Lead | claude-code | claude-opus-5-5 |
| Engineer (base and most specialties) | claude-code | claude-sonnet-5-5 |
| Engineer · watchOS | codex | Codex CLI default |
| Code Reviewer | the other vendor from the change's author | Codex default, or claude-opus-5-5 when the author ran on Codex |
| QA Engineer | claude-code | claude-sonnet-5-5 |
| Reflector | model-api | claude-opus-5-5 |
| Judge fallback | model-api | claude-sonnet-5-5 (claude-opus-5-5 for the escalation tier) |

The mockups show this roster on the sample project.

---

## 7. Engine

### 7.1 Project lifecycle

```
intake ──► discovery ──[CP1 roadmap approval]──► milestone loop ──► closed
                                                    │
     ┌──────────────────────────────────────────────┘
     ▼
  spikes? ──► spec ──[CP2 spec sign-off: ACs lock]──► ux design ──[CP3 optional]──►
  tech design ∥ test plan ──► build loop ──► verify ──► milestone review ──[CP4 acceptance]──► merge to main ──► retro
          ▲                         │           │
          └──── change requests ◄───┴───────────┘   (bugs → tickets → build loop)
```

1. **Intake.** The stakeholder writes a **Brief** in the UI: the goal, constraints, links, the target repo (or a new empty one), and any reference repos.
2. **Discovery.** The PM produces three things:
   - **Roadmap**: milestones, each with an outcome statement.
   - **Team Proposal**: the roles and specialties needed, plus suggested models.
   - **Human Requirements**: what the team needs from the stakeholder over the project, such as hardware, accounts, setup steps, and expected hands-on time per milestone. **[user]** (the team decides what's required)

   The Tech Lead produces an **Environment Profile**:
   - build, test and lint commands
   - required toolchains, simulators and devices
   - a smoke command

   The engine checks the profile by running it.

   **CP1:** the stakeholder approves the Roadmap, the Team Proposal and the Human Requirements together.
3. **Spikes.** These are optional and come first when there are feasibility unknowns. A **Spike** artifact defines:
   - the question
   - the method
   - a time and dollar budget
   - go/no-go criteria

   A **Spike Report** answers the question with evidence. Spike code lives on a throwaway branch and is never merged. **[call]**
4. **Spec.** The PM writes the **Milestone Spec**: user stories plus **acceptance criteria** (`AC-n`). Each criterion is specific and verifiable, and says *how* it will be verified: automated, dataset replay, scripted UI, or human test. **CP2:** on approval, the criteria **lock** (§7.5).
5. **UX design.** This runs when the Judge (`ux.needed`) or the spec says the milestone has user-facing scope.
   - The UX Designer produces flows, screen specs, interaction specs (gestures, haptics, error states) and, for visual work, a clickable HTML prototype.
   - **CP3** is optional per project. It's on by default for projects with a UI. **[call]**
6. **Tech design and test plan, in parallel.**
   - The Tech Lead writes the Tech Design, any Interface Contracts, and **Tickets**.
   - The QA Engineer writes the **Test Plan** from the acceptance criteria and the UX design, *before any code exists*, together with tickets for test harnesses (for example, a dataset replay harness).

   There's no checkpoint here by default. The Judge's `risk.needs_human` can raise one.
7. **Build loop.** Each ticket goes through the task lifecycle (§7.2) and is merged into the milestone's integration branch.
8. **Verify.** QA runs the Test Plan against the integration branch:
   - automated suites
   - dataset replays
   - scripted UI runs
   - **Human Test Tasks** where a human is needed (§9.3)

   QA marks each acceptance criterion `passing` or `failing` with evidence. Failures become **Bug** artifacts, which turn into tickets and go back through the build loop.
9. **Milestone review.** The PM compiles a **Milestone Review**:
   - an acceptance-criteria table with evidence
   - known issues
   - cost and time spent
   - deviations from plan

   **CP4:** the stakeholder accepts. Only then does the engine merge the integration branch into `main`, or prepare the merge for one click. **[call]** Merging locally is the default; a PR mode is optional.
10. **Retro.** The Reflector processes the milestone's outcomes into knowledge deltas (§8.3). The next milestone starts from the Roadmap.

### 7.2 Task and attempt lifecycle **[call]**

```
task:    queued → ready → running → checks → review → [qa] → done
                    ▲        │         │        │
                    │        ▼         ▼        ▼
                    └── retry (new attempt, fresh worktree) ◄── failed / changes_requested
         any → blocked(on: human_request | dependency | path_lock) → ready
         any → escalated (stall / budget / attempts exhausted) → (human decision) → ready | cancelled
attempt: starting → running → (succeeded | failed | timeout | budget_exceeded | invalid_output | cancelled | interrupted)
```

1. **`ready`** means all dependencies are done, no other running ticket holds an overlapping path lock, and nothing is blocked on a human.
2. **`running`**: the engine builds the manifest (§8.5), creates a fresh worktree from the integration branch's head, and starts the adapter.
3. **`checks`**: deterministic checks run in that worktree:
   - Environment Profile build, lint and test commands
   - write-scope validation of the diff
   - output-schema validation

   Any failure means the attempt failed, with the check output as evidence.
4. **`review`**: the Code Reviewer runs as its own fresh task over the diff, the ticket and the Change Report.
   - **Changes requested:** a new Engineer attempt starts, with the Review Report as an extra input.
   - **Approved:** the engine merges the worktree into the integration branch. On a conflict it either retries the rebase or creates a "resolve conflict" attempt.
   - **`qa`** **[call]**: when a ticket's `ac_refs` name criteria that QA verifies per ticket, the ticket waits after merge in `qa` until a QA task has checked them on a clean checkout of the integration branch. Other tickets go straight to `done`, and the milestone-level Verify (§7.1) still runs.
5. **Retry inputs.** A retry attempt receives the *previous attempt's Change Report and the failure evidence*, never its transcript.

### 7.3 Scheduling **[call]**

- **Parallelism.** Default: 3 concurrent workers, configurable.
- **Path locks.** Each ticket declares expected paths (globs) in its `touches` field. Two tickets with overlapping globs never run at the same time. Engineer work is serialized by these locks; reads are free.
- **Priority order:**
  1. blocking human-verification prerequisites
  2. bugs on the current milestone
  3. critical-path tickets
  4. everything else
- **Pre-flight check.** The engine checks the Environment Profile's smoke command before starting a batch.

### 7.4 Stall and loop control **[call]**

Each task keeps a **progress ledger** (inspired by Microsoft's Magentic orchestration): one entry per attempt with its outcome, failing checks and a short delta summary.

- **Judge question.** After each failed attempt, the engine asks `progress.stall` (*progressing / looping / blocked*).
- **Escalation triggers.** Any of the following escalates the task:
  - `stall ≥ 2`
  - attempts at the cap (default 3)
  - the task budget exhausted
- **Escalation path:**
  1. **Replan once.** The Tech Lead gets the ledger and either re-splits or redefines the ticket.
  2. **If it stalls again,** an **Inbox question** goes to the stakeholder with the ledger and the team's recommendation.
- **Failure classes.** Each failure is classified by the Judge (`failure.class`): `code_bug`, `flaky_test`, `env_issue`, `spec_ambiguity`, `permission_denied` or `external_dependency`. The engine acts on the class:

  | Class | Action |
  |---|---|
  | `env_issue` | Pause the queue and run an environment-fix task. |
  | `spec_ambiguity` | File a Change Request to the PM, not another retry. |
  | `flaky_test` | Re-run checks once before counting a failure. |

### 7.5 Locked acceptance criteria and change requests **[call]**

- **Status updates.** Acceptance-criteria status (`unverified`, `passing`, `failing`, `waived`) can be updated only by a QA verification task, and only with an evidence reference.
- **Text changes.** The criteria text lives in the approved Spec version. To change it, any role files a **Change Request** artifact:
  - the target artifact and section
  - the proposed text
  - the rationale
  - the evidence

  The owner role (the PM, for specs) recommends a decision. **Changes to criteria text always go to the stakeholder.** Other changes, such as UX or tech design, are decided by the owner role unless the Judge flags them as risky.
- **Approval propagates.** An approved change creates a new artifact version. Lineage marks everything derived from it **stale** (§11.3).

### 7.6 Budgets **[call]**

| Level | Holds |
|---|---|
| Per attempt | Turn cap and dollar cap, passed through to the adapter. |
| Per task | Total spend across all its attempts. |
| Per milestone | Total spend for the milestone. |
| Per project | Total spend for the project. |

Defaults **[call]**: $3 per attempt, $10 per task, $150 per milestone, $600 per project, all configurable per project.

**Usage windows.** **[call]** On subscriptions the dollar figures are estimates, and the real limit is each plan's usage window.
- When an adapter reports a usage or rate limit, the engine pauses that vendor's queue. The running attempt becomes `interrupted` and is re-queued.
- The pause shows on the Overview. The queue resumes at the reported reset time, or probes with backoff when none is given.
- Work for the other vendor continues.
- Optional **weekly caps**, per project and across all projects, stop new attempts once reached.
- When any budget runs out, the default is to escalate with an Inbox item; the alternative is to pause.

- **Warnings.** Each level warns at 80%.
- **Hard stop.** At 100% the level stops (escalates) and creates an Inbox item to raise or end it.
- **Reporting.** Spend is attributed per role, model, adapter and task.

### 7.7 Crash safety **[call]**

- **What's persisted.** All state is in SQLite:
  - the state machines
  - the event log
  - pending Inbox requests
  - judgments
- **What changes on disk.** Workers only change their own worktree. The engine is the only writer to integration branches, `main` and the project state repo (§11.1).
- **On restart:**
  - attempts whose process is gone become `interrupted`, and the task returns to `ready`, where a new attempt gets a new worktree
  - half-done merges are detected with git and rolled back
  - SQLite is reconciled against the state repo's HEAD. Git holds artifact and memory content; SQLite holds workflow state and the commit SHA of each artifact version. The engine commits to git first, then records the SHA.
  - pending Inbox items reappear unchanged
- **Request IDs.** Inbox answers are matched by request ID, never by position.

---

## 8. Knowledge system

This is the heart of "agents accumulate expertise". It's built conservatively because the 2026 evidence is clear: *self-generated, unvetted knowledge makes agents worse*.
- SkillsBench: −8 to −11.5 points.
- An AGENTS.md study: LLM-written context files lowered success and raised cost by 20%.
- ACE: a full model rewrite collapsed one playbook from 18k tokens to 122 and scored below having no playbook at all.

### 8.1 Two tiers **[user]** (intent) **[call]** (structure)

| Tier | Contains | Scope | Lives in | Who edits |
|---|---|---|---|---|
| **Role playbook** | How to do this role well: procedures, pitfalls, tool tips, forbidden moves | Cross-project; per role and specialty | Knowledge repo `~/.aiteam/knowledge` (git) | Delta applier (code), only from approved deltas |
| **Project memory** | Facts about this project: conventions, commands, decisions, gotchas | One project | Project state repo `memory/` (§11.1), snapshotted into the target repo at CP4 | Delta applier, from screened deltas |

### 8.2 Entry format **[call]**

Entry *content* lives in git so it can be reviewed and reverted. Entry *statistics* (counters, last used) live in SQLite, so stats churn doesn't pollute git history.

```yaml
# roles/engineer.watchos/entries.yaml (one list, sorted by id)
- id: ewos-0012
  section: tool-tips            # procedure | specs | advice | forbidden | required-inputs | tool-tips | pitfalls
  text: >
    For >=100 Hz accelerometer/gyro on watchOS use CMBatchedSensorManager;
    CMMotionManager is capped lower and throttled in background.
  tags: [platform:watchos, api:coremotion, phase:build]
  status: active                # candidate | active | demoted | retired | graduated
  origin: { kind: reflector, project: wrist-gestures, attempt: A-0153 }
  evidence: [project:wrist-gestures/attempt/A-0153, project:other-proj/attempt/A-0031]
  confirmed_in_projects: 2
  created: 2026-10-19
  last_validated: 2026-10-19
```

- **Entry length.** At most about 80 words. The entry is a rule or fact, not an essay.
- **Sections.** Adapted from Devin's playbook structure: Procedure, Specifications, Advice, Forbidden, Required inputs, plus Tool tips and Pitfalls.
- **Rendering.** At injection time the selected entries are rendered as a SKILL.md-style block, which is portable across Claude Code, Codex and OpenHands.
- **Seed playbooks.** The app ships small, **human-curated** playbooks for each base role. Curated beats self-generated by a wide margin in every study.

### 8.3 Capture: evidence-gated reflection **[call]**

- **Triggers.** A Reflector task runs after an attempt that has an *objective outcome signal*:
  - checks failed
  - review requested changes
  - QA failed an acceptance criterion
  - a ticket was reopened
  - the stakeholder rejected an item at a checkpoint (the highest-value signal)
  - success after an earlier failure

  It also runs at milestone retro, over the whole milestone. Plain first-pass successes don't trigger reflection; they only update counters.
- **Inputs.** The attempt's manifest, its Change Report, the evidence (check output, review findings, QA results, the human's comment) and the outcome. Never the raw transcript, except as a capped excerpt around the failure.
- **Output.** At most 3 **deltas**, each with evidence references:
  - `ADD {section, text, tags, tier: project}`
  - `EDIT {id, new_text}`
  - `UPVOTE {id}`
  - `DOWNVOTE {id}`
  - `RETIRE {id, reason}`
- **The worker never writes knowledge.** The Reflector proposes; code applies.
- **Failure lessons count.** They're kept as `pitfalls`. ReasoningBank showed failure lessons add value.

### 8.4 Screening, promotion, pruning **[call]**

1. **Screen.** For each `ADD` or `EDIT`, the Judge answers `lesson.screen` (specific? supported by the cited evidence? non-obvious?) and `lesson.duplicate_of` (over the top 10 full-text-search candidates). A duplicate becomes an `UPVOTE` or `EDIT` of the existing entry.
2. **Project tier.** A screened delta is applied automatically to project memory as a `candidate`: injected for this project only, and a candidate for the role tier. It's low-risk and visible in the project's Knowledge tab.
3. **Promotion to the role playbook.** An entry becomes a *promotion proposal* when either:
   - an equivalent lesson is confirmed in **2 or more projects**, or
   - the stakeholder promotes it by hand.

   In v1 **every role-tier change is approved by the stakeholder** in the Inbox (Knowledge proposals). Proposals are batched weekly or per milestone, so the Inbox stays quiet. This guards against over-generalised lessons poisoning a whole role (the OEP and RIZZ findings).
4. **Counters.** The manifest records which entries were injected. When the task finishes:

   | Outcome | Effect on each injected entry |
   |---|---|
   | First-pass success | `helpful += 1` |
   | The Reflector cites an entry as wrong or misleading | `harmful += 1` |

   Attribution is noisy, so counters are *signals for review*, not automatic deletion triggers.
5. **Demotion.** If `harmful ≥ 3` and `harmful > helpful`, the entry becomes `demoted` (no longer injected) and is queued for review.
6. **Expiry.** An entry not injected for 60 days, or for 50 eligible tasks, gets `last_validated` re-checked. Stale entries are demoted. (Copilot Memory uses a 28-day expiry.)
7. **Size cap.** Each role-plus-specialty playbook has a cap (default **150 active entries or 8k tokens**). Over the cap, a consolidation job proposes explicit `EDIT` / `RETIRE` deltas that merge near-duplicates. **It never rewrites the playbook wholesale.**
8. **Graduation.** A stable, mechanical entry (for example, "never import X in module Y") can become a lint rule, test template or script, through a Tech Lead ticket. The entry is then marked `graduated` and stops costing context, because the check enforces it.
9. **Versioning and rollback.** Every applied role-tier delta is a git commit in the knowledge repo. The UI shows the history, and any commit can be reverted.

### 8.5 Selection: the budgeted manifest **[call]**

For each attempt, the **context builder** assembles the following:

| Part | Budget (default) | Source |
|---|---|---|
| Role charter | ≤ 600 tok | `charter.md` |
| Playbook entries | ≤ 2,000 tok | role + specialty playbook |
| Project memory | ≤ 1,000 tok | project state repo `memory/` |
| Task inputs | remainder up to the role's context budget (12k) | the specific artifacts and **sections** referenced by the ticket |
| Output contract | small | role schema + write scope + definition of done |

How playbook entries are chosen:

1. **Filter.** Keep `active` role entries, plus this project's `candidate` entries, whose tags intersect the task's tags. A ticket's tags come from its specialty, the project's stack tags and the phase.
2. **Rank.** Combine:
   - SQLite full-text relevance to the task text
   - helpful ratio
   - the Judge's `playbook.relevance` score for the top 30 candidates
3. **Pack.** Add entries greedily until the budget is reached. *Few, focused sections beat comprehensive ones* (SkillsBench: +19 points for 2–3 focused modules vs. +0.7 for comprehensive). Never inject repository overviews; the worker explores the repo with its own tools.

**Logging.** The full manifest is stored per attempt: entry IDs, artifact versions, model, adapter, flags and budgets. Runs are reproducible, counters can be attributed, and the UI shows exactly what each worker knew.

### 8.6 Measuring whether learning works **[call]**

Per role and specialty, across projects, the app tracks:
- attempts per ticket
- first-pass review approval rate
- cost per ticket
- QA failure rate

It also tracks per-entry injection-versus-outcome tables.

A **replay suite** comes in a later milestone (§16, M7). It holds a small set of recorded past tasks with deterministic checks, re-run with the old and new playbook before a batch of role-tier changes is activated. Until then, stakeholder approval plus rollback is the safety net.

---

## 9. The human in the loop

### 9.1 Inbox: the single channel **[user]** (the team tells me what it needs) **[call]** (form)

Every request to the stakeholder is an **Inbox item** persisted with an ID. There are four types:

| Type | Examples | Actions |
|---|---|---|
| **Approval** | Roadmap + Team + Human Requirements (CP1), Spec (CP2), UX Design (CP3), Milestone acceptance (CP4), Change Request touching ACs, risky change flagged by Judge | Approve · Request changes (comment) · Reject |
| **Question** | A decision the team can't make (scope trade-off, ambiguous requirement, escalated stall) | Pick an option · Write an answer. Each question carries options **and the team's recommendation** |
| **Human Task** | Physical/hands-on work: record sensor sessions, test on device, pair hardware, create an account, grant a permission | Step checklist · Upload results · Notes · Done / Can't do |
| **Knowledge proposal** | Promote/edit/retire role-playbook entries (batched) | Approve · Edit · Reject (per delta) |

**What every item shows:**
- who is asking (role)
- why
- **what it blocks**
- the evidence
- the recommendation
- age

**Answers are durable.** An answer becomes an artifact (Decision Record or Human Test Result) with lineage, so the team never relies on memory of a conversation.

**Notifications.** v1 uses browser notifications. **[call]**

### 9.2 Checkpoint policy **[call]**

| Checkpoint | Default |
|---|---|
| CP1 Roadmap + Team + Human Requirements | Required |
| CP2 Milestone Spec (locks ACs) | Required |
| CP3 UX Design | On for projects with UI; else off |
| CP4 Milestone acceptance (merge to main) | Required |
| Change Requests touching AC text | Required |
| Risky changes (auth, data deletion, migrations, dependency adds, cross-repo contracts) | Judge-gated (`risk.needs_human`) |
| Role-playbook changes | Required (batched) |

Everything else runs without asking.

### 9.3 Human Tasks and datasets **[call]**

This is driven by the dogfood project. Simulators have no real sensors, so gesture work needs real wrist data and on-device checks.

- **Who creates them.** QA, or a spike, creates a **Human Task**:
  - purpose
  - steps
  - what to record
  - an upload schema (file types, metadata such as session duration or labelled gesture counts)
  - the estimated time
  - the acceptance criteria and tickets it unblocks
- **Uploads.** Uploaded files become a **Dataset** artifact: versioned, with metadata, stored under `data/` in the project state repo, with Git LFS for files larger than 5 MB. When tests need a dataset as a fixture, a QA ticket copies the needed slice into the target repo.
- **How QA uses datasets.** QA turns them into fixtures and metrics:
  - replay harnesses compute detection rate, false triggers per hour, latency and battery drain
  - the metrics are the evidence for acceptance criteria
- **Batching.** The PM's Human Requirements (CP1) predicts the hands-on load per milestone, and Human Tasks are batched, so the stakeholder gets a few planned sessions instead of a stream of interruptions.

---

## 10. Judge layer

### 10.1 Interface **[call]**

```ts
judge(decision: DecisionType, state: JudgeState /* ≤ 24k tokens, curated */,
      q: { kind: 'noul' } | { kind: 'choice'; options: string[] } | { kind: 'score'; levels: string[] })
  → { answer; distribution: number[]; confidence: number; provider: 'jev' | 'llm'; latencyMs; judgmentId }
```

- **Providers.**
  - **Jev** (TypeSafe AI, `POST /v1/systemone`) is primary.
  - **LLM fallback**: the model-API adapter with structured output, mapped to the same typed answer, with the LLM's self-reported probabilities treated as *uncalibrated*.
  - **Without Jev**, the LLM provider becomes primary. Its confidence comes from agreement across 3 samples, not self-reported probability. Thresholds start stricter (auto ≥ 0.9) until the calibration log supports loosening them. **[call]**
- **Jev constraints the builder must respect:**
  - 64k input, of which 32k is the state.
  - Questions in one call are answered in parallel, so dependent questions need sequential calls.
  - The state summarizer always sends curated summaries, never raw logs.

### 10.2 Decision catalog (v1) **[call]**

| Decision | Kind | Used by |
|---|---|---|
| `triage.specialty` | choice | Assign a ticket to a specialty when the Tech Lead didn't |
| `triage.size` | score (S/M/L) | Model routing (§6.5) |
| `ux.needed` | noul | Whether a milestone/ticket needs UX design |
| `playbook.relevance` | score | Manifest selection (§8.5) |
| `progress.stall` | choice | Loop control (§7.4) |
| `failure.class` | choice | Failure handling (§7.4) |
| `risk.needs_human` | noul | Checkpoint gating (§9.2) |
| `lineage.affected` | noul | Whether a stale-flagged dependent truly needs rework (§11.3) |
| `lesson.screen` | noul ×3 | Knowledge screening (§8.4) |
| `lesson.duplicate_of` | choice | Knowledge dedup (§8.4) |

### 10.3 Confidence gating and calibration **[call]**

**Per-decision thresholds** (defaults):
- Confidence of **at least 0.85**: the engine acts on the answer.
- Confidence **from 0.60 up to 0.85**: the question goes to the LLM fallback with a strong model.
- **Below 0.60**, or the two judges disagree: the question becomes an Inbox **Question**.

**Escalation-tier rule.** The engine acts on the escalation tier's answer only when it agrees with the first tier *and* its own confidence is at or above the auto threshold. Anything else, whether disagreement or agreement below the threshold, becomes an Inbox Question that shows both answers.

`risk.needs_human` is the exception. It is asymmetric: a "yes" at ≥ 0.4 goes to the human.

**Calibration logging.** Every judgment is logged with its later outcome when one exists. Examples:
- the `ux.needed = no` milestone that later got a UX bug
- the `failure.class = flaky_test` that failed again

A calibration view per decision type shows whether stated confidence matches reality. This is where thresholds get tuned.

**What the Judge never does:**
- certify that work is done
- judge whole plans
- serve as the only gate on role-playbook changes

Even Jev's promoters say it can't yet catch plan-level errors.

---

## 11. Artifacts, workspace, repositories

### 11.1 Artifact model **[call]**

Artifacts are Markdown with YAML front matter, plus an optional fenced JSON block that's validated against the type's schema. **Where they live.** **[call]** Each project has an engine-owned **project state repo** at `~/.aiteam/projects/<project>/state/` (git). It holds `artifacts/<type>/<id>.md`, `memory/` and `data/`, and SQLite indexes it. Keeping it outside the target repo means:
- The Brief, Roadmap and CP1 artifacts have a home before any milestone branch exists.
- Project memory survives a milestone that is never accepted.
- Nothing is committed to the target repo's `main` outside CP4, and the stakeholder can keep committing to `main` while a milestone runs.

Workers receive artifact content through the manifest, plus a read-only path to the state repo for following references. At CP4 the engine snapshots `artifacts/` and `memory/` into the target repo's `.aiteam/` as the last commit on the integration branch, so the project's history travels with its code.

```yaml
---
id: SPEC-M1
type: milestone_spec
version: 3
status: approved            # draft | proposed | approved | superseded | stale
owner_role: pm
derived_from: [ROADMAP@2, SPIKE-REPORT-2@1, CR-7@1]
acceptance_criteria: [AC-1, AC-2, AC-3, AC-4, AC-5]
approved_by: stakeholder
approved_at: 2026-10-19T18:02:00Z
---
```

**Types:**
- **Product and planning:**
  - Brief
  - Roadmap
  - Team Proposal
  - Human Requirements
  - Environment Profile
  - Spike, Spike Report
  - Milestone Spec
- **Design:**
  - UX Design (+ prototype file)
  - Tech Design
  - Interface Contract
  - ADR
- **Work and verification:**
  - Ticket
  - Change Report
  - Review Report
  - Test Plan
  - QA Report
  - Bug
  - Human Task, Human Test Result
  - Dataset
- **Decisions and closure:**
  - Change Request
  - Decision Record
  - Milestone Review
  - Retro

**Ticket fields** (required):
- `ac_refs`
- `specialty`
- `touches` (path globs)
- `depends_on`
- `definition_of_done` (checks to run)
- `inputs` (artifact IDs, and section anchors where possible)
- `size`

**Rule:** an artifact type that no downstream role consumes isn't created. This avoids MetaGPT's ceremonial "competitive quadrant charts".

### 11.2 Workspace and git **[call]**

- **Branches.**
  - The milestone integration branch is `aiteam/m<n>`.
  - Each attempt gets a worktree at `~/.aiteam/worktrees/<project>/<task>-a<k>`, branched from the integration head.
  - Spike branches are `aiteam/spike-<id>` and are never merged.
- **Write-scope enforcement.** After an attempt, the engine diffs the worktree against its base. Any path outside the role's `write_scope`, or any change under `.aiteam/`, fails the attempt with a `scope_violation`. Adapter permission flags restrict writes too, but the diff check is the authority.
- **Merges.** The engine merges into the integration branch after review approval, and into `main` only after CP4. The stakeholder may keep committing to `main` during a milestone. The engine merges `main` into the integration branch at milestone start and again before CP4; any conflict becomes a "resolve conflict" task.
- **Apple toolchains.** Builds use `-derivedDataPath` inside the worktree so they work under the sandbox. Roles with an Apple specialty get a declared sandbox exception for `xcodebuild` and `simctl` (simulator service access).
- **Cleanup.** Worktrees are removed after merge or abandonment. Failed attempts' worktrees are kept for 7 days for debugging. **[call]**
- **Worker environment.** Workers inherit an **allow-listed** set of environment variables. Secrets are referenced through the OS keychain or the CLIs' own logins, never written into prompts or artifacts.

### 11.3 Lineage and staleness **[call]**

- **Marking.** When an artifact gets a new approved version, every artifact whose `derived_from` names an older version is marked `stale`. When `derived_from` names a section (`TEST-PLAN@2#4`), only that section is marked, and only if it changed.
- **Filtering.** The Judge (`lineage.affected`), given the version diff and the dependent's relevant sections, sorts them:
  - `affected`: the owner role gets a "revise" task
  - `unaffected`: the dependent is re-pinned to the new version, and the decision is logged
- **Tickets.** If a stale ticket is in flight, its running attempt finishes, but merging waits until the ticket has been re-validated.

### 11.4 Reference repos and cross-repo work **[call]**

- **Reference repos.** A project can attach other repos read-only, for example `ar-hud` for the watch app. A reference can be any folder, git or not; `ar-hud` today holds only its design doc. Workers get them as read-only paths.
- **Interface Contracts.** Integration with another repo is defined by an **Interface Contract** artifact: messages, schemas, transport, versioning. Both sides work against the contract.
- **Changes on the other side.** These happen in that repo's own project. The contract artifact is shared by reference, and a change to it raises a Change Request in both projects.
- **Out of scope for v1:** multi-repo atomic changes.

---

## 12. Web UI

The mockups in `2026-10-19-ai-team-ui-mockups.html` use the watch-app project as sample data. The UI is a thin control room over the engine: every action maps to an engine command or an Inbox answer. **[call]**

| Screen | Purpose | Key elements |
|---|---|---|
| **Projects** | All projects at a glance | Status, current milestone, needs-you count, spend |
| **Overview** | One project's "war room" | Milestone strip; current milestone AC progress; team roster with live status; Inbox preview; activity feed (engine + judge events); spend by role; budget |
| **Flow** | How work moves through the team, live | Three views: **milestone swimlanes** (roles × phases, artifacts as nodes, checkpoints as gates in the stakeholder's lane, review/bug/change-request loops, stale paths); **ticket lifecycle** (the §7.2 state machine with live counts per state); **learning loop** (outcome → Reflector → screening → project memory → promotion → playbook → next manifest, with live counts). Clicking a node opens its details and links to the matching screen |
| **Inbox** | Everything that needs the stakeholder | Grouped by type with "blocks …"; detail pane per type (approval with diff, question with options + recommendation, human task runner with steps/uploads, knowledge proposal with evidence) |
| **Board** | Ticket flow | Columns Ready · Running · Review · QA · Blocked · Done; cards with specialty, attempts, cost, AC refs |
| **Task detail** | Debug/inspect one task | Attempt timeline; tabs: Live log (normalized events), **Manifest** (exactly what the worker got, with budget meters), Diff, Evidence, Judgments |
| **Documents** | Artifacts and traceability | Artifact list with status; **lineage graph** with stale paths; version diffs; **AC traceability matrix** (AC → tickets → tests → evidence → status) |
| **Team & Knowledge** | Roles and their expertise | Roles/specialties; playbook entries with tags, counters, status; size vs cap; delta history with revert; learning metrics (§8.6) |
| **Settings** | Policy | Adapter/model per role; budgets; checkpoint policy; judge thresholds; Jev key; max parallel workers |

**UI calls from the mockup review** **[call]**:
- **Roster.** One row per role, with a count of its live sessions. Expanding a row lists each session and its task.
- **Scope.** The nav separates project screens (Overview, Inbox, Board, Documents) from workspace screens (Team & Knowledge, Settings). The Inbox opens on the current project with an *All projects* toggle, and the nav badge counts all projects.
- **Evidence.** Worker test runs appear on Task detail as information only. Acceptance-criterion evidence and the traceability matrix show only QA results (G8).
- **Staleness** is shown per section wherever lineage names sections (§11.3).
- **Reviewer assignment.** The Code Reviewer's vendor is chosen per change, opposite to the author's (§6.5).
- **Risky changes.** A `risk.needs_human` flag holds the merge, not the running attempt. Rejecting starts a new attempt in a fresh worktree with the stakeholder's comment as input.

**Live updates.** These use server-sent events from the event log. The UI never polls workers directly.

---

## 13. Persistence layout

```
~/.aiteam/
  aiteam.db                 # SQLite: projects, FSM state, tasks, attempts, inbox, judgments,
                            #         event log, entry stats, AC status, costs
  knowledge/                # git repo — role definitions + playbooks (cross-project)
    roles/<role>/role.yaml, charter.md, entries.yaml
    schemas/*.json
  projects/<project>/state/ # git repo — engine-owned project state (§11.1)
    artifacts/<type>/<id>.md
    memory/entries.yaml
    data/<dataset-id>/...   # (LFS when large)
    project.yaml            # tags, environment profile ref, reference repos, policies
  worktrees/<project>/<task>-a<k>/
  transcripts/<project>/<attempt>.jsonl     # raw worker streams (debug only)
  config.yaml               # adapters, keys refs, defaults

<target-repo>/.aiteam/      # snapshot of artifacts/ + memory/, committed at CP4 only
```

---

## 14. Security and safety **[call]**

- **Network surface.** The daemon binds to `127.0.0.1`. No remote access in v1.
- **Worker permissions** are the minimum for each role:
  - The PM, UX Designer and Tech Lead get repository read access and write access only to their scratch output. The engine writes their artifacts from their structured output.
  - Engineers write inside their worktree only.
  - Network access is restricted where the adapter supports it, using Codex `--sandbox` and Claude permission rules plus its sandbox.
- **Untrusted repos.** For repos the stakeholder didn't author, Claude runs in `--bare` mode, so project hooks and `.mcp.json` don't execute implicitly.
- **Dangerous operations** require a Judge-gated Inbox approval:
  - deleting files outside the ticket's `touches`
  - adding dependencies
  - modifying CI, auth or migrations
- **Apple signing and devices.** **[user]** Workers with an Apple specialty may sign with the stakeholder's development team (automatic signing) and install development builds to the paired watch and to simulators. Distribution signing, TestFlight and App Store Connect stay with the stakeholder as Human Tasks. So do wearing, unlocking and testing the watch.
- **Stakeholder-only actions.** Workers never push to remotes, publish, or create external accounts. Those are Human Tasks.

---

## 15. Dogfood scenario: "Wrist Gestures for SPECS" **[user]** (project) **[call]** (walk-through)

1. **Brief.** "An Apple Watch app that uses the watch's sensors to help SPECS hand tracking and gesture detection, integrating with `ar-hud`." `ar-hud` is attached as a reference repo. It is built outside AI Team and today is only a design doc, so M3 (link to the hub) waits until the hub exists. **[call]**
2. **Discovery.**
   - **Roadmap:** M0 feasibility spikes; M1 gesture recorder and dataset; M2 on-watch pinch detector; M3 link to the `ar-hud` hub; M4 calibration and haptics UX.
   - **Team Proposal** adds `engineer.watchos` and `engineer.signal-ml`.
   - **Human Requirements:** Apple Watch with developer mode, an Xcode signing team, SPECS paired with `ar-hud`, and about 1 hour of recording sessions in M1 and 30 minutes in M2.
   - **CP1.**
3. **M0 spikes:**
   - "Can wrist IMU detect a pinch at ≥ 90% recall with < 1 false trigger per 10 minutes?" This needs a Human Task to record 3 short sessions.
   - "What's the p95 latency from watch to Mac over the local network?" This is measured against a stub receiver, since the hub isn't built yet. **[call]**

   Spike Reports come back GO or NO-GO. A NO-GO reshapes the roadmap through the PM.
4. **M1.** The spec has acceptance criteria for 100 Hz capture, export, a labelling UI with haptics, battery drain, and a dataset of at least 300 labelled pinches.
   - QA's Test Plan includes a replay harness and a Human Task to record 3 × 10-minute sessions.
   - Engineers work tickets in parallel, using path locks.
   - The stakeholder spends roughly 35 minutes on one Human Task.
   - QA verifies with replay metrics.
   - **CP4.**
5. **Learning shows up as:**
   - `engineer.watchos` entries about CoreMotion rates and extended runtime sessions in project memory
   - after a second watchOS project confirms them, a promotion proposal for the role playbook

---

## 16. Build milestones (for the builder) **[call]**

| # | Milestone | Done when |
|---|---|---|
| M1 | **Engine skeleton + Claude adapter** | A hand-written ticket runs in a fresh worktree with a logged manifest, in an isolated agent home on the subscription login (no user config in the worker's context); checks run; attempt FSM + event log + crash recovery work; minimal Task detail UI with live log |
| M2 | **Artifacts + roles end-to-end** | PM → Tech Lead → Engineer → Reviewer → QA flow completes a small greenfield milestone; lineage + staleness; locked ACs + Change Requests; Inbox with approvals (CP1/2/4); Board + Documents UI |
| M3 | **Agnostic workers + budgets** | Codex + model-API adapters; per-role model config; cross-model review; budgets with hard stops; cost views |
| M4 | **Knowledge v1** | Seed playbooks; manifest selection with budgets; Reflector deltas; screening; project memory auto-apply; role-tier proposals in Inbox; git history + revert; counters |
| M5 | **Judge layer** | LLM judge as primary (sample-agreement confidence) plus the Jev provider behind the same interface, switched on when a key exists; decision catalog; thresholds; calibration log/view; stall detection + failure classes wired into the engine |
| M6 | **Human tasks, datasets, UX, Apple toolchain** | Human Task runner + uploads → Dataset artifacts; UX Designer with HTML prototypes; Environment Profile for Xcode/watchOS; dev signing and install to the watch; dogfood project through M0–M1 |
| M7 | **Knowledge hardening** | Expiry + demotion + size caps + consolidation proposals + graduation tickets; replay suite for playbook changes; learning metrics (§8.6) |
| M8 | **Adopt existing repos** | Discovery over an existing codebase: the Tech Lead infers the Environment Profile and seeds project memory, with no repo overviews; a medium-size existing repo completes one milestone |

**Acceptance of the whole v1.** The dogfood project completes its M0 and M1, with the judge on the LLM provider (Jev isn't required), and with:
- no acceptance criteria changed without approval
- no worker context over budget
- every Inbox request carrying "blocks" and a recommendation
- at least one project-memory lesson that measurably shows up in a later attempt's manifest

---

## 17. Prior-art summary (why the [call]s look like this)

| Source | Took | Avoided |
|---|---|---|
| **MetaGPT / MGX (Atoms)** | Typed, schema'd handoff docs; documents record their dependencies; per-task manifest (AOrchestra) | LLM team-leader routing; raw-transcript cache as "experience"; verification = "compiles"; ceremonial artifacts |
| **ChatDev (+ ECL/IER)** | Experience pool must be pruned (IER kept 11.5% with equal/better quality); storing everything hurt (ECL) | Chat-chain handoffs; toy-scale greenfield-only focus |
| **ACE, ReasoningBank, ExpeL, AWM, Voyager** | Delta bullets with counters merged by code; failure lessons; ADD/EDIT/UP/DOWNVOTE; verified skills → graduation to checks | Full LLM rewrites (context collapse); unverified self-generated knowledge |
| **SkillsBench, AGENTS.md study, OEP, RIZZ, STALE (2026)** | Curated > generated; small focused modules; scope separation; verifier-gated memory updates; expiry | Repo-overview boilerplate; one global memory; single-episode generalisation |
| **CrewAI, LangGraph, Microsoft Agent Framework** | Human-feedback → per-role lessons (CrewAI); persisted pending HITL requests; Magentic progress ledger + stall counter; fork/replay | LLM manager control flow; node-level replay of long workers; pickle checkpoints; unbounded memory |
| **Factory Missions, Anthropic harness, Cursor, Copilot, Devin, OpenHands** | Fresh worker per feature; validators at milestones; feature list workers can only mark pass; memory expiry; playbook sections; SKILL.md format | Experimental agent teams (7× cost); always-on context files; thin dashboard as the product |
| **Jev (TypeSafe AI)** | Calibrated, cheap, typed judgments for bounded engine decisions | Using it for plan-level judgment or as sole gate; vendor lock-in (fallback provider) |

The full research notes are in `2026-10-19-ai-team-prior-art-research.md` in this folder.

---

## 18. Left to the builder

- Exact libraries (server framework, ORM, diff viewer, graph layout), within the stated stack.
- Prompt wording for role charters and seed playbooks. They must stay within the token budgets, and seed playbooks need stakeholder review before first use.
- Artifact JSON schemas, beyond the required fields named here.
- Exact SQLite schema.
- UI visual design details, guided by the mockups.
- Retention periods other than those stated.
- How the Environment Profile detects toolchains.
- Whether merges use merge commits or rebase.

## 19. Stakeholder answers (2026-10-20)

| Question | Answer |
|---|---|
| Subscription logins or API keys for workers? | Subscription, in an isolated agent home (§3, §6.2). |
| Must v1 adopt existing codebases? | No. Greenfield first; existing repos are M8. |
| Is there a Jev key? | Not yet. The LLM judge is primary until there is one (§10.1). Sending curated project state to TypeSafe is confirmed when the key is added. |
| May workers sign and install dev builds on the watch? | Yes, development builds only (§14). |

No questions remain open. The designer's calls added after the builder check:
- the project state repo outside the target repo (§11.1)
- default budgets and usage-window pauses (§7.6)
- the escalation-tier rule (§10.3)
- the M0 latency spike against a stub receiver, with M3 waiting for the hub (§15)
- the default model roster (§6.5)
- the UI calls from the mockup review (§12)
