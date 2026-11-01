import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
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
