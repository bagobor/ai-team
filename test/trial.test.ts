import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { addProject, addTicket } from '../src/engine/intake.ts';
import { Scheduler, type Background } from '../src/engine/scheduler.ts';
import { addEntry, startDraft } from '../src/trials/drafts.ts';
import { TrialStore } from '../src/trials/store.ts';
import { startTrial, TrialRunner, type NewTrialInput, type TrialDeps } from '../src/trials/trial.ts';
import type { TrialRow } from '../src/trials/types.ts';
import { baselineOf } from '../src/trials/verdict.ts';
import { makeEngine, okStep, resultStep, runOnce, ticket, until, type TestEngine } from './helpers/engine.ts';
import { makeRepo, run, tempDir } from './helpers/repo.ts';
import { projectState, read } from './helpers/trials.ts';

const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' });
const SLOW = { lines: [INIT], delayMs: 120_000 };

// A judge's run that says yes or no to the one expectation about each result. Results are lettered in a fixed order
// here: A is the stored one, the last letter the draft's, and B the committed knowledge's where that was run too.
const judged = (byLetter: Record<string, boolean>, passage = 'It lists `node --test`.') => resultStep({ answers: ['A', 'B', 'C'].map((letter) => ({ question: `${letter}-1`, yes: byLetter[letter] ?? false, passage })) });
const ALL_YES = judged({ A: true, B: true, C: true });

describe('a trial of a draft', () => {
  let e: TestEngine;
  let deps: TrialDeps;
  let runner: TrialRunner;
  let attempts: number[];
  let draftId: number;

  afterEach(async () => {
    await runner.shutdown();
    await e.cleanup();
  });

  // Six past tickets of the engineer, each run once, then a draft that adds one rule to its playbook. Every run of the
  // trial plays the step "*" unless the script names its folder, which is <arm>-<attempt id>, and every judge says yes
  // to everything unless the script names its run, <judge>-<attempt id>-<run>.
  async function setUp(byTask: Record<string, unknown> = {}, env: Record<string, string> = {}, localJudge: { url: string; model: string } | null = null): Promise<void> {
    e = await makeEngine({ steps: { byTask: { '*': okStep({ 'src/a.mjs': 'export {}' }), 'model-*': ALL_YES, 'evaluator-*': ALL_YES, ...byTask } }, env });
    deps = { ...e, config: { ...e.config, trials: { ...e.config.trials, localJudge } }, trials: new TrialStore(e.db), shuffle: (items) => items };
    runner = new TrialRunner(deps);
    attempts = [];
    for (let i = 1; i <= 6; i += 1) {
      const task = await e.addTicket(ticket({ id: `T-${i}` }));
      await runOnce(e, task.id);
      attempts.push((await e.store.listAttempts(task.id))[0]!.id);
    }
    draftId = (await startDraft(deps, 'engineer', 'Run the checks first')).id;
    await addEntry(deps, draftId, 'playbook', { text: 'Run every check before you report.' });
  }

  const input = (over: Partial<NewTrialInput> = {}): NewTrialInput => ({ expectations: ['Does the report list every command it ran?'], problem: attempts.slice(0, 3), fine: attempts.slice(3, 6), ...over });
  const begin = (over: Partial<NewTrialInput> = {}): Promise<TrialRow> => startTrial(deps, draftId, input(over));
  const charter = () => join(e.paths.knowledge, 'roles', 'engineer', 'charter.md');

  // What the scheduler does with spare workers, until nothing is left that a tick would start.
  async function work(free = 3): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await runner.tick(free);
      if (runner.liveCount() === 0) return;
      await runner.idle();
    }
    throw new Error('The trial never ran out of work');
  }

  describe('laid out', () => {
    it('compares the draft with the stored result where the attempt was given what is committed today', async () => {
      await setUp();

      const trial = await begin();

      expect(trial).toMatchObject({ state: 'running', role_id: 'engineer', cap_usd: 10, spent_usd: 0, expectations: ['Does the report list every command it ran?'] });
      expect(trial.tasks.map(({ attemptId, group }) => [attemptId, group])).toEqual([...attempts.slice(0, 3).map((id) => [id, 'problem']), ...attempts.slice(3).map((id) => [id, 'fine'])]);
      for (const task of trial.tasks) {
        expect(Object.keys(task.letters).sort()).toEqual(['A', 'B']);
        expect(Object.values(task.letters).sort()).toEqual(['draft', 'stored']);
        expect(baselineOf(task)).toBe('stored');
      }
      const results = await deps.trials.listResults(trial.id);
      expect(results.filter(({ arm }) => arm === 'stored')).toHaveLength(6);
      expect(results.find(({ arm }) => arm === 'stored')).toMatchObject({ state: 'done', output: { summary: 'Did the work' }, measured: { parses: true, checks: true, usd: 0.01 }, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(results.filter(({ arm }) => arm === 'draft').map(({ state }) => state)).toEqual(Array(6).fill('pending'));
      expect(results.some(({ arm }) => arm === 'current')).toBe(false);
      expect(trial.knowledge.draft.playbook).toContain('Run every check before you report.');
      expect(trial.knowledge.current.playbook).toBe('');
    });

    it('runs the committed knowledge too where it is no longer what the attempt was given', async () => {
      await setUp();
      appendFileSync(charter(), '- A rule added by hand since those attempts ran.\n');

      const trial = await begin();

      for (const task of trial.tasks) {
        expect(Object.values(task.letters).sort()).toEqual(['current', 'draft', 'stored']);
        expect(baselineOf(task)).toBe('current');
      }
      expect((await deps.trials.listResults(trial.id)).filter(({ arm }) => arm === 'current').map(({ state }) => state)).toEqual(Array(6).fill('pending'));
    });

    it('has a judgment to make for each task by the model and by the role’s evaluator, and by a local model when one is set', async () => {
      await setUp();

      const judges = async (trial: TrialRow) => [...new Set((await deps.trials.listJudgments(trial.id)).map(({ judge }) => judge))];
      const trial = await begin();
      expect(await judges(trial)).toEqual(['model', 'evaluator']);
      expect(await deps.trials.listJudgments(trial.id)).toHaveLength(12);

      await runner.stop(trial.id);
      await deps.trials.patchTrial(trial.id, { state: 'not_agreed' });
      deps = { ...deps, config: { ...e.config, trials: { ...e.config.trials, localJudge: { url: 'http://127.0.0.1:1/v1', model: 'm' } } } };
      expect(await judges(await begin())).toEqual(['model', 'evaluator', 'local']);
    });

    it.each([
      ['no expectation', () => ({ expectations: [' '] }), 'Say what you expected as one to 3 questions'],
      ['four expectations', () => ({ expectations: ['a?', 'b?', 'c?', 'd?'] }), 'Say what you expected as one to 3 questions'],
      ['four tasks', () => ({ problem: attempts.slice(0, 2), fine: attempts.slice(2, 4) }), 'A trial takes 5 to 7 tasks: at least 2 that showed the problem and at least 2 that went fine'],
      ['one task that went fine', () => ({ problem: attempts.slice(0, 5), fine: attempts.slice(5) }), 'A trial takes 5 to 7 tasks'],
      ['a task twice', () => ({ fine: [attempts[0]!, attempts[4]!, attempts[5]!] }), 'A task can be in a trial once'],
      ['an attempt that isn’t there', () => ({ fine: [attempts[3]!, attempts[4]!, 999] }), 'Attempt 999 can’t be run again: there is no attempt 999'],
      ['no cap', () => ({ capUsd: 0 }), 'The spending cap must be more than nothing'],
    ])('refuses %s', async (_what, over, message) => {
      await setUp();

      await expect(begin(over())).rejects.toThrow(message);
      expect(await deps.trials.listTrials()).toEqual([]);
    });

    it('refuses a draft that changes nothing, one a live file changed under, and a second trial while one is under way', async () => {
      await setUp();
      const empty = (await startDraft(deps, 'pm', 'Nothing yet')).id;
      await expect(startTrial(deps, empty, input())).rejects.toThrow('This draft changes nothing yet, so there is nothing to try');

      const first = await begin();
      await expect(begin()).rejects.toMatchObject({ status: 409, message: `Trial ${first.id} of this draft has not ended. Answer it, or stop and discard it, first.` });

      await deps.trials.patchTrial(first.id, { state: 'not_agreed' });
      writeFileSync(join(e.paths.knowledge, 'roles', 'engineer', 'playbook.md'), '## PB-9\nAdded by: someone\nAdded: 2026-11-21\n\nA hand edit.\n');
      await expect(begin()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('A live file changed after this draft first changed it') });
    });

    it('refuses another role’s attempt, and a task of another project when the draft changes one project’s memory', async () => {
      await setUp();
      const pm = (await startDraft(deps, 'pm', 'For the PM')).id;
      await addEntry(deps, pm, 'playbook', { text: 'Ask for a check.' });
      await expect(startTrial(deps, pm, input())).rejects.toThrow(`Attempt ${attempts[0]} is engineer’s work, and this draft is for pm`);

      await addProject(e, { name: 'q', repoPath: (await makeRepo()).path, create: false });
      const elsewhere = await addTicket(e, 'q', ticket({ id: 'T-9' }));
      await runOnce(e, elsewhere.id);
      const other = (await e.store.listAttempts(elsewhere.id))[0]!.id;
      // The draft changes no memory, so each task reads its own project's, as it stood when the trial began.
      const empty = { memory_project: '', memory_role: '' };
      expect((await begin({ fine: [attempts[3]!, attempts[4]!, other] })).knowledge.elsewhere).toEqual({ p: empty, q: empty });

      await deps.trials.patchTrial((await deps.trials.listTrials())[0]!.id, { state: 'not_agreed' });
      await addEntry(deps, draftId, 'memory_role', { text: 'Tests live in test/.', kind: 'structure', project: 'p' });
      await expect(begin({ fine: [attempts[3]!, attempts[4]!, other] })).rejects.toThrow(`This draft changes the memory of p, so it can only be tried on tasks of p. Attempt ${other} is of q.`);
    });
  });

  describe('run', () => {
    it('makes every run, a few at a time, then has it judged, and then waits for the stakeholder', async () => {
      await setUp();
      const trial = await begin();
      const before = await projectState(e);

      await runner.tick(2);
      expect(runner.liveCount()).toBe(2);
      expect((await deps.trials.listResults(trial.id)).filter(({ state }) => state === 'running')).toHaveLength(2);
      await runner.idle();
      while ((await deps.trials.listResults(trial.id)).some(({ state }) => state !== 'done')) {
        await runner.tick(2);
        await runner.idle();
      }

      const results = await deps.trials.listResults(trial.id);
      expect(results.map(({ state }) => state)).toEqual(Array(12).fill('done'));
      expect(results.find(({ arm }) => arm === 'draft')).toMatchObject({ output: { summary: 'Did the work' }, measured: { parses: true, checks: true, changed: true, usd: 0.01 }, error: null });
      expect(results.find(({ arm }) => arm === 'draft')!.fingerprint).not.toBe(results.find(({ arm }) => arm === 'stored')!.fingerprint);
      expect(await deps.trials.getTrial(trial.id)).toMatchObject({ state: 'judging', spent_usd: expect.closeTo(0.06) });

      await work();

      // Six runs, then the model judge three times and the evaluator once for each of six tasks.
      expect(await deps.trials.getTrial(trial.id)).toMatchObject({ state: 'awaiting_answer', spent_usd: expect.closeTo(0.06 + 0.18 + 0.06) });
      expect((await deps.trials.listJudgments(trial.id)).map(({ state }) => state)).toEqual(Array(12).fill('done'));
      expect(await projectState(e)).toEqual(before);
    });


    it('gives each task of another project that project’s memory, in every run of it', async () => {
      await setUp();
      await addProject(e, { name: 'q', repoPath: (await makeRepo()).path, create: false });
      const elsewhere = await addTicket(e, 'q', ticket({ id: 'T-9' }));
      await runOnce(e, elsewhere.id);
      const other = (await e.store.listAttempts(elsewhere.id))[0]!.id;
      const memory = join(e.paths.projects, 'q', 'state', 'memory');
      mkdirSync(memory, { recursive: true });
      writeFileSync(join(memory, 'project.md'), '## MEM-1\nKind: feedback\nAdded by: the engine\nAdded: 2026-11-15\n\nOnly project q knows this.\n');

      const trial = await begin({ fine: [attempts[3]!, attempts[4]!, other] });
      await work();

      // The attempt was given no memory, and a task of q would be given some today: so the committed knowledge is run too.
      const system = (name: string) => read(e.paths.trials, String(trial.id), name, 'system.md');
      expect(system(`draft-${other}`)).toContain('Only project q knows this.');
      expect(system(`current-${other}`)).toContain('Only project q knows this.');
      expect(system(`draft-${attempts[0]}`)).not.toContain('Only project q knows this.');
    });

    it('stops at its spending cap, and goes on once the cap is raised', async () => {
      await setUp();
      const trial = await begin({ capUsd: 0.025 });

      await work(1);

      expect(await deps.trials.getTrial(trial.id)).toMatchObject({ state: 'stopped', stop_reason: 'it reached its spending cap of $0.03' });
      expect((await deps.trials.listResults(trial.id)).filter(({ state }) => state === 'done')).toHaveLength(9);
      await expect(runner.resume(trial.id)).rejects.toMatchObject({ status: 409, message: 'This trial has spent $0.03 of its cap of $0.03. Raise the cap to go on.' });

      expect(await runner.resume(trial.id, 1)).toMatchObject({ state: 'running', stop_reason: null, cap_usd: 1 });
      await work();
      expect((await deps.trials.getTrial(trial.id))!.state).toBe('awaiting_answer');
    });

    it('is stopped by the stakeholder with a run in flight, which is made again when the trial goes on', async () => {
      await setUp({ 'draft-1': SLOW });
      const trial = await begin();
      await runner.tick(1);
      await until(async () => e.spawns().some(({ cwd }) => cwd.endsWith('draft-1')));

      expect(await runner.stop(trial.id)).toMatchObject({ state: 'stopped', stop_reason: 'the stakeholder stopped it' });
      await runner.idle();

      expect((await deps.trials.listResults(trial.id)).find(({ arm, attempt_id }) => arm === 'draft' && attempt_id === 1)).toMatchObject({ state: 'pending', error: 'it was cancelled' });
      expect((await deps.trials.getTrial(trial.id))!.stop_reason).toBe('the stakeholder stopped it');
      await runner.tick(3);
      expect(runner.liveCount()).toBe(0);
      expect(run(e.repoPath, 'branch', '--list', 'aiteam/trial/*')).toBe('');

      expect((await runner.resume(trial.id)).state).toBe('running');
      await expect(runner.stop(999)).rejects.toMatchObject({ status: 404 });
    });

    it('stops with what to fix when the agent home is no longer logged in', async () => {
      const auth = join(tempDir(), 'auth.json');
      writeFileSync(auth, '{"loggedIn":true}');
      await setUp({}, { FAKE_AUTH_FILE: auth });
      const trial = await begin();
      writeFileSync(auth, '{"loggedIn":false}');

      await work();

      expect(await deps.trials.getTrial(trial.id)).toMatchObject({ state: 'stopped', stop_reason: expect.stringContaining('claude auth login'), spent_usd: 0 });
      expect((await deps.trials.listResults(trial.id)).filter(({ arm }) => arm === 'draft').map(({ state }) => state)).toEqual(Array(6).fill('pending'));
    });

    it('leaves a trial to go on with the next daemon when this one goes down under it', async () => {
      await setUp({ 'draft-1': SLOW });
      const trial = await begin();
      await runner.tick(1);
      await until(async () => e.spawns().some(({ cwd }) => cwd.endsWith('draft-1')));

      await runner.shutdown();

      expect(await deps.trials.getTrial(trial.id)).toMatchObject({ state: 'running', stop_reason: null });
      expect((await deps.trials.listResults(trial.id)).some(({ state }) => state === 'running')).toBe(false);
      await runner.tick(3);
      expect(runner.liveCount()).toBe(0);
    });
  });

  describe('judged', () => {
    const judgmentOf = async (trial: TrialRow, judge: string, attemptId: number) => (await deps.trials.listJudgments(trial.id)).find((one) => one.judge === judge && one.attempt_id === attemptId)!;

    it('keeps for each result how likely each judge found it to meet each expectation', async () => {
      await setUp({ 'model-1-1': judged({ A: false, B: true }), 'model-1-2': judged({ A: false, B: true }), 'model-1-3': judged({ A: true, B: true }, 'It names no command.'), 'evaluator-1-1': judged({ A: false, B: true }) });
      const trial = await begin();

      await work();

      expect((await judgmentOf(trial, 'model', 1)).answers).toEqual([
        { arm: 'stored', expectation: 0, p: expect.closeTo(1 / 3), passage: 'It lists `node --test`.' },
        { arm: 'draft', expectation: 0, p: 1, passage: 'It lists `node --test`.' },
      ]);
      expect((await judgmentOf(trial, 'evaluator', 1)).answers).toMatchObject([{ arm: 'stored', p: 0 }, { arm: 'draft', p: 1 }]);
      expect((await judgmentOf(trial, 'model', 2)).answers).toMatchObject([{ arm: 'stored', p: 1 }, { arm: 'draft', p: 1 }]);
    });

    it('shows a judge the task and its results under letters, with no entry’s id to tell them apart', async () => {
      await setUp({ 'draft-1': okStep({ 'src/a.mjs': 'export const checked = true;' }, { summary: 'Ran the checks, as PB-1 and MEM-12 say' }) });
      const trial = await begin();

      await work();

      const task = read(e.paths.trials, String(trial.id), 'model-1-1', 'task.md');
      expect(task).toMatch(/^## The task\n\n<task>\n---\nid: T-1\n/);
      expect(task).toContain('### Result A\n\n<result letter="A">\n{\n  "summary": "Did the work"');
      expect(task).toContain('### Result B\n\n<result letter="B">\n{\n  "summary": "Ran the checks, as an entry and an entry say"');
      expect(task).not.toMatch(/PB-1|MEM-12|draft|stored/);
      expect(task).toContain('What it changed:\n\ndiff --git a/src/a.mjs b/src/a.mjs');
      expect(task).toContain('+export const checked = true;');
      expect(task).toMatch(/## Questions\n\n- `A-1`: About result A: Does the report list every command it ran\?\n- `B-1`: About result B: Does the report list every command it ran\?\n$/);
      expect(read(e.paths.trials, String(trial.id), 'model-1-1', 'system.md')).toMatch(/^# Judge\n/);
      expect(read(e.paths.trials, String(trial.id), 'evaluator-1-1', 'system.md')).toMatch(/^# Code Reviewer\n[\s\S]*\n# Judge\n/);
    });

    it('stops when a judge that counts can’t judge, and keeps what the others said', async () => {
      await setUp({ 'model-1-*': resultStep({ answers: [] }) });
      const trial = await begin();

      await work(1);

      expect(await deps.trials.getTrial(trial.id)).toMatchObject({ state: 'stopped', stop_reason: 'the model judge could not judge attempt 1: the judge twice gave an answer that left a question out or did not fit' });
      expect(await judgmentOf(trial, 'model', 1)).toMatchObject({ state: 'pending', answers: null });
      expect((await deps.trials.getTrial(trial.id))!.spent_usd).toBeCloseTo(0.06 + 0.02);
    });

    describe('by a local model too', () => {
      let server: Server;

      afterEach(() => new Promise((resolve) => server.close(resolve)));

      async function localModel(status: number): Promise<{ url: string; model: string }> {
        server = createServer((req, res) => {
          req.resume().on('end', () => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'yes' }, logprobs: { content: [{ top_logprobs: [{ token: 'yes', logprob: Math.log(0.9) }, { token: 'no', logprob: Math.log(0.1) }] }] } }] })));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'a-local-model' };
      }

      it('keeps its answers beside the others’', async () => {
        await setUp({}, {}, await localModel(200));
        const trial = await begin();

        await work();

        expect((await judgmentOf(trial, 'local', 1)).answers).toEqual([
          { arm: 'stored', expectation: 0, p: expect.closeTo(0.9), passage: null },
          { arm: 'draft', expectation: 0, p: expect.closeTo(0.9), passage: null },
        ]);
        expect((await deps.trials.getTrial(trial.id))!.state).toBe('awaiting_answer');
      });

      it('goes on without it when it fails, since it doesn’t count', async () => {
        await setUp({}, {}, await localModel(500));
        const trial = await begin();

        await work();

        expect(await judgmentOf(trial, 'local', 1)).toMatchObject({ state: 'failed', answers: null, error: expect.stringContaining('answered 500') });
        expect(await judgmentOf(trial, 'model', 1)).toMatchObject({ state: 'done' });
        expect((await deps.trials.getTrial(trial.id))!.state).toBe('awaiting_answer');
      });
    });
  });

  describe('beside live work', () => {
    const background = (live = 0) => {
      const ticks: number[] = [];
      const work: Background = { liveCount: () => live, tick: async (free) => void ticks.push(free) };
      return { ticks, work };
    };

    it('is offered the workers that are free when no task is waiting for one', async () => {
      await setUp();
      const { ticks, work } = background(1);

      await new Scheduler(e, e.runner, undefined, work).tick();

      expect(ticks).toEqual([e.config.maxWorkers - 1]);
    });

    it('is offered none while a task waits for a worker', async () => {
      e = await makeEngine({ steps: [SLOW], config: { maxWorkers: 1 } });
      deps = { ...e, trials: new TrialStore(e.db) };
      runner = new TrialRunner(deps);
      await e.addTicket(ticket({ id: 'T-1', touches: ['src/a/**'] }));
      await e.addTicket(ticket({ id: 'T-2', touches: ['src/b/**'] }));
      const { ticks, work } = background();
      const scheduler = new Scheduler(e, e.runner, undefined, work);

      await scheduler.tick();
      await scheduler.tick();

      expect(e.runner.liveCount()).toBe(1);
      expect(ticks).toEqual([]);
    });
  });
});
