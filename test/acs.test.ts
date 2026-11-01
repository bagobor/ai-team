import { sql, type Kysely } from 'kysely';
import { AC_ID, type Criterion } from '../src/artifacts/acs.ts';
import { openDb } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';
import { Store, type NewTask, type ProjectRow, type TaskRow } from '../src/engine/store.ts';
import { EventLog } from '../src/events.ts';

const criterion = (n: number, text = `Criterion ${n}`): Criterion => ({ id: `AC-${n}`, text, verification: { method: 'automated', how: `npm test -- ac${n}` } });

describe('acceptance-criteria registry', () => {
  let db: Kysely<DB>;
  let log: EventLog;
  let s: Store;
  let p: ProjectRow;
  let ticketTask: TaskRow;
  let qaTask: TaskRow;

  const task = (ticket_id: string, kind: string): NewTask => ({
    project_id: p.id,
    ticket_id,
    title: ticket_id,
    milestone: 1,
    role_id: 'engineer',
    ticket_path: `tickets/${ticket_id}.md`,
    ticket_sha: 'abc',
    touches: [],
    depends_on: [],
    dod: [],
    kind,
  });
  const verified = (status: 'passing' | 'failing' = 'passing', taskId = qaTask.id, evidenceRef = 'QA-REPORT-M1-1@1#ac-1') => ({
    status,
    evidenceRef,
    verifiedBy: { kind: 'qa_verify' as const, taskId },
  });

  beforeEach(async () => {
    db = await openDb(':memory:');
    log = new EventLog(db);
    s = new Store(db, log);
    p = await s.createProject({ name: 'p', repo_path: '/r', base_branch: 'main' });
    ticketTask = await s.createTask(task('T-1', 'ticket'));
    qaTask = await s.createTask(task('QA-1', 'qa_verify'));
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('locks criteria at unverified', async () => {
    await s.lockCriteria(p.id, 1, 3, [criterion(1), criterion(2)]);

    expect(await s.listCriteria(p.id, 1)).toMatchObject([
      { ac_id: 'AC-1', text: 'Criterion 1', status: 'unverified', evidence_ref: null, spec_version: 3, verification: { method: 'automated', how: 'npm test -- ac1' } },
      { ac_id: 'AC-2', text: 'Criterion 2', status: 'unverified', evidence_ref: null, spec_version: 3 },
    ]);
  });

  it('refuses to lock the same milestone twice', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);

    await expect(s.lockCriteria(p.id, 1, 2, [criterion(2)])).rejects.toThrow(/already locked/);
    expect((await s.listCriteria(p.id, 1)).map((c) => c.ac_id)).toEqual(['AC-1']);
  });

  it('locks another milestone with the same ids, and lists by milestone or across them', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);
    await s.lockCriteria(p.id, 2, 1, [criterion(1, 'Second milestone')]);

    expect((await s.listCriteria(p.id, 2)).map((c) => c.text)).toEqual(['Second milestone']);
    expect((await s.listCriteria(p.id)).map((c) => [c.milestone, c.ac_id])).toEqual([
      [1, 'AC-1'],
      [2, 'AC-1'],
    ]);
  });

  it('lists AC-10 after AC-2', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(10), criterion(2)]);

    expect((await s.listCriteria(p.id, 1)).map((c) => c.ac_id)).toEqual(['AC-2', 'AC-10']);
  });

  it.each([
    ['an id of the wrong shape', [{ ...criterion(1), id: 'crit-1' }]],
    ['the same id twice', [criterion(1), criterion(1)]],
    ['empty text', [criterion(1, ' ')]],
    ['no criteria at all', []],
  ])('refuses to lock %s', async (_name, criteria) => {
    await expect(s.lockCriteria(p.id, 1, 1, criteria)).rejects.toThrow();
    expect(await s.listCriteria(p.id, 1)).toEqual([]);
  });

  it('takes a verification only from a qa_verify task', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);

    await expect(s.recordVerification(p.id, 1, 'AC-1', verified('passing', ticketTask.id))).rejects.toThrow(/QA/);

    expect((await s.listCriteria(p.id, 1))[0]?.status).toBe('unverified');
  });

  it('takes no verification from a qa_verify task in another project', async () => {
    const other = await s.createProject({ name: 'other', repo_path: '/o', base_branch: 'main' });
    const foreign = await s.createTask({ ...task('QA-9', 'qa_verify'), project_id: other.id });
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);

    await expect(s.recordVerification(p.id, 1, 'AC-1', verified('passing', foreign.id))).rejects.toThrow(/QA/);
  });

  it('records a verification with its evidence', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);

    await s.recordVerification(p.id, 1, 'AC-1', verified('failing'));

    expect((await s.listCriteria(p.id, 1))[0]).toMatchObject({ status: 'failing', evidence_ref: 'QA-REPORT-M1-1@1#ac-1' });
  });

  it.each(['', '   '])('refuses passing with the empty evidence reference %j', async (evidence) => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);

    await expect(s.recordVerification(p.id, 1, 'AC-1', verified('passing', qaTask.id, evidence))).rejects.toThrow(/evidence/);

    expect((await s.listCriteria(p.id, 1))[0]?.status).toBe('unverified');
  });

  it('refuses a verification of a criterion that was never locked', async () => {
    await expect(s.recordVerification(p.id, 1, 'AC-9', verified())).rejects.toThrow(/AC-9/);
  });

  it('resets status and evidence when a Change Request revises the text', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);
    await s.recordVerification(p.id, 1, 'AC-1', verified());

    await s.reviseCriterion(p.id, 1, 'AC-1', { text: 'Stricter', crId: 'CR-7', specVersion: 2 });

    expect((await s.listCriteria(p.id, 1))[0]).toMatchObject({ text: 'Stricter', cr_id: 'CR-7', spec_version: 2, status: 'unverified', evidence_ref: null });
  });

  it('refuses a second revision under a Change Request that already changed the text', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);
    await s.reviseCriterion(p.id, 1, 'AC-1', { text: 'Stricter', crId: 'CR-7', specVersion: 2 });

    await expect(s.reviseCriterion(p.id, 1, 'AC-1', { text: 'Stricter still', crId: 'CR-7', specVersion: 3 })).rejects.toThrow(/Change Request/);
  });

  it('refuses a text change that goes around the registry', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);

    await expect(sql`UPDATE acceptance_criteria SET text = 'sneaky'`.execute(db)).rejects.toThrow(/Change Request/);
  });

  it('emits ac.status for every change', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);
    await s.recordVerification(p.id, 1, 'AC-1', verified());
    await s.reviseCriterion(p.id, 1, 'AC-1', { text: 'Stricter', crId: 'CR-7', specVersion: 2 });

    const events = (await log.list({ projectId: p.id })).filter((event) => event.type === 'ac.status');

    expect(events.map((event) => event.payload)).toEqual([
      { acId: 'AC-1', status: 'unverified' },
      { acId: 'AC-1', status: 'passing' },
      { acId: 'AC-1', status: 'unverified' },
    ]);
  });

  it('commits or rolls back with the rest of an atomically block', async () => {
    await s.lockCriteria(p.id, 1, 1, [criterion(1)]);

    await expect(
      s.atomically(async (tx) => {
        await tx.recordVerification(p.id, 1, 'AC-1', verified());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect((await s.listCriteria(p.id, 1))[0]?.status).toBe('unverified');
  });

  it('exposes the id shape', () => {
    expect(AC_ID.test('AC-12')).toBe(true);
    expect(AC_ID.test('AC-')).toBe(false);
  });
});
