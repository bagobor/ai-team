import { checkCommandProblems, missingChecks, type ProfileData } from '../src/engine/apply/discovery.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import { Conductor } from '../src/engine/conductor/index.ts';
import type { MsItem } from '../src/engine/must-support.ts';
import { protectedPaths } from '../src/engine/protected.ts';
import type { ProjectRow, TaskRow } from '../src/engine/store.ts';
import type { WorkOrder } from '../src/engine/workorder.ts';
import { apply, evidenceOf, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, seedMustSupport, type TestEngine } from './helpers/engine.ts';
import { commitAll, revParse, tempDir } from './helpers/repo.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const phone: MsItem = { id: 'MS-1', group: 'runs_on', text: 'Plays in a phone browser held upright', brief_quote: 'On my phone', check: 'play', viewport: 'phone_portrait', input: 'touch', fits_screen: true };
const cmd: MsItem = { id: 'MS-2', group: 'built_with', text: 'Has no build step', brief_quote: 'No build step', check: 'command' };
const offline: MsItem = { id: 'MS-3', group: 'built_with', text: 'Fetches nothing at run time', brief_quote: 'Works offline', check: 'command' };

const DATA: ProfileData = { commands: { build: 'true', test: 'true', lint: 'true', smoke: 'echo smoke-ok' }, toolchains: ['node 22'], network_allow: [], setup: null, play: null };
const PROFILE = { ...DATA, body: '# Environment\n\nNothing to install.\n', stakeholder_note: 'Note' };
const check = (item = 'MS-2', overrides: Partial<{ command: string; protected: string[] }> = {}) => ({ item, command: 'test ! -f package.json', protected: [], ...overrides });

describe('checkCommandProblems', () => {
  it('asks for a command for every item checked by command', () => {
    expect(checkCommandProblems(undefined, [phone, cmd, offline], [], 'main')).toEqual(['must_support_checks has no command for MS-2 (Has no build step)', 'must_support_checks has no command for MS-3 (Fetches nothing at run time)']);
    expect(checkCommandProblems([check(), check('MS-3')], [phone, cmd, offline], [], 'main')).toEqual([]);
    expect(checkCommandProblems(undefined, [phone], [], 'main')).toEqual([]);
  });

  it('refuses a check for an item that is not checked by command, an empty command, and a second command', () => {
    expect(checkCommandProblems([check('MS-1'), check('MS-9'), check('MS-2', { command: ' \n' }), check()], [phone, cmd], [], 'main')).toEqual([
      'must_support_checks names MS-1, which is not checked by command',
      'must_support_checks names MS-9, which is not checked by command',
      "MS-2's command is empty",
      'must_support_checks names MS-2 twice',
    ]);
  });

  it('a protected glob that matches nothing is refused', () => {
    expect(checkCommandProblems([check('MS-2', { protected: ['scripts/nope.sh'] })], [cmd], ['index.html'], 'main')).toEqual(['scripts/nope.sh matches no file on main: protect only files the command reads']);
    expect(checkCommandProblems([check('MS-2', { protected: ['scripts/*.sh', '.checks/**'] })], [cmd], ['scripts/check-no-build.sh', '.checks/a/b.txt'], 'main')).toEqual([]);
  });

  it('holds a protected glob to the rules a Test Plan\'s are held to', () => {
    expect(checkCommandProblems([check('MS-2', { protected: ['**'] })], [cmd], ['index.html'], 'main')).toEqual(['protected: "**" covers the whole repository']);
  });
});

describe('missingChecks', () => {
  it('names the command items the profile has no check for', () => {
    expect(missingChecks(DATA, [phone, cmd, offline])).toEqual(['MS-2', 'MS-3']);
    expect(missingChecks({ ...DATA, must_support_checks: [check()] }, [phone, cmd, offline])).toEqual(['MS-3']);
    expect(missingChecks({ ...DATA, must_support_checks: [check(), check('MS-3')] }, [phone, cmd, offline])).toEqual([]);
    expect(missingChecks(DATA, [phone])).toEqual([]);
  });
});

describe('must-support command checks', () => {
  let e: TestEngine;
  let project: ProjectRow;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    project = await projectOf(e);
    await e.artifacts.commit(project, { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
  });

  afterEach(() => e.cleanup());

  const profile = (output: Record<string, unknown> = {}) => apply(e, 'environment_profile', { ...PROFILE, ...output }, { worktree: tempDir(), role: 'tech_lead', milestone: 0, inputs: ['BRIEF@1', 'MUST-SUPPORT@1'] });
  const approvedProfile = (data: ProfileData = DATA) =>
    e.artifacts.commit(project, { message: 'profile', publish: [{ id: 'ENV-PROFILE', type: 'environment_profile', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'tech_lead', derivedFrom: ['BRIEF@1'], body: PROFILE.body, fields: { data } }] });
  const latestProfile = async () => (await e.artifacts.latest(project.id, 'ENV-PROFILE'))!;

  describe('in the Environment Profile', () => {
    it('a profile missing a check for a command item is sent back', async () => {
      await seedMustSupport(e, project, [phone, cmd]);

      expect(evidenceOf(await profile())).toBe('must_support_checks has no command for MS-2 (Has no build step)');
    });

    it('a profile with a check for every command item keeps them, and shows them', async () => {
      await seedMustSupport(e, project, [phone, cmd]);
      mkdirSync(join(e.repoPath, 'scripts'));
      writeFileSync(join(e.repoPath, 'scripts', 'check-no-build.sh'), 'test ! -f package.json\n');
      commitAll(e.repoPath, 'a check script');
      const checks = [check('MS-2', { command: 'sh scripts/check-no-build.sh', protected: ['scripts/check-no-build.sh'] })];

      await publish(e, await profile({ must_support_checks: checks }));

      const doc = await e.artifacts.read(project, 'ENV-PROFILE');
      expect((doc.fields.data as ProfileData).must_support_checks).toEqual(checks);
      expect(doc.body).toBe('# Environment\n\nNothing to install.\n\n## Must-support checks\n\n- MS-2: `sh scripts/check-no-build.sh` (protects scripts/check-no-build.sh)\n');
    });

    it('a protected glob must match a file on the base branch', async () => {
      await seedMustSupport(e, project, [cmd]);

      expect(evidenceOf(await profile({ must_support_checks: [check('MS-2', { protected: ['scripts/nope.sh'] })] }))).toBe('scripts/nope.sh matches no file on main: protect only files the command reads');
    });

    it('a list with nothing checked by command asks nothing of the profile', async () => {
      await seedMustSupport(e, project, [phone]);

      await publish(e, await profile());

      const doc = await e.artifacts.read(project, 'ENV-PROFILE');
      expect(doc.body).toBe(PROFILE.body);
      expect(doc.fields.data).toEqual(DATA);
    });
  });

  it("the checks' files are protected in every milestone, prototypes too", async () => {
    await approvedProfile({ ...DATA, must_support_checks: [check('MS-2', { protected: ['scripts/check-no-build.sh'] }), check('MS-3', { protected: [] })] });

    for (const m of [0, 2]) expect(await protectedPaths(e, project, m)).toEqual([{ glob: 'scripts/check-no-build.sh', source: 'ENV-PROFILE' }]);
  });

  describe('before a milestone', () => {
    const conductor = () => new Conductor(e, e.runner);
    const taskIds = async () => (await e.store.listTasks(project.id)).map((t) => t.ticket_id);
    const byTicket = async (id: string): Promise<TaskRow> => (await e.store.getTaskByTicket(project.id, id))!;

    // An active project at its first milestone: discovery approved, the list confirmed, the profile as given.
    async function pendingMilestone(items: MsItem[], data: ProfileData): Promise<void> {
      await seedMustSupport(e, project, items);
      await approvedProfile(data);
      await e.artifacts.commit(project, {
        message: 'discovery',
        publish: [
          { id: 'ROADMAP', type: 'roadmap', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'pm', derivedFrom: [], body: '# Roadmap\n' },
          { id: 'HUMAN-REQUIREMENTS', type: 'human_requirements', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'pm', derivedFrom: [], body: '# Human requirements\n' },
        ],
      });
      for (const phase of ['discovery', 'cp1', 'active'] as const) await e.store.setProjectPhase(project.id, phase);
      await e.store.createMilestone({ project_id: project.id, n: 1, title: 'First', goal: 'The first thing', phase: 'pending' });
    }

    // Takes a task to done through the real applier, as the runner would.
    async function finish(id: string, output: unknown): Promise<void> {
      const task = await byTicket(id);
      for (const state of ['ready', 'running', 'checks'] as const) await e.store.setTaskState(task.id, state);
      const { id: attemptId } = await e.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: 'b', base_sha: await revParse(e.repoPath, 'refs/heads/main') });
      await e.store.setAttemptState(attemptId, 'running');
      await e.store.patchAttempt(attemptId, { output });
      const result = await applyOutput({ deps: e, project, task: (await e.store.getTask(task.id))!, attempt: (await e.store.getAttempt(attemptId))!, order: task.work_order as WorkOrder, output, worktree: e.repoPath, signal: new AbortController().signal, report: { onEvent: () => {}, onSpawn: () => {} } });
      if (!result.ok) throw new Error(`${id} was refused: ${result.evidence}`);
      await e.artifacts.commit(project, result.change, async (s, rows) => {
        await s.setAttemptState(attemptId, 'succeeded');
        await s.setTaskState(task.id, 'done');
        await result.after?.(s, rows);
      });
    }

    it('a milestone on a project whose profile lacks checks waits for the Tech Lead', async () => {
      await pendingMilestone([phone, cmd], DATA);
      await conductor().tick();
      await conductor().tick();

      expect(await taskIds()).toEqual(['MS-CHECKS-TL']);
      const task = await byTicket('MS-CHECKS-TL');
      expect(task).toMatchObject({ role_id: 'tech_lead', milestone: 0, kind: 'authoring', purpose: 'must_support_checks' });
      expect((task.work_order as WorkOrder).inputs).toEqual(['ENV-PROFILE@1', 'MUST-SUPPORT@1']);
      expect((task.work_order as WorkOrder).instructions).toContain('MS-2 (Has no build step)');

      await finish('MS-CHECKS-TL', { must_support_checks: [check()], stakeholder_note: 'One check' });

      const row = await latestProfile();
      expect(row).toMatchObject({ version: 2, status: 'approved', approved_by: 'stakeholder', owner_role: 'tech_lead', derived_from: ['BRIEF@1', 'MUST-SUPPORT@1'] });
      const doc = await e.artifacts.read(project, 'ENV-PROFILE');
      expect(doc.fields.data).toEqual({ ...DATA, must_support_checks: [check()] });
      expect(doc.body).toBe('# Environment\n\nNothing to install.\n\n## Must-support checks\n\n- MS-2: `test ! -f package.json`\n');

      await conductor().tick();
      expect(await taskIds()).toEqual(['MS-CHECKS-TL', 'M1-SPEC']);
    });

    it('the Tech Lead is sent back for a command item it leaves out', async () => {
      await pendingMilestone([cmd, offline], DATA);
      await conductor().tick();

      await expect(finish('MS-CHECKS-TL', { must_support_checks: [check()], stakeholder_note: 'One check' })).rejects.toThrow('must_support_checks has no command for MS-3 (Fetches nothing at run time)');
    });

    it('a list that gains a command item asks the Tech Lead again, and the new checks replace the old section', async () => {
      await pendingMilestone([cmd], DATA);
      await conductor().tick();
      await finish('MS-CHECKS-TL', { must_support_checks: [check()], stakeholder_note: 'One check' });
      await seedMustSupport(e, project, [cmd, offline]);
      await conductor().tick();

      expect(await taskIds()).toEqual(['MS-CHECKS-TL', 'MS-CHECKS-TL-r2']);
      await finish('MS-CHECKS-TL-r2', { must_support_checks: [check(), check('MS-3', { command: 'sh no-fetch.sh' })], stakeholder_note: 'Two checks' });

      expect((await e.artifacts.read(project, 'ENV-PROFILE')).body).toBe('# Environment\n\nNothing to install.\n\n## Must-support checks\n\n- MS-2: `test ! -f package.json`\n- MS-3: `sh no-fetch.sh`\n');
      await conductor().tick();
      expect(await taskIds()).toContain('M1-SPEC');
    });

    it('a profile with every check starts the milestone at once', async () => {
      await pendingMilestone([phone, cmd], { ...DATA, must_support_checks: [check()] });
      await conductor().tick();

      expect(await taskIds()).toEqual(['M1-SPEC']);
    });
  });
});
