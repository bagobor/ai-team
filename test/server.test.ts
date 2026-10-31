import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../src/server/app.ts';
import { makeEngine, ticket, type TestEngine } from './helpers/engine.ts';
import { makeRepo, tempDir } from './helpers/repo.ts';

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
  });
});
