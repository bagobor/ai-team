import { gapProblems, gapScope } from '../src/engine/apply/gaps.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import { Conductor } from '../src/engine/conductor/index.ts';
import type { InboxAnswer, InboxRow } from '../src/engine/inbox.ts';
import type { MsItem } from '../src/engine/must-support.ts';
import type { ProjectRow } from '../src/engine/store.ts';
import type { WorkOrder } from '../src/engine/workorder.ts';
import { apply, CRITERIA, ctxFor, evidenceOf, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, seedMustSupport, type TestEngine } from './helpers/engine.ts';

const phone: MsItem = { id: 'MS-1', group: 'runs_on', text: 'Plays in a phone browser held upright', brief_quote: 'It should work on my phone', check: 'play', viewport: 'phone_portrait', input: 'touch', fits_screen: true };
const cmd: MsItem = { id: 'MS-2', group: 'built_with', text: 'Has no build step', brief_quote: '', check: 'command', proposed: true, reason: 'a page that opens as it is can be played anywhere' };

const SPEC = { body: '# Milestone two\n', criteria: CRITERIA, stakeholder_note: 'Note' };
const PLAN = {
  hypotheses: [{ id: 'H-1', element: 'Dodging', rationale: 'Near misses feel good', look_for: 'Leaning in' }],
  prototypes: [{ key: 'P-1', title: 'Rocks', hypotheses: ['H-1'], build: 'One ship and falling rocks.', controls: ['ArrowLeft'] }],
  stakeholder_note: 'Please play it',
};
const GAP = { item: 'MS-1', why: 'The map needs a wide screen' };

describe('must-support gaps', () => {
  let e: TestEngine;
  let project: ProjectRow;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    project = await projectOf(e);
    await e.artifacts.commit(project, { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', approvedBy: 'stakeholder', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
  });

  afterEach(() => e.cleanup());

  const spec = (gaps: unknown[], milestone = 2) => apply(e, 'milestone_spec', { ...SPEC, gaps }, { milestone, ticketId: `M${milestone}-SPEC`, role: 'pm', inputs: ['MUST-SUPPORT@1'] });
  const gapItems = () => e.store.inboxByPrefix(project.id, 'ms_gap:');
  const raised = async (): Promise<InboxRow> => {
    await publish(e, await spec([GAP]));
    return (await gapItems())[0]!;
  };
  const answer = async (item: InboxRow, reply: InboxAnswer) => {
    await e.store.answerInbox(item.id, reply);
    await new Conductor(e, e.runner).tick();
  };
  const waived = (item: InboxRow) => ({ item_id: 'MS-1', status: 'waived', evidence: `DEC-${item.id}@1`, source: 'stakeholder', must_support_version: 1 });
  const revision = async () => (await e.store.getTaskByTicket(project.id, 'MUST-SUPPORT-PM'))!;

  describe('with a confirmed list', () => {
    beforeEach(async () => {
      await seedMustSupport(e, project, [phone, cmd]);
    });

    it('a gap in a milestone spec raises a question with three options', async () => {
      const gap = await raised();

      expect(gap).toMatchObject({
        type: 'question',
        state: 'pending',
        dedupe_key: 'ms_gap:milestone:2:MS-1',
        ref: { kind: 'ms_gap', item: 'MS-1', scope: 'milestone', n: 2 },
        title: "Milestone 2 can't meet: Plays in a phone browser held upright",
        asked_by: 'pm',
        blocks: [],
        evidence: [{ label: 'MUST-SUPPORT', value: 'MUST-SUPPORT@1', pin: 'MUST-SUPPORT@1' }],
      });
      expect(gap.why).toBe("M2-SPEC says this can't be done: The map needs a wide screen\n\nThe item: MS-1 Plays in a phone browser held upright: From your brief: “It should work on my phone”");
      expect(gap.options).toEqual([
        { id: 'milestone', label: 'Accept it for this milestone' },
        { id: 'for_good', label: 'Accept it for good' },
        { id: 'change', label: 'Change the requirement' },
      ]);
      // The spec itself is published all the same: the milestone goes on while the stakeholder decides.
      expect(await e.artifacts.latest(project.id, 'SPEC-M2')).toMatchObject({ version: 1, status: 'proposed' });
    });

    it('says when the item was the PM\'s own suggestion', async () => {
      await publish(e, await spec([{ item: 'MS-2', why: 'The physics library ships as modules that need bundling' }]));

      expect((await gapItems())[0]!.why).toContain('The item: MS-2 Has no build step: Not in your brief: suggested because a page that opens as it is can be played anywhere');
    });

    it('a gap naming an item not on the list is sent back', async () => {
      const evidence = evidenceOf(await spec([{ item: 'MS-9', why: 'x' }, GAP, GAP]));

      expect(evidence).toContain('- MS-9 is not on the must-support list (MUST-SUPPORT@1): name an item from it');
      expect(evidence).toContain('- MS-1 appears in gaps twice');
      expect(evidence).toMatch(/^These gaps could not be raised\./);
      expect(await gapItems()).toEqual([]);
    });

    it('a last attempt keeps its work and the gaps that can be raised, and logs the rest', async () => {
      const ctx = await ctxFor(e, 'milestone_spec', { ...SPEC, gaps: [{ item: 'MS-9', why: 'x' }, GAP] }, { milestone: 2, ticketId: 'M2-SPEC', role: 'pm' });
      for (let i = 1; i < e.config.maxAttempts; i += 1) {
        const earlier = await e.store.createAttempt({ task_id: ctx.task.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: `b${i}` });
        await e.store.setAttemptState(earlier.id, 'running');
        await e.store.setAttemptState(earlier.id, 'invalid_output', { failure_kind: 'invalid_output', failure_evidence: 'A bad gap' });
      }

      await publish(e, await applyOutput(ctx));

      expect((await gapItems()).map(({ dedupe_key }) => dedupe_key)).toEqual(['ms_gap:milestone:2:MS-1']);
      const dropped = (await e.log.list({ projectId: project.id })).filter(({ type }) => type === 'must_support.gap_dropped');
      expect(dropped.map(({ payload }) => payload.reason)).toEqual(['MS-9 is not on the must-support list (MUST-SUPPORT@1): name an item from it']);
    });

    it("a gap in a round's plan is scoped to the round", async () => {
      await publish(e, await apply(e, 'prototype_plan', { ...PLAN, gaps: [GAP] }, { milestone: 0, ticketId: 'PROTO-PLAN-1', role: 'pm', inputs: ['BRIEF@1', 'MUST-SUPPORT@1'] }));

      const [gap] = await gapItems();
      expect(gap).toMatchObject({ dedupe_key: 'ms_gap:prototype:1:MS-1', ref: { kind: 'ms_gap', item: 'MS-1', scope: 'prototype', n: 1 }, title: "Prototype round 1 can't meet: Plays in a phone browser held upright", blocks: ['Prototype round 1'] });
      expect(gap!.options.map(({ label }) => label)).toEqual(['Accept it for this round', 'Accept it for good', 'Change the requirement']);
    });

    it('accepting for this milestone waives the item for that milestone only', async () => {
      const gap = await raised();
      await answer(gap, { option: 'milestone' });

      expect(await e.store.listMustSupport(project.id, { scope: 'milestone', n: 2 })).toMatchObject([waived(gap)]);
      expect(await e.store.listMustSupport(project.id, { scope: 'milestone', n: 3 })).toEqual([]);
      expect(await e.store.listMustSupport(project.id, { scope: 'project', n: 0 })).toEqual([]);
      expect(await e.store.getTaskByTicket(project.id, 'MUST-SUPPORT-PM')).toBeUndefined();
    });

    it('accepting for good waives it at project scope, and no later milestone asks again', async () => {
      const gap = await raised();
      await answer(gap, { option: 'for_good' });

      expect(await e.store.listMustSupport(project.id, { scope: 'project', n: 0 })).toMatchObject([waived(gap)]);
      expect(await e.store.listMustSupport(project.id, { scope: 'milestone', n: 2 })).toEqual([]);

      await publish(e, await spec([GAP], 3));
      expect(await gapItems()).toHaveLength(1);
    });

    it('changing the requirement runs the PM on a revision', async () => {
      await answer(await raised(), { option: 'change' });

      const order = (await revision()).work_order as WorkOrder;
      expect(order.inputs).toEqual(['BRIEF@1', 'MUST-SUPPORT@1']);
      expect(order.instructions).toContain("The stakeholder asked for changes: M2-SPEC says MS-1 can't be met: The map needs a wide screen.");
      expect(order.instructions).not.toContain('The stakeholder wrote');
      expect(await e.store.listMustSupport(project.id, { scope: 'milestone', n: 2 })).toEqual([]);
    });

    it('a written answer asks for the change in the stakeholder\'s words', async () => {
      const gap = await raised();
      await answer(gap, { text: 'Drop phones, tablets are enough' });

      expect(((await revision()).work_order as WorkOrder).instructions).toContain("M2-SPEC says MS-1 can't be met: The map needs a wide screen. The stakeholder wrote: Drop phones, tablets are enough");
      expect((await e.artifacts.read(project, `DEC-${gap.id}`)).body).toContain('Decision: Change the requirement');
    });

    it('replaying the output raises the gap once', async () => {
      const result = await spec([GAP]);
      await publish(e, result);
      await publish(e, result);

      expect(await gapItems()).toHaveLength(1);
    });
  });

  it('a gap with no confirmed list to raise it against is sent back', async () => {
    expect(evidenceOf(await spec([GAP]))).toContain('- There is no confirmed must-support list yet, so there is nothing to raise a gap against');
  });

  it('gives a gap the scope of the task that raised it', () => {
    expect(gapScope({ ticket_id: 'DISCOVERY-TL', milestone: 0 })).toEqual({ scope: 'milestone', n: 1 });
    expect(gapScope({ ticket_id: 'PROTO-PLAN-2', milestone: 0 })).toEqual({ scope: 'prototype', n: 2 });
    expect(gapScope({ ticket_id: 'M3-TECH', milestone: 3 })).toEqual({ scope: 'milestone', n: 3 });
  });

  it('accepts a gap for each item on the list, once', () => {
    expect(gapProblems([GAP, { item: 'MS-2', why: 'y' }], [phone, cmd], 'MUST-SUPPORT@4')).toEqual([]);
  });
});
