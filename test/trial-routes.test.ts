import type { Hono } from 'hono';
import { createApp } from '../src/server/app.ts';
import type { DraftView } from '../src/trials/drafts.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';

const PORT = 4780;
const host = `127.0.0.1:${PORT}`;

describe('the API for drafts and trials', () => {
  let e: TestEngine;
  let app: Hono;

  beforeEach(async () => {
    e = await makeEngine({ steps: [], config: { port: PORT } });
    app = createApp(e);
  });

  afterEach(() => e.cleanup());

  const get = (path: string) => app.request(path, { headers: { host } });
  const post = (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const draftOf = async (res: Response) => (await res.json()) as DraftView;
  const errorOf = async (res: Response) => ({ status: res.status, error: ((await res.json()) as { error: string }).error });
  const fileOf = (draft: DraftView, file: string) => draft.files.find((one) => one.file === file)!;

  describe('a draft', () => {
    it('is none for a role until one is started, and then the role’s open one', async () => {
      expect(await (await get('/api/roles/engineer/draft')).json()).toBeNull();

      const started = await draftOf(await post('/api/roles/engineer/draft', { title: 'Run the checks first' }));

      expect(started).toMatchObject({ role_id: 'engineer', state: 'open', changed: false });
      expect(await draftOf(await get('/api/roles/engineer/draft'))).toMatchObject({ id: started.id });
      expect(await draftOf(await get(`/api/drafts/${started.id}`))).toMatchObject({ title: 'Run the checks first' });
      expect(await errorOf(await post('/api/roles/engineer/draft', { title: 'Another' }))).toMatchObject({ status: 409 });
      expect(await errorOf(await post('/api/roles/nobody/draft', { title: 'x' }))).toMatchObject({ status: 404 });
      expect(await errorOf(await post('/api/roles/pm/draft', {}))).toEqual({ status: 400, error: 'title must be text' });
    });

    it('takes entries and a charter, each answer the draft as it now stands', async () => {
      const { id } = await draftOf(await post('/api/roles/engineer/draft', { title: 'Run the checks first' }));

      const added = await draftOf(await post(`/api/drafts/${id}/entries/playbook`, { text: 'Run every check.', sources: ['DEC-1@1'] }));
      expect(fileOf(added, 'playbook').entries).toMatchObject([{ id: 'PB-1', text: 'Run every check.', sources: ['DEC-1@1'] }]);

      const changed = await draftOf(await post(`/api/drafts/${id}/entries/playbook/PB-1`, { text: 'Run every check before you report.' }));
      expect(fileOf(changed, 'playbook').entries).toMatchObject([{ id: 'PB-1', text: 'Run every check before you report.', sources: ['DEC-1@1'] }]);

      const memory = await draftOf(await post(`/api/drafts/${id}/entries/memory_role`, { text: 'Tests live in test/.', kind: 'structure', project: 'p' }));
      expect(memory).toMatchObject({ project: 'p' });
      expect(fileOf(memory, 'memory_role').entries).toMatchObject([{ id: 'MEM-1', kind: 'structure' }]);

      const chartered = await draftOf(await post(`/api/drafts/${id}/charter`, { text: '# Engineer\n\nA new charter.' }));
      expect(fileOf(chartered, 'charter')).toMatchObject({ changed: true, text: '# Engineer\n\nA new charter.\n' });

      const removed = await draftOf(await post(`/api/drafts/${id}/entries/playbook/PB-1/remove`));
      expect(fileOf(removed, 'playbook')).toMatchObject({ changed: false, entries: [] });
    });

    it('says what is wrong with a request, in the status and in words', async () => {
      const { id } = await draftOf(await post('/api/roles/engineer/draft', { title: 'Run the checks first' }));

      expect(await errorOf(await post(`/api/drafts/${id}/entries/playbook`, { text: '' }))).toEqual({ status: 400, error: 'An entry needs text' });
      expect(await errorOf(await post(`/api/drafts/${id}/entries/playbook`, { text: 'x', sources: 'DEC-1' }))).toEqual({ status: 400, error: 'sources must be a list of texts' });
      expect(await errorOf(await post(`/api/drafts/${id}/entries/playbook`, { text: 'x', kind: 'gossip' }))).toMatchObject({ status: 400 });
      expect(await errorOf(await post(`/api/drafts/${id}/entries/charter`, { text: 'x' }))).toMatchObject({ status: 404 });
      expect(await errorOf(await post(`/api/drafts/${id}/entries/playbook/PB-9`, { text: 'x' }))).toMatchObject({ status: 404 });
      expect(await errorOf(await get('/api/drafts/999'))).toEqual({ status: 404, error: 'There is no draft 999' });
      expect(await errorOf(await get('/api/drafts/abc'))).toMatchObject({ status: 404 });
    });

    it('is discarded for good, and the role can start another', async () => {
      const { id } = await draftOf(await post('/api/roles/engineer/draft', { title: 'Run the checks first' }));

      expect(await draftOf(await post(`/api/drafts/${id}/discard`))).toMatchObject({ state: 'discarded' });

      expect(await (await get('/api/roles/engineer/draft')).json()).toBeNull();
      expect(await errorOf(await post(`/api/drafts/${id}/charter`, { text: 'x' }))).toMatchObject({ status: 409 });
      expect((await post('/api/roles/engineer/draft', { title: 'Another' })).status).toBe(200);
    });
  });
});
