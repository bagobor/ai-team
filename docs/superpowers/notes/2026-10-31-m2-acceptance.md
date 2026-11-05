# M2 acceptance on the real Claude CLI

Run on 2026-11-01 with `scripts/smoke-m2.ts`, the real `claude` binary (2.1.309, the desktop app's copy, set through `claude.binary`), the subscription login in `~/.aiteam/agent-home/claude`, and a temp project repo. Models: `claude-opus-5-5` for the PM, Tech Lead and Code Reviewer, `claude-sonnet-5-5` for the Engineer and QA Engineer.

The brief asked for a small dependency-free tool that converts temperatures from the command line, as one milestone.

**Result: `M2 ACCEPTANCE PASS`, 73 checks, 0 failed, on the third run.** The first two runs failed and found real problems, described below. The two small fixes the third run led to came after it, and the run was not repeated. Tests cover both.

**Run 4, on `main` at `25c77d6` on 2026-11-02: `M2 ACCEPTANCE PASS`, 81 checks, 0 failed, about $3.58.** It was meant to prove the two manifest-budget fixes. It proves less than that, and it found two problems the checks don't look for, both under "What the runs found". The sections on checks, drills and UI below still describe run 3.

**Run 5, on `m2-spec-view-and-harness` at `4aed29c` on 2026-11-02: `M2 ACCEPTANCE FAIL`, about $2.48.** It was meant to prove the fixes for run 4's two problems. The Spec's commands are now out of every manifest, and every worker read the whole reference file. QA filed no harness tickets. The run then stopped at QA on a third problem, older than the branch: the engine drops a change request whose target is written as a pin. That turned QA's correct findings about two of its own commands into false Bugs. Details are under "What the runs found".

**Run 6, on `m2-spec-view-and-harness` at `098e686` on 2026-11-02: `M2 ACCEPTANCE FAIL`, about $1.75.** It was meant to prove the fix for run 5's dropped change requests. It never reached QA, so that fix is proven only by the suite. It stopped at build: M1-T-2's definition of done greps for TAP lines that Node 25 doesn't print, so all three attempts failed `check_failed` on work that passes. The Engineer saw why each time and raised a correct change request, and the engine threw all three away, because a failed attempt's output is never applied. Details are under "What the runs found".

**Run 7, on `m2-spec-view-and-harness` at `3e60fdb` on 2026-11-03: `M2 ACCEPTANCE FAIL`, 3 checks failed, about $5.74.** It was meant to prove the fix for run 6, which files a failed attempt's requests and holds the ticket. No ticket attempt failed its checks, so that path never ran and is proven only by the suite. Otherwise the run went all the way: every criterion passed, all three tickets merged, main holds the code, and `node --test` passes 30 tests on it. The three failures are the script's own: its Change Request drill answered the Tech Lead's request instead of its own. The run also found a loop. The Tech Lead raised ten requests against AC-6's text to fix its recorded command, and none of them could. The revisions, recommendations and cancelled QA rounds came to $3.61 of the $5.74. Details are under "What the runs found".

**Run 8, on `m2-spec-view-and-harness` at `a5572c4` on 2026-11-04: `M2 ACCEPTANCE PASS`, 81 checks, 0 failed, about $1.91.** It was meant to prove the fixes for run 7. The script's Change Request drill now answers its own request, and it passed. No criterion went round: the Tech Lead raised no requests, and TECH-M1 and TEST-PLAN-M1 were revised once each, after the script's request. The PM used `proposed_verification` for the first time, in CR-2, but CR-2 never applied. By the time the stakeholder was asked about it, the script's CR-1 had changed the same criterion, so approving CR-2 superseded it instead. Neither the held-ticket path nor the reference file's new wording ran, because no ticket failed its checks and the Test Plan took the Spec's commands word for word. Details are under "What the runs found".

**Run 9, on `m2-spec-view-and-harness` at `6f253fe` on 2026-11-04: `M2 ACCEPTANCE PASS`, 77 checks, 0 failed, about $2.30.** It was meant to prove the fix for run 8's approved request that changed nothing. It had 9 criteria to run 8's 10, so four fewer checks. The PM again raised a criterion request while recommending on the script's CR-1. This was CR-2, against AC-4 this time, and approving it worked: SPEC-M1@3 adds a `36.6 C` case to AC-4's command. But AC-4 never moved, so the code before the fix would have applied CR-2 too, and the fix's handling of a moved criterion never ran. The run found two new problems. The revisions re-approved TECH-M1 and TEST-PLAN-M1 against SPEC-M1@2 after @3 was out, so QA ran AC-4 without the new case. And a request raised in the Milestone Review was left open when the milestone merged. Details are under "What the runs found". Both are fixed after run 9, in `38f5f79` and `4e2d97c` (suite 1386/1386), and neither fix has run for real yet.

## Runs and spend

Spend is the CLI's own estimate, taken from each attempt's final `result`. An interrupted attempt never reports a cost, so the crash drill's attempt is not in these figures.

| Run | Project | Outcome | Attempts | Worker time | Estimate |
|---|---|---|---|---|---|
| 1 | `smoke-m2` | Failed at discovery: every attempt `claude_code_version_too_old` | 3 | none | $0.00 |
| 2 | `smoke-m2-2` | Failed at QA: `M1-B-1 needs you. AC-1 failed verification: attempts_exhausted` | 25 | 1073s | $4.54 |
| 3 | `smoke-m2-3` | Passed | 17 | 860s | $3.66 |
| 4 | `smoke-m2-4` | Passed, with two problems the checks don't look for | 22 | 921s | $3.58 |
| 5 | `smoke-m2-5` | Failed at QA: `M1-B-1 needs you. AC-6 failed verification: attempts_exhausted` | 22 | 532s | $2.48 |
| 6 | `smoke-m2-6` | Failed at build: `M1-T-2 needs you. node:test suite under test/: attempts_exhausted` | 17 | 393s | $1.75 |
| 7 | `smoke-m2-7` | Merged, but the script's CR drill checks failed: it answered another request | 62 | 1232s | $5.74 |
| 8 | `smoke-m2-8` | Passed, with one approved request that changed nothing | 19 | 423s | $1.91 |
| 9 | `smoke-m2-9` | Passed, with an approved check QA never ran and a request left open at the merge | 17 | 479s | $2.30 |

The script's cap is $25. Isolation probes added about $0.04, so the total counted is about $8.24 for runs 1 to 3, about $11.82 with run 4, about $14.30 with run 5, about $16.05 with run 6, about $21.79 with run 7, about $23.70 with run 8 and about $26.00 with run 9.

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

Run 5, task by task, with 8 criteria:

| Task | Attempts | Estimate | Seconds |
|---|---|---|---|
| DISCOVERY-PM | 1 | $0.11 | 27 |
| DISCOVERY-TL | 1 | $0.12 | 22 |
| M1-SPEC | 2 (a1 `invalid_output`: ids `AC1` instead of `AC-1`) | $0.30 | 79 |
| M1-TECH | 1 | $0.36 | 86 |
| M1-TESTPLAN | 1 | $0.11 | 24 |
| M1-T-1 | 2 (a1 interrupted by the drill) | $0.08 | 29 |
| M1-T-2 | 1 | $0.07 | 18 |
| M1-T-3 | 1 | $0.05 | 10 |
| M1-T-1-R2 | 1 | $0.18 | 22 |
| CR-1-REC | 1 | $0.13 | 19 |
| M1-T-3-R1 | 1 | $0.09 | 13 |
| M1-T-2-R1 | 1 | $0.11 | 15 |
| M1-REVISE-TECH-M1-1 | 1 | $0.21 | 41 |
| M1-REVISE-TEST-PLAN-M1-1 | 1 | $0.09 | 8 |
| M1-QA-1 | 1 | $0.17 | 47 |
| M1-B-1 | 3 (a1 changes requested, a2 and a3 `no_changes`), then cancelled | $0.22 | 52 |
| M1-B-1-R1 | 1 | $0.09 | 20 |
| M1-B-2 | cancelled before it ran | $0.00 | 0 |

Run 6, task by task, with 10 criteria:

| Task | Attempts | Estimate | Seconds |
|---|---|---|---|
| DISCOVERY-PM | 1 | $0.10 | 23 |
| DISCOVERY-TL | 1 | $0.11 | 29 |
| M1-SPEC | 1 | $0.19 | 58 |
| M1-TECH | 1 | $0.24 | 56 |
| M1-TESTPLAN | 1 | $0.09 | 15 |
| M1-T-1 | 2 (a1 interrupted by the drill) | $0.09 | 34 |
| M1-T-2 | 3, each `check_failed`, then cancelled | $0.26 | 73 |
| M1-T-3 | 2 (a1 interrupted by the drill) | $0.04 | 14 |
| M1-T-3-R2 | 1 | $0.13 | 17 |
| M1-T-1-R2 | 1 | $0.12 | 19 |
| CR-1-REC | 1 | $0.12 | 17 |
| M1-REVISE-TECH-M1-1 | 1 | $0.17 | 31 |
| M1-REVISE-TEST-PLAN-M1-1 | 1 | $0.09 | 7 |

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

**Run 4: the Spec's commands stayed in every manifest (fixed on `m2-spec-view-and-harness`).** The PM wrote its own `## Acceptance criteria` in the Spec's body, a table of the criteria. The applier then added the engine's section under the same heading, which holds the `### AC-n` entries and the `Verified by:` lines. `replaceSection` takes the first match, so `specView` in both `role-inputs.ts` and `review-inputs.ts` replaced the PM's table and kept all ten commands. All six task texts I saved carry `Verified by:` ten times: Tech Design, Test Plan, Revise Test Plan, QA, the recommendation on the Change Request, and the Milestone Review.

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

**Run 4: the Test Plan asked for the product itself as a harness, and two tools were merged (wording fixed on `m2-spec-view-and-harness`).** The Test Plan and the Tech Design are written at the same time, so the QA Engineer can't see the Tech Lead's tickets. No code existed and its commands need a CLI, so it filed Q-1 "Implement the temperature converter CLI" and Q-2 "Add node --test suite" as `harness_tickets`. Q-1's own text says the syntax is "the Tech Lead's choice". The Tech Lead filed T-1 and T-2 for the same work, and all four merged. `main` holds `convert.js`, an untested `temperatures.js` that behaves differently, and three overlapping test files.

Code review approved Q-1, and all 81 checks passed, because nothing compares the two sets of tickets. The PM's Milestone Review caught it and named it under both Known issues and Deviations. The Q tickets and their reviews cost about $1.04 of the $3.58. Run 3's QA filed none, and nothing in the budget fixes points to this, so it looks like the model's call on the day, with nothing to stop it.

**The fixes for run 4's problems.** Both Spec views now replace the engine's own `## Acceptance criteria`, which is always the last level-2 section with that title, and keep the PM's text, including a table under the same heading (`criteriaSlug` in `src/engine/apply/milestone.ts`). The large-milestone fixture now writes a PM section of its own, as run 4's PM did, and 22 tests failed on it before the fix, 10 of them with `context_over_budget` at 30 criteria. The PM's table takes room in the Milestone Review, so what QA wrote is now capped at 2,500 tokens instead of 3,000. The manifest now tells workers to read the whole reference file. For harnesses, the QA charter, the Test Plan schema and its work order say that a harness is test tooling the product won't include, and that the Tech Lead's tickets build the product and everything its criteria ask it to include. Nothing structural enforces that. The smoke run now fails if a whole Spec in any manifest carries the engine's `Verified by:` lines, and it notes every ticket's title.

**Run 5: the fixes on a real project.** Six task texts read a whole Spec, and none has a `Verified by:` line. This PM wrote no section of its own, so the real run didn't exercise the two-heading case; the tests do. All six readers opened the whole file:

| Attempt | Manifest tokens | What it did with the file |
|---|---|---|
| M1-TECH | 3,331 | `Read`, all of it |
| M1-TESTPLAN | 3,576 | `Read`, all of it |
| CR-1-REC | 2,485 | `Glob`, then `Read`, all of it |
| M1-REVISE-TECH-M1-1 | 4,709 | `Glob`, then `Read`, all of it |
| M1-REVISE-TEST-PLAN-M1-1 | 4,326 | `cat`, all of it |
| M1-QA-1 | 3,304 | `cat`, all of it |

The largest of 22 manifests was M1-SPEC-a2 at 4,797 tokens. The Test Plan filed no harness tickets, and the Tech Lead's T-1 to T-3 built the product. Run 3 had none either, so this is weak evidence for the wording. The drills held: the worker killed on M1-T-1 outlived the daemon, and the daemon was healthy 4.7s after the SIGKILL. Time to each stop: CP1 52.6s, CP2 79.2s, first ticket running 85.6s.

**Run 5: the engine drops a change request that names its target as a pin, and turned QA's correct findings into false Bugs (not fixed, older than the branch).** The PM's verification for AC-6 says each specifier must appear in `require('node:module').builtinModules`, and for AC-7 that the TAP summary shows `# tests`. The Test Plan followed both. On Node 25.9.0 both are wrong: `builtinModules` has no plain `test` for `node:test`, and `node --test` prints `ℹ tests 19`. QA saw this, ran corrected commands, reported every criterion passing and "No product bugs", and raised two change requests against the Test Plan's commands. It named the target `TEST-PLAN-M1@1`. `changeRequestDocs` looks the target up as a bare id, so both were dropped with only a `change_request.dropped` event: "There is no document "TEST-PLAN-M1@1"". The engine's own re-run then failed AC-6 and AC-7 as written and filed BUG-M1-1 and BUG-M1-2 against a product that works.

- M1-B-1-a1 made the check pass by loading `node:test` through a variable, so the checker's pattern no longer saw it. The Code Reviewer rejected that. a2 and a3 changed nothing and raised a change request to fix the checker, so each failed with `no_changes`, and the ticket escalated. A failed attempt's output isn't applied, so those requests were lost too. The Code Reviewer's own request named `M1-B-1@1` and was dropped the same way.
- Seven change requests were raised in run 5 and none was filed. The other two, from CR-1-REC and M1-REVISE-TECH-M1-1, named both a section and a criterion, which the engine refuses. Run 4 dropped three: `ENV-PROFILE@1` and `M1-Q-2@1` as pins, and a section that doesn't exist. Nothing a person sees shows any of them.
- Workers are taught pins such as `SPEC-M1@1#ac-1` for `inputs`, and no schema describes `target_artifact`, so writing a pin there is the natural mistake. The fix is the engine's to choose: accept a pin and take its id, or send the output back as `invalid_output` the way other rule breaks go back.
- Even with the requests filed, the engine would still have filed the two Bugs, because it decides on the Test Plan's commands as written. A QA request against the very command that failed should probably hold that criterion's Bug until the request is decided.

**The fix for run 5's dropped requests (`098e686` on `m2-spec-view-and-harness`).** A pin such as `TEST-PLAN-M1@1#risks` is filed against the document's latest version, with the pin's section when none is named. A request that names both a section and a criterion keeps the criterion on a Spec or Test Plan, and the section elsewhere. A missing section's refusal lists the sections the document has. On a Test Plan, a criterion request replaces that criterion's commands, one per line, and the plan's owner decides it. Any other request that can't be filed sends the worker back with the reasons, except on its last attempt, which keeps its work and logs `change_request.dropped`. QA's verdict is checked for that before any command runs. When QA reports a criterion passing, every command of its own exited 0, a Test Plan command failed, and QA asked to change that criterion's commands, the engine files no Bug for it and the report names the request; the next round runs whatever is decided. Every schema now describes the four request fields. Suite 1357/1357.

**Run 6: the drills held, and the CR drill went the same way.** The worker killed on M1-T-1 outlived the daemon, and the daemon was healthy 7.8s after the SIGKILL. The PM again recommended rejecting CR-1, approving it published SPEC-M1@2, and M1-T-1, M1-T-2, TECH-M1 and TEST-PLAN-M1 went stale. Time to each stop: CP1 54.9s, CP2 56.9s, first ticket running 56.7s. No worker raised a malformed request, so the send-back path didn't run. The Engineer's three requests named `TEST-PLAN-M1` as a bare id with a criterion, which the new schema text asks for. One role in one run is weak evidence for that wording.

**Run 6: a check that can't pass on this Node, and a correct request thrown away three times (not fixed).** The PM's AC-8 says `node --test` passes, verified by `node --test > /tmp/m1t 2>&1` and then `grep -qE '^# fail 0$' /tmp/m1t && grep -qE '^# pass [1-9][0-9]*$' /tmp/m1t`. Node 25.9.0 uses the `spec` reporter even when output goes to a file, so it writes `ℹ fail 0`, and only `--test-reporter=tap` gives `# fail 0`. The Test Plan's AC-8 and M1-T-2's definition of done copy the Spec's five commands word for word. All 13 tests on a3's branch pass, and the check still exits 1. Run 5's AC-7 had the same mistake with `# tests`.

- Each Engineer attempt said exactly this in its notes, refused to fake `# pass` lines, and raised a change request against `TEST-PLAN-M1` AC-8 adding `--test-reporter=tap`. The checks run before the applier, so a `check_failed` attempt never reaches `withRaised`. All three requests were lost without even a `change_request.dropped` event. Run 5's `no_changes` attempts lost theirs the same way.
- Filing it would not have been enough. A Spec request replaces a criterion's text and keeps its `Verified by:` commands (`criterionReplacement`), the ticket's check comes from the Tech Design's `definition_of_done`, and the tickets derive from the Tech Design and the Spec, so a Test Plan change makes neither stale. Nothing a worker can raise changes a wrong command that lives in all three.
- The escalation the stakeholder got says "Read the last failure first" with no evidence. The last failure is "exited with 1" and an empty output tail, because `grep -q` prints nothing. The Engineer's diagnosis was only in the attempt's stored output.
- The Environment Profile says "Node.js 20 or newer", and its own smoke check printed `node v25.9.0 ok` at CP1. Nobody downstream was told the real version or what it changes.
- The worker's sandbox refuses writes to `/tmp`, and the engine's checks write there. Every attempt ran its check with `$TMPDIR` instead, so no worker can run its definition of done as written.

**The fix for run 6 (`3e60fdb` on `m2-spec-view-and-harness`).** A ticket attempt that fails its checks or changes nothing now files the requests it raised, each with `raised_in`, and the ticket waits, blocked on `change_request`, until they are decided. A last attempt escalates instead. An escalation carries the last failure, what the worker said and the requests the ticket raised. Suite 1367/1367.

**Run 7: the held-ticket path never ran.** No ticket attempt failed its checks or changed nothing, no task was ever blocked on `change_request`, and nothing escalated. This time QA wrote AC-6's Test Plan command for both reporters from the start, `grep -Eq '^(# |ℹ )pass [1-9]'`, and M1-T-3's definition of done uses it too. The drills held: the worker killed on M1-T-1 outlived the daemon, the daemon was healthy 8.0s after the SIGKILL, and a2 finished in a new worktree. Time to each stop: CP1 48.9s, CP2 36.7s, first ticket running 61.2s, CP4 626.7s after the CR drill.

**Run 7: the script's CR drill answered someone else's request (harness, not fixed).** The script files its request and then waits for `pending('cr')`, the first Change Request item in the Inbox. The Tech Lead's CR-2 was already waiting there, so the script approved CR-2 as its own. Its wait for SPEC-M1@2 was met at once, because CR-1 had already published it. Its own CR-3 then went through `settleTeamRequests`, which followed the PM and rejected it, so AC-1 never got the new text. The three failed checks come from that. The script should wait for the item whose `ref.cr` is the id the request route returns, and for a Spec version newer than the one it saw before filing.

**Run 7: ten requests that could not fix a command (not fixed).** SPEC-M1@1's AC-6 says the suite passes under `node --test`, and its `Verified by:` command greps only the TAP summary `^# pass [1-9]`. The Tech Lead raised CR-1 in M1-TECH, and the Spec's text was changed to accept both summary formats. The command stayed, because a Spec criterion request replaces only the text and keeps `verification.how` (`criterionReplacement`, `src/engine/change-requests.ts`). From then on the reference file showed "The Spec says:" with the TAP-only command next to the Test Plan's correct one. Each revising Tech Lead saw the contradiction and raised another request against AC-6's text, often with the right command written into it ("Only the verification command needs to change"). The PM recommended approving each one, the script followed, and each approval published a new Spec version, reset AC-6, made TECH-M1 and TEST-PLAN-M1 stale and started two more revisions.

- That came to CR-1, CR-2 and CR-5 to CR-12, SPEC-M1@12, 20 revision tasks ($2.73) that took TECH-M1 only to v4 and TEST-PLAN-M1 to v3, ten PM recommendations and QA's decision on CR-13 ($0.79), and five QA rounds cancelled by the next change ($0.09). One round was a real change: the PM's CR-4 against AC-2, which led to M1-T-3.
- It ended by chance. In M1-REVISE-TECH-M1-10 the Tech Lead aimed CR-13 at the Test Plan's commands instead. QA, as the plan's owner, rejected it because its command was already right, and the next revision raised nothing.
- A stakeholder would have seen eleven Inbox items about one command. Nothing limits how many times one criterion goes round, and the $25 cap is the only stop.

**Run 7: smaller things.** Three Tech Lead revisions (M1-REVISE-TECH-M1-4, -7 and -10) named merged tickets by their draft keys, `T-1` and `T-2`, and were refused with "Ticket T-1 is not an open ticket of this document". Each one cost an attempt. Two Code Reviewers tried to raise requests against a ticket, one against M1-T-2's `definition-of-done` section and one against M1-T-3's criteria. Both were sent back and corrected on a2. They are another sign that there is no route to a ticket's commands.

**The fixes for run 7 (`2fb2d00` and `a5572c4` on `m2-spec-view-and-harness`).** A Spec criterion request can carry `proposed_verification`, the reference file lists the Test Plan's commands first, and the script answers its own request. See the findings below. Suite 1375/1375.

**Run 8: what it proved.** The script's CR drill waited for its own CR-1, approved it, and saw SPEC-M1@2 published with the new text, the criterion reset and five dependents stale. No request was dropped, no task was blocked on `change_request`, and nothing escalated. The Tech Lead raised no requests, and each design document was revised once. The crash drill held: recovery killed the workers on M1-T-1 and M1-T-3, the daemon was healthy 8.8s after the SIGKILL, and both tickets finished on a2 in new worktrees. The largest manifest was M1-REVISE-TECH-M1-1-a1 at 4,632 tokens. Time to each stop: CP1 46.8s, CP2 55.1s, first ticket running 57.2s, CP4 85.6s after the CR drill. `node --test` passes 21 tests on the merged main.

**Run 8: what it didn't reach.** No ticket attempt failed its checks, so the held-ticket path from `3e60fdb` has still never run for real. The Test Plan took the Spec's commands word for word, so the reference file never had to say that the Spec names another command. Readers whose inputs have no Test Plan, such as the recommendations and the Tech Lead's revision, still see "The Spec says:", which is right for them.

**Run 8: an approved request that changed nothing (fixed after run 8).** The PM, recommending on the script's CR-1, saw that CR-1's new sentence about two decimal places is never tested, because none of AC-1's four known points needs more than two decimals. In the same output it raised CR-2 against AC-1. CR-2 proposed CR-1's text plus "`36.6C` prints `97.88°F`", and a `proposed_verification` that adds that case to the command. That is the first real use of the field, and the request was filed and shown as designed. But CR-2 was filed against SPEC-M1@1 while CR-1 was still waiting, and just over a second later the script's approval of CR-1 published SPEC-M1@2. The engine then still ran CR-2's recommendation ($0.09) and raised CR-2 in the Inbox, with SPEC-M1@2 among its evidence. The script approved it, following the PM, and DEC-40 records "Approve". Applying it hit `refuseIfMoved`, because AC-1 had changed since @1, and `applyRequest` closed CR-2 as superseded (`src/engine/conductor/change-requests.ts`). Only the event log and CR-2's status say so, and AC-1's command still checks only the four points. AC-4's cases test the rounding itself, so this run lost little. But a stakeholder would believe they had approved a change that never happened.

- The engine knew the criterion had moved before it spent the recommendation and asked. It could close such a request with the reason at that point. Or it could show the stakeholder the criterion's current text and check the request against the Spec version the Inbox showed, rather than the one the request was filed against.

**Run 9: what it proved.** The script's CR drill waited for its own CR-1 and approved it against the PM's advice. It then saw SPEC-M1@2 published with the new text, AC-1 reset, and M1-T-1, TECH-M1 and TEST-PLAN-M1 stale. The crash drill held: the worker killed on M1-T-1 outlived the daemon, the daemon was healthy 6.8s after the SIGKILL, and a2 finished in a new worktree. No attempt failed, and each design document was revised once. The largest manifest was M1-T-1-a1 at 5,733 tokens. Time to each stop: CP1 42.4s, CP2 86.8s, first ticket running 64.6s, and CP4 101.3s after the CR drill. `node --test` passes 5 tests on the merged main.

**Run 9: the fix for run 8, as far as it ran.**

- In CR-1-REC the PM again recommended rejecting CR-1. It also raised CR-2, against AC-4 this time, with a `proposed_verification` that adds `chk 36.6 C "97.88 F"` to AC-4's command.
- CR-2 was filed against SPEC-M1@1, and one second later CR-1's approval published SPEC-M1@2.
- The Inbox item for CR-2 showed SPEC-M1@2. The script approved it, following the PM, and the approval published SPEC-M1@3 with the new case in AC-4's text and command. This is the first time `proposed_verification` changed a command for real.
- This proves less about `6f253fe` than it seems. CR-1 changed only AC-1, so AC-4 was the same at @1 and @2, and the code before the fix would have applied CR-2 as well.
- Three parts of the fix never ran: withdrawing a pending item and asking again, the "AC-n now" evidence, and the `cr:N:<pin>` keys. Only the suite proves them.

**Run 9: a revision cleared staleness that a later Spec had set (fixed after run 9).**

- CR-1's approval made TECH-M1 and TEST-PLAN-M1 stale. The engine created M1-REVISE-TECH-M1-1 and M1-REVISE-TEST-PLAN-M1-1 at once, with SPEC-M1@2 in their work orders.
- CR-2's approval published SPEC-M1@3 about 12 seconds later, while both revisions were running. It marked M1-T-1 and M1-T-2 stale.
- Both revisions answered "unaffected" about SPEC-M1@2, which was true. The applier re-approved TECH-M1@1 and TEST-PLAN-M1@1 as derived from SPEC-M1@2, because `applyRevise` takes `derivedFrom` from the work order's frozen inputs (`src/engine/apply/design.ts`). The Tech Design's revision also re-approved both tickets as "Closed before this revision of TECH-M1".
- With nothing stale, the milestone went to verify with a Test Plan that never saw @3. QA ran the Spec's AC-4 command itself, with the new case, and its report says the Test Plan's command leaves that case out. The engine's own run decides the criterion, and it used the Test Plan's command, which lacks the `36.6 C` case the stakeholder had just approved.
- The merged main prints `97.88 F` for `36.6 C`, so nothing shipped broken. But the engine never ran the check the stakeholder approved.
- QA's report also says the worker sandbox blocked `mktemp -d`, so QA ran the commands with a wrapper on `PATH`. The engine's checks passed as written. Run 6's workers met the same thing with `/tmp`.
- Fixed in `38f5f79`. When an input the work order pinned has a newer approved or stale version, `applyRevise` publishes the document, or keeps it, as stale, so the next revision reads the newer version. The tickets are still re-approved, and the next round decides the open ones again. Tests: "leaves the design stale when the spec moved again while the worker decided" (`test/apply-authoring.test.ts`) and "revises again when the spec moves while a revision is running" (`test/conductor.test.ts`). Not yet run for real.
- Still open: the first Tech Design and Test Plan freeze their inputs the same way, so a Spec request approved while they are written has the same gap.

**Run 9: a request raised in the Milestone Review was left open at the merge (fixed after run 9).**

- In M1-REVIEW-1 the PM saw the same gap. It raised CR-3 against TEST-PLAN-M1's AC-4 to add the missing case.
- The engine published CR-3 with the review and raised CP4 115 ms later. CP4's evidence named only MILESTONE-REVIEW-M1@1, SPEC-M1@3 and QA-REPORT-M1-1@1, and nothing about CR-3.
- The script approved CP4, the milestone merged and the project closed. CR-3-REC, QA's recommendation as the plan's owner, was cancelled after 3 seconds.
- CR-3 is still `proposed` in a closed project. The check "The Inbox has nothing pending" passed, because CR-3 never reached the Inbox. A stakeholder would merge without knowing the team had asked for a change.
- Fixed in `4e2d97c`. CP4 is raised only once no change request is proposed. The merge waits the same way, for a request the stakeholder files while CP4 is pending. A request approved while the merge waits sends the milestone back to build, so `merging → build` is now allowed. The script now checks "No change request is left open" after the merge. Tests: "asks for CP4 only once a request raised in the Milestone Review is decided" and "merges only once a request filed while CP4 waited is decided", each for reject and approve (`test/conductor.test.ts`). Not yet run for real.

## What it leaves behind

- The projects `smoke-m2` to `smoke-m2-9` stay in the real `~/.aiteam`, because M2 has no project delete. `smoke-m2-3` and `smoke-m2-4` are closed, and the others are halted. Run 5's escalation and its attempt worktrees under `~/.aiteam/worktrees/smoke-m2-5` were left as they stopped, for inspection, and so were run 6's under `~/.aiteam/worktrees/smoke-m2-6`. Run 7's `smoke-m2-7` is closed, and its worktrees are under `~/.aiteam/worktrees/smoke-m2-7`. Run 8's `smoke-m2-8` is closed, and its two interrupted worktrees are under `~/.aiteam/worktrees/smoke-m2-8`. Run 9's `smoke-m2-9` is closed with CR-3 still proposed, and its interrupted worktree is under `~/.aiteam/worktrees/smoke-m2-9`. `smoke` and `smoke-2` from M1 were halted, because M2 would otherwise have started paid reviews for them.
- Their temp repos stay in the system temp folder as `aiteam-smoke-m2-*`.
- `aiteam.m1-backup.db` holds the database as it was before the M2 migration.
- `~/.aiteam/knowledge` has hand commits bringing existing files up to the seed, because `syncSeed` never overwrites a file that exists.

After the run stopped, port 4780 was free and no daemon or script process remained.

## Findings for later milestones

- **The context budget was the next thing a real project would hit. The fixes held at 30 criteria only for a Spec without its own `## Acceptance criteria` heading, and run 4's Spec has one. `m2-spec-view-and-harness` fixes that, and the tables below now hold for both.** M1-REVIEW-1-a2 used 11,841 of 12,000 tokens on a two-ticket milestone, because its inputs were the whole Spec, Test Plan and QA Report, and the PM's long verification commands appear in all three.

  The review is fixed on `m2-review-manifest-budget`. It now reads the Spec's prose and each criterion's text and status, the Test Plan's prose, and what QA wrote, and it leaves out the commands (`src/engine/review-inputs.ts`). What QA wrote is capped at 3,000 tokens (2,500 since `m2-spec-view-and-harness`), and the longest notes are cut first, with a mark that says so. The pins don't change, so the lineage doesn't either.

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

  - Run 5 is the first run with the commands only in the file. All six workers that needed it read all of it, and the Test Plan's commands follow the Spec's prose. Run 4's workers found it too, but three of the five that opened it read only the start.
  - Reading the file costs real context, outside the manifest budget: 23,206 characters at 30 criteria, about 6,630 tokens.
  - A worker's read tool may cut very long commands.
  - QA could still report a command that uses the file. That fails in the fresh worktree the engine verifies in, and costs a retry. The manifest warns against it.
  - Prose, criterion text and notes have no cap.
- **A change request can be lost without anyone seeing it (fixed after run 6).** `098e686` fixed run 5's cases for an attempt that is applied. Now an attempt that fails its checks (`check_failed`, `no_changes` or `scope_violation`) files what it raised as well, and each request names the ticket in `raised_in`. The ticket waits, blocked on `change_request`, until every request it raised is decided, whichever document they are against. If the decision leaves the ticket stale, it also waits for the Tech Lead's revision. A last attempt escalates instead of waiting. The retry's evidence says which requests were filed, but not how they were decided, so it may raise them again. Covered by the 'raised by a worker' tests in `test/change-requests.test.ts` and the 'a ticket held on a Change Request it raised' tests in `test/conductor.test.ts`, all seen failing first.
- **A wrong verification command has no route to a fix (partly fixed after run 7).** It is copied from the Spec into the Test Plan and the ticket's definition of done, and a request could change only the Test Plan's copy. See run 6. Run 7 shows what it costs: a Spec criterion request could change the text but not `Verified by:`, so the Tech Lead's ten requests went round ten times, for $3.61 of run 7's $5.74.

  Now a Spec criterion request can carry `proposed_verification`, one command on one line. Applying it replaces the command in the criterion's `Verified by:` line, in the Spec's criteria and in the registry, and resets the criterion to unverified. The stakeholder decides it, as for the text. It is refused on a Test Plan, whose commands are the proposed text, and on a section. Every schema a worker answers with describes it. The reference file now lists the Test Plan's commands first, and where the Spec names another command it says that QA verifies with the Test Plan's, so the Spec's runs only if the Test Plan takes it up. The ticket's definition of done still has no route of its own. Covered by the 'a Spec criterion's command' tests in `test/change-requests.test.ts`, a server test, and the reference-file test in `test/role-inputs.test.ts`, all seen failing first. In run 8 the PM used it once, and the request was filed and shown as designed, but it never applied (see run 8). Applying it is still proven only by the suite.
- **Nothing stops a criterion going round.** Run 7 published SPEC-M1@12 in ten minutes. After a few approved changes to one criterion within a milestone, the next one should go to the stakeholder with that history rather than start another round.
- **An approved request can change nothing (fixed after run 8).** A criterion-text request whose criterion moved after it was filed still got a recommendation and an Inbox question, and approving it superseded it without saying so. See run 8. In `6f253fe` the question is asked against the criterion's current text:
  - **The approval check.** An approval is checked against the Spec version its Inbox item showed, not the one the request was filed against. Only a move after the stakeholder saw it stops it.
  - **What the stakeholder sees.** When the criterion has moved since filing, the item says so, and it shows the criterion's current text as "AC-n now", pinned to the section.
  - **A move while the item waits.** The pending item is withdrawn and asked again with the new text.
  - **An approval in the same tick as a move.** The request stays open and is asked again, instead of being closed.
  - **What did not change.** The PM's recommendation is still made on the version the request was filed against. Requests the owner decides still close when their section moves.
  - **Tests.** Covered by three tests in `test/conductor.test.ts`, all seen failing first: 'applies a criterion change the stakeholder approved against the text they were shown…', 'asks again with the current text when a criterion moves while its change waits…' and 'asks again rather than closing a criterion change approved in the same tick…'.
  - **Not yet run for real.**
- **The acceptance script answered the first pending Change Request, not its own (fixed after run 7).** See run 7. It now waits for the Inbox item of the request it filed, never answers that one by the PM's recommendation, and checks the Spec version that its request published rather than SPEC-M1@2. Run 8 shows it works.
- **An escalation carries no evidence (fixed after run 6).** It now carries the last failure, what the last worker said in its summary and notes (cut at 1,500 characters), and each request the ticket raised with its status and target. Covered by the 'an escalated task' tests, seen failing first.
- **Roles write commands for a Node they haven't seen.** Twice now the Spec's commands assumed TAP output on Node 25. The Environment Profile should record the real versions its smoke check finds, and the knowledge base should keep what they change.
- **A self-approved command change.** A Test Plan command change that QA raises is decided by QA as the plan's owner, so QA could replace a failing command with `true`. The criterion's Bug is held only until the next round, but that round runs whatever QA decided, so a weaker command would pass it. Only the Milestone Review and CP4 put it in front of a person. A Test Plan change raised by its own owner should go to the Tech Lead or the stakeholder.
- **A false Bug dead-ends.** An Engineer who correctly changes nothing gets `no_changes` three times, then escalation. Run 5 hit it again, and its Engineer's request to fix the checker was lost with the failed attempt. The fix for exit 127 only handles commands the shell can't find. Prose that starts with a real command (exit 1, 129) relies on the new wording. The judge layer (M5) is the natural place for this.
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
