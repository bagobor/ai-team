import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureTask, qaTask, recommendationTask, reviseInputs, reviseTask, specTask, techTask, testPlanTask, type TaskSpec } from '../src/engine/conductor/tasks.ts';
import type { AttemptRow, ProjectRow } from '../src/engine/store.ts';
import type { TaskManifest } from '../src/manifest/build.ts';
import { manifestDir } from '../src/paths.ts';
import { apply, publish } from './helpers/apply.ts';
import { makeEngine, okStep, resultStep, runOnce, ticket, type TestEngine } from './helpers/engine.ts';
import { command, ids, largeCoverage, largeDesign, largeTestPlan, largeTickets, noteOf, planNoteOf, pmRowOf, publishLargeDesign, publishLargeSpec, publishProfile, ROOM_BEFORE_M4, textOf } from './helpers/large-milestone.ts';
import { commitAll, porcelain, run, tempDir } from './helpers/repo.ts';

const QA_PINS = ['SPEC-M1@1', 'TEST-PLAN-M1@1'];
const QA_OUTPUT = { results: ids.map((ac) => ({ ac, status: 'passing', commands: [], notes: noteOf(ac) })), bugs: [], summary: 'All of it passed' };
// The engine refuses these outputs, and a refused attempt keeps its worktree, so a test can read what the worker could read.
const QA_REFUSED = { results: [], bugs: [], summary: 'Nothing' };
const REVISED_PLAN = { unaffected: false, rationale: 'The Spec moved', body: '# Test plan\n', coverage: largeCoverage, ticket_decisions: [], tickets: [] };
const REVISE_REFUSED = { unaffected: false, rationale: 'The Spec moved', body: '# Test plan\n', coverage: null, ticket_decisions: [], tickets: [] };
const STILL_RIGHT = { unaffected: true, rationale: 'Still right', body: null, coverage: null, ticket_decisions: largeTickets.map(({ key }) => ({ ticket: `M1-${key}`, decision: 'still_valid', rationale: 'Yes' })), tickets: [] };
const CHANGE_REQUEST = { id: 'CR-1', type: 'change_request' as const, status: 'proposed' as const, ownerRole: 'pm', derivedFrom: [], body: 'Change it' };
const RECOMMENDATION = { decision: 'approve', rationale: 'It costs little' };

describe('what a role reads on a milestone of 10 tickets and 30 criteria', () => {
  let e: TestEngine;

  async function engineWith(ticketId: string, output: unknown, spec = { ownCriteriaSection: true }): Promise<ProjectRow> {
    e = await makeEngine({ steps: { byTask: { [ticketId]: resultStep(output) } } });
    return publishLargeSpec(e, spec);
  }

  async function workOn(spec: TaskSpec) {
    const task = await e.store.atomically((s) => ensureTask(s, spec));
    await runOnce(e, task.id);
    const [attempt] = await e.store.listAttempts(task.id);
    return { state: (await e.store.getTask(task.id))!.state, attempt: attempt!, manifest: attempt!.manifest as TaskManifest };
  }

  function expectRoomForM4({ attempt, manifest }: { attempt: AttemptRow; manifest: TaskManifest }): void {
    expect(attempt).toMatchObject({ failure_kind: null });
    expect(manifest.contextBudget).toBe(12_000);
    expect(manifest.totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M4);
  }

  const taskText = (ticketId: string) => readFileSync(join(manifestDir(e.paths, 'p', ticketId, 1), 'task.md'), 'utf8');
  const referenceOf = ({ worktree_path }: AttemptRow) => readFileSync(join(worktree_path, '.aiteam-reference', 'verification.md'), 'utf8');
  const timesIn = (text: string, part: string) => text.split(part).length - 1;

  function expectAllCommands(reference: string): void {
    for (const ac of ids) expect(timesIn(reference, command(ac)), ac).toBe(1);
  }

  afterEach(async () => {
    await e.cleanup();
  });

  describe('QA', () => {
    it('fits the budget with room left for M4, and its output still applies', async () => {
      const project = await engineWith('M1-QA-1', QA_OUTPUT);
      await publishLargeDesign(e);

      const ran = await workOn(qaTask(project, 1, 1, QA_PINS));

      expectRoomForM4(ran);
      expect(ran.state).toBe('done');
      expect(await e.artifacts.latest(project.id, 'QA-REPORT-M1-1')).toMatchObject({ derived_from: QA_PINS });
    });

    it('can read every command word for word, though the manifest leaves them out', async () => {
      const project = await engineWith('M1-QA-1', QA_REFUSED);
      await publishLargeDesign(e);

      const { attempt } = await workOn(qaTask(project, 1, 1, QA_PINS));

      expect(attempt.state).toBe('invalid_output');
      expectAllCommands(referenceOf(attempt));
      expect(taskText('M1-QA-1')).not.toContain('command-marker');
    });

    it('reads the criteria, the prose and the notes, under pins that stay whole', async () => {
      const project = await engineWith('M1-QA-1', QA_OUTPUT);
      await publishLargeDesign(e);

      await workOn(qaTask(project, 1, 1, QA_PINS));

      const text = taskText('M1-QA-1');
      for (const pin of QA_PINS) expect(text).toContain(`<input pin="${pin}">`);
      expect(text).toContain('spec-prose-marker');
      expect(text).toContain('assumption-marker');
      expect(text).toContain('plan-prose-marker');
      for (const ac of ids) {
        expect(text).toContain(textOf(ac));
        expect(text).toContain(pmRowOf(ac));
        expect(text).toContain(planNoteOf(ac));
      }
      expect(text).toContain('.aiteam-reference/verification.md');
    });

    it('leaves the commands out of a Spec without an Acceptance criteria section of its own as well', async () => {
      const project = await engineWith('M1-QA-1', QA_REFUSED, { ownCriteriaSection: false });
      await publishLargeDesign(e);

      const { attempt } = await workOn(qaTask(project, 1, 1, QA_PINS));

      expectAllCommands(referenceOf(attempt));
      expect(taskText('M1-QA-1')).not.toContain('command-marker');
      for (const ac of ids) expect(taskText('M1-QA-1')).toContain(textOf(ac));
    });

    it('sees the Spec\'s command and the Test Plan\'s under the same criterion when they differ', async () => {
      const project = await engineWith('M1-QA-1', QA_REFUSED);
      const coverage = ids.map((ac) => ({ ac, commands: [`first-plan-command ${ac}`, `second-plan-command ${ac}`], notes: '' }));
      await publish(e, await apply(e, 'test_plan', { ...largeTestPlan, coverage }, { inputs: ['SPEC-M1@1'], role: 'qa_engineer' }));

      const { attempt } = await workOn(qaTask(project, 1, 1, QA_PINS));

      const section = referenceOf(attempt).split('## AC-7\n')[1]!.split('## AC-8\n')[0]!;
      expect(section).toContain(command('AC-7'));
      expect(section).toContain('first-plan-command AC-7');
      expect(section).toContain('second-plan-command AC-7');
      expect(section).not.toContain('AC-8');
    });
  });

  describe('Tech Design', () => {
    it('fits the budget with room left for M4, and its output still applies', async () => {
      const project = await engineWith('M1-TECH', largeDesign);
      const inputs = ['SPEC-M1@1', await publishProfile(e)];

      const ran = await workOn(techTask(project, 1, inputs));

      expectRoomForM4(ran);
      expect(ran.state).toBe('done');
      expect(await e.artifacts.latest(project.id, 'TECH-M1')).toMatchObject({ derived_from: inputs });
    });

    it('still sees every criterion it must cover with a ticket', async () => {
      const project = await engineWith('M1-TECH', largeDesign);
      const inputs = ['SPEC-M1@1', await publishProfile(e)];

      await workOn(techTask(project, 1, inputs));

      const text = taskText('M1-TECH');
      for (const pin of inputs) expect(text).toContain(`<input pin="${pin}">`);
      expect(text).toContain('spec-prose-marker');
      expect(text).toContain('profile-marker');
      for (const ac of ids) expect(text).toContain(textOf(ac));
      expect(text).not.toContain('command-marker');
    });
  });

  describe('Test Plan', () => {
    it('fits the budget with room left for M4, and its output is published whole', async () => {
      const project = await engineWith('M1-TESTPLAN', largeTestPlan);
      const inputs = ['SPEC-M1@1', await publishProfile(e)];

      const ran = await workOn(testPlanTask(project, 1, inputs));

      expectRoomForM4(ran);
      expect(ran.state).toBe('done');
      expect(await e.artifacts.latest(project.id, 'TEST-PLAN-M1')).toMatchObject({ derived_from: inputs });
      expect((await e.artifacts.read(project, 'TEST-PLAN-M1@1')).fields.data).toEqual({ coverage: largeCoverage });
    });

    it('can read the command the Spec gave each criterion', async () => {
      const project = await engineWith('M1-TESTPLAN', { ...largeTestPlan, coverage: [] });

      const { attempt } = await workOn(testPlanTask(project, 1, ['SPEC-M1@1', await publishProfile(e)]));

      expect(attempt.state).toBe('invalid_output');
      expectAllCommands(referenceOf(attempt));
      const text = taskText('M1-TESTPLAN');
      for (const ac of ids) expect(text).toContain(textOf(ac));
    });
  });

  describe('a revision', () => {
    async function reviseOf(id: string, ticketId: string, output: unknown, purpose: 'revise_design' | 'revise_test_plan') {
      const project = await engineWith(ticketId, output);
      await publishLargeDesign(e);
      const doc = (await e.artifacts.latest(project.id, id))!;
      return { project, ...(await workOn(reviseTask(project, 1, doc, 1, purpose, await reviseInputs(e, project, doc), []))) };
    }

    it('of the Test Plan fits the budget and can publish its full coverage', async () => {
      const { project, ...ran } = await reviseOf('TEST-PLAN-M1', 'M1-REVISE-TEST-PLAN-M1-1', REVISED_PLAN, 'revise_test_plan');

      expectRoomForM4(ran);
      expect(ran.state).toBe('done');
      expect((await e.artifacts.read(project, 'TEST-PLAN-M1@2')).fields.data).toEqual({ coverage: largeCoverage });
    });

    it('of the Test Plan can read the commands it has to write again, with their notes in the manifest', async () => {
      const { attempt } = await reviseOf('TEST-PLAN-M1', 'M1-REVISE-TEST-PLAN-M1-1', REVISE_REFUSED, 'revise_test_plan');

      expect(attempt.state).toBe('invalid_output');
      expectAllCommands(referenceOf(attempt));
      const text = taskText('M1-REVISE-TEST-PLAN-M1-1');
      for (const ac of ids) expect(text).toContain(planNoteOf(ac));
      expect(text).not.toContain('command-marker');
    });

    it('of the Tech Design fits the budget', async () => {
      const ran = await reviseOf('TECH-M1', 'M1-REVISE-TECH-M1-1', STILL_RIGHT, 'revise_design');

      expectRoomForM4(ran);
      expect(ran.state).toBe('done');
    });
  });

  describe('a Change Request recommendation', () => {
    it.each(['SPEC-M1', 'TEST-PLAN-M1'])('on %s fits the budget', async (id) => {
      const project = await engineWith('CR-1-REC', RECOMMENDATION);
      await publishLargeDesign(e);
      await e.artifacts.commit(project, { message: 'a request', publish: [CHANGE_REQUEST] });
      const target = (await e.artifacts.latest(project.id, id))!;

      const ran = await workOn(recommendationTask(project, 'CR-1', target, ['CR-1@1', `${id}@1`]));

      expectRoomForM4(ran);
      expect(ran.state).toBe('done');
      expect(taskText('CR-1-REC')).toContain('Change it');
    });

    it('can read the commands behind the document it judges', async () => {
      const project = await engineWith('CR-1-REC', { decision: 'approve', rationale: ' ' });
      await publishLargeDesign(e);
      await e.artifacts.commit(project, { message: 'a request', publish: [CHANGE_REQUEST] });
      const target = (await e.artifacts.latest(project.id, 'SPEC-M1'))!;

      const { attempt } = await workOn(recommendationTask(project, 'CR-1', target, ['CR-1@1', 'SPEC-M1@1']));

      expect(attempt.state).toBe('invalid_output');
      expectAllCommands(referenceOf(attempt));
    });
  });

  it('gives a PM reworking its Spec the criteria and the commands it has to write again', async () => {
    const project = await engineWith('M1-SPEC-r2', { body: '# Goal\n', criteria: [] });

    const { attempt, manifest } = await workOn(specTask(project, 1, 2, ['SPEC-M1@1']));

    expect(attempt.state).toBe('invalid_output');
    expect(manifest.totalTokens).toBeLessThanOrEqual(ROOM_BEFORE_M4);
    expectAllCommands(referenceOf(attempt));
    for (const ac of ids) expect(taskText('M1-SPEC-r2')).toContain(textOf(ac));
  });

  describe('the reference file', () => {
    it('leaves nothing for git to see in the worktree', async () => {
      const project = await engineWith('M1-QA-1', QA_REFUSED);
      await publishLargeDesign(e);

      const { attempt } = await workOn(qaTask(project, 1, 1, QA_PINS));

      expect(existsSync(join(attempt.worktree_path, '.aiteam-reference', 'verification.md'))).toBe(true);
      expect(await porcelain(attempt.worktree_path)).toBe('');
    });

    it('stays inside the worktree when the branch holds a symlink at its folder', async () => {
      const project = await engineWith('M1-QA-1', QA_REFUSED);
      await publishLargeDesign(e);
      const outside = tempDir();
      mkdirSync(join(outside, 'aimed-at'));
      symlinkSync(join(outside, 'aimed-at'), join(e.repoPath, '.aiteam-reference'));
      commitAll(e.repoPath, 'a link aimed outside the repository');

      const { attempt } = await workOn(qaTask(project, 1, 1, QA_PINS));

      expect(run(attempt.worktree_path, 'ls-files', '.aiteam-reference')).toContain('.aiteam-reference');
      expect(readdirSync(join(outside, 'aimed-at'))).toEqual([]);
      expect(lstatSync(join(attempt.worktree_path, '.aiteam-reference')).isSymbolicLink()).toBe(false);
      expectAllCommands(referenceOf(attempt));
      rmSync(outside, { recursive: true, force: true });
    });
  });

  describe('an Engineer', () => {
    async function ticketRun(fields: Record<string, unknown>, setup: string | null = null) {
      e = await makeEngine({ steps: { byTask: { 'H-1': okStep({ 'src/done.txt': 'done\n' }) } } });
      const project = await publishLargeSpec(e);
      if (setup !== null) await e.artifacts.commit(project, { message: 'the profile', publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Profile\n', fields: { data: { network_allow: [], setup } } }] });
      const task = await e.addTicket(ticket({ id: 'H-1', ...fields }));
      await runOnce(e, task.id);
      const [attempt] = await e.store.listAttempts(task.id);
      return { attempt: attempt!, manifest: attempt!.manifest as TaskManifest };
    }

    it('whose ticket pins the whole Spec fits the budget, and its commit leaves the reference out', async () => {
      const ran = await ticketRun({ inputs: ['SPEC-M1@1'] });

      expectRoomForM4(ran);
      const tree = run(e.repoPath, 'ls-tree', '-r', '--name-only', ran.attempt.branch);
      expect(tree).toContain('src/done.txt');
      expect(tree).not.toContain('.aiteam-reference');
    });

    it('still finds the reference after a setup that cleans the worktree', async () => {
      const { attempt } = await ticketRun({ inputs: ['SPEC-M1@1'], definition_of_done: ['test -f .aiteam-reference/verification.md'] }, 'git clean -fdx');

      expect(attempt).toMatchObject({ failure_kind: null });
    });

    it('whose ticket pins one criterion keeps its command in the manifest, and gets no reference', async () => {
      // A check runs in the worker's own worktree, before that worktree can go away.
      const { attempt } = await ticketRun({ inputs: ['SPEC-M1@1#ac-1'], definition_of_done: ['test ! -e .aiteam-reference'] });

      expect(attempt).toMatchObject({ failure_kind: null });
      expect(taskText('H-1')).toContain(`Verified by: ${command('AC-1')}`);
    });
  });
});
