import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { openDb } from '../src/db/open.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import { Conductor } from '../src/engine/conductor/index.ts';
import { tryWorktree } from '../src/engine/conductor/try.ts';
import type { CheckMark, InboxAnswer, InboxRow } from '../src/engine/inbox.ts';
import { Runner } from '../src/engine/runner.ts';
import { Store, type ProjectRow, type TaskRow } from '../src/engine/store.ts';
import { TryServer } from '../src/engine/try-server.ts';
import type { WorkOrder } from '../src/engine/workorder.ts';
import { EventLog } from '../src/events.ts';
import { addAttemptWorktree, ensureIntegrationBranch, snapshotAttempt } from '../src/git/workspace.ts';
import { worktreePath } from '../src/paths.ts';
import { CRITERIA, projectOf } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';
import { fakePlayer, playResult } from './helpers/play.ts';
import { revParse, run } from './helpers/repo.ts';

const hypothesis = (id: string) => ({ id, element: `Element of ${id}`, rationale: `Why ${id} might be fun`, look_for: `What to watch for in ${id}` });
const prototype = (key: string, hypotheses: string[], controls: string[]) => ({ key, title: `Prototype ${key}`, hypotheses, build: `Build ${key} with one ship and falling rocks.`, controls });
const PLAN = {
  hypotheses: [hypothesis('H-1'), hypothesis('H-2')],
  prototypes: [prototype('P-1', ['H-1'], ['ArrowLeft', 'ArrowRight', 'Space']), prototype('P-2', ['H-1', 'H-2'], ['KeyW'])],
  stakeholder_note: 'Please play both',
};
const PAGE = '<!doctype html><title>Prototype</title><canvas></canvas>\n';
const instructions = (r: number) =>
  `Plan prototype round ${r}. Suggest candidate fun elements from general knowledge as hypotheses, and the smallest playable prototype for each. Only the stakeholder judges fun: read their notes in the Decision Records and build on what they found fun.`;
const FUN_CHECK = 'When a milestone changes an element of FUN-DEFINITION, its Spec carries a human check that names the F-n element, so the stakeholder confirms at CP4 that the fun still holds.';
const DISCOVERY = {
  roadmap: { body: '# Roadmap\n', milestones: [{ n: 1, title: 'First', goal: 'Start' }] },
  team_proposal: { body: '# Team\n' },
  human_requirements: { body: '# Needs\n' },
  fun_definition: null as unknown,
  stakeholder_note: 'Please look at the roadmap',
};
const PROFILE = { body: '# Environment\n', commands: { build: 'true', test: 'true', lint: 'true', smoke: 'echo smoke-ok' }, toolchains: ['node 22'], network_allow: [], setup: null, play: null, stakeholder_note: 'The toolchain is ready' };
const SPEC = { body: '# Milestone one\n\n## Scope\n\nSmall.\n', criteria: CRITERIA, stakeholder_note: 'The spec is small' };
const fun = (ac: string, note = ''): CheckMark => ({ ac, status: 'passing', note });
const notFun = (ac: string, note = 'Nothing to it'): CheckMark => ({ ac, status: 'failing', note });

type Harness = TestEngine & { conductor: Conductor; project: ProjectRow; tryServer: TryServer };

const open: { cleanup(): Promise<void> }[] = [];
const reopened: { destroy(): Promise<void> }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of reopened.splice(0)) await db.destroy();
  for (const e of open.splice(0)) await e.cleanup();
});

async function tryServerOf(): Promise<TryServer> {
  const server = await TryServer.start(0);
  open.push({ cleanup: () => server.close() });
  return server;
}

async function harness({ prototyping = true } = {}): Promise<Harness> {
  const e = await makeEngine({ steps: [] });
  open.push(e);
  if (prototyping) await e.db.updateTable('projects').set({ prototyping: 1 }).execute();
  const tryServer = await tryServerOf();
  return Object.assign(e, { tryServer, conductor: new Conductor(e, e.runner), project: await projectOf(e) });
}

// What a restart leaves: the same files and database, and nothing in memory, the try server's mounts included.
async function reopen(h: Harness): Promise<Harness> {
  const db = await openDb(h.paths.db);
  reopened.push(db);
  const log = new EventLog(db);
  const store = new Store(db, log);
  const deps = { ...h, db, log, store, artifacts: new ArtifactStore(store, h.paths), tryServer: await tryServerOf() };
  const runner = new Runner(deps);
  return { ...deps, runner, conductor: new Conductor(deps, runner) };
}

const byTicket = async (h: Harness, id: string): Promise<TaskRow> => {
  const task = await h.store.getTaskByTicket(h.project.id, id);
  if (!task) throw new Error(`No task ${id}. There are: ${(await h.store.listTasks(h.project.id)).map((t) => t.ticket_id).join(', ')}`);
  return task;
};
const orderOf = (task: TaskRow) => task.work_order as WorkOrder;
const taskIds = async (h: Harness) => (await h.store.listTasks(h.project.id)).map((t) => t.ticket_id);
const phaseOf = async (h: Harness) => (await h.store.getProjectById(h.project.id))!.phase;
const funEvals = (h: Harness) => h.store.listInbox({ projectId: h.project.id }).then((items) => items.filter((item) => item.ref.kind === 'fun_eval'));

async function pendingFun(h: Harness): Promise<InboxRow> {
  const found = (await funEvals(h)).filter((item) => item.state === 'pending');
  expect(found).toHaveLength(1);
  return found[0]!;
}

async function addBrief(h: Harness): Promise<void> {
  await h.artifacts.commit(h.project, { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
}

async function advanceTo(h: Harness, taskId: number, states: TaskRow['state'][]): Promise<void> {
  const task = (await h.store.getTask(taskId))!;
  for (const state of states.slice(Math.max(0, states.indexOf(task.state) + 1))) await h.store.setTaskState(taskId, state);
}

// Takes a task to done through the real applier, as the runner would.
async function finish(h: Harness, id: string, output: unknown): Promise<void> {
  const task = await byTicket(h, id);
  await advanceTo(h, task.id, ['ready', 'running', 'checks']);
  const { id: attemptId } = await h.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: h.repoPath, branch: 'b', base_sha: await revParse(h.repoPath, 'refs/heads/main') });
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

// Takes a ticket to review with a real commit on its own branch, based on aiteam/m0 as the runner bases a prototype.
async function toReview(h: Harness, id: string, files: Record<string, string>): Promise<void> {
  const task = await byTicket(h, id);
  await advanceTo(h, task.id, ['ready', 'running']);
  const k = await h.store.nextAttemptK(task.id);
  const worktree = worktreePath(h.paths, 'p', id, k);
  const branch = `aiteam/attempt/${id}-a${k}`;
  const { headSha: base } = await ensureIntegrationBranch(h.repoPath, task.milestone, 'main');
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
  await advanceTo(h, task.id, ['running', 'checks', 'review']);
}

const page = (r: number, k: number) => ({ [`prototypes/r${r}/p${k}/index.html`]: PAGE });

// A round from its plan to its evaluation: the plan is applied, each prototype in `built` writes its page, and the rest are cancelled.
async function playRound(h: Harness, r: number, built = [1, 2]): Promise<InboxRow> {
  await finish(h, `PROTO-PLAN-${r}`, PLAN);
  await h.conductor.tick();
  for (const k of [1, 2]) {
    if (built.includes(k)) await toReview(h, `PROTO-${r}-P-${k}`, page(r, k));
    else await h.runner.cancel((await byTicket(h, `PROTO-${r}-P-${k}`)).id);
  }
  await h.conductor.tick();
  await h.conductor.tick();
  return pendingFun(h);
}

async function toFunEval(h: Harness, built?: number[]): Promise<InboxRow> {
  await addBrief(h);
  await h.conductor.tick();
  return playRound(h, 1, built);
}

async function answer(h: Harness, item: InboxRow, reply: InboxAnswer): Promise<void> {
  await h.store.answerInbox(item.id, reply);
  await h.conductor.tick();
}

const linkOf = (h: Harness, r: number, k: number) => `${h.tryServer.url}p/m0/r${r}/p${k}/index.html`;
const status = async (url: string) => (await fetch(url)).status;

describe('the prototype phase', () => {
  it('intake starts PROTO-PLAN-1 for a prototyping project and discovery for any other', async () => {
    const h = await harness();
    await addBrief(h);
    await h.conductor.tick();

    expect(await phaseOf(h)).toBe('prototype');
    expect(await taskIds(h)).toEqual(['PROTO-PLAN-1']);
    const plan = await byTicket(h, 'PROTO-PLAN-1');
    expect(plan).toMatchObject({ milestone: 0, role_id: 'pm', kind: 'authoring', purpose: 'prototype_plan' });
    expect(orderOf(plan)).toEqual({ purpose: 'prototype_plan', instructions: instructions(1), inputs: ['BRIEF@1'], checks: [], base: { kind: 'base' } });

    // Until the PM's plan is in, the round waits.
    await h.conductor.tick();
    expect(await taskIds(h)).toEqual(['PROTO-PLAN-1']);

    const plain = await harness({ prototyping: false });
    await addBrief(plain);
    await plain.conductor.tick();

    expect(await phaseOf(plain)).toBe('discovery');
    expect(await taskIds(plain)).toEqual(['DISCOVERY-PM', 'DISCOVERY-TL']);
  });

  it("builds the round's prototypes, merges them into aiteam/m0 without a code review, and raises FUN eval r1 with one check and Play link per page", async () => {
    const h = await harness();
    const player = fakePlayer(playResult());
    h.player = player;
    const smoke = vi.spyOn(player, 'smoke');
    const main = await revParse(h.repoPath, 'refs/heads/main');

    const item = await toFunEval(h);

    const tickets = (await h.store.listTasks(h.project.id)).filter(({ kind }) => kind === 'ticket');
    expect(tickets.map(({ ticket_id, milestone, state }) => [ticket_id, milestone, state])).toEqual([
      ['PROTO-1-P-1', 0, 'done'],
      ['PROTO-1-P-2', 0, 'done'],
    ]);
    expect((await h.store.listTasks(h.project.id)).filter(({ kind }) => kind === 'code_review')).toEqual([]);
    expect(run(h.repoPath, 'show', 'aiteam/m0:prototypes/r1/p1/index.html')).toBe(PAGE.trim());
    expect(run(h.repoPath, 'show', 'aiteam/m0:prototypes/r1/p2/index.html')).toBe(PAGE.trim());
    expect(await revParse(h.repoPath, 'refs/heads/main')).toBe(main);

    expect(item).toMatchObject({ type: 'approval', dedupe_key: 'fun_eval:1', ref: { kind: 'fun_eval', round: 1 }, title: 'Prototype round 1: is it fun?', asked_by: 'pm', milestone: null, recommendation: 'Please play both' });
    expect(item.checks).toEqual([
      { ac: 'P-1', text: 'Prototype P-1 — tests H-1: Element of H-1', how: `Play ${linkOf(h, 1, 1)}. Mark it fun or not fun, and say what you felt.` },
      { ac: 'P-2', text: 'Prototype P-2 — tests H-1, H-2: Element of H-1; Element of H-2', how: `Play ${linkOf(h, 1, 2)}. Mark it fun or not fun, and say what you felt.` },
    ]);
    expect(item.evidence).toEqual([
      { label: 'PROTO-PLAN-1', value: 'PROTO-PLAN-1@1', pin: 'PROTO-PLAN-1@1' },
      { label: 'Play P-1', value: linkOf(h, 1, 1) },
      { label: 'Play P-2', value: linkOf(h, 1, 2) },
    ]);
    expect(item.why).not.toMatch(/P-\d:/);
    expect(await phaseOf(h)).toBe('prototype');

    // The engine played each page once, animated and with its own controls, and the links serve them.
    expect(smoke.mock.calls.map(([, keys, opts]) => [keys, opts])).toEqual([
      [['ArrowLeft', 'ArrowRight', 'Space'], { animated: true }],
      [['KeyW'], { animated: true }],
    ]);
    expect(player.calls.map(({ body }) => body)).toEqual([PAGE, PAGE]);
    const served = await fetch(linkOf(h, 1, 2));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(PAGE);

    // Nothing more is raised for the round while it waits.
    await h.conductor.tick();
    expect(await funEvals(h)).toHaveLength(1);
  });

  it('evaluates only the prototypes that have a page', async () => {
    const h = await harness();

    const item = await toFunEval(h, [1]);

    expect((await byTicket(h, 'PROTO-1-P-2')).state).toBe('cancelled');
    expect(item.checks.map(({ ac }) => ac)).toEqual(['P-1']);
    expect(item.evidence.map(({ label }) => label)).toEqual(['PROTO-PLAN-1', 'Play P-1']);
  });

  it('says so when no prototype in the round built a page', async () => {
    const h = await harness();

    const item = await toFunEval(h, []);

    expect(item.checks).toEqual([]);
    expect(item.evidence.map(({ label }) => label)).toEqual(['PROTO-PLAN-1']);
    expect(item.why).toContain('No prototype in round 1 built a page.');
  });

  it('a failing smoke goes into why and does not block the evaluation', async () => {
    const h = await harness();
    const player = fakePlayer([playResult([{ kind: 'exception', detail: 'Uncaught TypeError: ship is undefined\n    at index.html:3' }]), playResult()]);
    h.player = player;

    const item = await toFunEval(h);

    expect(player.calls).toHaveLength(2);
    expect(item.why).toContain('P-1: exception: Uncaught TypeError: ship is undefined');
    expect(item.why).not.toContain('P-2:');
    expect(item.checks.map(({ ac }) => ac)).toEqual(['P-1', 'P-2']);
  });

  it('says why the engine did not play the pages, and which setting chooses the browser, when it has none to play them in', async () => {
    const h = await harness();
    const player = fakePlayer(playResult(), { unavailable: 'Chrome was not found at /nope' });
    h.player = player;

    const item = await toFunEval(h);

    expect(player.calls).toEqual([]);
    expect(item.why).toContain('The engine did not play the prototypes first, so play each one to see that it loads. Chrome was not found at /nope\nThe engine plays the game in the Chrome that chrome.binary in ~/.aiteam/config.yaml names.');
    expect(item.checks.map(({ ac }) => ac)).toEqual(['P-1', 'P-2']);
  });

  it('links each page in the checkout when there is no try server to serve it', async () => {
    const h = await harness();
    Object.assign(h, { tryServer: undefined });

    const item = await toFunEval(h);

    const pageIn = (k: number) => join(tryWorktree(h, h.project, 0).worktree, `prototypes/r1/p${k}/index.html`);
    expect(item.evidence.slice(1)).toEqual([
      { label: 'Play P-1', value: pageIn(1) },
      { label: 'Play P-2', value: pageIn(2) },
    ]);
    expect(item.checks[0]!.how).toBe(`Play ${pageIn(1)}. Mark it fun or not fun, and say what you felt.`);
    expect(readFileSync(pageIn(2), 'utf8')).toBe(PAGE);
  });

  it('request changes starts PROTO-PLAN-2 with the decision record among its inputs', async () => {
    const h = await harness();
    const item = await toFunEval(h);

    await answer(h, item, { action: 'request_changes', comment: 'More rocks, and faster', checks: [fun('P-1', 'Dodging felt great'), notFun('P-2')] });

    expect(await phaseOf(h)).toBe('prototype');
    const next = await byTicket(h, 'PROTO-PLAN-2');
    expect(next).toMatchObject({ milestone: 0, role_id: 'pm', purpose: 'prototype_plan', state: 'queued' });
    expect(orderOf(next)).toMatchObject({ instructions: instructions(2), inputs: ['BRIEF@1', 'PROTO-PLAN-1@1', `DEC-${item.id}@1`] });

    const record = await h.artifacts.read(h.project, `DEC-${item.id}@1`);
    expect(record.fields.data).toEqual({ ref: { kind: 'fun_eval', round: 1 }, answer: { action: 'request_changes', comment: 'More rocks, and faster', checks: [fun('P-1', 'Dodging felt great'), notFun('P-2')] } });
    expect(record.body).toContain('## P-1\n\nFun.');
    expect(record.body).toContain('## P-2\n\nNot fun.');
  });

  it('approve moves to discovery with every PROTO-PLAN and fun decision record among its inputs, and unmounts', async () => {
    const h = await harness();
    const first = await toFunEval(h);
    await answer(h, first, { action: 'request_changes', comment: 'More rocks', checks: [fun('P-1'), notFun('P-2')] });
    const second = await playRound(h, 2);
    expect(await status(linkOf(h, 2, 1))).toBe(200);

    // Neither is fun this round, and the one round 1 found is what discovery builds on.
    await answer(h, second, { action: 'approve', checks: [notFun('P-1'), notFun('P-2')] });

    expect(await phaseOf(h)).toBe('discovery');
    expect(orderOf(await byTicket(h, 'DISCOVERY-PM')).inputs).toEqual(['BRIEF@1', 'PROTO-PLAN-1@1', `DEC-${first.id}@1`, 'PROTO-PLAN-2@1', `DEC-${second.id}@1`]);
    expect(await byTicket(h, 'DISCOVERY-TL')).toBeDefined();
    expect(h.tryServer.mounted('p', 0)).toBe(false);
    expect(await status(linkOf(h, 2, 1))).toBe(404);
    expect(existsSync(tryWorktree(h, h.project, 0).worktree)).toBe(false);
    expect(run(h.repoPath, 'ls-tree', '--name-only', 'refs/heads/main')).not.toContain('prototypes');
  });

  it('reject halts and unmounts', async () => {
    const h = await harness();
    const item = await toFunEval(h);

    await answer(h, item, { action: 'reject' });

    expect(await phaseOf(h)).toBe('halted');
    expect(h.tryServer.mounted('p', 0)).toBe(false);
    expect(await status(linkOf(h, 1, 1))).toBe(404);
  });

  it('mounts a pending evaluation again after a restart', async () => {
    const h = await harness();
    await toFunEval(h);

    const restarted = await reopen(h);
    expect(restarted.tryServer.mounted('p', 0)).toBe(false);
    await restarted.conductor.tick();

    expect(restarted.tryServer.mounted('p', 0)).toBe(true);
    const served = await fetch(`${restarted.tryServer.url}p/m0/r1/p1/index.html`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(PAGE);
    expect(await funEvals(restarted)).toHaveLength(1);
  });
});

describe('the fun definition', () => {
  const funDefinition = (...elements: [element: string, evidence: string][]) => ({
    body: '# What is fun\n',
    elements: elements.map(([element, pin], index) => ({ id: `F-${index + 1}`, element, evidence: [pin], how_to_check: `Play it and look for ${element}` })),
  });

  // A prototyping project to discovery: round 1 found P-1 fun and P-2 not, and the stakeholder approved.
  async function toDiscovery(): Promise<{ h: Harness; dec: number }> {
    const h = await harness();
    const item = await toFunEval(h);
    await answer(h, item, { action: 'approve', checks: [fun('P-1', 'Dodging felt great'), notFun('P-2')] });
    expect(await phaseOf(h)).toBe('discovery');
    return { h, dec: item.id };
  }

  async function toCp1(h: Harness, discovery: unknown): Promise<InboxRow> {
    await finish(h, 'DISCOVERY-PM', discovery);
    await finish(h, 'DISCOVERY-TL', PROFILE);
    await h.conductor.tick();
    const found = (await h.store.listInbox({ projectId: h.project.id })).filter((item) => item.ref.kind === 'cp1' && item.state === 'pending');
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  it('cp1 shows FUN-DEFINITION and approving it gives M1-SPEC the pin as an input', async () => {
    const { h, dec } = await toDiscovery();
    const cp1 = await toCp1(h, { ...DISCOVERY, fun_definition: funDefinition(['Dodging', `DEC-${dec}@1#p-1`]) });

    expect(cp1.evidence.map(({ pin }) => pin)).toEqual(['ROADMAP@1', 'TEAM-PROPOSAL@1', 'HUMAN-REQUIREMENTS@1', 'FUN-DEFINITION@1', 'ENV-PROFILE@1']);
    expect((await h.artifacts.latest(h.project.id, 'FUN-DEFINITION'))).toMatchObject({ status: 'proposed', type: 'fun_definition', derived_from: [`DEC-${dec}@1#p-1`] });

    await h.store.answerInbox(cp1.id, { action: 'approve' });
    await h.conductor.tick();

    expect((await h.artifacts.latest(h.project.id, 'FUN-DEFINITION'))!.status).toBe('approved');
    const spec = orderOf(await byTicket(h, 'M1-SPEC'));
    expect(spec.inputs).toEqual(['ROADMAP@1', 'HUMAN-REQUIREMENTS@1', 'FUN-DEFINITION@1']);
    expect(spec.instructions).toMatch(/^Write the Spec for milestone 1 .*\n\n/);
    expect(spec.instructions.endsWith(`\n\n${FUN_CHECK}`)).toBe(true);

    // A Spec the stakeholder sends back is written under the same rule, from the same sources.
    await finish(h, 'M1-SPEC', SPEC);
    await h.conductor.tick();
    const cp2 = (await h.store.listInbox({ projectId: h.project.id })).find((item) => item.ref.kind === 'cp2')!;
    await h.store.answerInbox(cp2.id, { action: 'request_changes', comment: 'Less scope' });
    await h.conductor.tick();
    const redo = orderOf(await byTicket(h, 'M1-SPEC-r2'));
    expect(redo.inputs).toEqual(['ROADMAP@1', 'HUMAN-REQUIREMENTS@1', 'FUN-DEFINITION@1', 'SPEC-M1@1']);
    expect(redo.instructions).toContain(FUN_CHECK);
  });

  it('a Spec in a project without a fun definition has no such rule', async () => {
    const h = await harness({ prototyping: false });
    await addBrief(h);
    await h.conductor.tick();
    const cp1 = await toCp1(h, DISCOVERY);

    expect(cp1.evidence.map(({ pin }) => pin)).toEqual(['ROADMAP@1', 'TEAM-PROPOSAL@1', 'HUMAN-REQUIREMENTS@1', 'ENV-PROFILE@1']);
    await h.store.answerInbox(cp1.id, { action: 'approve' });
    await h.conductor.tick();

    const spec = orderOf(await byTicket(h, 'M1-SPEC'));
    expect(spec.inputs).toEqual(['ROADMAP@1', 'HUMAN-REQUIREMENTS@1']);
    expect(spec.instructions).not.toContain('FUN-DEFINITION');
  });

  it('a request for changes at cp1 has the PM write FUN-DEFINITION again, from the same marks', async () => {
    const { h, dec } = await toDiscovery();
    const cp1 = await toCp1(h, { ...DISCOVERY, fun_definition: funDefinition(['Dodging', `DEC-${dec}@1#p-1`]) });

    await h.store.answerInbox(cp1.id, { action: 'request_changes', comment: 'Say how to check dodging' });
    await h.conductor.tick();

    const redo = await byTicket(h, 'DISCOVERY-PM-r2');
    expect(orderOf(redo).inputs).toEqual(['BRIEF@1', 'ROADMAP@1', 'TEAM-PROPOSAL@1', 'HUMAN-REQUIREMENTS@1', 'FUN-DEFINITION@1', 'PROTO-PLAN-1@1', `DEC-${dec}@1`]);

    // The revision is held to the same rule: the definition is not optional, and a mark that is not fun is not evidence.
    await expect(finish(h, 'DISCOVERY-PM-r2', DISCOVERY)).rejects.toThrow(/needs a fun_definition/);
    await expect(finish(h, 'DISCOVERY-PM-r2', { ...DISCOVERY, fun_definition: funDefinition(['Rocks', `DEC-${dec}@1#p-2`]) })).rejects.toThrow(`F-1 cites DEC-${dec}@1#p-2, which the stakeholder did not mark fun`);
    await finish(h, 'DISCOVERY-PM-r2', { ...DISCOVERY, fun_definition: funDefinition(['Dodging', `DEC-${dec}@1#p-1`], ['Close calls', `DEC-${dec}@1#p-1`]) });
    await finish(h, 'DISCOVERY-TL-r2', PROFILE);
    await h.conductor.tick();

    const second = (await h.store.listInbox({ projectId: h.project.id })).filter((item) => item.ref.kind === 'cp1' && item.state === 'pending');
    expect(second).toHaveLength(1);
    expect(second[0]!.evidence.map(({ pin }) => pin)).toEqual(['ROADMAP@2', 'TEAM-PROPOSAL@2', 'HUMAN-REQUIREMENTS@2', 'FUN-DEFINITION@2', 'ENV-PROFILE@2']);
    expect((await h.artifacts.latest(h.project.id, 'FUN-DEFINITION'))!.status).toBe('proposed');
  });
});
