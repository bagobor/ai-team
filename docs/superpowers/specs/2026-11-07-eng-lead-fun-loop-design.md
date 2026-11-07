# Eng Lead, test hooks, fun loop, milestone eng review, structured Tech Design

Date: 2026-11-07. Engine: `/Users/ps/dev/ai-team` at `f3f897a` (W1 merged, local main).

## Why

The STARLANCE beta postmortem found that the gates check conformance, not fun or code quality. Only a check the stakeholder owned made the game better. The stakeholder asked for five changes:

1. **An Eng Lead role** that sets the scope of each engineering task.
2. **Hooks** that make sure every component a change touches has added or updated tests.
3. **A fun loop at the start of a project.** The team builds small prototypes and a human plays them, round after round, until the essential fun elements are defined. A model may *suggest* what could be fun from general knowledge, but **only a human evaluates fun**.
4. **An Eng code review at milestone level**, with a loop that polishes the code.
5. **A Tech Design with a fixed structure**, including complexity and base performance requirements.

Then the game pipeline runs again as a new project, so its output can be compared with the alpha and beta.

## Overview of the new flow

```
project:   intake ─▶ prototype (rounds, opt-in) ─▶ discovery ─▶ cp1 ─▶ active
                      PROTO-PLAN-r (pm)                ▲
                      PROTO-r-P-k tickets (engineer)   │ FUN-DEFINITION written in
                      FUN eval inbox (human) ──────────┘ discovery, citing only the
                        └ request changes ▶ round r+1    human's "fun" marks

milestone: pending ▶ spec ▶ cp2 ▶ design ▶ build ▶ verify ▶ eng_review ▶ milestone_review ▶ cp4 ▶ merging
                                   │                          │  polish (≤ eng_cap)
           design = M{n}-TECH (tech_lead, structured) ┐       └──────▶ build
                    M{n}-TESTPLAN (qa)                ┴▶ M{n}-SCOPE (eng_lead: tickets)
```

## 1. Eng Lead role (`eng_lead`)

New seed role `seed/knowledge/roles/eng_lead/`:

- Department engineering, model `claude-opus-5-5`, budgets like `tech_lead`'s. Tools: `read_repo` and `run_commands`, no edits. Write scope: deny `**`.
- Output schemas:
  - `ticket_scope` → `schemas/ticket_scope.json`
  - `revise_scope` → `schemas/revise_scope.json`
  - `eng_review` → `schemas/eng_review.json`
  - `cr_recommendation` → `schemas/cr_recommendation.json`
- Charter (≤ 600 tokens):
  - Owns ticket scope: ticket boundaries, `touches`, `depends_on`, `definition_of_done`, `components`, `size`, and the tests each ticket must add.
  - A ticket is about one component's worth of change and names that component.
  - The definition of done runs that component's tests.
  - Owns the milestone eng review (§4).

**Split of design work.** The Tech Lead keeps the architecture. The Tech Design no longer carries tickets; it carries the structure in §5. The Eng Lead turns it into tickets:

- **Design phase.** `M{n}-TECH` (tech_lead) and `M{n}-TESTPLAN` (qa) run in parallel as now. When both are done, the engine creates `M{n}-SCOPE` (eng_lead, purpose `ticket_scope`). Its inputs are the Spec, the Environment Profile, the Tech Design and the Test Plan. When SCOPE is done, the smoke check runs, the ticket tasks are created, and the milestone moves to build.
- **`applyTicketScope`.**
  - It publishes `SCOPE-M{n}` (type `ticket_scope`, owner `eng_lead`, approved by its owner) and the `T-n` tickets (owner `eng_lead`).
  - Validation:
    - the existing `validateTickets` rules (prefix `T`);
    - every acceptance criterion covered, moved here from `applyTechDesign`;
    - every ticket has `components`, a non-empty list of names that exist in the Tech Design's components.
- **Revisions.**
  - A stale `tech_design` is revised by the Tech Lead with the new purpose `revise_design`. That revision is design only: no tickets and no ticket decisions.
  - A stale `ticket_scope`, or a stale non-harness ticket, is revised by the Eng Lead (`revise_scope`). This is today's `applyRevise('T')`, with the SCOPE doc in place of the TECH doc.
  - A SCOPE revision waits while the TECH doc is stale or has an open revise task, so it always reads the new design.
- **CP4 request changes.**
  - The replan goes to the Eng Lead: `M{n}-REPLAN-k`, purpose `revise_scope`, on the SCOPE doc, with the stakeholder's comment.
  - If the design itself must change, the Eng Lead raises a Change Request against `TECH-M{n}`.
- The QA Test Plan instructions name the Eng Lead, not the Tech Lead, as the one splitting the product into tickets.

## 2. Test hooks: every updated component has added or updated tests

The Tech Design's components (§5) each name `sources` and `tests` globs. One function serves the ticket hook, the milestone hook and the eng review:

`componentCoverage(changes, components)`

- **A source change of component C** is a changed path (any status) that matches C's `sources` and does not match C's `tests`.
- **A test change of C** is an added, modified or renamed path (not a deleted one) that matches C's `tests`.
- **C is untested** when it has a source change, no test change, and no `no_tests_reason`.

**Ticket hook (`tests_missing`).**

- `runChecks` gets an optional `components` input. After the no-changes and scope checks, and before the definition-of-done commands, any untested component fails the attempt with the new kind `tests_missing`.
- The evidence names each untested component, a few of its changed paths, and its test globs.
- The attempt fails and retries like `check_failed`, and escalates when the retries run out.
- `checkAttempt` passes the components of the milestone's approved or stale `TECH-M{n}` when the task is a product ticket. It passes none for:
  - harness tickets (`-Q-`), which are tests themselves;
  - prototype tickets (milestone 0);
  - a Tech Design with no components (older projects).

**Milestone hook.**

- When `M{n}-ENGREV-k` is created, the engine computes `componentCoverage` for the whole milestone diff, from `git merge-base <base> aiteam/m{n}` to the integration head. It writes the table into the work order's instructions.
- `applyEngReview` refuses an `approve` verdict while any component in that table is untested. The Eng Lead must file a polish ticket instead.

## 3. Fun loop: prototypes that a human evaluates

The fun loop is opt-in per project: there is a new column `projects.prototyping`, default 0.

- Turned on by `aiteam project add <name> <repo> --prototype`, or by `prototyping: true` on `POST /api/projects`.
- Project phase `prototype` sits between intake and discovery:
  - intake → prototype | discovery | halted
  - prototype → discovery | halted

**A round r:**

1. **`PROTO-PLAN-r`** (pm, purpose `prototype_plan`, milestone 0).
   - Inputs: the BRIEF, every earlier `PROTO-PLAN-*`, and every earlier fun-eval Decision Record.
   - Output `schemas/prototype_plan.json`: `{hypotheses: [{id: "H-1", element, rationale, look_for}], prototypes: [{key: "P-1", title, hypotheses: ["H-1"], build, controls: [keys]}], stakeholder_note}`.
     - Each hypothesis is a candidate fun element, argued from general knowledge.
     - Each prototype is the smallest playable thing that tests one or two hypotheses.
   - Validation:
     - 1 to 3 prototypes, keyed `P-1`… in order;
     - hypothesis ids unique and matching `H-\d+`;
     - every prototype tests at least one hypothesis from this plan;
     - text fields not blank;
     - controls valid play keys.
   - The engine renders the body with fixed headings (`## Hypotheses`, then `## P-k` for each prototype) and publishes `PROTO-PLAN-r` (type `prototype_plan`, approved by its owner).
   - It also publishes one ticket doc per prototype, `PROTO-r-P-k` (milestone 0, specialty `engineer`, size S, `ac_refs: []`):
     - `touches: ["prototypes/r<r>/p<k>/**"]`;
     - `definition_of_done: ["test -f prototypes/r<r>/p<k>/index.html"]`;
     - `inputs: ["PROTO-PLAN-r@v#p-<k>"]`;
     - a body saying: a self-contained static page, plain JS, no build, no dependencies, no network, opened as `index.html`.
2. **Building.** The engine creates ticket tasks for them. They run like other tickets but skip per-ticket code review and the test hook (they are throwaway). They merge straight into `aiteam/m0`, which never merges into the base branch.
3. **Evaluation inbox.** When every prototype ticket of round r is closed:
   - The engine checks out the `aiteam/m0` head (the try checkout for milestone 0).
   - If the engine has a browser, it smoke-plays each prototype with the W1 player (`servePage` and `player.smoke`, animated), and writes a failing smoke into the item's `why`. A failed smoke does not block the evaluation.
   - It mounts `<checkout>/prototypes` on the try server as `(project, 0)`.
   - It raises an approval with `ref {kind: 'fun_eval', round: r}` and dedupe key `fun_eval:r`. There is one check per prototype that has a page: `{ac: "P-k", text: "<title> — tests H-…: <element>", how: "Play <link>. Mark it fun or not fun, and say what you felt."}`. The evidence has the PROTO-PLAN pin and one `Play P-k` link per prototype.
   - After a daemon restart, a pending evaluation mounts its prototypes again.
4. **The human's answer** (only a human answers it; the engine never marks fun):
   - **Request changes** (a comment is required) → `PROTO-PLAN-(r+1)` with the new Decision Record among its inputs, so the next round follows the human's notes.
   - **Approve** ("the fun is defined") needs **every** check marked, fun or not fun (not all fun). The project moves to discovery, and discovery's inputs include every PROTO-PLAN and fun-eval Decision Record.
   - **Reject** halts the project.
   - On approve or reject, the prototype mount is removed.

**FUN-DEFINITION.**

- The discovery schema gains `fun_definition: {body, elements: [{id: "F-1", element, evidence: ["DEC-<id>@1#p-k"], how_to_check}]} | null`.
- For a prototyping project, `applyDiscovery` requires it and at least one element.
- Each element's evidence must name a fun-eval Decision Record mark that the human set to **passing** (fun). The PM can only write down what the human found fun.
- It publishes `FUN-DEFINITION` (type `fun_definition`, owner pm, proposed). CP1 shows it, and approving CP1 approves it with the Roadmap.
- Spec tasks take `FUN-DEFINITION` as an input. The PM charter says that a milestone changing an F-n element carries a human check for it, so CP4 is where the human confirms the fun still holds.

**Web UI.** For `fun_eval` items:

- the marks read "Fun" / "Not fun";
- Approve is enabled once every check is marked;
- the `Play P-k` evidence links open, the way CP4's `Try it` does;
- the label is `FUN-R<r>`.

The server's `assertValidAnswer` gets the same rule: for `fun_eval`, approve needs every check marked, but not all passing.

## 4. Milestone eng review with a polish loop

New milestone phase `eng_review`:

- verify → eng_review (when every automated criterion passes) | build | halted
- eng_review → build | milestone_review | halted

New milestone columns: `eng_round` (default 0) and `eng_cap` (default 2).

- **`M{n}-ENGREV-k`** (eng_lead, authoring, purpose `eng_review`, base integration).
  - Inputs: Spec, TECH, SCOPE, Test Plan and the latest QA report.
  - Instructions: the diff range, the component coverage table (§2), the performance budgets, and whether polish tickets from this round will be built (`eng_round < eng_cap`).
- **Output** `schemas/eng_review.json`: `{verdict: "approve" | "polish", summary, performance: [{metric, target, measured, status: "met" | "missed" | "unmeasured", evidence}], findings: [{severity: "critical" | "major" | "minor", file, line, issue}], polish_tickets: [ticket draft with key "E-n" and components], stakeholder_note, change_requests?}`.
- **Validation:**
  - every performance budget in TECH is reported exactly once, by metric;
  - `approve` needs no polish tickets, no critical finding, and no untested component;
  - `polish` needs at least one polish ticket;
  - polish tickets pass `validateTickets` with prefix `E`, where `ac_refs` may be empty, and name existing components.
- **Publishing.** `ENG-REVIEW-M{n}-k` (type `eng_review`, owner eng_lead, `fields.data: {verdict, performance, findings}`), and the E tickets as approved ticket docs. They are product tickets: the test hook and per-ticket code review apply.
- **Conductor:**
  - ENGREV cancelled → build.
  - Done with `polish` and `eng_round < eng_cap` → `eng_round + 1`, `verify_cap + 1` (a polish loop gets its own QA round), phase build. Build creates the E ticket tasks, then the play gate and QA run, then the next eng review.
  - Otherwise → `M{n}-REVIEW-k` (pm), with the eng review among its inputs, and phase milestone_review. When the cap ends the loop with findings open, they reach the stakeholder as known issues.
  - `build` cancels an open eng review, as it does QA and the milestone review.
  - CP4 shows the latest eng review as evidence.
  - A CP4 request for changes adds 1 to `eng_cap`.

## 5. Structured Tech Design

`schemas/tech_design.json` (tech_lead output, no tickets):

```
{ body,                                   // overview and tradeoffs
  components: [{ name, responsibility, sources: [glob], tests: [glob], no_tests_reason?,
                 complexity: "S"|"M"|"L", complexity_notes }],   // e.g. "O(enemies × bullets) per frame"
  complexity: { overall: "S"|"M"|"L", rationale },
  performance: [{ metric, target, how_measured, component? }],   // e.g. frame time ≤ 16.7 ms at 200 entities
  test_strategy, risks: [{ risk, mitigation }], stakeholder_note?, change_requests? }
```

**Validation (shared with `revise_design`):**

- at least one component;
- names unique and not blank;
- `sources` has at least one glob, and every glob passes `touchesProblem`;
- `tests` has at least one glob unless `no_tests_reason` is given;
- complexity values are S, M or L, with notes;
- at least one performance entry, with metric, target and how_measured not blank;
- `test_strategy` is not blank.

**Rendering.** The engine renders the doc body under fixed headings, so the structure is guaranteed and pins can name sections:

- `## Overview`
- `## Components`, with `### <name>` for each component
- `## Complexity`
- `## Performance`, as a table
- `## Test strategy`
- `## Risks`

`fields.data` keeps the structure, for the hooks and the Eng Lead.

`revise_design` (`schemas/revise_design.json`): `{unaffected, rationale, design: <the structure above, without change_requests> | null, change_requests?}`.

## Out of scope

- An engine play-check fix loop for prototypes: a failed smoke is only evidence.
- Checking that a ticket's `touches` sit inside its components' globs: the hook checks real changes instead.
- Pushing anything. The work merges into local `main` only.

## Re-run plan

- **Repo.** A fresh local repo, `/Users/ps/dev/shooter-gamma`: `git init`, with an empty first commit on `main`.
- **Project.** `shooter-gamma`, registered with `--prototype`. Its BRIEF is the original alpha brief (`space-shooter/docs/alpha/brief/BRIEF.md` body) word for word, so the comparison is fair.
- **Engine setup** before the run: rebuild `web/dist`, copy the seed to `~/.aiteam/knowledge`, and restart the daemon. The user is told each step.
- **Who answers what.**
  - Every fun evaluation goes to the user. The prototypes are served on a LAN URL, and the user's marks and notes are submitted word for word.
  - I answer the non-fun checkpoints as stakeholder: CP1, CP2, CRs and holds.
  - CP4 human checks that concern fun go to the user.
- **Comparison** with alpha and beta: cost and attempts, tests, balance-style checks, eng review findings, and the user's verdict on fun.
