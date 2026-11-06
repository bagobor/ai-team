# Critical review of the project flow, 2026-11-05

Six read-only reviewers went over the orchestrator at `605c89d` and the one real project it has built, STARLANCE (`/Users/ps/dev/space-shooter`, M1 to M3, $10.81, 51.4 min). Each one covered one side of the flow: verification, information flow, lifecycle, stakeholder control, budgets and context, and security. I checked their strongest claims against the code and the live database before writing them down here.

**Status.** C means confirmed in the code or the data. P means plausible: the code points that way, but no test or run has shown it.

**Severity.** Critical means the system can ship something broken while reporting success, or wedge a project with no way out. High means it wastes real money or hides a defect. Medium hurts but has a workaround. Low is polish.

The fix plan is `docs/superpowers/plans/2026-11-05-flow-fixes-roadmap.md`. Every id below has a place in it.

---

## PG: the product gate

Nothing in the flow runs the product the way a user meets it. Every player-visible defect in STARLANCE was found by the stakeholder.

| ID | Sev | Finding | Evidence | Status |
|----|-----|---------|----------|--------|
| PG-1 | Critical | A criterion can only be verified by an automated method. The Spec schema allows `method: automated` and nothing else, and the applier rejects anything else. A criterion only a person can judge, such as feel, look or 60 fps, has to be faked as a command. | `seed/knowledge/schemas/milestone_spec.json` (`method.enum`); `src/artifacts/acs.ts` ("automated only until M6"); `src/engine/apply/milestone.ts` `specProblems` | C |
| PG-2 | Critical | The engine accepts any non-blank command as verification. Browser criteria passed on grep: M2 AC-11 (best score in localStorage) and M3 AC-15 (AudioContext). | `src/engine/apply/design.ts:33-43` `coverageProblems` checks only for blanks; STARLANCE `TEST-PLAN-M2`, `TEST-PLAN-M3` | C |
| PG-3 | Critical | No gate loads the shipped product. `main.js` and `render.js` (307 lines) are referenced by no test. A copy with rendering broken still passed all 183 tests. | `grep -l "main.js\|render.js" /Users/ps/dev/space-shooter/test` is empty; the audit's broken copy, in the session scratchpad, passed 183/183 | C |
| PG-4 | Critical | The engineer writes, and can rewrite, the tests that grade it. The engineer's write scope is `**`, harness tickets are never used, and the M3 boss tests landed in the same commit as the boss code. | `seed/knowledge/roles/engineer/role.yaml` (`allow: ["**"]`); `src/engine/runner.ts:511` (`writeScope: role.write_scope`); STARLANCE history | C |
| PG-5 | High | Two shipped tests are hollow: `test/audio.test.js:56-61` asserts nothing, and `test/boss-fight.test.js:97` is a tautology. Both count as evidence. | STARLANCE test files | C |
| PG-6 | High | A criterion passes when QA says it passes and every command exits 0. Nothing shows a command fails without the milestone's work. QA rubber-stamped M1. | `src/engine/apply/qa.ts:113` (`held = claimed === 'passing' && … every exit 0`) | C |
| PG-7 | High | Every Test Plan, and every revision of one, is approved by its own author. Nobody but QA reads the commands before they become the definition of "passing". | `src/engine/apply/design.ts:56-66` (`approvedBy: 'owner:qa_engineer'`), `:213` | C |
| PG-8 | Low | The definition of done runs in the attempt's worktree, which can hold ignored and generated files that the merged tree won't have. | `src/engine/runner.ts:505-516` | P |
| PG-9 | Low | A code review that approves with critical findings still merges the ticket. Only `changes_requested` blocks. | `src/engine/conductor/reviews.ts:46` reads only the verdict | C |

## IF: information flow

The roles don't get what they need, so they guess, glob `.aiteam/`, or get bounced.

| ID | Sev | Finding | Evidence | Status |
|----|-----|---------|----------|--------|
| IF-1 | High | Review findings on an approved ticket are dropped. QA and the Milestone Review never see the REVIEW or CHANGE reports, so two hollow tests that a reviewer could have flagged shipped. | `src/engine/conductor/reviews.ts:46`; QA inputs at `src/engine/conductor/milestone.ts:162` | C |
| IF-2 | High | The next milestone's Spec and Tech Design get neither the previous Milestone Review and its known issues nor earlier Specs and Designs. The PM found them by globbing `.aiteam/`. Every CP2 bounced at least once, at about $0.61 a round. | `src/engine/conductor/milestone.ts:41` (`ROADMAP`, `HUMAN-REQUIREMENTS`), `:116` (`SPEC`, `ENV_PROFILE`); run transcripts | C |
| IF-3 | High | The code reviewer is told to judge the change against the criteria and the design, but gets only the ticket and the change report. A Bug ticket's reviewer sees neither the Bug nor its criterion. | `src/engine/conductor/reviews.ts:8-12` | C |
| IF-4 | Medium | A ticket kept as `still_valid` after a revise still pins the old Spec, so its engineer reads the old criterion text. | `src/engine/apply/design.ts:121` (`repinned` rewrites only `derived_from`); `src/engine/runner.ts:375-384` reads `ticket.inputs` | C |
| IF-5 | Medium | Engineers never see the Test Plan's commands or notes for their criteria. A Bug ticket's engineer doesn't get the criterion's text. | `src/engine/apply/qa.ts:147` (`inputs = [BUG, techPin]`), `:153` (Spec pin only in `derivedFrom`) | C |
| IF-6 | Medium | A revision isn't told what changed: there's no diff, `stale_sections` is unused, and it sees tickets by id only. A CP4 replan doesn't pin the Milestone Review or the QA report. | `src/engine/conductor/answers.ts:85-99` (`reviseInputs`) | C |
| IF-7 | Low | Milestone Reviews report deviations that the engine's own evidence contradicts. | STARLANCE `MILESTONE-REVIEW-M2` against `QA-REPORT-M2-*` | C |

## LC: lifecycle

Paths through the state machine that wedge a project or merge what nobody verified.

| ID | Sev | Finding | Evidence | Status |
|----|-----|---------|----------|--------|
| LC-1 | Critical | Answering a QA-cap hold with "Three more rounds" after a Change Request has already moved the milestone back to build tries build → build. That throws IllegalTransition, and the resulting engine error comes back every tick until the stakeholder halts. | `src/engine/conductor/answers.ts:136-141`; `src/engine/fsm.ts` (build: `['verify','halted']`); `src/engine/conductor/change-requests.ts` `RESET_FROM` | C |
| LC-2 | Critical | What merges isn't what was verified. The base branch is merged into the integration branch after QA and again in `merging`, and main advances with no re-verification. A hand-filed ticket (`POST /tickets`, no phase check) can merge during verify, CP4 or merging. | `src/engine/conductor/milestone.ts:222`, `:253-259`; the `POST /tickets` route in `src/server/app.ts` | C |
| LC-3 | High | Earlier milestones' criteria are never checked again, so M3 can break M1 and nothing notices. | `src/engine/conductor/milestone.ts:180` lists only milestone n | C |
| LC-4 | High | A Change Request approved against a merged milestone is applied and does nothing. | `src/engine/conductor/change-requests.ts` (`RESET_FROM` has no `merged`) | C |
| LC-5 | Medium | The Tech Design and Test Plan authors can't explain a criterion they can't cover. A Change Request they raise is discarded before `withRaised`, because the applier returns early on the coverage problem. | `src/engine/apply/design.ts:68-90` | C |
| LC-6 | Medium | A Roadmap Change Request can't add, drop or reorder milestones. The milestone rows are created once, at CP1. | `src/engine/conductor/answers.ts:51-57` | C |
| LC-7 | Medium | An attempt interrupted by a crash re-runs without limit. | `src/engine/runner.ts` recovery path | P |
| LC-8 | Medium | `moveBranch` reports any `update-ref` failure as `moved`, so `merging` waits silently for ever. | `src/git/merge.ts` `advanceBaseBranch`; `src/engine/conductor/milestone.ts:262` | P |
| LC-9 | Low | A revise ticket that depends on a ticket superseded in an earlier revise is cancelled as `dependency_cancelled`, or blocks for ever. | `src/engine/apply/design.ts:200-210` | P |

## SC: stakeholder control

| ID | Sev | Finding | Evidence | Status |
|----|-----|---------|----------|--------|
| SC-1 | High | Reject at any checkpoint halts the whole project for good. There is no pause and resume, and no way to reject one milestone. | `src/engine/conductor/answers.ts:39,62,86` | C |
| SC-2 | High | Retry on an escalation can't carry guidance, and the UI hides the text box whenever an item has options. One more failure escalates again. | `src/engine/escalations.ts:19`; `src/engine/runner.ts:195-201`; `web/src/pages/Inbox.tsx:28-38` | C |
| SC-3 | High | CP4 shows only documents. It never names the `aiteam/m<n>` branch, and the instructions for playing the game serve main, which doesn't have the milestone yet. CP4 feedback can't add a criterion. | `src/engine/conductor/milestone.ts:232-246` | C |
| SC-4 | Medium | Section Change Requests to the Roadmap or the Environment Profile are approved and change nothing that runs: not the smoke command, not the milestones. Change Requests can be filed only over raw HTTP, with no UI or CLI. | `src/engine/conductor/change-requests.ts:131` (`fields: doc.fields`) | C |
| SC-5 | Medium | `waived` can never be reached, so the QA-cap hold offers only more rounds or Halt. | No code path sets `waived`; `src/engine/conductor/milestone.ts:204-207` | C |
| SC-6 | Medium | The UI never shows spend. Discovery's cost appears in no review. | `web/src/pages/*` | C |
| SC-7 | Medium | CP3 (UX), the risky-change gate (spec §9.2) and a policy Settings screen aren't built. | spec §9.2 against `src/engine/conductor/*` | C |
| SC-8 | Low | No reminders or timeouts. A notification fires only for an item that arrives while a tab is open. | `web/src/pages/Inbox.tsx:8-21` | C |
| SC-9 | Low | Approve on CP4 ignores the comment that came with it. | `src/engine/conductor/answers.ts:100` | C |
| SC-10 | Medium | The project closes with Brief requirements never verified (60 fps, Safari and Firefox) and no record of what is still open. | `src/engine/conductor/milestone.ts:269`; STARLANCE Brief | C |

## BC: budgets and context

| ID | Sev | Finding | Evidence | Status |
|----|-----|---------|----------|--------|
| BC-1 | High | Only the per-attempt `max_turns` and `max_usd` limits exist. There's no cap per task, milestone or project, and no warning at 80%. Config has no budget keys, and unknown keys are rejected. | `src/config.ts:20-28,57`; role.yaml `budgets` | C |
| BC-2 | High | One ticket can spend about $36 in theory: 3 attempts × 3 escalation retries × $3 × the review loop, with nothing to stop it. | `src/engine/runner.ts:593-599` `retryOrEscalate` | P |
| BC-3 | High | The manifest has no room reserved for M4's playbook and memory: both are hard-coded to 0. M2-T-1 used 9,136 tokens, over the 9,000 test invariant. | `src/manifest/build.ts:169-178`; `test/helpers/large-milestone.ts:8` (`ROOM_BEFORE_M4`) | C |
| BC-4 | Medium | Over budget → escalate → Retry rebuilds the same manifest, so only Halt gets out. An M3 replan is estimated at about 12.2k tokens. | `src/engine/runner.ts:283-288` | P |
| BC-5 | Low | The size of the reference files is never logged. | `src/manifest/build.ts` | C |
| BC-6 | Low | Cache-read tokens grew sharply from M1 to M3. | `attempts.usage` | P |

## SI: security and isolation

| ID | Sev | Finding | Evidence | Status |
|----|-----|---------|----------|--------|
| SI-1 | High | A setup with `network: true` removes the network deny entirely instead of narrowing it to `network_allow`. An engineer can write a `package.json` postinstall that the next setup runs with full network. | `src/checks/run-checks.ts:79`; `src/engine/apply/qa.ts:92`; `src/engine/conductor/milestone.ts:85` | C |
| SI-2 | Medium | The Judge layer isn't there, so dependency, CI and migration changes reach main with no gate. | spec §9.2 risky changes | C |

## KL: knowledge and learning

| ID | Sev | Finding | Evidence | Status |
|----|-----|---------|----------|--------|
| KL-1 | High | Nothing captures knowledge, so the human is the memory. Four stakeholder rejections, and none of them recorded as a lesson. | spec M4; no Reflector | C |
| KL-2 | Medium | No learning baseline and no per-role metrics (spec G4). | spec §8.6 | C |
| KL-3 | Medium | Every escalation goes straight to the human: no Judge, no automatic replan. | `src/engine/runner.ts:593-599` | C |
| KL-4 | Low | The acceptance runs over-fit the Change Request path. | runs 8-10 | P |

---

## What's sound

- QA's commands are run by the engine itself, in a fresh worktree at the integration head (`src/engine/apply/qa.ts:89-118`).
- Answers are durable and applied once, and merges are atomic.
- Crash safety held in every run.
- Context per milestone stayed bounded, at 9.1k tokens or less.
- Code review had substance, and `changes_requested` does block.
- Request changes is cheap: $0.15 to $0.35, 48 to 92 s.
- Every play-test request the stakeholder made was built.

## Where STARLANCE's $10.81 went

- **By role:** PM $2.54, Tech Lead $2.57, code reviewer $2.55, engineer $2.37, QA $0.77.
- **By activity:** planning 40%, build and review 46%, QA and its review 10%.
- **By model:** 71% on Opus.
- **Rework:** $1.01 went on stakeholder bounces.
