import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { Conductor } from '../src/engine/conductor/index.ts';
import { IllegalTransition, type MilestonePhase } from '../src/engine/fsm.ts';
import type { NewInboxItem } from '../src/engine/inbox.ts';
import { createApp } from '../src/server/app.ts';
import { lockSpec, projectOf, ticketTask } from './helpers/apply.ts';
import { makeEngine, ticket, until, type TestEngine } from './helpers/engine.ts';
import { commitAll, makeRepo, revParse, tempDir } from './helpers/repo.ts';

const PORT = 4780;
const host = `127.0.0.1:${PORT}`;

describe('the API', () => {
  let e: TestEngine;
  let app: Hono;

  beforeEach(async () => {
    e = await makeEngine({ steps: [], config: { port: PORT } });
    app = createApp(e);
  });

  afterEach(async () => {
    await e.cleanup();
  });

  const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { host, ...init.headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    req(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  describe('the guard', () => {
    it.each([['evil.example:4780'], ['127.0.0.1.evil.example:4780'], ['localhost:9999'], ['localhost'], ['127.0.0.1']])('refuses Host %s', async (h) => {
      expect((await req('/api/tasks', { headers: { host: h } })).status).toBe(403);
    });

    it('refuses a request with no Host', async () => {
      expect((await app.request('/api/tasks')).status).toBe(403);
    });

    it.each([['127.0.0.1:4780'], ['localhost:4780']])('accepts Host %s', async (h) => {
      expect((await req('/api/tasks', { headers: { host: h } })).status).toBe(200);
    });

    it('guards every route, known or not', async () => {
      expect((await req('/nothing/here', { headers: { host: 'evil.example:4780' } })).status).toBe(403);
    });

    it('refuses a foreign Origin on write', async () => {
      const res = await post('/api/projects', { name: 'q', repoPath: '/tmp/q' }, { origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect((await e.store.listProjects()).map((p) => p.name)).toEqual(['p']);
    });

    it.each([['https://evil.example'], ['http://127.0.0.1:9999'], ['https://127.0.0.1:4780'], ['null']])('refuses Origin %s on read', async (origin) => {
      expect((await req('/api/tasks', { headers: { origin } })).status).toBe(403);
    });

    it.each([['http://127.0.0.1:4780'], ['http://localhost:4780']])('accepts Origin %s', async (origin) => {
      expect((await req('/api/tasks', { headers: { origin } })).status).toBe(200);
    });

    it.each([['text/plain'], ['application/x-www-form-urlencoded'], ['multipart/form-data']])('refuses a simple cross-site POST sent as %s', async (type) => {
      const res = await req('/api/projects', { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify({ name: 'q', repoPath: '/tmp/q' }) });
      expect(res.status).toBe(415);
    });

    it('refuses a write with no Content-Type', async () => {
      expect((await req('/api/tasks/1/cancel', { method: 'POST' })).status).toBe(415);
    });

    it('accepts JSON with a charset', async () => {
      const res = await post('/api/projects', {}, { 'content-type': 'Application/JSON; charset=utf-8' });
      expect(res.status).toBe(400);
    });
  });

  it('answers health', async () => {
    const res = await req('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  describe('projects', () => {
    it('adds and lists a project', async () => {
      const { path } = await makeRepo();

      const res = await post('/api/projects', { name: 'q', repoPath: path });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ name: 'q', repo_path: path });
      const listed = (await (await req('/api/projects')).json()) as { name: string }[];
      expect(listed.map((p) => p.name)).toEqual(['p', 'q']);
    });

    it('creates the repo when asked', async () => {
      const path = join(tempDir(), 'fresh');

      const res = await post('/api/projects', { name: 'q', repoPath: path, create: true });

      expect(res.status).toBe(201);
      expect(existsSync(join(path, '.git'))).toBe(true);
    });

    it('reports a bad repo as 400 and names it', async () => {
      const path = tempDir();

      const res = await post('/api/projects', { name: 'q', repoPath: path });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(path);
    });

    it('reports a duplicate as 409', async () => {
      const { path } = await makeRepo();

      const res = await post('/api/projects', { name: 'P', repoPath: path });

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('already exists');
    });

    it.each([
      [{ repoPath: '/tmp/q' }, 'name'],
      [{ name: 'q' }, 'repoPath'],
      [{ name: 7, repoPath: '/tmp/q' }, 'name'],
      [{ name: 'q', repoPath: 'relative/path' }, 'repoPath'],
      [{ name: 'q', repoPath: '/tmp/q', create: 'yes' }, 'create'],
    ])('rejects %j, naming %s', async (body, field) => {
      const res = await post('/api/projects', body);

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(field);
    });

    it('rejects a body that is not JSON', async () => {
      const res = await req('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('JSON');
    });
  });

  describe('tickets', () => {
    it('creates a task from a ticket', async () => {
      const res = await post('/api/projects/p/tickets', { markdown: ticket({ id: 'T-9' }) });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ ticket_id: 'T-9', state: 'queued' });
    });

    it('reports a bad ticket as 400 and names the field', async () => {
      const res = await post('/api/projects/p/tickets', { markdown: ticket({ touches: [] }) });

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('touches');
    });

    it('reports a duplicate as 409', async () => {
      await post('/api/projects/p/tickets', { markdown: ticket() });

      const res = await post('/api/projects/p/tickets', { markdown: ticket() });

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('already exists');
    });

    it('reports an unknown project as 404', async () => {
      const res = await post('/api/projects/ghost/tickets', { markdown: ticket() });

      expect(res.status).toBe(404);
      expect(await errorOf(res)).toContain('ghost');
    });

    it('requires the markdown', async () => {
      const res = await post('/api/projects/p/tickets', {});

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('markdown');
    });
  });

  describe('tasks', () => {
    async function withAttempt(usage: { inTok: number; outTok: number; usdEst?: number } | null = null, manifest: unknown = null) {
      const t = await e.addTicket(ticket());
      const attempt = await e.store.createAttempt({ task_id: t.id, adapter: 'claude-code', model: 'm', worktree_path: '/w', branch: 'b' });
      await e.store.patchAttempt(attempt.id, { usage, manifest });
      return { t, attempt };
    }

    it('lists tasks, with their attempts and estimated cost', async () => {
      const { t, attempt } = await withAttempt({ inTok: 1, outTok: 1, usdEst: 0.25 });
      await e.store.setAttemptState(attempt.id, 'running');
      await e.store.setAttemptState(attempt.id, 'failed');
      const second = await e.store.createAttempt({ task_id: t.id, adapter: 'claude-code', model: 'm', worktree_path: '/w2', branch: 'b2' });
      await e.store.patchAttempt(second.id, { usage: { inTok: 1, outTok: 1, usdEst: 0.5 } });

      const res = await req('/api/tasks');

      expect(await res.json()).toMatchObject([{ id: t.id, attempts: 2, usdEst: 0.75 }]);
    });

    it('filters by project', async () => {
      const t = await e.addTicket(ticket());
      const other = await makeRepo();
      await post('/api/projects', { name: 'q', repoPath: other.path });
      await post('/api/projects/q/tickets', { markdown: ticket({ id: 'T-2' }) });

      const onlyP = (await (await req('/api/tasks?project=p')).json()) as { id: number }[];
      const everything = (await (await req('/api/tasks')).json()) as { id: number }[];

      expect(onlyP.map((task) => task.id)).toEqual([t.id]);
      expect(everything).toHaveLength(2);
    });

    it('reports an unknown project filter as 404', async () => {
      expect((await req('/api/tasks?project=ghost')).status).toBe(404);
    });

    it('task detail omits manifest text; the manifest route returns it', async () => {
      const manifest = { system: 'THE SYSTEM PROMPT', task: 'THE TASK', parts: [] };
      const { t, attempt } = await withAttempt(null, manifest);

      const detail = await req(`/api/tasks/${t.id}`);
      const text = await detail.text();

      expect(detail.status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ task: { id: t.id }, attempts: [{ id: attempt.id }] });
      expect(text).not.toContain('THE SYSTEM PROMPT');
      expect(JSON.parse(text).attempts[0]).not.toHaveProperty('manifest');

      const stored = await req(`/api/attempts/${attempt.id}/manifest`);
      expect(stored.status).toBe(200);
      expect(await stored.json()).toEqual(manifest);
    });

    it.each([['/api/tasks/999'], ['/api/tasks/abc'], ['/api/tasks/1.5'], ['/api/attempts/999/manifest'], ['/api/attempts/abc/manifest']])('%s is 404', async (path) => {
      expect((await req(path)).status).toBe(404);
    });

    it('takes only plain digits as an id', async () => {
      const t = await e.addTicket(ticket());
      expect((await req(`/api/tasks/${t.id}`)).status).toBe(200);

      expect((await req(`/api/tasks/0x${t.id.toString(16)}`)).status).toBe(404);
    });

    it('lists a task with no attempts as none, at no known cost', async () => {
      await e.addTicket(ticket());

      expect(await (await req('/api/tasks')).json()).toMatchObject([{ attempts: 0, usdEst: null }]);
    });

    it('an attempt with no manifest yet is 404', async () => {
      const { attempt } = await withAttempt();

      expect((await req(`/api/attempts/${attempt.id}/manifest`)).status).toBe(404);
    });

    it('cancels a task', async () => {
      const t = await e.addTicket(ticket());

      const res = await post(`/api/tasks/${t.id}/cancel`, {});

      expect(res.status).toBe(202);
      expect((await e.store.getTask(t.id))!.state).toBe('cancelled');
    });

    it('cancel on a finished task is 409', async () => {
      const t = await e.addTicket(ticket());
      await e.store.setTaskState(t.id, 'cancelled');

      const res = await post(`/api/tasks/${t.id}/cancel`, {});

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('cancelled');
    });

    it('retries an escalated task', async () => {
      const t = await e.addTicket(ticket());
      await e.store.setTaskState(t.id, 'escalated');

      const res = await post(`/api/tasks/${t.id}/retry`, {});

      expect(res.status).toBe(202);
      expect((await e.store.getTask(t.id))!.state).toBe('ready');
    });

    it('retry on a non-escalated task is 409', async () => {
      const t = await e.addTicket(ticket());

      const res = await post(`/api/tasks/${t.id}/retry`, {});

      expect(res.status).toBe(409);
      expect((await e.store.getTask(t.id))!.state).toBe('queued');
    });

    it.each([['cancel'], ['retry']])('%s on an unknown task is 404', async (action) => {
      expect((await post(`/api/tasks/999/${action}`, {})).status).toBe(404);
    });

    it('refuses to cancel a task the conductor owns', async () => {
      const spec = await ticketTask(e, 'M1-SPEC', { kind: 'authoring', purpose: 'milestone_spec' });

      const res = await post(`/api/tasks/${spec.id}/cancel`, {});

      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('Halt');
      expect((await e.store.getTask(spec.id))!.state).toBe('queued');
    });

    it('adds the kind, purpose, criteria, parent and specialty to a task and filters by milestone', async () => {
      const parent = await ticketTask(e, 'M1-T-1', { ac_refs: ['AC-1'] });
      await ticketTask(e, 'M2-T-1', { milestone: 2 });
      await ticketTask(e, 'M1-T-1-R1', { kind: 'code_review', purpose: 'code_review', parent_task_id: parent.id, role_id: 'code_reviewer' });

      const rows = (await (await req('/api/tasks?project=p&milestone=1')).json()) as { ticket_id: string }[];

      expect(rows.map((row) => row.ticket_id)).toEqual(['M1-T-1', 'M1-T-1-R1']);
      expect(rows[0]).toMatchObject({ kind: 'ticket', ac_refs: ['AC-1'], specialty: 'engineer', parent_task_id: null });
      expect(rows[1]).toMatchObject({ kind: 'code_review', purpose: 'code_review', specialty: 'code_reviewer', parent_task_id: parent.id });
    });

    it('refuses a milestone that is not a number', async () => {
      expect((await req('/api/tasks?milestone=one')).status).toBe(400);
    });
  });

  const approval = async (overrides: Partial<NewInboxItem> = {}) =>
    e.store.raiseInbox({
      project_id: (await projectOf(e)).id,
      milestone: 1,
      type: 'approval',
      dedupe_key: 'cp2:1',
      ref: { kind: 'cp2', milestone: 1 },
      title: 'Approve the spec',
      asked_by: 'pm',
      why: 'The team needs locked criteria',
      blocks: ['Milestone 1 design'],
      evidence: [],
      recommendation: 'Approve it',
      options: [],
      ...overrides,
    });

  describe('a brief', () => {
    it('starts a project from a brief, once', async () => {
      const first = await post('/api/projects/p/brief', { markdown: '# Brief\n\nA small tool.\n' });
      const second = await post('/api/projects/p/brief', { markdown: '# Another\n' });

      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({ artifact_id: 'BRIEF', type: 'brief', status: 'approved', approved_by: 'stakeholder', version: 1 });
      expect(second.status).toBe(409);
      const doc = await e.artifacts.read(await projectOf(e), 'BRIEF');
      expect(doc.body).toBe('# Brief\n\nA small tool.\n');

      await new Conductor(e, e.runner).tick();

      expect((await projectOf(e)).phase).toBe('discovery');
    });

    it('gives two briefs sent at once a single version between them', async () => {
      const responses = await Promise.all([post('/api/projects/p/brief', { markdown: '# One\n' }), post('/api/projects/p/brief', { markdown: '# Two\n' })]);

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect((await e.artifacts.latest((await projectOf(e)).id, 'BRIEF'))!.version).toBe(1);
    });

    it.each([[''], ['  \n\t '], [7]])('refuses the brief %j', async (markdown) => {
      expect((await post('/api/projects/p/brief', { markdown })).status).toBe(400);
      expect(await e.artifacts.latest((await projectOf(e)).id, 'BRIEF')).toBeUndefined();
    });

    it('is 404 for an unknown project', async () => {
      expect((await post('/api/projects/nope/brief', { markdown: '# Brief\n' })).status).toBe(404);
    });

    it('refuses a brief for a halted project, which nothing would ever pick up', async () => {
      await post('/api/projects/p/halt', { reason: 'Not needed' });

      expect((await post('/api/projects/p/brief', { markdown: '# Brief\n' })).status).toBe(409);
    });
  });

  describe('projects', () => {
    const toPhase = async (n: number, phases: MilestonePhase[]) => {
      const { id } = await projectOf(e);
      for (const phase of phases) await e.store.setMilestonePhase(id, n, phase);
    };
    const milestone = async (n: number, title: string) => e.store.createMilestone({ project_id: (await projectOf(e)).id, n, title, goal: `Goal ${n}`, phase: 'pending' });
    const MERGED: MilestonePhase[] = ['spec', 'cp2', 'design', 'build', 'verify', 'milestone_review', 'cp4', 'merging', 'merged'];

    it('adds the current milestone and the pending count to each project', async () => {
      await milestone(1, 'One');
      await milestone(2, 'Two');
      await milestone(3, 'Three');
      await toPhase(1, MERGED);
      await toPhase(2, ['spec']);
      await approval();
      await approval({ dedupe_key: 'other' });

      const [row] = (await (await req('/api/projects')).json()) as Record<string, unknown>[];

      expect(row).toMatchObject({ name: 'p', phase: 'intake', pending: 2, milestone: { n: 2, title: 'Two', phase: 'spec' } });
    });

    it('shows the last milestone once all are merged, and none before there are any', async () => {
      const before = (await (await req('/api/projects')).json()) as Record<string, unknown>[];
      expect(before[0]).toMatchObject({ milestone: null, pending: 0 });

      await milestone(1, 'One');
      await toPhase(1, MERGED);

      const after = (await (await req('/api/projects')).json()) as Record<string, unknown>[];
      expect(after[0]).toMatchObject({ milestone: { n: 1, phase: 'merged' } });
    });

    it('returns a project with its milestones and totals', async () => {
      await milestone(1, 'One');
      await toPhase(1, ['spec']);
      const a = await ticketTask(e, 'M1-T-1');
      const b = await ticketTask(e, 'M1-T-2');
      for (const [task, usdEst] of [[a, 1.25], [b, 0.5]] as const) {
        const attempt = await e.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: 'b' });
        await e.store.patchAttempt(attempt.id, { usage: { inTok: 1, outTok: 1, usdEst } });
      }

      const res = await req('/api/projects/p');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ name: 'p', milestones: [{ n: 1, title: 'One', phase: 'spec' }], totals: { attempts: 2, usdEst: 1.75 } });
    });

    it('reports no estimate, not a zero, when no attempt reported a cost', async () => {
      const task = await ticketTask(e, 'M1-T-1');
      await e.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: 'b' });

      expect(await (await req('/api/projects/p')).json()).toMatchObject({ totals: { attempts: 1, usdEst: null } });
    });

    it('is 404 for an unknown project', async () => {
      expect((await req('/api/projects/nope')).status).toBe(404);
    });
  });

  describe('the Inbox', () => {
    const answer = (id: number | string, body: unknown, headers: Record<string, string> = {}) => post(`/api/inbox/${id}/answer`, body, headers);
    const question = (overrides: Partial<NewInboxItem> = {}) =>
      approval({ type: 'question', dedupe_key: 'q', ref: { kind: 'escalation', taskId: 7 }, options: [{ id: 'retry', label: 'Retry' }], ...overrides });

    it('returns 409 to the second of two answers', async () => {
      const { id } = await approval();

      const first = await answer(id, { action: 'approve' });
      const second = await answer(id, { action: 'reject' });

      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ id, state: 'answered', answer: { action: 'approve' } });
      expect(second.status).toBe(409);
      expect((await e.store.getInbox(id))!.answer).toEqual({ action: 'approve' });
    });

    it('records one of two answers sent at once', async () => {
      const { id } = await approval();

      const responses = await Promise.all([answer(id, { action: 'approve' }), answer(id, { action: 'reject' })]);

      expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    });

    it('returns 404 for an unknown item and 400 for the wrong answer shape', async () => {
      const approvalItem = await approval();
      const questionItem = await question();

      expect((await answer(999, { action: 'approve' })).status).toBe(404);
      expect((await answer('nope', { action: 'approve' })).status).toBe(404);
      for (const [id, body] of [
        [approvalItem.id, {}],
        [approvalItem.id, { option: 'retry' }],
        [approvalItem.id, { action: 'merge' }],
        [approvalItem.id, { action: 'request_changes' }],
        [approvalItem.id, { action: 'request_changes', comment: 7 }],
        [questionItem.id, { action: 'approve' }],
        [questionItem.id, { option: 'nope' }],
        [questionItem.id, { text: '  ' }],
      ] as const) {
        expect((await answer(id, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await e.store.getInbox(approvalItem.id))!.state).toBe('pending');
      expect((await e.store.getInbox(questionItem.id))!.state).toBe('pending');
    });

    it('keeps nothing but the answer itself in the durable record', async () => {
      const { id } = await approval();

      await answer(id, { action: 'request_changes', comment: 'Tighten it', comments: 'x', approved_by: 'someone else' });

      expect((await e.store.getInbox(id))!.answer).toEqual({ action: 'request_changes', comment: 'Tighten it' });
    });

    it('takes an option or written words for a question', async () => {
      const a = await question();
      const b = await question({ dedupe_key: 'q2' });

      expect((await answer(a.id, { option: 'retry' })).status).toBe(200);
      expect((await answer(b.id, { text: 'Use the old one' })).status).toBe(200);

      expect((await e.store.getInbox(a.id))!.answer).toEqual({ option: 'retry' });
      expect((await e.store.getInbox(b.id))!.answer).toEqual({ text: 'Use the old one' });
    });

    it('counts pending items across projects and filters by project', async () => {
      const other = await e.store.createProject({ name: 'q', repo_path: '/q', base_branch: 'main' });
      await approval();
      await approval({ project_id: other.id });
      const closed = await approval({ dedupe_key: 'closed' });
      await e.store.answerInbox(closed.id, { action: 'approve' });

      const all = (await (await req('/api/inbox')).json()) as { count: number; items: { project: string }[] };
      const mine = (await (await req('/api/inbox?project=p')).json()) as { count: number; items: { project: string }[] };

      expect(all.count).toBe(2);
      expect(all.items.map(({ project }) => project).sort()).toEqual(['p', 'q']);
      expect(mine.count).toBe(2);
      expect(mine.items.map(({ project }) => project)).toEqual(['p']);
      expect((await req('/api/inbox?project=nope')).status).toBe(404);
    });

    it('says how old each item is', async () => {
      const { created_at } = await approval();
      e.now = () => new Date(Date.parse(created_at) + 90_000);

      const { items } = (await (await req('/api/inbox')).json()) as { items: { ageS: number }[] };

      expect(items[0]!.ageS).toBe(90);
    });

    it('refuses a cross-origin answer', async () => {
      const { id } = await approval();

      const res = await answer(id, { action: 'approve' }, { origin: 'https://evil.example' });

      expect(res.status).toBe(403);
      expect((await e.store.getInbox(id))!.state).toBe('pending');
    });
  });

  describe('documents', () => {
    const publish = async (id: string, body: string, derivedFrom: string[] = []) =>
      e.artifacts.commit(await projectOf(e), { message: id, publish: [{ id, type: 'tech_design', status: 'proposed', ownerRole: 'tech_lead', derivedFrom, body }] });

    it('lists the latest version of each document', async () => {
      await publish('NOTES', '# First\n');
      await publish('NOTES', '# Second\n');
      await publish('OTHER', '# Other\n');

      const rows = (await (await req('/api/projects/p/artifacts')).json()) as { artifact_id: string; version: number }[];

      expect(rows.map(({ artifact_id, version }) => [artifact_id, version])).toEqual([['NOTES', 2], ['OTHER', 1]]);
    });

    it('returns artifact text as JSON, never rendered', async () => {
      const hostile = '# Notes\n\n<script>alert(1)</script>\n';
      await publish('NOTES', hostile);

      const res = await req('/api/projects/p/artifacts/NOTES');

      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toMatchObject({ id: 'NOTES', body: hostile });
    });

    it('returns a chosen version along with every version there is', async () => {
      await publish('NOTES', '# First\n');
      await publish('NOTES', '# Second\n');

      const latest = (await (await req('/api/projects/p/artifacts/NOTES')).json()) as { version: number; versions: { version: number; status: string }[] };
      const older = await (await req('/api/projects/p/artifacts/NOTES?version=1')).json();

      expect(latest.version).toBe(2);
      expect(latest.versions.map(({ version, status }) => [version, status])).toEqual([[1, 'superseded'], [2, 'proposed']]);
      expect(older).toMatchObject({ version: 1, body: '# First\n', status: 'superseded' });
    });

    it.each([['/api/projects/p/artifacts/..%2F..%2Fx'], ['/api/projects/p/artifacts/.hidden'], ['/api/projects/p/artifacts/..%2F..%2Fx/diff?from=1&to=2'], ['/api/projects/p/artifacts/a%00b']])('refuses artifact ids that are not safe: %s', async (path) => {
      expect((await req(path)).status).toBe(400);
    });

    it('is 404 for an unknown document, version or project', async () => {
      await publish('NOTES', '# First\n');

      expect((await req('/api/projects/p/artifacts/NOPE')).status).toBe(404);
      expect((await req('/api/projects/p/artifacts/NOTES?version=9')).status).toBe(404);
      expect((await req('/api/projects/nope/artifacts')).status).toBe(404);
      expect((await req('/api/projects/nope/artifacts/NOTES')).status).toBe(404);
      expect((await req('/api/projects/nope/lineage')).status).toBe(404);
      expect((await req('/api/projects/nope/acs')).status).toBe(404);
    });

    it('refuses a version that is not a number', async () => {
      await publish('NOTES', '# First\n');

      expect((await req('/api/projects/p/artifacts/NOTES?version=latest')).status).toBe(400);
    });

    it('diffs two versions', async () => {
      await publish('NOTES', '# First\n');
      await publish('NOTES', '# Second\n');

      const { diff } = (await (await req('/api/projects/p/artifacts/NOTES/diff?from=1&to=2')).json()) as { diff: string };

      expect(diff).toContain('-# First');
      expect(diff).toContain('+# Second');
    });

    it('needs two real versions to diff', async () => {
      await publish('NOTES', '# First\n');

      expect((await req('/api/projects/p/artifacts/NOTES/diff?from=1')).status).toBe(400);
      expect((await req('/api/projects/p/artifacts/NOTES/diff?from=1&to=two')).status).toBe(400);
      expect((await req('/api/projects/p/artifacts/NOTES/diff?from=1&to=9')).status).toBe(404);
    });

    it('returns the lineage graph', async () => {
      await publish('SOURCE', '# Source\n');
      await publish('DERIVED', '# Derived\n', ['SOURCE@1']);

      const graph = (await (await req('/api/projects/p/lineage')).json()) as { nodes: { id: string }[]; edges: unknown[] };

      expect(graph.nodes.map(({ id }) => id).sort()).toEqual(['DERIVED', 'SOURCE']);
      expect(graph.edges).toMatchObject([{ from: 'SOURCE', to: 'DERIVED', stale: false, pinnedVersion: 1 }]);
    });
  });

  describe('acceptance criteria', () => {
    const acs = async (query = '?milestone=1') => (await (await req(`/api/projects/p/acs${query}`)).json()) as Record<string, unknown>[];

    it('shows AC status only from the registry', async () => {
      await lockSpec(e);
      const project = await projectOf(e);
      const worker = await ticketTask(e, 'M1-T-1', { ac_refs: ['AC-1'] });
      const attempt = await e.store.createAttempt({ task_id: worker.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: 'b' });
      await e.store.patchAttempt(attempt.id, { output: { summary: 'AC-1 passes', commands_run: [{ command: 'npm test', exit_code: 0 }] } });

      expect((await acs())[0]).toMatchObject({ ac_id: 'AC-1', status: 'unverified', evidence_ref: null });

      const qa = await ticketTask(e, 'M1-QA-1', { kind: 'qa_verify' });
      await e.store.recordVerification(project.id, 1, 'AC-1', { status: 'passing', evidenceRef: 'QA-REPORT-M1@1', verifiedBy: { kind: 'qa_verify', taskId: qa.id } });

      expect((await acs())[0]).toMatchObject({ ac_id: 'AC-1', status: 'passing', evidence_ref: 'QA-REPORT-M1@1' });
    });

    it('joins each criterion to its tickets and Test Plan commands', async () => {
      await lockSpec(e);
      await ticketTask(e, 'M1-T-1', { ac_refs: ['AC-1'] });
      await ticketTask(e, 'M1-T-2', { ac_refs: ['AC-1', 'AC-2'] });
      await ticketTask(e, 'M2-T-1', { milestone: 2, ac_refs: ['AC-1'] });
      await e.store.setTaskState((await ticketTask(e, 'M1-T-3', { ac_refs: ['AC-1'] })).id, 'cancelled');
      await ticketTask(e, 'M1-T-1-R1', { kind: 'code_review', ac_refs: ['AC-1'] });
      await e.artifacts.commit(await projectOf(e), {
        message: 'plan',
        publish: [{ id: 'TEST-PLAN-M1', type: 'test_plan', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], milestone: 1, body: '# Plan\n', fields: { data: { coverage: [{ ac: 'AC-1', commands: ['npm test -- first'], notes: '' }, { ac: 'AC-2', commands: ['npm test -- second'], notes: '' }] } } }],
      });

      expect(await acs()).toMatchObject([
        { ac_id: 'AC-1', tickets: ['M1-T-1', 'M1-T-2'], commands: ['npm test -- first'] },
        { ac_id: 'AC-2', tickets: ['M1-T-2'], commands: ['npm test -- second'] },
      ]);
    });

    it('has no commands before there is a Test Plan', async () => {
      await lockSpec(e);

      expect((await acs())[0]).toMatchObject({ tickets: [], commands: [] });
    });

    it('takes the current milestone when none is named', async () => {
      await lockSpec(e);
      await e.store.createMilestone({ project_id: (await projectOf(e)).id, n: 1, title: 'One', goal: 'g', phase: 'pending' });

      expect((await acs('')).map(({ ac_id }) => ac_id)).toEqual(['AC-1', 'AC-2']);
    });

    it('is empty with no milestone at all, and refuses a bad one', async () => {
      expect(await acs('')).toEqual([]);
      expect((await req('/api/projects/p/acs?milestone=one')).status).toBe(400);
    });
  });

  describe('Change Requests', () => {
    const request = { target_artifact: 'SPEC-M1', target_ac: 'AC-1', proposed_text: 'The first thing works fast', rationale: 'It was slow', evidence: 'A timing run' };

    it('files one in the stakeholder’s name', async () => {
      await lockSpec(e);

      const res = await post('/api/projects/p/change-requests', { ...request, raised_by: 'pm' });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ artifact_id: 'CR-1', type: 'change_request' });
      const doc = await e.artifacts.read(await projectOf(e), 'CR-1');
      expect(doc.fields.data).toMatchObject({ raised_by: 'stakeholder', target_ac: 'AC-1' });
    });

    it('carries a new verification command for the criterion', async () => {
      await lockSpec(e);

      expect((await post('/api/projects/p/change-requests', { ...request, proposed_verification: 'npm test -- first --reporter=tap' })).status).toBe(201);

      const doc = await e.artifacts.read(await projectOf(e), 'CR-1');
      expect(doc.fields.data).toMatchObject({ proposed_verification: 'npm test -- first --reporter=tap' });
    });

    it('is 409 for a request the engine can’t file', async () => {
      await lockSpec(e);

      const res = await post('/api/projects/p/change-requests', { ...request, target_artifact: 'NOPE' });

      expect(res.status).toBe(409);
      expect(await e.artifacts.latest((await projectOf(e)).id, 'CR-1')).toBeUndefined();
    });

    it('is 400 when a field is missing and 404 for an unknown project', async () => {
      await lockSpec(e);

      expect((await post('/api/projects/p/change-requests', { target_artifact: 'SPEC-M1' })).status).toBe(400);
      expect((await post('/api/projects/nope/change-requests', request)).status).toBe(404);
    });

    it('is 409 once the project has stopped', async () => {
      await lockSpec(e);
      await post('/api/projects/p/halt', { reason: 'Not needed' });

      expect((await post('/api/projects/p/change-requests', request)).status).toBe(409);
    });
  });

  describe('halting', () => {
    it('halts a project and stops its running tasks', async () => {
      const slow = await makeEngine({ steps: [{ lines: [], delayMs: 120_000 }], config: { port: PORT } });
      try {
        const served = createApp(slow);
        const t = await slow.addTicket(ticket());
        await slow.store.setTaskState(t.id, 'ready');
        await slow.runner.begin(t.id);
        void slow.runner.execute(t.id);
        await until(async () => slow.spawnCount() === 1);

        const res = await served.request('/api/projects/p/halt', { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Not needed' }) });

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ name: 'p', phase: 'halted' });
        expect((await slow.store.getTask(t.id))!.state).toBe('cancelled');
      } finally {
        await slow.cleanup();
      }
    });

    it('carries on past a task that finished as the halt reached it', async () => {
      const finished = await ticketTask(e, 'M1-T-1');
      vi.spyOn(e.runner, 'cancel').mockRejectedValueOnce(new IllegalTransition('task', 'done', 'cancelled'));

      const res = await post('/api/projects/p/halt', { reason: 'Not needed' });

      expect(res.status).toBe(200);
      expect((await projectOf(e)).phase).toBe('halted');
      expect(finished.id).toBeGreaterThan(0);
    });

    it('withdraws what was waiting on the stakeholder', async () => {
      const { id } = await approval();

      await post('/api/projects/p/halt', { reason: 'Not needed' });

      expect((await e.store.getInbox(id))!.state).toBe('withdrawn');
    });

    it('is 409 once the project has stopped', async () => {
      await post('/api/projects/p/halt', { reason: 'Not needed' });

      expect((await post('/api/projects/p/halt', { reason: 'Again' })).status).toBe(409);
    });

    it('needs a reason, and a project', async () => {
      expect((await post('/api/projects/p/halt', {})).status).toBe(400);
      expect((await post('/api/projects/nope/halt', { reason: 'Why' })).status).toBe(404);
      expect((await projectOf(e)).phase).toBe('intake');
    });
  });

  describe('an attempt’s diff', () => {
    const attemptOf = async (shas: { base_sha?: string; head_sha?: string }) => {
      const task = await ticketTask(e, `M1-T-${Math.random()}`);
      const attempt = await e.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: 'b' });
      return e.store.patchAttempt(attempt.id, shas);
    };

    it('returns the change the attempt made', async () => {
      const base = await revParse(e.repoPath);
      writeFileSync(join(e.repoPath, 'added.txt'), 'a new line\n');
      const head = commitAll(e.repoPath, 'the attempt');
      const { id } = await attemptOf({ base_sha: base, head_sha: head });

      const res = (await (await req(`/api/attempts/${id}/diff`)).json()) as { diff: string; base: string; head: string };

      expect(res).toMatchObject({ base, head });
      expect(res.diff).toContain('+a new line');
    });

    it('returns a null diff before an attempt has a head', async () => {
      const { id } = await attemptOf({ base_sha: await revParse(e.repoPath) });

      expect(await (await req(`/api/attempts/${id}/diff`)).json()).toMatchObject({ diff: null });
    });

    it('returns a null diff once its commit is gone', async () => {
      const base = await revParse(e.repoPath);
      const head = 'f'.repeat(40);
      const { id } = await attemptOf({ base_sha: base, head_sha: head });

      expect(await (await req(`/api/attempts/${id}/diff`)).json()).toEqual({ diff: null, base, head });
    });

    it('is 404 for an unknown attempt', async () => {
      expect((await req('/api/attempts/999/diff')).status).toBe(404);
      expect((await req('/api/attempts/nope/diff')).status).toBe(404);
    });
  });
});
