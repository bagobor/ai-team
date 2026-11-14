import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql, type QueryExecutorProvider } from 'kysely';
import { Migrator } from 'kysely/migration';
import { migrations } from '../src/db/migrations.ts';
import { openDb } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';

describe('migration 002', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiteam-migrations-'));
    path = join(dir, 'aiteam.db');
    const m1 = new Kysely<unknown>({ dialect: new SqliteDialect({ database: new Database(path) }) });
    const { error } = await new Migrator({
      db: m1,
      provider: { getMigrations: async () => ({ '001_initial': migrations['001_initial']! }) },
    }).migrateToLatest();
    if (error) throw error;
    await sql`INSERT INTO projects (name, repo_path, base_branch, created_at)
      VALUES ('from-m1', '/repo', 'main', '2026-10-19T00:00:00Z')`.execute(m1);
    await m1.destroy();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const phases = async (db: Kysely<DB>): Promise<Record<string, string>> =>
    Object.fromEntries((await db.selectFrom('projects').select(['name', 'phase']).execute()).map(({ name, phase }) => [name, phase]));

  it('halts a project that M1 left behind, so upgrading starts no paid work', async () => {
    const db = await openDb(path);
    expect(await phases(db)).toEqual({ 'from-m1': 'halted' });
    await db.destroy();
  });

  it('still starts a project made after the upgrade at intake', async () => {
    const db = await openDb(path);
    await sql`INSERT INTO projects (name, repo_path, base_branch, created_at)
      VALUES ('new', '/repo2', 'main', '2026-11-01T00:00:00Z')`.execute(db);
    expect((await phases(db)).new).toBe('intake');
    await db.destroy();
  });
});

describe('migration 003', () => {
  let dir: string;
  let path: string;

  const insertItem = (db: QueryExecutorProvider, dedupeKey: string) =>
    sql`INSERT INTO inbox_items (project_id, type, dedupe_key, ref, title, asked_by, why, blocks, evidence, recommendation, options, created_at)
      VALUES (1, 'approval', ${dedupeKey}, '{"kind":"cp2","milestone":1}', 't', 'pm', 'w', '[]', '[]', 'r', '[]', '2026-11-01T00:00:00Z')`.execute(db);

  // inbox_items comes from 002, so the database an upgrade starts from is one that has run 001 and 002 and holds an item raised before checks existed.
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aiteam-migrations-'));
    path = join(dir, 'aiteam.db');
    const before = new Kysely<unknown>({ dialect: new SqliteDialect({ database: new Database(path) }) });
    const { error } = await new Migrator({
      db: before,
      provider: { getMigrations: async () => ({ '001_initial': migrations['001_initial']!, '002_artifacts_roles': migrations['002_artifacts_roles']! }) },
    }).migrateToLatest();
    if (error) throw error;
    await sql`INSERT INTO projects (name, repo_path, base_branch, created_at)
      VALUES ('from-m2', '/repo', 'main', '2026-10-19T00:00:00Z')`.execute(before);
    await insertItem(before, 'raised-before');
    await before.destroy();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const checksOf = async (db: Kysely<DB>) => (await sql<{ dedupe_key: string; checks: string }>`SELECT dedupe_key, checks FROM inbox_items ORDER BY id`.execute(db)).rows;

  it('gives an item raised before it an empty list of checks', async () => {
    const db = await openDb(path);

    expect(await checksOf(db)).toEqual([{ dedupe_key: 'raised-before', checks: '[]' }]);
    await db.destroy();
  });

  it('adds inbox checks with an empty default', async () => {
    const db = await openDb(path);
    await insertItem(db, 'raised-after');

    expect(await checksOf(db)).toEqual([
      { dedupe_key: 'raised-before', checks: '[]' },
      { dedupe_key: 'raised-after', checks: '[]' },
    ]);
    await db.destroy();
  });
});

describe('migration 004', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiteam-migrations-'));
    path = join(dir, 'aiteam.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds prototyping, eng_round and eng_cap with defaults 0, 0, 2', async () => {
    const db = await openDb(path);
    await sql`INSERT INTO projects (name, repo_path, base_branch, created_at)
      VALUES ('p', '/repo', 'main', '2026-11-07T00:00:00Z')`.execute(db);
    await sql`INSERT INTO milestones (project_id, n, title, goal, phase, created_at, updated_at)
      VALUES (1, 1, 'One', 'g', 'pending', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z')`.execute(db);

    const project = (await sql<{ prototyping: number }>`SELECT prototyping FROM projects`.execute(db)).rows;
    const milestone = (await sql<{ eng_round: number; eng_cap: number }>`SELECT eng_round, eng_cap FROM milestones`.execute(db)).rows;

    expect(project).toEqual([{ prototyping: 0 }]);
    expect(milestone).toEqual([{ eng_round: 0, eng_cap: 2 }]);
    await db.destroy();
  });

  it('gives a project and a milestone from before it the same defaults', async () => {
    const before = new Kysely<unknown>({ dialect: new SqliteDialect({ database: new Database(path) }) });
    const { error } = await new Migrator({
      db: before,
      provider: {
        getMigrations: async () => ({
          '001_initial': migrations['001_initial']!,
          '002_artifacts_roles': migrations['002_artifacts_roles']!,
          '003_inbox_checks': migrations['003_inbox_checks']!,
        }),
      },
    }).migrateToLatest();
    if (error) throw error;
    await sql`INSERT INTO projects (name, repo_path, base_branch, created_at)
      VALUES ('old', '/repo', 'main', '2026-11-01T00:00:00Z')`.execute(before);
    await sql`INSERT INTO milestones (project_id, n, title, goal, phase, created_at, updated_at)
      VALUES (1, 1, 'One', 'g', 'build', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`.execute(before);
    await before.destroy();

    const db = await openDb(path);

    expect((await sql`SELECT prototyping FROM projects`.execute(db)).rows).toEqual([{ prototyping: 0 }]);
    expect((await sql`SELECT eng_round, eng_cap FROM milestones`.execute(db)).rows).toEqual([{ eng_round: 0, eng_cap: 2 }]);
    await db.destroy();
  });
});

describe('migration 005', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiteam-migrations-'));
    path = join(dir, 'aiteam.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const insertProject = (db: QueryExecutorProvider) =>
    sql`INSERT INTO projects (name, repo_path, base_branch, created_at)
      VALUES ('p', '/repo', 'main', '2026-11-14T00:00:00Z')`.execute(db);

  it('adds must_support_status, which takes only the four statuses', async () => {
    const db = await openDb(path);
    await insertProject(db);
    const record = (item: string, status: string) =>
      sql`INSERT INTO must_support_status (project_id, scope, n, item_id, status, source, must_support_version, recorded_at)
        VALUES (1, 'milestone', 1, ${item}, ${status}, 'play_gate', 1, '2026-11-14T00:00:00Z')`.execute(db);

    await record('MS-1', 'met');
    await expect(record('MS-2', 'maybe')).rejects.toThrow(/CHECK/i);
    // One status per item at each place it is checked.
    await expect(record('MS-1', 'failing')).rejects.toThrow(/UNIQUE/i);

    expect((await sql`SELECT item_id, subject, evidence, status FROM must_support_status`.execute(db)).rows).toEqual([{ item_id: 'MS-1', subject: '', evidence: '', status: 'met' }]);
    await db.destroy();
  });

  it('gives an inbox item raised before it an empty waivable list', async () => {
    const before = new Kysely<unknown>({ dialect: new SqliteDialect({ database: new Database(path) }) });
    const earlier = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '005'));
    const { error } = await new Migrator({ db: before, provider: { getMigrations: async () => earlier } }).migrateToLatest();
    if (error) throw error;
    await insertProject(before);
    await sql`INSERT INTO inbox_items (project_id, type, dedupe_key, ref, title, asked_by, why, blocks, evidence, recommendation, options, created_at)
      VALUES (1, 'approval', 'cp4:1', '{"kind":"cp4","milestone":1}', 't', 'pm', 'w', '[]', '[]', 'r', '[]', '2026-11-14T00:00:00Z')`.execute(before);
    await before.destroy();

    const db = await openDb(path);

    expect((await sql`SELECT waivable FROM inbox_items`.execute(db)).rows).toEqual([{ waivable: '[]' }]);
    await db.destroy();
  });
});
