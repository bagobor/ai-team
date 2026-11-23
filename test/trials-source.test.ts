import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRow, TaskRow } from '../src/engine/store.ts';
import { knowledgeFingerprint, type TaskManifest } from '../src/manifest/build.ts';
import { manifestDir } from '../src/paths.ts';
import { pastAttempts, replaySource, storedMeasure, suggestFine, ticketMeasure, type PastAttempt, type ReplaySource } from '../src/trials/source.ts';
import { apply, CRITERIA, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, okStep, runOnce, ticket, type TestEngine } from './helpers/engine.ts';
import { run } from './helpers/repo.ts';

describe('running a past attempt again', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [okStep({ 'src/a.mjs': 'export {}' })] });
  });

  afterEach(() => e.cleanup());

  async function ran(markdown = ticket()): Promise<{ task: TaskRow; attempt: AttemptRow }> {
    const task = await e.addTicket(markdown);
    await runOnce(e, task.id);
    const [attempt] = await e.store.listAttempts(task.id);
    return { task, attempt: attempt! };
  }

  const sourceOf = async (attemptId: number): Promise<ReplaySource> => {
    const found = await replaySource(e, attemptId);
    if (!found.ok) throw new Error(found.why);
    return found.source;
  };
  const whyNot = async (attemptId: number) => {
    const found = await replaySource(e, attemptId);
    return found.ok ? 'it can be replayed' : found.why;
  };

  it('takes the prompt’s sections and the fingerprint an attempt kept', async () => {
    const { attempt, task } = await ran();
    const manifest = attempt.manifest as TaskManifest;

    const source = await sourceOf(attempt.id);

    expect(source).toMatchObject({ sections: manifest.sections, fingerprint: manifest.fingerprint, reference: {} });
    expect(source.task.id).toBe(task.id);
    expect(source.project.name).toBe('p');
  });

  // As every attempt from before playbooks and memory is stored: the whole prompt, and nothing about its parts.
  const asStoredBefore = async (attempt: AttemptRow, system?: string) => {
    const { sections: _, fingerprint: __, ...old } = attempt.manifest as TaskManifest;
    await e.store.patchAttempt(attempt.id, { manifest: { ...old, system: system ?? old.system } });
  };

  it('takes an older prompt apart at its output contract, and works out what it was given', async () => {
    const { attempt } = await ran();
    const manifest = attempt.manifest as TaskManifest;
    await asStoredBefore(attempt);

    const source = await sourceOf(attempt.id);

    expect(source.sections).toEqual(manifest.sections);
    expect(source.fingerprint).toBe(knowledgeFingerprint({ charter: manifest.sections.charter, playbook: '', memory: '' }, manifest.model));
  });

  it('takes apart an older prompt that carried the repository’s instructions', async () => {
    const { attempt } = await ran();
    const { sections } = attempt.manifest as TaskManifest;
    await asStoredBefore(attempt, `${sections.charter}\n\n${sections.contract}\n\n## Repository instructions\n\nUse tabs.\n`);

    expect((await sourceOf(attempt.id)).sections).toEqual({ ...sections, instructions: '## Repository instructions\n\nUse tabs.' });
  });

  it('won’t guess at a prompt it can’t take apart', async () => {
    const { attempt } = await ran();
    await asStoredBefore(attempt, 'A prompt with no contract in it.\n');

    expect(await whyNot(attempt.id)).toBe('its stored prompt can’t be taken apart into the charter and the output contract');
  });

  describe('an attempt that read a reference file', () => {
    // A ticket that reads the Spec gets the commands that verify its criteria in a file, not in its prompt.
    const withSpec = async () => {
      const project = await projectOf(e);
      await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
      const [spec] = await publish(e, await apply(e, 'milestone_spec', { body: '# Goal\n\nBoth things work.\n', criteria: CRITERIA }));
      await e.store.lockCriteria(project.id, 1, spec!.version, CRITERIA);
      return ran(ticket({ inputs: ['SPEC-M1@1'] }));
    };
    const kept = (task: TaskRow) => join(manifestDir(e.paths, 'p', task.ticket_id, 1), 'reference');

    it('gets the files kept beside its prompt', async () => {
      const { attempt, task } = await withSpec();

      const { reference } = await sourceOf(attempt.id);

      expect(Object.keys(reference)).toEqual(['verification.md']);
      expect(reference['verification.md']).toBe(readFileSync(join(kept(task), 'verification.md'), 'utf8'));
      expect(reference['verification.md']).toContain('npm test -- first');
    });

    it('gets them rebuilt from the same versions when none were kept, whatever has happened to the documents’ status since', async () => {
      const { attempt, task } = await withSpec();
      const before = (await sourceOf(attempt.id)).reference;
      rmSync(kept(task), { recursive: true });
      await e.artifacts.commit(await projectOf(e), { message: 'the spec goes stale', status: [{ id: 'SPEC-M1', status: 'stale' }] });

      expect((await sourceOf(attempt.id)).reference).toEqual(before);
    });

    it('is refused when an input no longer reads as the stored task has it', async () => {
      const { attempt, task } = await withSpec();
      rmSync(kept(task), { recursive: true });
      const manifest = attempt.manifest as TaskManifest;
      await e.store.patchAttempt(attempt.id, { manifest: { ...manifest, task: manifest.task.replace('The first thing works', 'The first thing worked differently then') } });

      expect(await whyNot(attempt.id)).toBe('its reference files can’t be rebuilt: SPEC-M1@1 no longer reads as it did then');
    });
  });

  it('says why an attempt can’t be run again', async () => {
    const { attempt, task } = await ran();
    const other = await e.store.createAttempt({ task_id: task.id, adapter: 'claude-code', model: 'm', worktree_path: e.repoPath, branch: 'b' });

    expect(await whyNot(999)).toBe('there is no attempt 999');
    expect(await whyNot(other.id)).toBe('it never got as far as a prompt');

    await e.store.patchAttempt(other.id, { manifest: attempt.manifest });
    expect(await whyNot(other.id)).toBe('it was starting, so it has no result to compare');

    await e.store.patchAttempt(attempt.id, { failure_kind: 'auth_required' });
    expect(await whyNot(attempt.id)).toBe('it failed for a reason outside the work (auth_required)');

    await e.store.patchAttempt(attempt.id, { failure_kind: null, base_sha: '0'.repeat(40) });
    expect(await whyNot(attempt.id)).toBe('the commit it started from is no longer in the repository');
  });

  it('counts what a ticket’s checks said, and leaves unknown what the run never reached', () => {
    expect(ticketMeasure({ ok: true })).toEqual({ changed: true, tests: true, checks: true, note: null });
    expect(ticketMeasure({ ok: false, kind: 'no_changes', evidence: 'The attempt changed nothing.' })).toEqual({ changed: false, tests: null, checks: null, note: 'The attempt changed nothing.' });
    expect(ticketMeasure({ ok: false, kind: 'tests_missing', evidence: 'No test for logic-core.' })).toMatchObject({ changed: true, tests: false, checks: null });
    expect(ticketMeasure({ ok: false, kind: 'check_failed', evidence: 'node --test: exit 1' })).toMatchObject({ changed: true, tests: true, checks: false });
    expect(ticketMeasure({ ok: false, kind: 'scope_violation', evidence: 'x' })).toMatchObject({ changed: true, tests: null, checks: false });
  });

  it('counts the same for what an attempt produced at the time', async () => {
    const { attempt, task } = await ran();
    const order = { ...task, kind: 'authoring' } as TaskRow;

    expect(storedMeasure(attempt, task)).toEqual({ parses: true, changed: true, tests: true, checks: true, usd: 0.01, note: null });
    expect(storedMeasure({ ...attempt, state: 'succeeded', failure_kind: 'changes_requested' }, task)).toMatchObject({ checks: true });
    expect(storedMeasure({ ...attempt, state: 'failed', failure_kind: 'check_failed', failure_evidence: 'node --test: exit 1' }, task)).toMatchObject({ parses: true, checks: false, note: 'node --test: exit 1' });
    expect(storedMeasure({ ...attempt, state: 'invalid_output', failure_kind: 'invalid_output', output: null }, task)).toMatchObject({ parses: false, checks: null, changed: null });
    expect(storedMeasure({ ...attempt, state: 'failed', failure_kind: 'max_turns', output: null, usage: null }, task)).toEqual({ parses: false, checks: null, changed: null, tests: null, usd: null, note: 'max_turns' });
    expect(storedMeasure(attempt, order)).toEqual({ parses: true, checks: null, changed: null, tests: null, usd: 0.01, note: null });
  });

  it('lists a role’s past attempts newest first, with whether each can be run again', async () => {
    const first = await ran(ticket({ id: 'T-1' }));
    const second = await ran(ticket({ id: 'T-2' }));
    run(e.repoPath, 'update-ref', '-d', `refs/heads/${second.attempt.branch}`);
    await e.store.patchAttempt(second.attempt.id, { base_sha: '0'.repeat(40) });

    const list = await pastAttempts(e, 'engineer');

    expect(list.map(({ ticketId, replayable, firstPass }) => [ticketId, replayable, firstPass])).toEqual([
      ['T-2', false, true],
      ['T-1', true, true],
    ]);
    expect(list[0]).toMatchObject({ attemptId: second.attempt.id, project: 'p', purpose: 'ticket', k: 1, state: 'succeeded', why: 'the commit it started from is no longer in the repository' });
    expect(list[1]).toMatchObject({ attemptId: first.attempt.id, why: null, usd: 0.01 });
    expect(await pastAttempts(e, 'pm')).toEqual([]);
    expect(await pastAttempts(e, 'engineer', 'no-such-project')).toEqual([]);
  });

  it('offers as tasks that went fine the newest first-pass successes, one of each project and purpose before a second', () => {
    const past = (attemptId: number, project: string, purpose: string, over: Partial<PastAttempt> = {}): PastAttempt => ({ attemptId, project, purpose, ticketId: `T-${attemptId}`, title: '', k: 1, state: 'succeeded', failureKind: null, endedAt: null, usd: null, firstPass: true, replayable: true, why: null, ...over });
    const list = [past(9, 'a', 'ticket'), past(8, 'a', 'ticket'), past(7, 'a', 'ticket', { replayable: false }), past(6, 'b', 'ticket', { firstPass: false }), past(5, 'b', 'ticket'), past(4, 'a', 'tech_design')];

    expect(suggestFine(list).map(({ attemptId }) => attemptId)).toEqual([9, 5, 4]);
    expect(suggestFine(list, 5).map(({ attemptId }) => attemptId)).toEqual([9, 5, 4, 8]);
    expect(suggestFine([])).toEqual([]);
  });
});
