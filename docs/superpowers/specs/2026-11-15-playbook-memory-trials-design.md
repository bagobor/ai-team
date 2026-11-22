# Playbooks, project memory, and trials for changes to what a role knows

Date: 2026-11-15. Engine: `/Users/ps/dev/ai-team` at `85b15b5` (main, pushed).

This replaces Part 4 (Memory) of `2026-11-12-must-support-context-designers-memory-design.md` and moves it ahead of that design's Parts 2 and 3. It also brings forward a small part of the original design's knowledge system (`2026-10-19-ai-team-orchestrator-design.md`, section 8): the role playbook and the replay of past tasks.

## Why

- Every role's playbook and project memory are empty. The manifest builder gives both parts 0 tokens and no sources (`src/manifest/build.ts:179-180`), and the Roles page shows a fixed "Empty" for each (`web/src/pages/Roles.tsx`). Nothing a role learns reaches its next task except through the documents it is handed.
- A change to a charter today goes live the moment the file is saved, with nothing to show whether it helped. The knowledge repo at `~/.aiteam/knowledge` holds edits to five charters and several schemas that were never committed.
- The stakeholder's idea, which this design builds: "why the observed agent behavior doesn't meet the expectation - its memory, prompt, playbook is reviewed and updated, and then the agent is performing the 5-7 of their past assignments and their results are compared with their prev results. and if the desired improvement is achieved - the update could be committed."

The engine already keeps what a replay needs. Each attempt stores its full prompt, the commit it started from, its output, its outcome and its cost (`attempts.manifest`, `base_sha`, `output`, `state`, `failure_kind`, `usage`). The four real projects hold 463 attempts across six roles. A spot check of one starting commit per project found each still in its repo.

## The stakeholder's answers (2026-11-15)

- On what a trial compares with: "compare with the stored results. And if the stored results were obtained with an older agent memory and playbook, we should re-run it and then do a 3 way comparison: stored, and re-runs."
- On who judges: "model, role evaluator (if set), a human, all these should agree on the improvements."
- On the build order below: "yes".

## Goals

- Every task is given its role's playbook and the project's memory, within the budgets `role.yaml` already sets, and each attempt records exactly which entries it was given.
- The stakeholder can read every entry, see who added it and from what, and edit it.
- A change to a charter, a playbook or memory can be tried on past assignments before it goes live, and is committed only when a model, the role's evaluator if it has one, and the stakeholder all say it is an improvement.
- Every commit to a charter or playbook says which trial it passed, or is shown as not tried.

## Non-goals

- Choosing entries by tag, relevance or score. A task gets the whole playbook and the memory that fits.
- A Reflector role, counters per entry, automatic promotion from memory to a playbook, expiry and consolidation (section 8.3, 8.4 and 8.6 of the original design). Playbook entries are written by a person.
- A saved set of tasks per role that every later trial reuses. Each trial picks its own tasks.
- Trying a change of model or adapter. A trial changes what a role knows, and nothing else.
- Showing memory on the project front page. That page is Part 2 of the 2026-11-12 design. Until it exists, memory is shown on the Roles page.

## Anti-goals (failure even if it works)

- A replay that changes a project: merges a branch, publishes a document, raises an inbox item, moves a task or a milestone.
- A draft that reaches a live task before it is committed.
- A commit recorded as passing a trial when one of the three judges did not agree, or when a check that can be measured got worse.
- A judge that knows which output came from the draft.
- A playbook or memory file that only the engine can read. A person opens the file and reads it as it is.

## Build order

The stakeholder agreed this order. Each part merges to main on its own, with the suite green.

1. **Reading** (Part A): playbook and memory files reach every task and are shown on the Roles page.
2. **Trials** (Parts B and C): drafts, replays, judging, commit or discard.
3. **Roles write their own memory** (Part D).

Two things come before Part A:

- The current state of `~/.aiteam/knowledge` is committed, with the stakeholder's OK, so that "commit when it passes" starts from a known point.
- The Tech Lead's `context_tokens` in the seed moves from 12000 to the 20000 the stakeholder already set by hand, since Part A adds up to 3000 tokens to every task.

---

## Part A: What a role is given

### Three layers

| Layer | Says | Scope | File | Limit |
|---|---|---|---|---|
| Charter | Who the role is and the rules it works by | The role, in every project | `roles/<id>/charter.md` in the knowledge repo (exists) | 600 tokens (`CHARTER_TOKEN_LIMIT`) |
| Playbook | How to do this role's work well: procedures, pitfalls, tool tips | The role, in every project | `roles/<id>/playbook.md` in the knowledge repo (new) | `playbook_tokens`, 2000 today |
| Memory | Facts about one project | One project | `memory/project.md` and `memory/roles/<id>.md` in the project's state repo (new; `memory/` is already reserved, `src/git/merge.ts:11`) | `memory_tokens`, 1000 today |

A lesson goes in the narrowest layer that covers it: the role's memory for this project, then the project memory, and the playbook only when it holds in any project.

### File format

Both new files are markdown. Each entry is a section:

- a heading with a stable id: `PB-n` in a playbook, `MEM-n` in memory. An id is never given to a second entry.
- for memory, its kind: `feedback`, `lesson` or `structure`, as in the 2026-11-12 design.
- who added it and when, and links to what it came from.
- the text, at most about 80 words. An entry is a rule or a fact, not an essay.

Git is the history of every entry. *(My call: one format for both files, so one parser and one editor serve both.)*

### Reading

- The manifest's `playbook` part is the whole playbook. A playbook over its limit is refused where it is edited, as a charter over 600 tokens is today, so a task never gets part of one.
- The manifest's `memory` part is the project memory, then this role's memory, whole entries only, newest first within each kind. The manifest records the ids that did not fit.
- Both parts count in the task's total against `context_tokens`. Today they don't.
- The manifest stores the charter, playbook, memory and output contract as separate parts, and a fingerprint: a hash of the charter, the playbook, the memory entries given, and the model. Part C needs both.

### Showing it

On the role's page (`/roles/:id`), the two fixed "Empty" panels become the playbook, and the memory for a chosen project. Each entry shows its text, who added it, and the commit behind it, the way the charter's lines do today.

---

## Part B: Drafts

- Every entry, and the charter, has an Edit action on the role's page. An edit is saved as a **draft**: a named set of changed files for one role, kept under `~/.aiteam/trials/`, outside the knowledge repo and the state repos. Live tasks keep reading the committed files.
- A draft can change the charter, the playbook, and the memory of one project, together.
- The page shows a draft as a diff against the committed files.
- A draft whose committed files changed underneath it says so, and cannot be committed until it is tried again.
- The files can still be edited by hand in the repos, as today. The Roles page already shows such a change as "Not committed yet", and a commit made by hand is shown as not tried.

---

## Part C: Trials

A **trial** runs one draft on past assignments of its role and reports whether the role did better.

### What the stakeholder gives a trial

- **Expectations**: one to three questions that say what was expected and not seen, each answerable from a task's output. Example: "Does the plan say how the game is played on a phone?"
- **Tasks**: 5 to 7 past attempts of the role.
  - **Problem tasks**, three or four: ones that showed the behaviour. The stakeholder picks them.
  - **Fine tasks**, three: ones that went well, which must not get worse. The engine offers the most recent first-pass successes from different projects and purposes; the stakeholder can swap any.
  - A draft that changes memory is tried on tasks of that project only.

### What is compared

For each task there are up to three results:

- **Stored**: the output the attempt produced at the time. Nothing is run.
- **Current**: a fresh run with the committed charter, playbook and memory.
- **Draft**: a fresh run with the draft.

The stakeholder's rule decides whether **current** is run. If the stored attempt's fingerprint equals what the committed knowledge would give that task today, the stored result stands in for it, and the trial compares stored with draft. If it differs, current is run and the trial shows all three.

- An attempt from before Part A has no fingerprint. Its playbook and memory were empty, its charter is the start of its stored prompt, and its model is in its stored manifest; the fingerprint is worked out from those.
- *(My call: the model is part of the fingerprint. A stored result from another model is no more comparable than one from an older playbook.)*

### How a replay runs

- The prompt is the draft's (or the committed) charter, playbook and memory, followed by the output contract the attempt had. The task text is the stored one, byte for byte, with the inputs as they were then.
- It runs in a fresh worktree at the attempt's `base_sha`, on a branch only the trial uses, with the role's usual tools and sandbox.
- Its output, transcript and check results go to the trial's records. The project's tasks, documents, inbox and branches are not touched.
- Replays take a worker only when no live task is waiting for one.
- A trial has a spending cap, and stops when it is reached.

### Scoring

**Measured, for every result:**

- the output parses against the schema the attempt was given;
- for an engineer's ticket, the ticket's own check commands pass, the worker changed something, and the tests it had to add are there;
- estimated cost and turns.

**Judged, against the expectations, by three judges:**

1. **A model.** It gets the expectations and a task's results, unlabelled and in a random order. For each result and each expectation it answers yes or no, with the passage that shows it.
2. **The role's evaluator, if set.** `role.yaml` gains an optional `evaluator: <role id>`. That role, with its own charter and playbook, reads the same unlabelled results and answers in the same form. A role cannot be its own evaluator. *(My call: the seed sets the engineer's evaluator to `code_reviewer` and leaves the others unset.)*
3. **The stakeholder.** They see the same results side by side, unlabelled, with the measured checks, and say for each task whether one result is better. The labels are shown once they have answered. *(My call: unlabelled for the stakeholder too, so all three judge the work and not the label.)*

### When a draft may be committed

A judge calls the draft an **improvement** when, by its answers:

- on the problem tasks, the draft meets more of the expectations than what it is compared with, and
- on no fine task does it meet fewer.

What the draft is compared with is current where current was run, and stored where it was not.

The draft may be committed only when:

- no measured check is worse for the draft on any task, and
- the model, the evaluator if set, and the stakeholder each call it an improvement.

There is no override. A trial where they disagree ends as "not agreed", and shows per task who said what. The draft stays, to be edited and tried again.

### Commit, discard, undo

- **Commit** writes the draft's files into the knowledge repo and the state repo and commits them. The commit message names the trial and its result.
- **Discard** drops the draft. The trial's record stays.
- **Undo** is a git revert of that commit, offered on the role's page.

### What the trial page shows

- The expectations, and one row per task with its results side by side: measured checks, each judge's answers, cost.
- Any output opened next to another.
- A task marked when one of the draft's entries names it as a source: the trial shows the lesson works where it was learnt, not that it works elsewhere.
- When stored and current differ though the draft is not involved: a note that the role's results on this task vary from run to run, or have changed since it was stored.

### Limits to state on the page

- One stored result against one new run is one sample each. With 5 to 7 tasks, only a clear difference means something; a single task flipping can be chance.
- A replay checks the output's form and, for tickets, its commands. The engine's fuller checks of a document depend on the project's state at the time and are not re-run.

### Cost

An attempt has averaged $0.11 to $0.43 by role, as estimated. Seven draft runs cost about $1 to $3. The same again when current is run. The model judge and the evaluator each read every task once, at about a reviewer's cost per task ($0.17 on average).

### Records

Two tables: one row per trial (role, draft, expectations, state, cost, the commit it led to), and one per result (task, which of the three, output, measured checks, each judge's answers). Outputs and transcripts are kept under `~/.aiteam/trials/<n>/`.

---

## Part D: Roles write their own memory

Part 4 of the 2026-11-12 design stands for how entries are added, their provenance, and removal by the stakeholder:

- a role adds up to three entries per attempt to its own memory, and may suggest entries for the project memory;
- the PM reviews them after tasks complete, in one review at a time;
- the engine records the stakeholder's own words as `feedback` entries.

With these changes:

- The files and the format are Part A's.
- What a role, the PM or the engine adds this way goes live at once, without a trial. *(My call: these entries are small, belong to one project, name their source, and can be removed. Asking for a trial of each would stop memory being written at all. A trial is how a person's edit is checked, and how a doubtful entry can be checked later.)*
- Memory is shown on the Roles page until the project front page exists.

---

## Calls I made (for the stakeholder to check)

1. One markdown format for playbooks and memory.
2. A task gets the whole playbook; an oversize playbook is refused when edited, never cut when read.
3. The model is part of what decides whether a stored result is still comparable.
4. The engineer's evaluator is the code reviewer; no other role has one until the stakeholder sets it.
5. The stakeholder judges unlabelled results, like the other two judges.
6. A measured check getting worse blocks a commit, whatever the judges say.
7. No override when the judges disagree.
8. Entries that roles, the PM and the engine add to memory go live without a trial.
9. Hand edits in the repos stay possible, and are shown as not tried.

## Left to the builder

- The exact layout of an entry in the markdown files, and the id counters.
- How a stored prompt from before Part A is split into its charter and its output contract.
- The prompt and model of the model judge, and the evaluator's output schema.
- Where drafts and trial files sit under `~/.aiteam/trials/`, and the two tables' columns.
- The default spending cap of a trial.
- How many of a trial's replays run at once.
- Test strategy, within the project's existing rule that tests never bind ports 4780 or 4781.
