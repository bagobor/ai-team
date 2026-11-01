export type Purpose =
  | 'discovery'
  | 'environment_profile'
  | 'milestone_spec'
  | 'tech_design'
  | 'test_plan'
  | 'code_review'
  | 'qa_verify'
  | 'milestone_review'
  | 'cr_recommendation'
  | 'revise_design'
  | 'revise_test_plan';

export type TaskKind = 'ticket' | 'authoring' | 'code_review' | 'qa_verify';

// What the engine wants from a non-ticket task. It writes these, so the instructions and pins are never a model's words.
export type WorkOrder = {
  purpose: Purpose;
  instructions: string;
  inputs: string[];
  checks: string[];
  base: { kind: 'base' } | { kind: 'integration' } | { kind: 'sha'; sha: string };
  comment?: string;
  subject?: { ticketTaskId: number; attemptId: number };
};
