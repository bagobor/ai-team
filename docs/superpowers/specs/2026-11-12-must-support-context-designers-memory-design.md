# Must-support list, plain inbox text, project front page, designer roles, and role memory

Date: 2026-11-12. Engine: `/Users/ps/dev/ai-team` at `67d24d4` (local main, not pushed). Live project: Hollow Comet Souls (id 16), milestone 1 waiting on CP4 (inbox 137).

Mockups (throwaway, real data): `inbox-item.html` and `project.html` in the session scratchpad `lan/mockups/`, served at `http://192.168.0.208:8710/`. The stakeholder said they point in the right direction. They are references for look and content, not pixel specs.

## Why

The stakeholder ran Hollow Comet Souls through prototypes and milestone 1 and gave five pieces of feedback:

1. "human facing text has internal references - human needs more context in one place"
2. "links to the current prototypes are not always explicit."
3. "check that top specification req. for prototypes are getting into the development process."
4. "we need a "designer" role."
5. "we need agentic personas with there agentic memories specific for each project, exposed in a readable form for a human, with an informaton on how specific information was added (hyperlinks if possible)."

What went wrong, in this project:

- **Point 3.** The brief says the game must be "fully playable on a phone held upright" with touch controls. Prototype round 1 had no touch and nobody said so. The prototype tickets never see the brief: `prototypeTicket` (`src/engine/apply/prototype.ts:96-117`) passes only the PM's `build` and `controls` text. After discovery, milestone tasks read the Roadmap, Human Requirements and FUN-DEFINITION (`specSources`, `src/engine/conductor/tasks.ts:364-367`), never the brief. At CP4 the stakeholder marked AC-16 failing: "the list wasn't working on phones chrome browser."
- **Point 1.** Inbox text is assembled from templates that cite IDs ("CR-15 changes the text of AC-9 in SPEC-M1", "DEC-74, DEC-75", "M1-T-12 needs you", "attempts_exhausted"). The web renders it as plain text with no links (`web/src/pages/Inbox.tsx:205-241`). The stakeholder's own CP4 notes on AC-14/15/16 (DEC-119) never reached the PM: MILESTONE-REVIEW-M1@2 says "My inputs don't say why", because the milestone review's inputs (`src/engine/conductor/milestone.ts:315`) leave out the decision record.
- **Point 2.** Builds are served on `127.0.0.1` only (`src/checks/static-server.ts:145-150`), so every link in the inbox is dead on the stakeholder's phone. Mounts live in memory and vanish on a daemon restart. There is no single place that lists what can be played now.
- **Point 4.** The PM owns mechanics, balance and the prototype plan on top of specs and milestone reviews. No role owns how anything looks. The engineer's role already consumes `ux_design#sections`, which nothing produces.
- **Point 5.** The `memory` part of every manifest is hard-coded to 0 tokens (`src/manifest/build.ts:179-180`). The Roles page shows a static "Empty". Lessons such as "on Node 25, `node --test` with folder names runs nothing" are learned again on every ticket.

The stakeholder's answers that shape this design, verbatim:

- On inbox text: "what is being asked, in plain words;. And references (clickable links) to all pieces that it refers to."
- On links: "current prototypes should be published at the top project view level. (links) along with the latest version of the design doc and specifications docs."
- On top requirements: ""top" in this context means before anything else, like browser, platform and input styles the product must support. these requirements are always should be respected or it must be explicitly communicated to the user that some of them couldn't be fulfilled."
- On the designer: "designer should ask human for things like: visual style approval, suggest visual style, and it's changes, be reponsible in making the whole visual presentation aligned with the main idea and product design direction. Ie all player / user facing visual components / elements."
- On mechanics: "mechanics is owned by the product designer role (or for a game it should be a game designer)."
- On memory content: "all of these: human's feedback, lessons, and detailed tech information about the project structure, etc"
- On memory levels: "agents at their level, and they should suggest top level memory update to the project lead / pm. also project lead / pm should review agentic memory after the task complete and if needed - save useful data on a higher level. Main rule - roles memory is role specific, while project memory is project specific."
- On rollout: "let's finish M1 and switch to the new version for the next milestone."

## Goals

- The product's must-support list (where it runs, how it is played) is written down before anything is built, reaches every prototype and every milestone task, and is checked at every gate. Anything not met is told to the stakeholder in plain words, never dropped silently.
- Every inbox item stands on its own: what is asked, in plain words; the stakeholder's earlier words where they matter; and a working link to every piece it refers to.
- Every build, prototype and newest document is one tap from the project's front page, and the links work from the stakeholder's phone on the local network.
- A game designer (product designer outside games) owns mechanics, progression and balance. A visual designer owns how everything the player sees looks, proposes a visual style and asks the stakeholder to approve it and any change to it.
- Each role keeps its own memory for each project. The PM keeps a project memory. Every entry says who added it, when, and from what, with links. The stakeholder can read both.

## Non-goals

- Making the app writable from the local network. The read-only view (today a scratchpad proxy on `:4790`) stays read-only; answering inbox items stays on the Mac. Builds get LAN links; the daemon API does not.
- Visual polish of prototypes. Prototypes test fun; the visual style applies from the first milestone on.
- Memory shared across projects (a global playbook). Role memory here is per project; `playbook_tokens` stays unused.
- A general rewrite of the web app's look. New pages use the existing tokens in `web/src/styles.css`.
- Measuring frame rate automatically. "60 fps" stays a human check, shown as "Not measured" until the stakeholder reports it.

## Anti-goals (failure even if it works)

- A gate passes while a must-support item is missing from its status list. Missing is not the same as met.
- Inbox text that still needs the Documents page open to be understood, or that names `SPEC-M1@11`, `AC-14`, `DEC-119` or `M1-T-12` without saying what they are.
- A link that works on the Mac and not on the phone.
- Memory that the stakeholder can't trace: an entry with no source, or one that changed without a record.
- Role memory that turns into a dump of every task's notes. Memory is what a role would want to know next time, not a log.
- Designers that re-decide what the stakeholder already judged. The stakeholder's verdicts on fun and their approved style win over any designer's taste.

## Rollout order

The stakeholder agreed this order. Each part merges to ai-team main on its own, with the suite green.

1. **Must-support list** (point 3).
2. **Plain inbox text and the project front page** (points 1 and 2, together, because the front page and the inbox share the link and naming work).
3. **Designer roles** (point 4).
4. **Memory** (point 5).

Changed on 2026-11-15: Part 1 is merged. Memory now comes next, ahead of Parts 2 and 3, and is built to `2026-11-15-playbook-memory-trials-design.md`, which replaces Part 4 below and adds role playbooks.

Hollow Comet Souls finishes milestone 1 on the engine that is running now (`67d24d4`), then waits until all four parts are merged, and starts milestone 2 on the new engine. See "Switching Hollow Comet Souls at milestone 2" at the end.

---

## Part 1: The must-support list

### What goes on it

"Top" requirements, in the stakeholder's words, are those that come "before anything else, like browser, platform and input styles the product must support." The list has two groups, as in the mockup's "Must support" panel:

- **Where it runs and how it's played** (the stakeholder's definition): browsers and their versions, platforms and devices, screen orientation and size, input styles (keyboard, mouse, touch, gamepad), and performance floors tied to them ("60 fps in desktop Chrome").
- **How it's built** *(my call, shown in the mockup without objection)*: hard rules the brief puts on the build, such as "one static folder, no build step, no dependencies, no network" or "art drawn in code, no image files". They are checked the same way and shown in their own group.

Everything else in the brief (features, fun, story) stays where it is today. The list is short: for Hollow Comet Souls it has 7 items.

### The document

A new artifact type `must_support`, id `MUST-SUPPORT`, owned by the PM, approved by the stakeholder. Each item:

- `id`: `MS-1`, `MS-2`, … stable across versions. A removed item's id is not reused.
- `group`: `runs_on` or `built_with`.
- `text`: the requirement in plain words ("Phone browser, held upright: the whole play area fits the screen; the page never scrolls, zooms or selects text").
- `brief_quote`: the brief's words it comes from, verbatim.
- `check`: how a gate decides it is met. One of:
  - `play`: the engine's browser play check covers it (see "Engine checks" below). A `play` item carries structured fields so the engine knows what to run without reading prose:
    - `viewport`: `desktop`, `phone_portrait`, `phone_landscape` or `tablet`;
    - `input`: `keys`, `touch` or `mouse`, or none when the item is only about the screen;
    - `fits_screen`: true when the page must never scroll, zoom or select text on that viewport.
  - `command`: a command in the repository decides it (for example a test that fails on any `import` of a package). The Tech Lead writes the command in discovery (below).
  - `human`: only a person can judge it; it becomes a human check at the gate.
- `how`: for `human`, what the stakeholder should do, in one sentence.

Must-support items are **not acceptance criteria**. They are checked by the engine at every gate, separately from each milestone's criteria. *(My call. Run through criteria, they would use up the Spec's cap of 3 human checks every milestone, need a regression-guard Change Request every milestone for items that hold from day one, such as "no dependencies", and could not apply to prototypes, which have no criteria.)*

### When it is written

It is the first thing a project does after the brief arrives, before prototype round 1 and before discovery:

1. The engine creates `MUST-SUPPORT-PM` (role `pm`, purpose `must_support`, input `BRIEF`). The PM extracts the items. If the brief says nothing about where the product runs or how it is played, the PM proposes the obvious items for the kind of product and marks each `proposed: true` with a reason.
2. The engine raises one inbox item: "Confirm what the game must run on and how it's played". It lists every item in plain words with its brief quote, and marks proposed items as "Not in your brief: suggested because …". Options: approve, or request changes with a comment (which re-runs step 1 with the comment).
3. Prototyping (or discovery, for a project without prototypes) waits for the approved list.

*(My call: the stakeholder confirms the list once, up front. It costs one short inbox item and makes the list theirs, so "met" and "not met" later mean what they meant.)*

Later changes go through the existing Change Request flow against `MUST-SUPPORT`, and the stakeholder decides each one.

### Where it flows

`MUST-SUPPORT` is pinned into the inputs of every task that plans, builds or judges the product:

| Task | What it must do with the list |
|---|---|
| Prototype plan (`PROTO-PLAN-r`) | Each prototype states, for every `runs_on` item, how it meets it, in one line. A plan can't exempt a prototype from an item. If the planner thinks an item can't be met in a prototype, it raises a gap (below), and the round waits for the stakeholder's answer before anything is built. The applier refuses a plan that skips an item. |
| Prototype tickets (`PROTO-r-P-k`) | The ticket body carries the full list in plain words, and the prototype's per-item lines. Today the body carries only `build` and `controls`. |
| Discovery (Tech Lead) | The Environment Profile gains `must_support_checks`: for each `command` item, the command that decides it. The engine treats the files those commands run as protected paths (as QA's acceptance tests are today, `src/engine/protected.ts`), so no ticket can change them. |
| Spec (`M{n}-SPEC`) | A "Must support" section lists every item and says what this milestone changes that the item touches, or "nothing". It is for the people and roles reading the Spec; the items are checked by the engine, not through the Spec's criteria. The applier refuses a Spec that leaves an item out. |
| Tech Design, Scope, tickets | Pinned as an input. Tickets that touch input handling or layout get it in their inputs. |
| QA, eng review, milestone review | Report a status for every item (below). |

### Engine checks

The browser play check (`src/checks/play.ts`, `chromePlayer`) today loads the page, presses the profile's `keys` and compares screenshots. The engine now derives the viewports and gestures to run from the `play` items of `MUST-SUPPORT`, not from the Environment Profile, so the check exists before discovery (for prototypes) and an existing project needs no profile change:

- One run per distinct `viewport` among the items. Fixed sizes: `desktop` 1280×800, `phone_portrait` 390×844 with touch and mobile emulation, `phone_landscape` 844×390 likewise, `tablet` 820×1180 with touch. With no `play` items, the desktop run alone, as today.
- On a viewport with a `touch` item, the check sends `tap`, `drag` and `hold` gestures and the page must change after them, as it must after keys today. Keys still come from the profile's `play.keys` (prototypes: from the plan's `controls`).
- On a viewport with a `fits_screen` item, the check also fails when the page scrolls, or the document is wider or taller than the viewport, after load and after the gestures. Viewports without such an item never get this check, so ordinary scrolling pages pass.
- Each run reports a result per item it covers, so the engine knows which item is Met or Failing.

These cover the `play` items that a machine can see: "touch controls work", "fits a phone held upright", "keyboard controls work". The prototype tickets' definition of done runs the same check on each prototype. *(My call: a prototype with no touch, for a product that must support touch, fails its ticket rather than reaching the stakeholder.)* `command` items are not checked on prototypes, which are built before the Tech Lead writes those commands; the fun evaluation shows them as "Not checked on prototypes".

### Status at each gate, and telling the stakeholder

Every gate that shows the stakeholder a build (fun evaluation and CP4) and every milestone review carries a status for each must-support item:

- **Met**, with the evidence (the check that passed, or the stakeholder's own earlier mark).
- **Failing**, with what failed in plain words.
- **Not measured**, when only a person can say and nobody has yet. It becomes a human check on the same item.
- **Waived**, when the stakeholder accepted a gap (below), with the date and their words.

The engine builds this table, not a role: it reads the play check results, the commands' results and the stakeholder's marks. Roles add explanation, but cannot mark an item met. Statuses are stored per gate in a new table (`must_support_status`: project, milestone or prototype round, item id, status, evidence, time), apart from the criteria table.

`human` items that are not yet measured appear on CP4 as checks keyed by their `MS-n`, next to the Spec's human checks and outside its cap of 3. The merge guard (`merging`, `src/engine/conductor/milestone.ts:404`) gains a second rule: every must-support item is Met or Waived for this milestone.

When an item is failing or not measured at a gate, the inbox item says so in its first lines, plainly: "This build does not meet: Phone browser, held upright. The beacon list doesn't fit on a phone screen." It is not hidden among evidence rows.

When a role finds that an item can't be met at all (for example a browser lacks an API the game needs), it raises a **must-support gap** through a new `gaps` field on its output. The engine raises an inbox item: what can't be met, why in plain words, and three options: accept the gap for this milestone, accept it for good (the item becomes Waived), or change the requirement (opens a Change Request). Work on that milestone goes on meanwhile. *(My call: a gap does not stop the milestone; the gate does, since CP4 can't be approved with an item failing unless the stakeholder waives it.)*

CP4's Approve stays possible with a failing item only through an explicit "Approve without: Phone browser, held upright", which records a waiver for that milestone.

The project front page (Part 2) shows the list with current statuses, and a history line under an item when it was missed before, as in the mockup: "Missed in prototype round 1: the prototypes had no touch, and nobody told you."

---

## Part 2: Plain inbox text and the project front page

### The rule for every human-facing text

Applies to inbox items, the project front page, notifications, and the parts of documents written for the stakeholder (each role's `stakeholder_note`, the milestone review summary):

1. **Say what is asked first, in plain words**: one or two sentences that make sense to someone who hasn't opened anything else. "Play milestone 1 again and decide if it goes into the game."
2. **Quote what the stakeholder needs in order to decide**, inline: the text of a criterion being checked, the stakeholder's own earlier words on it, what changed since.
3. **Link every piece it refers to**, with a plain name as the link text: "the spec for milestone 1", not `SPEC-M1@11`. An ID may follow in small type for those who want it.
4. **Say what each option does**: "Send back with my notes: the team fixes what you marked and asks you again."

### Inbox item shape

`NewInboxItem` (`src/engine/inbox.ts:24-38`) gains:

- `ask`: the plain sentence or two from rule 1. Required on every new item. The web shows it under the title, before anything else.
- `refs`: `{ label, target }[]`, the "Everything this refers to" list from the mockup. `target` is typed: `{ doc: pin }`, `{ ac: 'SPEC-M1@11#AC-14' }`, `{ task: id }`, `{ inbox: id }`, `{ build: buildId }`, `{ url }`. The web turns each into a link.
- On each check (`InboxCheck`): `said` (the stakeholder's previous note on the same criterion, with its date and a link to the decision it came from), `changed` (what the team changed since, in plain words, from the milestone review), and `source` (a ref to the criterion).
- On each option: `effect`, one sentence on what happens after choosing it.

The templates in `src/engine/conductor/` are rewritten to fill these: CP1 (`project.ts`), CP2 and CP4 and holds (`milestone.ts`), escalations (`escalations.ts`), Change Requests (`change-requests.ts`), fun evaluation (`prototype.ts`), and the new must-support items. Escalations say what the ticket was for and what went wrong in plain words ("The change to the game loop failed its tests 4 times in a row: the tests never started"), not `attempts_exhausted`.

As a safety net the web turns any known ID pattern left in any text (document pins, `AC-n`, `CR-n`, `DEC-n`, ticket ids, inbox ids) into a link to the right page. *(My call: a linkifier rather than an engine-side lint that refuses text containing IDs. Roles still write IDs in their notes; the charter rule asks them not to, and the link makes any that slip through usable.)*

The `inbox-item.html` mockup is the reference for CP4: plain ask; Play buttons; one block per check with "You said on 11 Nov", "What changed", "How to check", the full criterion and its source link; smaller decisions; "Everything this refers to"; and the decision buttons with their effects.

### The stakeholder's words reach the roles that act on them

The "You said" and "What changed" pair only works if the team reads what the stakeholder said. Every task that follows a stakeholder answer gets that answer's decision record as an input:

- The milestone review after a CP4 "request changes" reads the CP4 decision record (today `milestone.ts:315` omits it).
- The replan, QA round and eng review after it read it too.
- The milestone review's output gains `changed_since_cp4`: for each criterion the stakeholder marked, what the team changed, in plain words. That fills `changed` on the next CP4's checks.

### Builds the phone can open

- **A build record.** Every build the stakeholder might play gets a row: `id`, `project_id`, `kind` (`milestone`, `prototype`, `main`), `label` ("Milestone 1: Embers and beacons", "Prototype P-2, round 1"), `commit`, `created_at`, `path` and `url`. New table `builds`.
- **Durable exports.** The engine serves a build from an export of its commit (`git archive` into `~/.aiteam/projects/<name>/builds/<build-id>/`, then the profile's build command if any), not from a worktree, and serves it again after a restart. Exports are never deleted while their build is the latest of its kind, or linked from a pending inbox item.
- **LAN links.** A new config value `try.lan_host` (for example `192.168.0.208`). When set, the try server also listens on that address and accepts it in the Host allow-list, and every build URL uses it. When unset, nothing changes: `127.0.0.1` only. *(My call: off by default, turned on by the stakeholder in config. Serving agent-built pages to the local network is what we do by hand today with `python3 -m http.server`; this makes it the engine's job.)*
- Every inbox item that asks the stakeholder to judge something playable carries its Play link at the top, with "With frame counter" where the profile has an fps switch. The milestone review document carries the build's link too.

### The project front page

`/projects/:name` becomes the project's front page and its default view. The `project.html` mockup is the reference. Its sections:

1. **Name, one-line description** (from the brief's first paragraph or the Roadmap), and a **status line**: what is waiting for the stakeholder, with a link to it, or what the team is doing now.
2. **Play**: every build from the `builds` table, newest first: the latest milestone build, main, then each prototype round with each prototype's verdict quoted in the stakeholder's words ("forks are not fun, scans and caches are good.") and what became of it.
3. **Must support**: the list from Part 1, grouped, each item with its status chip and history line. Links to the brief.
4. **Latest documents**: only the newest version of each document, by plain name, with a one-line description, version and date: the brief, the Roadmap, the game design and visual style (Part 3), the spec and tech design of the current milestone, FUN-DEFINITION, the latest prototype plan. Older versions stay on the Documents page.
5. **Team**: the roles on the project. From Part 4 on, the project memory panel and each role's memory link (Part 4).

A new API endpoint `GET /api/projects/:name/overview` returns everything the page shows in one response. The page works at phone width (375 px) and reads through the existing read-only LAN view.

Document pins inside rendered documents (`web/src/pages/Documents.tsx`) become links. *(Whether the Documents page renders markdown instead of `<pre>` is the builder's call.)*

---

## Part 3: Designer roles

Two new seed roles in `seed/knowledge/roles/`, each with a `role.yaml`, a `charter.md` (≤ 600 tokens) and output schemas, following `eng_lead`.

### Game designer (`product_designer`)

The stakeholder: "mechanics is owned by the product designer role (or for a game it should be a game designer)."

- **Role id** `product_designer`. It is shown as "Game designer" in a game project and "Product designer" otherwise. A project gains a `kind` (`game` or `app`) set at intake (`--game` on the CLI; Hollow Comet Souls is `game`). *(My call: one role with two display names, so the charter and the engine don't fork.)*
- **Owns**: mechanics, rules, progression, economy and balance numbers, controls feel, and the fun hypotheses.
- **Takes over from the PM**: the prototype plan (`PROTO-PLAN-r`) and FUN-DEFINITION. The PM keeps the brief → Roadmap, Human Requirements, Specs and their acceptance criteria, and milestone reviews.
- **New document** `GAME-DESIGN` (type `game_design`, owner `product_designer`): how the product plays. Sections per mechanic, each with the numbers that tune it (costs, rates, drops) and the F-n elements of FUN-DEFINITION it serves. Approved by its owner; changes after a milestone's CP2 go through Change Requests, as Specs do.
- **When it works**:
  - Discovery: writes `GAME-DESIGN` v1 alongside the PM's Roadmap, from the brief, the must-support list and the prototype verdicts.
  - Each milestone, before the Spec: a new task `M{n}-GAMEDESIGN` revises the sections this milestone adds or changes. The Spec reads `GAME-DESIGN` and its mechanics criteria must agree with it.
  - After a CP4 "request changes" (the engine can't tell which notes are about mechanics, so every CP4 decision record goes to it), it revises `GAME-DESIGN` directly, before the replan, when the notes call for it. The stakeholder's notes are the authority for that revision, so it needs no Change Request of its own; the next CP4 shows what changed. If the Spec's locked criteria must change to match, that goes through the existing Change Request flow, which the stakeholder decides, as CR-15 did. *(My call: one decision for the stakeholder, as today, not two.)* The AC-15 note ("we need an equipment mechanics - weapon, shield generators, trustors, secondary weapons …") is exactly this.
  - Gives a recommendation on Change Requests that touch `GAME-DESIGN`.

### Visual designer (`visual_designer`)

The stakeholder: "designer should ask human for things like: visual style approval, suggest visual style, and it's changes, be reponsible in making the whole visual presentation aligned with the main idea and product design direction. Ie all player / user facing visual components / elements."

- **Owns**: everything the player or user sees: palette, shapes and sprites, type, HUD and menus, screen layouts at each must-support viewport, motion and effects, and their fit with the product's idea and the game design.
- **New document** `VISUAL-STYLE` (type `visual_style`, owner `visual_designer`, approved by the stakeholder): the style in words and numbers (colours, sizes, spacing, the HUD layout per viewport, what each effect means), plus a **style board**: one self-contained HTML page that shows the palette, the player's ship and enemies drawn the game's way, the HUD on a phone and a desktop frame, and the key screens.
  - The designer returns the board as a field of its structured output (`board_html`), like every non-engineer role, so it stays read-only with no edit tools. The engine stores the page in the state repo beside the document version, runs the play check's load step on it (it must load without errors), and serves it as a build of kind `style`. *(My call: the board is never part of the product, so it lives with the document and never touches a milestone branch or main.)*
- **Asks the stakeholder**:
  - "Approve the visual style": an inbox item with the style board's Play link, the style summary in plain words, and approve / request changes.
  - Any later change to an approved style is a Change Request against `VISUAL-STYLE` raised by the designer, with a new style board showing before and after. The stakeholder decides.
- **When it works**:
  - After discovery: `VISUAL-STYLE-VD` writes the first style. Milestone 1's design phase (Tech Design, Scope) waits for the stakeholder's approval; its Spec does not. *(My call: the style must be approved before tickets are cut, so engineers build against it; it need not hold up the Spec.)*
  - Tickets that touch player-facing code get `VISUAL-STYLE` in their inputs. The engineer's `consumes` replaces `ux_design#sections` with `visual_style#sections`.
  - **Visual review** at milestone level, next to the eng review: the engine takes screenshots of the build at each must-support viewport at fixed moments (after load, after the play check's keys or gestures), and the visual designer reviews them against `VISUAL-STYLE`. Findings become polish tickets, through the same loop and cap as the eng review. *(My call: screenshots from the play check rather than letting the designer drive a browser.)*
- Prototypes are out of its scope: they test fun, not looks.

### Wiring both roles

Per the recon, a new role and document type need: `ARTIFACT_TYPES` (`src/artifacts/format.ts`), schemas in `seed/knowledge/schemas/`, a purpose in `src/engine/workorder.ts`, appliers in `src/engine/apply/index.ts`, ids in `src/engine/apply/ids.ts`, the stage wiring in `src/engine/conductor/tasks.ts` and `milestone.ts`, `GROUP_OF` in `web/src/lib/documents.ts`, `ROLE_CHIP` in `web/src/lib/ledger.ts` and `ROLE_NAME` in `web/src/lib/roles.ts`. `syncSeed` adds new seed files only, so existing installs pick up the new roles and the edited PM charter needs a deliberate update path. Model choice and budgets per role are the builder's call; the charters stay within 600 tokens.

---

## Part 4: Memory

Replaced on 2026-11-15 by `2026-11-15-playbook-memory-trials-design.md`. That design keeps what this part says about how entries are added, their provenance and removal, and changes the rest.

### Two levels

The stakeholder: "roles memory is role specific, while project memory is project specific."

- **Role memory**: one per role per project. Written by that role. What that role should know next time it works on this project. Example: the engineer's "On this machine's Node 25, `node --test` with folder names stops before running anything. Pass file patterns instead."
- **Project memory**: one per project, read by every role. Curated by the PM. What everyone on the project should know. Its three kinds, from the stakeholder's answer:
  - **Feedback**: what the stakeholder said and prefers, in their words. "The stakeholder plays on a phone held upright, in Chrome and Safari."
  - **Lessons**: what went wrong or right and what to do about it.
  - **Structure**: detailed technical facts about the project: layout, modules and what each owns, commands, conventions, where tests live.

### How entries are added

- **By a role, at its level.** Every role's output schemas gain an optional `memory` array. Each item: `level` (`role` or `suggest_project`), `kind` (`feedback`, `lesson`, `structure`), `text`, and `sources` (refs, as in the inbox's `refs`). `role` items are saved to that role's memory from every attempt whose output parses, failed attempts included, since a failure is where most lessons come from (the Node 25 lesson came from a ticket that failed and was cancelled). At most 3 entries per attempt. `suggest_project` items are queued for the PM. *(My call: the 3-entry cap and the PM's review keep this from becoming a log of every attempt.)*
- **By the PM, after tasks complete.** The stakeholder: "project lead / pm should review agentic memory after the task complete and if needed - save useful data on a higher level." A task `MEMORY-REVIEW-n` (role `pm`, purpose `memory_review`) runs when there are new role entries or suggestions since the last review. Its inputs are those entries and the current project memory. It can promote an entry (copy it up, citing the role entry), merge or rewrite project entries, and drop entries that no longer hold, each with a reason. *(My call: one review covers every task completed since the last, and only one runs at a time, so a burst of tickets costs one PM run, not one each.)*
- **By the engine, for the stakeholder's words.** Every stakeholder answer that carries words (fun verdicts, CP4 notes, request-changes comments, Change Request decisions, must-support confirmations) is recorded verbatim as a project-memory `feedback` entry by the engine, linked to its decision record. The PM may later merge several into a lasting preference, keeping the links. *(My call: the engine records them, so feedback never depends on a role noticing it.)*

### Provenance

Every entry carries:

- who added it: a role (and which task and attempt), the PM (and which memory review), or the engine (from which stakeholder answer);
- when;
- `sources`: links to what it came from: an inbox item, a decision record, a document version, a ticket and attempt, a commit;
- for a promoted entry, a link to the role entry it came from.

Every change to an entry (added, rewritten, merged, dropped) is a commit in the project's state repo, with the reason in the commit message. The web shows an entry's history from those commits.

### Storage

In the project's state repo, which already versions artifacts with git and reserves `memory/` (`STATE_FOLDERS`, `src/git/merge.ts:11`): `memory/project.md` and `memory/roles/<role-id>.md`. Each entry is a section with a stable id (`MEM-n`), its provenance as fields, and its text. *(The exact file format is the builder's call, as long as a person can read the file as it is and the web can parse it.)*

### Reading it

The manifest's `memory` part (`src/manifest/build.ts:179-180`) gets real content: the project memory, then this role's memory, within the role's `memory_tokens` budget. Whole entries only, newest first within each kind; the manifest records which entries didn't fit. The memory review keeps project memory under budget by merging and condensing; a role whose own memory is over budget gets a condense instruction in its next task. *(Budget sizes are the builder's call; today every role has 1000.)*

### Showing it

- **Project front page, Team section**: the project memory, grouped by kind, each entry with its text and "Added by the PM from your note on 11 Nov", every source a link (as in the mockup).
- **Role page** (`/roles/:id`): the static "Empty" panels (`web/src/pages/Roles.tsx`) become that role's memory for a chosen project, and the project memory it reads.
- **Remove**: the stakeholder can remove an entry from the web with a reason. The removal is a commit like any other and shows in the history. *(My call: wrong memory is worse than none, and the stakeholder is the one who will spot a wrong "the stakeholder prefers …".)*

---

## Switching Hollow Comet Souls at milestone 2

- Milestone 1 finishes on the running daemon (`67d24d4`). Inbox 137 is the stakeholder's to answer.
- **The project waits for all four parts** (the stakeholder's choice). The old engine starts milestone 2's Spec right after the merge, so the daemon is stopped as soon as milestone 1 has merged, with the stakeholder's go-ahead at that time. The project's `halt` endpoint can't be undone, so it isn't the tool for this.
- The project stays stopped while Parts 1 to 4 are built and merged. Then the daemon is restarted on the new main, again with the stakeholder's go-ahead, and milestone 2 begins with everything in place. One migration covers it.
- If the old engine started milestone 2's Spec before the stop, the new engine's migration cancels that task and its draft, and milestone 2 begins on the new flow. *(My call.)*
- A project created before this change has no `MUST-SUPPORT`, `GAME-DESIGN`, `VISUAL-STYLE` or memory. When its next milestone starts, the engine creates the missing pieces in this order and the milestone waits for them:
  1. `MUST-SUPPORT` from `BRIEF@1`, confirmed by the stakeholder (7 items for this project).
  2. `GAME-DESIGN` from the brief, FUN-DEFINITION, the prototype verdicts, the merged milestone 1 code and the CP4 decision records, including the AC-15 equipment note.
  3. `VISUAL-STYLE` from the game as it looks after milestone 1: describe what exists, propose changes, and ask for approval.
  4. A first memory review that reads every past decision record (DEC-116 to the last) and records the stakeholder's feedback, and the merged code's structure.
- Builds already served by hand (`:8705`, `:8706`, `:8711`) are recorded in the `builds` table by the migration, so the front page links them from the start.

## Calls I made (for the stakeholder to check)

1. The must-support list includes "how it's built" rules, in their own group.
2. The stakeholder confirms the must-support list once, before prototypes.
3. A prototype that misses a touch requirement fails its ticket instead of reaching the stakeholder.
4. A must-support gap doesn't stop the milestone; CP4 can't be approved with a failing item without an explicit waiver.
5. IDs left in text become links in the web, rather than being refused by the engine.
6. Builds get LAN links through an opt-in `try.lan_host` setting.
7. One designer role id, shown as "Game designer" or "Product designer" by project kind.
8. The game designer takes the prototype plan and FUN-DEFINITION from the PM.
9. The visual style must be approved before milestone tickets are cut, not before the Spec.
10. The visual review uses screenshots from the play check.
11. One memory review covers all tasks completed since the last one.
12. The engine records the stakeholder's words into project memory itself.
13. The stakeholder can remove a memory entry from the web.
14. If the old engine began milestone 2's Spec before the daemon was stopped, the migration cancels it and milestone 2 starts on the new flow.
15. Must-support items are checked by the engine at every gate, apart from each milestone's acceptance criteria.
16. The play check's viewports and gestures come from the must-support items, so prototypes get them and no Environment Profile has to change.
17. A prototype plan can't exempt a prototype from an item; it raises a gap, and the round waits for the stakeholder's answer.
18. Role memory is saved from failed attempts too, at most 3 entries per attempt.
19. The game designer's revision after CP4 notes needs no Change Request of its own; Spec changes still do.
20. The visual designer returns the style board as a page in its output; it is stored with the document and never touches main.

## Left to the builder

- File formats for memory, model choices and budgets for the new roles, the exact wording of charters within the rules above.
- Whether the Documents page renders markdown.
- How the play check emulates touch and mobile viewports in Chrome (CDP `Emulation.setTouchEmulationEnabled`, `Emulation.setDeviceMetricsOverride` and `Input.dispatchTouchEvent` are the obvious path).
- Database migrations for `builds`, project `kind`, and the new inbox fields.
- Test strategy, within the project's existing rule that tests never bind ports 4780 or 4781.
