import { isHumanCheck } from '../../artifacts/acs.ts';
import { coverageTable } from '../../checks/coverage.ts';
import { runSandboxed } from '../../checks/run-checks.ts';
import { advanceBaseBranch, snapshotState, syncBaseIntoIntegration } from '../../git/merge.ts';
import { ensureIntegrationBranch } from '../../git/workspace.ts';
import { stateRepoDir, worktreePath } from '../../paths.ts';
import type { ProfileData } from '../apply/discovery.ts';
import { milestoneCoverage, type EngFinding, type EngReviewData } from '../apply/eng-review.ts';
import { engReviewId, ENV_PROFILE, reviewId, scopeId, specId, techId, testPlanId } from '../apply/ids.ts';
import { structureOf } from '../apply/tech-structure.ts';
import { oneLine, sentence } from '../apply/text.ts';
import { TRY_IT } from '../inbox.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { MilestoneRow, ProjectRow, Store, TaskRow } from '../store.ts';
import { withHeadWorktree } from './head-worktree.ts';
import { playBug, problemLine, runPlayGate } from './play-gate.ts';
import { designMoving, engReviewTask, ensureTask, isClosed, latestPin, milestoneReviewTask, noteOf, pinOf, qaTask, raiseHold, RETRY_OR_HALT, roundId, roundOf, scopeTask, specTask, techTask, testPlanTask, ticketTask, openHold, type TaskSpec, type TicketFields } from './tasks.ts';
import { offerTry, removeTryWorktree, serveTryAgain } from './try.ts';

type HoldKind = 'smoke' | 'base_conflict' | 'base_refused' | 'play';

const HOLD_KINDS = ['smoke', 'base_conflict', 'base_refused', 'qa_cap', 'play'] as const;
const STALE_BLOCKS: readonly string[] = ['tech_design', 'test_plan', 'ticket_scope', 'ticket'];

const byId = (tasks: TaskRow[], id: string) => tasks.find(({ ticket_id }) => ticket_id === id);
const isPolishTicket = (id: string) => /-E-\d+$/.test(id);

// A checkout offered at CP4 is the engine's, not the stakeholder's, so they are told not to keep work in it. A CP4 for the
// same head keeps it as it is (ensureTryWorktree).
const DISPOSABLE = "The checkout is replaced when the milestone's head moves and removed when the milestone merges or is rejected, so edits there are lost.";

// An open request could still change what the stakeholder approves, so CP4 and the merge wait until it is decided.
const requestOpen = async (deps: EngineDeps, project: ProjectRow) =>
  (await deps.artifacts.list(project.id)).some(({ type, status }) => type === 'change_request' && status === 'proposed');

function hold(s: Store, project: ProjectRow, n: number, kind: HoldKind, title: string, why: string, recommendation: string) {
  return raiseHold(s, project, `${kind}:M${n}`, {
    milestone: n,
    type: 'question',
    ref: { kind, milestone: n },
    title,
    asked_by: 'engine',
    why,
    blocks: [`Milestone ${n}`],
    evidence: [],
    recommendation,
    options: RETRY_OR_HALT,
  });
}

const holdBaseConflict = (s: Store, project: ProjectRow, n: number, conflicts: string[]) =>
  hold(s, project, n, 'base_conflict', `${project.base_branch} conflicts with milestone ${n}`, `Merging ${project.base_branch} into the integration branch conflicts in: ${conflicts.join(', ')}`, `Resolve the conflict in ${project.base_branch} or on the integration branch, then retry.`);

// QA and the play gate both spend rounds, so either can be the one that finds them all used. Each says it in its own words.
const holdQaCap = (s: Store, project: ProjectRow, n: number, title: string, why: string) =>
  raiseHold(s, project, `qa_cap:M${n}`, {
    milestone: n,
    type: 'question',
    ref: { kind: 'qa_cap', milestone: n },
    title,
    asked_by: 'engine',
    why,
    blocks: [`Milestone ${n}`],
    evidence: [],
    recommendation: 'Give it three more rounds if the failures look close to fixed, otherwise halt and look at the Bug reports.',
    options: [
      { id: 'more', label: 'Three more rounds' },
      { id: 'halt', label: 'Halt' },
    ],
  });

async function setPending(deps: EngineDeps, project: ProjectRow, { n }: MilestoneRow): Promise<void> {
  const inputs = [await latestPin(deps, project, 'ROADMAP'), await latestPin(deps, project, 'HUMAN-REQUIREMENTS')];
  await deps.store.atomically(async (s) => {
    await ensureTask(s, specTask(project, n, 1, inputs));
    await s.setMilestonePhase(project.id, n, 'spec');
  });
}

async function afterSpec(deps: EngineDeps, project: ProjectRow, { n }: MilestoneRow, tasks: TaskRow[]): Promise<void> {
  const base = `M${n}-SPEC`;
  const task = byId(tasks, roundId(base, roundOf(tasks, base)));
  if (task?.state !== 'done') return;
  const spec = await deps.artifacts.latest(project.id, specId(n));
  if (!spec) throw new Error(`${task.ticket_id} finished without ${specId(n)}`);
  const recommendation = await noteOf(deps.store, task.id);
  await deps.store.atomically(async (s) => {
    await s.raiseInbox({
      project_id: project.id,
      milestone: n,
      type: 'approval',
      dedupe_key: `cp2:M${n}:${spec.version}`,
      ref: { kind: 'cp2', milestone: n },
      title: `Approve the Spec for milestone ${n}`,
      asked_by: 'pm',
      why: 'Approving locks the acceptance criteria. After that, only a Change Request you approve can change their text.',
      blocks: [`Milestone ${n}`],
      evidence: [{ label: specId(n), value: pinOf(spec), pin: pinOf(spec) }],
      recommendation,
      options: [],
    });
    await s.setMilestonePhase(project.id, n, 'cp2');
  });
}

// Runs at the integration head with the same setup a ticket gets.
async function runSmoke(deps: EngineDeps, project: ProjectRow, n: number): Promise<{ ok: true } | { ok: false; why: string }> {
  const { commands, setup } = (await deps.artifacts.read(project, ENV_PROFILE)).fields.data as ProfileData;
  return withHeadWorktree(deps, project, n, 'smoke', async (checkout) => {
    const env = { ...checkout, onEvent: () => {} };
    if (setup) {
      const prepared = await runSandboxed({ ...env, network: true, commands: [setup] });
      if (!prepared.ok) return { ok: false, why: prepared.evidence };
    }
    const smoke = await runSandboxed({ ...env, commands: [commands.smoke] });
    return smoke.ok ? { ok: true } : { ok: false, why: smoke.evidence };
  });
}

export async function newTicketSpecs(deps: EngineDeps, project: ProjectRow, n: number, tasks: TaskRow[]): Promise<TaskSpec[]> {
  const specs: TaskSpec[] = [];
  for (const row of await deps.artifacts.list(project.id)) {
    if (row.type !== 'ticket' || row.milestone !== n || (row.status !== 'approved' && row.status !== 'stale')) continue;
    if (byId(tasks, row.artifact_id)) continue;
    const { fields } = await deps.artifacts.read(project, row.artifact_id);
    specs.push(ticketTask(project, n, row, fields as TicketFields));
  }
  return specs;
}

async function design(deps: EngineDeps, project: ProjectRow, { n }: MilestoneRow, tasks: TaskRow[]): Promise<void> {
  const { store } = deps;
  const tech = byId(tasks, `M${n}-TECH`);
  const plan = byId(tasks, `M${n}-TESTPLAN`);
  if (!tech || !plan) {
    const synced = await syncBaseIntoIntegration(project.repo_path, n, project.base_branch);
    if (!synced.ok) {
      await holdBaseConflict(store, project, n, synced.conflicts);
      return;
    }
    const inputs = [await latestPin(deps, project, specId(n)), await latestPin(deps, project, ENV_PROFILE)];
    await store.atomically(async (s) => {
      await ensureTask(s, techTask(project, n, inputs));
      await ensureTask(s, testPlanTask(project, n, inputs));
    });
    return;
  }
  if (tech.state !== 'done' || plan.state !== 'done') return;

  // The Eng Lead splits the work into tickets from the Tech Design's components, with the Test Plan in view, once the design stops moving.
  const scope = byId(tasks, `M${n}-SCOPE`);
  if (!scope) {
    if (designMoving(await deps.artifacts.list(project.id), tasks, n)) return;
    const inputs = [await latestPin(deps, project, specId(n)), await latestPin(deps, project, ENV_PROFILE), await latestPin(deps, project, techId(n)), await latestPin(deps, project, testPlanId(n))];
    await store.atomically((s) => ensureTask(s, scopeTask(project, n, inputs)));
    return;
  }
  if (scope.state !== 'done') return;

  const smoke = await runSmoke(deps, project, n);
  if (!smoke.ok) {
    await hold(store, project, n, 'smoke', `The smoke check failed before milestone ${n}'s tickets`, smoke.why, 'Fix the toolchain or the smoke command, then retry. No ticket starts until it passes.');
    return;
  }
  const specs = await newTicketSpecs(deps, project, n, tasks);
  await store.atomically(async (s) => {
    for (const spec of specs) await ensureTask(s, spec);
    await s.setMilestonePhase(project.id, n, 'build');
  });
}

async function build(deps: EngineDeps, runner: Runner, project: ProjectRow, m: MilestoneRow, tasks: TaskRow[]): Promise<void> {
  const { store, artifacts } = deps;
  const { n } = m;
  const own = tasks.filter(({ milestone }) => milestone === n);

  // A change moved the milestone back here. The move is in the Change Request's transaction and this isn't, so a crash in between is repaired on the next tick.
  for (const task of own) {
    if ((task.kind === 'qa_verify' || task.purpose === 'eng_review' || task.purpose === 'milestone_review') && !isClosed(task)) await runner.cancel(task.id);
  }

  const specs = await newTicketSpecs(deps, project, n, tasks);
  if (specs.length > 0) {
    await store.atomically(async (s) => {
      for (const spec of specs) await ensureTask(s, spec);
    });
    return;
  }

  if (!own.filter(({ kind }) => kind === 'ticket').every(isClosed)) return;
  if (own.some(({ purpose, state }) => (purpose === 'revise_design' || purpose === 'revise_scope' || purpose === 'revise_test_plan') && !isClosed({ state }))) return;
  if (tasks.some(({ purpose, state }) => purpose === 'cr_recommendation' && !isClosed({ state }))) return;
  // A stale Spec doesn't count: nothing revises one, so it would hold the milestone for ever. It still shows in Documents.
  if ((await artifacts.list(project.id)).some((row) => row.milestone === n && row.status === 'stale' && STALE_BLOCKS.includes(row.type))) return;

  const played = await runPlayGate(deps, project, n);
  if (played.kind === 'unavailable' && played.cause === 'setup') {
    await hold(store, project, n, 'play', `The setup failed before milestone ${n}'s game could be played`, played.why, "Fix the Environment Profile's setup command, or what it fetches from, such as a lockfile or a registry, then retry. No QA round starts until the game has been played.");
    return;
  }
  if (played.kind === 'unavailable') {
    await hold(store, project, n, 'play', `Milestone ${n}'s game can't be played here`, played.why, 'Fix what stops the engine playing the game on this machine, such as a missing Chrome (chrome.binary in ~/.aiteam/config.yaml), then retry. No QA round starts until the game has been played.');
    return;
  }
  if (played.kind === 'failed') {
    if (m.verify_round >= m.verify_cap) {
      // No QA ran, so these are rounds, not QA rounds. Only the first problem fits in a line; the Bugs hold the rest.
      const rounds = (k: number) => `${k} round${k === 1 ? '' : 's'}`;
      const used = m.verify_cap === 1 ? 'its only round' : `its ${rounds(m.verify_cap)}`;
      const why = `The game doesn't run: ${sentence(problemLine(played.problems[0]!))} The milestone has used ${used}.`;
      await holdQaCap(store, project, n, `Milestone ${n}'s game still doesn't run after ${rounds(m.verify_round)}`, why);
      return;
    }
    // The round is spent with the Bug that records it, so a crash can't charge it twice or file a Bug for free.
    const { bug, ticket } = await playBug(deps, project, n, m.verify_round + 1, played);
    await artifacts.commit(project, { message: `milestone ${n}: the game does not run`, publish: [bug, ticket] }, async (s, rows) => {
      const row = rows.find(({ artifact_id }) => artifact_id === ticket.id);
      if (!row) throw new Error(`${ticket.id} was not published with ${bug.id}`);
      await s.patchMilestone(project.id, n, { verify_round: m.verify_round + 1 });
      await ensureTask(s, ticketTask(project, n, row, ticket.fields as TicketFields));
    });
    return;
  }

  const round = m.verify_round + 1;
  const inputs = [await latestPin(deps, project, specId(n)), await latestPin(deps, project, techId(n)), await latestPin(deps, project, testPlanId(n))];
  await store.atomically(async (s) => {
    await s.patchMilestone(project.id, n, { verify_round: round });
    await ensureTask(s, qaTask(project, n, round, inputs));
    await s.setMilestonePhase(project.id, n, 'verify');
  });
}

async function verify(deps: EngineDeps, project: ProjectRow, m: MilestoneRow, tasks: TaskRow[]): Promise<void> {
  const { store } = deps;
  const { n, verify_round: round, verify_cap: cap } = m;
  const qa = byId(tasks, `M${n}-QA-${round}`);
  if (qa?.state === 'cancelled') {
    await store.setMilestonePhase(project.id, n, 'build');
    return;
  }
  if (qa?.state !== 'done') return;

  // QA never verifies a human check, which stays unverified until the stakeholder judges it at milestone approval. Counting it would hold the milestone here for ever.
  const criteria = (await store.listCriteria(project.id, n)).filter((criterion) => !isHumanCheck(criterion));
  if (criteria.every(({ status }) => status === 'passing' || status === 'waived')) {
    const spec = await engReviewSpec(deps, project, m);
    await store.atomically(async (s) => {
      await ensureTask(s, spec);
      await s.setMilestonePhase(project.id, n, 'eng_review');
    });
    return;
  }
  if (round < cap) {
    await store.setMilestonePhase(project.id, n, 'build');
    return;
  }
  const failing = criteria.filter(({ status }) => status !== 'passing' && status !== 'waived').map(({ ac_id }) => ac_id);
  await holdQaCap(store, project, n, `Milestone ${n} still fails after ${round} QA rounds`, `These criteria don't pass: ${failing.join(', ')}. The milestone has used its ${cap} rounds.`);
}

// The Eng Lead reviews what QA passed against the Tech Design. Its work order carries the engine's own measure of each
// component, which is what holds an approve to the tests, and says whether polish from this round will be built.
export async function engReviewSpec(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, m: MilestoneRow): Promise<TaskSpec> {
  const { artifacts } = deps;
  const { n, verify_round: round } = m;
  const { from, to, rows } = await milestoneCoverage(deps, project, n);
  const budgets = structureOf(await artifacts.read(project, techId(n)))?.performance ?? [];
  const polished = (await artifacts.list(project.id)).filter((row) => row.type === 'ticket' && row.milestone === n && isPolishTicket(row.artifact_id)).map(({ artifact_id }) => artifact_id);
  const scope = await artifacts.latest(project.id, scopeId(n));
  const inputs = [
    await latestPin(deps, project, specId(n)),
    await latestPin(deps, project, techId(n)),
    ...(scope ? [pinOf(scope)] : []),
    await latestPin(deps, project, testPlanId(n)),
    await latestPin(deps, project, `QA-REPORT-M${n}-${round}`),
  ];
  const instructions = [
    `Review the code of milestone ${n}, ${from}..${to} on the integration branch, which QA has passed. Judge it against the Tech Design: its components, their tests and its performance budgets. Approve it, or file polish tickets for what falls short.`,
    '',
    "What each component changed, by the engine's measure. You can approve only when no component is untested:",
    '',
    rows.length > 0 ? coverageTable(rows) : 'The Tech Design names no components.',
    '',
    ...(budgets.length > 0 ? ['Report each of these budgets once, by its metric:', '', ...budgets.map(({ metric, target, how_measured }) => `- ${metric}: ${target}, measured by ${how_measured}`)] : ['The Tech Design sets no performance budgets.']),
    '',
    `Polish tickets so far: ${polished.length > 0 ? polished.join(', ') : 'none'}. A new one takes a number none of them has.`,
    '',
    m.eng_round < m.eng_cap ? 'Polish tickets from this review will be built.' : 'This is the last polish round: polish tickets will not be built and open findings go to the stakeholder as known issues.',
  ].join('\n');
  return engReviewTask(project, n, round, inputs, instructions);
}

// Polish goes back to build while the rounds last, and costs QA none of its rounds. Otherwise the PM writes the
// milestone up, and a polish verdict that the last round can't build reaches the stakeholder as known issues.
async function engReview(deps: EngineDeps, project: ProjectRow, m: MilestoneRow, tasks: TaskRow[]): Promise<void> {
  const { store, artifacts } = deps;
  const { n, verify_round: round } = m;
  const task = byId(tasks, `M${n}-ENGREV-${round}`);
  if (task?.state === 'cancelled') {
    await store.setMilestonePhase(project.id, n, 'build');
    return;
  }
  if (task?.state !== 'done') return;
  const review = await artifacts.latest(project.id, engReviewId(n, round));
  if (!review) throw new Error(`${task.ticket_id} finished without ${engReviewId(n, round)}`);
  const { verdict } = (await artifacts.read(project, pinOf(review))).fields.data as EngReviewData;

  if (verdict === 'polish' && m.eng_round < m.eng_cap) {
    await store.atomically(async (s) => {
      await s.patchMilestone(project.id, n, { eng_round: m.eng_round + 1, verify_cap: m.verify_cap + 1 });
      await s.setMilestonePhase(project.id, n, 'build');
    });
    return;
  }
  const inputs = [await latestPin(deps, project, specId(n)), await latestPin(deps, project, techId(n)), await latestPin(deps, project, testPlanId(n)), await latestPin(deps, project, `QA-REPORT-M${n}-${round}`), pinOf(review)];
  const note = verdict === 'polish' ? `No polish round is left to build what ${review.artifact_id} asked for: list its findings and polish tickets under known_issues.` : undefined;
  await store.atomically(async (s) => {
    await ensureTask(s, milestoneReviewTask(project, n, round, inputs, note));
    await s.setMilestonePhase(project.id, n, 'milestone_review');
  });
}

// CP4 shows only so many of the eng review's budgets and findings; the review itself is pinned beside them.
const ENG_ROWS = 10;
const findingText = ({ severity, file, line, issue }: EngFinding) => `${oneLine(severity)} ${oneLine(file)}${line === null ? '' : `:${line}`}: ${oneLine(issue)}`;

async function engEvidence(deps: EngineDeps, project: ProjectRow, n: number, round: number, tasks: TaskRow[]): Promise<{ pins: string[]; rows: { label: string; value: string }[]; unbuilt: boolean }> {
  // A milestone that was past its eng review before the engine had one has none to show.
  const review = await deps.artifacts.latest(project.id, engReviewId(n, round));
  if (!review) return { pins: [], rows: [], unbuilt: false };
  const { verdict, performance, findings } = (await deps.artifacts.read(project, pinOf(review))).fields.data as EngReviewData;
  // A polish verdict only gets this far when no round was left to build it.
  const unbuilt = verdict === 'polish';
  const task = byId(tasks, `M${n}-ENGREV-${round}`);
  const note = task ? await noteOf(deps.store, task.id) : '';
  const label = unbuilt ? 'polish, not built' : verdict;
  const detail = [
    ...performance.map(({ metric, target, measured, status }) => ({ label: `Budget: ${oneLine(metric)}`, value: `${status}: ${oneLine(measured)} against ${oneLine(target)}` })),
    ...findings.map((finding) => ({ label: unbuilt ? 'Known issue' : 'Finding', value: findingText(finding) })),
  ];
  const more = detail.length > ENG_ROWS ? [{ label: 'More', value: `${detail.length - ENG_ROWS} more in ${pinOf(review)}` }] : [];
  return { pins: [pinOf(review)], rows: [{ label: 'Eng review', value: note === '' ? label : `${label}: ${oneLine(note)}` }, ...detail.slice(0, ENG_ROWS), ...more], unbuilt: unbuilt && findings.length > 0 };
}

async function afterMilestoneReview(deps: EngineDeps, project: ProjectRow, m: MilestoneRow, tasks: TaskRow[]): Promise<void> {
  const { store, artifacts } = deps;
  const { n, verify_round: round } = m;
  const task = byId(tasks, `M${n}-REVIEW-${round}`);
  if (task?.state === 'cancelled') {
    await store.setMilestonePhase(project.id, n, 'build');
    return;
  }
  if (task?.state !== 'done') return;
  if (await requestOpen(deps, project)) return;

  const synced = await syncBaseIntoIntegration(project.repo_path, n, project.base_branch);
  if (!synced.ok) {
    await holdBaseConflict(store, project, n, synced.conflicts);
    return;
  }
  const review = await artifacts.latest(project.id, reviewId(n));
  if (!review) throw new Error(`${task.ticket_id} finished without ${reviewId(n)}`);
  const eng = await engEvidence(deps, project, n, round, tasks);
  const pins = [pinOf(review), await latestPin(deps, project, specId(n)), await latestPin(deps, project, `QA-REPORT-M${n}-${round}`), ...eng.pins];
  const recommendation = await noteOf(store, task.id);
  const checks = (await store.listCriteria(project.id, n)).filter(isHumanCheck).map(({ ac_id, text, verification }) => ({ ac: ac_id, text, how: verification.how }));
  // The stakeholder tries the milestone as it stands, not as the base was when they last looked, so the checkout is made after the sync.
  const { headSha } = await ensureIntegrationBranch(project.repo_path, n, project.base_branch);
  const tryIt = await offerTry(deps, project, n, headSha);
  const k = checks.length;
  await store.atomically(async (s) => {
    await s.raiseInbox({
      project_id: project.id,
      milestone: n,
      type: 'approval',
      dedupe_key: `cp4:M${n}:${review.version}`,
      ref: { kind: 'cp4', milestone: n },
      title: `Approve milestone ${n} to merge into ${project.base_branch}`,
      asked_by: 'pm',
      why: `${k > 0 ? 'Every automated criterion passed QA.' : 'Every acceptance criterion passed QA.'}${eng.unbuilt ? " The Eng Lead's last polish round was left unbuilt, so its findings are listed below as known issues." : ''} Nothing reaches ${project.base_branch} until you approve.${k > 0 ? ` Check the ${k} item${k === 1 ? '' : 's'} below yourself before approving.` : ''}${tryIt.link ? '' : ` ${DISPOSABLE}`}`,
      blocks: [`Merging milestone ${n}`],
      evidence: [
        ...pins.map((pin) => ({ label: pin.split('@')[0]!, value: pin, pin })),
        { label: 'Branch', value: `aiteam/m${n} at ${headSha.slice(0, 7)}` },
        { label: TRY_IT, value: tryIt.value },
        ...eng.rows,
      ],
      recommendation,
      options: [],
      checks,
    });
    await s.setMilestonePhase(project.id, n, 'cp4');
  });
}

async function merging(deps: EngineDeps, project: ProjectRow, { n }: MilestoneRow): Promise<void> {
  const { store, paths } = deps;
  if (await requestOpen(deps, project)) return;
  // Approval only gets here with every criterion judged, by QA or by the stakeholder at CP4. A milestone pushed to this phase any other way would put unchecked work on the base branch.
  const unverified = (await store.listCriteria(project.id, n)).filter(({ status }) => status !== 'passing' && status !== 'waived').map(({ ac_id }) => ac_id);
  if (unverified.length > 0) throw new Error(`Milestone ${n} can't merge: ${unverified.join(', ')} not verified`);
  const synced = await syncBaseIntoIntegration(project.repo_path, n, project.base_branch);
  if (!synced.ok) {
    await holdBaseConflict(store, project, n, synced.conflicts);
    return;
  }
  const { sha } = await snapshotState(project.repo_path, n, stateRepoDir(paths, project.name), worktreePath(paths, project.name, `M${n}-snapshot`, 1));
  const advanced = await advanceBaseBranch(project.repo_path, project.base_branch, sha);
  if (!advanced.ok) {
    // The stakeholder committed in the window. The next tick merges that in and tries again.
    if (advanced.reason === 'moved') return;
    await hold(store, project, n, 'base_refused', `Git refused to move ${project.base_branch} to milestone ${n}`, advanced.detail, `Commit or stash your changes in ${project.repo_path}, then retry. Nothing is half done.`);
    return;
  }
  // What was tried is now on the base branch, so the checkout has nothing left to show.
  await removeTryWorktree(deps, project, n);
  await store.atomically(async (s) => {
    await s.setMilestonePhase(project.id, n, 'merged');
    const others = await s.listMilestones(project.id);
    if (others.every((other) => other.phase === 'merged')) await s.setProjectPhase(project.id, 'closed');
  });
}

// One step per tick, for the lowest milestone not merged. Each step reads SQLite and acts only when the row says to, so a re-run after a crash is safe.
export async function advanceMilestone(deps: EngineDeps, runner: Runner, project: ProjectRow): Promise<void> {
  if (project.phase !== 'active') return;
  const { store } = deps;
  const m = (await store.listMilestones(project.id)).find(({ phase }) => phase !== 'merged');
  if (!m) return;
  for (const kind of HOLD_KINDS) if (await openHold(store, project, `${kind}:M${m.n}`)) return;

  const tasks = await store.listTasks(project.id);
  const own = tasks.filter(({ milestone }) => milestone === m.n);
  switch (m.phase) {
    case 'pending':
      return setPending(deps, project, m);
    case 'spec':
      return afterSpec(deps, project, m, own);
    case 'design':
      return design(deps, project, m, own);
    case 'build':
      return build(deps, runner, project, m, tasks);
    case 'verify':
      return verify(deps, project, m, own);
    case 'eng_review':
      return engReview(deps, project, m, own);
    case 'milestone_review':
      return afterMilestoneReview(deps, project, m, own);
    case 'cp4':
      return serveTryAgain(deps, project, m.n);
    case 'merging':
      return merging(deps, project, m);
    default:
  }
}
