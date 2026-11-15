# Part A: Playbook and memory reach every task — Implementation Plan

**Goal:** Every task is given its role's playbook and the project's memory, within the budgets `role.yaml` already sets. Each attempt records which entries it was given. The Roles page shows the entries in place of the two fixed "Empty" panels.

**Spec:** `docs/superpowers/specs/2026-11-15-playbook-memory-trials-design.md`, Part A. Calls 1 and 2 apply. Parts B, C and D each get their own plan.

**Architecture:**
- **Entries.** A pure module, `src/knowledge/entries.ts`, parses a playbook or memory file into entries and renders the two prompt sections.
- **Loading.** `loadRole` also returns the role's playbook. A new `loadMemory` reads a project's two memory files from its state repo.
- **Manifest.** `buildManifest` puts both sections in the system prompt between the charter and the output contract, counts them, names every entry given, and records the prompt's sections and a fingerprint.
- **Showing.** A role's provenance carries its playbook entries with the commit behind each; a new endpoint gives a role's memory for one project. The Roles page draws both.

**Tech stack:** TypeScript on Node, vitest, React. No new dependencies.

## Global constraints

- Work only in `/Users/ps/dev/ai-team/.worktrees/playbook-memory-read`, branch `playbook-memory-read`. A task is green when its tests and `npm run typecheck` pass; the full suite runs once at the end, alone.
- Every commit names its files with `git add <files>`, and ends with the co-author trailer. Never commit `node_modules`.
- Tests never bind ports 4780 or 4781.
- With no playbook file and no memory files, a task's system prompt is byte for byte what it is today.
- Nothing in this part writes a playbook or a memory file. Tests write their own.

## File format (both files)

```markdown
# Engineer playbook

## PB-1
Added by: the stakeholder
Added: 2026-11-15
Sources: DEC-119@1, M1-T-4 attempt 2

Pass file patterns to `node --test`, never folder names.
```

- An optional `# title` line first. Nothing else before the first entry.
- An entry starts at `## PB-n` in a playbook and `## MEM-n` in memory.
- Field lines follow the heading with no blank line between: `Added by` and `Added` (a date, `YYYY-MM-DD`) are required, `Sources` is optional and comma-separated. Memory also requires `Kind`: `feedback`, `lesson` or `structure`. A playbook entry has no `Kind`.
- After one blank line, the text. It is not empty, and no line of it starts with `#`.
- An id appears once in a file.

## Calls this plan makes

1. **A file with a problem stops the task.** A playbook or memory file that doesn't parse, or a playbook over its limit, escalates the task with the problem named, as an oversize charter does today. A task never gets part of a file a person wrote wrongly.
2. **A missing file is an empty one.** No seed playbooks ship in this part.
3. **Memory ids are unique across a project.** `memory/project.md` and `memory/roles/<id>.md` share one run of `MEM-n`. A task whose two files share an id is stopped.
4. **A playbook's size is the size of what the worker gets**: its rendered section, without the provenance lines.
5. **No word limit when reading.** The budget is the cap here; the 80-word rule belongs to the editor in Part B.
6. **Memory that doesn't fit is skipped entry by entry**, in reading order, and a later smaller entry may still fit. The manifest's memory part lists what was left out.
7. **The manifest keeps the prompt's five sections as text**, beside the whole prompt. It costs a few kilobytes per attempt and lets Part C rebuild a prompt without guessing where the charter ends.
8. **The commit behind an entry is the newest commit that touched any of its lines.** An entry with a line no commit has seen shows as not committed.

## Tasks

### Task 0: Docs, and the Tech Lead's budget in the seed

- Commit the spec, the note in the 2026-11-12 design, and this plan.
- `seed/knowledge/roles/tech_lead/role.yaml`: `context_tokens: 12000` becomes `20000`.
- Test: the existing role and budget tests stay green.

### Task 1: Entries

Files: `src/knowledge/entries.ts`, `test/entries.test.ts`.

- `parseEntries(text, 'PB' | 'MEM')` returns `{ entries, problems }`. An entry is `{ id, kind, addedBy, added, sources, text, line }`.
- `playbookSection(entries)` and `memorySection({ project, role }, budgetTokens)`, the second returning `{ text, given, omitted }`.
- Tests: a file with a title and two entries parses; each rule in "File format" has a test that names its problem; an empty file has no entries and no problems; the memory section orders project before role, and `feedback`, `lesson`, `structure` within each, newest first; an entry that doesn't fit is left out and a later smaller one is kept; no entries gives an empty section.

### Task 2: Loading

Files: `src/roles/role.ts`, `src/knowledge/memory.ts`, `test/role.test.ts`, `test/memory.test.ts`.

- `loadRole` returns `playbook`. It throws on a problem and on a section over `playbook_tokens`.
- `loadMemory(stateDir, roleId)` returns `{ project, role }`. It throws on a problem in either file and on an id both files use.
- Tests: no file gives no entries; a playbook loads; a bad one and an oversize one are refused by name; memory loads from both files; a shared id is refused.

### Task 3: The manifest and the runner

Files: `src/manifest/build.ts`, `src/engine/runner.ts`, `test/manifest.test.ts`, `test/runner.test.ts`.

- `BuildInput` gains `playbook` and `memory`. The system prompt is the charter, the playbook section, the memory section, the output contract, then the repository instructions.
- The `playbook` and `memory` parts carry real tokens and one source per entry given (`roles/<id>/playbook.md#PB-1`, `memory/project.md#MEM-3`). The memory part gains `omitted`.
- Both parts count in `totalTokens`, and in what is left for a retry's evidence.
- `TaskManifest` gains `sections` and `fingerprint` (SHA-256 of the charter, the playbook section, the memory section and the model).
- The runner loads memory with the rest of a task's work and passes both in.
- Tests: with neither, the prompt is unchanged; with both, the sections sit in order and the parts name their entries; a playbook can push a task over its context budget; the fingerprint changes with each of its four inputs and with nothing else; a ticket run through the runner with a playbook in the knowledge repo and memory in the state repo has both in `system.md`; a broken playbook escalates the task.

### Task 4: Provenance and the API

Files: `src/roles/provenance.ts`, `src/server/app.ts`, `test/provenance.test.ts`, `test/server.test.ts`.

- `RoleProvenance.playbook`: the entries, each with its commit, the section's tokens, and the file's problems. `RoleSummary.playbookTokens`.
- A change to `playbook.md` is listed among a role's lessons with the kind `playbook`.
- `GET /api/roles/:id/memory/:project`: both files' entries with their commits from the state repo, what a task would be given and what would be left out, and any problems. 404 for an unknown role or project.
- Tests: an entry is credited to the commit that last changed it; an uncommitted entry has none; a file with a problem is shown with it, not refused; the endpoint returns both files and the fit.

### Task 5: The Roles page

Files: `web/src/pages/Roles.tsx`, `web/src/lib/roles.ts`, `web/src/api.ts`, `web/src/styles.css`, `test/web-lib.test.ts`.

- The roster's last column shows the playbook's size against its budget.
- A role's page shows its playbook entries, and its memory for a project chosen from a list, each entry with its text, who added it and when, its sources and its commit. Problems are shown above the entries. An empty file says what would fill it.
- Tests for the wording helpers in `web-lib.test.ts`. The page itself is checked in a browser.

## After the last task (needs the user)

- Full suite and typecheck, alone. Changed files, verification and risks reported.
- Push and PR only when asked. After a merge, restart the daemon; no seed copy is needed apart from the Tech Lead's budget, which the installed file already has.
