// A change to what a role knows is made as a draft, tried on past attempts of the role, and committed only when the
// trial ends agreed. These are the shapes the drafts, the trials and the pages share.

export const KNOWLEDGE_FILES = ['charter', 'playbook', 'memory_project', 'memory_role'] as const;
export type KnowledgeFile = (typeof KNOWLEDGE_FILES)[number];

// Each file's whole text, empty where there is no file.
export type Knowledge = Record<KnowledgeFile, string>;

export type DraftState = 'open' | 'committed' | 'discarded';

// base is a hash of each committed file as it was when the draft first changed it.
export type DraftRow = { id: number; role_id: string; project_id: number | null; title: string; state: DraftState; base: Partial<Record<KnowledgeFile, string>>; created_at: string; updated_at: string };

// stored is what the attempt produced at the time. current and draft are fresh runs, with the committed knowledge and
// with the draft's.
export type Arm = 'stored' | 'current' | 'draft';
export type Letter = 'A' | 'B' | 'C';

// letters is what each of the task's results is called wherever it is judged, so no judge can tell the draft's.
export type TrialTask = { attemptId: number; group: 'problem' | 'fine'; letters: Partial<Record<Letter, Arm>> };

export type TrialState = 'running' | 'judging' | 'awaiting_answer' | 'agreed' | 'not_agreed' | 'stopped';

// What can be counted about one result. checks, changed and tests are a ticket's, and null for any other task or
// where the run never got that far. note says in words what went wrong.
export type Measured = { parses: boolean; checks: boolean | null; changed: boolean | null; tests: boolean | null; usd: number | null; note: string | null };

export type JudgeName = 'model' | 'evaluator' | 'local';

// p is the probability that the result meets the expectation, counted from 0 in the trial's list.
export type Answer = { arm: Arm; expectation: number; p: number; passage: string | null };

export type JudgeVerdict = { improvement: boolean; why: string };
export type Verdict = { worse: string[]; judges: Partial<Record<JudgeName | 'stakeholder', JudgeVerdict>>; agreed: boolean };

export type TrialRow = {
  id: number;
  draft_id: number;
  role_id: string;
  state: TrialState;
  stop_reason: string | null;
  expectations: string[];
  tasks: TrialTask[];
  knowledge: { current: Knowledge; draft: Knowledge };
  cap_usd: number;
  spent_usd: number;
  // Per attempt id, which of the two compared results the stakeholder found better.
  human: Record<string, Arm | 'same'> | null;
  verdict: Verdict | null;
  commits: { knowledge?: string; state?: string } | null;
  created_at: string;
  ended_at: string | null;
};

export type ResultRow = { id: number; trial_id: number; attempt_id: number; arm: Arm; state: 'pending' | 'running' | 'done'; output: unknown; measured: Measured | null; fingerprint: string | null; error: string | null };

export type JudgmentRow = { id: number; trial_id: number; attempt_id: number; judge: JudgeName; state: 'pending' | 'running' | 'done' | 'failed'; answers: Answer[] | null; error: string | null };
