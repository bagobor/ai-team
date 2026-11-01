import { homedir } from 'node:os';
import { runSandboxed } from '../../checks/run-checks.ts';
import { advanceBaseBranch, snapshotState, syncBaseIntoIntegration } from '../../git/merge.ts';
import { addAttemptWorktree, ensureIntegrationBranch, removeAttemptWorktree } from '../../git/workspace.ts';
import { stateRepoDir, workerDenyRead, worktreePath } from '../../paths.ts';
import { ENV_PROFILE, reviewId, specId, testPlanId } from '../apply/ids.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { MilestoneRow, ProjectRow, Store, TaskRow } from '../store.ts';
import { ensureTask, isClosed, latestPin, milestoneReviewTask, noteOf, pinOf, qaTask, raiseHold, RETRY_OR_HALT, roundId, roundOf, specTask, techTask, testPlanTask, ticketTask, openHold, type TaskSpec, type TicketFields } from './tasks.ts';

type HoldKind = 'smoke' | 'base_conflict' | 'base_refused';

const HOLD_KINDS = ['smoke', 'base_conflict', 'base_refused', 'qa_cap'] as const;
const STALE_BLOCKS: readonly string[] = ['tech_design', 'test_plan', 'ticket'];

const byId = (tasks: TaskRow[], id: string) => tasks.find(({ ticket_id }) => ticket_id === id);

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

// Runs in a worktree of its own at the integration head, with the same setup a ticket gets, and leaves nothing behind.
async function runSmoke(deps: EngineDeps, project: ProjectRow, n: number): Promise<{ ok: true } | { ok: false; why: string }> {
  const { commands, setup } = (await deps.artifacts.read(project, ENV_PROFILE)).fields.data as { commands: { smoke: string }; setup: string | null };
  const { headSha } = await ensureIntegrationBranch(project.repo_path, n, project.base_branch);
  const worktree = worktreePath(deps.paths, project.name, `M${n}-smoke`, 1);
  const branch = `aiteam/smoke/M${n}`;
  await removeAttemptWorktree(project.repo_path, worktree, branch);
  await addAttemptWorktree(project.repo_path, worktree, branch, headSha);
  try {
    const env = { worktree, repoPath: project.repo_path, denyRead: workerDenyRead(deps.paths, homedir()), timeoutS: deps.config.checkTimeoutS, onEvent: () => {} };
    if (setup) {
      const prepared = await runSandboxed({ ...env, network: true, commands: [setup] });
      if (!prepared.ok) return { ok: false, why: prepared.evidence };
    }
    const smoke = await runSandboxed({ ...env, commands: [commands.smoke] });
    return smoke.ok ? { ok: true } : { ok: false, why: smoke.evidence };
  } finally {
    await removeAttemptWorktree(project.repo_path, worktree, branch);
  }
}

async function newTicketSpecs(deps: EngineDeps, project: ProjectRow, n: number, tasks: TaskRow[]): Promise<TaskSpec[]> {
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
    if ((task.kind === 'qa_verify' || task.purpose === 'milestone_review') && !isClosed(task)) await runner.cancel(task.id);
  }

  const specs = await newTicketSpecs(deps, project, n, tasks);
  if (specs.length > 0) {
    await store.atomically(async (s) => {
      for (const spec of specs) await ensureTask(s, spec);
    });
    return;
  }

  if (!own.filter(({ kind }) => kind === 'ticket').every(isClosed)) return;
  if (own.some(({ purpose, state }) => (purpose === 'revise_design' || purpose === 'revise_test_plan') && !isClosed({ state }))) return;
  if (tasks.some(({ purpose, state }) => purpose === 'cr_recommendation' && !isClosed({ state }))) return;
  // A stale Spec doesn't count: nothing revises one, so it would hold the milestone for ever. It still shows in Documents.
  if ((await artifacts.list(project.id)).some((row) => row.milestone === n && row.status === 'stale' && STALE_BLOCKS.includes(row.type))) return;

  const round = m.verify_round + 1;
  const inputs = [await latestPin(deps, project, specId(n)), await latestPin(deps, project, testPlanId(n))];
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

  const criteria = await store.listCriteria(project.id, n);
  if (criteria.every(({ status }) => status === 'passing' || status === 'waived')) {
    const inputs = [await latestPin(deps, project, specId(n)), await latestPin(deps, project, testPlanId(n)), await latestPin(deps, project, `QA-REPORT-M${n}-${round}`)];
    await store.atomically(async (s) => {
      await ensureTask(s, milestoneReviewTask(project, n, round, inputs));
      await s.setMilestonePhase(project.id, n, 'milestone_review');
    });
    return;
  }
  if (round < cap) {
    await store.setMilestonePhase(project.id, n, 'build');
    return;
  }
  const failing = criteria.filter(({ status }) => status !== 'passing' && status !== 'waived').map(({ ac_id }) => ac_id);
  await raiseHold(store, project, `qa_cap:M${n}`, {
    milestone: n,
    type: 'question',
    ref: { kind: 'qa_cap', milestone: n },
    title: `Milestone ${n} still fails after ${round} QA rounds`,
    asked_by: 'engine',
    why: `These criteria don't pass: ${failing.join(', ')}. The milestone has used its ${cap} rounds.`,
    blocks: [`Milestone ${n}`],
    evidence: [],
    recommendation: 'Give it three more rounds if the failures look close to fixed, otherwise halt and look at the Bug reports.',
    options: [
      { id: 'more', label: 'Three more rounds' },
      { id: 'halt', label: 'Halt' },
    ],
  });
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

  const synced = await syncBaseIntoIntegration(project.repo_path, n, project.base_branch);
  if (!synced.ok) {
    await holdBaseConflict(store, project, n, synced.conflicts);
    return;
  }
  const review = await artifacts.latest(project.id, reviewId(n));
  if (!review) throw new Error(`${task.ticket_id} finished without ${reviewId(n)}`);
  const pins = [pinOf(review), await latestPin(deps, project, specId(n)), await latestPin(deps, project, `QA-REPORT-M${n}-${round}`)];
  const recommendation = await noteOf(store, task.id);
  await store.atomically(async (s) => {
    await s.raiseInbox({
      project_id: project.id,
      milestone: n,
      type: 'approval',
      dedupe_key: `cp4:M${n}:${review.version}`,
      ref: { kind: 'cp4', milestone: n },
      title: `Approve milestone ${n} to merge into ${project.base_branch}`,
      asked_by: 'pm',
      why: `Every acceptance criterion passed QA. Nothing reaches ${project.base_branch} until you approve.`,
      blocks: [`Merging milestone ${n}`],
      evidence: pins.map((pin) => ({ label: pin.split('@')[0]!, value: pin, pin })),
      recommendation,
      options: [],
    });
    await s.setMilestonePhase(project.id, n, 'cp4');
  });
}

async function merging(deps: EngineDeps, project: ProjectRow, { n }: MilestoneRow): Promise<void> {
  const { store, paths } = deps;
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
    case 'milestone_review':
      return afterMilestoneReview(deps, project, m, own);
    case 'merging':
      return merging(deps, project, m);
    default:
  }
}
