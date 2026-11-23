import type { Generated } from 'kysely';

// JSON columns hold their values as TEXT.
export type ProjectsTable = {
  id: Generated<number>;
  name: string;
  repo_path: string;
  base_branch: string;
  created_at: string;
  phase: Generated<string>;
  prototyping: Generated<number>;
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
  kind: Generated<string>;
  purpose: string | null;
  work_order: string | null;
  parent_task_id: number | null;
  ac_refs: Generated<string>;
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
  head_sha: string | null;
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

export type MilestonesTable = {
  project_id: number;
  n: number;
  title: string;
  goal: string;
  phase: string;
  verify_round: Generated<number>;
  verify_cap: Generated<number>;
  eng_round: Generated<number>;
  eng_cap: Generated<number>;
  created_at: string;
  updated_at: string;
};

export type ArtifactVersionsTable = {
  project_id: number;
  artifact_id: string;
  type: string;
  version: number;
  status: string;
  owner_role: string;
  milestone: number | null;
  sha: string;
  path: string;
  derived_from: string;
  stale_sections: Generated<string>;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
};

export type ArtifactDepsTable = {
  project_id: number;
  from_id: string;
  from_version: number;
  to_id: string;
  to_version: number;
  to_section: string | null;
  to_section_hash: string | null;
};

export type AcceptanceCriteriaTable = {
  project_id: number;
  milestone: number;
  ac_id: string;
  text: string;
  verification: string;
  spec_version: number;
  cr_id: string | null;
  status: Generated<string>;
  evidence_ref: string | null;
  updated_at: string;
};

export type InboxItemsTable = {
  id: Generated<number>;
  project_id: number;
  milestone: number | null;
  type: string;
  dedupe_key: string;
  ref: string;
  title: string;
  asked_by: string;
  why: string;
  blocks: string;
  evidence: string;
  recommendation: string;
  options: string;
  checks: Generated<string>;
  waivable: Generated<string>;
  state: Generated<string>;
  answer: string | null;
  answered_at: string | null;
  applied_at: string | null;
  created_at: string;
};

export type MustSupportStatusTable = {
  project_id: number;
  scope: string;
  n: number;
  subject: Generated<string>;
  item_id: string;
  status: string;
  evidence: Generated<string>;
  source: string;
  must_support_version: number;
  recorded_at: string;
};

export type DraftsTable = {
  id: Generated<number>;
  role_id: string;
  project_id: number | null;
  title: string;
  state: string;
  base: Generated<string>;
  created_at: string;
  updated_at: string;
};

export type TrialsTable = {
  id: Generated<number>;
  draft_id: number;
  role_id: string;
  state: string;
  stop_reason: string | null;
  expectations: string;
  tasks: string;
  knowledge: string;
  cap_usd: number;
  spent_usd: Generated<number>;
  human: string | null;
  verdict: string | null;
  commits: string | null;
  created_at: string;
  ended_at: string | null;
};

export type TrialResultsTable = {
  id: Generated<number>;
  trial_id: number;
  attempt_id: number;
  arm: string;
  state: string;
  output: string | null;
  measured: string | null;
  fingerprint: string | null;
  error: string | null;
};

export type TrialJudgmentsTable = {
  id: Generated<number>;
  trial_id: number;
  attempt_id: number;
  judge: string;
  state: string;
  answers: string | null;
  error: string | null;
};

export type DB = {
  projects: ProjectsTable;
  tasks: TasksTable;
  attempts: AttemptsTable;
  events: EventsTable;
  vendor_pauses: VendorPausesTable;
  milestones: MilestonesTable;
  artifact_versions: ArtifactVersionsTable;
  artifact_deps: ArtifactDepsTable;
  acceptance_criteria: AcceptanceCriteriaTable;
  inbox_items: InboxItemsTable;
  must_support_status: MustSupportStatusTable;
  drafts: DraftsTable;
  trials: TrialsTable;
  trial_results: TrialResultsTable;
  trial_judgments: TrialJudgmentsTable;
};
