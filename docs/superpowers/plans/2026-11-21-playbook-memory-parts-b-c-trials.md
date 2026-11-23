# Parts B and C: Drafts and trials — Implementation Plan

**Goal:** A change to a role's charter, playbook or project memory is made as a draft, tried on 5 to 7 of the role's past assignments, and committed only when no measured check got worse and a model, the role's evaluator (if set) and the stakeholder each call it an improvement.

**Spec:** `docs/superpowers/specs/2026-11-15-playbook-memory-trials-design.md`, Parts B and C. Calls 3 to 7 and 9 apply. Part D gets its own plan.

**Builds on:** Part A (`dd772f8`). Every attempt since then stores its prompt's sections and a fingerprint.

**Tech stack:** TypeScript on Node, Kysely with SQLite, vitest, React. No new dependencies.

## What past attempts can be replayed (measured on 2026-11-21)

A replay uses the stored task text byte for byte, so the inputs are always what they were. Two things are not in a stored manifest:

- **The charter and the output contract as separate texts.** All 695 stored prompts hold exactly one `## Output contract` heading and no repository instructions, so the prompt splits there without guessing.
- **The reference files.** Many tasks tell the role to read a file in `.aiteam-reference/` in its worktree (the whole Tech Design, the Test Plan, the verification commands). Those files were written into the worktree and not kept.

Every pin in a stored task carries its version, so the reference files can be rebuilt from the same document versions. I checked this against a copy of the database, counting an attempt as rebuilt only when every input also came back word for word:

| Role | Attempts | Replayable today | Purposes with none |
|---|---|---|---|
| Engineer | 135 | 129 | |
| Code Reviewer | 108 | 106 | |
| QA Engineer | 61 | 45 | `cr_recommendation` |
| Tech Lead | 44 | 34 | `revise_design` |
| PM | 74 | 29 | most of `cr_recommendation` and `milestone_review` |
| Eng Lead | 39 | 11 | `revise_scope` |

Every role has enough for a trial. Task 1 keeps the reference files with each new attempt, so everything run from then on is replayable. Why some old inputs don't come back word for word is not known yet; Task 4 looks, and widens the count where that is safe.

## Global constraints

- Work only in `/Users/ps/dev/ai-team/.worktrees/knowledge-trials`, branch `knowledge-trials`. A task is green when its tests and `npm run typecheck` pass. The full suite runs alone, at the checkpoint and at the end.
- Every commit names its files with `git add <files>` and ends with the co-author trailer. Never commit `node_modules`.
- Tests never bind ports 4780 or 4781, and never call a real model: the fake Claude in `test/fixtures` plays every worker and judge.
- A replay or a judge changes nothing in a project: no task, attempt, document, inbox item, event or branch that the project's own flow reads. Task 5 has a test that compares all of them before and after.
- A live task always goes before a replay.

## Calls this plan makes

1. **One open draft per role.** It can change the charter, the playbook, and the memory of one project. A second draft waits until the first is committed or discarded.
2. **Three tables:** `drafts`, `trials`, `trial_results`. The spec names two; a draft needs a row of its own to be listed and to carry its state.
3. **A draft's files are plain files** under `~/.aiteam/trials/drafts/<n>/`, in the same format as the committed ones.
4. **The editor refuses an entry over 100 words.** The spec says "about 80".
5. **A trial takes 5 to 7 tasks, at least two that showed the problem and at least two that went fine.**
6. **In a replay, the model and the budgets are today's**, from `role.yaml`, as a live task would get. The tools, write scope, output schema and network list are the stored attempt's, since the stored contract describes them.
7. **A ticket replay is checked against today's project**: its own commands, the protected paths, and the Tech Design's components for missing tests. Both fresh runs get the same checks. The play check in a browser is not run.
8. **Cost blocks a commit only when it is clearly worse**: the draft's total over all tasks is more than half as much again as what it is compared with. Run-to-run noise is larger than any smaller difference.
9. **What the judges read is masked**: an entry id such as `PB-3` or `MEM-7` in an output is replaced, since only one side may have that entry to cite.
10. **When all three results exist, the stored one is shown with its label.** The two fresh runs are the ones compared, and they stay unlabelled. Knowing which is the stored one does not say which of the others is the draft.
11. **The stakeholder's verdict comes from their per-task answers**: an improvement when the draft is better on more problem tasks than it is worse, and worse on no fine task.
12. **The model's and the evaluator's answers stay hidden from the stakeholder until they have answered.**
13. **A trial stops, and can be resumed**, when its spending cap is reached, the login has expired, or the vendor is rate-limited. The default cap is $10.
14. **Undo is a git revert** of the trial's commit, refused if later changes conflict with it.
15. **No component-test setup is added.** Every decision the pages make (what is enabled, what a verdict says, which label is which) sits in pure functions under `web/src/lib/`, tested as the others are. The pages are checked in a browser.
16. **The model judge answers with a probability** (agreed with the stakeholder on 2026-11-22). Each yes/no question is asked several times, three by default, and the probability is the share of runs that said yes. An expectation is met at 0.7 or more and not met at 0.3 or less; between the two it is unsure, and counts as not met.
17. **A local model can judge beside it, and is shown but not counted.** It is set in `config.yaml` (an OpenAI-compatible address such as Ollama's or `llama-server`'s, and a model name) and gives the probability of "yes" from the model's own token probabilities. Without the setting there is no local judge. A failure of it never stops a trial.
18. **The evaluator is asked once.** Its answers are yes or no. Only the model judge is asked several times.
19. **Each judgment is kept beside the stakeholder's answer for the same task**, which is what will show how far each judge can be trusted.

## Tasks

### Task 1: Keep what a replay needs

- The runner saves the reference files it writes into a worktree beside `system.md` and `task.md`, in the attempt's manifest folder.
- `role.yaml` takes an optional `evaluator: <role id>`. A role naming itself is refused. The seed sets the engineer's to `code_reviewer`.
- `config.yaml` takes `trials: { judge_model, judge_runs, cap_usd, local_judge: { url, model } }`, with defaults and no local judge.
- `paths.trials` (`~/.aiteam/trials`), which no worker may read.

### Task 2: The tables

Migration 006 and the store's methods for them.

- `drafts`: role, project (for memory), title, state (`open`, `committed`, `discarded`), what the committed files were when it was last saved.
- `trials`: draft, expectations, tasks with their group, state, the draft and the committed knowledge it ran against, cap and spend, the stakeholder's answers, each judge's verdict, the commits it led to.
- `trial_results`: trial, attempt, which of `stored`, `current`, `draft`, state, output, measured results, usage, fingerprint, each judge's answers, where its transcript and diff are.

### Task 3: Drafts

`src/trials/drafts.ts`, and the API.

- Start a draft for a role; set the charter's text; add, change and remove an entry of the playbook or of one project's memory; discard.
- The engine gives a new entry its id, never one the file's history has used, and writes who added it and the date.
- Refused, with the reason: a charter over 600 tokens, a playbook over its limit, an entry over 100 words, text the file format doesn't allow.
- Reading a draft gives each file's diff against what is committed, and says when the committed file has changed since.
- Live tasks keep reading the committed files. A test runs a ticket while a draft is open.

### Task 4: Which attempts can be replayed

`src/trials/source.ts`.

- From a stored attempt: its prompt's sections (kept, or split at the output contract), its fingerprint (kept, or worked out from the charter and model it had), its reference files (kept, or rebuilt from the pinned versions and accepted only when every input comes back word for word), and whether its starting commit is still in the repo.
- An attempt that can't be replayed says why.
- Listing a role's attempts for the picker: what each was, how it ended, its cost, whether it can be replayed. For the fine tasks, the newest first-pass successes from different projects and purposes come first.
- Find why old inputs fail to come back word for word, and fix what is safe to fix.

### Task 5: One replay

`src/trials/replay.ts`.

- The prompt: the given charter, playbook and memory, then the stored contract and instructions. The task: the stored text.
- A fresh worktree at the attempt's starting commit, on a branch only the trial uses, with the reference files and the project's setup command.
- A prompt over the role's context budget is a failed result, as it would be for a live task.
- Measured: the output fits the schema; for a ticket, its commands pass, something changed, and the tests it had to add are there; cost and turns.
- The output, transcript and diff go under `~/.aiteam/trials/<n>/`. The worktree and branch are removed.
- The test that nothing in the project changed.

### Task 6: A trial's runs

`src/trials/trial.ts`, the scheduler, and the API.

- Starting a trial checks the expectations (one to three), the tasks (call 5, each replayable, and of the draft's project when it changes memory), and that the role's evaluator exists.
- For each task: the stored result is recorded from the attempt. The current knowledge is run only where the stored fingerprint differs from what that task would be given today. The draft is always run.
- The scheduler starts a replay only when a worker is free and no live task is waiting.
- Stop, resume, and what a daemon restart does with a run that was in flight: it runs again.

**Checkpoint, with the stakeholder's OK:** the full suite, then one real trial on the engineer, to see a real replay before the judges are built. It costs about $1 to $3.

### Task 7: The judge and its providers

`src/judge/`, one interface: the material to judge and a set of yes/no questions go in, a probability of yes per question comes out, with the passage that shows it where the provider gives one.

- **Claude through the CLI.** One run answers every question with yes or no and a passage. The provider makes the configured number of runs and gives the share that said yes. Its instructions and answer schema ship in the seed (`trials/judge.md`, `schemas/trial_judgment.json`), so they can be read and changed like a charter. A run that leaves a question out is made again once, then stops the trial.
- **A local model.** One request per question, asking for a single token and its probabilities, from which the probability of "yes" against "no" is taken.
- **In a trial:** one judgment per task per judge. It gets the expectations as questions about each of that task's results, the results under letters in a random order, masked (call 9), each output with its diff where there is one.
- The evaluator is the Claude provider with the evaluating role's own charter and playbook in front, on that role's model, asked once.

### Task 8: The stakeholder's answer and the verdict

- For each task they say which of the two compared results is better, or that there is no difference. The letters are turned back into labels once they have answered every task.
- The verdict: no measured check worse on any task (calls 7 and 8), and each judge that counts calls it an improvement: the model judge and the evaluator by the spec's rule over the expectations met (call 16), the stakeholder by call 11. The local judge's answers are shown and do not count.
- A trial ends `agreed` or `not agreed`, and keeps who said what for each task.

### Task 9: Commit, discard, undo

- Commit needs an agreed trial of the draft as it is now, against the committed files as they are now, and no hand edit waiting in those files.
- It writes the charter and playbook to the knowledge repo and the memory to the project's state repo, each as one commit whose message names the trial and its result.
- Discard drops the draft and keeps its trials.
- Undo reverts that commit.
- A role's list of lessons marks each change to its charter or playbook with the trial it passed, or as not tried.

### Task 10: The web

- The role's page: Edit on the charter and on each entry, Add entry, and the open draft with its diff.
- The trial form: the expectations, the problem tasks picked from the role's past attempts, the fine tasks offered and swappable, the cap.
- The trial page: progress and spend; then the blind comparison, task by task, any two outputs side by side; then every result with its measured checks, each judge's answers and the labels; the limits from the spec, in words; Commit or Discard.
- Notes where they apply: a task that one of the draft's own entries came from, and a task whose stored and current results differ with no draft involved.

### Task 11: Finish

- Full suite and typecheck, alone. The pages checked in a browser against a throwaway daemon.
- One real trial end to end, with the stakeholder's OK.

## After the last task (needs the user)

- Push and PR only when asked.
- At rollout, with the user's OK: copy `roles/engineer/role.yaml`, `trials/judge.md` and `schemas/trial_judgment.json` from the seed into `~/.aiteam/knowledge`, commit them there, and restart the daemon.
