import type { Hono } from 'hono';
import { createApp } from '../src/server/app.ts';
import type { DraftView } from '../src/trials/drafts.ts';
import type { PastAttempt } from '../src/trials/source.ts';
import { TrialStore } from '../src/trials/store.ts';
import { startTrial, TrialRunner, type TrialDeps } from '../src/trials/trial.ts';
import type { TrialSummary, TrialView } from '../src/trials/view.ts';
import { makeEngine, okStep, resultStep, runOnce, ticket, type TestEngine } from './helpers/engine.ts';

const PORT = 4780;
const host = `127.0.0.1:${PORT}`;

// Every judge finds that result A does not meet the expectation and result B does.
const B_IS_BETTER = resultStep({ answers: ['A', 'B', 'C'].map((letter) => ({ question: `${letter}-1`, yes: letter === 'B', passage: `What ${letter} says` })) });

describe('the API for drafts and trials', () => {
  let e: TestEngine;
  let app: Hono;
  let deps: TrialDeps;
  let runner: TrialRunner;

  async function boot(byTask: Record<string, unknown> = {}): Promise<void> {
    e = await makeEngine({ steps: { byTask: { '*': okStep({ 'src/a.mjs': 'export {}' }), 'model-*': B_IS_BETTER, 'evaluator-*': B_IS_BETTER, ...byTask } }, config: { port: PORT } });
    // Results are lettered in a fixed order here, the stored one first and the draft's last.
    deps = { ...e, trials: new TrialStore(e.db), shuffle: (items) => items };
    runner = new TrialRunner(deps);
    app = createApp({ ...e, trialRunner: runner });
  }

  afterEach(async () => {
    await runner.shutdown();
    await e.cleanup();
  });

  const get = (path: string) => app.request(path, { headers: { host } });
  const post = (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const draftOf = async (res: Response) => (await res.json()) as DraftView;
  const trialOf = async (res: Response) => (await res.json()) as TrialView;
  const errorOf = async (res: Response) => ({ status: res.status, error: ((await res.json()) as { error: string }).error });
  const fileOf = (draft: DraftView, file: string) => draft.files.find((one) => one.file === file)!;

  describe('a draft', () => {
    beforeEach(() => boot());

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

  describe('a trial', () => {
    let attempts: number[];
    let draftId: number;

    // Six past tickets of the engineer, and a draft that adds a rule to its playbook.
    beforeEach(async () => {
      await boot({ 'draft-1': okStep({ 'src/a.mjs': 'export const checked = true;' }, { summary: 'Ran the checks, as PB-1 says' }) });
      attempts = [];
      for (let i = 1; i <= 6; i += 1) {
        const task = await e.addTicket(ticket({ id: `T-${i}`, title: `Ticket ${i}` }));
        await runOnce(e, task.id);
        attempts.push((await e.store.listAttempts(task.id))[0]!.id);
      }
      draftId = (await draftOf(await post('/api/roles/engineer/draft', { title: 'Run the checks first' }))).id;
      await post(`/api/drafts/${draftId}/entries/playbook`, { text: 'Run every check before you report.', sources: ['T-2 attempt 1'] });
    });

    const body = () => ({ expectations: ['Does the report list every command it ran?'], problem: attempts.slice(0, 3), fine: attempts.slice(3) });
    const begin = () => startTrial(deps, draftId, body());

    async function work(): Promise<void> {
      for (let i = 0; i < 20; i += 1) {
        await runner.tick(3);
        if (runner.liveCount() === 0) return;
        await runner.idle();
      }
    }

    it('is made of the role’s past attempts, of which the newest that went well are offered as the tasks that went fine', async () => {
      const { attempts: past, fine } = (await (await get('/api/roles/engineer/attempts')).json()) as { attempts: PastAttempt[]; fine: number[] };

      expect(past.map(({ ticketId }) => ticketId)).toEqual(['T-6', 'T-5', 'T-4', 'T-3', 'T-2', 'T-1']);
      expect(past[0]).toMatchObject({ project: 'p', title: 'Ticket 6', purpose: 'ticket', state: 'succeeded', firstPass: true, replayable: true, usd: 0.01 });
      expect(fine).toEqual([attempts[5], attempts[4], attempts[3]]);
      expect((await (await get('/api/roles/engineer/attempts?project=nowhere')).json()) as unknown).toEqual({ attempts: [], fine: [] });
    });

    it('starts with every run to make, and shows neither which result is the draft’s nor any judgment', async () => {
      const trial = await trialOf(await post(`/api/drafts/${draftId}/trials`, { ...body(), capUsd: 4 }));

      expect(trial).toMatchObject({ draftId, roleId: 'engineer', state: 'running', capUsd: 4, spentUsd: 0, revealed: false, verdict: null, commits: null, draftMoved: false, expectations: body().expectations });
      expect(trial.progress).toEqual({ runs: { done: 6, total: 12 }, judgments: { done: 0, total: 12 } });
      expect(trial.tasks.map(({ ticketId, group, project }) => [ticketId, group, project])).toEqual([...[1, 2, 3].map((n) => [`T-${n}`, 'problem', 'p']), ...[4, 5, 6].map((n) => [`T-${n}`, 'fine', 'p'])]);
      for (const task of trial.tasks) {
        expect(task).toMatchObject({ compare: ['A', 'B'], answer: null, judgments: null, purpose: 'ticket' });
        expect(task.results.map(({ letter, arm }) => [letter, arm])).toEqual([['A', null], ['B', null]]);
        expect(task.results.map(({ state }) => state).sort()).toEqual(['done', 'pending']);
      }
      expect(((await (await get(`/api/drafts/${draftId}/trials`)).json()) as TrialSummary[])).toMatchObject([{ id: trial.id, state: 'running', agreed: null, committed: false }]);
    });

    it('refuses a trial that could mean nothing, before anything is spent', async () => {
      expect(await errorOf(await post(`/api/drafts/${draftId}/trials`, { ...body(), expectations: [] }))).toEqual({ status: 400, error: 'Say what you expected as one to 3 questions' });
      expect(await errorOf(await post(`/api/drafts/${draftId}/trials`, { ...body(), problem: ['1'] }))).toEqual({ status: 400, error: 'problem must be a list of attempt ids' });
      expect(await errorOf(await post(`/api/drafts/${draftId}/trials`, { ...body(), capUsd: 'lots' }))).toEqual({ status: 400, error: 'capUsd must be a number' });
      expect(await errorOf(await post('/api/drafts/999/trials', body()))).toMatchObject({ status: 404 });
      expect(await errorOf(await get('/api/trials/999'))).toEqual({ status: 404, error: 'There is no trial 999' });
      expect(e.spawnCount()).toBe(6);
    });

    it('is judged blind by the stakeholder, and then shows who said what', async () => {
      const { id } = await begin();
      await work();

      const blind = await trialOf(await get(`/api/trials/${id}`));
      expect(blind).toMatchObject({ state: 'awaiting_answer', revealed: false, verdict: null, progress: { runs: { done: 12, total: 12 }, judgments: { done: 12, total: 12 } } });
      const first = blind.tasks[0]!;
      expect(first.results).toMatchObject([
        { letter: 'A', arm: null, state: 'done', output: { summary: 'Did the work' }, measured: { parses: true, checks: true } },
        { letter: 'B', arm: null, state: 'done', output: { summary: 'Ran the checks, as an entry says' }, measured: { parses: true, checks: true } },
      ]);
      expect(first.results[1]!.diff).toContain('+export const checked = true;');
      expect(first.judgments).toBeNull();
      expect(blind.tasks[1]!.notes).toEqual(['One of the draft’s entries names this task as where it came from. A better result here shows the lesson works where it was learnt, and says nothing of anywhere else.']);
      expect(first.notes).toEqual([]);

      const choices = { [attempts[0]!]: 'B', [attempts[1]!]: 'B', [attempts[2]!]: 'same', [attempts[3]!]: 'same', [attempts[4]!]: 'same' };
      expect(await errorOf(await post(`/api/trials/${id}/answer`, { choices }))).toEqual({ status: 400, error: `Say for attempt ${attempts[5]} which of A and B is better, or that there is no difference` });
      expect(await errorOf(await post(`/api/trials/${id}/answer`, { choices: { ...choices, [attempts[5]!]: 'C' } }))).toMatchObject({ status: 400 });
      expect(await errorOf(await post(`/api/trials/${id}/answer`, {}))).toMatchObject({ status: 400 });

      const answered = await trialOf(await post(`/api/trials/${id}/answer`, { choices: { ...choices, [attempts[5]!]: 'same' } }));

      expect(answered).toMatchObject({ state: 'agreed', revealed: true, verdict: { agreed: true, worse: [], judges: { model: { improvement: true }, evaluator: { improvement: true }, stakeholder: { improvement: true } } } });
      expect(answered.endedAt).not.toBeNull();
      const shown = answered.tasks[0]!;
      expect(shown.answer).toBe('B');
      expect(shown.results.map(({ letter, arm }) => [letter, arm])).toEqual([['A', 'stored'], ['B', 'draft']]);
      expect(shown.results[1]!.output).toMatchObject({ summary: 'Ran the checks, as PB-1 says' });
      expect(shown.judgments).toMatchObject([
        { judge: 'model', state: 'done', answers: [{ letter: 'A', expectation: 0, p: 0, passage: 'What A says' }, { letter: 'B', expectation: 0, p: 1, passage: 'What B says' }] },
        { judge: 'evaluator', state: 'done', answers: [{ letter: 'A', p: 0 }, { letter: 'B', p: 1 }] },
      ]);
      expect(answered.tasks[5]!.answer).toBe('same');
      expect(await errorOf(await post(`/api/trials/${id}/answer`, { choices }))).toEqual({ status: 409, error: `Trial ${id} has been answered` });
    });

    it('ends not agreed when the stakeholder sees no improvement, whatever the judges found', async () => {
      const { id } = await begin();
      await work();

      const answered = await trialOf(await post(`/api/trials/${id}/answer`, { choices: Object.fromEntries(attempts.map((attempt) => [attempt, 'same'])) }));

      expect(answered).toMatchObject({ state: 'not_agreed', verdict: { agreed: false, judges: { model: { improvement: true }, stakeholder: { improvement: false, why: 'On the tasks that showed the problem, you found the draft’s result better on 0 and worse on 0 of 3.' } } } });
    });

    it('can’t be answered before its runs and judges have finished', async () => {
      const { id } = await begin();

      expect(await errorOf(await post(`/api/trials/${id}/answer`, { choices: {} }))).toEqual({ status: 409, error: `Trial ${id} is not ready to be answered: its runs and judges have not finished` });
    });

    it('is stopped and goes on again when the stakeholder says', async () => {
      const { id } = await begin();

      expect(await trialOf(await post(`/api/trials/${id}/stop`))).toMatchObject({ state: 'stopped', stopReason: 'the stakeholder stopped it' });
      expect(await errorOf(await post(`/api/trials/${id}/resume`, { capUsd: 'more' }))).toMatchObject({ status: 400 });
      expect(await trialOf(await post(`/api/trials/${id}/resume`, { capUsd: 20 }))).toMatchObject({ state: 'running', stopReason: null, capUsd: 20 });
      expect(await errorOf(await post(`/api/trials/${id}/resume`))).toMatchObject({ status: 409 });
    });

    it('is stopped with its draft when the draft is discarded, and says the draft is no longer what it tried', async () => {
      const { id } = await begin();

      await post(`/api/drafts/${draftId}/discard`);

      expect(await trialOf(await get(`/api/trials/${id}`))).toMatchObject({ state: 'stopped', stopReason: 'its draft was discarded', draftMoved: true });
    });

    it('says when the draft has changed since it was tried', async () => {
      const { id } = await begin();
      expect((await trialOf(await get(`/api/trials/${id}`))).draftMoved).toBe(false);

      await post(`/api/drafts/${draftId}/entries/playbook`, { text: 'One more rule.' });

      expect((await trialOf(await get(`/api/trials/${id}`))).draftMoved).toBe(true);
    });
  });
});
