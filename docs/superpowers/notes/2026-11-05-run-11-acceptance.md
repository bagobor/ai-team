# Run 11 acceptance: W1, the product gate

**Status: planned, not run.** Run 11 is the real-run acceptance for W1 (`docs/superpowers/plans/2026-11-05-w1-product-gate.md`, with the roadmap's W1 section in `2026-11-05-flow-fixes-roadmap.md`). This page is the brief to give the team, what to do before the run, and what to check afterwards. The Results section at the end is empty until the run has happened.

The run needs the code of branch `w1-product-gate` (last implementation commit `843fbd9`), either from that checkout or from `main` once it is merged. Everything on this page that touches the daemon, `~/.aiteam` or its database is done by the stakeholder, by hand: they are theirs, and nothing in the repo touches them.

## The brief

A small browser game, in one milestone of about 3 tickets. Create a project with a new empty repo, name it `dodger` (the queries below use that name), and post this as its Brief:

```markdown
# Asteroid dodger

A one-screen asteroid dodger that runs in the browser. The arrow keys move the ship, the game speeds up as it goes, and it shows a score and a best score. There is a sound when the ship is hit.

One milestone is enough for this.
```

The last line is what sets Discovery to one milestone. The first thing to look at is that the Roadmap has exactly one.

## Before the run

1. **Copy the changed seed files into the knowledge repo.** `syncSeed` never overwrites a file that exists, so a charter or schema that this branch changed stays old in `~/.aiteam/knowledge` until it is copied. These are the files `git diff --stat 605c89d..HEAD -- seed/` lists, plus the Engineer charter, which Task 12 changes:

   - `knowledge/roles/engineer/charter.md`
   - `knowledge/roles/pm/charter.md`
   - `knowledge/roles/qa_engineer/charter.md`
   - `knowledge/roles/qa_engineer/role.yaml`
   - `knowledge/roles/tech_lead/charter.md`
   - `knowledge/schemas/environment_profile.json`
   - `knowledge/schemas/milestone_spec.json`
   - `knowledge/schemas/revise.json`
   - `knowledge/schemas/test_plan.json`

   Each path is under `seed/` in the checkout and under `~/.aiteam/` in the live setup. Look at what the live copy has first (`diff seed/<path> ~/.aiteam/<path>`), because a copy replaces any edit made there by hand. Then commit them in `~/.aiteam/knowledge` with a message such as `seed: W1 product gate`.

2. **Make sure port 4781 is free.** The daemon takes its API port plus one for the try server, and refuses to start if it can't have it. `lsof -nP -iTCP:4781 -sTCP:LISTEN` prints nothing when the port is free.

3. **Run the Chrome fixture tests.** They are the canary for a Chrome update that changes headless behavior. Chrome can't start inside a sandbox, so run them from the checkout in a plain terminal, or in Claude Code with the Bash sandbox off:

   ```
   AITEAM_REQUIRE_CHROME=1 npx vitest run test/play.test.ts
   ```

   With the variable set, a missing Chrome fails them instead of skipping them. The Chrome is the system one, unless `chrome.binary` is set in `~/.aiteam/config.yaml`.

4. **Restart the daemon on 4780**, so it runs the new code and starts the try server. Check that 4781 is now listening. The daemon now warns at start about knowledge files that differ from its seed, and after the copy in step 1 that warning should list none of the files above.

## During the run

Answer the Inbox as in earlier runs. Two things are particular to this one:

- **File a ticket that breaks the render, while the milestone is in `build`.** It checks item 7 below. Save this as `hand-1.md`. `touches` and the file in the body are the game's main script, which is `main.js` unless the Tech Design names another:

  ```markdown
  ---
  id: HAND-1
  title: Break the render on purpose
  milestone: 1
  ac_refs: []
  specialty: engineer
  touches:
    - main.js
  depends_on: []
  definition_of_done:
    - test -f main.js
  inputs: []
  size: S
  ---
  Add `throw new Error('render broken on purpose')` as the first line of main.js. This ticket exists only to check that the engine notices a game that doesn't run.
  ```

  Then post it:

  ```
  node -e "fetch('http://127.0.0.1:4780/api/projects/dodger/tickets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({markdown:require('fs').readFileSync('hand-1.md','utf8')})}).then(async r=>console.log(r.status,await r.text()))"
  ```

  The code review may send it back instead of passing it. If it does, say so in the results: the play gate was not exercised by it, and item 7 is not shown.

- **Mark the human checks at CP4 in the UI**, as item 9 says, one by one, and open the `Try it` link first.

## The checklist

Queries use `sqlite3 -readonly ~/.aiteam/aiteam.db`. Wherever one has `<P>`, put `(select id from projects where name = 'dodger')` there.

1. **The Spec has 1 to 3 human checks and at least one automated criterion.** In Documents, open SPEC-M1: each criterion's line says `Checked by the stakeholder` or `Verified by`. The same from the database:

   ```
   select ac_id, json_extract(verification, '$.method') as method from acceptance_criteria where project_id = <P> and milestone = 1;
   ```

   Pass: 1 to 3 rows with method `human`, and at least one `automated`.

2. **The Environment Profile has a `play` block.** In Documents, open ENV-PROFILE. Pass: a `play` block with `root`, `entry` and `keys`, where `keys` lists every key the game reads, the start key among them. An `animated` field may be present too; for this game it should be absent or `true`, since `false` is for a page with no animation loop.

3. **The Test Plan names `protected` paths, and its Q-tickets write the acceptance tests.** In Documents, open TEST-PLAN-M1 and look for `protected` globs. On the Board, the `M1-Q-` tickets are merged. Pass: the Q-tickets' diffs hold files under the protected globs, and the product (`M1-T-`) tickets' diffs hold none.

4. **Every product ticket's manifest lists the protected paths.**

   ```
   select t.ticket_id, a.k, instr(a.manifest, 'Protected paths: QA''s acceptance tests') > 0 as lists_protected
   from attempts a join tasks t on t.id = a.task_id
   where t.project_id = <P> and t.ticket_id like 'M1-T-%' order by t.ticket_id, a.k;
   ```

   Pass: `lists_protected` is 1 on every row. No engineer attempt should have a `scope_violation` on a protected path either: `select t.ticket_id, a.k, a.failure_kind from attempts a join tasks t on t.id = a.task_id where t.project_id = <P> and a.failure_kind = 'scope_violation';`. A row there is a product ticket that tried, and the check did its job; note it in the results.

5. **A `play.result` event comes before every QA task.**

   ```
   select t.ticket_id, t.created_at,
     (select max(e.ts) from events e where e.project_id = t.project_id and e.type = 'play.result' and json_extract(e.payload, '$.milestone') = t.milestone and json_extract(e.payload, '$.outcome') = 'passed' and e.ts <= t.created_at) as played_at
   from tasks t where t.project_id = <P> and t.kind = 'qa_verify' order by t.created_at;
   ```

   Pass: `played_at` is set on every row, and differs between rounds. `select ts, payload from events where type = 'play.result' and project_id = <P> order by seq;` shows the whole run of them, including a `failed` one for item 7.

6. **The QA report has an "On the base" line for every automated criterion.** In Documents, open each QA-REPORT-M1-n. Pass: every automated criterion's section has one line starting `On the base (<sha7>)`, and it says `failed as it should` or, for a regression guard the stakeholder approved, `a regression guard`. `passed too, so it shows nothing` must not appear in a report that passes.

   Also note how each browser criterion was covered: a `play` script or a grep of the code. The grep can still pass red on the base (the plan's risk PG-2), and this is where that shows. TEST-PLAN-M1's coverage says which.

7. **A hand-filed ticket that breaks the render is caught by the play gate before QA.** HAND-1 from "During the run" is merged into `aiteam/m1`. Pass:
   - a `play.result` event with outcome `failed` and a `problems` list that names the uncaught error;
   - a `BUG-M1-k` in Documents whose body starts `The game does not run`, approved by `engine`, not by QA:

     ```
     select artifact_id, version, approved_by from artifact_versions where project_id = <P> and type = 'bug';
     ```

   - no QA task between the merge of HAND-1 and that Bug. The failed gate spends QA round 1, so the first QA task is `M1-QA-2`, and the milestone's cap of 3 leaves it two.

8. **CP4 shows the checks, the branch and a working `Try it` link.** In the Inbox, open the CP4 item for milestone 1. Pass:
   - the human checks are listed to be made;
   - `Branch aiteam/m1 at <sha7>`, where `<sha7>` is `git -C <repo> rev-parse --short=7 aiteam/m1`;
   - `Try it` is a link on port 4781, and the game loads and runs in a browser when it is opened.

9. **The stakeholder marks the checks in the UI, and the criteria show their evidence.** Mark each human check passing or failing at CP4. A failed check can only be sent back with request changes, never approved (D3). Then:

   ```
   select ac_id, status, evidence_ref from acceptance_criteria where project_id = <P> and milestone = 1 order by ac_id;
   ```

   Pass: each human check is `passing` with `DEC-<id>@1#ac-n` as its evidence, and each automated one has a QA report as its evidence.

10. **The run's cost is in the cost views.** The Tasks page has a Cost column, and `GET /api/projects/dodger` has `totals.usdEst`. Pass: both show a figure, and the two agree.

## Cost by phase

Fill this in after the run, with the query below, against STARLANCE's split: planning 40%, build plus review 46%, QA 10%. Those add to 96%, and the record doesn't break down the other 4%. QA's share is the one to watch: every command now runs twice, once on the base, and the Q-tickets add build work.

```
select case
    when t.kind = 'qa_verify' then 'QA'
    when t.kind in ('ticket', 'code_review') then 'build + review'
    when t.purpose in ('discovery', 'milestone_spec', 'environment_profile', 'tech_design', 'test_plan', 'revise_design', 'revise_test_plan') then 'planning'
    else 'other (change requests, milestone review)'
  end as phase,
  round(sum(json_extract(a.usage, '$.usdEst')), 2) as usd
from attempts a join tasks t on t.id = a.task_id
where t.project_id = <P> group by phase;
```

| Phase | STARLANCE | Run 11 |
|---|---|---|
| Planning | 40% | |
| Build plus review | 46% | |
| QA | 10% | |
| Other | 4% | |

## What to watch for

These are the open risks from the plan that the run can show:

- **A grep still passing red on the base.** Item 6 shows it.
- **The "still" check failing a game that sits on a title screen.** If the play gate files a `BUG-M1-k` for a game that runs, read its problems. The fix would be to make the check a warning in the Bug body.
- **A Chrome update.** The canary in "Before the run" is the first sign.
- **QA command time.** Setup now runs twice per round, on the head and on the base. Note the QA task's duration against the earlier runs.

## Results

Not run yet.
