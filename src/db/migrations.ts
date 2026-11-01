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
  '002_artifacts_roles': {
    async up(db: Kysely<unknown>): Promise<void> {
      await sql`ALTER TABLE projects ADD COLUMN phase TEXT NOT NULL DEFAULT 'intake'`.execute(db);
      // A project from before this has no spec or milestones to work from, and its parked tickets would start paid reviews.
      await sql`UPDATE projects SET phase = 'halted'`.execute(db);
      await sql`ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket'`.execute(db);
      await sql`ALTER TABLE tasks ADD COLUMN purpose TEXT`.execute(db);
      await sql`ALTER TABLE tasks ADD COLUMN work_order TEXT`.execute(db);
      await sql`ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)`.execute(db);
      await sql`ALTER TABLE tasks ADD COLUMN ac_refs TEXT NOT NULL DEFAULT '[]'`.execute(db);
      await sql`ALTER TABLE attempts ADD COLUMN head_sha TEXT`.execute(db);
      await sql`CREATE INDEX events_project ON events (project_id, seq)`.execute(db);

      await sql`
        CREATE TABLE milestones (
          project_id INTEGER NOT NULL REFERENCES projects(id),
          n INTEGER NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          phase TEXT NOT NULL,
          verify_round INTEGER NOT NULL DEFAULT 0,
          verify_cap INTEGER NOT NULL DEFAULT 3,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, n)
        )`.execute(db);

      await sql`
        CREATE TABLE artifact_versions (
          project_id INTEGER NOT NULL REFERENCES projects(id),
          artifact_id TEXT NOT NULL,
          type TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          owner_role TEXT NOT NULL,
          milestone INTEGER,
          sha TEXT NOT NULL,
          path TEXT NOT NULL,
          derived_from TEXT NOT NULL,
          stale_sections TEXT NOT NULL DEFAULT '[]',
          approved_by TEXT,
          approved_at TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, artifact_id, version)
        )`.execute(db);

      await sql`
        CREATE TABLE artifact_deps (
          project_id INTEGER NOT NULL,
          from_id TEXT NOT NULL,
          from_version INTEGER NOT NULL,
          to_id TEXT NOT NULL,
          to_version INTEGER NOT NULL,
          to_section TEXT,
          to_section_hash TEXT
        )`.execute(db);
      await sql`CREATE INDEX artifact_deps_to ON artifact_deps (project_id, to_id)`.execute(db);

      await sql`
        CREATE TABLE acceptance_criteria (
          project_id INTEGER NOT NULL,
          milestone INTEGER NOT NULL,
          ac_id TEXT NOT NULL,
          text TEXT NOT NULL,
          verification TEXT NOT NULL,
          spec_version INTEGER NOT NULL,
          cr_id TEXT,
          status TEXT NOT NULL DEFAULT 'unverified',
          evidence_ref TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, milestone, ac_id),
          CHECK (status IN ('unverified','passing','failing','waived')),
          CHECK (status NOT IN ('passing','failing') OR evidence_ref IS NOT NULL)
        )`.execute(db);
      await sql`
        CREATE TRIGGER ac_text_needs_cr BEFORE UPDATE OF text ON acceptance_criteria
        WHEN NEW.text <> OLD.text AND (NEW.cr_id IS NULL OR NEW.cr_id = OLD.cr_id)
        BEGIN SELECT RAISE(ABORT, 'criteria text changes only through a Change Request'); END`.execute(db);

      await sql`
        CREATE TABLE inbox_items (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          milestone INTEGER,
          type TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          ref TEXT NOT NULL,
          title TEXT NOT NULL,
          asked_by TEXT NOT NULL,
          why TEXT NOT NULL,
          blocks TEXT NOT NULL,
          evidence TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          options TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          answer TEXT,
          answered_at TEXT,
          applied_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (project_id, dedupe_key)
        )`.execute(db);
    },
  },
};
