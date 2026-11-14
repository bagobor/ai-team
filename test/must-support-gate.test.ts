import { applyOutput } from '../src/engine/apply/index.ts';
import { Conductor } from '../src/engine/conductor/index.ts';
import { ensureTask, mustSupportTask } from '../src/engine/conductor/tasks.ts';
import type { InboxAnswer, InboxRow } from '../src/engine/inbox.ts';
import type { MsItem } from '../src/engine/must-support.ts';
import type { ProjectRow, TaskRow } from '../src/engine/store.ts';
import type { WorkOrder } from '../src/engine/workorder.ts';
import { projectOf } from './helpers/apply.ts';
import { makeEngine, seedMustSupport, type TestEngine } from './helpers/engine.ts';
import { revParse } from './helpers/repo.ts';

const phone: MsItem = {
  id: 'MS-1',
  group: 'runs_on',
  text: 'Plays in a phone browser held upright',
  brief_quote: '',
  check: 'play',
  viewport: 'phone_portrait',
  input: 'touch',
  fits_screen: true,
  proposed: true,
  reason: 'players hold phones upright',
};
const cmd: MsItem = { id: 'MS-2', group: 'built_with', text: 'Plain JavaScript, no build step', brief_quote: 'no build step', check: 'command' };
const tablet: MsItem = { id: 'MS-3', group: 'runs_on', text: 'Plays on a tablet', brief_quote: 'tablets too', check: 'play', viewport: 'tablet', input: 'touch', fits_screen: true };

type Harness = TestEngine & { conductor: Conductor; project: ProjectRow };

const open: TestEngine[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) await e.cleanup();
});

async function harness({ prototyping = false } = {}): Promise<Harness> {
  const e = await makeEngine({ steps: [] });
  open.push(e);
  if (prototyping) await e.db.updateTable('projects').set({ prototyping: 1 }).execute();
  return Object.assign(e, { conductor: new Conductor(e, e.runner), project: await projectOf(e) });
}

const taskIds = async (h: Harness) => (await h.store.listTasks(h.project.id)).map((t) => t.ticket_id);
const byTicket = async (h: Harness, id: string): Promise<TaskRow> => {
  const task = await h.store.getTaskByTicket(h.project.id, id);
  if (!task) throw new Error(`No task ${id}. There are: ${(await taskIds(h)).join(', ')}`);
  return task;
};
const orderOf = (task: TaskRow) => task.work_order as WorkOrder;
const phaseOf = async (h: Harness) => (await h.store.getProjectById(h.project.id))!.phase;
const confirmItems = (h: Harness) => h.store.inboxByPrefix(h.project.id, 'must_support:');

async function addBrief(h: Harness): Promise<void> {
  await h.artifacts.commit(h.project, { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
}

// Takes a task to done through the real applier, as the runner would.
async function finish(h: Harness, id: string, output: unknown): Promise<void> {
  const task = await byTicket(h, id);
  for (const state of ['ready', 'running', 'checks'] as const) await h.store.setTaskState(task.id, state);
  const { id: attemptId } = await h.store.createAttempt({ task_id: task.id, adapter: 'claude', model: 'm', worktree_path: h.repoPath, branch: 'b', base_sha: await revParse(h.repoPath, 'refs/heads/main') });
  await h.store.setAttemptState(attemptId, 'running');
  await h.store.patchAttempt(attemptId, { output });
  const project = await projectOf(h);
  const result = await applyOutput({ deps: h, project, task: (await h.store.getTask(task.id))!, attempt: (await h.store.getAttempt(attemptId))!, order: orderOf(task), output, worktree: h.repoPath, signal: new AbortController().signal, report: { onEvent: () => {}, onSpawn: () => {} } });
  if (!result.ok) throw new Error(`${id} was refused: ${result.evidence}`);
  await h.artifacts.commit(project, result.change, async (s, rows) => {
    await s.setAttemptState(attemptId, 'succeeded');
    await s.setTaskState(task.id, 'done');
    await result.after?.(s, rows);
  });
}

const list = (items: MsItem[], note = 'Please confirm') => ({ items, stakeholder_note: note });

// Intake to the first confirm item: the PM wrote [phone, cmd].
async function toConfirm(h: Harness): Promise<InboxRow> {
  await addBrief(h);
  await h.conductor.tick();
  await finish(h, 'MUST-SUPPORT-PM', list([phone, cmd]));
  await h.conductor.tick();
  await h.conductor.tick();
  const items = (await confirmItems(h)).filter(({ state }) => state === 'pending');
  expect(items).toHaveLength(1);
  return items[0]!;
}

async function answer(h: Harness, item: InboxRow, reply: InboxAnswer): Promise<void> {
  await h.store.answerInbox(item.id, reply);
  await h.conductor.tick();
}

describe('the must-support confirm gate', () => {
  it('starts the PM on the list at intake and waits', async () => {
    const h = await harness();
    await addBrief(h);
    await h.conductor.tick();
    await h.conductor.tick();
    expect(await taskIds(h)).toEqual(['MUST-SUPPORT-PM']);
    expect(orderOf(await byTicket(h, 'MUST-SUPPORT-PM')).inputs).toEqual(['BRIEF@1']);
    expect(await phaseOf(h)).toBe('intake');
  });

  it('waits for a brief before anything', async () => {
    const h = await harness();
    await h.conductor.tick();
    expect(await taskIds(h)).toEqual([]);
  });

  it('raises the confirm item once', async () => {
    const h = await harness();
    const item = await toConfirm(h);
    expect(await confirmItems(h)).toHaveLength(1);
    expect(item).toMatchObject({ type: 'approval', asked_by: 'pm', title: "Confirm what the game must run on and how it's played", ref: { kind: 'must_support', version: 1 }, blocks: ['Discovery'], recommendation: 'Please confirm', options: [] });
    expect(item.evidence.map((x) => x.pin)).toEqual(['MUST-SUPPORT@1', 'BRIEF@1']);
    expect((await taskIds(h)).filter((id) => id.startsWith('MUST-SUPPORT-PM'))).toHaveLength(1);
    expect(await phaseOf(h)).toBe('intake');
  });

  it('says where each item came from', async () => {
    const h = await harness();
    const item = await toConfirm(h);
    expect(item.why).toBe(
      [
        "Before anything is built, confirm what the game must run on, how it's played and how it's built. Every prototype and milestone is checked against this list, and anything that can't be met comes back to you.",
        '',
        '- MS-1 Plays in a phone browser held upright: Not in your brief: suggested because players hold phones upright',
        '- MS-2 Plain JavaScript, no build step: From your brief: “no build step”',
      ].join('\n'),
    );
  });

  it('approving starts discovery with the list as an input', async () => {
    const h = await harness();
    await answer(h, await toConfirm(h), { action: 'approve' });
    expect(await h.artifacts.latest(h.project.id, 'MUST-SUPPORT')).toMatchObject({ version: 1, status: 'approved', approved_by: 'stakeholder' });
    expect(orderOf(await byTicket(h, 'DISCOVERY-PM')).inputs).toEqual(['BRIEF@1', 'MUST-SUPPORT@1']);
    expect(orderOf(await byTicket(h, 'DISCOVERY-TL')).inputs).toContain('MUST-SUPPORT@1');
    expect(await phaseOf(h)).toBe('discovery');
  });

  it('approving on a prototyping project starts round 1 with the list as an input', async () => {
    const h = await harness({ prototyping: true });
    const item = await toConfirm(h);
    expect(item.blocks).toEqual(['Prototyping']);
    await answer(h, item, { action: 'approve' });
    expect(orderOf(await byTicket(h, 'PROTO-PLAN-1')).inputs).toEqual(['BRIEF@1', 'MUST-SUPPORT@1']);
    expect(await phaseOf(h)).toBe('prototype');
  });

  it('request changes runs the PM again with the comment and the earlier list', async () => {
    const h = await harness();
    await answer(h, await toConfirm(h), { action: 'request_changes', comment: 'Add tablets' });
    const order = orderOf(await byTicket(h, 'MUST-SUPPORT-PM-r2'));
    expect(order.inputs).toEqual(['BRIEF@1', 'MUST-SUPPORT@1']);
    expect(order.instructions).toContain('The stakeholder asked for changes: Add tablets');
    expect(await phaseOf(h)).toBe('intake');

    // Nothing was approved yet, so the new list is still the first one.
    await finish(h, 'MUST-SUPPORT-PM-r2', list([phone, cmd, tablet]));
    await h.conductor.tick();
    const next = (await confirmItems(h)).find(({ state }) => state === 'pending')!;
    expect(next).toMatchObject({ dedupe_key: 'must_support:2', title: "Confirm what the game must run on and how it's played", ref: { kind: 'must_support', version: 2 } });
    expect(await taskIds(h)).not.toContain('DISCOVERY-PM');
  });

  it('rejecting the first list halts the project', async () => {
    const h = await harness();
    await answer(h, await toConfirm(h), { action: 'reject' });
    expect(await phaseOf(h)).toBe('halted');
  });

  describe('a revision of an approved list', () => {
    // The approved v1 and the PM's proposed v2, which adds the tablet and drops the build step.
    async function toRevision(h: Harness): Promise<InboxRow> {
      await answer(h, await toConfirm(h), { action: 'approve' });
      await h.store.atomically((s) => ensureTask(s, mustSupportTask(h.project, 2, ['BRIEF@1', 'MUST-SUPPORT@1'], 'The build step is needed')));
      await finish(h, 'MUST-SUPPORT-PM-r2', list([{ ...phone, text: 'Plays in a phone browser held upright or sideways' }, tablet], 'Changed it'));
      await h.conductor.tick();
      const items = (await confirmItems(h)).filter(({ state }) => state === 'pending');
      expect(items).toHaveLength(1);
      return items[0]!;
    }

    it('asks to confirm the change, item by item', async () => {
      const h = await harness();
      const item = await toRevision(h);
      expect(item).toMatchObject({ title: 'Confirm the change to what the game must run on', ref: { kind: 'must_support', version: 2 }, blocks: ['The next milestone'], recommendation: 'Changed it' });
      expect(item.why).toBe(
        [
          'The PM changed the list. Approve to build against the new one, or reject to keep MUST-SUPPORT@1.',
          '',
          'Added: MS-3 Plays on a tablet',
          'Removed: MS-2 Plain JavaScript, no build step',
          'Changed: MS-1 Plays in a phone browser held upright or sideways',
        ].join('\n'),
      );
      expect(item.evidence.map((x) => x.pin)).toEqual(['MUST-SUPPORT@2', 'BRIEF@1', 'MUST-SUPPORT@1']);
    });

    it('approving it builds against the new list', async () => {
      const h = await harness();
      await answer(h, await toRevision(h), { action: 'approve' });
      expect(await h.artifacts.latest(h.project.id, 'MUST-SUPPORT')).toMatchObject({ version: 2, status: 'approved', approved_by: 'stakeholder' });
    });

    it('rejecting it keeps the approved list', async () => {
      const h = await harness();
      await answer(h, await toRevision(h), { action: 'reject' });
      expect(await h.artifacts.latest(h.project.id, 'MUST-SUPPORT')).toMatchObject({ version: 3, status: 'approved', approved_by: 'stakeholder' });
      expect((await h.artifacts.read(h.project, 'MUST-SUPPORT@3')).fields.data).toEqual((await h.artifacts.read(h.project, 'MUST-SUPPORT@1')).fields.data);
      expect((await h.artifacts.read(h.project, 'MUST-SUPPORT@3')).body).toBe((await h.artifacts.read(h.project, 'MUST-SUPPORT@1')).body);
      expect(await phaseOf(h)).toBe('discovery');
      await h.conductor.tick();
      expect((await confirmItems(h)).filter(({ state }) => state === 'pending')).toEqual([]);
    });
  });

  describe('a milestone', () => {
    // An active project from before the list: milestone 1 pending, the brief at version 2, and no MUST-SUPPORT.
    async function activeWithoutList(h: Harness): Promise<void> {
      await addBrief(h);
      await addBrief(h);
      await h.artifacts.commit(h.project, {
        message: 'discovery',
        publish: [
          { id: 'ROADMAP', type: 'roadmap', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'pm', derivedFrom: [], body: '# Roadmap\n' },
          { id: 'HUMAN-REQUIREMENTS', type: 'human_requirements', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'pm', derivedFrom: [], body: '# Human requirements\n' },
        ],
      });
      for (const phase of ['discovery', 'cp1', 'active'] as const) await h.store.setProjectPhase(h.project.id, phase);
      await h.store.createMilestone({ project_id: h.project.id, n: 1, title: 'First', goal: 'The first thing', phase: 'pending' });
    }

    it('waits for the list on a project that has none', async () => {
      const h = await harness();
      await activeWithoutList(h);
      await h.conductor.tick();
      const ids = await taskIds(h);
      expect(ids).toContain('MUST-SUPPORT-PM');
      expect(ids).not.toContain('M1-SPEC');
      expect(orderOf(await byTicket(h, 'MUST-SUPPORT-PM')).inputs).toEqual(['BRIEF@2']);

      await finish(h, 'MUST-SUPPORT-PM', list([phone, cmd]));
      await h.conductor.tick();
      const item = (await confirmItems(h)).find(({ state }) => state === 'pending')!;
      expect(item.blocks).toEqual(['The next milestone']);
      expect(await taskIds(h)).not.toContain('M1-SPEC');

      await answer(h, item, { action: 'approve' });
      await h.conductor.tick();
      expect(await taskIds(h)).toContain('M1-SPEC');
    });

    it('waits while a revision is pending', async () => {
      const h = await harness();
      await activeWithoutList(h);
      await seedMustSupport(h, h.project, [phone]);
      await h.artifacts.commit(h.project, { message: 'revision', publish: [{ id: 'MUST-SUPPORT', type: 'must_support', status: 'proposed', ownerRole: 'pm', derivedFrom: ['BRIEF@2'], body: '# List\n', fields: { data: { items: [phone, tablet], used: ['MS-1', 'MS-3'] } } }] });
      await h.conductor.tick();
      expect(await taskIds(h)).not.toContain('M1-SPEC');
      expect((await confirmItems(h)).filter(({ state }) => state === 'pending')).toHaveLength(1);
    });

    it('starts at once with a seeded list', async () => {
      const h = await harness();
      await activeWithoutList(h);
      expect(await seedMustSupport(h, h.project)).toBe('MUST-SUPPORT@1');
      await h.conductor.tick();
      expect(await taskIds(h)).toEqual(['M1-SPEC']);
    });
  });
});
