import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureTask, milestoneReviewTask } from '../src/engine/conductor/tasks.ts';
import type { TaskRow } from '../src/engine/store.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { manifestDir } from '../src/paths.ts';
import { apply, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, resultStep, runOnce, type TestEngine } from './helpers/engine.ts';
import { ids, noteOf, pmRowOf, publishLargeDesign, publishLargeSpec, ROOM_BEFORE_M4, words } from './helpers/large-milestone.ts';
import { revParse } from './helpers/repo.ts';

const PINS = ['SPEC-M1@1', 'TEST-PLAN-M1@1', 'QA-REPORT-M1-1@1'];
const REVIEW = { body: '# How it went\n', known_issues: [], deviations: [], stakeholder_note: 'Ship it' };

type QaOverrides = { notes?: (ac: string) => string; summary?: string; bugs?: unknown[]; ownCriteriaSection?: boolean };

describe('the Milestone Review inputs', () => {
  let e: TestEngine;

  async function reviewOfLargeMilestone(qa: QaOverrides = {}): Promise<TaskRow> {
    e = await makeEngine({ steps: { byTask: { 'M1-REVIEW-1': resultStep(REVIEW) } } });
    const project = await publishLargeSpec(e, { ownCriteriaSection: qa.ownCriteriaSection ?? true });
    await publishLargeDesign(e);

    const results = ids.map((ac) => ({ ac, status: 'passing', commands: [], notes: (qa.notes ?? noteOf)(ac) }));
    const output = { results, bugs: qa.bugs ?? [], summary: qa.summary ?? `qa-summary-marker ${words(600)}` };
    await publish(e, await apply(e, 'qa_verify', output, { kind: 'qa_verify', role: 'qa_engineer', inputs: ['SPEC-M1@1', 'TEST-PLAN-M1@1'], baseSha: await revParse(e.repoPath) }));

    return e.store.atomically((s) => ensureTask(s, milestoneReviewTask(project, 1, 1, PINS)));
  }

  const taskText = () => readFileSync(join(manifestDir(e.paths, 'p', 'M1-REVIEW-1', 1), 'task.md'), 'utf8');
  const manifestOf = async (task: TaskRow) => (await e.store.listAttempts(task.id))[0]!.manifest as TaskManifest;

  afterEach(async () => {
    await e.cleanup();
  });

  it('fit the budget on a milestone of 10 tickets and 30 criteria, with room left for M4', async () => {
    const task = await reviewOfLargeMilestone();

    await runOnce(e, task.id);

    const [attempt] = await e.store.listAttempts(task.id);
    expect(attempt).toMatchObject({ failure_kind: null });
    const manifest = attempt!.manifest as TaskManifest;
    expect(manifest.contextBudget).toBe(12_000);
    expect(manifest.totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M4);
  });

  it('give the PM the prose, every criterion with its status, and everything QA wrote', async () => {
    const bugs = [{ ac: 'AC-5', title: 'noted-title-marker', description: 'noted-description-marker', touches: ['src/**'], commands: [] }];
    const task = await reviewOfLargeMilestone({ bugs });

    await runOnce(e, task.id);

    const text = taskText();
    expect(text).toContain('spec-prose-marker');
    expect(text).toContain('assumption-marker');
    expect(text).toContain('plan-prose-marker');
    expect(text).toContain('qa-summary-marker');
    for (const ac of ids) {
      expect(text).toContain(pmRowOf(ac));
      expect(text).toContain(`- ${ac} (passing): text-${ac}-marker`);
      expect(text).toContain(`note-${ac}-marker`);
    }
    expect(text).toContain('noted-title-marker: noted-description-marker');
  });

  it('leave out the verification commands, which ran and passed before the review began', async () => {
    const task = await reviewOfLargeMilestone();

    await runOnce(e, task.id);

    expect(taskText()).not.toContain('command-marker');
  });

  it('leave out the commands of a Spec without an Acceptance criteria section of its own as well', async () => {
    const task = await reviewOfLargeMilestone({ ownCriteriaSection: false });

    await runOnce(e, task.id);

    expect(taskText()).not.toContain('command-marker');
    for (const ac of ids) expect(taskText()).toContain(`- ${ac} (passing): text-${ac}-marker`);
  });

  it('still name their three documents, and the review still derives from them', async () => {
    const task = await reviewOfLargeMilestone();

    await runOnce(e, task.id);

    const text = taskText();
    for (const pin of PINS) expect(text).toContain(`<input pin="${pin}">`);
    const project = await projectOf(e);
    expect(await e.artifacts.latest(project.id, 'MILESTONE-REVIEW-M1')).toMatchObject({ derived_from: PINS });
    const { body } = await e.artifacts.read(project, 'MILESTONE-REVIEW-M1');
    for (const ac of ids) expect(body).toContain(`${ac}: text-${ac}-marker`);
  });

  it('cut only a note too long to fit, and say so', async () => {
    const task = await reviewOfLargeMilestone({ notes: (ac) => (ac === 'AC-1' ? `note-AC-1-marker ${words(50_000)}` : noteOf(ac)) });

    await runOnce(e, task.id);

    const text = taskText();
    expect(text).toContain('note-AC-1-marker');
    expect(text).toMatch(/\[cut: \d+ more characters\]/);
    expect(text.match(/\[cut:/g)).toHaveLength(1);
    expect(text).toContain(noteOf('AC-30'));
    expect((await manifestOf(task)).totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M4);
  });

  it('stay within budget however much QA writes', async () => {
    const task = await reviewOfLargeMilestone({ notes: (ac) => `note-${ac}-marker ${words(20_000)}`, summary: `qa-summary-marker ${words(20_000)}` });

    await runOnce(e, task.id);

    const [attempt] = await e.store.listAttempts(task.id);
    expect(attempt).toMatchObject({ failure_kind: null });
    expect((attempt!.manifest as TaskManifest).totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M4);
    const text = taskText();
    for (const ac of ids) expect(text).toContain(`note-${ac}-marker`);
    expect(text).toContain('qa-summary-marker');
  });

  it('name a note left empty only in the criteria list', async () => {
    const task = await reviewOfLargeMilestone({ notes: (ac) => (ac === 'AC-1' ? ' ' : noteOf(ac)) });

    await runOnce(e, task.id);

    const text = taskText();
    expect(text).toContain('- AC-1 (passing): text-AC-1-marker');
    expect(text).not.toContain('## AC-1 ');
    expect(text).toContain('## AC-2 (passing)');
  });
});
