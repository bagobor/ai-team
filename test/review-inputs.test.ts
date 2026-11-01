import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureTask, milestoneReviewTask } from '../src/engine/conductor/tasks.ts';
import type { TaskRow } from '../src/engine/store.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { manifestDir } from '../src/paths.ts';
import { apply, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, resultStep, runOnce, type TestEngine } from './helpers/engine.ts';
import { revParse } from './helpers/repo.ts';

const CRITERIA_COUNT = 30;
const TICKET_COUNT = 10;
const PINS = ['SPEC-M1@1', 'TEST-PLAN-M1@1', 'QA-REPORT-M1-1@1'];
// A role budget is 12,000, and M3 adds up to 2,000 of playbook and 1,000 of memory to every manifest.
const ROOM_BEFORE_M3 = 9_000;

const ids = Array.from({ length: CRITERIA_COUNT }, (_, i) => `AC-${i + 1}`);
const words = (chars: number) => 'the check reads the file and compares it with what it should hold '.repeat(Math.ceil(chars / 67)).slice(0, chars);
// Sizes from the first real run: its verification commands were shell one-liners of about 700 characters.
const command = (ac: string) => `true # command-marker ${ac} ${words(700)}`;
const textOf = (ac: string) => `text-${ac}-marker ${words(250)}`;
const noteOf = (ac: string) => `note-${ac}-marker ${words(150)}`;
const REVIEW = { body: '# How it went\n', known_issues: [], deviations: [], stakeholder_note: 'Ship it' };

type QaOverrides = { notes?: (ac: string) => string; summary?: string; bugs?: unknown[] };

describe('the Milestone Review inputs', () => {
  let e: TestEngine;

  // Each document comes from its real applier, so these are the sizes and shapes a real milestone leaves behind.
  async function reviewOfLargeMilestone(qa: QaOverrides = {}): Promise<TaskRow> {
    e = await makeEngine({ steps: { byTask: { 'M1-REVIEW-1': resultStep(REVIEW) } } });
    const project = await projectOf(e);
    await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'Goal', phase: 'pending' });
    await e.store.patchMilestone(project.id, 1, { verify_round: 1 });

    const criteria = ids.map((id) => ({ id, text: textOf(id), verification: { method: 'automated', how: command(id) } }));
    const [spec] = await publish(e, await apply(e, 'milestone_spec', { body: `# Goal\n\nspec-prose-marker ${words(3000)}\n`, criteria }));
    await e.store.lockCriteria(project.id, 1, spec!.version, criteria as Parameters<typeof e.store.lockCriteria>[3]);

    const tickets = Array.from({ length: TICKET_COUNT }, (_, t) => ({
      key: `T-${t + 1}`,
      title: `Ticket ${t + 1}`,
      specialty: 'engineer',
      ac_refs: ids.slice(t * 3, t * 3 + 3),
      touches: [`src/part-${t + 1}/**`],
      depends_on: [],
      definition_of_done: ['npm test'],
      inputs: [],
      size: 'S',
      body: 'Do it.\n',
    }));
    await publish(e, await apply(e, 'tech_design', { body: '# Design\n', tickets }, { inputs: ['SPEC-M1@1'], role: 'tech_lead' }));
    const coverage = ids.map((ac) => ({ ac, commands: [command(ac)], notes: words(150) }));
    await publish(e, await apply(e, 'test_plan', { body: `# Test plan\n\nplan-prose-marker ${words(1500)}\n`, coverage, harness_tickets: [] }, { inputs: ['SPEC-M1@1'], role: 'tech_lead' }));

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

  it('fit the budget on a milestone of 10 tickets and 30 criteria, with room left for M3', async () => {
    const task = await reviewOfLargeMilestone();

    await runOnce(e, task.id);

    const [attempt] = await e.store.listAttempts(task.id);
    expect(attempt).toMatchObject({ failure_kind: null });
    const manifest = attempt!.manifest as TaskManifest;
    expect(manifest.contextBudget).toBe(12_000);
    expect(manifest.totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M3);
  });

  it('give the PM the prose, every criterion with its status, and everything QA wrote', async () => {
    const bugs = [{ ac: 'AC-5', title: 'noted-title-marker', description: 'noted-description-marker', touches: ['src/**'], commands: [] }];
    const task = await reviewOfLargeMilestone({ bugs });

    await runOnce(e, task.id);

    const text = taskText();
    expect(text).toContain('spec-prose-marker');
    expect(text).toContain('plan-prose-marker');
    expect(text).toContain('qa-summary-marker');
    for (const ac of ids) {
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
    expect((await manifestOf(task)).totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M3);
  });

  it('stay within budget however much QA writes', async () => {
    const task = await reviewOfLargeMilestone({ notes: (ac) => `note-${ac}-marker ${words(20_000)}`, summary: `qa-summary-marker ${words(20_000)}` });

    await runOnce(e, task.id);

    const [attempt] = await e.store.listAttempts(task.id);
    expect(attempt).toMatchObject({ failure_kind: null });
    expect((attempt!.manifest as TaskManifest).totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M3);
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
