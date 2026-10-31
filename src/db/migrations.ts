import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

export const migrations: Record<string, Migration> = {
  '001_initial': {
    async up(db: Kysely<unknown>): Promise<void> {
      await sql`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          repo_path TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`.execute(db);

      await sql`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          ticket_id TEXT NOT NULL,
          title TEXT NOT NULL,
          milestone INTEGER NOT NULL,
          role_id TEXT NOT NULL,
          state TEXT NOT NULL,
          blocked_on TEXT,
          escalation_reason TEXT,
          ticket_path TEXT NOT NULL,
          ticket_sha TEXT NOT NULL,
          touches TEXT NOT NULL,
          depends_on TEXT NOT NULL,
          dod TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (project_id, ticket_id)
        )`.execute(db);

      await sql`
        CREATE TABLE attempts (
          id INTEGER PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES tasks(id),
          k INTEGER NOT NULL,
          state TEXT NOT NULL,
          adapter TEXT NOT NULL,
          model TEXT NOT NULL,
          session_id TEXT,
          pid INTEGER,
          pid_started_at TEXT,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_sha TEXT,
          manifest TEXT,
          output TEXT,
          failure_kind TEXT,
          failure_evidence TEXT,
          usage TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          worktree_removed_at TEXT,
          UNIQUE (task_id, k)
        )`.execute(db);

      await sql`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          project_id INTEGER,
          task_id INTEGER,
          attempt_id INTEGER,
          type TEXT NOT NULL,
          payload TEXT NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX events_task ON events (task_id, seq)`.execute(db);

      await sql`
        CREATE TRIGGER events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`.execute(db);
      await sql`
        CREATE TRIGGER events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`.execute(db);

      await sql`
        CREATE TABLE vendor_pauses (
          vendor TEXT PRIMARY KEY,
          "until" TEXT NOT NULL,
          backoff_s INTEGER NOT NULL,
          reason TEXT NOT NULL
        )`.execute(db);
    },
  },
};
