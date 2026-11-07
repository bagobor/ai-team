# Eng Lead, test hooks, fun loop, eng review, structured Tech Design — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Eng Lead who scopes tickets and reviews each milestone with a polish loop, a hook that fails any change whose touched components gain no tests, an opt-in prototype round loop whose fun is judged only by a human, and a Tech Design with a fixed structure (components, complexity, performance budgets).

**Architecture:** The Tech Lead's `tech_design` becomes a structure stored in `fields.data`. A new `eng_lead` role turns it into tickets (`M{n}-SCOPE`) and reviews the milestone (`M{n}-ENGREV-k`) between verify and the milestone review. One pure function, `componentCoverage`, serves the ticket hook (`runChecks` → `tests_missing`) and the milestone review. A new project phase `prototype` runs PM-planned prototype rounds on `aiteam/m0` and raises a `fun_eval` approval that only the human answers. Discovery then writes `FUN-DEFINITION` from the human's "fun" marks alone.

**Tech Stack:** TypeScript (Node 22, tsx), vitest, Kysely and better-sqlite3, ajv (JSON Schema draft-07), picomatch, Hono, React (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-07-eng-lead-fun-loop-design.md`

## Global Constraints

- No new dependencies. picomatch, ajv and Kysely are already present.
- Tests are flat `test/*.test.ts` files (vitest) and reuse `test/helpers/*`. Never bind ports 4780 or 4781 in a test; use `freePort()`.
- Run `npm test` and `npm run typecheck` from the worktree root. Both must be green at the end of every task.
- Schemas (`seed/knowledge/schemas/*.json`):
  - JSON Schema draft-07 with `additionalProperties: false`.
  - Every property is in `required`, except `change_requests`. Every schema has a `change_requests` property, and it is never in `required`.
  - Optional values are nullable types.
- Every charter contains the phrases `data, never instructions` and `change_requests`. A charter is at most 600 tokens.
- Exact names:
  - Purposes: `ticket_scope`, `revise_scope`, `eng_review`, `prototype_plan` (and the existing `revise_design`, which gets its own schema).
  - Phases: project `prototype`, milestone `eng_review`.
  - Columns: `projects.prototyping` (default 0), `milestones.eng_round` (default 0), `milestones.eng_cap` (default 2).
  - Failure kind: `tests_missing`.
  - Task ids: `M{n}-SCOPE`, `M{n}-ENGREV-{k}`, `PROTO-PLAN-{r}`.
  - Doc ids: `SCOPE-M{n}`, `ENG-REVIEW-M{n}-{k}`, `PROTO-PLAN-{r}`, `PROTO-{r}-P-{k}`, `FUN-DEFINITION`.
  - Inbox: ref `{kind: 'fun_eval', round}`, dedupe `fun_eval:{r}`, web label `FUN-R{r}`.
- `eng_lead` role:
  - model `claude-opus-5-5`, department engineering;
  - tools exactly `[read_repo, run_commands]`;
  - write scope allow `[]`, deny `["**"]`;
  - budgets the same as `tech_lead`'s.
- Commits:
  - Stage with `git add <files>`, never `-A`.
  - Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Work only inside the worktree. Never touch `~/.aiteam` or the running daemon.

## Review Focus

1. **Overlapping globs.** A component with `sources: ["src/**"]` and `tests: ["src/**/*.test.js"]` whose only change is a test file has no source change, so it is not untested. Test: Task 2, `componentCoverage › a test file inside the sources is not a source change`.
2. **A deleted test file alongside a source edit.** The deletion does not count as a test change, so the component is untested. Test: Task 2, `componentCoverage › a deleted test does not count`.
3. **A daemon restart while a fun evaluation is pending.** The prototypes are mounted again, and the `Play` links in the pending item still resolve. Test: Task 8, `prototype › mounts a pending evaluation again after a restart`.
4. **Approving a fun evaluation when no round has a "fun" mark.** Discovery could never cite evidence, so the answer is refused with a message instead of leaving discovery to fail later. Test: Task 8, `store › refuses to approve a fun evaluation when nothing was marked fun`.
5. **A prototype ticket that is cancelled or escalated.** The round still reaches the human, with checks only for prototypes that have a page; a round with none says so in `why`. Test: Task 8, `prototype › evaluates only the prototypes that have a page`.

---

### Task 1: Foundations — columns, phases, the `--prototype` flag

**Files:**
- Modify:
  - `src/db/migrations.ts` (new key `'004_eng_lead_fun_loop'`)
  - `src/db/schema.ts`
  - `src/engine/store.ts` (`NewProject`, `createProject`, `patchMilestone`)
  - `src/engine/fsm.ts`
  - `src/engine/intake.ts`
  - `src/server/app.ts` (POST `/api/projects`)
  - `src/cli.ts`
- Test:
  - `test/migrations.test.ts`
  - `test/fsm.test.ts`
  - `test/store.test.ts`
  - `test/server.test.ts`
  - `test/cli.test.ts`

**Interfaces:**
- Produces:
  - `ProjectsTable.prototyping: Generated<number>`.
  - `MilestonesTable.eng_round: Generated<number>` and `eng_cap: Generated<number>`.
  - `NewProject = Pick<ProjectRow, 'name' | 'repo_path' | 'base_branch'> & { prototyping?: number }`.
  - `patchMilestone(projectId, n, patch: { verify_round?; verify_cap?; eng_round?; eng_cap? })`.
  - `ProjectPhase` gains `'prototype'`, and `MilestonePhase` gains `'eng_review'`.
  - `addProject(deps, { name, repoPath, create, prototyping?: boolean })`.
- Transitions added:
  - intake → prototype
  - prototype → discovery | halted
  - verify → eng_review
  - eng_review → build | milestone_review | halted
- **Keep `verify → milestone_review` for now.** Task 6 removes it.

- [ ] **Step 1: Write the failing tests.**
  - `fsm.test.ts › project › allows intake → prototype → discovery and refuses prototype → cp1`
  - `fsm.test.ts › milestone › allows verify → eng_review, eng_review → build | milestone_review | halted, and refuses eng_review → cp4`
  - `migrations.test.ts › 004 adds prototyping, eng_round and eng_cap with defaults 0, 0, 2`. It migrates a fresh DB, inserts a project and a milestone without the new columns, and reads them back as `0`, `0`, `2`.
  - `store.test.ts › createProject keeps prototyping, and patchMilestone sets eng_round and eng_cap`
  - `server.test.ts › POST /api/projects stores prototyping: true as 1 and refuses a non-boolean prototyping with 400`
  - `cli.test.ts › project add --prototype posts prototyping: true, and posts false without the flag`
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/fsm.test.ts test/migrations.test.ts test/store.test.ts test/server.test.ts test/cli.test.ts`
  - Expected: FAIL on the new cases only.
- [ ] **Step 3: Implement.**
  - The migration uses three `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT` statements, like `003_inbox_checks`.
  - The API validates `prototyping` the way it validates `create`: it may be absent, and otherwise must be a boolean.
  - `addProject` stores `prototyping ? 1 : 0`.
  - The CLI usage line becomes `aiteam project add <name> <repoPath> [--create] [--prototype]`.
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: all pass.
- [ ] **Step 5: Commit** with the message `feat: prototyping flag, eng_round/eng_cap columns, prototype and eng_review phases`.

---

### Task 2: Pure modules — the Tech Design structure and component coverage

**Files:**
- Create:
  - `src/engine/apply/tech-structure.ts`
  - `src/checks/coverage.ts`
- Test:
  - `test/tech-structure.test.ts`
  - `test/coverage.test.ts`

**Interfaces:**
- Produces, in `tech-structure.ts`:
  ```ts
  export type Size = 'S' | 'M' | 'L';
  export type ComponentSpec = { name: string; responsibility: string; sources: string[]; tests: string[]; no_tests_reason: string | null; complexity: Size; complexity_notes: string };
  export type PerformanceBudget = { metric: string; target: string; how_measured: string; component: string | null };
  export type TechStructure = { components: ComponentSpec[]; complexity: { overall: Size; rationale: string }; performance: PerformanceBudget[]; test_strategy: string; risks: { risk: string; mitigation: string }[] };
  export function structureProblems(s: TechStructure): string[];        // [] when valid
  export function renderTechDesign(body: string, s: TechStructure): string;
  export function structureOf(doc: { fields?: Record<string, unknown> } | undefined): TechStructure | undefined; // reads fields.data; undefined for an old, unstructured TECH
  ```
- Produces, in `coverage.ts`:
  ```ts
  export type PathChange = { path: string; status: string };          // git --name-status letter: A M D T …
  export type CoverageComponent = Pick<ComponentSpec, 'name' | 'sources' | 'tests' | 'no_tests_reason'>;
  export type ComponentCoverage = { name: string; sourceChanges: string[]; testChanges: string[]; untested: boolean; reason: string | null };
  export function componentCoverage(changes: PathChange[], components: CoverageComponent[]): ComponentCoverage[];
  export function coverageTable(rows: ComponentCoverage[]): string;     // markdown table: Component | Source changes | Test changes | Status
  export function untestedEvidence(rows: ComponentCoverage[], components: CoverageComponent[]): string;
  ```
- Rules:
  - `structureProblems` messages name the offender. For example: `component "loop": tests is empty and there is no no_tests_reason`.
  - Each glob goes through `touchesProblem` from `src/engine/apply/tickets.ts`.
  - Matching uses picomatch with `{ dot: true, nocase: true }`, as `run-checks` matches protected paths.
  - The Status cell is `untested`, `tested`, `no change`, or `exempt: <reason>`.
  - `untestedEvidence` lists each untested component, its first 5 changed source paths, and its test globs. It ends with `Add or update tests that match those globs.`

- [ ] **Step 1: Write the failing tests.**
  - `tech-structure.test.ts`:
    - `accepts a valid structure` (`[]`).
    - `refuses no components`, `duplicate or blank names`, `a source glob that touchesProblem rejects`, `empty tests without a reason`, `no performance entry`, `a blank metric/target/how_measured`, and `a blank test_strategy`. Each expects a message containing the component name or the field.
    - `renderTechDesign puts the headings in order`. It asserts that `## Overview`, `## Components`, `### loop`, `## Complexity`, `## Performance`, `## Test strategy` and `## Risks` appear in that order, and that the performance section is a markdown table with the header `| Metric | Target | How measured | Component |`.
    - `structureOf returns undefined for a doc without fields.data.components`.
  - `coverage.test.ts`, with `C = { name: 'loop', sources: ['src/**'], tests: ['src/**/*.test.js', 'test/**'], no_tests_reason: null }`:
    - `a source change without a test change is untested`:
      `componentCoverage([{ path: 'src/loop.js', status: 'M' }], [C])` → `[{ name: 'loop', untested: true, sourceChanges: ['src/loop.js'], testChanges: [], reason: null }]`
    - `an added or modified test makes it tested`: add `{ path: 'test/loop.test.js', status: 'A' }` and expect `untested: false`.
    - `a deleted test does not count` *(Review Focus 2)*: `{ path: 'test/loop.test.js', status: 'D' }` with a source change gives `untested: true`.
    - `a test file inside the sources is not a source change` *(Review Focus 1)*: only `src/loop.test.js`, status `M`, gives `sourceChanges: []`, `untested: false`.
    - `no_tests_reason exempts it`: `untested: false`, `reason` set.
    - `a deleted source still counts as a source change`.
    - `coverageTable shows exempt: <reason>`, and `untestedEvidence names the component, its paths and its globs`.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/tech-structure.test.ts test/coverage.test.ts`
  - Expected: FAIL, module not found.
- [ ] **Step 3: Implement both modules.**
- [ ] **Step 4: Run them, then the suite and the typecheck.**
  - Run: `npx vitest run test/tech-structure.test.ts test/coverage.test.ts && npm test && npm run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: tech design structure and component coverage`.

---

### Task 3: The `eng_lead` role, the `ticket_scope` and `revise_scope` appliers

At this point TECH still carries tickets; Task 4 switches it over. This task adds the Eng Lead's path next to the old one.

**Files:**
- Create:
  - `seed/knowledge/roles/eng_lead/role.yaml`
  - `seed/knowledge/roles/eng_lead/charter.md` (copy the layout of `roles/tech_lead/`)
  - `seed/knowledge/schemas/ticket_scope.json`
  - `seed/knowledge/schemas/revise_scope.json`
  - `src/engine/apply/scope.ts`
- Modify:
  - `src/engine/workorder.ts` (Purpose gains `ticket_scope` and `revise_scope`)
  - `src/engine/apply/ids.ts` (`scopeId`)
  - `src/engine/apply/tickets.ts`
  - `src/engine/apply/design.ts`
  - `src/engine/apply/index.ts` (APPLIERS)
  - `src/engine/ticket.ts`, or wherever `Ticket` and `parseTicket` live (the `components` field)
- Test:
  - `test/role.test.ts`
  - `test/apply-tickets.test.ts`
  - `test/apply-authoring.test.ts`

**Interfaces:**
- Consumes (Task 2): `structureOf` and `ComponentSpec`.
- Produces:
  - `export const scopeId = (n: number) => \`SCOPE-M${n}\``
  - In `tickets.ts`:
    - `export type TicketBatch = { prefix: 'T' | 'Q' | 'E'; docId: string; owner: string; components?: ComponentSpec[] }`
    - `validateTickets(ctx, milestone, drafts, acIds, existing, batch: TicketBatch, batchBody?)`. This replaces the old `prefix` parameter. Callers pass:
      - Q (test plan): `{ prefix: 'Q', docId: testPlanId(n), owner: 'tech_lead' }`. The owner is unchanged on purpose.
      - Old TECH path: `{ prefix: 'T', docId: techId(n), owner: 'tech_lead' }`.
      - Eng Lead path: `{ prefix: 'T', docId: scopeId(n), owner: 'eng_lead', components }`.
    - Prefix `E` matches `/^E-\d+$/`, and an empty `ac_refs` is allowed for it.
    - When `components` is given, every draft needs a non-empty `components: string[]` whose names all exist. Otherwise the error is `T-2: components names "renderer", which the Tech Design does not have`.
    - Each ticket doc keeps `components` in its fields. Its body gets `## Tests` appended: one line per named component, `- <name>: <tests globs joined by ", ">`, or `- <name>: no tests (<reason>)`.
  - `TicketDraft` and the ticket fields gain `components: string[]`. `parseTicket` defaults a missing `components` to `[]`, so older tickets still parse.
  - `applyTicketScope` (purpose `ticket_scope`):
    - Output: `{ body, tickets: TicketDraft[], stakeholder_note, change_requests? }`.
    - It needs `TECH-M{n}` with a structure; a TECH without one is an engine bug and throws.
    - It runs `validateTickets` with the Eng Lead batch, then the uncovered-criterion check (moved from `applyTechDesign`, sharing one helper).
    - It publishes `SCOPE-M{n}` (type `ticket_scope`, status approved, owner `eng_lead`, `approvedBy: 'owner:eng_lead'`, derivedFrom the inputs) and the tickets.
  - `applyReviseScope = applyRevise('T', { docId: scopeId, owner: 'eng_lead', components: true })`.
    - `applyRevise` is generalised so the T side can target either TECH (old) or SCOPE.
    - The output schema `revise_scope.json` equals `revise.json` with `components` in the ticket draft.
  - `eng_lead` `role.yaml`:
    - consumes `[brief, roadmap, milestone_spec, tech_design, test_plan, ticket_scope, qa_report, change_request]`;
    - produces `[ticket_scope, ticket, eng_review]`;
    - output_schemas: `ticket_scope`, `revise_scope`, `eng_review` → `schemas/eng_review.json` (that file comes in Task 6, so add this entry in Task 6), `cr_recommendation`.
  - The charter says:
    - the Eng Lead owns ticket boundaries, `touches`, `depends_on`, `definition_of_done`, `components`, `size`, and the tests each ticket adds;
    - one component's worth of change per ticket, naming that component;
    - the definition of done runs that component's tests;
    - the Eng Lead owns the milestone eng review, and a design that must change is raised as a change request against `TECH-M{n}`.

- [ ] **Step 1: Write the failing tests.**
  - `role.test.ts`:
    - `ROLES` gains `'eng_lead'`, with model `claude-opus-5-5` and tools exactly `['read_repo', 'run_commands']`.
    - `eng_lead` purposes are `['ticket_scope', 'revise_scope', 'cr_recommendation']` for now.
    - The schema count goes from 11 to 13.
    - `loadRole(seed, 'eng_lead', 'revise_scope').schemaSource` is `'schemas/revise_scope.json'`.
  - `apply-tickets.test.ts`:
    - `an E batch allows empty ac_refs and refuses a T-1 key`.
    - `a batch with components refuses an unknown component name`.
    - `a ticket keeps its components and lists their test globs under ## Tests`.
    - `a ticket without components still parses`.
  - `apply-authoring.test.ts › ticket_scope` publishes a structured TECH first, through `artifacts.commit`, with `fields.data` holding a valid `TechStructure` whose components are `core` and `ui`:
    - `publishes SCOPE-M1 and its tickets owned by eng_lead`: rows `[['SCOPE-M1','approved','owner:eng_lead'], ['M1-T-1','approved','owner:eng_lead'], ['M1-T-2','approved','owner:eng_lead']]`, and the tickets' derived_from starts with `'SCOPE-M1@1'`.
    - `rejects a scope that leaves a criterion without a ticket` (evidence `/AC-2/`).
    - `rejects a ticket without components`.
    - `revise_scope re-plans open tickets against SCOPE-M1`, mirroring the existing `revise` describe for the T side.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/role.test.ts test/apply-tickets.test.ts test/apply-authoring.test.ts`
  - Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** Update the existing `validateTickets` callers to the `TicketBatch` form, with no behaviour change for them.
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: eng_lead role with ticket_scope and revise_scope`.

---

### Task 4: The switch — a structured TECH, SCOPE in the design phase, revision routing

This is the one task where the flow changes shape. Every flow fixture moves its tickets from `M1-TECH` to `M1-SCOPE` in the same commit.

**Files:**
- Modify:
  - `seed/knowledge/schemas/tech_design.json` (the structure, no tickets)
  - create `seed/knowledge/schemas/revise_design.json`
  - `seed/knowledge/roles/tech_lead/role.yaml` (`revise_design` → `schemas/revise_design.json`; `produces` drops `ticket`)
  - `seed/knowledge/roles/tech_lead/charter.md` (no tickets; owns the structure and budgets)
  - `seed/knowledge/roles/qa_engineer/charter.md`, if it names the Tech Lead as the one splitting tickets
  - `src/engine/apply/design.ts`:
    - `applyTechDesign` takes `{ body } & TechStructure & { stakeholder_note, change_requests? }`;
    - `applyReviseDesign` becomes design only;
    - remove the old TECH ticket path.
  - `src/engine/conductor/tasks.ts`:
    - new `scopeTask`;
    - `replanTask` goes to eng_lead / revise_scope on SCOPE;
    - `testPlanTask` names the Eng Lead.
  - `src/engine/conductor/milestone.ts`:
    - `design()` creates SCOPE after TECH and TESTPLAN;
    - `STALE_BLOCKS` gains `'ticket_scope'`.
  - `src/engine/conductor/change-requests.ts` (`reviseStale` routing)
  - `src/engine/conductor/answers.ts` (`answerCp4` replan on SCOPE)
- Test fixtures:
  - `test/conductor.test.ts` (`ONE_TICKET` and `TWO_TICKETS` become SCOPE outputs, plus a `DESIGN` structure; `toBuild` finishes `M1-TECH` with the structure, ticks, then finishes `M1-SCOPE`)
  - `test/fixtures/m2-script.ts`
  - `test/helpers/large-milestone.ts`
  - `test/role-inputs.test.ts`
  - `test/apply-authoring.test.ts`
  - and any other file that scripts `tech_design` with `tickets` (grep for `tickets:` next to `tech_design`/`M1-TECH`)

**Interfaces:**
- Consumes:
  - Task 2: `structureProblems`, `renderTechDesign`, `TechStructure`.
  - Task 3: `scopeId`, `applyTicketScope`, `applyReviseScope`, the `TicketBatch` form.
- Produces:
  - `scopeTask(project, n, inputs: string[]): TaskSpec`. Ticket id `M{n}-SCOPE`, role `eng_lead`, kind authoring, purpose `ticket_scope`, base `BASE`. Its inputs are the pins of SPEC, ENV-PROFILE, TECH and TESTPLAN.
    - Instructions: `Split milestone {n} into tickets from the Tech Design's components. Every acceptance criterion must be covered by a ticket. Each ticket names its components and adds or updates their tests.`
  - `TECH-M{n}`:
    - `fields.data` is the `TechStructure`.
    - The body is `renderTechDesign(body, structure)`.
    - It is validated with `structureProblems`; the evidence lists every problem.
  - `revise_design.json` is `{ unaffected, rationale, design: <tech_design shape without change_requests and stakeholder_note> | null, change_requests? }`.
    - `unaffected: true` re-pins the inputs.
    - Otherwise `design` is required and is validated like `tech_design`.
  - `design()`:
    - When both TECH and TESTPLAN are done and SCOPE is missing, it creates `scopeTask`.
    - When SCOPE is done, it runs `runSmoke`, then `newTicketSpecs`, then build (the old "both done" branch, moved).
  - `reviseStale` routing:
    - stale `tech_design` → `revise_design` (tech_lead);
    - stale `ticket_scope`, or a stale non-harness ticket → `revise_scope` on `SCOPE-M{n}` (eng_lead);
    - stale `test_plan`, or a stale harness ticket → `revise_test_plan`, as now.
    - **The SCOPE revision waits (no task is created this tick) while `TECH-M{n}` is stale or has an open `revise_design` task.**
  - `answerCp4` request_changes: the replan is `M{n}-REPLAN-k`, role eng_lead, purpose `revise_scope`, on `SCOPE-M{n}`, with the open T tickets.

- [ ] **Step 1: Write the failing tests.**
  - `apply-authoring.test.ts › tech_design`:
    - `publishes TECH-M1 with fields.data and the fixed headings, and no tickets`: one row, `['TECH-M1','approved','owner:tech_lead']`, with `fields.data.components[0].name` equal to `'core'`.
    - `rejects a structure with a component missing tests and no reason`.
    - `revise_design › publishes a new TECH version from design, and refuses tickets in the output` (schema-level: `additionalProperties`).
  - `conductor.test.ts`:
    - `design › creates M1-SCOPE only after M1-TECH and M1-TESTPLAN are done, with their pins among its inputs`.
    - `design › moves to build when M1-SCOPE is done and creates the ticket tasks`.
    - `change requests › a stale ticket is re-planned by the eng lead on SCOPE-M1`.
    - `change requests › the scope revision waits while TECH-M1 has an open revise_design`.
    - `cp4 › request changes re-plans on SCOPE-M1 with role eng_lead`. Adjust the existing replan test.
  - `role.test.ts`:
    - tech_lead's `revise_design` schemaSource is `'schemas/revise_design.json'`;
    - the schema count is 14;
    - tech_lead's purposes are unchanged.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/apply-authoring.test.ts test/conductor.test.ts test/role.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement, then update every fixture.**
  - Fixture structures use components whose `sources` match the files the scripted tickets write, and whose `tests` match the files those tickets' scripts add.
  - Where a scripted ticket writes a source file and no test, give that fixture component a `no_tests_reason`. Note which ones in your report. Task 5's hook must not break the flows.
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: PASS, including `m2-flow.test.ts`.
- [ ] **Step 5: Commit** with the message `feat: structured tech design; eng lead scopes tickets in the design phase`.

---

### Task 5: The ticket hook — `tests_missing`

**Files:**
- Modify:
  - `src/git/workspace.ts`
  - `src/checks/run-checks.ts`
  - `src/engine/runner.ts`
  - `web/src/…`, only if failure kinds have a display map (grep `check_failed` under `web/src`)
- Test:
  - `test/checks.test.ts`
  - `test/workspace.test.ts` (or the file that tests `changedPaths`)
  - `test/conductor.test.ts`, or a runner test file that already drives `checkAttempt` (grep `scope_violation` in `test/`)

**Interfaces:**
- Consumes (Task 2): `componentCoverage`, `untestedEvidence`, `PathChange`, `CoverageComponent`.
- Produces:
  - `changedPathStatuses(repoPath, wtPath, baseSha): Promise<PathChange[]>`. It works like `changedPaths`, using `linkedLocation`, with `--name-status` instead of `--name-only` and `-z` pairs of status and path.
  - `diffStatuses(repoPath, from: string, to: string): Promise<PathChange[]>`. It runs in `repoPath` with `--no-ext-diff --no-renames --name-status -z from to`.
  - `ChecksInput.components?: CoverageComponent[]`.
  - `ChecksResult` kind gains `'tests_missing'`. It runs after the protected and scope checks and before the definition-of-done commands. `runs` is `[]` when it fails.
  - `AttemptFailureKind` gains `'tests_missing'`. It retries and escalates exactly as `check_failed` does.
  - The runner's `componentsFor(project, task): Promise<CoverageComponent[] | undefined>` returns `undefined` for:
    - a harness ticket (`isHarnessTicket`);
    - milestone 0;
    - a non-ticket task;
    - a TECH with no structure.
    - Otherwise it returns the `structureOf` components of the latest `TECH-M{n}` whose status is approved or stale.

- [ ] **Step 1: Write the failing tests.**
  - `checks.test.ts`:
    - `fails with tests_missing when a component's sources change and its tests do not`: the evidence matches `/loop/`, `/src\/loop\.js/` and `/test\/\*\*/`, and the DoD command did not run. Use a DoD that writes a marker file and assert it is absent.
    - `passes when the change adds a test`.
    - `scope_violation still wins over tests_missing`.
    - `no components means no hook`.
  - Workspace test: `changedPathStatuses reports A, M and D, and a rename as D plus A`.
  - Runner or conductor test:
    - `a product ticket that changes a source without a test fails tests_missing and retries`.
    - `a harness ticket is exempt`.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/checks.test.ts` plus the workspace and runner test files.
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: tests_missing hook for ticket attempts`.

---

### Task 6: The milestone eng review and its polish loop

**Files:**
- Create:
  - `seed/knowledge/schemas/eng_review.json`
  - `src/engine/apply/eng-review.ts`
- Modify:
  - `seed/knowledge/roles/eng_lead/role.yaml` (output_schemas gains `eng_review`)
  - `src/engine/workorder.ts` (Purpose `eng_review`)
  - `src/engine/apply/ids.ts`
  - `src/engine/apply/index.ts`
  - `src/engine/fsm.ts` (remove `verify → milestone_review`)
  - `src/engine/conductor/tasks.ts` (`engReviewTask`; `milestoneReviewTask` inputs)
  - `src/engine/conductor/milestone.ts` (`verify`, the new `engReview` step, `build` cancelling, CP4 evidence)
  - `src/engine/conductor/answers.ts` (CP4 request_changes: `eng_cap + 1`)
  - the role-inputs or `reviewInputs` budget code, if the milestone review's inputs are budgeted there
- Test:
  - `test/apply-authoring.test.ts`
  - `test/conductor.test.ts` (`toCp4` finishes `M1-ENGREV-1` with an approve)
  - `test/fixtures/m2-script.ts` (adds `M1-ENGREV-{round}`)
  - `test/fsm.test.ts`
  - `test/role.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `componentCoverage`, `coverageTable`, `structureOf`.
  - Task 5: `diffStatuses`.
  - Task 3: `validateTickets` with `{ prefix: 'E', docId: engReviewId(n, k), owner: 'eng_lead', components }`.
- Produces:
  - `export const engReviewId = (n: number, k: number) => \`ENG-REVIEW-M${n}-${k}\``
  - `milestoneCoverage(deps, project, n): Promise<{ from: string; to: string; rows: ComponentCoverage[] }>` in `eng-review.ts`.
    - `from` is `mergeBase(repo, base_branch, aiteam/m{n})` and `to` is the `aiteam/m{n}` head.
    - With no TECH structure, `rows` is `[]`.
  - `engReviewTask(project, n, k, inputs, instructions: string): TaskSpec`.
    - Ticket id `M{n}-ENGREV-{k}`, role eng_lead, kind authoring, purpose `eng_review`, base `INTEGRATION`.
    - `k` is the milestone's current `verify_round`.
    - The conductor builds the instructions: the range `from..to`, `coverageTable(rows)`, the TECH budgets as a list, the E ticket ids that already exist, and either `Polish tickets from this review will be built.` or `This is the last polish round: polish tickets will not be built and open findings go to the stakeholder as known issues.`
  - The output in `eng_review.json`:
    ```
    { verdict: 'approve'|'polish', summary,
      performance: [{ metric, target, measured, status: 'met'|'missed'|'unmeasured', evidence }],
      findings: [{ severity: 'critical'|'major'|'minor', file, line: integer|null, issue }],
      polish_tickets: [<revise_scope ticket draft shape, key E-n>],
      stakeholder_note, change_requests? }
    ```
  - `applyEngReview` validation, with one evidence line per problem:
    - every TECH `performance[].metric` is reported exactly once (`missing budget "frame time"`, `"frame time" reported twice`);
    - `approve` with polish tickets, with a critical finding, or while `milestoneCoverage` has an untested row → refused (`approve needs …`);
    - `polish` with no tickets → refused.
  - Publishing: `ENG-REVIEW-M{n}-{k}` (type `eng_review`, approved, owner eng_lead, `fields.data: { verdict, performance, findings }`) and the E tickets.
  - Conductor:
    - `verify()`: all automated criteria passing or waived → `engReviewTask`, phase `eng_review` (it used to be `milestone_review`).
    - `engReview()`:
      - ENGREV cancelled → build.
      - Not done → wait.
      - `polish` with `eng_round < eng_cap` → `patchMilestone({ eng_round: eng_round + 1, verify_cap: verify_cap + 1 })`, phase build. Build creates the E ticket tasks through `newTicketSpecs`.
      - Otherwise → `milestoneReviewTask` with `engReviewId(n, k)` among its inputs, phase milestone_review.
    - `build()` cancels an open ENGREV, as it cancels QA and the milestone review.
    - CP4 evidence gains the `ENG-REVIEW-M{n}-{k}` pin.
    - `answerCp4` request_changes also sets `eng_cap + 1`.
- [ ] **Step 1: Write the failing tests.**
  - `apply-authoring.test.ts › eng_review`. Set up a structured TECH with the budget `frame time`, an integration branch `aiteam/m1` with commits, and SCOPE tickets.
    - `publishes ENG-REVIEW-M1-1 with its data on approve`.
    - `refuses approve while a component is untested`: the branch changes `src/loop.js` only, and the evidence matches `/loop/`.
    - `refuses a missing or repeated budget`.
    - `refuses approve with a critical finding`, and `refuses polish without tickets`.
    - `publishes E tickets as M1-E-1 owned by eng_lead`.
  - `conductor.test.ts › eng review`:
    - `verify moves to eng_review and creates M1-ENGREV-1 whose instructions hold the coverage table`.
    - `approve goes on to M1-REVIEW-1 with ENG-REVIEW-M1-1 among its inputs`.
    - `polish under the cap builds the E tickets, raises verify_cap, and reviews again as M1-ENGREV-2`.
    - `polish at the cap goes to the milestone review`.
    - `build cancels an open eng review`.
    - `cp4 shows the eng review and a request for changes raises eng_cap`.
  - `fsm.test.ts › refuses verify → milestone_review`.
  - `role.test.ts`: the eng_lead purposes gain `'eng_review'`, and the schema count is 15.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/apply-authoring.test.ts test/conductor.test.ts test/fsm.test.ts test/role.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement, then update `toCp4`, `m2-script` and any flow that went verify → milestone_review.**
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: milestone eng review with a polish loop`.

---

### Task 7: The prototype plan applier

**Files:**
- Create:
  - `seed/knowledge/schemas/prototype_plan.json`
  - `src/engine/apply/prototype.ts`
- Modify:
  - `seed/knowledge/roles/pm/role.yaml` (output_schemas `prototype_plan`)
  - `seed/knowledge/roles/pm/charter.md` (a prototype-plan paragraph: hypotheses from general knowledge; never claim something is fun; the smallest playable thing per hypothesis)
  - `src/engine/workorder.ts`
  - `src/engine/apply/index.ts`
  - `src/engine/apply/ids.ts`
- Test:
  - `test/apply-prototype.test.ts`
  - `test/role.test.ts` (pm purposes gain `prototype_plan`; schema count 16)

**Interfaces:**
- Consumes:
  - `renderTicket` and `parseTicket` from `tickets.ts`;
  - `keyProblem` from `src/checks/play.ts`.
- Produces:
  - `export const protoPlanId = (r: number) => \`PROTO-PLAN-${r}\``
  - `export const protoTicketId = (r: number, k: number) => \`PROTO-${r}-P-${k}\``
  - `export const protoRoot = (r: number, k: number) => \`prototypes/r${r}/p${k}\``
  - `applyPrototypePlan` (purpose `prototype_plan`). The round `r` is read from the task's ticket id `PROTO-PLAN-{r}`.
    - Output: `{ hypotheses: [{ id, element, rationale, look_for }], prototypes: [{ key, title, hypotheses: string[], build, controls: string[] }], stakeholder_note, change_requests? }`.
    - Validation, one line per problem:
      - 1 to 3 prototypes, keyed `P-1`, `P-2`, … in order;
      - hypothesis ids unique and matching `/^H-\d+$/`;
      - every prototype names at least one hypothesis, and each one it names is defined in this plan;
      - no blank text;
      - every control passes `keyProblem`.
    - The body is `# Prototype round {r}`, then `## Hypotheses` (one `### H-n — element` with rationale and "look for"), then `## P-k` for each prototype (title, hypotheses, build, controls). Pins name `PROTO-PLAN-{r}@{v}#p-{k}`.
    - It publishes `PROTO-PLAN-{r}` (type `prototype_plan`, approved, owner pm, milestone 0, derivedFrom the inputs). Per prototype it publishes a ticket doc `PROTO-{r}-P-{k}`:
      - milestone 0, specialty `engineer`, size `S`, `ac_refs: []`, `components: []`, `depends_on: []`;
      - `touches: ["prototypes/r{r}/p{k}/**"]`;
      - `definition_of_done: ["test -f prototypes/r{r}/p{k}/index.html"]`;
      - `inputs: ["PROTO-PLAN-{r}@{v}#p-{k}"]`, owner pm, approvedBy `owner:pm`.
      - Its body is exactly:
        `Build prototype P-{k} as a self-contained static page at prototypes/r{r}/p{k}/index.html: plain JavaScript, no build step, no dependencies, no network. It must open by loading index.html. Controls: {controls}.\n\n{build}\n`
- [ ] **Step 1: Write the failing tests.**
  - `publishes PROTO-PLAN-1 and one ticket per prototype`: ids `['PROTO-PLAN-1','PROTO-1-P-1','PROTO-1-P-2']`, with the ticket `touches` and `definition_of_done` exactly as above.
  - `renders ## Hypotheses then ## P-1, ## P-2`.
  - `refuses 0 or 4 prototypes`, `keys out of order`, `an unknown hypothesis`, `a duplicate H id`, `a bad control key`.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/apply-prototype.test.ts test/role.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: prototype_plan applier`.

---

### Task 8: The prototype phase and the human fun evaluation

**Files:**
- Create:
  - `src/engine/conductor/prototype.ts`
  - `test/prototype.test.ts`
- Modify:
  - `src/engine/conductor/project.ts` (intake branches on `project.prototyping`; `advanceProject` dispatches `prototype`)
  - `src/engine/conductor/tasks.ts` (`protoPlanTask`, `funInputs`)
  - `src/engine/conductor/reviews.ts` (milestone-0 tickets merge without code review)
  - `src/engine/inbox.ts` (the `fun_eval` ref; `assertValidAnswer` takes `ref`)
  - `src/engine/store.ts` (`answerInbox`: the fun rule across rounds)
  - `src/engine/conductor/answers.ts` (`effectOf` for `fun_eval`)
  - the daemon start path that calls `serveTryAgain` (also call `serveFunAgain`)
- Test:
  - `test/prototype.test.ts`
  - `test/inbox.test.ts`
  - `test/store.test.ts`

**Interfaces:**
- Consumes:
  - Task 7: `protoPlanId`, `protoTicketId`, `protoRoot`.
  - From `try.ts`: `ensureTryWorktree`, `removeTryWorktree`, `tryWorktree`.
  - From `play-gate.ts`: `servePage`, `NO_BROWSER`.
  - From `reviews.ts`: `advanceTicket` and `mergeTicket`.
- Produces:
  - `protoPlanTask(project, r, inputs): TaskSpec`. Ticket id `PROTO-PLAN-{r}`, milestone 0, role pm, authoring, purpose `prototype_plan`, base `BASE`.
    - Instructions: `Plan prototype round {r}. Suggest candidate fun elements from general knowledge as hypotheses, and the smallest playable prototype for each. Only the stakeholder judges fun: read their notes in the Decision Records and build on what they found fun.`
  - `funInputs(deps, project): Promise<string[]>` returns the latest pins of every `PROTO-PLAN-*` and every `DEC-*` whose `fields.data.ref.kind === 'fun_eval'`, in round order.
  - `advancePrototype(deps, runner, project)`. Each tick, for the latest round `r`:
    1. no `PROTO-PLAN-{r}` task → create it, with inputs BRIEF plus `funInputs`;
    2. plan not done → wait;
    3. plan done and its `PROTO-{r}-P-*` docs have no tasks → create ticket tasks (milestone 0) from those docs;
    4. drive each open prototype ticket through the same review and merge path build uses;
    5. every prototype ticket closed and no `fun_eval:{r}` item → `raiseFunEval(deps, project, r)`.
  - `raiseFunEval`:
    - It checks out the `aiteam/m0` head with `ensureTryWorktree(deps, project, 0, head)`.
    - For each prototype `k` whose `prototypes/r{r}/p{k}/index.html` exists there, it adds one check:
      `{ ac: 'P-{k}', text: '{title} — tests {H ids}: {elements}', how: 'Play {link}. Mark it fun or not fun, and say what you felt.' }`
    - If `deps.player` is available, it smoke-plays each one with `servePage` and `player.smoke(page, controls, { animated: true })`. Each failing smoke adds `P-{k}: {problems}` to `why`.
    - It mounts with `deps.tryServer.mount(project.name, 0, join(checkout, 'prototypes'))`. The link is `{prefixUrl}r{r}/p{k}/index.html`, or the checkout file path when there is no try server.
    - It raises an approval:
      - ref `{ kind: 'fun_eval', round: r }`, dedupe `fun_eval:{r}`;
      - title `Prototype round {r}: is it fun?`;
      - evidence: the `PROTO-PLAN-{r}` pin and one `{ label: 'Play P-{k}', value: link }` per check.
      - With no pages, `why` says `No prototype in round {r} built a page.`
  - `serveFunAgain(deps, project)`: for a pending `fun_eval`, if the round is not mounted, check out and mount again.
  - The inbox:
    - `InboxRef` gains `{ kind: 'fun_eval'; round: number }`.
    - `assertValidAnswer(item: Pick<InboxRow,'id'|'type'|'options'|'checks'|'ref'>, answer)`. For `fun_eval` + approve, every check must be marked passing or failing (failing still needs a note). The other kinds are unchanged.
  - `store.answerInbox`, for `fun_eval` + approve: if neither this answer nor any earlier answered `fun_eval` item of the project has a passing mark, it throws `InvalidAnswer('Nothing has been marked fun yet. Mark a prototype fun, or request another round.')`.
  - `effectOf` for `fun_eval`:
    - request_changes → create `protoPlanTask(r + 1)` with BRIEF plus `funInputs` (which now include this DEC);
    - approve → unmount and remove the try worktree for 0, create `discoveryTask(1, [...discoveryInputs, ...funInputs])` and `profileTask(1)`, phase discovery;
    - reject → unmount, then the existing halt.
  - `intake()`: with BRIEF and `project.prototyping === 1` → `protoPlanTask(1, [BRIEF pin])`, phase prototype. Otherwise unchanged.
  - `reviews.ts`: a ticket with `milestone === 0` skips `codeReviewTask` and goes straight to `mergeTicket`. That merges into `aiteam/m0`, which never merges into the base.
- [ ] **Step 1: Write the failing tests** in `test/prototype.test.ts`. Use the conductor harness pattern from `test/conductor.test.ts` with a fake try server and a `fakePlayer`.
  - `intake starts PROTO-PLAN-1 for a prototyping project and discovery for any other`.
  - `builds the round's prototypes, merges them into aiteam/m0 without a code review, and raises FUN eval r1 with one check and Play link per page`.
  - `evaluates only the prototypes that have a page` *(Review Focus 5)*: one prototype ticket is cancelled.
  - `a failing smoke goes into why and does not block the evaluation`.
  - `request changes starts PROTO-PLAN-2 with the decision record among its inputs`.
  - `approve moves to discovery with every PROTO-PLAN and fun decision record among its inputs, and unmounts`.
  - `reject halts and unmounts`.
  - `mounts a pending evaluation again after a restart` *(Review Focus 3)*.
  - `inbox.test.ts`: `a fun_eval approve needs every check marked but not all passing`; `cp4 approve still needs all passing`.
  - `store.test.ts`: `refuses to approve a fun evaluation when nothing was marked fun` *(Review Focus 4)*; `accepts it when an earlier round marked one fun`.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/prototype.test.ts test/inbox.test.ts test/store.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: prototype rounds with a human fun evaluation`.

---

### Task 9: FUN-DEFINITION in discovery

**Files:**
- Modify:
  - `seed/knowledge/schemas/discovery.json`
  - `src/engine/apply/discovery.ts`
  - `src/engine/conductor/tasks.ts` (`DISCOVERY_DOCS` handling, spec inputs)
  - `src/engine/conductor/project.ts` (CP1 evidence)
  - `src/engine/conductor/answers.ts` (`answerCp1` approves FUN-DEFINITION)
  - `seed/knowledge/roles/pm/charter.md`
  - the place that builds `specTask` inputs
- Test:
  - `test/apply-authoring.test.ts`
  - `test/prototype.test.ts`, or `test/conductor.test.ts`

**Interfaces:**
- Consumes (Task 8): fun-eval DEC docs, whose `fields.data` is `{ ref: { kind: 'fun_eval', round }, answer: { action, checks: [{ ac, status, note }] } }`. Read the exact answer shape from `decisionRecord`.
- Produces:
  - In `discovery.json`, `fun_definition` is required and nullable: `{ body, elements: [{ id, element, evidence: string[], how_to_check }] } | null`.
  - `applyDiscovery`:
    - For `project.prototyping === 1`, `fun_definition` must be non-null and have at least one element.
    - Element ids match `/^F-\d+$/` and are unique.
    - Each evidence string matches `/^DEC-(\d+)@(\d+)#p-(\d+)$/`. It must name an existing fun-eval DEC whose answer marks `P-{k}` as `passing`. Otherwise the error is `F-2 cites DEC-31@1#p-2, which the stakeholder did not mark fun`.
    - For a non-prototyping project, `fun_definition` must be null.
    - It publishes `FUN-DEFINITION` (type `fun_definition`, status proposed, owner pm, derivedFrom the cited DEC pins). `DISCOVERY_IDS` gains it.
  - CP1 evidence includes `FUN-DEFINITION` when it exists. CP1 approve sets it approved along with the Roadmap.
  - Spec tasks get the `FUN-DEFINITION` pin in their inputs when it exists.
  - The PM charter: `When a milestone changes an element of FUN-DEFINITION, its Spec carries a human check that names the F-n element, so the stakeholder confirms at CP4 that the fun still holds.`
- [ ] **Step 1: Write the failing tests.**
  - `discovery › a prototyping project needs a fun definition`.
  - `discovery › refuses evidence the stakeholder marked not fun` and `refuses evidence that is not a fun-eval decision`.
  - `discovery › publishes FUN-DEFINITION citing a fun mark`.
  - `discovery › a project without prototyping must not send one`.
  - Flow test: `cp1 shows FUN-DEFINITION and approving it gives M1-SPEC the pin as an input`.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/apply-authoring.test.ts test/prototype.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.** Update every discovery fixture to send `fun_definition: null`.
- [ ] **Step 4: Run the full suite and the typecheck.**
  - Run: `npm test && npm run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat: FUN-DEFINITION written from the stakeholder's fun marks`.

---

### Task 10: The web inbox for fun evaluations

**Files:**
- Modify:
  - `web/src/lib/inbox.ts`
  - `web/src/pages/Inbox.tsx`
- Test:
  - `test/web-lib.test.ts`

**Interfaces:**
- Consumes (Task 8): the `fun_eval` ref.
- Produces:
  - `inboxLabel` returns `FUN-R{round}` for `fun_eval`.
  - `canApproveItem(ref: InboxRef, checks, marks): boolean`. For `fun_eval`, every check is marked (passing or failing). Otherwise it calls `canApprove`.
  - `markLabels(ref): { passing: string; failing: string }`. For `fun_eval` it returns `{ passing: 'Fun', failing: 'Not fun' }`, otherwise `{ passing: 'Passing', failing: 'Failing' }`.
  - `isTryLink` also accepts a `fun_eval` evidence label that starts with `Play `, under the same URL rule.
  - `Inbox.tsx` uses `canApproveItem` and `markLabels`.
- [ ] **Step 1: Write the failing tests** in `web-lib.test.ts`:
  - `labels a fun evaluation FUN-R2`;
  - `a fun evaluation can be approved with a not-fun mark once every check is marked`;
  - `fun marks read Fun and Not fun`;
  - `Play links of a fun evaluation open like Try it`.
- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run test/web-lib.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite, the typecheck and the web build.**
  - Run: `npm test && npm run typecheck && npm run web:build`
  - Expected: PASS, and the build succeeds. `web/dist` is not tracked.
- [ ] **Step 5: Commit** with the message `feat: fun evaluation in the web inbox`.
