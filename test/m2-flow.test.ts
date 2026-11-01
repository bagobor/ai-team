import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Hono } from 'hono';
import type { LineageGraph } from '../src/artifacts/lineage.ts';
import type { InboxAnswer, InboxRef, InboxRow } from '../src/engine/inbox.ts';
import { manifestDir } from '../src/paths.ts';
import { createApp } from '../src/server/app.ts';
import { M2_BRIEF, m2Script } from './fixtures/m2-script.ts';
import { makeProjectEngine, type ProjectEngine } from './helpers/engine.ts';
import { porcelain, revParse, run, symbolicHead, tempDir } from './helpers/repo.ts';

vi.setConfig({ testTimeout: 60_000 });

const PORT = 4780;
const host = `127.0.0.1:${PORT}`;
const CHECKPOINTS: InboxRef['kind'][] = ['cp1', 'cp2', 'cp4'];

type ProjectView = { phase: string; milestones: { n: number; phase: string }[] };

const fileAt = (repo: string, ref: string, path: string) => run(repo, 'show', `${ref}:${path}`);

describe('the whole M2 flow', () => {
  let e: ProjectEngine;
  let app: Hono;
  let repo: string;

  const start = async (script = m2Script()) => {
    e = await makeProjectEngine({ byTask: script.byTask, config: { port: PORT } });
    app = createApp(e);
    repo = e.repoPath;
  };

  afterEach(async () => {
    await e.cleanup();
  });

  const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { host, ...init.headers } });
  const post = (path: string, body: unknown) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const inbox = async () => ((await (await req('/api/inbox?project=p')).json()) as { items: InboxRow[] }).items;
  const pending = async (kind: InboxRef['kind']) => (await inbox()).some(({ ref }) => ref.kind === kind);
  const answer = async (kind: InboxRef['kind'], body: InboxAnswer) => {
    const item = (await inbox()).find(({ ref }) => ref.kind === kind);
    if (!item) throw new Error(`Nothing is waiting at ${kind}`);
    const res = await post(`/api/inbox/${item.id}/answer`, body);
    expect(res.status).toBe(200);
  };
  const project = async () => (await (await req('/api/projects/p')).json()) as ProjectView;
  const phaseIs = async (phase: string) => (await project()).milestones[0]?.phase === phase;
  const reached = async (phase: string) => {
    const { phase: own, milestones } = await project();
    return own === phase || milestones[0]?.phase === phase;
  };
  const stateOf = async (ticketId: string) => (await e.store.getTaskByTicket((await e.store.getProject('p'))!.id, ticketId))?.state;
  const criteria = async () => e.store.listCriteria((await e.store.getProject('p'))!.id, 1);
  const postBrief = async () => expect((await post('/api/projects/p/brief', { markdown: M2_BRIEF })).status).toBe(201);

  const toCp4 = async () => {
    await postBrief();
    await e.drive(() => pending('cp1'));
    await answer('cp1', { action: 'approve' });
    await e.drive(() => pending('cp2'));
    await answer('cp2', { action: 'approve' });
    await e.drive(() => pending('cp4'));
  };

  // Stops when done says so, and says yes to every checkpoint on the way.
  const approveUntil = (done: () => Promise<boolean>) =>
    e.drive(async () => {
      if (await done()) return true;
      for (const { id, ref } of await inbox()) {
        if (CHECKPOINTS.includes(ref.kind)) expect((await post(`/api/inbox/${id}/answer`, { action: 'approve' })).status).toBe(200);
      }
      return false;
    });

  it('takes a brief to a merged milestone with approvals only through the API', async () => {
    await start();
    await toCp4();
    expect((await criteria()).map(({ ac_id, status }) => [ac_id, status])).toEqual([
      ['AC-1', 'passing'],
      ['AC-2', 'passing'],
    ]);

    await answer('cp4', { action: 'approve' });
    await e.drive(() => phaseIs('merged'));

    expect(fileAt(repo, 'main', 'tempconv.mjs')).toContain('export');
    expect(fileAt(repo, 'main', '.aiteam/artifacts/spec/SPEC-M1.md')).toContain('status: approved');
    expect(execFileSync('node', ['tempconv.mjs', 'c2f', '100'], { cwd: repo, encoding: 'utf8' })).toBe('212\n');
    expect((await project()).phase).toBe('closed');
  });

  it('holds main at its old commit until CP4 is approved', async () => {
    await start();
    const before = await revParse(repo, 'main');

    await postBrief();
    await e.drive(() => pending('cp1'));
    expect(await revParse(repo, 'main')).toBe(before);
    await answer('cp1', { action: 'approve' });
    await e.drive(() => pending('cp2'));
    expect(await revParse(repo, 'main')).toBe(before);
    await answer('cp2', { action: 'approve' });
    await e.drive(() => pending('cp4'));
    expect(await revParse(repo, 'main')).toBe(before);

    await answer('cp4', { action: 'approve' });
    await e.drive(() => phaseIs('merged'));

    expect(await revParse(repo, 'main')).not.toBe(before);
    expect(run(repo, 'merge-base', before, 'main')).toBe(before);
  });

  it('changes nothing in the checked-out working tree before CP4', async () => {
    await start();
    writeFileSync(join(repo, 'README.md'), '# my own unfinished edit\n');
    writeFileSync(join(repo, 'notes.txt'), 'my own notes\n');
    const status = await porcelain(repo);
    const head = await revParse(repo);

    await toCp4();

    expect(await porcelain(repo)).toBe(status);
    expect(await revParse(repo)).toBe(head);
    expect(await symbolicHead(repo)).toBe('refs/heads/main');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# my own unfinished edit\n');
  });

  it('goes through a QA failure, a Bug ticket and a second round', async () => {
    await start(m2Script({ failFirstQa: true }));
    await toCp4();

    const p = (await e.store.getProject('p'))!;
    const firstReport = await e.artifacts.read(p, 'QA-REPORT-M1-1');
    expect(firstReport.body).toContain('## AC-2\n\nStatus: failing');
    expect((await e.artifacts.read(p, 'BUG-M1-1')).body).toContain('f2c gives the wrong answer');
    expect(await stateOf('M1-B-1')).toBe('done');
    expect(await stateOf('M1-QA-2')).toBe('done');
    expect((await criteria()).map(({ status }) => status)).toEqual(['passing', 'passing']);

    await answer('cp4', { action: 'approve' });
    await e.drive(() => phaseIs('merged'));

    expect(execFileSync('node', ['tempconv.mjs', 'f2c', '212'], { cwd: repo, encoding: 'utf8' })).toBe('100\n');
  });

  it('gets back to a merged milestone after a Change Request during build', async () => {
    // The worker on the first ticket waits for this file, so that the request lands while that ticket is running.
    const gateDir = tempDir('aiteam-gate-');
    const gate = join(gateDir, 'open');
    const script = m2Script();
    script.byTask['M1-T-1'] = { ...script.byTask['M1-T-1'], waitForFile: gate };
    await start(script);

    await postBrief();
    await approveUntil(async () => (await stateOf('M1-T-1')) === 'running');

    const filed = await post('/api/projects/p/change-requests', {
      target_artifact: 'SPEC-M1',
      target_ac: 'AC-1',
      proposed_text: 'c2f prints the Fahrenheit value of a Celsius temperature, and nothing else',
      rationale: 'Scripts read the output',
      evidence: 'A shell script that uses it',
    });
    expect(filed.status).toBe(201);

    await e.drive(() => pending('cr'));
    await answer('cr', { action: 'approve' });
    await e.drive(async () => (await stateOf('M1-REVISE-TECH-M1-1')) === 'done' && (await stateOf('M1-REVISE-TEST-PLAN-M1-1')) === 'done');
    expect(await stateOf('M1-T-1')).toBe('running');

    writeFileSync(gate, '');
    await approveUntil(() => phaseIs('merged'));
    rmSync(gateDir, { recursive: true, force: true });

    const [first] = await criteria();
    expect(first).toMatchObject({ ac_id: 'AC-1', text: 'c2f prints the Fahrenheit value of a Celsius temperature, and nothing else', status: 'passing' });
    expect(fileAt(repo, 'main', 'tempconv.mjs')).toContain('f2c');
  });

  it.each([['discovery'], ['cp1'], ['spec'], ['cp2'], ['design'], ['build'], ['verify'], ['milestone_review'], ['cp4']])('resumes after a daemon stop in %s', async (phase) => {
    await start();
    await postBrief();
    await approveUntil(() => reached(phase));

    e = await e.restart();
    app = createApp(e);

    await approveUntil(() => phaseIs('merged'));
    expect(fileAt(repo, 'main', 'tempconv.mjs')).toContain('f2c');
    expect((await criteria()).map(({ status }) => status)).toEqual(['passing', 'passing']);
    expect(await inbox()).toEqual([]);
  });

  it('gives every attempt a fresh worktree and a manifest with only its own inputs', async () => {
    await start();
    await toCp4();

    const places = e.spawns().map(({ cwd }) => cwd);
    expect(new Set(places).size).toBe(places.length);
    expect(places.map((place) => basename(place))).toEqual(expect.arrayContaining(['DISCOVERY-PM-a1', 'M1-SPEC-a1', 'M1-T-1-a1', 'M1-T-1-R1-a1', 'M1-QA-1-a1']));

    const taskOf = (ticketId: string) => readFileSync(join(manifestDir(e.paths, 'p', ticketId, 1), 'task.md'), 'utf8');
    expect(taskOf('DISCOVERY-PM')).toContain('so I stop looking the formula up');
    expect(taskOf('M1-T-1')).toContain('nine fifths');
    expect(taskOf('M1-T-1')).not.toContain('names the direction');
    expect(taskOf('M1-T-1')).not.toContain('so I stop looking the formula up');
    expect(taskOf('M1-T-2')).toContain('names the direction');
    expect(taskOf('M1-T-2')).not.toContain('nine fifths');
  });

  it('records lineage from each ticket back to the brief', async () => {
    await start();
    await toCp4();

    const { edges } = (await (await req('/api/projects/p/lineage')).json()) as LineageGraph;
    const ancestorsOf = (id: string, seen = new Set<string>()): Set<string> => {
      for (const { from, to } of edges) {
        if (to !== id || seen.has(from)) continue;
        seen.add(from);
        ancestorsOf(from, seen);
      }
      return seen;
    };

    expect([...ancestorsOf('M1-T-1')]).toEqual(expect.arrayContaining(['TECH-M1', 'SPEC-M1', 'BRIEF']));
    expect([...ancestorsOf('M1-T-2')]).toEqual(expect.arrayContaining(['TECH-M1', 'SPEC-M1', 'BRIEF']));
    expect([...ancestorsOf('M1-Q-1')]).toEqual(expect.arrayContaining(['TEST-PLAN-M1', 'SPEC-M1', 'BRIEF']));
  });
});
