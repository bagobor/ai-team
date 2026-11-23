import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { manifestDir, stateRepoDir } from '../src/paths.ts';
import type { RoleProvenance } from '../src/roles/provenance.ts';
import { createApp } from '../src/server/app.ts';
import { commitTrial, undoTrial } from '../src/trials/commit.ts';
import { addEntry, changeEntry, setCharter, startDraft } from '../src/trials/drafts.ts';
import { TrialStore } from '../src/trials/store.ts';
import { startTrial, type TrialDeps } from '../src/trials/trial.ts';
import type { TrialRow, Verdict } from '../src/trials/types.ts';
import { makeEngine, okStep, runOnce, ticket, type TestEngine } from './helpers/engine.ts';
import { commitAll, run } from './helpers/repo.ts';
import { read } from './helpers/trials.ts';

const PORT = 4780;
const AGREED: Verdict = { worse: [], agreed: true, judges: { model: { improvement: true, why: 'It meets 3 of 3 expectations, against 0 without it.' }, stakeholder: { improvement: true, why: 'You found it better on 3 of 3.' } } };

describe('committing a draft that a trial agreed on', () => {
  let e: TestEngine;
  let deps: TrialDeps;
  let attempts: number[];
  let draftId: number;

  beforeEach(async () => {
    e = await makeEngine({ steps: { byTask: { '*': okStep({ 'src/a.mjs': 'export {}' }) } }, config: { port: PORT } });
    deps = { ...e, trials: new TrialStore(e.db) };
    attempts = [];
    for (let i = 1; i <= 5; i += 1) {
      const task = await e.addTicket(ticket({ id: `T-${i}` }));
      await runOnce(e, task.id);
      attempts.push((await e.store.listAttempts(task.id))[0]!.id);
    }
    draftId = (await startDraft(deps, 'engineer', 'Run the checks first')).id;
    await addEntry(deps, draftId, 'playbook', { text: 'Run every check before you report.' });
  });

  afterEach(() => e.cleanup());

  const knowledge = (...parts: string[]) => join(e.paths.knowledge, ...parts);
  const playbook = () => knowledge('roles', 'engineer', 'playbook.md');

  // A trial of the draft as it stands, ended the way the stakeholder's answer would end it.
  async function tried(state: 'agreed' | 'not_agreed' = 'agreed'): Promise<TrialRow> {
    const trial = await startTrial(deps, draftId, { expectations: ['Does it list every command?'], problem: attempts.slice(0, 3), fine: attempts.slice(3) });
    return deps.trials.patchTrial(trial.id, { state, verdict: { ...AGREED, agreed: state === 'agreed' }, ended_at: '2026-11-22T12:00:00.000Z' });
  }

  it('writes the playbook to the knowledge repo as one commit that names the trial and who found what', async () => {
    const trial = await tried();

    const committed = await commitTrial(deps, trial.id);

    expect(read(playbook())).toBe(trial.knowledge.draft.playbook);
    expect(committed.commits).toEqual({ knowledge: run(e.paths.knowledge, 'rev-parse', 'HEAD') });
    expect(run(e.paths.knowledge, 'log', '-1', '--format=%B')).toBe(
      ['engineer: Run the checks first', '', `Passed trial ${trial.id}, on 5 past tasks of the role. Nothing that can be counted got worse.`, '- The model judge: It meets 3 of 3 expectations, against 0 without it.', '- The stakeholder: You found it better on 3 of 3.'].join('\n'),
    );
    expect(run(e.paths.knowledge, 'show', '--name-only', '--format=', 'HEAD')).toBe('roles/engineer/playbook.md');
    expect(run(e.paths.knowledge, 'status', '--porcelain')).toBe('');
    expect(await deps.trials.getDraft(draftId)).toMatchObject({ state: 'committed' });
    expect(await deps.trials.openDraft('engineer')).toBeUndefined();
  });

  it('is what the role’s next task reads', async () => {
    await commitTrial(deps, (await tried()).id);
    const next = await e.addTicket(ticket({ id: 'T-9' }));

    await runOnce(e, next.id);

    expect(read(manifestDir(e.paths, 'p', 'T-9', 1), 'system.md')).toContain('### PB-1\n\nRun every check before you report.');
  });

  it('writes a charter to the knowledge repo and memory to the project’s state repo, each with its own commit', async () => {
    await setCharter(deps, draftId, `${read(knowledge('roles', 'engineer', 'charter.md'))}- Run every check before you report.\n`);
    await addEntry(deps, draftId, 'memory_role', { text: 'Tests live in test/.', kind: 'structure', project: 'p' });
    const state = stateRepoDir(e.paths, 'p');
    const trial = await tried();

    const { commits } = await commitTrial(deps, trial.id);

    expect(commits).toEqual({ knowledge: run(e.paths.knowledge, 'rev-parse', 'HEAD'), state: run(state, 'rev-parse', 'HEAD') });
    expect(run(e.paths.knowledge, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['roles/engineer/charter.md', 'roles/engineer/playbook.md']);
    expect(run(state, 'show', '--name-only', '--format=%s', 'HEAD')).toBe('engineer: Run the checks first\n\nmemory/roles/engineer.md');
    expect(read(state, 'memory', 'roles', 'engineer.md')).toContain('## MEM-1\nKind: structure');
    expect(existsSync(join(state, 'memory', 'project.md'))).toBe(false);
  });

  it('is refused for a trial that did not end agreed, and for one committed already', async () => {
    const trial = await tried('not_agreed');
    await expect(commitTrial(deps, trial.id)).rejects.toMatchObject({ status: 409, message: `Trial ${trial.id} did not end agreed, so its draft can’t be committed` });
    expect(existsSync(playbook())).toBe(false);

    await deps.trials.patchTrial(trial.id, { state: 'agreed' });
    await commitTrial(deps, trial.id);
    await expect(commitTrial(deps, trial.id)).rejects.toMatchObject({ status: 409, message: `Trial ${trial.id}’s draft has been committed already` });
    await expect(commitTrial(deps, 999)).rejects.toMatchObject({ status: 404 });
  });

  it('is refused when the draft is no longer what the trial tried', async () => {
    const trial = await tried();
    await changeEntry(deps, draftId, 'playbook', 'PB-1', { text: 'Run every check, twice.' });

    await expect(commitTrial(deps, trial.id)).rejects.toMatchObject({ status: 409, message: 'The draft has changed since this trial tried it. Try it again as it is now.' });
    expect(existsSync(playbook())).toBe(false);
  });

  it('is refused when a live file has changed since the trial began', async () => {
    const trial = await tried();
    writeFileSync(playbook(), '## PB-9\nAdded by: someone\nAdded: 2026-11-21\n\nA hand edit.\n');

    await expect(commitTrial(deps, trial.id)).rejects.toMatchObject({ status: 409, message: 'roles/engineer/playbook.md has changed since this trial began, so the trial no longer says what committing the draft would do. Try it again.' });
    expect(read(playbook())).toContain('A hand edit.');
  });

  it('is refused while a hand edit to the same file waits to be committed, since it never passed the trial', async () => {
    // The edit is live, so the trial ran with it on both sides. But it would be committed under the trial's name.
    appendFileSync(knowledge('roles', 'engineer', 'charter.md'), '- A rule added by hand and never committed.\n');
    await setCharter(deps, draftId, `${read(knowledge('roles', 'engineer', 'charter.md'))}- One more rule.\n`);
    const trial = await tried();

    await expect(commitTrial(deps, trial.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('in the knowledge repo has a change nobody committed') });
    expect(run(e.paths.knowledge, 'log', '-1', '--format=%s')).not.toContain('Run the checks first');
  });

  describe('undone', () => {
    it('takes the commit back with a commit of its own', async () => {
      const trial = await tried();
      const { commits } = await commitTrial(deps, trial.id);

      const undone = await undoTrial(deps, trial.id);

      expect(existsSync(playbook())).toBe(false);
      expect(undone.commits).toEqual({ ...commits, undone: { knowledge: run(e.paths.knowledge, 'rev-parse', 'HEAD') } });
      expect(run(e.paths.knowledge, 'log', '-2', '--format=%s')).toBe('Revert "engineer: Run the checks first"\nengineer: Run the checks first');
      await expect(undoTrial(deps, trial.id)).rejects.toMatchObject({ status: 409, message: `Trial ${trial.id}’s commit has been undone already` });
    });

    it('takes back memory in the project’s state repo too', async () => {
      await addEntry(deps, draftId, 'memory_role', { text: 'Tests live in test/.', kind: 'structure', project: 'p' });
      const state = stateRepoDir(e.paths, 'p');
      const trial = await tried();
      await commitTrial(deps, trial.id);

      const undone = await undoTrial(deps, trial.id);

      expect(undone.commits?.undone).toEqual({ knowledge: run(e.paths.knowledge, 'rev-parse', 'HEAD'), state: run(state, 'rev-parse', 'HEAD') });
      expect(existsSync(join(state, 'memory', 'roles', 'engineer.md'))).toBe(false);
    });

    it('is refused when a later change to the same lines stands in the way, and leaves the files as they were', async () => {
      const trial = await tried();
      await commitTrial(deps, trial.id);
      writeFileSync(playbook(), read(playbook()).replace('Run every check before you report.', 'Run every check, and say which.'));
      commitAll(e.paths.knowledge, 'engineer: sharper by hand');

      await expect(undoTrial(deps, trial.id)).rejects.toMatchObject({ status: 409, message: 'A later change to the same lines stands in the way of undoing this. Change the files by hand instead.' });
      expect(read(playbook())).toContain('Run every check, and say which.');
      expect(run(e.paths.knowledge, 'status', '--porcelain')).toBe('');
      expect((await deps.trials.getTrial(trial.id))!.commits?.undone).toBeUndefined();
    });

    it('has nothing to take back for a trial that committed nothing', async () => {
      await expect(undoTrial(deps, (await tried()).id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('through the API', () => {
    let app: Hono;
    const host = `127.0.0.1:${PORT}`;
    const get = (path: string) => app.request(path, { headers: { host } });
    const post = (path: string) => app.request(path, { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: '{}' });

    beforeEach(() => {
      app = createApp(e);
    });

    it('commits and undoes, and marks the role’s changes with the trial they passed', async () => {
      const trial = await tried();

      const committed = (await (await post(`/api/trials/${trial.id}/commit`)).json()) as { commits: TrialRow['commits']; draftMoved: boolean };
      expect(committed.commits?.knowledge).toMatch(/^[0-9a-f]{40}$/);
      expect((await post(`/api/trials/${trial.id}/commit`)).status).toBe(409);

      const lessons = async () => ((await (await get('/api/roles/engineer/provenance')).json()) as RoleProvenance).lessons;
      const [newest, ...older] = await lessons();
      expect(newest).toMatchObject({ sha: committed.commits!.knowledge, subject: 'engineer: Run the checks first', trial: trial.id, files: [{ kind: 'playbook' }] });
      expect(older.every((lesson) => lesson.trial === undefined)).toBe(true);

      expect((await post(`/api/trials/${trial.id}/undo`)).status).toBe(200);
      const [revert, change] = await lessons();
      expect(revert).toMatchObject({ subject: 'Revert "engineer: Run the checks first"', undoes: trial.id });
      expect(revert!.trial).toBeUndefined();
      expect(change).toMatchObject({ trial: trial.id });
      expect((await post(`/api/trials/${trial.id}/undo`)).status).toBe(409);
    });
  });
});
