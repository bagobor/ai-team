import { TrialStore } from '../src/trials/store.ts';
import type { Knowledge } from '../src/trials/types.ts';
import { ticketTask } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';

const NONE: Knowledge = { charter: '', playbook: '', memory_project: '', memory_role: '' };

describe('the trial store', () => {
  let e: TestEngine;
  let trials: TrialStore;
  let attemptId: number;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    trials = new TrialStore(e.db, () => new Date('2026-11-22T10:00:00Z'));
    const task = await ticketTask(e, 'M1-T-1');
    attemptId = (await e.store.createAttempt({ task_id: task.id, adapter: 'claude-code', model: 'm', worktree_path: e.repoPath, branch: 'b' })).id;
  });

  afterEach(() => e.cleanup());

  const begin = async () => {
    const draft = await trials.createDraft({ role_id: 'engineer', title: 'Run the checks first' });
    const trial = await trials.createTrial({
      draft_id: draft.id,
      role_id: 'engineer',
      expectations: ['Does the report list every command?'],
      tasks: [{ attemptId, group: 'problem', letters: { A: 'draft', B: 'stored' } }],
      knowledge: { current: NONE, draft: { ...NONE, playbook: '## PB-1\n' } },
      cap_usd: 10,
      results: [
        { attempt_id: attemptId, arm: 'stored', state: 'done', output: { summary: 'Did it' }, measured: { parses: true, checks: true, changed: true, tests: true, usd: 0.2, note: null }, fingerprint: 'abc' },
        { attempt_id: attemptId, arm: 'draft', state: 'pending', output: null, measured: null, fingerprint: null },
      ],
      judgments: [{ attempt_id: attemptId, judge: 'model' }],
    });
    return { draft, trial };
  };

  it('keeps one open draft to find for a role, until it is committed or discarded', async () => {
    const draft = await trials.createDraft({ role_id: 'engineer', title: 'Run the checks first' });

    expect(draft).toMatchObject({ state: 'open', project_id: null, base: {}, created_at: '2026-11-22T10:00:00.000Z' });
    expect(await trials.openDraft('engineer')).toEqual(draft);
    expect(await trials.openDraft('pm')).toBeUndefined();

    const changed = await trials.patchDraft(draft.id, { base: { playbook: 'h1' }, state: 'discarded' });

    expect(changed).toMatchObject({ base: { playbook: 'h1' }, state: 'discarded' });
    expect(await trials.openDraft('engineer')).toBeUndefined();
    expect(await trials.getDraft(draft.id)).toEqual(changed);
  });

  it('begins a trial with every result and judgment it will need', async () => {
    const { draft, trial } = await begin();

    expect(trial).toMatchObject({ state: 'running', spent_usd: 0, human: null, verdict: null, expectations: ['Does the report list every command?'], tasks: [{ attemptId, group: 'problem', letters: { A: 'draft', B: 'stored' } }] });
    expect(trial.knowledge.draft.playbook).toBe('## PB-1\n');
    expect(await trials.listResults(trial.id)).toMatchObject([
      { arm: 'stored', state: 'done', output: { summary: 'Did it' }, measured: { checks: true, usd: 0.2 }, fingerprint: 'abc' },
      { arm: 'draft', state: 'pending', output: null, measured: null },
    ]);
    expect(await trials.listJudgments(trial.id)).toMatchObject([{ judge: 'model', state: 'pending', answers: null }]);
    expect(await trials.listTrials({ draftId: draft.id })).toEqual([trial]);
    expect(await trials.listTrials({ states: ['agreed'] })).toEqual([]);
  });

  it('records what a run and a judge came back with, and what it cost', async () => {
    const { trial } = await begin();
    const [, pending] = await trials.listResults(trial.id);
    const [judgment] = await trials.listJudgments(trial.id);

    await trials.patchResult(pending!.id, { state: 'done', output: { summary: 'Better' }, measured: { parses: true, checks: false, changed: true, tests: null, usd: 0.3, note: 'node --test failed' } });
    await trials.patchJudgment(judgment!.id, { state: 'done', answers: [{ arm: 'draft', expectation: 0, p: 1, passage: 'Ran node --test' }] });
    await trials.addSpend(trial.id, 0.3);
    const after = await trials.addSpend(trial.id, 0.25);
    const ended = await trials.patchTrial(trial.id, { state: 'not_agreed', human: { [attemptId]: 'same' }, verdict: { worse: ['M1-T-1: its checks no longer pass'], judges: {}, agreed: false }, ended_at: '2026-11-22T11:00:00.000Z' });

    expect(after.spent_usd).toBeCloseTo(0.55);
    expect((await trials.listResults(trial.id))[1]).toMatchObject({ state: 'done', measured: { checks: false, note: 'node --test failed' } });
    expect((await trials.listJudgments(trial.id))[0]).toMatchObject({ state: 'done', answers: [{ arm: 'draft', p: 1 }] });
    expect(ended).toMatchObject({ state: 'not_agreed', human: { [attemptId]: 'same' }, verdict: { agreed: false } });
  });

  it('puts back in the queue what a daemon that died had begun', async () => {
    const { trial } = await begin();
    const [, result] = await trials.listResults(trial.id);
    const [judgment] = await trials.listJudgments(trial.id);
    await trials.patchResult(result!.id, { state: 'running' });
    await trials.patchJudgment(judgment!.id, { state: 'running' });

    await trials.requeueRunning();

    expect((await trials.listResults(trial.id)).map(({ state }) => state)).toEqual(['done', 'pending']);
    expect((await trials.listJudgments(trial.id)).map(({ state }) => state)).toEqual(['pending']);
  });
});
