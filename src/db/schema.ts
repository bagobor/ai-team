import type { Generated } from 'kysely';

// JSON columns hold their values as TEXT.
export type ProjectsTable = {
  id: Generated<number>;
  name: string;
  repo_path: string;
  base_branch: string;
  created_at: string;
};

export type TasksTable = {
  id: Generated<number>;
  project_id: number;
  ticket_id: string;
  title: string;
  milestone: number;
  role_id: string;
  state: string;
  blocked_on: string | null;
  escalation_reason: string | null;
  ticket_path: string;
  ticket_sha: string;
  touches: string;
  depends_on: string;
  dod: string;
  created_at: string;
  updated_at: string;
};

export type AttemptsTable = {
  id: Generated<number>;
  task_id: number;
  k: number;
  state: string;
  adapter: string;
  model: string;
  session_id: string | null;
  pid: number | null;
  pid_started_at: string | null;
  worktree_path: string;
  branch: string;
  base_sha: string | null;
  manifest: string | null;
  output: string | null;
  failure_kind: string | null;
  failure_evidence: string | null;
  usage: string | null;
  started_at: string;
  ended_at: string | null;
  worktree_removed_at: string | null;
};

export type EventsTable = {
  seq: Generated<number>;
  ts: string;
  project_id: number | null;
  task_id: number | null;
  attempt_id: number | null;
  type: string;
  payload: string;
};

export type VendorPausesTable = {
  vendor: string;
  until: string;
  backoff_s: number;
  reason: string;
};

export type DB = {
  projects: ProjectsTable;
  tasks: TasksTable;
  attempts: AttemptsTable;
  events: EventsTable;
  vendor_pauses: VendorPausesTable;
};
