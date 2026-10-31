import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { migrations } from './migrations.ts';
import type { DB } from './schema.ts';

export async function openDb(path: string): Promise<Kysely<DB>> {
  const database = new Database(path);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');

  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database }) });
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    throw error;
  }
  return db;
}
