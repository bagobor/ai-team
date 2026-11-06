# Flow fixes: prioritized roadmap

**Covers:** every finding in `docs/superpowers/notes/2026-11-05-flow-review.md`. Each one appears in exactly one workstream below.

**Spec:** `docs/superpowers/specs/2026-10-19-ai-team-orchestrator-design.md`. The goals most at stake are G8 (honest verification), G3 (work finishes or escalates), G6 (low load on the human) and G1 (the goal can't drift).

**How this roadmap is used.** W1 has a full implementation plan: `docs/superpowers/plans/2026-11-05-w1-product-gate.md`. Each later workstream gets its own full plan, written just before it starts, so that it argues from the code as W1 and earlier workstreams leave it. A workstream is finished when its done criteria hold and one real run has passed its acceptance.

## Order and why

| # | Workstream | Findings | Size | Depends on |
|---|-----------|----------|------|------------|
| W1 | Product gate | PG-1…PG-7, SC-3, LC-1 | L (12 tasks) | — |
| W2 | Lifecycle correctness | LC-2…LC-9, PG-8 | M (7 tasks) | W1 (it shares `conductor/milestone.ts` and `answers.ts`) |
| W3 | Information flow | IF-1…IF-7, PG-9 | M (8 tasks) | W1 (reviewers get the protected paths and human checks) |
| W4 | Budgets and context headroom | BC-1…BC-6 | M (6 tasks) | W3 (the new inputs have to fit the budget) |
| W5 | Stakeholder control | SC-1, SC-2, SC-4…SC-10 | M (8 tasks) | W1 (CP4 checks), W4 (spend views) |
| W6 | Isolation and the risky-change gate | SI-1, SI-2 | M (5 tasks) | W1 (the play gate's network rules) |
| W7 | Knowledge and learning (spec M4) | KL-1…KL-4 | L | W4 (the manifest headroom), W5 |

- **W1 comes first, because without it the other fixes don't show.** No defect the stakeholder found in STARLANCE was caught by the system. Until the product is run, a better-fed engineer or a cheaper loop still ships an unplayable game marked passing.
- **W2 comes second, because its first finding is Critical and small.** LC-2 merges commits nobody verified, and that undoes W1's gate. The other Critical one, LC-1, moved into W1: it wedges a project so that only Halt gets out, and W1's play gate raises the QA cap from `build`, the phase that triggers it.
- **W3 comes before W4 on purpose.** W3 adds inputs, and W4 then sets budgets and headroom against what the roles really receive. The other order would size the budgets twice.
- **W4 is the budget half of spec M3.** Hard stops come before cross-model review, as the review recommended, and the M4 headroom gets fixed before W7 needs it.
- **W7 is spec M4.** It is sequenced here but not designed: it needs its own spec revision first.

---

## W1. Product gate

**Findings:** PG-1, PG-2, PG-3, PG-4, PG-5, PG-6, PG-7, SC-3, LC-1.

**Approach.** Full plan in `2026-11-05-w1-product-gate.md`. In outline:

1. **Human-check criteria.** A criterion can be `method: human`. QA leaves those alone. CP4 lists them, the stakeholder marks each one passing or failing, and the decision record is their evidence.
2. **CP4 you can try.** CP4 names the `aiteam/m<n>` branch and its head, and gives a checkout of it to try. For a browser project it gives a local link that serves that checkout.
3. **Protected tests.** The Test Plan names `protected` paths, its acceptance tests and fixtures. Only QA's harness tickets may write them. Product and Bug tickets that touch them fail their checks. Protection carries on into later milestones.
4. **Red on base.** The engine also runs each criterion's Test Plan commands on the milestone's base, with the protected files laid over it. A criterion whose commands pass there too isn't shown by the work. QA has to change the commands, or mark the entry `regression`.
5. **Play gate.** For a project whose Environment Profile has a `play` block, the engine loads the built product in headless system Chrome before every QA round. It checks for uncaught errors, console errors, a painted canvas and frames that advance. A product that doesn't run passes nothing.
6. **Play scripts.** A Test Plan entry can carry a short script of key presses, waits and a JS expectation. The engine runs it in the real page, so a browser criterion is shown in a browser and not by grep.

**Decisions only the user can make** (each has a recommended default in the W1 plan):
- **D1.** Drive system Chrome over CDP with Node's built-in WebSocket and no new dependency, or add Playwright. The default is CDP.
- **D2.** QA's harness tickets write the acceptance tests and product tickets can't touch them, or protection starts only once a milestone merges. The default is harness tickets.
- **D3.** A failed human check can only be sent back with request changes, never approved. The default is yes.
- **D4.** A failed play gate uses up one QA round, so the existing QA cap stops a loop. The default is yes.
- **D5.** The try link uses port `port + 1` (4781). The default is yes.

**Done when:**
- A Spec can hold human checks and a milestone can't merge with one unanswered.
- An engineer's change to a protected path fails `scope_violation`.
- A criterion whose commands pass on base can't pass: QA is sent back, or, with a Change Request on those commands, the criterion fails.
- A product that throws on load can't reach CP4.
- A criterion with a play script is evidenced by a real page run.
- The full suite and `tsc` are clean.

**Real-run acceptance (run 11).** A fresh small browser game, brief in the W1 plan's last task, through M1. Required:
- At least one human check, marked at CP4 through the UI.
- The CP4 try link loads the game.
- The play gate ran before every QA round.
- The QA report shows a red-on-base result for every criterion.
- A hand-filed ticket that breaks the render is caught by the play gate before QA.
- No engineer attempt touched a protected path without a `scope_violation`.

---

## W2. Lifecycle correctness

**Findings:** LC-2, LC-3, LC-4, LC-5, LC-6, LC-7, LC-8, LC-9, PG-8. LC-1 is fixed in W1, Task 9.

**Approach:**
- **LC-2.** What merges is what was verified.
  - The QA report records the integration head it verified.
  - If `afterMilestoneReview` or `merging` finds that a base sync or a hand ticket moved the head, it goes back to `build`, so a QA round runs on the new head. It doesn't raise CP4 or advance main.
  - `POST /tickets` is refused outside `design` and `build`.
- **LC-3.** Each QA round also re-runs the Test Plan commands of every merged milestone, as regression evidence. A failure files a Bug against the current milestone that names the old criterion. The old criterion stays `passing` in its own milestone.
- **LC-4.** A Change Request against a merged milestone is refused at filing, and the refusal says why. A follow-up belongs in a new milestone (see LC-6).
- **LC-5.** The design and test-plan appliers collect raised Change Requests before they validate coverage. An uncoverable criterion with a CR raised against it isn't a problem, and the author's explanation reaches the stakeholder.
- **LC-6.** An approved Roadmap CR that adds or reorders milestones that haven't started updates the milestone rows. Dropping one that has started is refused.
- **LC-7.** Crash re-runs count against `maxAttempts`.
- **LC-8.** `advanceBaseBranch` tells "the branch moved" from "update-ref failed". The second raises `base_refused`.
- **LC-9.** A revise's dependency on a ticket superseded earlier is rewritten to the ticket that superseded it, or dropped with a logged reason.
- **PG-8.** The definition of done runs in a clean checkout of the attempt's commit, as QA already does.

**Decisions:**
- LC-2: re-verify automatically after a base sync (costs a QA round), or hold and ask. The default is to re-verify, because it costs about $0.30 and asks nothing of the stakeholder.
- LC-3: how a regression failure is filed. The default is a Bug in the current milestone.
- LC-4: refuse at filing, or open a follow-up milestone. The default is to refuse.

**Done when** each finding has a test that reproduces it and now passes.

**Real-run acceptance (run 12).**
- Commit to main by hand during a milestone's `verify`: the milestone re-verifies before CP4.

---

## W3. Information flow

**Findings:** IF-1, IF-2, IF-3, IF-4, IF-5, IF-6, IF-7, PG-9.

**Approach:**
- **IF-1, PG-9.**
  - A code review that approves with findings publishes them as `noted` items on the ticket.
  - QA and the Milestone Review get a compact list of every noted finding of the milestone.
  - An approve with a finding marked `critical` is treated as changes requested.
- **IF-2.**
  - The Spec task of milestone n+1 gets the Milestone Review of n, its known issues, and the section lists of earlier Specs and Tech Designs, with the full text as reference files.
  - The Tech Design task gets the same, and the previous Tech Design in full as a reference file.
- **IF-3.**
  - The code reviewer gets the ticket's criteria (text and Test Plan commands) and the Tech Design sections the ticket pins.
  - A Bug ticket's reviewer also gets the Bug.
- **IF-4.** A revise that keeps a ticket repins its `inputs` as well as `derived_from`, so the engineer reads the current criterion text.
- **IF-5.**
  - The ticket's manifest lists the Test Plan commands and notes for its `ac_refs`.
  - A Bug ticket's inputs include the Spec pin of its criterion.
- **IF-6.**
  - A revision gets the old and new text of the changed section, from the existing `stale_sections`, and each kept ticket's title and criteria.
  - A CP4 replan pins the Milestone Review and the last QA report.
- **IF-7.** The Milestone Review's deviations are checked against the engine's verdicts. One that contradicts them sends the review back.

**Decisions:** whether approve-with-critical becomes changes requested. The default is yes. A real reviewer at Anthropic quality calls a critical finding a blocker, and the current behavior merges it.

**Done when** each input is in the manifest of the role that needs it, under the budget the W1 tests pin, and the room for M4 stays at least 3,000 tokens (W4 enforces that).

**Real-run acceptance (run 13), on a two-milestone project:**
- M2's first Spec passes CP2 without a bounce.
- No role reads `.aiteam/` by glob (checked in the transcripts).

---

## W4. Budgets and context headroom

**Findings:** BC-1, BC-2, BC-3, BC-4, BC-5, BC-6.

**Approach:**
- **BC-1, BC-2.**
  - New config keys for USD caps: `budgets.task_usd`, `budgets.milestone_usd`, `budgets.project_usd`.
  - Spend is summed from `attempts.usage`.
  - At 80% the engine raises an Inbox notice, which blocks nothing.
  - At 100% it stops starting attempts under that scope and raises a question: raise the cap, or halt.
  - The escalation Retry counts against the task cap.
- **BC-3.**
  - `taskBudget` reserves `playbook_tokens + memory_tokens` from the role's budget.
  - The test invariant becomes "total + reservation ≤ budget".
  - The manifest builder cuts reference text, never required inputs, to fit.
- **BC-4.** Over budget, the escalation offers "Cut reference files and retry". That option rebuilds the manifest with a smaller reference allowance, so Retry isn't a dead end.
- **BC-5.** Reference-file sizes go into the manifest record.
- **BC-6.** Cache-read tokens per attempt are added to the cost views, and the growth from M1 to M3 is explained or fixed. This is the investigation task.

**Decisions:**
- Default caps. The suggested defaults are $5 per task, $25 per milestone and $100 per project, from STARLANCE's $10.81 over three milestones.
- At a cap, pause, or wait for an answer. The default is to wait for an answer.

**Done when** a test project hits each cap and stops cleanly with an Inbox question, and every role manifest in the large-milestone tests leaves its reservation free.

**Real-run acceptance (run 14).** Set `budgets.milestone_usd` to $1 on a small project. It stops at the cap with a question, and resumes after the cap is raised.

---

## W5. Stakeholder control

**Findings:** SC-1, SC-2, SC-4, SC-5, SC-6, SC-7, SC-8, SC-9, SC-10.

**Approach:**
- **SC-1.**
  - Reject at CP2 or CP4 rejects the milestone: the stakeholder picks "replan this milestone" or "drop it", and the project carries on.
  - A project gets Pause and Resume, separate from Halt.
  - Reject at CP1 still ends the project.
- **SC-2.**
  - An escalation's Retry takes optional guidance, which the next attempt's manifest carries as "The stakeholder says".
  - The UI shows the text box beside the options.
- **SC-4.**
  - Approving an Environment Profile CR re-applies the profile, so the new smoke command and setup run.
  - Roadmap CRs go through LC-6 (W2).
  - Change Requests can be filed from the Documents page and from `aiteam cr`.
- **SC-5.** The QA-cap hold gains "Waive a criterion". The stakeholder picks criteria and gives a reason, which is recorded as a decision and is the waived criterion's evidence.
- **SC-6.** The board and the project page show spend per milestone and per role, Discovery included.
- **SC-7.**
  - A policy Settings page shows the checkpoint table, read-only at first.
  - CP3 stays off until there's a UX Designer (spec M6).
  - The risky-change gate is W6.
- **SC-8.** A daily digest event, and an item older than a day is marked in the Inbox. Notifications go through the service worker when the browser allows it.
- **SC-9.** A CP4 approval's comment goes into the Milestone Review's next round as a known issue, and into project memory once W7 exists.
- **SC-10.**
  - Before the last milestone's CP4, the PM writes a closing check. It lists every Brief requirement and says how it was verified (criterion, human check, or not at all).
  - CP4 shows that check. "Not at all" items need an explicit approve.

**Decisions:**
- Reject semantics. The default: milestone-level at CP2 and CP4, project-level at CP1.
- Whether a waiver needs a typed reason. The default is yes.

**Done when** each control has a server test and a UI path. The UI paths are verified in the browser pane with screenshots.

**Real-run acceptance (run 15).** Reject one milestone at CP4, waive one criterion, retry an escalation with guidance, and finish the project with a closing check that lists the Brief's 60 fps and Safari/Firefox requirements.

---

## W6. Isolation and the risky-change gate

**Findings:** SI-1, SI-2.

**Approach:**
- **SI-1.**
  - Setup no longer drops the network deny. The sandbox keeps `(deny network*)`, allows only `127.0.0.1` and a local port, and the engine runs an HTTP CONNECT proxy on that port. The proxy admits only the profile's `network_allow` domains.
  - Setup gets `HTTPS_PROXY` and `HTTP_PROXY` set to it.
  - npm's lifecycle scripts run with `--ignore-scripts` unless the profile says `scripts: true`, which the stakeholder approves at CP1.
- **SI-2.**
  - At the end of build, a risky-change check diffs the integration branch against base for dependency manifests and lockfiles, CI config, migrations, and anything outside the Tech Design's declared touches.
  - Each hit is listed on CP4 as an item that needs its own tick.
  - The spec's Judge (M5) can later take this gate over.

**Decisions:**
- A proxy in the engine, or no network for setup at all, with the stakeholder running installs. The default is the proxy.
- Whether npm scripts are off by default. The default is yes.

**Done when** a setup that fetches from a domain not on `network_allow` fails, and a ticket that adds a dependency shows on CP4 as a risky change.

**Real-run acceptance:** folded into run 15, with `network_allow` set to `registry.npmjs.org`.

---

## W7. Knowledge and learning (spec M4)

**Findings:** KL-1, KL-2, KL-3, KL-4.

**Approach:**
- This is the spec's M4, Knowledge v1: Reflector deltas, project memory with auto-apply, role-tier proposals, and counters.
- The spec's M5 (Judge, stall detection) takes KL-3.
- The flow review adds two requirements to M4's spec revision:
  - Every stakeholder rejection, request-changes and CP4 comment becomes a Reflector input.
  - The acceptance run checks that one lesson from an earlier milestone appears in a later attempt's manifest. That is the spec's own v1 acceptance line.
- KL-4: from now on, each acceptance run records which paths it exercised. The next run chooses what to exercise from the ones not yet covered.

**Decisions:** these belong to the M4 spec revision, not to this roadmap.

**Done when** the spec's M4 row holds and its acceptance passes.
