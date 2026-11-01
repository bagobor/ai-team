import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { openDb } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';
import { AlreadyAnswered, InvalidAnswer, type InboxAnswer, type NewInboxItem } from '../src/engine/inbox.ts';
import { Store } from '../src/engine/store.ts';
import { EventLog } from '../src/events.ts';
import { tempDir } from './helpers/repo.ts';

describe('Inbox', () => {
  let db: Kysely<DB>;
  let log: EventLog;
  let s: Store;
  let projectId: number;

  const open = async (path: string) => {
    db = await openDb(path);
    log = new EventLog(db);
    s = new Store(db, log);
  };

  beforeEach(async () => {
    await open(':memory:');
    projectId = (await s.createProject({ name: 'p', repo_path: '/r', base_branch: 'main' })).id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  const approval = (overrides: Partial<NewInboxItem> = {}): NewInboxItem => ({
    project_id: projectId,
    milestone: 1,
    type: 'approval',
    dedupe_key: 'cp2:M1:1',
    ref: { kind: 'cp2', milestone: 1 },
    title: 'Approve the spec for milestone 1',
    asked_by: 'pm',
    why: 'The team needs locked criteria',
    blocks: ['Milestone 1 design'],
    evidence: [{ label: 'Spec', value: 'SPEC-M1 v1', pin: 'SPEC-M1@1' }],
    recommendation: 'Approve it',
    options: [],
    ...overrides,
  });
  const question = (overrides: Partial<NewInboxItem> = {}): NewInboxItem =>
    approval({
      type: 'question',
      dedupe_key: 'escalation:7',
      ref: { kind: 'escalation', taskId: 7 },
      title: 'M1-T-1 is stuck',
      options: [
        { id: 'retry', label: 'Retry' },
        { id: 'cancel', label: 'Cancel' },
      ],
      ...overrides,
    });
  const eventsOf = async (type: string) => (await log.list({ projectId })).filter((event) => event.type === type);

  describe('raising', () => {
    it('keeps who asks, why, what it blocks, the evidence and the recommendation', async () => {
      const item = await s.raiseInbox(approval());
      expect(item).toMatchObject({
        project_id: projectId,
        milestone: 1,
        type: 'approval',
        state: 'pending',
        ref: { kind: 'cp2', milestone: 1 },
        asked_by: 'pm',
        why: 'The team needs locked criteria',
        blocks: ['Milestone 1 design'],
        evidence: [{ label: 'Spec', value: 'SPEC-M1 v1', pin: 'SPEC-M1@1' }],
        recommendation: 'Approve it',
        options: [],
        answer: null,
        answered_at: null,
        applied_at: null,
      });
      expect(Date.parse(item.created_at)).not.toBeNaN();
    });

    it('raises once per dedupe key', async () => {
      const first = await s.raiseInbox(approval());
      const second = await s.raiseInbox(approval({ title: 'A different title' }));
      expect(second).toEqual(first);
      expect(await s.listInbox({ projectId })).toHaveLength(1);
      expect(await eventsOf('inbox.raised')).toHaveLength(1);
    });

    it('returns a closed item rather than raising it again', async () => {
      const first = await s.raiseInbox(approval());
      await s.answerInbox(first.id, { action: 'approve' });
      const again = await s.raiseInbox(approval());
      expect(again.id).toBe(first.id);
      expect(again.state).toBe('answered');
      expect(await s.pendingInboxCount()).toBe(0);
    });

    it('keeps the dedupe key per project', async () => {
      const other = await s.createProject({ name: 'q', repo_path: '/q', base_branch: 'main' });
      const mine = await s.raiseInbox(approval());
      const theirs = await s.raiseInbox(approval({ project_id: other.id }));
      expect(theirs.id).not.toBe(mine.id);
    });

    it('logs the raise under the project with its title', async () => {
      await s.raiseInbox(approval());
      expect((await eventsOf('inbox.raised'))[0]?.payload).toEqual({ title: 'Approve the spec for milestone 1' });
    });

    it('takes an item with no milestone', async () => {
      const { milestone: _milestone, ...withoutMilestone } = approval({ dedupe_key: 'engine_error', ref: { kind: 'engine_error' } });
      expect((await s.raiseInbox(withoutMilestone)).milestone).toBeNull();
    });
  });

  describe('answering', () => {
    it('lets the first answer win and refuses the second', async () => {
      const item = await s.raiseInbox(approval());
      await s.answerInbox(item.id, { action: 'approve' });
      await expect(s.answerInbox(item.id, { action: 'reject' })).rejects.toBeInstanceOf(AlreadyAnswered);
      expect((await s.getInbox(item.id))?.answer).toEqual({ action: 'approve' });
      expect(await eventsOf('inbox.answered')).toHaveLength(1);
    });

    it('lets exactly one of two concurrent answers through', async () => {
      const { id } = await s.raiseInbox(approval());
      const results = await Promise.allSettled([s.answerInbox(id, { action: 'approve' }), s.answerInbox(id, { action: 'reject' })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected');
      expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyAnswered);
      expect(await eventsOf('inbox.answered')).toHaveLength(1);
    });

    it('records the answer and when, and applies nothing', async () => {
      const item = await s.raiseInbox(approval());
      const answered = await s.answerInbox(item.id, { action: 'request_changes', comment: 'Tighten AC-2' });
      expect(answered).toMatchObject({ state: 'answered', answer: { action: 'request_changes', comment: 'Tighten AC-2' }, applied_at: null });
      expect(Date.parse(answered.answered_at as string)).not.toBeNaN();
    });

    it.each(['', '   \n\t'])('refuses Request changes with the empty comment %j', async (comment) => {
      const item = await s.raiseInbox(approval());
      await expect(s.answerInbox(item.id, { action: 'request_changes', comment })).rejects.toBeInstanceOf(InvalidAnswer);
      expect((await s.getInbox(item.id))?.state).toBe('pending');
    });

    it.each<[InboxAnswer, 'approval' | 'question']>([
      [{ option: 'retry' }, 'approval'],
      [{ text: 'Do it' }, 'approval'],
      [{ action: 'approve' }, 'question'],
      [{ action: 'reject' }, 'question'],
      [{ action: 'request_changes', comment: 'No' }, 'question'],
    ])('refuses %o on an %s', async (answer, type) => {
      const item = await s.raiseInbox(type === 'approval' ? approval() : question());
      await expect(s.answerInbox(item.id, answer)).rejects.toBeInstanceOf(InvalidAnswer);
      expect((await s.getInbox(item.id))?.state).toBe('pending');
    });

    it('refuses an option the item does not offer', async () => {
      const item = await s.raiseInbox(question());
      await expect(s.answerInbox(item.id, { option: 'halt' })).rejects.toBeInstanceOf(InvalidAnswer);
    });

    it('takes an option the item offers', async () => {
      const item = await s.raiseInbox(question());
      expect((await s.answerInbox(item.id, { option: 'cancel' })).answer).toEqual({ option: 'cancel' });
    });

    it('takes a written answer to a question, but not a blank one', async () => {
      const item = await s.raiseInbox(question());
      await expect(s.answerInbox(item.id, { text: '  ' })).rejects.toBeInstanceOf(InvalidAnswer);
      expect((await s.answerInbox(item.id, { text: 'Retry it tomorrow' })).answer).toEqual({ text: 'Retry it tomorrow' });
    });

    it('refuses an answer shape it has never heard of', async () => {
      const item = await s.raiseInbox(approval());
      await expect(s.answerInbox(item.id, { action: 'merge' } as unknown as InboxAnswer)).rejects.toBeInstanceOf(InvalidAnswer);
    });

    it('refuses to answer a withdrawn item', async () => {
      const item = await s.raiseInbox(approval());
      await s.withdrawInbox(item.id, 'The spec moved on');
      await expect(s.answerInbox(item.id, { action: 'approve' })).rejects.toBeInstanceOf(AlreadyAnswered);
      expect((await s.getInbox(item.id))?.answer).toBeNull();
    });

    it('refuses to answer an item that does not exist', async () => {
      await expect(s.answerInbox(999, { action: 'approve' })).rejects.toBeInstanceOf(AlreadyAnswered);
    });
  });

  describe('withdrawing', () => {
    it('withdraws a pending item and logs why', async () => {
      const item = await s.raiseInbox(approval());
      await s.withdrawInbox(item.id, 'The spec moved on');
      expect((await s.getInbox(item.id))?.state).toBe('withdrawn');
      expect((await eventsOf('inbox.withdrawn'))[0]?.payload).toEqual({ reason: 'The spec moved on' });
    });

    it('leaves an answered item as it was', async () => {
      const item = await s.raiseInbox(approval());
      await s.answerInbox(item.id, { action: 'approve' });
      await s.withdrawInbox(item.id, 'Too late');
      expect(await s.getInbox(item.id)).toMatchObject({ state: 'answered', answer: { action: 'approve' } });
      expect(await eventsOf('inbox.withdrawn')).toEqual([]);
    });
  });

  describe('applying', () => {
    it('lists answered but unapplied items for the conductor', async () => {
      const unanswered = await s.raiseInbox(approval({ dedupe_key: 'a' }));
      const answered = await s.raiseInbox(approval({ dedupe_key: 'b' }));
      const applied = await s.raiseInbox(approval({ dedupe_key: 'c' }));
      const withdrawn = await s.raiseInbox(approval({ dedupe_key: 'd' }));
      await s.answerInbox(answered.id, { action: 'approve' });
      await s.answerInbox(applied.id, { action: 'reject' });
      await s.markInboxApplied(applied.id);
      await s.withdrawInbox(withdrawn.id, 'gone');

      expect((await s.listUnappliedAnswers()).map(({ id }) => id)).toEqual([answered.id]);
      expect(unanswered.state).toBe('pending');
    });

    it('applies once and logs once', async () => {
      const item = await s.raiseInbox(approval());
      await s.answerInbox(item.id, { action: 'approve' });
      await s.markInboxApplied(item.id);
      const first = (await s.getInbox(item.id))?.applied_at;
      await s.markInboxApplied(item.id);
      expect(Date.parse(first as string)).not.toBeNaN();
      expect((await s.getInbox(item.id))?.applied_at).toBe(first);
      expect(await eventsOf('inbox.applied')).toHaveLength(1);
    });

    it('does not mark an unanswered item applied', async () => {
      const item = await s.raiseInbox(approval());
      await s.markInboxApplied(item.id);
      expect((await s.getInbox(item.id))?.applied_at).toBeNull();
    });

    it('rolls back with the transaction it is part of', async () => {
      const item = await s.raiseInbox(approval());
      await s.answerInbox(item.id, { action: 'approve' });
      await expect(
        s.atomically(async (t) => {
          await t.markInboxApplied(item.id);
          throw new Error('the apply failed');
        }),
      ).rejects.toThrow('the apply failed');
      expect((await s.getInbox(item.id))?.applied_at).toBeNull();
      expect((await s.listUnappliedAnswers()).map(({ id }) => id)).toEqual([item.id]);
    });
  });

  describe('reading', () => {
    it('does not count withdrawn or answered items in the badge', async () => {
      const other = await s.createProject({ name: 'q', repo_path: '/q', base_branch: 'main' });
      await s.raiseInbox(approval({ dedupe_key: 'a' }));
      await s.raiseInbox(approval({ project_id: other.id, dedupe_key: 'b' }));
      await s.answerInbox((await s.raiseInbox(approval({ dedupe_key: 'c' }))).id, { action: 'approve' });
      await s.withdrawInbox((await s.raiseInbox(approval({ dedupe_key: 'd' }))).id, 'gone');
      expect(await s.pendingInboxCount()).toBe(2);
    });

    it('filters by project and by state', async () => {
      const other = await s.createProject({ name: 'q', repo_path: '/q', base_branch: 'main' });
      const a = await s.raiseInbox(approval({ dedupe_key: 'a' }));
      const b = await s.raiseInbox(approval({ dedupe_key: 'b' }));
      const c = await s.raiseInbox(approval({ project_id: other.id, dedupe_key: 'c' }));
      await s.answerInbox(b.id, { action: 'approve' });

      expect((await s.listInbox({ projectId })).map(({ id }) => id)).toEqual([a.id, b.id]);
      expect((await s.listInbox({ state: 'pending' })).map(({ id }) => id)).toEqual([a.id, c.id]);
      expect((await s.listInbox({ projectId, state: 'answered' })).map(({ id }) => id)).toEqual([b.id]);
      expect((await s.listInbox({})).map(({ id }) => id)).toEqual([a.id, b.id, c.id]);
    });

    it('finds items by the start of their key, with no wildcards in it', async () => {
      const m1 = await s.raiseInbox(approval({ dedupe_key: 'cp4:M1:1' }));
      await s.raiseInbox(approval({ dedupe_key: 'cp4:M10:1' }));
      await s.raiseInbox(approval({ dedupe_key: 'cr:1' }));
      expect((await s.inboxByPrefix(projectId, 'cp4:M1:')).map(({ id }) => id)).toEqual([m1.id]);
      expect(await s.inboxByPrefix(projectId, 'cp4_M1%')).toEqual([]);
    });

    it('returns nothing for an unknown item', async () => {
      expect(await s.getInbox(999)).toBeUndefined();
    });
  });

  it('keeps pending items exactly as they were across a reopen of the database', async () => {
    await db.destroy();
    const path = join(tempDir('inbox-'), 'state.db');
    await open(path);
    projectId = (await s.createProject({ name: 'p', repo_path: '/r', base_branch: 'main' })).id;
    const before = await s.raiseInbox(question());
    await db.destroy();

    await open(path);

    expect(await s.getInbox(before.id)).toEqual(before);
    expect(await s.pendingInboxCount()).toBe(1);
    expect((await s.answerInbox(before.id, { option: 'retry' })).state).toBe('answered');
  });
});
