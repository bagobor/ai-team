# Part 1: The Must-Support List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The brief's "top" requirements become a list the stakeholder confirms: where the game runs, how it's played and how it's built. Every prototype and milestone is built against that list and checked by the engine. Each item ends up met or waived by the stakeholder, or the stakeholder is told plainly that it isn't met.

**Architecture:**
- **The list.** A new artifact, `MUST-SUPPORT`, is written by the PM from the brief and confirmed at a new inbox gate. The gate sits before prototyping or discovery, and before the next milestone of a project that has no list yet.
- **Item logic.** A pure module, `src/engine/must-support.ts`, holds the item rules, the rendering and the status logic.
- **Play check.** The play check learns phone and tablet viewports, touch gestures and a fits-the-screen test.
- **Statuses.** A new table, `must_support_status`, records one status per item per prototype and per milestone. The prototype tickets, the milestone play gate, CP4 and the merge guard all read it.
- **Gaps.** A role that can't meet an item says so in a `gaps` output field. The engine then asks the stakeholder.

**Tech Stack:** TypeScript on Node, Kysely with SQLite, vitest, and the Chrome DevTools Protocol through the existing `src/checks/play.ts`. The web app is React.

**Spec:** `docs/superpowers/specs/2026-11-12-must-support-context-designers-memory-design.md`
- Part 1 is lines 74–160.
- "Switching over" starts at line 305, "Calls" at 318, and "Left to the builder" at 341.
- Calls 1–4 and 15–17 apply to this part.

## Global Constraints

**Where and how to work**
- Work only in `/Users/ps/dev/ai-team/.worktrees/part1-must-support`, and run every command from there. A task is green when `npm test` and `npm run typecheck` both pass.
- Add no new dependencies.
- Tests never bind ports 4780 or 4781. Use `freePort` from `test/helpers/engine.ts`.

**What an item is**
- Items are **not** acceptance criteria. Never write them to `acceptance_criteria`, and never count them against the cap of 3 human checks.
- Item ids have the form `MS-n` and are stable. A removed id is never reused.

**Viewports**

| Viewport | Size | Touch | Mobile |
|---|---|---|---|
| `desktop` | 1280×800 | no | no |
| `phone_portrait` | 390×844 | yes | yes |
| `phone_landscape` | 844×390 | yes | yes |
| `tablet` | 820×1180 | yes | no |

A list with no play items gets exactly today's single desktop smoke, with no viewport override.

**Exact copy**

| Use | Text |
|---|---|
| Status labels | `Met`, `Failing`, `Not measured`, `Waived` |
| Confirm item title | `Confirm what the game must run on and how it's played` |
| Revision title | `Confirm the change to what the game must run on` |
| Proposed item | `Not in your brief: suggested because <reason>` |
| CP4 first line | `This build does not meet: <item texts joined by "; ">.` |
| CP4 toggle | `Approve without: <item text>` |
| Command item on prototypes | `Not checked on prototypes` |

**Writing for people and roles**
- Human-facing text says what is being asked, in plain words, and pins every artifact it mentions as evidence.
- Role charters stay at most 600 tokens; the QA charter stays at most 2100 characters. Text for one purpose goes in that purpose's work-order instructions, never in `role.yaml`.

**Rollout and git**
- Seed files reach `~/.aiteam/knowledge` only through a copy at rollout, with the user's OK. `syncSeed` adds missing files only.
- Stage files with `git add <files>`, never `-A`. Never commit `node_modules` or `prototypes/`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A brief that says nothing about platforms.** The PM proposes items; each shows `Not in your brief: suggested because …` on the confirm item; nothing is built until the stakeholder confirms. Test: Task 3, `shows a proposed item as not in the brief`.
2. **A revision removes an item that still has status rows.** Statuses, CP4 and the merge guard ignore the removed id. Tests: Task 1 `gives every current item a status and ignores removed ones`; Task 11 `a removed item's rows do not hold up the merge`.
3. **The engine restarts mid-gate.** Replaying a tick raises one confirm item and one gap item, never a second PM task. Tests: Task 3 `raises the confirm item once`; Task 7 `replaying the output raises the gap once`.
4. **A page fits after load and overflows after a tap.** It fails `fits_screen` with "after the gestures". Test: Task 4, `a page that grows after a tap fails fits after the gestures`.
5. **Malformed CP4 answers.** Any of these raises `InvalidAnswer` and records nothing:
   - a failing item left out of `waive`;
   - `waive` on any item that isn't a CP4 approval;
   - an unknown id in `waive`.

   Tests: Task 11, `assertValidAnswer` waive cases.

## Calls this plan makes

The design leaves these to the builder. Each one is marked *(my call)* where it is used.

1. **Every id ever used is stored with the list.** `MUST-SUPPORT`'s `fields.data` holds `used`: every id in every version so far. That is how "never reused" is checked without reading old versions.
2. **Only one list governs at a time.** Publishing a version supersedes the earlier ones (`store.ts:307`). So the list in force is the newest version with `approved_by` set. If the stakeholder rejects a revision, the engine republishes the list in force as the next version, approved by the same approver.
3. **Rejecting the first list halts the project**, as a CP1 reject does.
4. **A change goes through a gap, not a change request.** A role that can't meet an item raises a gap, and change requests against `MUST-SUPPORT` are dropped with a pointer to `gaps`. When the stakeholder answers a gap with "Change the requirement", the PM revises the list and the stakeholder confirms it at the confirm item. This differs from the design's "existing CR flow" wording; the result is the same, with the stakeholder deciding each change.
5. **What counts as answering touch.** A phone or tablet run fails touch when no page handler for touch, pointer, mouse or click ran during the gestures. On a page that isn't animated, it also fails when the page looks the same afterwards. On animated pages only the handler test applies, because the screen changes anyway.
6. **Touch runs press no keys.** Keys are pressed only in runs without touch, so a touch-only game isn't failed for ignoring a keyboard a phone doesn't have.
7. **Phone emulation uses device scale factor 1.** The layout in CSS pixels is the same, and the screenshots stay small.
8. **Gaps are checked in every applier that ends in `withRaised`**, but only these schemas offer the field: `prototype_plan`, `environment_profile`, `milestone_spec`, `tech_design`, `ticket_scope`, `test_plan`, `qa_verify` and `eng_review`. Engineers' change reports don't get it.
9. **The scope of a gap:**
   - a `PROTO-PLAN-r` task: prototype round `r`;
   - a task in milestone ≥ 1: that milestone;
   - any other milestone-0 task: milestone 1.

   For a prototype round, the first option reads "Accept it for this round". A written answer to a gap is treated as "change", with the stakeholder's words as the PM's comment.
10. **A prototype ticket fails only on failing play items.** With no play items it is played no more than today. With no browser, its play items are recorded `Not measured` and the ticket isn't failed.
11. **After a "change" answer, the round goes on with its existing plan.** Its tickets carry the newest approved list, so new items reach the engineers. The plan isn't redone.
12. **Adding command checks to an approved profile.** `MS-CHECKS-TL` publishes the next `ENV-PROFILE` version, approved under the previous version's approver. Adding checks to an approved profile is mechanical; the stakeholder approved the items themselves.
13. **How the milestone roles see statuses.** QA and the eng review get the engine's statuses in their work-order instructions. The milestone review gets an engine-written `## Must support` section appended to its body.
14. **A play gate that comes up short** (the game runs, but items fail) works like a failed one:
    - while rounds remain, it files a Bug and spends a round;
    - once rounds are spent, the milestone goes on to QA, and CP4 leads with what isn't met.
15. **Waivers at CP4.**
    - A `Not measured` play or command item at CP4 is waivable, like a failing one.
    - A human item becomes an `MS-n` check.
    - An `MS-n` check marked failing must be waived to approve.
16. **Human items on the fun evaluation are shown, not marked.** The fun evaluation lists each one as `Not measured: check it yourself as you play`. It doesn't add a check, because its checks are a fun or not-fun verdict per prototype. A human item first becomes a check to mark at CP4.
17. **Every ticket pins the list,** not only those that touch input handling or layout. The engine can't tell which tickets touch those, and an extra pin costs little.

## File Structure

**New files**

| File | What it holds |
|---|---|
| `src/engine/must-support.ts` | Pure: item types, rules, rendering, play runs, statuses, the spec section and CP4 lines. |
| `src/engine/apply/must-support.ts` | `applyMustSupport` and `applyMustSupportChecks`. |
| `src/engine/apply/gaps.ts` | Validates gaps, gives a gap its scope and raises the gap item. |
| `src/engine/conductor/must-support.ts` | The confirm gate: `approvedMustSupport`, `mustSupportItems`, `advanceMustSupport`, and the answers to the confirm and gap items. |
| `src/engine/conductor/must-support-play.ts` | `playMustSupport`: one smoke per viewport, mapped to item statuses. |
| `seed/knowledge/schemas/must_support.json`, `seed/knowledge/schemas/must_support_checks.json` | The output schemas for the two new purposes. |
| `test/fixtures/play/touch-ok/index.html`, `touch-ignored/index.html`, `overflow/index.html`, `overflow-after-gesture/index.html` | Play fixtures for the touch and fits checks. |
| `test/must-support.test.ts`, `test/apply-must-support.test.ts`, `test/must-support-gate.test.ts`, `test/must-support-play.test.ts`, `test/must-support-gaps.test.ts`, `test/must-support-checks.test.ts`, `test/must-support-milestone.test.ts` | Tests. |

**Changed files:** each task lists its own.

---

### Task 1: The must-support module, artifact type and id

**Files:**
- Create: `src/engine/must-support.ts`
- Modify: `src/artifacts/format.ts:4-25` (add `'must_support'` to `ARTIFACT_TYPES`)
- Modify: `src/engine/apply/ids.ts` (add `export const MUST_SUPPORT = 'MUST-SUPPORT'`)
- Test: `test/must-support.test.ts`, `test/artifact-format.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (all from `src/engine/must-support.ts`):

```ts
export type Viewport = 'desktop' | 'phone_portrait' | 'phone_landscape' | 'tablet';
export type MsInput = 'keys' | 'touch' | 'mouse';
export type MsItem = {
  id: string; group: 'runs_on' | 'built_with'; text: string; brief_quote: string;
  check: 'play' | 'command' | 'human';
  viewport?: Viewport; input?: MsInput | null; fits_screen?: boolean; // play items
  how?: string;                                                       // human items
  proposed?: boolean; reason?: string;
};
export type MustSupportData = { items: MsItem[]; used: string[] };     // used: (my call 1)
export type MsStatus = 'met' | 'failing' | 'not_measured' | 'waived';
export type ItemStatus = { item_id: string; status: MsStatus; evidence: string };
export type ViewportSpec = { width: number; height: number; mobile: boolean; touch: boolean };
export const VIEWPORTS: Record<Viewport, ViewportSpec>;          // values from Global Constraints
export const VIEWPORT_LABEL: Record<Viewport, string>;
export const STATUS_LABEL: Record<MsStatus, string>;             // Met, Failing, Not measured, Waived
export type MsPrior = { current: string[]; used: string[] };
export function mustSupportProblems(items: MsItem[], prior: MsPrior): string[];
export function nextUsed(prior: MsPrior, items: MsItem[]): string[];   // sorted by number, no duplicates
export function renderMustSupport(items: MsItem[]): string;
export function itemLine(item: MsItem): string;                        // `${id} ${oneLine(text)}`
export type PlayRun = { viewport: Viewport; touch: boolean; fitsScreen: boolean; items: MsItem[] };
export function playRuns(items: MsItem[]): PlayRun[];
export function gateStatuses(items: MsItem[], rows: ItemStatus[], forGood: ItemStatus[]): ItemStatus[];
```

`VIEWPORT_LABEL` values:

| Viewport | Label |
|---|---|
| `desktop` | `Desktop browser` |
| `phone_portrait` | `Phone browser, held upright` |
| `phone_landscape` | `Phone browser, held sideways` |
| `tablet` | `Tablet browser` |

`mustSupportProblems` returns one line per problem, sent back to the PM verbatim:

| Rule | Message |
|---|---|
| no items | `The list is empty: name at least what the brief says the game runs on` |
| id not `MS-<n>` | `<id> is not an id like MS-1` |
| repeated id | `<id> is listed more than once` |
| id not in `current`, and not above every id in `used` | `<id> is new, so its id must be above MS-<max>, the highest used so far` |
| blank text | `<id> has no text` |
| not proposed, blank quote | `<id> quotes nothing from the brief: quote it, or mark it proposed and say why` |
| proposed, blank reason | `<id> is proposed and needs a reason` |
| play item in `built_with` | `<id> is checked by play, which only a runs_on item can be` |
| play item, no viewport | `<id> is checked by play and needs a viewport` |
| play item, `input` undefined | `<id> is checked by play and needs an input: keys, touch, mouse or null` |
| human item, blank how | `<id> is checked by you and needs a how` |

`renderMustSupport` puts the `runs_on` items under `## Where it runs and how it's played` and the `built_with` items under `## How it's built`, so section pins read `MUST-SUPPORT@v#ms-1`. A group with no items is left out. Each item is:

```
### MS-1

<text>

From your brief: “<brief_quote>”        ← or: Not in your brief: suggested because <reason>
Checked by the engine: <VIEWPORT_LABEL>[, played by touch|the keyboard|the mouse][, fitting the screen].
                                         ← command: Checked by a command the Tech Lead writes.
                                         ← human:   Checked by you: <how>
```

The play runs and statuses work like this:
- **`playRuns`** makes one run per distinct viewport among the play items, in the order desktop, phone_portrait, phone_landscape, tablet.
  - `touch` is true when any item in the run has input `touch`.
  - `fitsScreen` is true when any item in the run has `fits_screen`.
  - With no play items it returns `[{ viewport: 'desktop', touch: false, fitsScreen: false, items: [] }]`.
- **`gateStatuses`** returns one status per item in `items`, in list order. For each item:
  - a `met` row gives `met`;
  - otherwise, a `forGood` row with status `waived` gives `waived`;
  - otherwise the item takes its row's status;
  - with no row at all, it is `not_measured` with evidence `''`.

  Rows for ids that aren't in `items` are ignored.

- [ ] **Step 1: Write the failing tests** in `test/must-support.test.ts`. Use a `phone` play item (MS-1: runs_on, phone_portrait, touch, fits_screen), a `cmd` command item (MS-2, built_with) and a `you` human item (MS-3, `how: 'Play it on your phone'`).

```ts
it('refuses an empty list', () => {
  expect(mustSupportProblems([], { current: [], used: [] })).toEqual(['The list is empty: name at least what the brief says the game runs on']);
});
it('keeps a current id and refuses a removed one coming back', () => {
  expect(mustSupportProblems([phone], { current: ['MS-1'], used: ['MS-1', 'MS-2'] })).toEqual([]);
  expect(mustSupportProblems([phone, cmd], { current: ['MS-1'], used: ['MS-1', 'MS-2'] }))
    .toContain('MS-2 is new, so its id must be above MS-2, the highest used so far');
});
it('needs a viewport and an input on a play item, and a how on a human one', () => {
  const p = mustSupportProblems([{ ...phone, viewport: undefined, input: undefined }, { ...you, how: ' ' }], { current: [], used: [] });
  expect(p).toEqual(expect.arrayContaining(['MS-1 is checked by play and needs a viewport', 'MS-1 is checked by play and needs an input: keys, touch, mouse or null', 'MS-3 is checked by you and needs a how']));
});
it('needs a brief quote unless the item is proposed with a reason', () => {
  expect(mustSupportProblems([{ ...phone, brief_quote: '' }], { current: [], used: [] })).toContain('MS-1 quotes nothing from the brief: quote it, or mark it proposed and say why');
  expect(mustSupportProblems([{ ...phone, brief_quote: '', proposed: true, reason: 'players hold phones upright' }], { current: [], used: [] })).toEqual([]);
});
it('renders each item under its group as an MS-n section', () => {
  const body = renderMustSupport([phone, cmd, { ...you, proposed: true, brief_quote: '', reason: 'touch feel needs a person' }]);
  expect(body).toContain("## Where it runs and how it's played");
  expect(body).toContain('### MS-1');
  expect(body).toContain('Checked by the engine: Phone browser, held upright, played by touch, fitting the screen.');
  expect(body).toContain('Not in your brief: suggested because touch feel needs a person');
  expect(body.indexOf("## How it's built")).toBeGreaterThan(body.indexOf('### MS-1'));
});
it('plans one desktop run when no item is played', () => {
  expect(playRuns([cmd, you])).toEqual([{ viewport: 'desktop', touch: false, fitsScreen: false, items: [] }]);
});
it('plans one run per viewport in a fixed order', () => {
  const desk = { ...phone, id: 'MS-4', viewport: 'desktop', input: 'keys', fits_screen: false } as MsItem;
  const runs = playRuns([phone, desk]);
  expect(runs.map((r) => [r.viewport, r.touch, r.fitsScreen])).toEqual([['desktop', false, false], ['phone_portrait', true, true]]);
});
it('gives every current item a status and ignores removed ones', () => {
  expect(gateStatuses([phone, cmd], [{ item_id: 'MS-1', status: 'met', evidence: 'x' }, { item_id: 'MS-9', status: 'failing', evidence: 'y' }], []))
    .toEqual([{ item_id: 'MS-1', status: 'met', evidence: 'x' }, { item_id: 'MS-2', status: 'not_measured', evidence: '' }]);
});
it('a waiver for good stands unless the milestone met the item', () => {
  const forGood = [{ item_id: 'MS-1', status: 'waived' as const, evidence: 'DEC-12@1' }];
  expect(gateStatuses([phone], [{ item_id: 'MS-1', status: 'failing', evidence: 'f' }], forGood)[0]!.status).toBe('waived');
  expect(gateStatuses([phone], [{ item_id: 'MS-1', status: 'met', evidence: 'm' }], forGood)[0]!.status).toBe('met');
});
```

In `test/artifact-format.test.ts`, add `expect(ARTIFACT_TYPES).toContain('must_support')`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/must-support.test.ts test/artifact-format.test.ts`
Expected: FAIL, because `../src/engine/must-support.ts` can't be resolved and `must_support` isn't in `ARTIFACT_TYPES`.

- [ ] **Step 3: Implement the module, the type and the id** as the Interfaces block says. Use `oneLine` from `src/engine/apply/text.ts` in `itemLine`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/must-support.test.ts test/artifact-format.test.ts && npm run typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/engine/must-support.ts src/artifacts/format.ts src/engine/apply/ids.ts test/must-support.test.ts test/artifact-format.test.ts
git commit -m "feat(must-support): item rules, rendering, play runs and statuses"
```

---

### Task 2: The PM's `must_support` purpose

**Files:**
- Create: `seed/knowledge/schemas/must_support.json`, `src/engine/apply/must-support.ts`
- Modify: `src/engine/workorder.ts` (add `'must_support'` to `Purpose`), `src/engine/apply/index.ts` (`APPLIERS.must_support`), `src/engine/conductor/tasks.ts` (`mustSupportTask`), `src/engine/runner.ts` (`VIEWS.must_support`, using the view `discovery` uses for the PM), `seed/knowledge/roles/pm/role.yaml`
- Test: `test/apply-must-support.test.ts`

**Interfaces:**
- Consumes: from Task 1, `MsItem`, `MustSupportData`, `mustSupportProblems`, `nextUsed`, `renderMustSupport` and `MUST_SUPPORT`.
- Produces:
  - `export const applyMustSupport: Applier` in `src/engine/apply/must-support.ts`;
  - `export function mustSupportTask(project: ProjectRow, k: number, inputs: string[], comment?: string): TaskSpec` in `tasks.ts`.

**What to build:**
- **Schema.** `must_support.json` is an object with required `items` (array, `minItems: 1`) and `stakeholder_note` (string), and `additionalProperties: false`. Each item has:
  - required: `id`, `group` (enum), `text`, `brief_quote` and `check` (enum);
  - optional: `viewport` (enum), `input` (enum `keys|touch|mouse` or null), `fits_screen`, `how`, `proposed` and `reason`.
- **PM role.** `role.yaml` gets `must_support` added to `produces`, and `output_schemas.must_support: schemas/must_support.json`.
- **Applier.** `applyMustSupport` works in the same `ApplyCtx` shape as `applyPrototypePlan`.
  1. It reads `prior` from the latest `MUST-SUPPORT`, of any status: `current` is that version's item ids, and `used` is its `data.used`. With no earlier version, both are `[]`.
  2. When `mustSupportProblems` finds problems, it returns `{ ok: false, evidence: problems.join('\n') }`.
  3. Otherwise it ends through `withRaised` with one publish:
     - `{ id: MUST_SUPPORT, type: 'must_support', status: 'proposed', ownerRole: 'pm' }`;
     - `derivedFrom`: the task's input pins;
     - `fields: { data: { items, used: nextUsed(prior, items) } }`;
     - `body`: `# What the game must run on and how it's played\n\n` followed by `renderMustSupport(items)`.
- **Task builder.** `mustSupportTask` builds the task for ticket `roundId('MUST-SUPPORT-PM', k)`: role `pm`, purpose `must_support`, milestone 0, with `workOrder` and base `BASE`, as `discoveryTask` does.
  - The instructions are this exact copy:

    > List what this game must run on and how it is played (group runs_on), and what the brief says about how it must be built (group built_with). Quote the brief's own words in brief_quote for every item it states. If the brief says nothing about where the game runs, propose what a game like this needs: set proposed to true and give the reason. The stakeholder confirms every item. Check an item by play when a browser can show it: name the viewport (desktop, phone_portrait, phone_landscape or tablet), the input (keys, touch, mouse, or null for none) and whether it must fit the screen. Check it by command when a shell command can prove it, and by human when only the stakeholder can judge it, saying how. Keep the ids of the items you keep, and give a new item the next id above every id used before.

  - With a comment, it adds `\n\nThe stakeholder asked for changes: <comment>`.

- [ ] **Step 1: Write the failing tests** in `test/apply-must-support.test.ts`. Use the engine helpers (`makeProjectEngine`) and call the applier the way `test/apply-prototype.test.ts` calls `applyPrototypePlan`.

```ts
it('publishes the list as a proposed MUST-SUPPORT owned by the PM', async () => {
  // output: { items: [phone, cmd], stakeholder_note: '' }
  const row = await artifacts.latest(project.id, 'MUST-SUPPORT');
  expect(row).toMatchObject({ status: 'proposed', owner_role: 'pm', version: 1 });
  const doc = await artifacts.read(project, 'MUST-SUPPORT@1');
  expect(doc.fields.data).toEqual({ items: [phone, cmd], used: ['MS-1', 'MS-2'] });
  expect(doc.body).toContain('### MS-1');
});
it('sends back a list with problems', async () => {
  expect(await apply({ items: [], stakeholder_note: '' })).toMatchObject({ ok: false, evidence: expect.stringContaining('The list is empty') });
});
it('keeps every id ever used', async () => {
  // v1 [MS-1, MS-2]; v2 [MS-1, MS-3] → used ['MS-1','MS-2','MS-3']; v3 [MS-1, MS-2] → refused
  expect((await artifacts.read(project, 'MUST-SUPPORT@2')).fields.data.used).toEqual(['MS-1', 'MS-2', 'MS-3']);
  expect(await apply({ items: [phone, cmd], stakeholder_note: '' })).toMatchObject({ ok: false, evidence: expect.stringContaining('MS-2 is new') });
});
it("quotes the stakeholder's comment in the work order", () => {
  expect(mustSupportTask(project, 2, ['BRIEF@1'], 'Add tablets').instructions).toContain('The stakeholder asked for changes: Add tablets');
  expect(mustSupportTask(project, 2, ['BRIEF@1']).ticket_id).toBe('MUST-SUPPORT-PM-2');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/apply-must-support.test.ts`
Expected: FAIL, because `applyMustSupport` and `mustSupportTask` aren't exported.

- [ ] **Step 3: Implement the schema, the applier, the task builder, the `VIEWS` entry and the role.yaml lines.**

- [ ] **Step 4: Run the tests, the role and seed tests, and the typecheck**

Run: `npx vitest run test/apply-must-support.test.ts test/role.test.ts test/seed-sync.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add seed/knowledge/schemas/must_support.json seed/knowledge/roles/pm/role.yaml src/engine/apply/must-support.ts src/engine/apply/index.ts src/engine/workorder.ts src/engine/conductor/tasks.ts src/engine/runner.ts test/apply-must-support.test.ts
git commit -m "feat(must-support): PM writes the list from the brief"
```

---

### Task 3: The confirm gate

**Files:**
- Create: `src/engine/conductor/must-support.ts`, `test/must-support-gate.test.ts`
- Modify:
  - `src/engine/inbox.ts`: add `| { kind: 'must_support'; version: number }` to `InboxRef`;
  - `src/engine/conductor/answers.ts`: `effectOf` routes `must_support`, and `Effect` (line 16) and `halt` (line 37) are exported for the new answer functions;
  - `src/engine/conductor/project.ts`: `intake`;
  - `src/engine/conductor/milestone.ts:71`: `setPending`;
  - `src/engine/conductor/tasks.ts`: `discoveryInputs` includes the list's pin;
  - `src/engine/conductor/prototype.ts`: the plan inputs include the list's pin;
  - `test/helpers/engine.ts`: add `seedMustSupport`.
- Modify every test that drives a project past intake or into milestone `pending`. Find them with `grep -ln "'BRIEF'" test/*.test.ts test/helpers/*.ts`, and have each call `seedMustSupport` after it publishes the BRIEF.

**Interfaces:**
- Consumes: from Task 2, `mustSupportTask` and `MUST_SUPPORT`; from Task 1, `MsItem`, `renderMustSupport` and `itemLine`.
- Produces:

```ts
// src/engine/conductor/must-support.ts
export async function approvedMustSupport(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<ArtifactVersionRow | undefined>;
  // newest version with approved_by set (my call 2); walk back with artifacts.version()
export async function mustSupportItems(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<{ pin: string; version: number; items: MsItem[] } | undefined>;
export type MsState = { approved?: ArtifactVersionRow; pending: boolean };
export async function advanceMustSupport(deps: EngineDeps, project: ProjectRow): Promise<MsState>;
export async function answerMustSupport(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, version: number, choice: string, words?: string): Promise<Effect>;
// test/helpers/engine.ts
export async function seedMustSupport(e: { deps: EngineDeps }, project: ProjectRow, items: MsItem[] = []): Promise<string>; // returns the pin
```

**`advanceMustSupport`**, each tick:
1. Let `k = roundOf(tasks, 'MUST-SUPPORT-PM')`.
2. If no `MUST-SUPPORT-PM` task exists and no list is approved: ensure `mustSupportTask(project, 1, [latest BRIEF pin])` and return `{ pending: true }`. This also covers a project created before this change.
3. If round `k`'s task exists and isn't `done`, return `{ approved, pending: true }`.
4. If the latest version is `proposed`, raise the confirm item (below) and return `{ approved, pending: true }`.
5. Otherwise return `{ approved, pending: false }`.

**The confirm item:**

| Field | Value |
|---|---|
| `type` | `approval` |
| `dedupe_key` | `must_support:<version>` |
| `ref` | `{ kind: 'must_support', version }` |
| `asked_by` | `pm` |
| `options` | `[]` |
| `recommendation` | `noteOf(store, task.id)` |

- **Title.** With no approved list, use the confirm item title; otherwise use the revision title (both in Global Constraints).
- **Why**, first list:

  > Before anything is built, confirm what the game must run on, how it's played and how it's built. Every prototype and milestone is checked against this list, and anything that can't be met comes back to you.

  - Then a blank line, then one line per item: `- <itemLine>: From your brief: “<quote>”`, or `- <itemLine>: Not in your brief: suggested because <reason>`.
- **Why**, revision:

  > The PM changed the list. Approve to build against the new one, or reject to keep MUST-SUPPORT@<approved.version>.

  - Then the lines `Added: <itemLine>`, `Removed: <itemLine>` and `Changed: <itemLine>`, comparing the two versions by id.
- **`blocks`:** `['Prototyping']` or `['Discovery']` (by `project.prototyping`) for the first list; `['The next milestone']` for a revision.
- **`evidence`:** the proposed `MUST-SUPPORT` pin and the BRIEF pin, plus the approved list's pin on a revision.

**The answers:**
- **approve:** status `{ id: MUST_SUPPORT, status: 'approved', approvedBy: 'stakeholder' }`.
- **request_changes:** ensure `mustSupportTask(project, k + 1, [BRIEF pin, MUST-SUPPORT@version], words)`.
- **reject**, with no approved list: `halt(...)` *(my call 3)*.
- **reject**, with an approved list: publish the next version, copying the approved one's `fields` and `body`, status `approved`, with `approvedBy` set to its `approved_by` and message `The stakeholder kept MUST-SUPPORT@<approved.version>` *(my call 2)*.

Each effect has the shape `answerCp1` returns (`answers.ts:42`).

**The waits:**
- **Intake:** `intake` first runs `const ms = await advanceMustSupport(deps, project); if (!ms.approved || ms.pending) return;`. The approved pin then joins `protoPlanTask` round 1's inputs and both lists from `discoveryInputs`.
- **Milestone:** `setPending` makes the same check before it ensures the spec task.

**`seedMustSupport`** publishes, through `artifacts.commit`:
- `MUST-SUPPORT`, status `approved`, `approvedBy: 'stakeholder'`, `ownerRole: 'pm'`;
- `derivedFrom`: the latest BRIEF pin when there is one, otherwise `[]`;
- `data`: `{ items, used: items.map(({ id }) => id) }`;
- `body`: `renderMustSupport(items)`.

With `[]`, the gate passes and every later check behaves as it does today.

- [ ] **Step 1: Write the failing tests** in `test/must-support-gate.test.ts`. Drive the PM task with the fake adapter, as `test/intake.test.ts` drives discovery.

```ts
it('starts the PM on the list at intake and waits', async () => {
  await runOnce(e);
  expect((await e.store.listTasks(project.id)).map((t) => t.ticket_id)).toEqual(['MUST-SUPPORT-PM-1']);
  expect((await e.store.getProjectById(project.id)).phase).toBe('intake');
});
it('raises the confirm item once', async () => {
  // PM output: [phone, cmd]; then two ticks
  const items = await e.store.inboxByPrefix(project.id, 'must_support:');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ title: "Confirm what the game must run on and how it's played", ref: { kind: 'must_support', version: 1 } });
  expect(items[0]!.evidence.map((x) => x.pin)).toEqual(['MUST-SUPPORT@1', 'BRIEF@1']);
  expect((await e.store.listTasks(project.id)).filter((t) => t.ticket_id.startsWith('MUST-SUPPORT-PM'))).toHaveLength(1);
});
it('shows a proposed item as not in the brief', async () => {
  expect(item.why).toContain('MS-1 Plays in a phone browser held upright: Not in your brief: suggested because players hold phones upright');
});
it('approving starts discovery with the list as an input', async () => {
  const tasks = await e.store.listTasks(project.id);
  expect(tasks.find((t) => t.ticket_id === 'DISCOVERY-PM-1')!.inputs).toContain('MUST-SUPPORT@1');
  expect(tasks.find((t) => t.ticket_id === 'DISCOVERY-TL-1')!.inputs).toContain('MUST-SUPPORT@1');
});
it('approving on a prototyping project starts round 1 with the list as an input', async () => { /* PROTO-PLAN-1 inputs contain MUST-SUPPORT@1 */ });
it('request changes runs the PM again with the comment and the earlier list', async () => {
  const t = (await e.store.listTasks(project.id)).find((x) => x.ticket_id === 'MUST-SUPPORT-PM-2')!;
  expect(t.inputs).toEqual(['BRIEF@1', 'MUST-SUPPORT@1']);
  expect(t.work_order).toContain('The stakeholder asked for changes: Add tablets');
});
it('rejecting the first list halts the project', async () => { /* phase 'halted' */ });
it('rejecting a revision keeps the approved list', async () => {
  const v3 = await e.artifacts.latest(project.id, 'MUST-SUPPORT');
  expect(v3).toMatchObject({ version: 3, status: 'approved', approved_by: 'stakeholder' });
  expect((await e.artifacts.read(project, 'MUST-SUPPORT@3')).fields.data).toEqual((await e.artifacts.read(project, 'MUST-SUPPORT@1')).fields.data);
});
it('a milestone waits for the list on a project that has none', async () => {
  // active project, milestone 1 pending, BRIEF@2 latest, no MUST-SUPPORT
  await runOnce(e);
  const ids = (await e.store.listTasks(project.id)).map((t) => t.ticket_id);
  expect(ids).toContain('MUST-SUPPORT-PM-1');
  expect(ids).not.toContain('M1-SPEC-1');
  // …approve → next tick: M1-SPEC-1 exists
});
it('a milestone waits while a revision is pending', async () => { /* approved v1 + proposed v2 → no M1-SPEC-1 */ });
```

The field that holds a task's work order is whatever `TaskRow` names it; match the existing tests.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/must-support-gate.test.ts`
Expected: FAIL, because `intake` creates `DISCOVERY-PM-1` straight away and the expected `MUST-SUPPORT-PM-1` never appears.

- [ ] **Step 3: Implement the gate, the answers, the input pins and `seedMustSupport`.** Then add `seedMustSupport` to the existing tests the grep finds.

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Every earlier test still passes with a seeded empty list.

- [ ] **Step 5: Commit**

```bash
git add src/engine/conductor/must-support.ts src/engine/inbox.ts src/engine/conductor/answers.ts src/engine/conductor/project.ts src/engine/conductor/milestone.ts src/engine/conductor/tasks.ts src/engine/conductor/prototype.ts test/helpers/engine.ts test/must-support-gate.test.ts <each existing test file you changed>
git commit -m "feat(must-support): stakeholder confirms the list before work starts"
```

---

### Task 4: Viewports, touch and fitting the screen in the play check

**Files:**
- Modify: `src/checks/play.ts`
- Create: `test/fixtures/play/touch-ok/index.html`, `test/fixtures/play/touch-ignored/index.html`, `test/fixtures/play/overflow/index.html`, `test/fixtures/play/overflow-after-gesture/index.html`
- Test: `test/play.test.ts`

**Interfaces:**
- Consumes: from Task 1, `ViewportSpec` and `VIEWPORTS` (tests only; `play.ts` takes the plain `ViewportSpec` shape).
- Produces:

```ts
export type SmokeOptions = { animated?: boolean; viewport?: ViewportSpec; touch?: boolean; fitsScreen?: boolean };
// PlayProblem.kind gains 'touch' | 'fits'
export type ScreenMetrics = { scrollWidth: number; scrollHeight: number; innerWidth: number; innerHeight: number; scrollX: number; scrollY: number };
export function fitsProblem(m: ScreenMetrics, when: 'after load' | 'after the keys' | 'after the gestures'): string | undefined;
```

**Changes to `play.ts`:**
- **Viewport.** When `opts.viewport` is set, `smokeSteps` sends these before load:
  - `Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile })` *(my call 7)*;
  - when `viewport.touch` is set, `Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 })`.
- **Gestures.** When `opts.touch` is set, after the existing key presses, `Input.dispatchTouchEvent` sends:
  1. a tap at the centre;
  2. a drag from (¼w, ½h) to (¾w, ½h) in 10 `touchMove` steps over 300 ms;
  3. a hold at the centre for `SMOKE_HOLD_MS`.
- **Touch check.** A script added with `addScriptToEvaluateOnNewDocument`, next to `FRAME_COUNTER`, counts calls to page handlers for `touchstart`, `touchmove`, `touchend`, `pointerdown`, `pointermove`, `pointerup`, `mousedown`, `mouseup` and `click`. It counts both `addEventListener` listeners and `on…` properties. The touch problems are *(my call 5)*:
  - no handler ran during the gestures: `{ kind: 'touch', detail: 'Nothing on the page answered a tap, a drag or a hold' }`;
  - the page isn't animated, and its screenshots before and after the gestures are identical: `{ kind: 'touch', detail: 'The page did not change when it was tapped, dragged and held' }`.
- **Fits check.** When `opts.fitsScreen` is set, read `ScreenMetrics` with `Runtime.evaluate`:
  - after load;
  - after the keys, when there were any;
  - after the gestures, when there were any.

  Each `fitsProblem` result becomes `{ kind: 'fits', detail }`.

`fitsProblem` allows 1 px for rounding and reports the first problem it finds, in this order:
1. `scrollX` or `scrollY` > 1: `The page scrolled <when>, so the screen moved off the game`
2. `scrollWidth` > `innerWidth` + 1: `The page is <scrollWidth>px wide on a <innerWidth>px-wide screen <when>, so part of it is off screen`
3. `scrollHeight` > `innerHeight` + 1: `The page is <scrollHeight>px tall on a <innerHeight>px-tall screen <when>, so part of it is off screen`

**The fixtures:**
- Each fixture is one static `index.html`, with an animated canvas drawn by `requestAnimationFrame`, so `frozen` doesn't fire.
- `touch-ok` changes its fill colour on `pointerdown`.
- `touch-ignored` listens only to `keydown`.
- `overflow` adds a 2000 px-tall block below the canvas.
- `overflow-after-gesture` fits until a `pointerdown`, which appends a 2000 px-tall block.

- [ ] **Step 1: Write the failing tests** in `test/play.test.ts`. The pure tests always run; the Chrome tests sit under the file's existing guard for a missing Chrome.

```ts
it('fitsProblem passes a page that fits, within a pixel', () => {
  expect(fitsProblem({ scrollWidth: 391, scrollHeight: 844, innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 0 }, 'after load')).toBeUndefined();
});
it('fitsProblem names the side that overflows and when', () => {
  expect(fitsProblem({ scrollWidth: 390, scrollHeight: 2000, innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 0 }, 'after the gestures'))
    .toBe('The page is 2000px tall on a 844px-tall screen after the gestures, so part of it is off screen');
  expect(fitsProblem({ scrollWidth: 390, scrollHeight: 844, innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 40 }, 'after load'))
    .toBe('The page scrolled after load, so the screen moved off the game');
});
const phone = { animated: true, viewport: VIEWPORTS.phone_portrait, touch: true, fitsScreen: true };
const onPhone = (name: string) => served(name, (url) => player.smoke(url + 'index.html', [], phone));
it('a phone run that answers touch passes', async () => {
  expect(await onPhone('touch-ok')).toMatchObject({ ok: true, problems: [] });
});
it('a page that ignores touch fails with a touch problem', async () => {
  const r = await onPhone('touch-ignored');
  expect(r.problems).toContainEqual({ kind: 'touch', detail: 'Nothing on the page answered a tap, a drag or a hold' });
});
it('a page taller than the phone fails fits after load', async () => {
  const r = await onPhone('overflow');
  expect(r.problems.find((p) => p.kind === 'fits')!.detail).toMatch(/tall on a 844px-tall screen after load/);
});
it('a page that grows after a tap fails fits after the gestures', async () => {
  const r = await onPhone('overflow-after-gesture');
  expect(r.problems.filter((p) => p.kind === 'fits').map((p) => p.detail)).toEqual([expect.stringMatching(/after the gestures/)]);
});
```

`served` is the helper inside the file's `chromePlayer` describe block (`test/play.test.ts:299`); put the Chrome tests in that block.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/play.test.ts`
Expected: FAIL, because `fitsProblem` isn't exported and the smoke ignores `viewport`, `touch` and `fitsScreen`.

- [ ] **Step 3: Implement the options, the gestures, the handler counter, the fits checks and the four fixtures.**

- [ ] **Step 4: Run the play tests, including the existing desktop ones, and the typecheck**

Run: `npx vitest run test/play.test.ts test/play-gate.test.ts && npm run typecheck`
Expected: PASS. A smoke with no options sends no `Emulation` call and gives the same results as before.

- [ ] **Step 5: Commit**

```bash
git add src/checks/play.ts test/play.test.ts test/fixtures/play/touch-ok test/fixtures/play/touch-ignored test/fixtures/play/overflow test/fixtures/play/overflow-after-gesture
git commit -m "feat(play): phone and tablet viewports, touch gestures, fits-screen check"
```

---

### Task 5: Migration 005, the status store and the event

**Files:**
- Modify:
  - `src/db/migrations.ts`: add `'005_must_support'`;
  - `src/db/schema.ts`: add `MustSupportStatusTable`, add it to `DB`, and give `InboxItemsTable` a `waivable: Generated<string>`;
  - `src/engine/store.ts`: `recordMustSupport`, `listMustSupport`, and `waivable` in `raiseInbox` and the row parse;
  - `src/engine/inbox.ts`: `InboxWaivable`, `NewInboxItem.waivable?`, `InboxRow.waivable`;
  - `src/events.ts`: add `'must_support.status'` to `EventType`.
- Test: `test/migrations.test.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: `MsStatus` and `ItemStatus` from Task 1.
- Produces:

```ts
// src/engine/inbox.ts
export type InboxWaivable = { id: string; text: string; why: string };
// src/engine/store.ts
export type MsScope = { scope: 'milestone' | 'prototype' | 'project'; n: number; subject?: string };
export type MsRecord = ItemStatus & { source: 'play_gate' | 'prototype_check' | 'stakeholder'; must_support_version: number };
export type MsStatusRow = MsRecord & { scope: MsScope['scope']; n: number; subject: string; recorded_at: string };
recordMustSupport(projectId: number, at: MsScope, rows: MsRecord[]): Promise<void>;
listMustSupport(projectId: number, at: MsScope): Promise<MsStatusRow[]>; // subject undefined → every subject
```

**The migration:**

```sql
CREATE TABLE must_support_status (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  scope TEXT NOT NULL CHECK (scope IN ('milestone', 'prototype', 'project')),
  n INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  item_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('met', 'failing', 'not_measured', 'waived')),
  evidence TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  must_support_version INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scope, n, subject, item_id)
);
ALTER TABLE inbox_items ADD COLUMN waivable TEXT NOT NULL DEFAULT '[]';
```

**The store:**
- `recordMustSupport` upserts every row in one transaction, with `subject` defaulting to `''`. Then it logs `must_support.status` with `{ scope, n, subject, statuses: [{ item_id, status }] }`.
- The project-wide scope uses `{ scope: 'project', n: 0 }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/migrations.test.ts
it('005 adds must_support_status and inbox waivable', async () => {
  // after migrateToLatest: insert a row; a status of 'maybe' rejects; inbox_items.waivable defaults to '[]'
});
// test/store.test.ts
it('records must-support statuses, replacing a row with the same key', async () => {
  await store.recordMustSupport(p.id, { scope: 'milestone', n: 1 }, [{ item_id: 'MS-1', status: 'failing', evidence: 'a', source: 'play_gate', must_support_version: 1 }]);
  await store.recordMustSupport(p.id, { scope: 'milestone', n: 1 }, [{ item_id: 'MS-1', status: 'met', evidence: 'b', source: 'play_gate', must_support_version: 1 }]);
  expect(await store.listMustSupport(p.id, { scope: 'milestone', n: 1 })).toMatchObject([{ item_id: 'MS-1', status: 'met', evidence: 'b', subject: '' }]);
});
it('lists one prototype or every prototype of a round', async () => {
  // rows for prototype 1 subjects P-1, P-2 → subject 'P-1' gives 1 row, no subject gives 2
});
it('logs must_support.status', async () => { /* eventTypes(...) contains 'must_support.status' */ });
it("keeps an inbox item's waivable list", async () => {
  // raiseInbox({..., waivable: [{ id: 'MS-1', text: 'Plays on a phone', why: 'Failing: too tall' }]}) → row.waivable equal
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/migrations.test.ts test/store.test.ts`
Expected: FAIL, because there is no table `must_support_status`, `recordMustSupport` isn't a function, and `waivable` is undefined.

- [ ] **Step 3: Implement the migration, the schema types, the store methods, the inbox field and the event type.**

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/migrations.test.ts test/store.test.ts test/inbox.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/schema.ts src/engine/store.ts src/engine/inbox.ts src/events.ts test/migrations.test.ts test/store.test.ts
git commit -m "feat(must-support): status table, inbox waivable column, status event"
```

---

### Task 6: Playing a build against the list

**Files:**
- Create: `src/engine/conductor/must-support-play.ts`, `test/must-support-play.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1, `playRuns`, `VIEWPORTS`, `VIEWPORT_LABEL`, `MsItem` and `ItemStatus`;
  - from Task 4, `SmokeOptions`;
  - existing: `servePage`, `browserWhy` and `problemLine` (`play-gate.ts`), `Player`, `PlayProblem` and `PlayBlock`.
- Produces:

```ts
export type RunProblems = { viewport: Viewport; problems: PlayProblem[] };
export type PlayedItems =
  | { kind: 'played'; statuses: ItemStatus[]; game: RunProblems[] } // game: runs whose game-level problems mean the game doesn't run
  | { kind: 'unavailable'; why: string };
export async function playMustSupport(player: Player, root: string, play: PlayBlock, items: MsItem[]): Promise<PlayedItems>;
```

For each `PlayRun`:
1. **Serve and smoke.** Call `servePage(root, play, (page) => player.smoke(page, keys, opts))`.
   - `keys` is `run.touch ? [] : play.keys` *(my call 6)*.
   - `opts` is `{ animated: play.animated, touch: run.touch, fitsScreen: run.fitsScreen }`, plus `viewport: VIEWPORTS[run.viewport]` whenever `run.items.length > 0`.
   - So the default run, with no items, gets exactly today's options.
2. **Unplayable runs.**
   - A `servePage` that isn't ok counts as a game problem: `{ kind: 'load', detail: why }`.
   - Any `browser` problem returns `{ kind: 'unavailable', why: browserWhy(<details>) }` at once.
3. **Game-level problems** are every kind except `touch` and `fits`. Any of them fails every item in the run, with evidence `<VIEWPORT_LABEL>: <problemLine; …>`, and the run goes into `game`.
4. **Item problems.** Otherwise:
   - a `touch` problem fails the run's items whose input is `touch`;
   - a `fits` problem fails the items with `fits_screen`;
   - the evidence is `<VIEWPORT_LABEL>: <detail>`.
5. **Met items.** Every other item in the run is `met`, with evidence `Played in a <VIEWPORT_LABEL> at <w>×<h>`.

The result's statuses cover the play items only.

- [ ] **Step 1: Write the failing tests.** Use a fake `Player` that records `(url, keys, opts)` and returns scripted `PlayResult`s, built like the fake in `test/play-gate.test.ts`. Serve a temporary directory holding an `index.html`.

```ts
it('plays once on the desktop, as before, when no item is played', async () => {
  const r = await playMustSupport(fake([ok]), root, play, [cmd]);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.opts).toEqual({ animated: false, touch: false, fitsScreen: false });
  expect(r).toEqual({ kind: 'played', statuses: [], game: [] });
});
it("plays once per viewport with that viewport's size and touch", async () => {
  await playMustSupport(fake([ok, ok]), root, { ...play, keys: ['ArrowLeft'] }, [phoneTouch, tabletMouse]);
  expect(fake.calls.map((c) => [c.keys, c.opts.viewport, c.opts.touch])).toEqual([
    [[], { width: 390, height: 844, mobile: true, touch: true }, true],
    [['ArrowLeft'], { width: 820, height: 1180, mobile: false, touch: true }, false],
  ]);
});
it('a touch problem fails only the items played by touch', async () => { /* phoneTouch failing, phoneFitsKeys met */ });
it('a fits problem fails only the items that must fit', async () => { /* evidence 'Phone browser, held upright: The page is 2000px tall…' */ });
it('a game that does not load fails every played item in that run', async () => {
  // problems [{ kind: 'exception', detail: 'boom' }] → both phone items failing; game [{ viewport: 'phone_portrait', problems: [...] }]
});
it("the browser's own failure makes the result unavailable", async () => {
  expect((await playMustSupport(fake([{ ok: false, problems: [{ kind: 'browser', detail: 'no chrome' }], durationMs: 0, log: [] }]), root, play, [phoneTouch])).kind).toBe('unavailable');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/must-support-play.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement `playMustSupport`.**

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/must-support-play.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/conductor/must-support-play.ts test/must-support-play.test.ts
git commit -m "feat(must-support): play a build per viewport and map problems to items"
```

---

### Task 7: Gaps — saying an item can't be met

**Files:**
- Create: `src/engine/apply/gaps.ts`, `test/must-support-gaps.test.ts`
- Modify:
  - `src/engine/apply/raised.ts`: `withRaised` validates `output.gaps` and raises them;
  - `src/engine/inbox.ts`: add `| { kind: 'ms_gap'; item: string; scope: 'milestone' | 'prototype'; n: number }` to `InboxRef`;
  - `src/engine/conductor/answers.ts`: route `ms_gap`;
  - `src/engine/conductor/change-requests.ts`: the drop reason for a `MUST-SUPPORT` target;
  - `src/engine/conductor/tasks.ts`: add `GAPS_LINE` to the instructions of every purpose listed below;
  - the schemas `seed/knowledge/schemas/{prototype_plan,environment_profile,milestone_spec,tech_design,ticket_scope,test_plan,qa_verify,eng_review}.json`.
- Test: `test/must-support-gaps.test.ts`, `test/change-requests.test.ts`

**Interfaces:**
- Consumes:
  - from Task 3, `mustSupportItems` and `mustSupportTask`;
  - from Task 5, `recordMustSupport`;
  - from Task 1, `itemLine`.
- Produces:

```ts
export type Gap = { item: string; why: string };
export type GapScope = { scope: 'milestone' | 'prototype'; n: number };
export function gapScope(task: Pick<TaskRow, 'ticket_id' | 'milestone'>): GapScope;      // (my call 9)
export function gapProblems(gaps: Gap[], items: MsItem[], pin: string): string[];
export async function raiseGaps(s: Store, project: ProjectRow, task: TaskRow, gaps: Gap[], ms: { pin: string; version: number; items: MsItem[] }): Promise<void>;
export async function answerGap(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, ref: Extract<InboxRef, { kind: 'ms_gap' }>, choice: string, words?: string): Promise<Effect>;
  // the shape of answerCp1 and answerCp2: effectOf passes choiceOf(item, answer) and wordsOf(answer)
export const GAPS_LINE: string; // in tasks.ts
```

**The schemas.** Each of the eight schemas gets an optional property, left out of `required`:

```json
"gaps": { "type": "array", "items": { "type": "object", "required": ["item", "why"], "additionalProperties": false,
  "properties": { "item": { "type": "string", "pattern": "^MS-\\d+$" }, "why": { "type": "string", "minLength": 1 } } } }
```

**`GAPS_LINE`**, exact copy:

> If an item on the must-support list can't be met, name it in gaps and say why. Never leave an item out silently.

**`gapProblems`** messages:
- `<item> is not on the must-support list (<pin>): name an item from it`
- `<item> appears in gaps twice`
- With no approved list, `withRaised` reports: `There is no confirmed must-support list yet, so there is nothing to raise a gap against`.

Problems send the output back, as dropped change requests do. On the last attempt, the bad gaps are dropped, and the drop is logged.

**The gap item:**

| Field | Value |
|---|---|
| `type` | `question` |
| `dedupe_key` | `ms_gap:<scope>:<n>:<item>` |
| `ref` | `{ kind: 'ms_gap', item, scope, n }` |
| `asked_by` | the task's role |
| `blocks` | `['Prototype round <n>']` for a round; `[]` for a milestone, which goes on |
| `evidence` | `[{ label: 'MUST-SUPPORT', value: pin, pin }]` |

- **Title:** `Milestone <n> can't meet: <text>`, or `Prototype round <n> can't meet: <text>`.
- **Why:** `<ticket_id> says this can't be done: <why>`, a blank line, then `The item: <itemLine>: From your brief: “<quote>”` (or `Not in your brief: suggested because <reason>`).
- **Options:**
  - `milestone`: `Accept it for this milestone` (for a round, `Accept it for this round`);
  - `for_good`: `Accept it for good`;
  - `change`: `Change the requirement`.

**The answers:**
- **`milestone`:** record `{ scope, n }` with the row `{ item_id, status: 'waived', evidence: 'DEC-<inbox id>@1', source: 'stakeholder', must_support_version }`.
- **`for_good`:** the same row, recorded at `{ scope: 'project', n: 0 }`.
- **`change`, or a written answer:** ensure `mustSupportTask(project, k + 1, [BRIEF pin, MUST-SUPPORT pin], comment)`, where `k = roundOf(tasks, 'MUST-SUPPORT-PM')`. The comment is `<ticket_id> says <item> can't be met: <why>.`, followed by ` The stakeholder wrote: <text>` when they wrote one. The confirm item follows through Task 3's gate *(my call 4)*.

**The change-request drop.** In `change-requests.ts`, a target of type `must_support` throws `ChangeRequestError` with: `<target> is the must-support list, which changes only through the stakeholder: name the item in gaps and say why it can't be met`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a gap in a milestone spec raises a question with three options', async () => {
  // M2-SPEC-1 output with gaps [{ item: 'MS-1', why: 'The map needs a wide screen' }]
  const [g] = await e.store.inboxByPrefix(project.id, 'ms_gap:');
  expect(g).toMatchObject({ dedupe_key: 'ms_gap:milestone:2:MS-1', title: "Milestone 2 can't meet: Plays in a phone browser held upright", blocks: [] });
  expect(g!.options.map((o) => o.label)).toEqual(['Accept it for this milestone', 'Accept it for good', 'Change the requirement']);
});
it('a gap naming an item not on the list is sent back', async () => {
  // gaps [{ item: 'MS-9', why: 'x' }] → attempt sent back; evidence contains 'MS-9 is not on the must-support list (MUST-SUPPORT@1)'
});
it("a gap in a round's plan is scoped to the round", async () => {
  // PROTO-PLAN-1 → dedupe 'ms_gap:prototype:1:MS-1', first option 'Accept it for this round', blocks ['Prototype round 1']
});
it('a gap from discovery is scoped to milestone 1', () => {
  expect(gapScope({ ticket_id: 'DISCOVERY-TL-1', milestone: 0 })).toEqual({ scope: 'milestone', n: 1 });
  expect(gapScope({ ticket_id: 'PROTO-PLAN-2', milestone: 0 })).toEqual({ scope: 'prototype', n: 2 });
  expect(gapScope({ ticket_id: 'M3-TECH-1', milestone: 3 })).toEqual({ scope: 'milestone', n: 3 });
});
it('accepting for this milestone waives the item for that milestone only', async () => {
  expect(await e.store.listMustSupport(project.id, { scope: 'milestone', n: 2 })).toMatchObject([{ item_id: 'MS-1', status: 'waived', evidence: `DEC-${g.id}@1` }]);
  expect(await e.store.listMustSupport(project.id, { scope: 'milestone', n: 3 })).toEqual([]);
});
it('accepting for good waives it at project scope', async () => { /* listMustSupport({ scope: 'project', n: 0 }) has MS-1 waived */ });
it('changing the requirement runs the PM on a revision', async () => {
  // MUST-SUPPORT-PM-2 work order contains "M2-SPEC-1 says MS-1 can't be met: The map needs a wide screen."
});
it('replaying the output raises the gap once', async () => { /* run the same applier result twice → one ms_gap row */ });
// test/change-requests.test.ts
it('a change request against MUST-SUPPORT is dropped and points at gaps', async () => {
  // error message contains 'name the item in gaps'
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/must-support-gaps.test.ts test/change-requests.test.ts`
Expected: FAIL, because no `ms_gap` item is raised and `gapScope` isn't exported.

- [ ] **Step 3: Implement gaps, the answers, the change-request message, `GAPS_LINE` and the schema property.**

- [ ] **Step 4: Run the tests, the role and seed tests, and the typecheck**

Run: `npx vitest run test/must-support-gaps.test.ts test/change-requests.test.ts test/role.test.ts test/seed-sync.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/apply/gaps.ts src/engine/apply/raised.ts src/engine/inbox.ts src/engine/conductor/answers.ts src/engine/conductor/change-requests.ts src/engine/conductor/tasks.ts seed/knowledge/schemas/prototype_plan.json seed/knowledge/schemas/environment_profile.json seed/knowledge/schemas/milestone_spec.json seed/knowledge/schemas/tech_design.json seed/knowledge/schemas/ticket_scope.json seed/knowledge/schemas/test_plan.json seed/knowledge/schemas/qa_verify.json seed/knowledge/schemas/eng_review.json test/must-support-gaps.test.ts test/change-requests.test.ts
git commit -m "feat(must-support): roles raise gaps, the stakeholder decides"
```

---

### Task 8: Prototypes are planned, built and played against the list

**Files:**
- Modify:
  - `seed/knowledge/schemas/prototype_plan.json`: give each prototype a `must_support` array;
  - `src/engine/apply/prototype.ts`: `planProblems`, `renderPlan`, `prototypeTicket` and the plan's `fields.data`;
  - `src/engine/conductor/prototype.ts`: `advancePrototype`, `raiseFunEval`, `checkPrototype`, `roundHeld`;
  - `src/engine/runner.ts`: `checkAttempt` calls `checkPrototype` for `PROTO-r-P-k` tickets.
- Test: `test/apply-prototype.test.ts`, `test/prototype.test.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes:
  - from Task 3, `mustSupportItems` and `advanceMustSupport`;
  - from Task 5, `recordMustSupport` and `listMustSupport`;
  - from Task 6, `playMustSupport`;
  - from Task 7, `Gap` and the `ms_gap` ref;
  - from Task 1, `itemLine` and `STATUS_LABEL`.
- Produces:

```ts
// apply/prototype.ts: these three are exported now, for the tests
Prototype gains must_support: { item: string; how: string }[];   PlanOutput gains gaps?: Gap[];
export function planProblems(output: PlanOutput, ms: MsItem[]): string[];   // ms: the approved list's items
export function renderPlan(round: number, output: PlanOutput): string;
export function prototypeTicket(round: number, k: number, prototype: Prototype, pin: string, ms: { pin: string; items: MsItem[] }): NewVersion;
// conductor/prototype.ts
export async function roundHeld(deps: EngineDeps, project: ProjectRow, r: number): Promise<boolean>;
export async function checkPrototype(deps: EngineDeps, project: ProjectRow, ticketId: string, worktree: string): Promise<{ ok: true } | { ok: false; evidence: string }>;
export function mustSupportLines(items: MsItem[], rows: MsStatusRow[]): { lead: string[]; block: string[] };
```

**`planProblems`.** Every `runs_on` item needs exactly one line in each prototype, unless the item is in `output.gaps`. Its messages:
- `P-<k> has no must_support line for <id>: say how it meets it, or name it in gaps`
- `P-<k> names <id>, which is not a runs_on item on the list`
- `P-<k> lists <id> twice`
- `P-<k>'s line for <id> says nothing`

**`renderPlan`.** Under each `## P-k`, after `- Controls:`, add `- Must support:` and then one line `  - <itemLine>: <how>` for each entry.

**`prototypeTicket`.**
- The body gets a final section:

  ```
  ## Must support

  Every item below holds for this prototype. Before the ticket is done, the engine plays it in each browser the list names.

  - <itemLine> — <Checked … line>: <the plan's how>        (play items)
  - <itemLine> — Not checked on prototypes                  (command items)
  - <itemLine> — The stakeholder checks this when they play it  (human items)
  ```

- The list's pin joins the ticket's inputs.

**`advancePrototype`.**
- The plan inputs are `[BRIEF, MUST-SUPPORT pin, ...funInputs]`.
- After the plan is `done`, and before it creates tickets, it runs `if (await roundHeld(deps, project, r)) return;`.
- `roundHeld` is true while either is pending:
  - an `ms_gap` item with `scope: 'prototype'` and `n: r`;
  - `(await advanceMustSupport(deps, project)).pending`.
- After a "change" answer, the round keeps its plan *(my call 11)*.

**`checkPrototype`.** It runs after `runChecks` passes for a ticket matching `/^PROTO-(\d+)-P-(\d+)$/`.
1. It reads the round's plan data for `controls`, and the list from `mustSupportItems`.
2. With no play items, it returns `{ ok: true }` at once *(my call 10)*.
3. With no player, or when `player.unavailable()`, it records every play item `not_measured` with the reason as evidence, and returns ok.
4. Otherwise it resolves `siteRoot(worktree, protoRoot(r, k))` and calls `playMustSupport` with `{ root: protoRoot(r, k), entry: 'index.html', keys: controls, animated: true }`. An `unavailable` result is recorded `not_measured`, and the ticket passes.
5. It records the statuses at `{ scope: 'prototype', n: r, subject: 'P-k' }`, with source `prototype_check`.
6. When any item is failing, it returns `{ ok: false, evidence: 'The prototype does not meet what the game must support:\n' + lines }`, one line per item: `<itemLine>: <evidence>`.

The runner treats that like any other failed check: the attempt fails with `check_failed` and the evidence, then goes through `blocked` or `retryOrEscalate`.

**The fun evaluation.** `raiseFunEval` reads `listMustSupport({ scope: 'prototype', n: r })`.
- `mustSupportLines(items, rows).lead` comes before the intro:
  - when any play item is failing: `Round <r>'s prototypes don't meet: <text> (P-2, P-3); <text> (P-1).`;
  - when any play item is unmeasured: `The engine could not check: <texts>.`
- After the smoke lines comes the block `What the game must support, as the engine found it:`, with one line per item in this order:
  1. failing and unmeasured play items;
  2. met play items;
  3. command items;
  4. human items.
- Each line is `- <itemLine>: <per-prototype statuses, e.g. "Failing on P-2 (<first evidence line>); Met on P-1">`. Command items read `Not checked on prototypes`; human items read `Not measured: check it yourself as you play`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/apply-prototype.test.ts
it('refuses a plan with no must-support line for a runs_on item', () => {
  expect(planProblems(/* plan without lines */, [phone, cmd])).toContain('P-1 has no must_support line for MS-1: say how it meets it, or name it in gaps');
});
it('lets a plan leave out an item it names in gaps', () => { /* output.gaps [{ item: 'MS-1', why }] → no MS-1 problem */ });
it('refuses an unknown or repeated item', () => { /* MS-2 (built_with) → 'P-1 names MS-2, which is not a runs_on item on the list'; MS-1 twice → 'P-1 lists MS-1 twice' */ });
it("renders each prototype's must-support lines", () => { /* renderPlan contains '- Must support:' and '  - MS-1 Plays in a phone browser held upright: big touch buttons' */ });
it('a prototype ticket carries the whole list and pins it', () => {
  const t = prototypeTicket(1, 1, proto, 'PROTO-PLAN-1@1#p-1', { pin: 'MUST-SUPPORT@1', items: [phone, cmd] });
  expect(t.body).toContain('## Must support');
  expect(t.body).toContain('MS-2 Has no build step — Not checked on prototypes');
  expect(t.fields!.inputs).toContain('MUST-SUPPORT@1');
});
// test/prototype.test.ts
it('a round waits while a gap for it is pending', async () => { /* no PROTO-1-P-* tasks; after answering 'milestone' they appear */ });
it("the fun evaluation leads with what the prototypes don't meet", async () => {
  // seeded rows: prototype 1 P-1 MS-1 failing
  expect(item.why.split('\n')[0]).toBe("Round 1's prototypes don't meet: Plays in a phone browser held upright (P-1).");
  expect(item.why).toContain('- MS-2 Has no build step: Not checked on prototypes');
});
// test/runner.test.ts
it('a prototype that fails a played item fails its attempt', async () => {
  // fake player returns a touch problem → attempt 'failed', evidence contains 'MS-1 Plays in a phone browser held upright: Phone browser, held upright: Nothing on the page answered a tap, a drag or a hold'
});
it('a prototype is not failed when there is no browser', async () => {
  // deps.player undefined → task in 'review'; listMustSupport({ scope: 'prototype', n: 1, subject: 'P-1' }) is [{ item_id: 'MS-1', status: 'not_measured', … }]
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/apply-prototype.test.ts test/prototype.test.ts test/runner.test.ts`
Expected: FAIL. The new assertions fail, and the existing tests still pass.

- [ ] **Step 3: Implement the plan rules, the rendering, the ticket section, `roundHeld`, `checkPrototype`, the runner hook and the fun-evaluation lines.**

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add seed/knowledge/schemas/prototype_plan.json src/engine/apply/prototype.ts src/engine/conductor/prototype.ts src/engine/runner.ts test/apply-prototype.test.ts test/prototype.test.ts test/runner.test.ts
git commit -m "feat(must-support): prototypes planned, built and played against the list"
```

---

### Task 9: Command checks from the Tech Lead

**Files:**
- Create: `seed/knowledge/schemas/must_support_checks.json`, `test/must-support-checks.test.ts`
- Modify:
  - `seed/knowledge/schemas/environment_profile.json`: add a `must_support_checks` array;
  - `seed/knowledge/roles/tech_lead/role.yaml`: `produces` and `output_schemas.must_support_checks`;
  - `src/engine/apply/discovery.ts`: `ProfileData.must_support_checks?`, the profile applier's validation, and the renderer's section;
  - `src/engine/apply/must-support.ts`: `applyMustSupportChecks`;
  - `src/engine/apply/index.ts`;
  - `src/engine/workorder.ts`: add `'must_support_checks'` to `Purpose`;
  - `src/engine/runner.ts`: `VIEWS.must_support_checks`, using the view `discovery` uses for the TL;
  - `src/engine/conductor/tasks.ts`: `mustSupportChecksTask`, and a line in `profileTask`'s instructions;
  - `src/engine/protected.ts`: `protectedPaths`;
  - `src/engine/conductor/milestone.ts`: `setPending`.

**Interfaces:**
- Consumes: from Task 3, `mustSupportItems`; existing `protectedProblems` and the glob matcher `protected.ts` already uses.
- Produces:

```ts
export type MsCheckCommand = { item: string; command: string; protected: string[] };  // apply/discovery.ts
export function checkCommandProblems(checks: MsCheckCommand[] | undefined, items: MsItem[], tracked: string[], base: string): string[];
export function missingChecks(profile: ProfileData, items: MsItem[]): string[];          // command-item ids with no check
export const applyMustSupportChecks: Applier;
export function mustSupportChecksTask(project: ProjectRow, k: number, inputs: string[]): TaskSpec; // 'MS-CHECKS-TL-k', tech_lead, milestone 0
```

**`checkCommandProblems`** messages:
- `must_support_checks has no command for <id> (<text>)`
- `must_support_checks names <id>, which is not checked by command`
- `<id>'s command is empty`
- `<glob> matches no file on <base>: protect only files the command reads`
- each `protectedProblems` line, as it is

`tracked` is the output of `git ls-tree -r --name-only <base_branch>` in `project.repo_path`.

**The profile line.** `profileTask`'s instructions get this line, exact copy:

> For every must-support item checked by command, add a must_support_checks entry: a shell command that exits 0 only when the item holds (it runs in the sandbox, without network, at the head of each milestone), and the files it reads that tickets must not change (protected).

**`applyMustSupportChecks`:**
1. Its output is `{ must_support_checks, stakeholder_note }`, and it is validated against every command item.
2. It publishes the next `ENV-PROFILE` version:
   - `data`: `{ ...previous data, must_support_checks }`;
   - `body`: rendered by the discovery applier's profile renderer;
   - `status: 'approved'`, with `approvedBy` set to the previous version's `approved_by` *(my call 12)*;
   - `derivedFrom`: `[previous ENV-PROFILE pin, MUST-SUPPORT pin]`.

The renderer shows the checks as `## Must-support checks`, one line per check: `- <id>: \`<command>\` (protects <globs>)`.

**`protectedPaths`** adds every glob from the latest approved profile's `must_support_checks`, with `source: ENV_PROFILE`, for every milestone, 0 included.

**`setPending`.** After the list gate passes:
1. If `missingChecks(profile, items)` isn't empty, ensure `mustSupportChecksTask(project, k, [ENV-PROFILE pin, MUST-SUPPORT pin])` and return.
   - `k` is the current `MS-CHECKS-TL` round.
   - If that round is `done` and checks are still missing, `k` is the next round.
2. Return while that task isn't `done`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a profile missing a check for a command item is sent back", async () => {
  // DISCOVERY-TL output without must_support_checks, list has cmd (MS-2) → evidence contains 'must_support_checks has no command for MS-2 (Has no build step)'
});
it('a protected glob that matches nothing is refused', () => {
  expect(checkCommandProblems([{ item: 'MS-2', command: 'test ! -f package.json', protected: ['scripts/nope.sh'] }], [cmd], ['index.html'], 'main'))
    .toEqual(['scripts/nope.sh matches no file on main: protect only files the command reads']);
});
it("the checks' files are protected in every milestone, prototypes too", async () => {
  for (const m of [0, 2]) expect(await protectedPaths(deps, project, m)).toContainEqual({ glob: 'scripts/check-no-build.sh', source: 'ENV-PROFILE' });
});
it('a milestone on a project whose profile lacks checks waits for the Tech Lead', async () => {
  // approved list with cmd; approved ENV-PROFILE@1 without checks; milestone 1 pending
  await runOnce(e);
  const ids = (await e.store.listTasks(project.id)).map((t) => t.ticket_id);
  expect(ids).toContain('MS-CHECKS-TL-1');
  expect(ids).not.toContain('M1-SPEC-1');
  // MS-CHECKS-TL-1 done → ENV-PROFILE@2 approved_by equals ENV-PROFILE@1's; next tick creates M1-SPEC-1
});
it('a profile with every check starts the milestone at once', async () => { /* M1-SPEC-1 on the first tick */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/must-support-checks.test.ts`
Expected: FAIL, because `checkCommandProblems` isn't exported and there is no `MS-CHECKS-TL-1`.

- [ ] **Step 3: Implement the schemas, the role lines, the validation, the applier, the task builder, the protected paths and the `setPending` wait.**

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/must-support-checks.test.ts test/protected.test.ts test/intake.test.ts test/role.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add seed/knowledge/schemas/must_support_checks.json seed/knowledge/schemas/environment_profile.json seed/knowledge/roles/tech_lead/role.yaml src/engine/apply/discovery.ts src/engine/apply/must-support.ts src/engine/apply/index.ts src/engine/workorder.ts src/engine/runner.ts src/engine/conductor/tasks.ts src/engine/protected.ts src/engine/conductor/milestone.ts test/must-support-checks.test.ts
git commit -m "feat(must-support): Tech Lead writes protected command checks"
```

---

### Task 10: The spec's "Must support" section and the list as every milestone input

**Files:**
- Modify:
  - `seed/knowledge/schemas/milestone_spec.json`: add `must_support`;
  - `src/engine/must-support.ts`: `specSection`;
  - `src/engine/apply/milestone.ts`: the spec applier;
  - `src/engine/conductor/tasks.ts`: `withMustSupport`, and QA's and the eng review's status lines;
  - `src/engine/conductor/milestone.ts`: the spec, tech, scope, test plan, QA, eng review and milestone review inputs;
  - `src/engine/apply/tickets.ts:173`: ticket inputs.
- Test: `test/apply-authoring.test.ts`, `test/review-inputs.test.ts`

**Interfaces:**
- Consumes: from Task 3, `mustSupportItems`; from Task 5, `listMustSupport`; from Task 1, `itemLine` and `STATUS_LABEL`.
- Produces:

```ts
export function specSection(lines: { item: string; change: string }[], items: MsItem[], gapped: string[]): { problems: string[]; section: string }; // must-support.ts
export async function withMustSupport(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, inputs: string[]): Promise<string[]>; // tasks.ts: appends the approved pin when one exists
export async function statusLines(deps: EngineDeps, project: ProjectRow, n: number): Promise<string[]>; // tasks.ts: "<itemLine>: <STATUS_LABEL> — <evidence>"
```

**`specSection`.** Each item needs one line.
- Its messages:
  - `The spec has no must_support line for <id> (<text>): say what this milestone does for it, or name it in gaps`
  - `The spec names <id>, which is not on the must-support list`
  - `The spec lists <id> twice`
- It returns this section, with one line per item:

  ```
  ## Must support

  - <itemLine>: <change>
  ```

  A gapped item reads `- <itemLine>: Not met in this milestone (raised with the stakeholder)`.
- The spec applier puts the section right before `## Acceptance criteria`.

**`withMustSupport`** wraps the inputs of:
- `specTask` (through `specSources`);
- the tech design, scope and test plan tasks in `design()`;
- `qaTask`;
- `engReviewSpec`;
- the milestone review task;
- every ticket the scope applier publishes (`tickets.ts:173`).

**`statusLines`** go into QA's and the eng review's instructions *(my call 13)*:

```
What the game must support, as the engine last found it:
- <itemLine>: <label> — <evidence>
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/apply-authoring.test.ts
it('a spec without a line for every item is sent back', async () => {
  // evidence contains 'The spec has no must_support line for MS-1 (Plays in a phone browser held upright): say what this milestone does for it, or name it in gaps'
});
it('a spec renders Must support before Acceptance criteria', async () => {
  const body = (await artifacts.read(project, 'M1-SPEC@1')).body; // the spec id specId(1) gives
  expect(body.indexOf('## Must support')).toBeGreaterThan(-1);
  expect(body.indexOf('## Must support')).toBeLessThan(body.indexOf('## Acceptance criteria'));
});
it('a gapped item reads as not met in this milestone', async () => { /* '- MS-1 …: Not met in this milestone (raised with the stakeholder)' */ });
// test/review-inputs.test.ts
it('every milestone task pins the must-support list', async () => {
  // seedMustSupport(e, project, [phone]) → after a flow through review, every task among
  // M1-SPEC-1, the tech/scope/test plan tasks, each M1 ticket, QA, ENG-REVIEW and REVIEW has 'MUST-SUPPORT@1' in inputs
});
it('QA is told what the engine found', async () => { /* qaTask instructions contain 'What the game must support, as the engine last found it:' */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/apply-authoring.test.ts test/review-inputs.test.ts`
Expected: FAIL. The new assertions fail.

- [ ] **Step 3: Implement the schema field, `specSection`, the applier change, `withMustSupport` at each call site, and `statusLines`.**

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add seed/knowledge/schemas/milestone_spec.json src/engine/must-support.ts src/engine/apply/milestone.ts src/engine/apply/tickets.ts src/engine/conductor/tasks.ts src/engine/conductor/milestone.ts test/apply-authoring.test.ts test/review-inputs.test.ts
git commit -m "feat(must-support): spec section, and the list pinned on every milestone task"
```

---

### Task 11: The milestone gate, CP4 waivers and the merge guard

**Files:**
- Modify:
  - `src/engine/conductor/play-gate.ts`: `runPlayGate`, `mustSupportBug`;
  - `src/engine/conductor/milestone.ts`: `build()`, `afterMilestoneReview`, `merging`;
  - `src/engine/inbox.ts`: `waive` on approve, and `assertValidAnswer`;
  - `src/engine/conductor/answers.ts`: `answerCp4`, `recordMarks`, `decisionRecord`;
  - `src/engine/apply/review.ts`: the milestone review's `## Must support` section;
  - `src/engine/must-support.ts`: `cp4MustSupport`.
- Test: `test/play-gate.test.ts`, `test/inbox.test.ts`, `test/must-support-milestone.test.ts`

**Interfaces:**
- Consumes:
  - from Task 6, `playMustSupport`;
  - from Task 9, `MsCheckCommand`;
  - from Task 5, `recordMustSupport`, `listMustSupport` and `InboxWaivable`;
  - from Task 1, `gateStatuses`;
  - existing: `runSandboxed`, `bugTicket` and `nextBugNumber`.
- Produces:

```ts
// play-gate.ts
PlayGateResult gains | { kind: 'short'; headSha: string; statuses: ItemStatus[]; profile: ProfileData };
export async function mustSupportBug(deps: EngineDeps, project: ProjectRow, n: number, round: number, short: Extract<PlayGateResult, { kind: 'short' }>): Promise<{ bug: NewVersion; ticket: NewVersion }>;
// must-support.ts
export function cp4MustSupport(items: MsItem[], statuses: ItemStatus[]): { lead: string[]; waivable: InboxWaivable[]; checks: InboxCheck[] };
// inbox.ts
InboxAnswer approve becomes { action: 'approve'; checks?: CheckMark[]; waive?: string[] };
assertValidAnswer(item: Pick<InboxRow, 'id' | 'type' | 'options' | 'checks' | 'ref' | 'waivable'>, answer): void;
```

**`runPlayGate`:**
1. **Inputs.** It reads `ms = mustSupportItems` and the profile.
   - The command checks are the profile's `must_support_checks` for the command items.
   - With `play === null` and no command items, it returns `skipped`.
2. **The head checkout.** In `withHeadWorktree`, it runs setup. Then, when there is a play block:
   - It builds and calls `playMustSupport(player, site.root, play, ms.items)`, with the existing player checks first.
   - `unavailable` holds as it does today.
   - Any `game` run gives `failed`. Its problems are every game run's problems, with details prefixed `<VIEWPORT_LABEL>: ` for any viewport other than desktop. This is the "The game does not run" Bug, unchanged.
3. **Command items.** Each one runs through `runSandboxed({ ...env, network: false, commands: [command] })`.
   - On success it is `met`, with evidence `` `<command>` passed ``.
   - Otherwise it is `failing`, with the run's evidence.

   Command items run even when `play === null`, and need no player.
4. **Record.** Play and command statuses are recorded at `{ scope: 'milestone', n }` with source `play_gate`. Human items aren't recorded here.
5. **Result.** Any failing status gives `short`; otherwise `passed`. `play.result` logs the statuses too.

**`build()`** handles `short` *(my call 14)*:
- **While `verify_round < verify_cap`:** `mustSupportBug`, then commit, `patchMilestone verify_round + 1` and `ensureTask`, as the `failed` path does.
- **Once rounds are spent:** go on exactly as `passed` does (`qaTask`, phase `verify`).

**`mustSupportBug`** files Bug `BUG-M<n>-<k>`:

| Field | Value |
|---|---|
| title | `The game does not meet what it must support` |
| `data` | `{ items: <failing ids>, headSha, statuses }` |
| `derivedFrom` | `[spec pin, MUST-SUPPORT pin, ENV-PROFILE pin]` |

- **Body:** `The engine built milestone <n> at <sha7> and checked it against MUST-SUPPORT@<v> before QA round <round>. These items failed:`. Then one line per failing item, `- <itemLine>: <first evidence line>`. Then `## In full`, with any multi-line evidence fenced, as `playBug` does.
- **Ticket:** from `bugTicket(n, k, { acs: [], title, touches: ['**'], definition_of_done: [profile.commands.test, ...failing command items' commands], techPin, specPin, components })`.

**`cp4MustSupport`:**
- **`failing` or `not_measured` play or command items** become `waivable`, as `{ id, text, why }` *(my call 15)*.
  - A failing item's `why` is its first evidence line.
  - An unmeasured one's `why` is `Not measured: <evidence, or "the engine could not check it">`.
- **`not_measured` human items** become checks, as `{ ac: id, text, how }`.
- **`lead`:**
  - when any item is failing, `This build does not meet: <failing texts joined "; ">.`, followed by one line per failing item, `<text>: <first evidence line>`;
  - otherwise `[]`.

**`afterMilestoneReview`:**
- `statuses = gateStatuses(items, listMustSupport(milestone n), listMustSupport({ scope: 'project', n: 0 }))`.
- `why = [...lead, existingWhy].join('\n')`.
- `checks = [...<AC human checks>, ...<MS checks>]`, with no cap on the MS checks.
- `waivable` goes on the item.

**`assertValidAnswer`**, for an item with `waivable` or a `waive` in the answer. The checks:
- `waive` on any item but a `cp4`, or on an answer that isn't approve: `Only a milestone approval can waive a must-support item`.
- An id in `waive` that is neither in `waivable` nor an `MS-n` check: `<id> is not a must-support item on this approval`.
- A `waivable` id missing from `waive`: `<id> does not meet the list: approve without it, or request changes`.
- `MS-n` checks named in `waive` don't need to be marked or passing. Every other check is held to today's rules.

**`answerCp4` approve:**
- `recordMarks` sends `AC-*` marks to `recordVerification` as it does today, and sends `MS-*` marks to the must-support statuses:
  - passing becomes `met`;
  - failing (allowed only when waived) becomes `waived`.
- Every waived id is recorded `waived`.
- Each row's evidence is `DEC-<inbox id>@1#<id lowercased>`, with source `stakeholder`, scope `{ milestone, n }`.
- `decisionRecord` adds a `## MS-n` section for each waived id that has no mark: `Approved without it.`, with the waiver's `why` quoted.

**The merge guard.** `merging` also throws `Milestone <n> can't merge: <ids> not met or waived` when any `gateStatuses` result isn't `met` or `waived`.

**The milestone review.** Its applier appends:

```
## Must support

The engine's last check of milestone <n> against MUST-SUPPORT@<v>:

- <itemLine>: <STATUS_LABEL> — <evidence>
```

A human item that isn't measured reads `Not measured — you check it at approval`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/play-gate.test.ts
it('a phone item that does not fit makes the gate short', async () => {
  const r = await runPlayGate(deps, project, 1); // fake player: phone run → fits problem
  expect(r).toMatchObject({ kind: 'short', statuses: [{ item_id: 'MS-1', status: 'failing' }] });
  expect(await store.listMustSupport(project.id, { scope: 'milestone', n: 1 })).toMatchObject([{ item_id: 'MS-1', status: 'failing', source: 'play_gate' }]);
});
it('a failing command item makes the gate short', async () => { /* check command 'false' → MS-2 failing */ });
it('a game that does not load still files the Bug the game does not run', async () => { /* kind 'failed', as today */ });
it('with no play block, the command items still run', async () => { /* play null + command item → MS-2 met, kind 'passed' */ });
it('with nothing to play and no command items, the gate is skipped', async () => { /* kind 'skipped' */ });
// test/inbox.test.ts
it('refuses a waive outside a milestone approval', () => {
  expect(() => assertValidAnswer({ ...cp2Item, waivable: [] }, { action: 'approve', waive: ['MS-1'] })).toThrow('Only a milestone approval can waive a must-support item');
});
it('refuses an approval that leaves a failing item unwaived', () => {
  expect(() => assertValidAnswer(cp4With([{ id: 'MS-1', text: 't', why: 'w' }]), { action: 'approve', checks: [] })).toThrow('MS-1 does not meet the list: approve without it, or request changes');
});
it('refuses an unknown id in waive', () => { /* 'MS-9 is not a must-support item on this approval' */ });
it('a waived MS check needs no mark', () => { /* checks [{ ac: 'MS-4', … }], waive ['MS-4'], no marks → no throw */ });
// test/must-support-milestone.test.ts (flow, with seedMustSupport and a fake player)
it('a short build with rounds left files a must-support Bug', async () => {
  // BUG-M1-1 title 'The game does not meet what it must support'; milestone verify_round grew by 1; its ticket task exists
});
it('a short build with no rounds left goes to QA, and CP4 leads with what it does not meet', async () => {
  expect(cp4.why.split('\n')[0]).toBe('This build does not meet: Plays in a phone browser held upright.');
  expect(cp4.waivable).toEqual([{ id: 'MS-1', text: 'Plays in a phone browser held upright', why: expect.any(String) }]);
});
it('a human item is a CP4 check outside the cap', async () => { /* 3 AC human checks + MS-4 → 4 checks */ });
it('approving with the item waived records it and merges', async () => {
  // approve { checks: […], waive: ['MS-1'] } → row MS-1 waived, evidence `DEC-${cp4.id}@1#ms-1`; DEC body contains '## MS-1'; phase 'merged'
});
it('the merge guard refuses an item that is neither met nor waived', async () => {
  // force phase merging with MS-1 failing → advanceMilestone rejects with "Milestone 1 can't merge: MS-1 not met or waived"
});
it("a removed item's rows do not hold up the merge", async () => { /* failing row for MS-9, MS-9 not on list → merged */ });
it('the milestone review shows the engine statuses', async () => { /* REVIEW body contains '## Must support' and 'MS-1 Plays in a phone browser held upright: Failing —' */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/play-gate.test.ts test/inbox.test.ts test/must-support-milestone.test.ts`
Expected: FAIL. The new assertions fail, and the existing play-gate tests still pass.

- [ ] **Step 3: Implement the gate, `build()`'s `short` path, `mustSupportBug`, `cp4MustSupport`, the CP4 raise, the waive validation, the recording, the decision-record sections, the merge guard and the review section.**

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/conductor/play-gate.ts src/engine/conductor/milestone.ts src/engine/inbox.ts src/engine/conductor/answers.ts src/engine/apply/review.ts src/engine/must-support.ts test/play-gate.test.ts test/inbox.test.ts test/must-support-milestone.test.ts
git commit -m "feat(must-support): milestone gate per viewport, CP4 waivers, merge guard"
```

---

### Task 12: The web inbox

**Files:**
- Modify: `web/src/lib/inbox.ts`, and `web/src/pages/Inbox.tsx` (where Approve sends its answer)
- Modify the server's answer route if it checks the answer's shape (`grep -rn "request_changes" src/server`), so it passes `waive` through as a string array.
- Test: `test/web-lib.test.ts`

**Interfaces:**
- Consumes: from Task 11, the answer shape `{ action: 'approve', checks, waive }` and `InboxWaivable`; from Tasks 3 and 7, the `must_support` and `ms_gap` refs.
- Produces (in `web/src/lib/inbox.ts`):

```ts
InboxItem gains waivable: { id: string; text: string; why: string }[];
export function canApproveItem(ref: InboxRef, checks: InboxCheck[], marks: Marks, waivable?: InboxItem['waivable'], waive?: string[]): boolean;
export const waiveLabel: (text: string) => string; // `Approve without: ${text}`
```

**What changes:**
- **Labels.** `inboxLabel` gives `What it must run on` for `must_support` and `Can't meet <item>` for `ms_gap`.
- **Approve.** `canApproveItem` is false while any `waivable` id is missing from `waive`. `MS-n` checks in `waive` need no mark.
- **CP4 view.** The Inbox shows one checkbox per waivable item, labelled `waiveLabel(text)`, with its `why` below. Approve sends `{ action: 'approve', checks: checkMarks(...), waive }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('labels the must-support items', () => {
  expect(inboxLabel({ id: 7, ref: { kind: 'must_support', version: 1 } })).toBe('What it must run on');
  expect(inboxLabel({ id: 8, ref: { kind: 'ms_gap', item: 'MS-1', scope: 'milestone', n: 2 } })).toBe("Can't meet MS-1");
});
it('approve needs every failing item waived', () => {
  const w = [{ id: 'MS-1', text: 'Plays on a phone', why: 'too tall' }];
  expect(canApproveItem({ kind: 'cp4', milestone: 1 }, [], {}, w, [])).toBe(false);
  expect(canApproveItem({ kind: 'cp4', milestone: 1 }, [], {}, w, ['MS-1'])).toBe(true);
});
it('a waived MS check needs no mark', () => {
  expect(canApproveItem({ kind: 'cp4', milestone: 1 }, [{ ac: 'MS-4', text: 't', how: 'h' }], {}, [], ['MS-4'])).toBe(true);
});
it('labels a waiver', () => expect(waiveLabel('Plays on a phone')).toBe('Approve without: Plays on a phone'));
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/web-lib.test.ts`
Expected: FAIL, because `waiveLabel` isn't exported and the labels are missing.

- [ ] **Step 3: Implement the lib changes, the waiver toggles, the answer body and the route pass-through.**

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/inbox.ts web/src/pages/Inbox.tsx <the server route, if changed> test/web-lib.test.ts
git commit -m "feat(web): must-support labels and Approve without toggles at CP4"
```

---

## After the last task (not a task: needs the user)

- **Rollout.** Copy the changed seed files into `~/.aiteam/knowledge`, and restart the daemon. Both need the user's OK; `syncSeed` won't overwrite these files on its own. The files:
  - the schemas `must_support`, `must_support_checks`, `prototype_plan`, `environment_profile`, `milestone_spec`, `tech_design`, `ticket_scope`, `test_plan`, `qa_verify` and `eng_review`;
  - `roles/pm/role.yaml` and `roles/tech_lead/role.yaml`.
- **Switching an existing project over.** A project created before this change gets its list when its next milestone starts: Task 3's `setPending` wait builds it from the latest BRIEF. Its command checks follow in Task 9's wait.
