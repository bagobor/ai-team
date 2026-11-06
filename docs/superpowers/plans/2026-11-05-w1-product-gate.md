# W1 Product Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "passing" mean the product works. That takes five things:
- criteria the stakeholder checks;
- a CP4 the stakeholder can try;
- acceptance tests that product tickets can't change;
- criteria whose commands must fail on the base;
- an engine-run browser check before every QA round.

**Architecture:**
- **Criteria.** A criterion gets a second verification method, `human`. QA, the Test Plan and `verify()` skip those criteria. CP4 carries them as checks that the stakeholder marks, and the answer's decision record is their evidence.
- **Protected paths.** The Test Plan names protected paths. The runner adds them to every non-harness ticket's denied paths.
- **Red on base.** QA verification runs the planned commands a second time, at the milestone's merge-base, with the protected files laid over it.
- **The play module.** A new `src/checks/play.ts` drives system Chrome over the DevTools protocol, using Node's global `WebSocket`.
  - The conductor runs a smoke check in a fresh worktree before every QA round.
  - Test Plan entries can carry play scripts, which QA verification runs.
  - A localhost server lets the stakeholder try the CP4 build.

**Tech Stack:**
- TypeScript ESM on Node 25.
- Hono, kysely on SQLite.
- vitest.
- React with Vite in `web/`.
- System Google Chrome in headless mode, over CDP.

**Spec:**
- `docs/superpowers/specs/2026-10-19-ai-team-orchestrator-design.md`. The goals at stake are G8, G6 and G3. CP4 is §9.2, Human Tasks are §9.3, and the Environment Profile is the Discovery section.
- Findings: `docs/superpowers/notes/2026-11-05-flow-review.md`, items PG-1…PG-7, SC-3 and LC-1.
- Roadmap: `docs/superpowers/plans/2026-11-05-flow-fixes-roadmap.md`, W1.

## Global Constraints

- **Dependencies.** Add no new npm dependency. Chrome is driven over CDP with Node's global `WebSocket`. The static server is `node:http`.
- **Code style.**
  - TypeScript ESM with `.ts` import suffixes, as the codebase already writes them.
  - Every comment says why, as the code around it does.
- **Gates.** Every task ends with `npm run typecheck` exiting 0 and `npm test` passing, with no test newly skipped other than the Chrome ones.
- **The database.** A schema change goes in a new migration, `002_inbox_checks`. `001_initial` is never edited, and `src/db/schema.ts` changes in the same task.
- **Seed text.** A seed schema in `seed/knowledge/schemas/*.json` changes in the same task as the code that reads it. So does a charter in `seed/knowledge/roles/*/charter.md`.
- **Chrome and the network.**
  - Chrome is spawned by the engine itself, with its own sandbox on, a fresh temporary profile, and these flags:
    - `--headless=new --remote-debugging-port=0 --no-first-run --no-default-browser-check --disable-extensions --mute-audio --autoplay-policy=no-user-gesture-required`
    - `--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>`
    - `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`
    - `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
  - Every server this plan adds binds only to `127.0.0.1`.
- **Chrome tests.**
  - Tests that launch Chrome sit in `describe.skipIf(!chromePath)`.
  - When `AITEAM_REQUIRE_CHROME=1`, a missing Chrome fails them.
  - Each task that touches play code runs them once with that variable set. In a Claude Code session, run them with the Bash sandbox off, because Chrome can't start inside it.
- **Commits.** Stage with `git add <files>`, never `-a` or `-A`. Each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The try page and the API.** A script on the CP4 try origin, `http://127.0.0.1:4781`, posts to the API on 4780. It must get a 403, and no response may carry `Access-Control-Allow-Origin`. Tested in Task 11.
2. **Chrome missing or failing to start.** The play gate must never pass in silence. It raises a hold that names the path it tried and the `chrome.binary` setting. Tested in Task 9, with a fake player, and in Task 8, with a binary that doesn't exist.
3. **A WebGL game.** A canvas drawn with WebGL that animates must pass the paint and frame checks. That's why paint is judged from a screenshot, not from `getImageData`. Tested in Task 8, with the `webgl` fixture.
4. **A play gate that loops.** A product that never runs must stop at the round cap with a qa_cap hold. Answering that hold with more rounds while the phase is `build` must not throw. That's LC-1, which this plan fixes because the gate raises the hold from `build`. Tested in Task 9.
5. **The product reaching the network.** A page in the play browser that fetches an IP literal must fail with a proxy error and reach nothing. Tested in Task 8, with the `network` fixture.

## Decisions taken (defaults; change any of them before executing)

- **D1. The browser driver.** System Chrome over CDP, with no dependency. Playwright would bring its own Chromium and an install step, and it's a dependency the constraints rule out.
- **D2. Who writes acceptance tests.** QA's harness tickets write them, under `protected` paths. Product tickets can read and run them, but never change them. The protection lasts into later milestones.
- **D3. A failed human check can't be approved.** Approve needs every check marked passing. A failing mark is only allowed with Request changes, and it needs a note.
- **D4. A failed play gate costs a QA round.** Through the existing cap, that stops a loop.
- **D5. The try server listens on `port + 1`.** With the default port that's 4781.
- **D6. Limits on human checks.** At most 3 per Spec, and every Spec keeps at least one automated criterion. The aim is to keep the stakeholder's load low (G6).

## File Structure

| File | Responsibility |
|------|----------------|
| `src/artifacts/acs.ts` | Criterion types, `isHumanCheck`, `Verification` with a stakeholder variant |
| `src/engine/apply/milestone.ts` | Spec validation and the section text for human checks |
| `src/engine/role-inputs.ts` | The Spec view marks human checks |
| `src/engine/apply/design.ts` | Test Plan validation: automated criteria only, `protected`, `regression`, `play` |
| `src/engine/apply/qa.ts` | QA verification: automated only, red on base, play script runs, `bugTicket` for several criteria |
| `src/engine/store.ts` | `recordVerification` guards, inbox `checks` |
| `src/db/migrations.ts`, `src/db/schema.ts` | `002_inbox_checks` |
| `src/engine/inbox.ts` | `InboxCheck`, `CheckMark`, answer validation |
| `src/server/app.ts` | `answerFrom` passes `checks` through |
| `src/engine/conductor/milestone.ts` | CP4 checks, branch and try link; the play gate before QA; the merge guard |
| `src/engine/conductor/answers.ts` | CP4 marks become verifications; decision record sections; the LC-1 fix |
| `src/engine/conductor/try.ts` (new) | The try worktree for each CP4 |
| `src/engine/conductor/play-gate.ts` (new) | Build, serve and smoke-play the integration head |
| `src/engine/protected.ts` (new) | Protected globs, from the Test Plans |
| `src/checks/run-checks.ts` | Violations of protected paths, with their source |
| `src/engine/runner.ts`, `src/manifest/build.ts` | Pass protected paths to the checks and to the ticket manifest |
| `src/checks/cdp.ts` (new) | A minimal CDP client |
| `src/checks/static-server.ts` (new) | Serves a directory, with path containment |
| `src/checks/play.ts` (new) | `Player`, `chromePlayer`, the smoke check, scripts, key table |
| `src/engine/try-server.ts` (new) | One fixed-port server that mounts CP4 builds |
| `src/config.ts` | `chrome.binary` |
| `src/daemon.ts` | Wires `player` and `tryServer` into `EngineDeps` |
| `seed/knowledge/schemas/{milestone_spec,test_plan,environment_profile}.json` | Schema fields |
| `seed/knowledge/roles/{pm,qa_engineer,tech_lead,engineer}/charter.md` | Role guidance |
| `web/src/lib/inbox.ts`, `web/src/pages/Inbox.tsx` | Marking CP4 checks; links in evidence |
| `test/fixtures/play/*/index.html` (new) | Pages for the play tests |

---

### Task 1: A Spec can hold human checks

**Files:**
- Modify: `src/artifacts/acs.ts:4-9`
- Modify: `src/engine/apply/milestone.ts:13` (`criterionSection`) and `:26-40` (`specProblems`)
- Modify: `seed/knowledge/schemas/milestone_spec.json`
  - `criteria[].verification.method` enum.
  - `change_requests[].proposed_verification.method` enum, if it has one.
- Modify: `seed/knowledge/roles/pm/charter.md`
- Test: `test/apply-authoring.test.ts` (`describe('milestone_spec')`, :132)

**Interfaces:**
- Produces:
  - `type VerificationMethod = 'automated' | 'human'`
  - `Criterion = { id: string; text: string; verification: { method: VerificationMethod; how: string } }`
  - `isHumanCheck(c: { verification: { method: string } }): boolean`
  - `MAX_HUMAN_CHECKS = 3`
  - `Verification['verifiedBy'] = { kind: 'qa_verify'; taskId: number } | { kind: 'stakeholder'; inboxId: number }`
  - All of these are exported from `src/artifacts/acs.ts`.

- [ ] **Step 1: Write the failing tests**

  In the `it.each` reject list, change the `'verifies by hand'` case to expect `/automated method or checked by the stakeholder/`. Then add:

```ts
const HUMAN = { id: 'AC-2', text: 'Dodging feels fair', verification: { method: 'human', how: 'Play two minutes; you should never die without seeing the shot coming' } };

it('accepts a human check and says who checks it', async () => {
  const [row] = await publish(e, await apply(e, 'milestone_spec', { ...SPEC, criteria: [CRITERIA[0], HUMAN] }));
  expect(row).toMatchObject({ artifact_id: 'SPEC-M1' });
  const doc = await read('SPEC-M1');
  expect(sectionText(doc.body, 'ac-2')).toContain('Checked by the stakeholder: Play two minutes');
  expect(sectionText(doc.body, 'ac-2')).not.toContain('Verified by');
});

it('rejects a Spec whose criteria are all human checks', async () => {
  const result = await apply(e, 'milestone_spec', { ...SPEC, criteria: [{ ...HUMAN, id: 'AC-1' }] });
  expect(evidenceOf(result)).toMatch(/at least one automated criterion/);
});

it('rejects more than three human checks', async () => {
  const humans = [2, 3, 4, 5].map((k) => ({ ...HUMAN, id: `AC-${k}` }));
  const result = await apply(e, 'milestone_spec', { ...SPEC, criteria: [CRITERIA[0], ...humans] });
  expect(evidenceOf(result)).toMatch(/at most 3 checks/);
});
```

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/apply-authoring.test.ts -t milestone_spec`
  Expected: the three new tests FAIL with "must be verified by an automated method". The changed `it.each` case FAILS on its regex.

- [ ] **Step 3: Implement**
  - In `acs.ts`, add the types above. Rewrite the comment on `Criterion` so it says why a human check exists: some promises, such as feel and look, only a person can judge.
  - In `specProblems`, replace the `!== 'automated'` line with three problems:
    - `` `${id} must be verified by an automated method or checked by the stakeholder` `` for any other method;
    - `` `A Spec needs at least one automated criterion` ``;
    - `` `A Spec can ask the stakeholder for at most ${MAX_HUMAN_CHECKS} checks` ``.
  - `criterionSection` ends with `Checked by the stakeholder: ${how}` for a human check, and with `Verified by: ${how}` otherwise.
  - In the schema, the method enum becomes `["automated", "human"]`, with this description: "automated when a command can show it; human only when a person has to judge it, such as feel, look or sound. The stakeholder checks a human one at milestone approval by doing what `how` says, so write `how` as steps a person follows in under two minutes."
  - In the PM charter, add a "Human checks" paragraph:
    - use one only for what no command can judge;
    - at most 3;
    - `how` is steps and what to look for;
    - every behavior a command can check stays automated.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npx vitest run test/apply-authoring.test.ts && npm run typecheck`
  Expected: PASS, and tsc exits 0. Callers that read `verifiedBy.taskId` without narrowing on `kind` are compile errors, so fix each one: narrow on `kind === 'qa_verify'`.

- [ ] **Step 5: Commit**

```bash
git add src/artifacts/acs.ts src/engine/apply/milestone.ts seed/knowledge/schemas/milestone_spec.json seed/knowledge/roles/pm/charter.md test/apply-authoring.test.ts
git commit -m "feat: let a Spec hold human checks the stakeholder makes"
```

---

### Task 2: QA, the Test Plan and verify() skip human checks

**Files:**
- Modify: `src/engine/apply/design.ts:33-45` (`coverageProblems`) and `:80-90` (`applyTestPlan`)
- Modify: `src/engine/apply/qa.ts:30` (`outputProblems`) and `:190-191`
- Modify: `src/engine/store.ts:366` (`recordVerification`)
- Modify: `src/engine/role-inputs.ts:25-26` (`specView`)
- Modify: `src/engine/conductor/milestone.ts:170-210` (`verify`) and the CP4 `why` at `:240`
- Test: `test/apply-authoring.test.ts` (test_plan, :214), `test/qa-verify.test.ts`, `test/store.test.ts`, `test/role-inputs.test.ts`, `test/conductor.test.ts`

**Interfaces:**
- Consumes: `isHumanCheck` (Task 1).
- Produces: `coverageProblems(acIds: string[], coverage: Coverage[], humanIds: string[]): string[]`. Its signature gains `humanIds`.

- [ ] **Step 1: Write the failing tests**
  - **apply-authoring, test_plan.** Lock a Spec with `[CRITERIA[0], HUMAN]`, where `HUMAN` is AC-2 from Task 1:
    - `it('needs no coverage for a human check')`: a plan covering only AC-1 is accepted.
    - `it('rejects coverage for a human check')`: a plan covering AC-2 gets evidence matching `/AC-2 is checked by the stakeholder/`.
  - **qa-verify.** Lock the Spec with a human AC-2, then add:
    - `it('needs no result for a human check')`: `verify({ results: [pass('AC-1')] })` is accepted, and AC-2 stays `unverified`.
    - `it('rejects a result for a human check')`: evidence matches `/AC-2 is checked by the stakeholder at milestone approval/`.
  - **store.** `it('refuses a QA verification of a human check')`: `recordVerification` with `verifiedBy: { kind: 'qa_verify', taskId }` on a human criterion rejects with `/checked by the stakeholder/`.
  - **role-inputs.** `it('marks a human check in the Spec view')`: the view of a Spec with a human AC-2 contains `AC-2` and `Checked by the stakeholder at milestone approval; QA leaves it alone`.
  - **conductor.**
    - First, add `spec?: unknown` to `Flow` and use `flow.spec ?? SPEC` where the Spec is finished. Declare the same `HUMAN` criterion as in Task 1 at the top of the file; Task 4 reuses it.
    - `it('moves to milestone review when every automated criterion passes')`: with a human AC-2, a QA output covering only AC-1 takes the milestone to `milestone_review`.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/apply-authoring.test.ts test/qa-verify.test.ts test/store.test.ts test/role-inputs.test.ts test/conductor.test.ts`
  Expected: the new tests FAIL. They report missing coverage, a missing result, a verification that went through, a missing marker, and a phase that is still `verify`.

- [ ] **Step 3: Implement**
  - `applyTestPlan` and `applyQaVerify` split the locked criteria with `isHumanCheck`, and validate only the automated ids.
  - In `coverageProblems`, an entry for a human id gives `` `${ac} is checked by the stakeholder, so it has no place in the coverage` ``.
  - In `outputProblems`, a result for a human id gives `` `${ac} is checked by the stakeholder at milestone approval; leave it out` ``.
  - `recordVerification` loads the criterion's `verification` before it updates. A `qa_verify` verifier on a human one throws `` `${acId} is checked by the stakeholder, so QA can't verify it` ``. The stakeholder branch comes in Task 3, so for now an unknown kind throws.
  - `verify()` filters out human checks before both its `every` and its `failing` lists.
  - The CP4 `why` reads `Every automated criterion passed QA.` when the milestone has human checks. Task 4 adds the rest.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npx vitest run test/apply-authoring.test.ts test/qa-verify.test.ts test/store.test.ts test/role-inputs.test.ts test/conductor.test.ts && npm run typecheck`
  Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/apply/design.ts src/engine/apply/qa.ts src/engine/store.ts src/engine/role-inputs.ts src/engine/conductor/milestone.ts test/apply-authoring.test.ts test/qa-verify.test.ts test/store.test.ts test/role-inputs.test.ts test/conductor.test.ts
git commit -m "feat: QA, the Test Plan and verify leave human checks to the stakeholder"
```

---

### Task 3: Inbox items carry checks, and answers mark them

**Files:**
- Modify: `src/db/migrations.ts` (add `'002_inbox_checks'`) and `src/db/schema.ts:130-149`
- Modify: `src/engine/inbox.ts:1-70`
- Modify: `src/engine/store.ts`
  - `raiseInbox`, at :604-605;
  - the row parse, at :123-124;
  - `recordVerification`, for the stakeholder branch.
- Modify: `src/server/app.ts:74-80` (`answerFrom`)
- Test: `test/migrations.test.ts`, `test/inbox.test.ts`, `test/store.test.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: `Verification` with the stakeholder variant (Task 1).
- Produces, from `src/engine/inbox.ts`:
  - `type InboxCheck = { ac: string; text: string; how: string }`
  - `type CheckMark = { ac: string; status: 'passing' | 'failing'; note: string }`
  - `NewInboxItem.checks?: InboxCheck[]`
  - `InboxRow.checks: InboxCheck[]`
  - `InboxAnswer`:
    - `{ action: 'approve' | 'reject'; checks?: CheckMark[] }`
    - `| { action: 'request_changes'; comment: string; checks?: CheckMark[] }`
    - `| { option: string }`
    - `| { text: string }`
  - `assertValidAnswer(item: Pick<InboxRow, 'id' | 'type' | 'options' | 'checks'>, answer: InboxAnswer): void`

- [ ] **Step 1: Write the failing tests**
  - **migrations.** `it('adds inbox checks with an empty default')`: after migrating, an `inbox_items` row inserted without `checks` reads back `'[]'`.
  - **inbox.**
    - Set up: `const item = { id: 7, type: 'approval', options: [], checks: [{ ac: 'AC-2', text: 't', how: 'h' }] }`.
    - Each of these throws `InvalidAnswer`:
      - `{ action: 'approve' }` → `/AC-2 is not marked/`
      - `{ action: 'approve', checks: [{ ac: 'AC-2', status: 'failing', note: 'too fast' }] }` → `/AC-2 is failing/`
      - `{ action: 'request_changes', comment: 'x', checks: [{ ac: 'AC-2', status: 'failing', note: ' ' }] }` → `/needs a note/`
      - a mark for `AC-9` → `/AC-9 is not one of this item's checks/`
      - two marks for AC-2 → `/more than once/`
    - These are accepted:
      - `{ action: 'approve', checks: [{ ac: 'AC-2', status: 'passing', note: '' }] }`
      - `{ action: 'reject' }`
      - `{ action: 'request_changes', comment: 'x' }`
  - **store.**
    - `it('keeps an inbox item's checks')`: raise an item with `checks`; `listInbox` returns them as they went in.
    - `it('takes a stakeholder verification from this milestone's CP4')`: raise a cp4 for milestone 1. `recordVerification(project.id, 1, 'AC-2', { status: 'passing', evidenceRef: 'DEC-1@1#ac-2', verifiedBy: { kind: 'stakeholder', inboxId } })` makes AC-2 `passing` with that evidence.
    - `it('refuses a stakeholder verification from another item')`: an escalation item's id rejects with `/Only this milestone's CP4/`. So does a cp4 of milestone 2.
    - `it('refuses a stakeholder verification of an automated criterion')`: rejects with `/QA verifies/`.
  - **server.** `it('passes check marks through to the answer')`: POST `/api/inbox/:id/answer` with `{ action: 'approve', checks: [{ ac: 'AC-2', status: 'passing', note: '', extra: 1 }] }`. The stored answer equals `{ action: 'approve', checks: [{ ac: 'AC-2', status: 'passing', note: '' }] }`.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/migrations.test.ts test/inbox.test.ts test/store.test.ts test/server.test.ts`
  Expected: FAIL. The column is missing, approve is accepted without marks, and the checks are dropped.

- [ ] **Step 3: Implement**
  - The migration is `ALTER TABLE inbox_items ADD COLUMN checks TEXT NOT NULL DEFAULT '[]'`. In `schema.ts`, the column is `checks: Generated<string>`.
  - `raiseInbox` writes `JSON.stringify(item.checks ?? [])`, and the row parse reads it back.
  - `assertValidAnswer` runs these rules, for approvals only and in this order:
    1. Every mark names one of the item's checks.
    2. No check is marked twice.
    3. A failing mark has a note.
    4. Approve needs every check marked passing.
  - Reject ignores marks.
  - `recordVerification` adds the stakeholder branch, inside its transaction:
    - The item must be `ref.kind === 'cp4'`, with `ref.milestone === milestone` and `project_id === projectId`. Otherwise it throws `` `Only this milestone's CP4 can record the stakeholder's check of ${acId}` ``.
    - The criterion must be human. Otherwise it throws `` `${acId} is automated: QA verifies it` ``.
  - `answerFrom` keeps `checks` only when it's an array. Each entry is mapped to `{ ac, status, note }`, with `String()` applied to each field.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npx vitest run test/migrations.test.ts test/inbox.test.ts test/store.test.ts test/server.test.ts && npm run typecheck`
  Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/schema.ts src/engine/inbox.ts src/engine/store.ts src/server/app.ts test/migrations.test.ts test/inbox.test.ts test/store.test.ts test/server.test.ts
git commit -m "feat: inbox approvals carry checks the stakeholder marks"
```

---

### Task 4: CP4 asks for the checks, names the branch, and gives a checkout to try

**Files:**
- Create: `src/engine/conductor/try.ts`
- Modify: `src/engine/conductor/milestone.ts:211-249` (`afterMilestoneReview`) and `:250-272` (`merging`)
- Modify: `src/engine/conductor/answers.ts:85-101` (`answerCp4`) and `:149-165` (`decisionRecord`)
- Test: `test/conductor.test.ts`

**Interfaces:**
- Consumes: `InboxCheck`, `CheckMark` (Task 3); `isHumanCheck` (Task 1).
- Produces, from `src/engine/conductor/try.ts`:
  - `tryWorktree(deps: EngineDeps, project: ProjectRow, n: number): { worktree: string; branch: string }`. The worktree is `worktreePath(deps.paths, project.name, `M${n}-try`, 1)` and the branch is `aiteam/try/M${n}`.
  - `ensureTryWorktree(deps, project, n, headSha: string): Promise<string>`. It is idempotent: it removes and re-adds when the worktree's HEAD isn't `headSha`.
  - `removeTryWorktree(deps, project, n): Promise<void>`

- [ ] **Step 1: Write the failing tests** (conductor.test.ts, with `flow.spec` holding a human AC-2)
  - `it('asks the stakeholder for each human check at CP4')`:

```ts
const cp4 = await toCp4(h, { spec: { ...SPEC, criteria: [CRITERIA[0], HUMAN] } });
expect(cp4.checks).toEqual([{ ac: 'AC-2', text: HUMAN.text, how: HUMAN.verification.how }]);
expect(cp4.why).toMatch(/Every automated criterion passed QA/);
expect(cp4.why).toMatch(/1 check/);
```

  - `it('names the branch and gives a checkout to try')`:
    - The evidence includes `{ label: 'Branch', value: expect.stringMatching(/^aiteam\/m1 at [0-9a-f]{7}$/) }`.
    - The evidence includes a `'Try it'` entry whose value is the try worktree path.
    - `existsSync(join(tryPath, '.git'))` is true.
    - The worktree's HEAD equals `aiteam/m1`.
  - `it('records approved checks as the stakeholder's evidence')`:
    - Answer `{ action: 'approve', checks: [{ ac: 'AC-2', status: 'passing', note: 'Feels fair' }] }`, then tick.
    - AC-2 is `passing` with `evidence_ref` `` `DEC-${cp4.id}@1#ac-2` ``.
    - `sectionText(decision.body, 'ac-2')` contains `Feels fair`.
    - The phase is `merging`, then `merged`.
  - `it('sends failed checks back with the request')`:
    - Answer `{ action: 'request_changes', comment: 'Mostly fine', checks: [{ ac: 'AC-2', status: 'failing', note: 'Shots come from off-screen' }] }`.
    - AC-2 is `failing`.
    - The `M1-REPLAN-1` task's notes contain `Mostly fine` and `AC-2: Shots come from off-screen`.
    - The phase is `build`.
  - `it('removes the try checkout once the milestone merges')`: after merging, the try path doesn't exist.
  - `it('does not merge while a criterion is unverified')`:
    - Force the phase to `merging` with AC-2 still `unverified`, then tick.
    - The phase is not `merged`.
    - An `engine_error` item names `AC-2`.
    - The base branch didn't move.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/conductor.test.ts -t "CP4|check|try|unverified"`
  Expected: FAIL. `checks` is `[]`, and there's no Branch or Try it evidence.

- [ ] **Step 3: Implement**
  - **`afterMilestoneReview`.**
    - After the base sync, it gets the head from `ensureIntegrationBranch` and calls `ensureTryWorktree`.
    - It builds `checks` from the human criteria.
    - It appends evidence: `Branch` is `` `aiteam/m${n} at ${headSha.slice(0, 7)}` `` and `Try it` is the worktree path. Task 11 replaces `Try it` with a URL for play projects.
    - The `why` adds `` ` Check the ${k} item${k === 1 ? '' : 's'} below yourself before approving.` ``
  - **`answerCp4`** receives the answer's `checks`. Pass them through `effectOf`.
    - Inside `after`, each mark becomes `s.recordVerification(project.id, n, mark.ac, { status: mark.status, evidenceRef: `DEC-${item.id}@1#${mark.ac.toLowerCase()}`, verifiedBy: { kind: 'stakeholder', inboxId: item.id } })`.
    - For request changes, the replan's words are the comment, then `Failed checks:` with one `- AC-n: note` line per failing mark.
    - Reject also calls `removeTryWorktree`.
  - **`decisionRecord`** appends one `## AC-n` section per mark, holding `Passing.` or `Failing.` and then the note. That way the `#ac-n` anchor resolves.
  - **`merging`**
    - It refuses when any criterion isn't `passing` or `waived`, by throwing `` `Milestone ${n} can't merge: ${ids} not verified` ``. The conductor's existing error path raises that as `engine_error`.
    - After the base advances, it calls `removeTryWorktree`.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npx vitest run test/conductor.test.ts && npm run typecheck`
  Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/conductor/try.ts src/engine/conductor/milestone.ts src/engine/conductor/answers.ts test/conductor.test.ts
git commit -m "feat: CP4 asks for human checks and names what to try"
```

---

### Task 5: The Inbox UI marks CP4 checks

**Files:**
- Modify: `web/src/lib/inbox.ts`
- Modify: `web/src/pages/Inbox.tsx`, in `Detail` and `Actions`
- Test: `test/web-lib.test.ts`

**Interfaces:**
- Consumes: `InboxCheck`, `CheckMark` (Task 3), through `InboxItem = InboxRow & …`.
- Produces, from `web/src/lib/inbox.ts`:
  - `type Marks = Record<string, { status?: 'passing' | 'failing'; note: string }>`
  - `checkMarks(checks: InboxCheck[], marks: Marks): CheckMark[]`, which returns only the marked checks, in the order of `checks`.
  - `canApprove(checks: InboxCheck[], marks: Marks): boolean`
  - `failedChecksComment(checks: InboxCheck[], marks: Marks): string`

- [ ] **Step 1: Write the failing tests**

```ts
const checks = [{ ac: 'AC-2', text: 'Dodging feels fair', how: 'Play' }, { ac: 'AC-3', text: 'Sounds right', how: 'Listen' }];
it('approves only when every check is marked passing', () => {
  expect(canApprove(checks, { 'AC-2': { status: 'passing', note: '' } })).toBe(false);
  expect(canApprove(checks, { 'AC-2': { status: 'passing', note: '' }, 'AC-3': { status: 'failing', note: 'quiet' } })).toBe(false);
  expect(canApprove(checks, { 'AC-2': { status: 'passing', note: '' }, 'AC-3': { status: 'passing', note: '' } })).toBe(true);
  expect(canApprove([], {})).toBe(true);
});
it('turns failed checks into the request comment', () => {
  expect(failedChecksComment(checks, { 'AC-3': { status: 'failing', note: 'Too quiet' } })).toBe('Failed checks:\n- AC-3 (Sounds right): Too quiet');
  expect(failedChecksComment(checks, {})).toBe('');
});
it('sends only marked checks', () => {
  expect(checkMarks(checks, { 'AC-3': { status: 'passing', note: '' } })).toEqual([{ ac: 'AC-3', status: 'passing', note: '' }]);
});
```

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/web-lib.test.ts`
  Expected: FAIL, with "canApprove is not exported" or a similar error.

- [ ] **Step 3: Implement**
  - Add the three functions.
  - In `Inbox.tsx`, a `Checks` list renders above `Actions` when `item.checks.length > 0`. Each check shows:
    - its text and `how`;
    - a Passing / Failing pair of radio buttons;
    - a note input, required when Failing.
  - Approve is disabled until `canApprove` holds, with the hint "Mark every check passing to approve".
  - Opening Request changes pre-fills the comment with `failedChecksComment` when it's empty.
  - Both answers send `checks: checkMarks(...)`.

- [ ] **Step 4: Run the tests and check they pass, then look at the page**
  - Run: `npx vitest run test/web-lib.test.ts && npm run typecheck`. Expected: PASS.
  - Then use `preview_start` with `{name: "aiteam-demo"}`.
    - Raise a demo CP4 with one check, using the demo seed's way of raising items. If it has none, add one CP4 with a check to the demo seed in this task.
    - Mark the check failing, open Request changes, and check the comment is pre-filled. Take a screenshot.
    - Mark it passing, and check Approve is enabled. Take a screenshot.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/inbox.ts web/src/pages/Inbox.tsx test/web-lib.test.ts
git commit -m "feat: mark CP4 checks in the Inbox"
```

---

### Task 6: Acceptance tests sit in protected paths

**Files:**
- Create: `src/engine/protected.ts`
- Modify: `seed/knowledge/schemas/test_plan.json`
  - Add the required `protected`.
  - Rewrite the `harness_tickets` description.
- Modify: `src/engine/apply/design.ts:80-90` (`applyTestPlan`) and `testPlanDoc`
- Modify: `src/checks/run-checks.ts`: `ChecksInput`, `scopeViolations` at :51, and the violation evidence
- Modify: `src/engine/runner.ts:375` (`ticketText`), `:63` (`TaskText`) and `:511` (`checkAttempt`)
- Modify: `src/manifest/build.ts:49,73,85`
- Test: `test/apply-authoring.test.ts` (test_plan), `test/checks.test.ts`, `test/runner.test.ts`, `test/manifest.test.ts`, `test/protected.test.ts` (new)

**Interfaces:**
- Produces:
  - `type ProtectedPath = { glob: string; source: string }`, where `source` is a Test Plan id such as `TEST-PLAN-M1`.
  - `protectedPaths(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, milestone: number): Promise<ProtectedPath[]>`. It takes the union over the latest version of `TEST-PLAN-M<k>` for each k ≤ milestone.
  - `isHarnessTicket(ticketId: string): boolean`, which is `/-Q-\d+$/`.
  - `ChecksInput.protectedPaths?: ProtectedPath[]`
  - `TaskText.protectedPaths: string[]`
  - The Test Plan data becomes `{ coverage, protected: string[] }`.

- [ ] **Step 1: Write the failing tests**
  - **apply-authoring, test_plan.**
    - `it('stores the protected globs')`: a plan with `protected: ['acceptance/**']` publishes data with `protected` equal to `['acceptance/**']`.
    - `it.each` reject cases:
      - `protected: ['**']` → `/protected/`
      - `protected: ['.aiteam/x']` → `/protected/`
      - `protected` missing → `/protected/`
  - **protected.test.ts.**
    - `it('protects every earlier milestone's paths too')`: publish plans for M1 (`['acceptance/m1/**']`) and M2 (`['acceptance/m2/**']`). For milestone 2, `protectedPaths` equals both, with their sources. For milestone 1 it's only the first.
    - `it('treats only Q tickets as harness tickets')`: `isHarnessTicket('M1-Q-2')` is true; `'M1-T-2'` and `'M1-B-1'` are false.
  - **checks.test.ts.** `it('fails a change to a protected path and names who protects it')`:
    - The worktree changes `acceptance/ac-1.test.js`, with `protectedPaths: [{ glob: 'acceptance/**', source: 'TEST-PLAN-M1' }]`.
    - The result is `ok: false` and kind `scope_violation`.
    - The evidence contains `acceptance/ac-1.test.js is protected by TEST-PLAN-M1: only QA's harness tickets may change it`.
  - **runner.test.ts.**
    - `it('protects the Test Plan paths from product tickets')`: a `M1-T-1` attempt writing `acceptance/x.js` fails with `scope_violation`.
    - `it('lets a harness ticket write protected paths')`: `M1-Q-1` writing the same file passes its checks.
  - **manifest.test.ts.** `it('lists protected paths in a ticket manifest')`: the rendered task text contains `Protected paths` and `acceptance/**`.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/apply-authoring.test.ts test/protected.test.ts test/checks.test.ts test/runner.test.ts test/manifest.test.ts`
  Expected: FAIL. `protectedPaths` is missing, and the protected write goes through.

- [ ] **Step 3: Implement**
  - **The schema.**
    - `protected` is a required array of strings, with this description: "Globs for the acceptance tests and fixtures your coverage commands run, such as `acceptance/**`. Only your harness tickets may write them. Any other ticket that touches one, in this milestone or a later one, fails its checks. Keep them out of the paths the project's `test` command collects, so a product ticket's definition of done never runs a test for a criterion it hasn't built yet."
    - `harness_tickets` gets this description: "The tickets that write what `protected` names: the acceptance tests your coverage commands run, and any harness or recorded data they need. Never the product itself, and never tests a criterion asks the product to include: the Tech Lead's tickets build those."
  - **`applyTestPlan`** validates each glob with `touchesProblem`, prefixing `protected: `. It stores `protected` in `testPlanDoc`'s data. Existing fixture plans in tests gain `protected: []`.
  - **`runChecks`.** A changed path matching a protected glob is a violation with the evidence line above. It is checked before the role scope, so its message wins.
  - **`checkAttempt`** passes `protectedPaths` for every `ticket` task that isn't `isHarnessTicket`. Bug tickets are protected too.
  - **`ticketText`** adds the globs. The manifest renders: `Protected paths: QA's acceptance tests. Read and run them; never change them:` followed by one `` - `glob` `` line per path.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npm test && npm run typecheck`
  Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/protected.ts seed/knowledge/schemas/test_plan.json src/engine/apply/design.ts src/checks/run-checks.ts src/engine/runner.ts src/manifest/build.ts test/apply-authoring.test.ts test/protected.test.ts test/checks.test.ts test/runner.test.ts test/manifest.test.ts
git commit -m "feat: protect QA's acceptance tests from product tickets"
```

---

### Task 7: A criterion's commands must fail on the base

**Files:**
- Modify: `seed/knowledge/schemas/test_plan.json`, adding an optional `coverage[].regression`
- Modify: `src/engine/apply/design.ts` (the `Coverage` type)
- Modify: `src/git/workspace.ts`, adding `mergeBase` and `overlayPaths`
- Modify: `src/engine/apply/qa.ts`: `verifyAll` at :89, `Verdict`, `reportSection` at :129, and `applyQaVerify`
- Test: `test/qa-verify.test.ts`, `test/workspace.test.ts`, and the fixture plans in `test/conductor.test.ts` and `test/m2-flow.test.ts`

**Interfaces:**
- Consumes: `protectedPaths` (Task 6).
- Produces:
  - `Coverage = { ac: string; commands: string[]; notes: string; regression?: boolean }`
  - `mergeBase(repoPath: string, a: string, b: string): Promise<string>`
  - `overlayPaths(worktree: string, fromSha: string, globs: string[]): Promise<string[]>`, which returns the files it laid over.
  - `Verdict.onBase?: { sha: string; runs: CheckRun[]; red: boolean }`

- [ ] **Step 1: Write the failing tests**
  - In `qa-verify.test.ts`, the `covers` helper gains `regression: true`, so that the existing tests, whose `true` commands pass anywhere, keep testing what they test. New tests use `fresh(ac, ...commands)`, which leaves `regression` out.
  - The same change goes to every fixture Test Plan whose commands pass on any commit: grep `coverage` in `test/`.

```ts
it('rejects a criterion whose commands pass on the base too', async () => {
  await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
  const result = await verify({ results: [pass('AC-1'), pass('AC-2')] });
  expect(evidenceOf(result)).toMatch(/AC-1's Test Plan commands pass on the base too/);
  expect(evidenceOf(result)).toMatch(/Change Request/);
});

it('takes a criterion whose commands fail on the base', async () => {
  // feature.txt exists only on the verified commit, which sits on a branch past the base.
  await start([fresh('AC-1', 'test -f feature.txt'), covers('AC-2', 'true')]);
  const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'feature.txt': 'x' });
  await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head));
  expect(await criterion('AC-1')).toMatchObject({ status: 'passing' });
  expect(await evidence('AC-1')).toMatch(/On the base \([0-9a-f]{7}\), failed as it should/);
});

it('lays the protected files over the base', async () => {
  // The protected test exists only on head; with the overlay, a command that only checks for it passes on base, so it is vacuous.
  await start([fresh('AC-1', 'test -f acceptance/ac-1.sh'), covers('AC-2', 'true')], undefined, 1, { protected: ['acceptance/**'] });
  const head = await commitOnBranch(e.repoPath, 'aiteam/m1', { 'acceptance/ac-1.sh': 'exit 0' });
  expect(evidenceOf(await verify({ results: [pass('AC-1'), pass('AC-2')] }, undefined, head))).toMatch(/pass on the base too/);
});

it('takes a CR on vacuous commands as a dispute', async () => {
  await start([fresh('AC-1', 'true'), covers('AC-2', 'true')]);
  await publish(e, await verify({ results: [pass('AC-1'), pass('AC-2')], change_requests: [disputes('AC-1')] }));
  expect(await criterion('AC-1')).toMatchObject({ status: 'failing' });
  expect(await ids()).not.toContain('BUG-M1-1');
});

it('counts a base where setup fails as red', async () => { /* profile setup `test -f feature.txt`: fails on base, passes on head; AC-1 fresh `true` → passing, report says the base could not be set up */ });
```

  - The new test helpers:
    - `commitOnBranch(repo, branch, files): Promise<string>`, added to `test/helpers/repo.ts`.
    - A third argument to `verify` and `qaCtx`: the `baseSha`.
    - A fourth parameter to `start`: extra Test Plan data.
  - **workspace.test.ts.**
    - `it('finds the merge-base of a branch and the base')`.
    - `it('lays files from another commit over a worktree')`: it returns the paths it laid over, and returns `[]` when no file matches.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/qa-verify.test.ts test/workspace.test.ts`
  Expected: the new tests FAIL. Vacuous commands are accepted, and `mergeBase` is not exported.

- [ ] **Step 3: Implement**
  - **`mergeBase`** wraps `git merge-base a b`.
  - **`overlayPaths`**:
    - lists `git ls-tree -r --name-only fromSha`, filtered by picomatch over the globs;
    - runs `git checkout fromSha -- <files>` when the list isn't empty;
    - returns the list.
  - **In `applyQaVerify`, after `verifyAll` on head:**
    - Compute `base = mergeBase(repo, attempt.base_sha, project.base_branch)`.
    - Open a second fresh worktree, `${ticket_id}-base`, with branch `` `aiteam/verify/${ticket_id}-a${k}-base` ``, at `base`.
    - Lay the protected files from `attempt.base_sha` over it.
    - Run the approved setup, as `verifyAll` does. If it fails, every entry is red, and the report says the base couldn't be set up.
    - Run each criterion's planned commands with `runEach`.
    - `red` is `runs.some(exitCode !== 0)`.
  - **Rule.** A verdict that `held` on head, is not `regression`, and is not `red` on base is vacuous. Handle vacuous verdicts like this:
    - With no CR raised against that criterion's plan commands, the whole output is rejected. The evidence is: `` `${ac}'s Test Plan commands pass on the base too (${sha7}), so they don't show this milestone's work. Raise a Change Request on ${ac}'s Test Plan commands with commands that fail without the work, or mark the entry regression if the criterion is meant to hold already.` ``
    - With such a CR, the verdict takes the existing disputed path: it is `failing`, and no Bug is filed.
  - **`reportSection`** adds one of these lines:
    - `On the base (sha7), failed as it should.`
    - `On the base (sha7), passed too: a regression guard.`
    - `On the base (sha7), passed too, so it shows nothing.`
  - The two worktrees run in sequence, not in parallel, so a QA round costs about twice its command time. Say so in the comment above the base run.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npm test && npm run typecheck`
  Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add seed/knowledge/schemas/test_plan.json src/engine/apply/design.ts src/git/workspace.ts src/engine/apply/qa.ts test/qa-verify.test.ts test/workspace.test.ts test/helpers/repo.ts test/conductor.test.ts test/m2-flow.test.ts
git commit -m "feat: a criterion's Test Plan commands must fail on the base"
```

---

### Task 8: The play module drives Chrome

**Files:**
- Create: `src/checks/cdp.ts`, `src/checks/static-server.ts`, `src/checks/play.ts`
- Create: `test/fixtures/play/{ok,throws,console-error,blank,frozen,missing-script,webgl,network}/index.html`
- Modify: `src/config.ts:20-28,57`, adding `chrome.binary`
- Test: `test/static-server.test.ts`, `test/play.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  - **`src/checks/static-server.ts`**
    - `serveStatic(root: string, opts?: { port?: number; mounts?: boolean }): Promise<StaticServer>`
    - `StaticServer = { url: string; port: number; mount(prefix: string, root: string): void; unmount(prefix: string): void; close(): Promise<void> }`
    - With `mounts: true`, the server serves `/<prefix>/…` from each mounted root, and `root` is unused.
  - **`src/checks/cdp.ts`**
    - `connectCdp(wsUrl: string): Promise<Cdp>`
    - `Cdp = { send<T>(method: string, params?: object, sessionId?: string): Promise<T>; on(event: string, handler: (params: any, sessionId?: string) => void): () => void; close(): void }`
  - **`src/checks/play.ts`**
    - `KEYS: Record<string, { key: string; code: string; keyCode: number }>`, holding `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Space`, `Enter`, `Escape`, `ShiftLeft`, `KeyA`…`KeyZ` and `Digit0`…`Digit9`.
    - `keyProblem(key: string): string | undefined`
    - `type PlayStep = { key: string; hold_ms?: number } | { wait_ms: number } | { eval: string }`
    - `type PlayScript = { steps: PlayStep[]; expect: string }`
    - `scriptProblems(script: PlayScript): string[]`. The limits are at most 50 steps, a total wait of at most 20,000 ms, and a non-blank `expect`.
    - `type PlayProblem = { kind: 'load' | 'exception' | 'console' | 'request' | 'blank' | 'frozen' | 'still' | 'key' | 'expect' | 'timeout' | 'browser'; detail: string }`
    - `type PlayResult = { ok: boolean; problems: PlayProblem[]; durationMs: number; log: string[] }`
    - `type Player = { unavailable(): string | undefined; smoke(url: string, keys: string[]): Promise<PlayResult>; script(url: string, script: PlayScript): Promise<PlayResult> }`
    - `chromePath(config: Config): string | undefined`. It returns `config.chrome.binary`, else `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, but only when that file exists.
    - `chromePlayer(config: Config, opts?: { timeoutMs?: number }): Player`. The default timeout is 20,000 ms per run.
  - **`Config.chrome: { binary: string | null }`**

- [ ] **Step 1: Write the failing tests**
  - **static-server.test.ts:**
    - `it('serves a file with its content type')`: `index.html` comes back as `text/html`, and `game.js` as `text/javascript`.
    - `it('answers 404 for a missing file')`.
    - `it('refuses to leave its root')`: `/../secret.txt` and `/%2e%2e/secret.txt` both get 404.
    - `it('refuses a symlink that points out of its root')`: 404.
    - `it('listens on 127.0.0.1 only')`: `server.url` starts with `http://127.0.0.1:`.
    - `it('serves mounted roots under their prefix')`: after `mount('a', dirA)`, `/a/index.html` is dirA's file. After `unmount('a')`, it's 404.
  - **config.test.ts:**
    - `it('reads chrome.binary')`.
    - `it('rejects an unknown chrome key')` → `/unknown key chrome.path/`.
  - **play.test.ts.** It is wrapped in `const chrome = chromePath(defaultConfig()); describe.skipIf(!chrome && process.env.AITEAM_REQUIRE_CHROME !== '1')(…)`. Each case serves `test/fixtures/play/<name>` with `serveStatic` and runs `player.smoke(url + 'index.html', ['ArrowLeft', 'Space'])`.

| Test | Fixture does | Expect |
|------|--------------|--------|
| `it('passes a page that paints, animates and takes keys')` | 2D canvas starfield on rAF, moves a ship on keys | `ok: true`, `problems: []` |
| `it('catches an exception on load')` | `throw new Error('boom')` in a module | problem `exception` whose detail contains `boom` |
| `it('catches a console error')` | `console.error('bad')` | problem `console` containing `bad` |
| `it('catches a missing script')` | `<script src="missing.js">` | problem `request` containing `missing.js` and `404` |
| `it('catches a canvas that never paints')` | `<canvas>` never drawn, black body | problem `blank` |
| `it('catches frames that do not advance')` | draws once, no rAF | problem `frozen` |
| `it('passes an animating WebGL canvas')` | WebGL clear colour cycling on rAF | `ok: true` |
| `it('keeps the page off the network')` | `fetch('http://1.1.1.1/')`, logs the error message to `document.title` | problem list holds no `request` to 1.1.1.1 that succeeded; `log` contains `ERR_PROXY_CONNECTION_FAILED` |

    Then the script and failure cases:
    - `it('runs a play script and its expectation')`: on `ok`, run `{ steps: [{ key: 'ArrowLeft', hold_ms: 300 }, { wait_ms: 100 }], expect: 'window.ship.x < 100' }`. The result is `ok: true`. With `expect: 'false'`, it has an `expect` problem.
    - `it('says why when Chrome cannot start')`: `chromePlayer({ ...config, chrome: { binary: '/nope' } }).unavailable()` matches `/\/nope/`.
  - The `ok` fixture exposes `window.ship`.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `AITEAM_REQUIRE_CHROME=1 npx vitest run test/static-server.test.ts test/play.test.ts test/config.test.ts`. In Claude Code, run it with the Bash sandbox off.
  Expected: FAIL, because the modules don't exist.

- [ ] **Step 3: Implement**
  - **`serveStatic`**
    - It uses `node:http` on `127.0.0.1` and the given port, which defaults to 0.
    - It decodes the path, resolves it against the root, `realpath`s it, and serves only when the result is inside `realpath(root)`.
    - A directory serves its `index.html`.
    - Content types: html, js, mjs, css, json, png, jpg, gif, svg, wav, mp3, ogg, wasm, and otherwise `application/octet-stream`.
    - It sends `Cache-Control: no-store` and no CORS headers.
  - **`connectCdp`** keeps a message id counter and pending promises keyed by id. It routes events by `method`, and passes `sessionId` along.
  - **`chromePlayer`**, for each run:
    - Spawn Chrome with the flags in Global Constraints and `--user-data-dir=<mkdtemp>`.
    - Read `DevToolsActivePort` from that directory, polling for up to 10 s, to get the browser websocket URL.
    - Call `Target.createBrowserContext`, then `Target.createTarget` in it, then `Target.attachToTarget` with `flatten: true`.
    - Enable `Runtime`, `Log`, `Network` and `Page`.
    - `Page.addScriptToEvaluateOnNewDocument` with a rAF counter on `window.__aiteamFrames`.
    - `Page.navigate`, then wait for `Page.loadEventFired`.
    - Kill Chrome and remove the profile directory in a `finally`.
  - **`smoke`**, after load:
    - It waits 1,000 ms and takes screenshot A.
    - It presses each key, with a keyDown and keyUp 100 ms apart, through `Input.dispatchKeyEvent` using `KEYS`.
    - It waits 1,000 ms and takes screenshot B.
    - It reads the frame counter, then reports these problems:
      - **load**: the document response isn't 200.
      - **exception**: any `Runtime.exceptionThrown`, with its text and url:line.
      - **console**: any `consoleAPICalled` of type `error`, or `Log.entryAdded` at level `error`.
      - **request**: a `127.0.0.1` response of 400 or more, or a failed load.
      - **blank**: screenshot B has fewer than 2 distinct colors after quantizing to 4 bits per channel.
      - **frozen**: the counter advanced by less than 30.
      - **still**: A and B are identical.
      - **key**: an exception thrown while a key was down.
  - **Counting screenshot colors.** Decode the PNG in a second, blank target of the same context: set an `Image` from a `data:` URL, `drawImage` it at 160×90, then `getImageData`. That counts colors without a PNG decoder in Node, and it works for WebGL, because the screenshot is the composited frame.
  - **`script`**
    - It loads the page the same way.
    - It runs the steps: keyDown, then `hold_ms` (default 50), then keyUp; or a wait; or `Runtime.evaluate` of the step's `eval`.
    - It evaluates `expect` with `returnByValue`. Anything but `true` is an `expect` problem.
    - Exceptions are problems here too.
  - **`unavailable()`** returns `` `Chrome was not found at ${path}. Set chrome.binary in ~/.aiteam/config.yaml` `` when nothing exists at that path.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `AITEAM_REQUIRE_CHROME=1 npx vitest run test/static-server.test.ts test/play.test.ts test/config.test.ts && npm run typecheck`, with the Bash sandbox off.
  Expected: PASS, and tsc exits 0. Then run `npm test`, which passes, with the play tests skipped only when Chrome is absent.

- [ ] **Step 5: Commit**

```bash
git add src/checks/cdp.ts src/checks/static-server.ts src/checks/play.ts src/config.ts test/static-server.test.ts test/play.test.ts test/config.test.ts test/fixtures/play
git commit -m "feat: drive system Chrome to smoke-check and script a page"
```

---

### Task 9: Run the play gate before every QA round

**Files:**
- Create: `src/engine/conductor/play-gate.ts`
- Modify: `seed/knowledge/schemas/environment_profile.json`, adding a required, nullable `play`
- Modify: `src/engine/apply/discovery.ts:53-61` (`applyEnvironmentProfile`)
- Modify: `src/engine/runner.ts:27` (`EngineDeps.player?: Player`)
- Modify: `src/daemon.ts`, setting `player: chromePlayer(config)`
- Modify: `src/engine/conductor/milestone.ts`:
  - `HOLD_KINDS` at :13;
  - `build()` at :160-167, the QA-round block.
- Modify: `src/engine/inbox.ts` (`InboxRef`, for `play`)
- Modify: `src/engine/apply/qa.ts`:
  - `bugTicket` at :144, to take `acs: string[]`;
  - export `nextBugNumber`, rewritten over `deps` and `project`.
- Modify: `src/engine/conductor/answers.ts:136-141`, the qa_cap `more` answer (the LC-1 fix)
- Modify: `seed/knowledge/roles/tech_lead/charter.md`
- Create: `test/helpers/play.ts`, with `fakePlayer`, which Task 10 reuses
- Modify: `test/helpers/large-milestone.ts:59` (`publishProfile` gets `play: null`)
- Test: `test/apply-authoring.test.ts` (environment_profile), `test/conductor.test.ts`

**Interfaces:**
- Consumes: `Player`, `serveStatic`, `keyProblem` (Task 8).
- Produces:
  - `type PlayBlock = { root: string; entry: string; keys: string[] }`.
  - `export type ProfileData`, in `src/engine/apply/discovery.ts`. It replaces the private `ProfileOutput` at :14 minus `body` and `stakeholder_note`, and gains `play: PlayBlock | null`. The ad-hoc cast in `runSmoke` (`milestone.ts:76`) switches to it.
  - `fakePlayer(results: PlayResult | PlayResult[], opts?: { unavailable?: string }): Player & { calls: { url: string; body: string }[] }`, in `test/helpers/play.ts`. It fetches each URL it gets, records the body, and returns the results in order, repeating the last one.
  - `type PlayGateResult = { kind: 'skipped' } | { kind: 'passed'; headSha: string } | { kind: 'failed'; headSha: string; problems: PlayProblem[] } | { kind: 'unavailable'; why: string }`
  - `runPlayGate(deps: EngineDeps, project: ProjectRow, n: number): Promise<PlayGateResult>`
  - `buildSite(env: CommandEnv, profile: ProfileData, opts: { setup: boolean }): Promise<{ ok: true; root: string } | { ok: false; why: string }>`. It is exported from `play-gate.ts` for Task 10.
  - `nextBugNumber(deps: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, milestone: number): Promise<number>`
  - `bugTicket(milestone, k, bug: { acs: string[]; title; touches; definition_of_done; techPin; specPin })`

- [ ] **Step 1: Write the failing tests**
  - **apply-authoring, environment_profile.**
    - `it('takes a play block')`.
    - `it.each` rejects:
      - `root: '../x'` → `/play.root/`
      - `entry: 'index.txt'` → `/play.entry/`
      - `keys: ['Fire']` → `/Fire is not a key/`
      - `keys: []` → `/at least one key/`
      - `play` missing → `/play/`
    - Existing fixture profiles gain `play: null`.
  - **conductor.** Harness deps get `player: fakePlayer(result)`, where `fakePlayer` records each URL and fetches it, so a test can see what was served. The flows use a profile with `play: { root: '.', entry: 'index.html', keys: ['Space'] }`, and `mergeTicket` writes `index.html`.
    - `it('runs the play gate before the QA round')`: after the last ticket merges, the fake was called once with a URL ending in `/index.html`, whose body is the merged `index.html`. Then `M1-QA-1` exists.
    - `it('files a Bug when the game does not run')`:
      - The fake returns `{ ok: false, problems: [{ kind: 'exception', detail: 'boom at game.js:3' }] }`.
      - `BUG-M1-1` exists, and its body contains `boom at game.js:3`.
      - The ticket `M1-B-1` has `ac_refs` equal to every automated criterion, and DoD equal to the profile's `test` command.
      - `verify_round` is 1, and there's no `M1-QA-1`.
    - `it('runs the gate again once the Bug is fixed')`: the fake fails once, then passes. After `M1-B-1` merges and a tick, `M1-QA-2` exists.
    - `it('stops at the round cap with a hold')`:
      - The fake always fails, with `verify_cap` at 1.
      - After the first Bug merges, a `qa_cap` item exists whose `why` matches `/doesn't run/`.
      - Answering `more` takes the milestone back to running the gate, and no `engine_error` is raised. That's LC-1.
    - `it('holds when Chrome is unavailable')`:
      - `unavailable()` returns `'Chrome was not found at /nope'`.
      - A `play` hold exists whose `why` contains `/nope`.
      - Answering Retry with a fake that is now available starts QA.
    - `it('skips the gate without a play block')`: with `play: null`, the fake is never called, and QA starts.
    - `it('serves the build output when play.root is dist')`: the profile has `commands.build: 'mkdir -p dist && cp index.html dist/'` and `root: 'dist'`. The fake's fetched body is the copied file.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/apply-authoring.test.ts test/conductor.test.ts -t "play|profile|Bug when|cap|Chrome"`
  Expected: FAIL. `play` is rejected as an unknown field, and QA starts without the gate.

- [ ] **Step 3: Implement**
  - **The schema.**
    - `play` is `{ root, entry, keys } | null`, with this description: "How a person plays the product in a browser. `root` is the directory to serve after the build command runs, such as `.` or `dist`. `entry` is the page under it. `keys` are the keys the game uses, by `KeyboardEvent.code`. Use null only when nothing runs in a browser."
    - The `keys` description lists the names in `KEYS`.
  - **`applyEnvironmentProfile`**
    - `root` is relative, with no `..` segment.
    - `entry` ends in `.html`, with no `..`.
    - Each key passes `keyProblem`, and there is at least one.
  - **`runPlayGate`**
    - With no `play` block, it returns `skipped`.
    - When `deps.player` is missing or `unavailable()`, it returns `unavailable`.
    - Otherwise it opens a worktree `` `M${n}-play` `` at the integration head, as `runSmoke` does, runs `buildSite`, serves `join(worktree, root)`, and calls `player.smoke(url + entry, keys)`.
    - It closes the server and removes the worktree in a `finally`, and logs `play.result` with the problems.
  - **`build()`**, before the QA-round block:
    - `unavailable` raises a `play` hold. It uses `RETRY_OR_HALT`, the title `Milestone ${n}'s game can't be played here`, and `why` set to the reason.
    - `failed` with `verify_round >= verify_cap` raises a `qa_cap` hold. Its `why` reads `` `The game doesn't run: ${first problem}. The milestone has used its ${cap} rounds.` ``
    - `failed` under the cap does this in one transaction:
      - increments `verify_round`;
      - publishes an engine-authored Bug `BUG-M<n>-<k>`, whose body lists every problem;
      - creates the ticket `bugTicket(n, k, { acs: automatedIds, title: 'The game does not run', touches: ['**'], definition_of_done: [commands.test], … })`.
    - Then it returns. The next pass, once that ticket closes, runs the gate again.
    - `passed` and `skipped` continue to the QA round, unchanged.
  - **The LC-1 fix.** The qa_cap `more` answer raises the cap. It calls `setMilestonePhase('build')` only when the phase is `verify`.
  - **`daemon.ts`** sets `player: chromePlayer(config)`.
  - **The Tech Lead charter** says: set `play` for anything that runs in a browser, and list every key the game reads.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npm test && npm run typecheck`
  Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/conductor/play-gate.ts seed/knowledge/schemas/environment_profile.json src/engine/apply/discovery.ts src/engine/runner.ts src/daemon.ts src/engine/conductor/milestone.ts src/engine/inbox.ts src/engine/apply/qa.ts src/engine/conductor/answers.ts seed/knowledge/roles/tech_lead/charter.md test/helpers/play.ts test/helpers/large-milestone.ts test/apply-authoring.test.ts test/conductor.test.ts
git commit -m "feat: play the built product before every QA round"
```

---

### Task 10: Test Plan entries can carry play scripts

**Files:**
- Modify: `seed/knowledge/schemas/test_plan.json`, adding an optional `coverage[].play`
- Modify: `src/engine/apply/design.ts`, in `coverageProblems` and `Coverage`
- Modify: `src/engine/apply/qa.ts` (`verifyAll`, and the base run from Task 7)
- Modify: `seed/knowledge/roles/qa_engineer/charter.md`
- Test: `test/apply-authoring.test.ts` (test_plan), `test/qa-verify.test.ts`

**Interfaces:**
- Consumes: `PlayScript`, `scriptProblems`, `Player` (Task 8); `buildSite` (Task 9); `Verdict.onBase` (Task 7).
- Produces: `Coverage.play?: PlayScript`. A play run is recorded as `CheckRun { command: `play: ${n} steps, expect ${expect}`, exitCode: ok ? 0 : 1, timedOut, durationMs, outputTail }`, where `outputTail` holds the problems and the log.

- [ ] **Step 1: Write the failing tests**
  - **apply-authoring, test_plan.** The profile has a play block.
    - `it('accepts an entry with only a play script')`: `commands: []` with `play` is accepted.
    - Rejects:
      - a play script with the profile's `play: null` → `/no play block/`;
      - the key `Fire` → `/Fire is not a key/`;
      - 51 steps → `/at most 50 steps/`;
      - `commands: []` without `play` → `/at least one command or a play script/`.
  - **qa-verify.** Engine deps get `player: fakePlayer(...)`, which records its calls.
    - `it('records a play script as a run of its criterion')`:
      - AC-1 is `fresh` with a play script, the head commit has `index.html`, and the fake passes on head and fails on base.
      - AC-1 is `passing`.
      - The evidence contains `play: 1 steps, expect window.ok`.
      - The fake saw two calls: head, then base.
    - `it('fails a criterion whose play script fails')`:
      - The fake returns `{ ok: false, problems: [{ kind: 'expect', detail: 'window.ok was false' }] }` on head.
      - AC-1 is `failing`.
      - `BUG-M1-1`'s body contains `window.ok was false`.
    - `it('rejects a play script that passes on the base too')`: the fake passes both times, and the evidence matches `/pass on the base too/`.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/apply-authoring.test.ts test/qa-verify.test.ts -t play`
  Expected: FAIL, because `play` is an unknown property.

- [ ] **Step 3: Implement**
  - **The schema.** `play` is `{ steps: [ {key, hold_ms?} | {wait_ms} | {eval} ], expect: string }`, with this description: "A short run of the real page, for a criterion only a browser can show: what to press and wait for, then a JavaScript expression that must be true. Read state the game exposes, never the DOM text alone."
  - **`coverageProblems`** gets `hasPlay: boolean` and runs `scriptProblems`.
  - **`verifyAll`.** When any planned entry has `play`:
    - run `buildSite(env, profile, { setup: false })` once, since setup has already run;
    - serve the site;
    - run `deps.player.script(url + entry, script)` for each entry, after its commands;
    - append the `CheckRun`.
  - **The base run does the same.** A site that won't build on the base counts as a red play run.
  - **A missing or unavailable player** rejects the output with the `unavailable()` reason. That way QA isn't billed for a Bug.
  - **The QA charter.** One section:
    - the acceptance tests go under `protected` paths, out of what `test` collects;
    - the commands run them by exact path, never through an npm script the product owns;
    - commands must fail without the work, or the entry is marked `regression`;
    - prefer a play script for anything a person sees or does in the browser.

- [ ] **Step 4: Run the tests and check they pass**

  Run: `npm test && npm run typecheck`
  Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add seed/knowledge/schemas/test_plan.json src/engine/apply/design.ts src/engine/apply/qa.ts seed/knowledge/roles/qa_engineer/charter.md test/apply-authoring.test.ts test/qa-verify.test.ts
git commit -m "feat: verify browser criteria by playing the page"
```

---

### Task 11: CP4 gives a link to play the build

**Files:**
- Create: `src/engine/try-server.ts`
- Modify: `src/engine/runner.ts:27`, adding `EngineDeps.tryServer?: TryServer`
- Modify: `src/daemon.ts`, which starts `TryServer` on `config.port + 1` and closes it on shutdown
- Modify: `src/engine/conductor/milestone.ts`:
  - `afterMilestoneReview`, for the `Try it` URL;
  - a new `cp4` phase step that remounts after a restart.
- Modify: `src/engine/conductor/try.ts`, which unmounts in `removeTryWorktree`
- Modify: `web/src/pages/Inbox.tsx` (`Detail`), so that evidence values starting with `http://127.0.0.1:` render as links with `target="_blank" rel="noopener"`
- Test: `test/try-server.test.ts`, `test/conductor.test.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes:
  - `serveStatic` with `mounts` (Task 8);
  - `buildSite` (Task 9);
  - `ensureTryWorktree` and `removeTryWorktree` (Task 4).
- Produces:
  - `class TryServer`, with `static start(port: number): Promise<TryServer>`, `mount(project: string, n: number, root: string): string` (returns the URL of the entry's directory), `unmount(project: string, n: number): void` and `close(): Promise<void>`.
  - The URL is `` `http://127.0.0.1:${port}/${project}/m${n}/` ``.

- [ ] **Step 1: Write the failing tests**
  - **try-server.test.ts:**
    - `it('serves a mounted build under its project and milestone')`.
    - `it('stops serving it once unmounted')`, which gets a 404.
    - `it('listens on 127.0.0.1 only')`.
  - **server.test.ts.** The test for Review Focus 1:
    - `it('refuses an answer posted from the try origin')`: POST `/api/inbox/1/answer` with `Origin: http://127.0.0.1:4781` and a JSON body gets 403.
    - `it('sends no CORS header to the try origin')`: GET `/api/inbox` with that Origin gets a response with no `access-control-allow-origin` header.
  - **conductor.** The harness gets `tryServer: await TryServer.start(0)`, and the flow has a profile with a play block.
    - `it('links the playable build at CP4')`:
      - the `Try it` evidence is `` `${tryServer.url}${project.name}/m1/index.html` ``;
      - fetching it returns the merged `index.html`.
    - `it('serves the CP4 build again after a restart')`:
      - unmount by hand, which is what a restart leaves;
      - tick in phase `cp4`;
      - the URL serves again.
    - `it('stops serving once the milestone merges')`: after merging, it gets a 404.
    - Without a play block, `Try it` stays the worktree path, as in Task 4.

- [ ] **Step 2: Run the tests and check they fail**

  Run: `npx vitest run test/try-server.test.ts test/server.test.ts test/conductor.test.ts -t "try|Try|origin|CORS"`
  Expected: the try-server and conductor tests FAIL, because the module doesn't exist. The server tests may already pass, because `guard` refuses other origins. If they do, keep them as the regression pins Review Focus asks for, and record that they passed before the implementation.

- [ ] **Step 3: Implement**
  - **`afterMilestoneReview`**, for play projects:
    - run `buildSite` in the try worktree, with setup;
    - call `deps.tryServer.mount`;
    - use the URL plus `entry` as `Try it`.
  - **A build failure doesn't block CP4.** `Try it` instead says `` `The build failed here: ${why}. The checkout is at ${worktree}.` ``
  - **The `cp4` phase step** remounts when `tryServer` has no mount for that milestone. Mounting is idempotent, so a daemon restart heals on the next tick.
  - **`removeTryWorktree`** unmounts first.

- [ ] **Step 4: Run the tests and check they pass, then look at the page**
  - Run: `npm test && npm run typecheck`. Expected: PASS.
  - In the demo preview, open a CP4 with a `Try it` link, and screenshot the Inbox showing it as a link.

- [ ] **Step 5: Commit**

```bash
git add src/engine/try-server.ts src/engine/runner.ts src/daemon.ts src/engine/conductor/milestone.ts src/engine/conductor/try.ts web/src/pages/Inbox.tsx test/try-server.test.ts test/conductor.test.ts test/server.test.ts
git commit -m "feat: CP4 links a playable build of the milestone"
```

---

### Task 12: Role guidance and the run-11 acceptance

**Files:**
- Modify: `seed/knowledge/roles/engineer/charter.md`
- Modify: `seed/knowledge/roles/tech_lead/charter.md`, for product tickets
- Create: `docs/superpowers/notes/2026-11-05-run-11-acceptance.md`
- Modify: `docs/superpowers/plans/2026-11-05-flow-fixes-roadmap.md`, marking W1 done with links to the commits
- Test: `test/seed-sync.test.ts`, `test/role.test.ts`. Both are existing tests, and both must stay green.

**Interfaces:**
- Consumes: everything above. Nothing new is produced.

- [ ] **Step 1: Write the charters**
  - **Engineer.** Protected paths are QA's acceptance tests: you read them and run them, and you never change them. If one is wrong, raise a Change Request against the Test Plan, with the failing output as evidence.
  - **Tech Lead.**
    - Product tickets never write the acceptance tests.
    - Their definition of done runs the project's `test` command, which doesn't collect `protected` paths.
    - A ticket whose touches would overlap a protected path is a design mistake.

- [ ] **Step 2: Run the seed tests**

  Run: `npx vitest run test/seed-sync.test.ts test/role.test.ts`
  Expected: PASS.

- [ ] **Step 3: Write the run-11 acceptance notes**
  - **The brief.** A small browser game: "a one-screen asteroid dodger: arrow keys move, the game speeds up, a score and a best score, sound on hits". It should take one milestone of about 3 tickets, with Discovery set to one milestone.
  - **The checklist, each item with how to observe it:**
    1. The Spec has 1 to 3 human checks and at least one automated criterion. Look in Documents, at SPEC-M1.
    2. The Environment Profile has a `play` block. Look at ENV-PROFILE.
    3. The Test Plan names `protected` paths, and its Q-tickets write the acceptance tests. Look at TEST-PLAN-M1 and the M1-Q tickets.
    4. Every product ticket's manifest lists the protected paths. Check with `sqlite3 -readonly` over the `attempts.manifest` of the M1-T attempts.
    5. A `play.result` event comes before every QA task. Check the events.
    6. The QA report has an "On the base" line for every automated criterion. Look at QA-REPORT-M1-n.
    7. A hand-filed ticket that breaks the render is caught by the play gate before QA. Through `POST /api/projects/:id/tickets`, file one during `build` that makes `main.js` throw; a `BUG-M1-k` follows from the engine, not QA.
    8. CP4 shows the checks, `Branch aiteam/m1 at <sha7>`, and a `Try it` link that loads the game in a browser.
    9. The stakeholder marks the checks in the UI. The criteria show `DEC-<id>@1#ac-n` evidence.
    10. The run's cost is in the cost views.
  - Record the cost for each phase against STARLANCE's split, which was planning 40%, build plus review 46%, and QA 10%.
  - **Before the run:** `syncSeed` never overwrites a file that exists, so copy every seed schema and charter this plan changed into `~/.aiteam/knowledge` and commit them there by hand. Restart the daemon on 4780, so it runs the new code and starts the try server.

- [ ] **Step 4: Mark W1 in the roadmap**

  In the W1 section, add `Status: implemented (commits <first7>..<last7>); run 11 pending`.

- [ ] **Step 5: Commit**

```bash
git add seed/knowledge/roles/engineer/charter.md seed/knowledge/roles/tech_lead/charter.md docs/superpowers/notes/2026-11-05-run-11-acceptance.md docs/superpowers/plans/2026-11-05-flow-fixes-roadmap.md
git commit -m "docs: role guidance for protected tests, and the run-11 acceptance"
```

---

## Risks this plan leaves open

- **A grep of new product code still passes red on base (PG-2, in part).** It fails on the base because the code isn't there yet, then passes on head. The engine doesn't reject grep commands: there's no sound rule for it. What W1 adds is the play script, a better tool for a browser criterion, and the QA charter that steers to it. Run 11's checklist item 6 shows whether QA uses it.
- **Nobody but QA reads the Test Plan (PG-7, in part).** W1 replaces trust with engine checks: red on base runs every command against the base, and protected paths stop product tickets from editing what the commands run. A second reader of the coverage is still missing. W3 gives the code reviewer the criteria and their commands; a review of the Test Plan itself belongs there too.
- **Hollow tests in new modules (PG-5) can still pass.** That's the case when a protected acceptance test passes on the base for a reason unrelated to the work. Red on base catches only tests that pass without the work, not tests that are weak. The backstop is in W3, where the code reviewer gets the criteria and the Test Plan commands.
- **The "still" check can fail a game that shows a static title screen and ignores the configured keys.** The Tech Lead's `keys` should include the start key. If run 11 shows false failures, the check becomes a warning in the Bug body rather than a failure.
- **Chrome updates can change headless behavior.** Task 8's fixture tests are the canary. Run them with `AITEAM_REQUIRE_CHROME=1` before each real run.
- **The base run roughly doubles QA command time.** Setup runs twice, which costs more for projects with heavy installs. W4's budgets can cap it.
