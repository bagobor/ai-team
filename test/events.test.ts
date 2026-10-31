import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { openDb } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';
import { EventLog, type EventRow } from '../src/events.ts';

describe('EventLog', () => {
  let dir: string;
  let path: string;
  let db: Kysely<DB>;
  let log: EventLog;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiteam-events-'));
    path = join(dir, 'aiteam.db');
    db = await openDb(path);
    log = new EventLog(db);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assigns increasing seq and filters by task and afterSeq', async () => {
    const a = await log.append({ taskId: 1, type: 'task.state', payload: { to: 'ready' } });
    const b = await log.append({ taskId: 2, type: 'task.state', payload: { to: 'ready' } });
    const c = await log.append({ taskId: 1, type: 'task.state', payload: { to: 'running' } });

    expect(b.seq).toBeGreaterThan(a.seq);
    expect((await log.list({ taskId: 1, afterSeq: a.seq })).map((e) => e.seq)).toEqual([c.seq]);
  });

  it('returns what was appended, payload included', async () => {
    const row = await log.append({ projectId: 3, taskId: 1, attemptId: 2, type: 'worker.message', payload: { text: 'hi' } });

    expect(row).toMatchObject({ projectId: 3, taskId: 1, attemptId: 2, type: 'worker.message', payload: { text: 'hi' } });
    expect((await log.list({}))[0]).toEqual(row);
  });

  it('honors the list limit, oldest first', async () => {
    const a = await log.append({ type: 'task.state', payload: {} });
    const b = await log.append({ type: 'task.state', payload: {} });
    await log.append({ type: 'task.state', payload: {} });

    expect((await log.list({ limit: 2 })).map((e) => e.seq)).toEqual([a.seq, b.seq]);
  });

  it('refuses update and delete', async () => {
    await log.append({ type: 'task.state', payload: {} });

    await expect(sql`update events set type = 'x'`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from events`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('notifies subscribers after commit and stops after unsubscribe', async () => {
    const seen: number[] = [];
    let readBack: Promise<EventRow[]> | undefined;
    const unsubscribe = log.subscribe((e) => {
      seen.push(e.seq);
      readBack = log.list({ afterSeq: e.seq - 1 });
    });

    const first = await log.append({ type: 'task.state', payload: {} });
    expect(seen).toEqual([first.seq]);
    expect((await readBack)?.map((e) => e.seq)).toEqual([first.seq]);
    expect(log.subscriberCount()).toBe(1);

    unsubscribe();
    await log.append({ type: 'task.state', payload: {} });
    expect(seen).toEqual([first.seq]);
    expect(log.subscriberCount()).toBe(0);
  });

  it('keeps going when a subscriber throws', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error('bad subscriber');
    });
    log.subscribe((e) => seen.push(e.seq));

    const row = await log.append({ type: 'task.state', payload: {} });

    expect(seen).toEqual([row.seq]);
  });

  it('keeps rows across reopen and migrates idempotently', async () => {
    const row = await log.append({ type: 'task.state', payload: { to: 'ready' } });
    await db.destroy();

    db = await openDb(path);
    log = new EventLog(db);

    expect((await log.list({})).map((e) => e.seq)).toEqual([row.seq]);
  });

  it('applies the connection settings', async () => {
    const pragma = async (name: string) => (await sql.raw<Record<string, unknown>>(`pragma ${name}`).execute(db)).rows[0];

    expect(await pragma('journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(await pragma('foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(await pragma('busy_timeout')).toEqual({ timeout: 5000 });
  });
});
