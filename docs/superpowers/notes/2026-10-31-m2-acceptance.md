# M2 acceptance on the real Claude CLI

Run on 2026-11-01 with `scripts/smoke-m2.ts`, the real `claude` binary (2.1.309, the desktop app's copy, set through `claude.binary`), the subscription login in `~/.aiteam/agent-home/claude`, and a temp project repo. Models: `claude-opus-5-5` for the PM, Tech Lead and Code Reviewer, `claude-sonnet-5-5` for the Engineer and QA Engineer.

The brief asked for a small dependency-free tool that converts temperatures from the command line, as one milestone.

**Result: `M2 ACCEPTANCE PASS`, 73 checks, 0 failed, on the third run.** The first two runs failed and found real problems, described below. The two small fixes the third run led to came after it, and the run was not repeated. Tests cover both.

**Run 4, on `main` at `25c77d6` on 2026-11-02: `M2 ACCEPTANCE PASS`, 81 checks, 0 failed, about $3.58.** It was meant to prove the two manifest-budget fixes. It proves less than that, and it found two problems the checks don't look for, both under "What the runs found". The sections on checks, drills and UI below still describe run 3.

## Runs and spend

Spend is the CLI's own estimate, taken from each attempt's final `result`. An interrupted attempt never reports a cost, so the crash drill's attempt is not in these figures.

| Run | Project | Outcome | Attempts | Worker time | Estimate |
|---|---|---|---|---|---|
| 1 | `smoke-m2` | Failed at discovery: every attempt `claude_code_version_too_old` | 3 | none | $0.00 |
| 2 | `smoke-m2-2` | Failed at QA: `M1-B-1 needs you. AC-1 failed verification: attempts_exhausted` | 25 | 1073s | $4.54 |
| 3 | `smoke-m2-3` | Passed | 17 | 860s | $3.66 |
| 4 | `smoke-m2-4` | Passed, with two problems the checks don't look for | 22 | 921s | $3.58 |

The script's cap is $25. Isolation probes added about $0.04, so the total counted is about $8.24 for runs 1 to 3 and about $11.82 with run 4.

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

Run 4, task by task. It had 10 criteria to run 3's 8, so the two compare only roughly:

| Task | Attempts | Estimate | Seconds |
|---|---|---|---|
| DISCOVERY-PM | 1 | $0.12 | 30 |
| DISCOVERY-TL | 1 | $0.12 | 23 |
| M1-SPEC | 1 | $0.31 | 113 |
| M1-TECH | 1 | $0.42 | 133 |
| M1-TESTPLAN | 1 | $0.12 | 30 |
| M1-Q-1 | 2 (a1 interrupted by the drill) | $0.07 | 27 |
| M1-Q-2 | 2 | $0.17 | 57 |
| M1-T-1 | 2 (a1 interrupted by the drill) | $0.07 | 27 |
| M1-T-2 | 1 | $0.09 | 28 |
| M1-Q-1-R2 | 1 | $0.26 | 48 |
| M1-T-1-R2 | 1 | $0.17 | 32 |
| CR-1-REC | 1 | $0.17 | 27 |
| M1-T-2-R1 | 1 | $0.20 | 36 |
| M1-REVISE-TEST-PLAN-M1-1 | 1 | $0.09 | 8 |
| M1-REVISE-TECH-M1-1 | 1 | $0.31 | 64 |
| M1-Q-2-R1 | 1 | $0.27 | 64 |
| M1-Q-2-R2 | 1 | $0.27 | 80 |
| M1-QA-1 | 1 | $0.12 | 44 |
| M1-REVIEW-1 | 1 | $0.24 | 51 |

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

**Run 4: what the budget fixes did on a real project.** The manifests shrank: the largest is M1-REVISE-TECH-M1-1-a1 at 6,355 tokens on 10 criteria, against 11,841 on 8 in run 3. No attempt failed with `invalid_output`, and M1-REVIEW-1 succeeded first time at 4,330. The drills held too: the worker killed on M1-Q-1 outlived the daemon, the daemon was healthy 6.6s after the SIGKILL, and the PM again recommended rejecting the Change Request. Time to each stop: CP1 55.1s, CP2 114.3s, first ticket running 134.3s, CP4 271.4s after the Change Request, merge 2.0s.

**Run 4: the Spec's commands stayed in every manifest (not fixed, and on `main`).** The PM wrote its own `## Acceptance criteria` in the Spec's body, a table of the criteria. The applier then added the engine's section under the same heading, which holds the `### AC-n` entries and the `Verified by:` lines. `replaceSection` takes the first match, so `specView` in both `role-inputs.ts` and `review-inputs.ts` replaced the PM's table and kept all ten commands. All six task texts I saved carry `Verified by:` ten times: Tech Design, Test Plan, Revise Test Plan, QA, the recommendation on the Change Request, and the Milestone Review.

- The test fixture's Spec has no such heading, so the suite couldn't catch this. Of the four Specs in temp repos that reached `main`, only this one has two such headings, so it depends on what the PM writes.
- The run doesn't show that a worker can get its commands from the file alone, because they were in the manifest as well. M1-TESTPLAN read 2 of the 10 criteria in the file, and all ten of its commands still match the Spec word for word.
- What did take effect is dropping the copy in the Spec's frontmatter and the Test Plan's commands. That's why the manifests fell anyway, helped by real commands averaging 223 characters, not 700.
- The tables under "Findings for later milestones" hold only for a Spec without that heading. By estimate, at 700 characters a Spec like this one adds about 204 tokens per criterion, so QA, Revise Test Plan and the review each reach 12,000 at about 28 criteria. At this run's 223 characters, QA reaches it at about 48.
- The PM's table was lost from every manifest, and nothing was meant to touch it.

**Run 4: workers found the file, but most read only the start of it.** Once the commands really are only in the file, a worker that stops early won't see them, so the manifest should say to read all of it.

| Attempt | Manifest tokens | What it did with the file |
|---|---|---|
| M1-TECH | 4,690 | `Read`, all of it |
| M1-TESTPLAN | 4,731 | `head -20`: 2 of 10 criteria |
| M1-REVISE-TECH-M1-1 | 6,355 | `Glob`, then `Read`, all of it |
| M1-REVISE-TEST-PLAN-M1-1 | 5,864 | `head -60`, then answered `unaffected: true` after 8 seconds |
| M1-QA-1 | 4,875 | `head -80`: stops just before AC-10's command |
| CR-1-REC | 3,874 | Saw it in a `Glob`, didn't open it |
| M1-REVIEW-1 | 4,330 | Its role gets no file |

**Run 4: the Test Plan asked for the product itself as a harness, and two tools were merged (not fixed).** The Test Plan and the Tech Design are written at the same time, so the QA Engineer can't see the Tech Lead's tickets. No code existed and its commands need a CLI, so it filed Q-1 "Implement the temperature converter CLI" and Q-2 "Add node --test suite" as `harness_tickets`. Q-1's own text says the syntax is "the Tech Lead's choice". The Tech Lead filed T-1 and T-2 for the same work, and all four merged. `main` holds `convert.js`, an untested `temperatures.js` that behaves differently, and three overlapping test files.

Code review approved Q-1, and all 81 checks passed, because nothing compares the two sets of tickets. The PM's Milestone Review caught it and named it under both Known issues and Deviations. The Q tickets and their reviews cost about $1.04 of the $3.58. Run 3's QA filed none, and nothing in the budget fixes points to this, so it looks like the model's call on the day, with nothing to stop it.

## What it leaves behind

- The projects `smoke-m2`, `smoke-m2-2`, `smoke-m2-3` and `smoke-m2-4` stay in the real `~/.aiteam`, because M2 has no project delete. The first two are halted and the other two are closed. `smoke` and `smoke-2` from M1 were halted, because M2 would otherwise have started paid reviews for them.
- Their temp repos stay in the system temp folder as `aiteam-smoke-m2-*`.
- `aiteam.m1-backup.db` holds the database as it was before the M2 migration.
- `~/.aiteam/knowledge` has hand commits bringing existing files up to the seed, because `syncSeed` never overwrites a file that exists.

After the run stopped, port 4780 was free and no daemon or script process remained.

## Findings for later milestones

- **The context budget was the next thing a real project would hit. The fixes hold at 30 criteria only for a Spec without its own `## Acceptance criteria` heading, and run 4's Spec has one.** M1-REVIEW-1-a2 used 11,841 of 12,000 tokens on a two-ticket milestone, because its inputs were the whole Spec, Test Plan and QA Report, and the PM's long verification commands appear in all three.

  The review is fixed on `m2-review-manifest-budget`. It now reads the Spec's prose and each criterion's text and status, the Test Plan's prose, and what QA wrote, and it leaves out the commands (`src/engine/review-inputs.ts`). What QA wrote is capped at 3,000 tokens, and the longest notes are cut first, with a mark that says so. The pins don't change, so the lineage doesn't either.

  The other roles still read whole documents at that point, so this moved the practical limit from about 8 criteria to about 10, not to 30. Tokens per manifest before `m2-role-manifest-budget`, measured with the first run's sizes (about 700 characters per verification command):

  | Criteria | Review before | Review now | Tech Design, Test Plan | QA |
  |---|---|---|---|---|
  | 10 | 14,017 | 3,705 | 8,126 | 11,171 |
  | 12 | 16,330 | 3,980 | 9,338 | 12,918 |
  | 16 | 20,955 | 4,528 | 11,762 | 16,413 |
  | 20 | 25,580 | 5,077 | 14,186 | 19,908 |
  | 30 | 37,143 | 6,448 | 20,246 | 28,645 |

  Tech Design and Test Plan also read the Environment Profile, which adds about 660 tokens that this table leaves out. So QA went over the 12,000 budget at about 11 criteria, and Tech Design and Test Plan at about 16. Both stopped before the review was reached, with a `context_over_budget` that a retry can't fix. Dropping only the copies in the Spec's `data.criteria` and `Verified by:` lines still left QA at about 12,850 tokens at 30 criteria.

  The fix is on `m2-role-manifest-budget` (`src/engine/role-inputs.ts`). Every role except the review's PM now reads a whole Spec or Test Plan as what people wrote: the Spec's prose and each criterion's text, and the Test Plan's prose and notes. The commands go to `.aiteam-reference/verification.md` in the attempt's worktree, each once and word for word, and the manifest says where. The engine writes the file after a profile's setup has run. Its folder ignores itself, so it stays out of `git status` and a ticket's snapshot. An input pinned to one section stays as it was, so an Engineer's criterion keeps its command beside it. The pins don't change, so the lineage doesn't either.

  Tokens per manifest now, with the same sizes, with the Environment Profile counted where it's read, and for a Spec without its own heading (run 4 shows what happens with one):

  | Criteria | QA | Tech Design | Test Plan | Revise Test Plan | Revise Tech Design | Recommendation on the Spec | Spec, round 2 |
  |---|---|---|---|---|---|---|---|
  | 10 | 3,825 | 3,494 | 3,535 | 4,085 | 3,199 | 2,507 | 2,549 |
  | 12 | 4,085 | 3,655 | 3,696 | 4,345 | 3,359 | 2,667 | 2,710 |
  | 16 | 4,607 | 3,976 | 4,017 | 4,866 | 3,681 | 2,988 | 3,031 |
  | 20 | 5,128 | 4,297 | 4,338 | 5,387 | 4,002 | 3,310 | 3,352 |
  | 30 | 6,431 | 5,100 | 5,141 | 6,690 | 4,805 | 4,112 | 4,155 |
  | 60 | 10,339 | 7,509 | 7,549 | 10,599 | 7,213 | 6,521 | 6,564 |

  For such a Spec, command length no longer counts. At 30 criteria, with several commands of 2,000 characters for each criterion, QA measures 6,439, Revise Test Plan 6,699 and Tech Design 5,100, and the file reaches 241,999 characters. What's left grows with criterion text and notes, about 130 tokens per criterion for QA. That reaches the 9,000 target at about 50 criteria and the budget at about 73.

  This doesn't settle everything:

  - No run has yet shown a worker managing with the commands only in the file. Run 4's workers found it, and a `Glob` lists it even though the folder is git-ignored, but three of the five that opened it read only the start.
  - Reading the file costs real context, outside the manifest budget: 23,206 characters at 30 criteria, about 6,630 tokens.
  - A worker's read tool may cut very long commands.
  - QA could still report a command that uses the file. That fails in the fresh worktree the engine verifies in, and costs a retry. The manifest warns against it.
  - Prose, criterion text and notes have no cap.
- **A false Bug dead-ends.** An Engineer who correctly changes nothing gets `no_changes` three times, then escalation. The fix for exit 127 only handles commands the shell can't find. Prose that starts with a real command (exit 1, 129) relies on the new wording. The judge layer (M5) is the natural place for this.
- **A revise's work order is frozen when it's created.** Tickets that close are now handled, but a ticket opened after that, such as a Bug filed while a revision runs, still costs an attempt before the evidence names it.
- **Doctor passes while workers can't use the configured models.** It checks neither the CLI version nor the models, so a stakeholder finds out at the first attempt, and a permanent `worker_error` then uses all 3 attempts before escalating.
- **Nothing re-runs the isolation probe when `claude.binary` changes.** The path also includes the app's version and a hash, so an app update can remove it.
- **Migrations must not leave old rows runnable.** An M1 project carried into M2 would have started paid reviews on the first tick, so migration 002 now halts every project it finds. Halted is terminal, so such a project stays read-only and its work starts again as a new project. Later migrations should do the same for anything the engine would otherwise pick up.
- **An install gets no new seed wording for existing files**, except by hand.
- **`AITEAM_HOME=''` is treated as a root** and creates `aiteam.db` in the current folder.
- **QA's inputs are only the Spec and Test Plan.** In run 2 QA said it hadn't run the ENV-PROFILE commands "because I don't have their definitions". Check whether its manifest should carry them.
- **QA's sandbox and the engine's differ.** Run 3's QA reported that `mktemp -d` was blocked for it and worked around that, and also merged four checks into one script. The engine's own re-run used the commands as written, so the result stands, but a QA summary can describe a different run from the one that decided. Run 4's QA hit the same block on AC-10, and the Milestone Review reported that as a deviation even though the engine's re-run passed the command as written.
- **Verification commands are heavy.** Run 3's are long `node -e` one-liners, repeated across documents. They work, but they're hard for a person to read in the traceability table.
- **A worker outlives a SIGKILLed daemon** until recovery kills it, 3.7s in this run.
- **The Board scrolls sideways at 800px**, so Done is off-screen in a narrow window.
- **One unexplained test failure:** `test/qa-verify.test.ts` failed once in `afterEach` at `e.cleanup()`. I didn't capture the message, and every later run passed.
