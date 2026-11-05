import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { openDb } from '../src/db/open.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import { fileChangeRequest } from '../src/engine/change-requests.ts';
import { applyAnswers } from '../src/engine/conductor/answers.ts';
import { Conductor, haltProject } from '../src/engine/conductor/index.ts';
import { addProject } from '../src/engine/intake.ts';
import { AlreadyAnswered, type InboxRef, type InboxRow } from '../src/engine/inbox.ts';
import { Runner } from '../src/engine/runner.ts';
import { Store, type ProjectRow, type TaskRow } from '../src/engine/store.ts';
import type { WorkOrder } from '../src/engine/workorder.ts';
import { EventLog } from '../src/events.ts';
import { mergeIntoBranch } from '../src/git/merge.ts';
import { addAttemptWorktree, snapshotAttempt } from '../src/git/workspace.ts';
import { worktreePath } from '../src/paths.ts';
import { CRITERIA, projectOf } from './helpers/apply.ts';
import { eventTypes, makeEngine, ticket, type TestEngine } from './helpers/engine.ts';
import { commitAll, makeRepo, porcelain, revParse, run } from './helpers/repo.ts';

const DISCOVERY = {
  roadmap: { body: '# Roadmap\n', milestones: [{ n: 1, title: 'First', goal: 'Start' }, { n: 2, title: 'Second', goal: 'Finish' }] },
  team_proposal: { body: '# Team\n' },
  human_requirements: { body: '# Needs\n' },
  stakeholder_note: 'Please look at the roadmap',
};
const ONE_MILESTONE = { ...DISCOVERY, roadmap: { body: '# Roadmap\n', milestones: [{ n: 1, title: 'Only', goal: 'All of it' }] } };
const PROFILE = { body: '# Environment\n', commands: { build: 'true', test: 'true', lint: 'true', smoke: 'echo smoke-ok' }, toolchains: ['node 22'], network_allow: [], setup: null, stakeholder_note: 'The toolchain is ready' };
const SPEC = { body: '# Milestone one\n\n## Scope\n\nSmall.\n', criteria: CRITERIA, stakeholder_note: 'The spec is small' };
const draft = (key: string, ac_refs: string[]) => ({ key, title: key, specialty: 'engineer', ac_refs, touches: ['src/**'], depends_on: [], definition_of_done: ['true'], inputs: [], size: 'S', body: 'Do it.\n' });
const ONE_TICKET = { body: '# Design\n', tickets: [draft('T-1', ['AC-1', 'AC-2'])] };
const TWO_TICKETS = { body: '# Design\n', tickets: [draft('T-1', ['AC-1']), draft('T-2', ['AC-2'])] };
const TEST_PLAN = { body: '# Test plan\n', coverage: CRITERIA.map(({ id }) => ({ ac: id, commands: ['true'], notes: '' })), harness_tickets: [] };
const APPROVE = { verdict: 'approve', summary: 'Fine', findings: [] };
const PASS = { results: CRITERIA.map(({ id }) => ({ ac: id, status: 'passing', commands: [], notes: '' })), bugs: [], summary: 'All good' };
const failing = (ac: string) => ({
  results: CRITERIA.map(({ id }) => ({ ac: id, status: id === ac ? 'failing' : 'passing', commands: [], notes: '' })),
  bugs: [{ ac, title: `${ac} is broken`, description: 'It does not work', touches: ['src/**'], commands: [] }],
  summary: 'One failure',
});
const REVIEW = { body: '# How it went\n', known_issues: [], deviations: [], stakeholder_note: 'Ship it' };
const revised = (ticket_decisions: { ticket: string; decision: string; rationale: string }[] = [], tickets: unknown[] = []) => ({ unaffected: true, rationale: 'Still right', body: null, coverage: null, ticket_decisions, tickets });
const stillValid = (ticket: string) => ({ ticket, decision: 'still_valid', rationale: 'Still right' });
const criterionChange = { target_artifact: 'SPEC-M1', target_ac: 'AC-1', proposed_text: 'The first thing works faster', rationale: 'It was too slow', evidence: 'A timing run', raised_by: 'engineer' };
const scopeChange = { target_artifact: 'SPEC-M1', target_section: 'scope', proposed_text: 'Smaller.', rationale: 'Less to do', evidence: 'A look at the code', raised_by: 'engineer' };

type Harness = TestEngine & { conductor: Conductor; project: ProjectRow };
type Restarted = Harness;

const open: TestEngine[] = [];
const reopened: { destroy(): Promise<void> }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of reopened.splice(0)) await db.destroy();
  for (const e of open.splice(0)) await e.cleanup();
});

async function harness(): Promise<Harness> {
  const e = await makeEngine({ steps: [] });
  open.push(e);
  return Object.assign(e, { conductor: new Conductor(e, e.runner), project: await projectOf(e) });
}

// What a restart leaves: the same files and database, and nothing in memory. No tick has run yet.
async function reopen(h: Harness): Promise<Restarted> {
  const db = await openDb(h.paths.db);
  reopened.push(db);
  const log = new EventLog(db);
  const store = new Store(db, log);
  const deps = { ...h, db, log, store, artifacts: new ArtifactStore(store, h.paths) };
  const runner = new Runner(deps);
  return { ...deps, runner, conductor: new Conductor(deps, runner) };
}

const byTicket = async (h: Harness, id: string): Promise<TaskRow> => {
  const task = await h.store.getTaskByTicket(h.project.id, id);
  if (!task) throw new Error(`No task ${id}. There are: ${(await h.store.listTasks(h.project.id)).map((t) => t.ticket_id).join(', ')}`);
  return task;
};
const orderOf = (task: TaskRow) => task.work_order as WorkOrder;
const ticketIds = async (h: Harness) => (await h.store.listTasks(h.project.id)).filter((t) => t.kind === 'ticket').map((t) => t.ticket_id);
const taskIds = async (h: Harness) => (await h.store.listTasks(h.project.id)).map((t) => t.ticket_id);
const phaseOf = async (h: Harness) => (await h.store.getProjectById(h.project.id))!.phase;
const milestonePhase = async (h: Harness, n = 1) => (await h.store.getMilestone(h.project.id, n))!.phase;
const statusOf = async (h: Harness, id: string) => (await h.artifacts.latest(h.project.id, id))!.status;
const decisionRecords = async (h: Harness) => (await h.artifacts.list(h.project.id)).filter((row) => row.type === 'decision_record');
const inboxOf = (h: Harness, kind: InboxRef['kind']) => h.store.listInbox({ projectId: h.project.id }).then((items) => items.filter((item) => item.ref.kind === kind));

async function pending(h: Harness, kind: InboxRef['kind']): Promise<InboxRow> {
  const found = (await inboxOf(h, kind)).filter((item) => item.state === 'pending');
  expect(found).toHaveLength(1);
  return found[0]!;
}

async function advanceTo(h: Harness, taskId: number, states: TaskRow['state'][]): Promise<void> {
  const task = (await h.store.getTask(taskId))!;
  for (const state of states.slice(Math.max(0, states.indexOf(task.state) + 1))) await h.store.setTaskState(taskId, state);
}

async function baseShaOf(h: Harness, task: TaskRow): Promise<string> {
  const { base } = orderOf(task);
  if (base.kind === 'sha') return base.sha;
  return revParse(h.repoPath, base.kind === 'base' ? 'refs/heads/main' : `refs/heads/aiteam/m${task.milestone}`);
}

// Takes a task to done through the real applier, as the runner would.
async function finish(h: Harness, id: string, output: unknown): Promise<void> {
  const task = await byTicket(h, id);
  await advanceTo(h, task.id, ['ready', 'running', 'checks']);
  const { id: attemptId } = await h.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: h.repoPath, branch: 'b', base_sha: await baseShaOf(h, task) });
  await h.store.setAttemptState(attemptId, 'running');
  await h.store.patchAttempt(attemptId, { output });
  const project = await projectOf(h);
  const result = await applyOutput({ deps: h, project, task: (await h.store.getTask(task.id))!, attempt: (await h.store.getAttempt(attemptId))!, order: orderOf(task), output, worktree: h.repoPath, signal: new AbortController().signal, report: { onEvent: () => {}, onSpawn: () => {} } });
  if (!result.ok) throw new Error(`${id} was refused: ${result.evidence}`);
  await h.artifacts.commit(project, result.change, async (s, rows) => {
    await s.setAttemptState(attemptId, 'succeeded');
    await s.setTaskState(task.id, 'done');
    await result.after?.(s, rows);
  });
}

// Takes a ticket to review with a real commit on its own branch, as the runner would.
async function toReview(h: Harness, id: string, files: Record<string, string> = { [`src/${id}.txt`]: 'work\n' }): Promise<{ attemptId: number; head: string; worktree: string; k: number }> {
  const task = await byTicket(h, id);
  await advanceTo(h, task.id, ['ready', 'running']);
  const k = await h.store.nextAttemptK(task.id);
  const worktree = worktreePath(h.paths, 'p', id, k);
  const branch = `aiteam/attempt/${id}-a${k}`;
  const base = await revParse(h.repoPath, `refs/heads/aiteam/m${task.milestone}`);
  await addAttemptWorktree(h.repoPath, worktree, branch, base);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
  const { headSha: head } = await snapshotAttempt(h.repoPath, worktree, 'work');
  const { id: attemptId } = await h.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: worktree, branch, base_sha: base });
  await h.store.setAttemptState(attemptId, 'running');
  await h.store.patchAttempt(attemptId, { head_sha: head });
  await h.store.setAttemptState(attemptId, 'succeeded');
  const ticket = await h.artifacts.latest(h.project.id, id);
  await h.artifacts.commit(h.project, {
    message: 'change report',
    publish: [{ id: `CHANGE-${id}-a${k}`, type: 'change_report', status: 'approved', approvedBy: 'owner:engineer', ownerRole: 'engineer', derivedFrom: ticket ? [`${id}@${ticket.version}`] : [], milestone: task.milestone, body: '# Change\n' }],
  });
  await advanceTo(h, task.id, ['running', 'checks', 'review']);
  return { attemptId, head, worktree, k };
}

function commitOn(h: Harness, branch: string, files: Record<string, string>): void {
  const worktree = join(h.paths.worktrees, `commit-${Date.now()}`);
  mkdirSync(dirname(worktree), { recursive: true });
  run(h.repoPath, 'worktree', 'add', '-q', worktree, branch);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), content);
  }
  commitAll(worktree, 'someone else');
  run(h.repoPath, 'worktree', 'remove', '--force', worktree);
}

const hasCommit = (h: Harness, sha: string, ref: string) => {
  try {
    run(h.repoPath, 'merge-base', '--is-ancestor', sha, ref);
    return true;
  } catch {
    return false;
  }
};

async function addBrief(h: Harness): Promise<void> {
  await h.artifacts.commit(h.project, { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
}

type Flow = { discovery?: unknown; profile?: unknown; design?: unknown; plan?: unknown };

async function toCp1(h: Harness, flow: Flow = {}): Promise<InboxRow> {
  await addBrief(h);
  await h.conductor.tick();
  await finish(h, 'DISCOVERY-PM', flow.discovery ?? DISCOVERY);
  await finish(h, 'DISCOVERY-TL', flow.profile ?? PROFILE);
  await h.conductor.tick();
  return pending(h, 'cp1');
}

async function toCp2(h: Harness, flow: Flow = {}): Promise<InboxRow> {
  const cp1 = await toCp1(h, flow);
  await h.store.answerInbox(cp1.id, { action: 'approve' });
  await h.conductor.tick();
  await finish(h, 'M1-SPEC', SPEC);
  await h.conductor.tick();
  return pending(h, 'cp2');
}

async function toDesign(h: Harness, flow: Flow = {}): Promise<void> {
  const cp2 = await toCp2(h, flow);
  await h.store.answerInbox(cp2.id, { action: 'approve' });
  await h.conductor.tick();
}

async function toBuild(h: Harness, flow: Flow = {}): Promise<void> {
  await toDesign(h, flow);
  await finish(h, 'M1-TECH', flow.design ?? ONE_TICKET);
  await finish(h, 'M1-TESTPLAN', flow.plan ?? TEST_PLAN);
  await h.conductor.tick();
}

async function mergeTicket(h: Harness, id: string, files?: Record<string, string>): Promise<void> {
  const { k } = await toReview(h, id, files);
  await h.conductor.tick();
  await finish(h, `${id}-R${k}`, APPROVE);
  await h.conductor.tick();
}

async function toVerify(h: Harness, flow: Flow = {}): Promise<void> {
  await toBuild(h, flow);
  await mergeTicket(h, 'M1-T-1');
  await h.conductor.tick();
}

async function toCp4(h: Harness, flow: Flow = {}, files?: Record<string, string>): Promise<InboxRow> {
  await toBuild(h, flow);
  await mergeTicket(h, 'M1-T-1', files);
  await h.conductor.tick();
  await finish(h, 'M1-QA-1', PASS);
  await h.conductor.tick();
  await finish(h, 'M1-REVIEW-1', REVIEW);
  await h.conductor.tick();
  return pending(h, 'cp4');
}

// A change the owner decides, from filing to applied.
async function ownerApplies(h: Harness, request: Parameters<typeof fileChangeRequest>[2]): Promise<string> {
  const { artifact_id: id } = await fileChangeRequest(h, h.project, request);
  await h.conductor.tick();
  await finish(h, `${id}-REC`, { decision: 'approve', rationale: 'Yes' });
  await h.conductor.tick();
  return id;
}

// A criterion change, from filing to applied by the stakeholder.
async function stakeholderApplies(h: Harness, request: Parameters<typeof fileChangeRequest>[2] = criterionChange): Promise<string> {
  const { artifact_id: id } = await fileChangeRequest(h, h.project, request);
  await h.conductor.tick();
  await finish(h, `${id}-REC`, { decision: 'approve', rationale: 'Yes' });
  await h.conductor.tick();
  await h.store.answerInbox((await pending(h, 'cr')).id, { action: 'approve' });
  await h.conductor.tick();
  return id;
}

describe('flow', () => {
  it('starts discovery from a brief, with the Tech Lead after the PM', async () => {
    const h = await harness();
    await h.conductor.tick();
    expect(await taskIds(h)).toEqual([]);
    expect(await phaseOf(h)).toBe('intake');

    await addBrief(h);
    await h.conductor.tick();

    const pm = await byTicket(h, 'DISCOVERY-PM');
    const tl = await byTicket(h, 'DISCOVERY-TL');
    expect([pm.role_id, pm.purpose, orderOf(pm).inputs, orderOf(pm).base]).toEqual(['pm', 'discovery', ['BRIEF@1'], { kind: 'base' }]);
    expect([tl.role_id, tl.purpose, tl.depends_on]).toEqual(['tech_lead', 'environment_profile', ['DISCOVERY-PM']]);
    expect(await phaseOf(h)).toBe('discovery');
  });

  it('raises CP1 once with all four documents as evidence', async () => {
    const h = await harness();
    const cp1 = await toCp1(h);
    await h.conductor.tick();
    await h.conductor.tick();

    expect(await inboxOf(h, 'cp1')).toHaveLength(1);
    expect(cp1.dedupe_key).toBe('cp1:1');
    expect(cp1.type).toBe('approval');
    expect(cp1.evidence.map(({ pin }) => pin).sort()).toEqual(['ENV-PROFILE@1', 'HUMAN-REQUIREMENTS@1', 'ROADMAP@1', 'TEAM-PROPOSAL@1']);
    expect(cp1.recommendation).toContain('Please look at the roadmap');
    expect(cp1.blocks).toEqual(['Milestone 1']);
    expect(await phaseOf(h)).toBe('cp1');
  });

  it('runs nothing past discovery until CP1 is approved', async () => {
    const h = await harness();
    await toCp1(h);
    await h.conductor.tick();
    await h.conductor.tick();

    expect(await taskIds(h)).toEqual(['DISCOVERY-PM', 'DISCOVERY-TL']);
    expect(await h.store.listMilestones(h.project.id)).toEqual([]);
  });

  it('creates milestones and starts the first spec on CP1 approval', async () => {
    const h = await harness();
    const cp1 = await toCp1(h);
    await h.store.answerInbox(cp1.id, { action: 'approve' });
    await h.conductor.tick();

    const milestones = await h.store.listMilestones(h.project.id);
    expect(milestones.map(({ n, title, phase }) => [n, title, phase])).toEqual([[1, 'First', 'spec'], [2, 'Second', 'pending']]);
    expect(await phaseOf(h)).toBe('active');
    for (const id of ['ROADMAP', 'TEAM-PROPOSAL', 'HUMAN-REQUIREMENTS', 'ENV-PROFILE']) expect((await h.artifacts.latest(h.project.id, id))!).toMatchObject({ status: 'approved', approved_by: 'stakeholder' });

    const spec = await byTicket(h, 'M1-SPEC');
    expect([spec.role_id, spec.purpose, orderOf(spec).inputs, orderOf(spec).base]).toEqual(['pm', 'milestone_spec', ['ROADMAP@1', 'HUMAN-REQUIREMENTS@1'], { kind: 'base' }]);
    expect(await taskIds(h)).not.toContain('M2-SPEC');
  });

  it('redoes discovery with the comment on Request changes', async () => {
    const h = await harness();
    const cp1 = await toCp1(h);
    await h.store.answerInbox(cp1.id, { action: 'request_changes', comment: 'Fewer milestones' });
    await h.conductor.tick();

    const pm = await byTicket(h, 'DISCOVERY-PM-r2');
    const tl = await byTicket(h, 'DISCOVERY-TL-r2');
    expect(orderOf(pm).comment).toBe('Fewer milestones');
    expect(orderOf(tl).comment).toBe('Fewer milestones');
    expect(tl.depends_on).toEqual(['DISCOVERY-PM-r2']);
    expect(await phaseOf(h)).toBe('discovery');
    expect(await inboxOf(h, 'cp1')).toHaveLength(1);

    await finish(h, 'DISCOVERY-PM-r2', DISCOVERY);
    await finish(h, 'DISCOVERY-TL-r2', PROFILE);
    await h.conductor.tick();
    const second = await pending(h, 'cp1');
    expect(second.dedupe_key).toBe('cp1:2');
    expect(second.evidence.map(({ pin }) => pin).sort()).toEqual(['ENV-PROFILE@2', 'HUMAN-REQUIREMENTS@2', 'ROADMAP@2', 'TEAM-PROPOSAL@2']);

    await h.store.answerInbox(second.id, { action: 'approve' });
    await h.conductor.tick();
    // The second round's documents read the first round's, and approving them must not make them stale.
    for (const id of ['ROADMAP', 'TEAM-PROPOSAL', 'HUMAN-REQUIREMENTS', 'ENV-PROFILE']) expect(await statusOf(h, id)).toBe('approved');
  });

  it('halts on Reject, cancels open tasks, and writes a Decision Record', async () => {
    const h = await harness();
    const cp1 = await toCp1(h);
    const open = await h.addTicket(ticket({ id: 'H-1' }));
    const stuck = await h.addTicket(ticket({ id: 'H-2' }));
    await h.store.setTaskState(stuck.id, 'escalated', { reason: 'attempts_exhausted' });
    await h.conductor.tick();
    const question = await pending(h, 'escalation');

    await h.store.answerInbox(cp1.id, { action: 'reject' });
    await h.conductor.tick();

    expect(await phaseOf(h)).toBe('halted');
    expect((await h.store.getTask(open.id))!.state).toBe('cancelled');
    expect((await h.store.getTask(stuck.id))!.state).toBe('cancelled');
    expect((await h.store.getInbox(question.id))!.state).toBe('withdrawn');
    const [record] = await decisionRecords(h);
    expect(record).toMatchObject({ artifact_id: `DEC-${cp1.id}`, status: 'approved', approved_by: 'stakeholder' });
    expect(record!.derived_from.sort()).toEqual(['ENV-PROFILE@1', 'HUMAN-REQUIREMENTS@1', 'ROADMAP@1', 'TEAM-PROPOSAL@1']);

    const before = await h.log.list({ projectId: h.project.id });
    await h.conductor.tick();
    expect(await h.log.list({ projectId: h.project.id })).toEqual(before);
  });

  it('halts every unfinished milestone', async () => {
    const h = await harness();
    const cp2 = await toCp2(h);
    await h.store.answerInbox(cp2.id, { action: 'reject' });
    await h.conductor.tick();

    expect(await phaseOf(h)).toBe('halted');
    expect((await h.store.listMilestones(h.project.id)).map(({ phase }) => phase)).toEqual(['halted', 'halted']);
  });

  it('halts from outside the Inbox, stopping tasks and withdrawing items', async () => {
    const h = await harness();
    const cp1 = await toCp1(h);
    const open = await h.addTicket(ticket({ id: 'H-1' }));

    await haltProject(h, h.runner, h.project, 'The stakeholder stopped it');

    expect(await phaseOf(h)).toBe('halted');
    expect((await h.store.getTask(open.id))!.state).toBe('cancelled');
    expect((await h.store.getInbox(cp1.id))!.state).toBe('withdrawn');
  });

  it('locks criteria on CP2 approval, and only then', async () => {
    const h = await harness();
    const cp2 = await toCp2(h);
    expect(cp2).toMatchObject({ dedupe_key: 'cp2:M1:1', milestone: 1, recommendation: 'The spec is small' });
    expect(cp2.evidence.map(({ pin }) => pin)).toEqual(['SPEC-M1@1']);
    await h.conductor.tick();
    expect(await h.store.listCriteria(h.project.id, 1)).toEqual([]);

    await h.store.answerInbox(cp2.id, { action: 'approve' });
    await h.conductor.tick();

    expect((await h.store.listCriteria(h.project.id, 1)).map(({ ac_id, text, status }) => [ac_id, text, status])).toEqual([['AC-1', 'The first thing works', 'unverified'], ['AC-2', 'The second thing works', 'unverified']]);
    expect(await statusOf(h, 'SPEC-M1')).toBe('approved');
    expect(run(h.repoPath, 'branch', '--list', 'aiteam/m1')).toContain('aiteam/m1');
    expect(await milestonePhase(h)).toBe('design');
  });

  it('redoes the spec with the comment on CP2 Request changes', async () => {
    const h = await harness();
    const cp2 = await toCp2(h);
    await h.store.answerInbox(cp2.id, { action: 'request_changes', comment: 'Less scope' });
    await h.conductor.tick();

    const redo = await byTicket(h, 'M1-SPEC-r2');
    expect(orderOf(redo).comment).toBe('Less scope');
    expect(await milestonePhase(h)).toBe('spec');

    await finish(h, 'M1-SPEC-r2', SPEC);
    await h.conductor.tick();
    expect((await pending(h, 'cp2')).dedupe_key).toBe('cp2:M1:2');
  });

  it('creates no ticket task before the design → build move', async () => {
    const h = await harness();
    await toDesign(h);
    const [tech, plan] = [await byTicket(h, 'M1-TECH'), await byTicket(h, 'M1-TESTPLAN')];
    expect([tech.role_id, tech.purpose, orderOf(tech).base]).toEqual(['tech_lead', 'tech_design', { kind: 'integration' }]);
    expect([plan.role_id, plan.purpose, orderOf(plan).base]).toEqual(['qa_engineer', 'test_plan', { kind: 'integration' }]);

    await finish(h, 'M1-TECH', ONE_TICKET);
    await h.conductor.tick();
    expect(await ticketIds(h)).toEqual([]);
    expect(await milestonePhase(h)).toBe('design');

    await finish(h, 'M1-TESTPLAN', TEST_PLAN);
    await h.conductor.tick();

    const row = (await h.artifacts.latest(h.project.id, 'M1-T-1'))!;
    expect(await byTicket(h, 'M1-T-1')).toMatchObject({ kind: 'ticket', role_id: 'engineer', dod: ['true'], touches: ['src/**'], depends_on: [], ac_refs: ['AC-1', 'AC-2'], ticket_path: row.path, ticket_sha: row.sha });
    expect(await milestonePhase(h)).toBe('build');
  });

  it('asks once when the smoke pre-flight fails, and retries on Retry', async () => {
    const h = await harness();
    // The Tech Lead's run sees this file. A fresh checkout of the integration branch won't.
    writeFileSync(join(h.repoPath, 'ready.txt'), 'yes\n');
    await toBuild(h, { profile: { ...PROFILE, commands: { ...PROFILE.commands, smoke: 'test -f ready.txt' } } });
    await h.conductor.tick();

    const hold = await pending(h, 'smoke');
    expect(hold.dedupe_key).toBe('smoke:M1:1');
    expect(hold.options.map(({ id }) => id)).toEqual(['retry', 'halt']);
    expect(await inboxOf(h, 'smoke')).toHaveLength(1);
    expect(await ticketIds(h)).toEqual([]);
    expect(await milestonePhase(h)).toBe('design');

    commitOn(h, 'aiteam/m1', { 'ready.txt': 'yes\n' });
    await h.store.answerInbox(hold.id, { option: 'retry' });
    await h.conductor.tick();

    expect(await ticketIds(h)).toEqual(['M1-T-1']);
    expect(await milestonePhase(h)).toBe('build');
    expect(await inboxOf(h, 'smoke')).toHaveLength(1);
  });

  it('leaves nothing behind after the smoke pre-flight', async () => {
    const h = await harness();
    await toBuild(h);

    expect(existsSync(worktreePath(h.paths, 'p', 'M1-smoke', 1))).toBe(false);
    expect(run(h.repoPath, 'branch', '--list', 'aiteam/smoke/*')).toBe('');
  });

  it('reviews a ticket, merges on approve, and marks it done', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    const { attemptId, head, worktree } = await toReview(h, 'M1-T-1');
    await h.conductor.tick();

    const review = await byTicket(h, 'M1-T-1-R1');
    expect([review.role_id, review.kind, review.purpose, review.parent_task_id]).toEqual(['code_reviewer', 'code_review', 'code_review', task.id]);
    expect(orderOf(review)).toMatchObject({ base: { kind: 'sha', sha: head }, inputs: ['M1-T-1@1', 'CHANGE-M1-T-1-a1@1'], subject: { ticketTaskId: task.id, attemptId } });
    expect((await h.store.getTask(task.id))!.state).toBe('review');
    expect(hasCommit(h, head, 'aiteam/m1')).toBe(false);

    await finish(h, 'M1-T-1-R1', APPROVE);
    await h.conductor.tick();

    expect((await h.store.getTask(task.id))!.state).toBe('done');
    expect(hasCommit(h, head, 'aiteam/m1')).toBe(true);
    expect(hasCommit(h, head, 'main')).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect((await h.store.getAttempt(attemptId))!.worktree_removed_at).not.toBeNull();
    expect(await eventTypes(h, task.id)).toContain('merge.done');
  });

  it('reviews a ticket added by hand, which has no artifact', async () => {
    const h = await harness();
    await h.store.setProjectPhase(h.project.id, 'discovery');
    const task = await h.addTicket(ticket({ id: 'H-1' }));
    run(h.repoPath, 'branch', 'aiteam/m1');
    await toReview(h, 'H-1');
    await h.conductor.tick();

    expect(orderOf(await byTicket(h, 'H-1-R1')).inputs).toEqual(['CHANGE-H-1-a1@1']);
    await finish(h, 'H-1-R1', APPROVE);
    await h.conductor.tick();
    expect((await h.store.getTask(task.id))!.state).toBe('done');
  });

  it('sends a ticket back with the report on changes_requested, then escalates at the cap', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    const rejected = { verdict: 'changes_requested', summary: 'Not yet', findings: [{ severity: 'high', file: 'src/a.ts', line: 3, issue: 'It drops the first row' }] };

    for (const k of [1, 2, 3]) {
      const { attemptId, worktree } = await toReview(h, 'M1-T-1');
      await h.conductor.tick();
      await finish(h, `M1-T-1-R${k}`, rejected);
      await h.conductor.tick();

      const attempt = (await h.store.getAttempt(attemptId))!;
      expect(attempt.failure_kind).toBe('changes_requested');
      expect(attempt.failure_evidence).toContain('It drops the first row');
      expect(existsSync(worktree)).toBe(false);
      expect((await h.store.getTask(task.id))!.state).toBe(k < 3 ? 'ready' : 'escalated');
    }
    expect((await h.store.getTask(task.id))!.escalation_reason).toContain('attempts_exhausted');
    expect((await pending(h, 'escalation')).options.map(({ id }) => id)).toEqual(['retry', 'cancel']);
  });

  it('starts a fresh attempt on a merge conflict', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    const { attemptId } = await toReview(h, 'M1-T-1', { 'src/a.txt': 'from the ticket\n' });
    commitOn(h, 'aiteam/m1', { 'src/a.txt': 'from elsewhere\n' });
    await h.conductor.tick();
    await finish(h, 'M1-T-1-R1', APPROVE);
    const before = await revParse(h.repoPath, 'refs/heads/aiteam/m1');
    await h.conductor.tick();

    expect((await h.store.getTask(task.id))!.state).toBe('ready');
    const attempt = (await h.store.getAttempt(attemptId))!;
    expect(attempt.failure_kind).toBe('merge_conflict');
    expect(attempt.failure_evidence).toContain('src/a.txt');
    expect(await revParse(h.repoPath, 'refs/heads/aiteam/m1')).toBe(before);
    expect(await eventTypes(h, task.id)).toContain('merge.conflict');
  });

  it('starts QA only when every ticket is done', async () => {
    const h = await harness();
    await toBuild(h, { design: TWO_TICKETS });
    await mergeTicket(h, 'M1-T-1');
    await h.conductor.tick();
    expect(await taskIds(h)).not.toContain('M1-QA-1');
    expect(await milestonePhase(h)).toBe('build');

    await mergeTicket(h, 'M1-T-2');
    await h.conductor.tick();

    const qa = await byTicket(h, 'M1-QA-1');
    expect([qa.role_id, qa.kind, qa.purpose, orderOf(qa).base, orderOf(qa).inputs]).toEqual(['qa_engineer', 'qa_verify', 'qa_verify', { kind: 'integration' }, ['SPEC-M1@1', 'TEST-PLAN-M1@1']]);
    expect((await h.store.getMilestone(h.project.id, 1))!).toMatchObject({ phase: 'verify', verify_round: 1 });
  });

  it('counts a cancelled ticket as finished for QA', async () => {
    const h = await harness();
    await toBuild(h, { design: TWO_TICKETS });
    await mergeTicket(h, 'M1-T-1');
    await h.runner.cancel((await byTicket(h, 'M1-T-2')).id);
    await h.conductor.tick();

    expect(await taskIds(h)).toContain('M1-QA-1');
  });

  it('turns QA failures into tickets and returns to build, then asks at the round cap', async () => {
    const h = await harness();
    await toVerify(h);
    await h.store.patchMilestone(h.project.id, 1, { verify_cap: 2 });

    await finish(h, 'M1-QA-1', failing('AC-1'));
    await h.conductor.tick();
    expect(await milestonePhase(h)).toBe('build');
    await h.conductor.tick();
    expect(await byTicket(h, 'M1-B-1')).toMatchObject({ kind: 'ticket', role_id: 'engineer', state: 'queued' });
    expect(await taskIds(h)).not.toContain('M1-QA-2');

    await mergeTicket(h, 'M1-B-1');
    await h.conductor.tick();
    await finish(h, 'M1-QA-2', failing('AC-1'));
    await h.conductor.tick();

    const hold = await pending(h, 'qa_cap');
    expect(hold.dedupe_key).toBe('qa_cap:M1:1');
    expect(hold.options.map(({ id, label }) => [id, label])).toEqual([['more', 'Three more rounds'], ['halt', 'Halt']]);
    expect(await milestonePhase(h)).toBe('verify');
    await h.conductor.tick();
    expect(await inboxOf(h, 'qa_cap')).toHaveLength(1);

    await h.store.answerInbox(hold.id, { option: 'more' });
    await h.conductor.tick();
    expect((await h.store.getMilestone(h.project.id, 1))!).toMatchObject({ phase: 'build', verify_cap: 5 });
    await h.conductor.tick();
    expect(await taskIds(h)).toContain('M1-B-2');
  });

  it('raises CP4 with the Milestone Review, and asks when the base conflicts', async () => {
    const clean = await harness();
    const cp4 = await toCp4(clean);
    expect(cp4).toMatchObject({ dedupe_key: 'cp4:M1:1', milestone: 1, recommendation: 'Ship it' });
    expect(cp4.evidence.map(({ pin }) => pin)).toEqual(['MILESTONE-REVIEW-M1@1', 'SPEC-M1@1', 'QA-REPORT-M1-1@1']);
    expect(await milestonePhase(clean)).toBe('cp4');

    const h = await harness();
    await toBuild(h);
    await mergeTicket(h, 'M1-T-1', { 'src/a.txt': 'from the ticket\n' });
    await h.conductor.tick();
    await finish(h, 'M1-QA-1', PASS);
    await h.conductor.tick();
    await finish(h, 'M1-REVIEW-1', REVIEW);
    mkdirSync(join(h.repoPath, 'src'), { recursive: true });
    writeFileSync(join(h.repoPath, 'src/a.txt'), 'from the stakeholder\n');
    commitAll(h.repoPath, 'the stakeholder kept working');
    await h.conductor.tick();

    const hold = await pending(h, 'base_conflict');
    expect(hold.why).toContain('src/a.txt');
    expect(hold.options.map(({ id }) => id)).toEqual(['retry', 'halt']);
    expect(await milestonePhase(h)).toBe('milestone_review');
    expect(await inboxOf(h, 'cp4')).toEqual([]);
  });

  it('asks when the base conflicts at the start of design', async () => {
    const h = await harness();
    const cp2 = await toCp2(h);
    await h.store.answerInbox(cp2.id, { action: 'approve' });
    // The integration branch exists from here on, and both sides now change one file.
    await applyAnswers(h, h.runner, await projectOf(h));
    commitOn(h, 'aiteam/m1', { 'src/a.txt': 'integration\n' });
    mkdirSync(join(h.repoPath, 'src'), { recursive: true });
    writeFileSync(join(h.repoPath, 'src/a.txt'), 'base\n');
    commitAll(h.repoPath, 'the stakeholder kept working');
    await h.conductor.tick();

    expect((await pending(h, 'base_conflict')).why).toContain('src/a.txt');
    expect(await taskIds(h)).not.toContain('M1-TECH');
  });

  it('finishes CP4: snapshot, base advanced, next milestone or closed', async () => {
    const h = await harness();
    const cp4 = await toCp4(h);
    await h.store.answerInbox(cp4.id, { action: 'approve' });
    await h.conductor.tick();

    expect(await milestonePhase(h)).toBe('merged');
    expect(await statusOf(h, 'MILESTONE-REVIEW-M1')).toBe('approved');
    expect(await revParse(h.repoPath, 'refs/heads/main')).toBe(await revParse(h.repoPath, 'refs/heads/aiteam/m1'));
    expect(run(h.repoPath, 'show', `main:.aiteam/artifacts/decision_record/DEC-${cp4.id}.md`)).toContain('Approve');
    expect(await porcelain(h.repoPath)).toBe('');
    expect(await phaseOf(h)).toBe('active');

    await h.conductor.tick();
    expect(await milestonePhase(h, 2)).toBe('spec');
    expect(orderOf(await byTicket(h, 'M2-SPEC')).base).toEqual({ kind: 'base' });

    const last = await harness();
    const only = await toCp4(last, { discovery: ONE_MILESTONE });
    await last.store.answerInbox(only.id, { action: 'approve' });
    await last.conductor.tick();
    expect(await phaseOf(last)).toBe('closed');
  });

  it('asks and holds when the fast-forward is refused, with nothing half-done', async () => {
    const h = await harness();
    const cp4 = await toCp4(h, {}, { 'src/a.txt': 'from the ticket\n' });
    const mainBefore = await revParse(h.repoPath, 'refs/heads/main');
    mkdirSync(join(h.repoPath, 'src'), { recursive: true });
    writeFileSync(join(h.repoPath, 'src/a.txt'), 'the stakeholder is writing this\n');

    await h.store.answerInbox(cp4.id, { action: 'approve' });
    await h.conductor.tick();

    const hold = await pending(h, 'base_refused');
    expect(hold.dedupe_key).toBe('base_refused:M1:1');
    expect(hold.why).toContain('src/a.txt');
    expect(hold.options.map(({ id }) => id)).toEqual(['retry', 'halt']);
    expect(await milestonePhase(h)).toBe('merging');
    expect(await revParse(h.repoPath, 'refs/heads/main')).toBe(mainBefore);
    await h.conductor.tick();
    expect(await inboxOf(h, 'base_refused')).toHaveLength(1);

    rmSync(join(h.repoPath, 'src/a.txt'));
    await h.store.answerInbox(hold.id, { option: 'retry' });
    await h.conductor.tick();

    expect(await milestonePhase(h)).toBe('merged');
    expect(await revParse(h.repoPath, 'refs/heads/main')).toBe(await revParse(h.repoPath, 'refs/heads/aiteam/m1'));
  });

  it('syncs the base again when it moved during the fast-forward window', async () => {
    const h = await harness();
    const cp4 = await toCp4(h);
    await h.store.answerInbox(cp4.id, { action: 'approve' });
    await applyAnswers(h, h.runner, await projectOf(h));
    writeFileSync(join(h.repoPath, 'late.txt'), 'late\n');
    const late = commitAll(h.repoPath, 'the stakeholder kept working');
    await h.conductor.tick();

    expect(await milestonePhase(h)).toBe('merged');
    expect(hasCommit(h, late, 'refs/heads/main')).toBe(true);
    expect(await revParse(h.repoPath, 'refs/heads/main')).toBe(await revParse(h.repoPath, 'refs/heads/aiteam/m1'));
  });

  it('turns an escalated task into one Question and withdraws it after a manual retry', async () => {
    const h = await harness();
    const task = await h.addTicket(ticket({ id: 'H-1' }));
    await h.store.setTaskState(task.id, 'escalated', { reason: 'attempts_exhausted: three tries failed' });
    await h.conductor.tick();
    await h.conductor.tick();

    const question = await pending(h, 'escalation');
    expect(question.dedupe_key).toBe(`escalation:${task.id}:1`);
    expect(question.why).toContain('three tries failed');
    expect(question.recommendation).not.toBe('');
    expect(question.options.map(({ id }) => id)).toEqual(['retry', 'cancel']);

    await h.runner.retry(task.id);
    await h.conductor.tick();
    expect((await h.store.getInbox(question.id))!.state).toBe('withdrawn');
  });

  it('retries or cancels an escalated ticket as the answer says', async () => {
    const h = await harness();
    const [one, two] = [await h.addTicket(ticket({ id: 'H-1' })), await h.addTicket(ticket({ id: 'H-2' }))];
    await h.store.setTaskState(one.id, 'escalated', { reason: 'attempts_exhausted' });
    await h.store.setTaskState(two.id, 'escalated', { reason: 'attempts_exhausted' });
    await h.conductor.tick();
    const [first, second] = await inboxOf(h, 'escalation');

    await h.store.answerInbox(first!.id, { option: 'retry' });
    await h.store.answerInbox(second!.id, { option: 'cancel' });
    await h.conductor.tick();

    expect((await h.store.getTask(one.id))!.state).toBe('ready');
    expect((await h.store.getTask(two.id))!.state).toBe('cancelled');
    expect(await phaseOf(h)).toBe('intake');
  });

  it('offers Halt rather than Cancel for a task a phase is waiting on', async () => {
    const h = await harness();
    await toDesign(h);
    await h.store.setTaskState((await byTicket(h, 'M1-TECH')).id, 'escalated', { reason: 'attempts_exhausted' });
    await h.conductor.tick();

    const question = await pending(h, 'escalation');
    expect(question.options.map(({ id }) => id)).toEqual(['retry', 'halt']);

    await h.store.answerInbox(question.id, { option: 'halt' });
    await h.conductor.tick();
    expect(await phaseOf(h)).toBe('halted');
  });

  it('asks again when a Retry fails again', async () => {
    const h = await harness();
    writeFileSync(join(h.repoPath, 'ready.txt'), 'yes\n');
    await toBuild(h, { profile: { ...PROFILE, commands: { ...PROFILE.commands, smoke: 'test -f ready.txt' } } });
    const first = await pending(h, 'smoke');

    await h.store.answerInbox(first.id, { option: 'retry' });
    await h.conductor.tick();

    const second = await pending(h, 'smoke');
    expect(second.id).not.toBe(first.id);
    expect(second.dedupe_key).toBe('smoke:M1:2');
    expect((await h.store.getInbox(first.id))!.applied_at).not.toBeNull();
    expect(await inboxOf(h, 'smoke')).toHaveLength(2);
  });

  it('counts a written answer as the first option and keeps its words', async () => {
    const h = await harness();
    writeFileSync(join(h.repoPath, 'ready.txt'), 'yes\n');
    await toBuild(h, { profile: { ...PROFILE, commands: { ...PROFILE.commands, smoke: 'test -f ready.txt' } } });
    const hold = await pending(h, 'smoke');
    commitOn(h, 'aiteam/m1', { 'ready.txt': 'yes\n' });

    await h.store.answerInbox(hold.id, { text: 'I committed the file, try again' });
    await h.conductor.tick();

    expect(await milestonePhase(h)).toBe('build');
    const doc = await h.artifacts.read(h.project, `DEC-${hold.id}`);
    expect(doc.body).toContain('I committed the file, try again');
  });

  it('runs a fresh Milestone Review after CP4 Request changes', async () => {
    const h = await harness();
    const cp4 = await toCp4(h);
    await h.store.answerInbox(cp4.id, { action: 'request_changes', comment: 'The second thing is too slow' });
    await h.conductor.tick();

    const replan = await byTicket(h, 'M1-REPLAN-1');
    expect([replan.role_id, replan.purpose, orderOf(replan).comment, orderOf(replan).base]).toEqual(['tech_lead', 'revise_design', 'The second thing is too slow', { kind: 'integration' }]);
    expect(await milestonePhase(h)).toBe('build');
    await h.conductor.tick();
    expect(await taskIds(h)).not.toContain('M1-QA-2');

    await finish(h, 'M1-REPLAN-1', revised());
    await h.conductor.tick();
    await finish(h, 'M1-QA-2', PASS);
    await h.conductor.tick();
    await finish(h, 'M1-REVIEW-2', REVIEW);
    await h.conductor.tick();

    const second = await pending(h, 'cp4');
    expect(second.dedupe_key).toBe('cp4:M1:2');
    expect(second.evidence.map(({ pin }) => pin)).toContain('MILESTONE-REVIEW-M1@2');

    // The replan read neither Review, so approving the second one leaves the design alone.
    await h.store.answerInbox(second.id, { action: 'approve' });
    await h.conductor.tick();
    expect(await statusOf(h, 'TECH-M1')).toBe('approved');
    expect(await milestonePhase(h)).toBe('merged');
  });

  it('revises again when a re-pinned document goes stale again', async () => {
    const h = await harness();
    await toBuild(h);

    await ownerApplies(h, scopeChange);
    expect(await statusOf(h, 'TECH-M1')).toBe('stale');
    const first = await byTicket(h, 'M1-REVISE-TECH-M1-1');
    expect([first.role_id, first.purpose, orderOf(first).inputs]).toEqual(['tech_lead', 'revise_design', ['SPEC-M1@2', 'ENV-PROFILE@1', 'TECH-M1@1']]);
    expect(orderOf(first).instructions).toContain('M1-T-1');
    const plan = await byTicket(h, 'M1-REVISE-TEST-PLAN-M1-1');
    expect([plan.role_id, plan.purpose]).toEqual(['qa_engineer', 'revise_test_plan']);

    await h.conductor.tick();
    expect(await taskIds(h)).not.toContain('M1-REVISE-TECH-M1-2');

    await finish(h, 'M1-REVISE-TECH-M1-1', revised([stillValid('M1-T-1')]));
    await finish(h, 'M1-REVISE-TEST-PLAN-M1-1', revised());
    await h.conductor.tick();
    expect(await statusOf(h, 'TECH-M1')).toBe('approved');
    expect((await h.artifacts.latest(h.project.id, 'TECH-M1'))!.version).toBe(1);

    await ownerApplies(h, { ...scopeChange, proposed_text: 'Smaller still.' });
    expect(orderOf(await byTicket(h, 'M1-REVISE-TECH-M1-2')).inputs).toEqual(['SPEC-M1@3', 'ENV-PROFILE@1', 'TECH-M1@1']);
  });

  it('revises again when the spec moves while a revision is running', async () => {
    const h = await harness();
    await toBuild(h);
    await ownerApplies(h, scopeChange);
    await ownerApplies(h, { ...scopeChange, proposed_text: 'Smaller still.' });
    expect(await taskIds(h)).not.toContain('M1-REVISE-TECH-M1-2');

    await finish(h, 'M1-REVISE-TECH-M1-1', revised([stillValid('M1-T-1')]));
    await finish(h, 'M1-REVISE-TEST-PLAN-M1-1', revised());
    await h.conductor.tick();

    expect(await statusOf(h, 'TECH-M1')).toBe('stale');
    expect(await statusOf(h, 'TEST-PLAN-M1')).toBe('stale');
    expect(orderOf(await byTicket(h, 'M1-REVISE-TECH-M1-2')).inputs).toEqual(['SPEC-M1@3', 'ENV-PROFILE@1', 'TECH-M1@1']);
    expect(orderOf(await byTicket(h, 'M1-REVISE-TEST-PLAN-M1-2')).inputs).toContain('SPEC-M1@3');
    expect(await taskIds(h)).not.toContain('M1-QA-1');
  });

  it('revises the owning document when only a ticket goes stale', async () => {
    const h = await harness();
    await toBuild(h);
    await h.artifacts.commit(h.project, { message: 'stale', status: [{ id: 'M1-T-1', status: 'stale' }] });
    await h.conductor.tick();

    expect(await byTicket(h, 'M1-REVISE-TECH-M1-1')).toMatchObject({ role_id: 'tech_lead', purpose: 'revise_design' });
    await finish(h, 'M1-REVISE-TECH-M1-1', revised([stillValid('M1-T-1')]));
    expect(await statusOf(h, 'M1-T-1')).toBe('approved');
  });

  it('does not wait on a stale spec, which no one revises', async () => {
    const h = await harness();
    await toBuild(h);
    await mergeTicket(h, 'M1-T-1');
    await h.artifacts.commit(h.project, { message: 'stale', status: [{ id: 'SPEC-M1', status: 'stale' }] });
    await h.conductor.tick();

    expect(await taskIds(h)).toContain('M1-QA-1');
  });

  it('cancels the review of a cancelled ticket', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    await toReview(h, 'M1-T-1');
    await h.conductor.tick();
    expect((await byTicket(h, 'M1-T-1-R1')).state).toBe('queued');

    await h.runner.cancel(task.id);
    await h.conductor.tick();

    expect((await byTicket(h, 'M1-T-1-R1')).state).toBe('cancelled');
  });

  it('isolates one project error from other projects', async () => {
    const h = await harness();
    const { path } = await makeRepo();
    const other = await addProject(h, { name: 'other', repoPath: path, create: false });
    await addBrief(h);
    await h.artifacts.commit(other, { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });

    const latest = h.artifacts.latest.bind(h.artifacts);
    const spy = vi.spyOn(h.artifacts, 'latest').mockImplementation(async (projectId, id) => {
      if (projectId === h.project.id) throw new Error('The state repo is gone');
      return latest(projectId, id);
    });
    await h.conductor.tick();
    await h.conductor.tick();

    expect((await h.store.getProjectById(other.id))!.phase).toBe('discovery');
    expect(await phaseOf(h)).toBe('intake');
    const hold = await pending(h, 'engine_error');
    expect(hold.why).toContain('The state repo is gone');
    expect(hold.options.map(({ id }) => id)).toEqual(['retry', 'halt']);
    const errors = (await h.log.list({ projectId: h.project.id })).filter(({ type }) => type === 'conductor.error');
    expect(errors).toHaveLength(1);

    // While the question is open, nothing but answers moves.
    spy.mockRestore();
    await h.conductor.tick();
    expect(await taskIds(h)).toEqual([]);

    await h.store.answerInbox(hold.id, { option: 'retry' });
    await h.conductor.tick();
    expect(await phaseOf(h)).toBe('discovery');
  });

  it('applies Halt on an engine error even while another answer keeps failing', async () => {
    const h = await harness();
    const stuck = await h.addTicket(ticket({ id: 'H-1' }));
    await h.store.setTaskState(stuck.id, 'escalated', { reason: 'attempts_exhausted' });
    await h.conductor.tick();
    const question = await pending(h, 'escalation');
    await h.store.answerInbox(question.id, { option: 'retry' });

    // This answer can't be applied, so the error surfaces every tick.
    const retry = vi.spyOn(h.runner, 'retry').mockRejectedValue(new Error('The retry keeps failing'));
    await h.conductor.tick();
    const hold = await pending(h, 'engine_error');
    await h.store.answerInbox(hold.id, { option: 'halt' });
    await h.conductor.tick();

    retry.mockRestore();
    expect(await phaseOf(h)).toBe('halted');
    expect((await h.store.getTask(stuck.id))!.state).toBe('cancelled');
    // What was left answered is recorded, and does nothing to a halted project.
    expect((await h.store.getInbox(question.id))!.applied_at).not.toBeNull();
  });

  it('halts from an engine error when asked to', async () => {
    const h = await harness();
    await addBrief(h);
    const spy = vi.spyOn(h.artifacts, 'latest').mockRejectedValue(new Error('The state repo is gone'));
    await h.conductor.tick();
    spy.mockRestore();

    await h.store.answerInbox((await pending(h, 'engine_error')).id, { option: 'halt' });
    await h.conductor.tick();
    expect(await phaseOf(h)).toBe('halted');
  });
});

describe('review focus: answers and restarts', () => {
  it('applies an answer exactly once when the daemon dies right after it', async () => {
    const h = await harness();
    const cp1 = await toCp1(h);
    await h.store.answerInbox(cp1.id, { action: 'approve' });

    const again = await reopen(h);
    await again.conductor.tick();
    await again.conductor.tick();

    expect(await again.store.listMilestones(h.project.id)).toHaveLength(2);
    expect(await decisionRecords(again)).toHaveLength(1);
  });

  it('re-runs safely when the crash falls between the git commit and SQLite', async () => {
    const h = await harness();
    const cp1 = await toCp1(h);
    await h.store.answerInbox(cp1.id, { action: 'approve' });

    vi.spyOn(Store.prototype, 'markInboxApplied').mockRejectedValueOnce(new Error('The daemon died'));
    await expect(applyAnswers(h, h.runner, await projectOf(h))).rejects.toThrow('The daemon died');
    expect(await h.store.listMilestones(h.project.id)).toEqual([]);
    expect((await h.store.getInbox(cp1.id))!.applied_at).toBeNull();

    const again = await reopen(h);
    await again.artifacts.reconcile(await projectOf(h));
    await again.conductor.tick();

    expect(await again.store.listMilestones(h.project.id)).toHaveLength(2);
    expect((await decisionRecords(again)).map(({ version }) => version)).toEqual([1]);
    expect((await again.store.getInbox(cp1.id))!.applied_at).not.toBeNull();
    expect(await statusOf(again, 'ROADMAP')).toBe('approved');
  });

  it('treats an already merged ticket as merged after a crash', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    const { head } = await toReview(h, 'M1-T-1');
    await h.conductor.tick();
    await finish(h, 'M1-T-1-R1', APPROVE);
    const merged = await mergeIntoBranch(h.repoPath, { target: 'aiteam/m1', source: head, message: 'merged before the crash' });
    expect(merged.ok).toBe(true);
    const integration = await revParse(h.repoPath, 'refs/heads/aiteam/m1');

    const again = await reopen(h);
    await again.conductor.tick();

    expect((await again.store.getTask(task.id))!.state).toBe('done');
    expect(await revParse(h.repoPath, 'refs/heads/aiteam/m1')).toBe(integration);
  });

  it('resumes a milestone left in merging', async () => {
    const h = await harness();
    const cp4 = await toCp4(h);
    await h.store.answerInbox(cp4.id, { action: 'approve' });
    await applyAnswers(h, h.runner, await projectOf(h));
    expect(await milestonePhase(h)).toBe('merging');

    const again = await reopen(h);
    await again.conductor.tick();

    expect(await milestonePhase(again)).toBe('merged');
    expect(await revParse(h.repoPath, 'refs/heads/main')).toBe(await revParse(h.repoPath, 'refs/heads/aiteam/m1'));
    expect(await decisionRecords(again)).toHaveLength((await decisionRecords(h)).length);
  });

  it('keeps pending items unchanged after a restart', async () => {
    const h = await harness();
    await toCp1(h);
    const before = await h.store.listInbox({ projectId: h.project.id });

    const again = await reopen(h);
    await again.conductor.tick();

    expect(await again.store.listInbox({ projectId: h.project.id })).toEqual(before);
  });
});

describe('review focus: a change mid-flight', () => {
  it('lets a running stale ticket finish, and holds its merge', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    await advanceTo(h, task.id, ['ready', 'running']);

    await stakeholderApplies(h);
    expect(await statusOf(h, 'M1-T-1')).toBe('stale');
    expect((await h.store.getTask(task.id))!.state).toBe('running');

    const { head } = await toReview(h, 'M1-T-1');
    await h.conductor.tick();
    await finish(h, 'M1-T-1-R1', APPROVE);
    await h.conductor.tick();
    await h.conductor.tick();

    expect((await h.store.getTask(task.id))!.state).toBe('review');
    expect(hasCommit(h, head, 'aiteam/m1')).toBe(false);
  });

  it('merges it once the Tech Lead re-validates it', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    await stakeholderApplies(h);
    const { head } = await toReview(h, 'M1-T-1');
    await h.conductor.tick();
    await finish(h, 'M1-T-1-R1', APPROVE);
    await h.conductor.tick();
    expect((await h.store.getTask(task.id))!.state).toBe('review');

    await finish(h, 'M1-REVISE-TECH-M1-1', revised([stillValid('M1-T-1')]));
    await h.conductor.tick();

    expect((await h.store.getTask(task.id))!.state).toBe('done');
    expect(hasCommit(h, head, 'aiteam/m1')).toBe(true);
  });

  it('cancels a superseded ticket and adds the new one', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    await advanceTo(h, task.id, ['ready', 'running']);
    await stakeholderApplies(h);

    await finish(h, 'M1-REVISE-TECH-M1-1', revised([{ ticket: 'M1-T-1', decision: 'superseded', rationale: 'Replaced' }], [draft('T-2', ['AC-1', 'AC-2'])]));
    await h.conductor.tick();

    expect((await h.store.getTask(task.id))!.state).toBe('cancelled');
    expect(await byTicket(h, 'M1-T-2')).toMatchObject({ kind: 'ticket', state: 'queued' });
  });

  it('always sends criterion text changes to the stakeholder, even when the PM recommends rejecting', async () => {
    const h = await harness();
    await toBuild(h);
    const { artifact_id: id } = await fileChangeRequest(h, h.project, criterionChange);
    await h.conductor.tick();
    const rec = await byTicket(h, `${id}-REC`);
    expect([rec.role_id, rec.purpose, orderOf(rec).inputs]).toEqual(['pm', 'cr_recommendation', ['CR-1@1', 'SPEC-M1@1']]);

    await finish(h, `${id}-REC`, { decision: 'reject', rationale: 'Not worth it' });
    await h.conductor.tick();

    expect(await statusOf(h, id)).toBe('proposed');
    const item = await pending(h, 'cr');
    expect(item.dedupe_key).toBe('cr:1');
    expect(item.type).toBe('approval');
    expect(item.recommendation).toContain('Not worth it');
    expect((await h.artifacts.latest(h.project.id, 'SPEC-M1'))!.version).toBe(1);

    await h.store.answerInbox(item.id, { action: 'approve' });
    await h.conductor.tick();

    expect((await h.artifacts.latest(h.project.id, 'SPEC-M1'))!.version).toBe(2);
    expect((await h.store.listCriteria(h.project.id, 1))[0]).toMatchObject({ text: 'The first thing works faster', cr_id: id });
    expect(await decisionRecords(h)).toContainEqual(expect.objectContaining({ artifact_id: `DEC-${item.id}` }));
  });

  it('applies a criterion change the stakeholder approved against the text they were shown, though it moved after the request was filed', async () => {
    const h = await harness();
    await toBuild(h);
    const { artifact_id: first } = await fileChangeRequest(h, h.project, criterionChange);
    const { artifact_id: second } = await fileChangeRequest(h, h.project, { ...criterionChange, proposed_text: 'The first thing works offline' });
    await h.conductor.tick();
    await finish(h, `${first}-REC`, { decision: 'approve', rationale: 'Yes' });
    await h.conductor.tick();
    await h.store.answerInbox((await pending(h, 'cr')).id, { action: 'approve' });
    await h.conductor.tick();
    expect((await h.artifacts.latest(h.project.id, 'SPEC-M1'))!.version).toBe(2);

    await finish(h, `${second}-REC`, { decision: 'approve', rationale: 'Yes' });
    await h.conductor.tick();
    const item = await pending(h, 'cr');
    expect(item.why).toContain(`AC-1 has changed since ${second} was filed against SPEC-M1@1`);
    expect(item.evidence).toContainEqual({ label: 'AC-1 now', value: expect.stringMatching(/^The first thing works faster\n\nVerified by: /), pin: 'SPEC-M1@2#ac-1' });

    await h.store.answerInbox(item.id, { action: 'approve' });
    await h.conductor.tick();

    expect(await statusOf(h, second)).toBe('approved');
    expect((await h.artifacts.latest(h.project.id, 'SPEC-M1'))!.version).toBe(3);
    expect((await h.store.listCriteria(h.project.id, 1))[0]).toMatchObject({ text: 'The first thing works offline', cr_id: second });
  });

  it('asks again with the current text when a criterion moves while its change waits for the stakeholder', async () => {
    const h = await harness();
    await toBuild(h);
    const { artifact_id: first } = await fileChangeRequest(h, h.project, criterionChange);
    const { artifact_id: second } = await fileChangeRequest(h, h.project, { ...criterionChange, proposed_text: 'The first thing works offline' });
    await h.conductor.tick();
    await finish(h, `${first}-REC`, { decision: 'approve', rationale: 'Yes' });
    await finish(h, `${second}-REC`, { decision: 'approve', rationale: 'Yes' });
    await h.conductor.tick();
    const asked = await inboxOf(h, 'cr');
    const [one, two] = [first, second].map((cr) => asked.find(({ ref }) => ref.kind === 'cr' && ref.cr === cr)!);

    await h.store.answerInbox(one!.id, { action: 'approve' });
    await h.conductor.tick();

    expect((await h.store.getInbox(two!.id))!.state).toBe('withdrawn');
    const again = await pending(h, 'cr');
    expect(again.ref).toEqual({ kind: 'cr', cr: second });
    expect(again.evidence).toContainEqual({ label: 'AC-1 now', value: expect.stringMatching(/^The first thing works faster\n/), pin: 'SPEC-M1@2#ac-1' });

    await h.store.answerInbox(again.id, { action: 'approve' });
    await h.conductor.tick();

    expect(await statusOf(h, second)).toBe('approved');
    expect((await h.store.listCriteria(h.project.id, 1))[0]!.text).toBe('The first thing works offline');
  });

  it('asks again rather than closing a criterion change approved in the same tick as another change to its criterion', async () => {
    const h = await harness();
    await toBuild(h);
    const { artifact_id: first } = await fileChangeRequest(h, h.project, criterionChange);
    const { artifact_id: second } = await fileChangeRequest(h, h.project, { ...criterionChange, proposed_text: 'The first thing works offline' });
    await h.conductor.tick();
    await finish(h, `${first}-REC`, { decision: 'approve', rationale: 'Yes' });
    await finish(h, `${second}-REC`, { decision: 'approve', rationale: 'Yes' });
    await h.conductor.tick();
    for (const item of await inboxOf(h, 'cr')) await h.store.answerInbox(item.id, { action: 'approve' });

    await h.conductor.tick();

    expect(await statusOf(h, first)).toBe('approved');
    expect(await statusOf(h, second)).toBe('proposed');
    const again = await pending(h, 'cr');
    expect(again.ref).toEqual({ kind: 'cr', cr: second });
    expect(again.why).toContain(`AC-1 has changed since ${second} was filed against SPEC-M1@1`);
    expect((await h.store.listCriteria(h.project.id, 1))[0]!.text).toBe('The first thing works faster');
  });

  it('closes a Change Request and carries on when the stakeholder rejects it', async () => {
    const h = await harness();
    await toBuild(h);
    const { artifact_id: id } = await fileChangeRequest(h, h.project, criterionChange);
    await h.conductor.tick();
    await finish(h, `${id}-REC`, { decision: 'approve', rationale: 'Yes' });
    await h.conductor.tick();

    await h.store.answerInbox((await pending(h, 'cr')).id, { action: 'reject' });
    await h.conductor.tick();

    expect(await statusOf(h, id)).toBe('superseded');
    expect(await phaseOf(h)).toBe('active');
    expect((await h.store.listCriteria(h.project.id, 1))[0]!.text).toBe('The first thing works');
  });

  it('lets the owner decide other changes', async () => {
    const h = await harness();
    await toBuild(h);

    const applied = await ownerApplies(h, scopeChange);
    expect(await statusOf(h, applied)).toBe('approved');
    expect((await h.artifacts.read(h.project, 'SPEC-M1')).body).toContain('Smaller.');

    const { artifact_id: rejected } = await fileChangeRequest(h, h.project, { ...scopeChange, proposed_text: 'Bigger.' });
    await h.conductor.tick();
    await finish(h, `${rejected}-REC`, { decision: 'reject', rationale: 'No' });
    await h.conductor.tick();

    expect(await statusOf(h, rejected)).toBe('superseded');
    expect(await inboxOf(h, 'cr')).toEqual([]);
  });

  it('refuses a request the owner approved after its section moved, instead of failing every tick', async () => {
    const h = await harness();
    await toBuild(h);
    const { artifact_id: late } = await fileChangeRequest(h, h.project, { ...scopeChange, proposed_text: 'Late.' });
    await ownerApplies(h, scopeChange);
    await finish(h, `${late}-REC`, { decision: 'approve', rationale: 'Yes' });
    await h.conductor.tick();

    expect(await statusOf(h, late)).toBe('superseded');
    expect(await inboxOf(h, 'engine_error')).toEqual([]);
    expect((await h.artifacts.read(h.project, 'SPEC-M1')).body).toContain('Smaller.');
  });

  it('withdraws a pending CP4, resets the criterion and returns to build', async () => {
    const h = await harness();
    const cp4 = await toCp4(h);
    expect((await h.store.listCriteria(h.project.id, 1))[0]!.status).toBe('passing');

    await stakeholderApplies(h);

    expect((await h.store.getInbox(cp4.id))!.state).toBe('withdrawn');
    expect((await h.store.listCriteria(h.project.id, 1))[0]).toMatchObject({ status: 'unverified', text: 'The first thing works faster' });
    expect(await milestonePhase(h)).toBe('build');
  });

  it('cancels a running QA task when a change lands during verify', async () => {
    const h = await harness();
    await toVerify(h);
    const qa = await byTicket(h, 'M1-QA-1');
    await advanceTo(h, qa.id, ['ready', 'running']);

    await ownerApplies(h, scopeChange);

    expect((await h.store.getTask(qa.id))!.state).toBe('cancelled');
    expect(await milestonePhase(h)).toBe('build');
  });

  it('cancels a running Milestone Review when a change lands', async () => {
    const h = await harness();
    await toVerify(h);
    await finish(h, 'M1-QA-1', PASS);
    await h.conductor.tick();
    const review = await byTicket(h, 'M1-REVIEW-1');
    await advanceTo(h, review.id, ['ready', 'running']);

    await ownerApplies(h, scopeChange);

    expect((await h.store.getTask(review.id))!.state).toBe('cancelled');
    expect(await milestonePhase(h)).toBe('build');
  });

  it('holds the Bug while QA asks to change a Test Plan command, then verifies again with the new one', async () => {
    const h = await harness();
    const plan = { ...TEST_PLAN, coverage: [{ ac: 'AC-1', commands: ['false'], notes: '' }, { ac: 'AC-2', commands: ['true'], notes: '' }] };
    await toVerify(h, { plan });
    const dispute = { target_artifact: 'TEST-PLAN-M1@1', target_ac: 'AC-1', proposed_text: 'true', rationale: 'It checks the wrong thing', evidence: 'The Spec never names that file' };

    await finish(h, 'M1-QA-1', { ...PASS, change_requests: [dispute] });
    await h.conductor.tick();
    await h.conductor.tick();
    expect(await h.artifacts.latest(h.project.id, 'M1-B-1')).toBeUndefined();
    expect(await milestonePhase(h)).toBe('build');
    expect(await taskIds(h)).not.toContain('M1-QA-2');

    await finish(h, 'CR-1-REC', { decision: 'approve', rationale: 'Yes' });
    await h.conductor.tick();
    await h.conductor.tick();
    const plan2 = await h.artifacts.read(h.project, 'TEST-PLAN-M1');
    expect((plan2.fields.data as { coverage: { commands: string[] }[] }).coverage.map(({ commands }) => commands)).toEqual([['true'], ['true']]);
    expect(orderOf(await byTicket(h, 'M1-QA-2')).inputs).toContain('TEST-PLAN-M1@2');

    await finish(h, 'M1-QA-2', PASS);
    await h.conductor.tick();
    expect(await milestonePhase(h)).toBe('milestone_review');
  });

  it('goes back to build when QA was cancelled by a crash between the two steps', async () => {
    const h = await harness();
    await toVerify(h);
    await h.runner.cancel((await byTicket(h, 'M1-QA-1')).id);
    await h.conductor.tick();

    expect(await milestonePhase(h)).toBe('build');
    await h.conductor.tick();
    expect(await taskIds(h)).toContain('M1-QA-2');
  });

  it('re-verifies every criterion in the next round', async () => {
    const h = await harness();
    await toCp4(h);
    await stakeholderApplies(h);
    await finish(h, 'M1-REVISE-TECH-M1-1', revised());
    await finish(h, 'M1-REVISE-TEST-PLAN-M1-1', revised());
    await h.conductor.tick();

    // AC-2 passed last round and the change didn't touch it, but this round's verdict is what counts.
    await finish(h, 'M1-QA-2', failing('AC-2'));
    await h.conductor.tick();

    expect((await h.store.listCriteria(h.project.id, 1)).map(({ ac_id, status }) => [ac_id, status])).toEqual([['AC-1', 'passing'], ['AC-2', 'failing']]);
    expect(await milestonePhase(h)).toBe('build');
    expect(await taskIds(h)).not.toContain('M1-REVIEW-2');
  });

  it('refuses a late answer to the withdrawn CP4', async () => {
    const h = await harness();
    const cp4 = await toCp4(h);
    await stakeholderApplies(h);

    await expect(h.store.answerInbox(cp4.id, { action: 'approve' })).rejects.toThrow(AlreadyAnswered);
    await h.conductor.tick();
    expect(await milestonePhase(h)).toBe('build');
  });
});

describe('a ticket held on a Change Request it raised', () => {
  const held = async (h: Harness): Promise<TaskRow> => {
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    await h.store.setTaskState(task.id, 'blocked', { blockedOn: 'change_request' });
    return task;
  };
  const stateOf = async (h: Harness, task: TaskRow) => (await h.store.getTask(task.id))!.state;

  it('stays held while the request is open, and goes back to ready once it is rejected', async () => {
    const h = await harness();
    const task = await held(h);
    const { artifact_id: id } = await fileChangeRequest(h, h.project, { ...scopeChange, raised_in: 'M1-T-1' });
    await h.conductor.tick();
    expect(await stateOf(h, task)).toBe('blocked');

    await finish(h, `${id}-REC`, { decision: 'reject', rationale: 'No' });
    await h.conductor.tick();

    expect(await stateOf(h, task)).toBe('ready');
  });

  it('is not held by a request another ticket raised', async () => {
    const h = await harness();
    const task = await held(h);
    await fileChangeRequest(h, h.project, { ...scopeChange, raised_in: 'M1-T-9' });
    await h.conductor.tick();

    expect(await stateOf(h, task)).toBe('ready');
  });

  it('stays held while an approved request leaves the ticket stale, until the Tech Lead decides on it', async () => {
    const h = await harness();
    const task = await held(h);
    await stakeholderApplies(h, { ...criterionChange, raised_in: 'M1-T-1' });
    expect(await statusOf(h, 'M1-T-1')).toBe('stale');
    expect(await stateOf(h, task)).toBe('blocked');

    await finish(h, 'M1-REVISE-TECH-M1-1', revised([stillValid('M1-T-1')]));
    await h.conductor.tick();

    expect(await stateOf(h, task)).toBe('ready');
  });
});

describe('an escalated task', () => {
  const failedAttempt = async (h: Harness, task: TaskRow, output: unknown, evidence: string) => {
    const attempt = await h.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: h.repoPath, branch: 'b' });
    await h.store.setAttemptState(attempt.id, 'running');
    await h.store.patchAttempt(attempt.id, { output });
    await h.store.setAttemptState(attempt.id, 'failed', { failure_kind: 'check_failed', failure_evidence: evidence });
  };
  const report = (notes: string) => ({ summary: 'Wrote the tests', files_changed: [], commands_run: [], notes });

  it('shows the last failure, what the worker said, and each request the ticket raised', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    await advanceTo(h, task.id, ['ready', 'running', 'checks']);
    await failedAttempt(h, task, report('The first try'), 'Check `true` exited with 1.\n');
    await failedAttempt(h, task, report('The grep in the check never matches on Node 25'), 'Check `grep -q x out` exited with 1.\n');
    const { artifact_id: id } = await fileChangeRequest(h, h.project, { ...scopeChange, raised_in: 'M1-T-1' });
    await fileChangeRequest(h, h.project, { ...scopeChange, raised_in: 'M1-T-9' });
    await h.store.setTaskState(task.id, 'escalated', { reason: 'attempts_exhausted' });
    await h.conductor.tick();

    expect((await pending(h, 'escalation')).evidence).toEqual([
      { label: 'Last failure', value: 'check_failed: Check `grep -q x out` exited with 1.' },
      { label: 'What the worker said', value: 'Wrote the tests\n\nThe grep in the check never matches on Node 25' },
      { label: id, value: 'proposed, against SPEC-M1#scope: Less to do', pin: `${id}@1` },
    ]);
  });

  it('cuts what the worker said short', async () => {
    const h = await harness();
    await toBuild(h);
    const task = await byTicket(h, 'M1-T-1');
    await advanceTo(h, task.id, ['ready', 'running', 'checks']);
    await failedAttempt(h, task, report('x'.repeat(5000)), 'Check `true` exited with 1.\n');
    await h.store.setTaskState(task.id, 'escalated', { reason: 'attempts_exhausted' });
    await h.conductor.tick();

    const said = (await pending(h, 'escalation')).evidence.find(({ label }) => label === 'What the worker said')!.value;
    expect(said.length).toBe(1500);
    expect(said.endsWith('…')).toBe(true);
  });
});
