# M2 acceptance on the real Claude CLI

Run on 2026-11-01 with `scripts/smoke-m2.ts`, the real `claude` binary (2.1.309, the desktop app's copy, set through `claude.binary`), the subscription login in `~/.aiteam/agent-home/claude`, and a temp project repo. Models: `claude-opus-5-5` for the PM, Tech Lead and Code Reviewer, `claude-sonnet-5-5` for the Engineer and QA Engineer.

The brief asked for a small dependency-free tool that converts temperatures from the command line, as one milestone.

**Result: `M2 ACCEPTANCE PASS`, 73 checks, 0 failed, on the third run.** The first two runs failed and found real problems, described below. The two small fixes the third run led to came after it, and the run was not repeated. Tests cover both.

## Runs and spend

Spend is the CLI's own estimate, taken from each attempt's final `result`. An interrupted attempt never reports a cost, so the crash drill's attempt is not in these figures.

| Run | Project | Outcome | Attempts | Worker time | Estimate |
|---|---|---|---|---|---|
| 1 | `smoke-m2` | Failed at discovery: every attempt `claude_code_version_too_old` | 3 | none | $0.00 |
| 2 | `smoke-m2-2` | Failed at QA: `M1-B-1 needs you. AC-1 failed verification: attempts_exhausted` | 25 | 1073s | $4.54 |
| 3 | `smoke-m2-3` | Passed | 17 | 860s | $3.66 |

The script's cap is $25. Isolation probes added about $0.04, so the total counted is about $8.24.

Run 3, task by task:

| Task | Kind | Role | Attempts | Estimate | Seconds |
|---|---|---|---|---|---|
| DISCOVERY-PM | authoring | pm | 1 | $0.09 | 34 |
| DISCOVERY-TL | authoring | tech_lead | 1 | $0.12 | 27 |
| M1-SPEC | authoring | pm | 1 | $0.37 | 160 |
| M1-TECH | authoring | tech_lead | 1 | $0.50 | 156 |
| M1-TESTPLAN | authoring | qa_engineer | 1 | $0.14 | 26 |
| M1-T-1 | ticket | engineer | 2 (a1 interrupted by the drill) | $0.12 | 34 |
| M1-T-2 | ticket | engineer | 1 | $0.09 | 29 |
| M1-T-1-R2 | code_review | code_reviewer | 1 | $0.22 | 35 |
| CR-1-REC | authoring | pm | 1 | $0.13 | 17 |
| M1-REVISE-TECH-M1-1 | authoring | tech_lead | 2 (a1 `invalid_output`) | $0.58 | 97 |
| M1-REVISE-TEST-PLAN-M1-1 | authoring | qa_engineer | 1 | $0.17 | 29 |
| M1-T-2-R1 | code_review | code_reviewer | 1 | $0.18 | 35 |
| M1-QA-1 | qa_verify | qa_engineer | 1 | $0.28 | 71 |
| M1-REVIEW-1 | authoring | pm | 2 (a1 `invalid_output`) | $0.67 | 110 |

## Checks on the passing run

| # | Check | Result |
|---|---|---|
| 1 | Doctor passes and the seed roles load | PASS: all five roles on their planned models, and the Engineer can raise a Change Request |
| 2 | CP1 names who, why, what it blocks, a recommendation and the evidence | PASS: from `pm`, blocks Milestone 1, evidence ROADMAP, TEAM-PROPOSAL, HUMAN-REQUIREMENTS, ENV-PROFILE |
| 3 | The smoke command passed in the sandbox | PASS: `node --version` |
| 4 | CP2 locks the criteria, each saying how it's verified | PASS: AC-1 to AC-8, all `automated`, SPEC-M1@1 approved |
| 5 | No ticket before design finishes, every ticket has criteria, every manifest within 12,000 tokens | PASS: 17 manifests, the largest is M1-REVIEW-1-a2 at 11,841 |
| 6 | Crash drill | PASS, below |
| 7 | Every merged ticket has a Review Report from a separate attempt | PASS: REVIEW-M1-T-1-a2@1, REVIEW-M1-T-2-a1@1 |
| 8 | Change Request drill | PASS, below |
| 9 | QA evidence comes from the engine's re-run, and every criterion is `passing` | PASS: each criterion cites QA-REPORT-M1-1@1, and the engine ran the Test Plan's commands |
| 10 | `main` doesn't move until CP4, then holds the code and `.aiteam/`, and a dirty unrelated file survives | PASS: base stayed at `9b25bba` until CP4; afterwards README.md, temp.js, test/temp.test.js and 21 files under `.aiteam/`; `NOTES.md` still modified, `scratch-notes.txt` still untracked, git reports only ` M NOTES.md`, HEAD on `refs/heads/main` |
| 11 | `node --test` passes on the merged `main`, run by the script | PASS: exit 0, 34 passed |
| 12 | Spend under the cap, labelled as an estimate | PASS: estimate $3.66 of $25 |

Time to each stop: CP1 63.3s, CP2 161.2s, first ticket running 157.1s, CP4 279.3s after the Change Request, merge 2.0s after the approval.

## Crash drill

Two kills, so that a pending Inbox item and a running worker are each tested.

| Step | Result |
|---|---|
| SIGKILL at CP2, where no worker runs | Item 7 comes through unchanged and still pending |
| SIGKILL while M1-T-1's first worker runs | Worker 81854 had a live pid and outlived the daemon, so recovery had a real orphan |
| Daemon healthy again | 3.7s after SIGKILL |
| The old worker's pid is gone | 3.7s after SIGKILL |
| Attempts on M1-T-1 | a1 `interrupted`, a2 `succeeded` |
| a2 has a different worktree | `~/.aiteam/worktrees/smoke-m2-3/M1-T-1-a2` |
| M1-T-1 reaches `done` | 67.2s after the kill |

## Change Request drill

Filed against AC-1 while the milestone was in `build`, after the killed ticket finished. It waits for that ticket because a revision may supersede any open one, which would have left check 6 with nothing to prove.

| Step | Result |
|---|---|
| Reaches the Inbox with a PM recommendation | 20.4s. The PM recommended **rejecting** it: "SPEC-M1@1 already covers it". That's correct, since AC-4 covers rounding. The script approves anyway, to exercise the path |
| Approving it publishes SPEC-M1@2 | 2.1s |
| The criterion | New text, `unverified`, spec v2 |
| What depends on it is stale | M1-T-1, TECH-M1, TEST-PLAN-M1 |
| The revisions ran | Both `done`, and Documents ends with 0 stale |
| QA re-verified the new text | AC-1 `passing` from QA-REPORT-M1-1@1, which derives from SPEC-M1@2 and TEST-PLAN-M1@2 |

## UI on the kept daemon

Checked in the browser against the daemon run 3 left up, with no console errors.

- **Inbox:** "Nothing is waiting for you", 0 in this project, 0 in all projects. The pane blocks browser notifications, so the notification path is unverified.
- **Board:** M1 shows 0 in every column but Done, which has 10 cards, including M1-T-1 and M1-T-2 with their criteria, attempts and `Reviewer: done`. Costs read `~$0.12 est.`
- **Documents:** 21 documents, 0 stale, SPEC-M1 and TEST-PLAN-M1 at v2, and the lineage graph runs from BRIEF to the reports. The traceability table lists all 8 criteria with their tickets, tests, evidence pins and `passing`. Opening QA-REPORT-M1-1 shows it derives from SPEC-M1@2 and TEST-PLAN-M1@2.

Screenshots:

- [Inbox, nothing pending](m2-acceptance/inbox.jpg)
- [Board, every ticket in Done](m2-acceptance/board.jpg)
- [Documents, lineage and evidence](m2-acceptance/documents.jpg)

## What the runs found

**Run 1: the installed CLI was too old for the models.** `claude` 2.1.109 refuses the 5.5 models, which need 2.1.280 or newer. `~/.aiteam/config.yaml` now points `claude.binary` at the desktop app's 2.1.309, and the global CLI was left alone.

**2.1.309 reached workers differently.** The isolation probe failed: this CLI offers workers the account's synced skills and reports built-in plugins. `320b7cb` adds `--disable-slash-commands` and tolerates only plugins whose path is `builtin`. The adapter suite passed on streams re-recorded from 2.1.309. The committed fixtures still pin 2.1.109.

**Run 2: QA described what it did in `commands`, and the engine filed false Bugs.** Every Test Plan command exited 0. QA's own entries were prose such as `spec AC-1 conv command, verbatim`, which exit 127, so the engine filed 8 Bugs. The Engineer rightly changed nothing, got `no_changes` three times, and the task escalated. `1ced163` makes a claim of `passing` on a command the shell can't find an `invalid_output` that goes back to QA, with no Bug filed. A command of the Test Plan's own that can't be found still counts as failing. The charter and schemas now state the rule.

Run 2 also burned attempts on rules workers were never told, such as ticket key format, `specialty` and pin format. The same commit states them, and run 3 passed M1-TECH and M1-TESTPLAN on the first try. In that run the revision superseded every open ticket, so the Tech Lead's charter now says a ticket stays `still_valid` unless the change really touches it.

**Run 3: a revision refused a correct decision about a ticket that had just merged (fixed after the run).** M1-REVISE-TECH-M1-1's work order listed M1-T-2 as open, and M1-T-2 wasn't stale, so it merged while the Tech Lead was deciding. The applier then refused "Ticket M1-T-2 is not an open ticket of this document". That cost one attempt, about $0.29, and on a busier build could have used all three. A decision about a ticket closed since then is now ignored and can never supersede merged work. Only a ticket the document doesn't have is refused. Covered by 'ignores a decision about a ticket that closed while the worker was deciding' and 'never lets a late decision supersede a ticket that has merged', both seen failing first.

**Run 3: the PM wasn't told which review headings the engine writes (fixed after the run).** M1-REVIEW-1-a1 used the heading "Acceptance criteria", which is correctly refused. The `body` in `milestone_review.json` now says so. It's the same kind of gap as run 2's unstated rules.

## What it leaves behind

- The projects `smoke-m2`, `smoke-m2-2` and `smoke-m2-3` stay in the real `~/.aiteam`, because M2 has no project delete. The first two are halted and the third is closed. `smoke` and `smoke-2` from M1 were halted, because M2 would otherwise have started paid reviews for them.
- Their temp repos stay in the system temp folder as `aiteam-smoke-m2-*`.
- `aiteam.m1-backup.db` holds the database as it was before the M2 migration.
- `~/.aiteam/knowledge` has hand commits bringing existing files up to the seed, because `syncSeed` never overwrites a file that exists.

After the run stopped, port 4780 was free and no daemon or script process remained.

## Findings for later milestones

- **The context budget is the next thing a real project will hit.** M1-REVIEW-1-a2 used 11,841 of 12,000 tokens on a two-ticket milestone. Its inputs are the Spec, the Test Plan and the QA Report, and each grows with the number of criteria, partly because the PM's verification commands are long and appear in all three. A milestone with a few more criteria stops at `context_over_budget`, which escalates at once and that a retry can't fix. Inputs need trimming or section pins before the Apple Watch project.
- **A false Bug dead-ends.** An Engineer who correctly changes nothing gets `no_changes` three times, then escalation. The fix for exit 127 only handles commands the shell can't find. Prose that starts with a real command (exit 1, 129) relies on the new wording. The judge layer (M5) is the natural place for this.
- **A revise's work order is frozen when it's created.** Tickets that close are now handled, but a ticket opened after that, such as a Bug filed while a revision runs, still costs an attempt before the evidence names it.
- **Doctor passes while workers can't use the configured models.** It checks neither the CLI version nor the models, so a stakeholder finds out at the first attempt, and a permanent `worker_error` then uses all 3 attempts before escalating.
- **Nothing re-runs the isolation probe when `claude.binary` changes.** The path also includes the app's version and a hash, so an app update can remove it.
- **An M1 project carried into M2 starts paid reviews on the first tick**, because the migration puts it in `intake` and `advanceReviews` ignores phase. Later migrations should halt or skip what was already there.
- **An install gets no new seed wording for existing files**, except by hand.
- **`AITEAM_HOME=''` is treated as a root** and creates `aiteam.db` in the current folder.
- **QA's inputs are only the Spec and Test Plan.** In run 2 QA said it hadn't run the ENV-PROFILE commands "because I don't have their definitions". Check whether its manifest should carry them.
- **QA's sandbox and the engine's differ.** Run 3's QA reported that `mktemp -d` was blocked for it and worked around that, and also merged four checks into one script. The engine's own re-run used the commands as written, so the result stands, but a QA summary can describe a different run from the one that decided.
- **Verification commands are heavy.** Run 3's are long `node -e` one-liners, repeated across documents. They work, but they're hard for a person to read in the traceability table.
- **A worker outlives a SIGKILLed daemon** until recovery kills it, 3.7s in this run.
- **The Board scrolls sideways at 800px**, so Done is off-screen in a narrow window.
- **One unexplained test failure:** `test/qa-verify.test.ts` failed once in `afterEach` at `e.cleanup()`. I didn't capture the message, and every later run passed.
