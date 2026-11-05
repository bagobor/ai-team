export type TaskState =
  | 'queued'
  | 'ready'
  | 'running'
  | 'checks'
  | 'review'
  | 'qa'
  | 'blocked'
  | 'escalated'
  | 'done'
  | 'cancelled';

export type AttemptState =
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'budget_exceeded'
  | 'invalid_output'
  | 'cancelled'
  | 'interrupted';

export type ProjectPhase = 'intake' | 'discovery' | 'cp1' | 'active' | 'closed' | 'halted';

export type MilestonePhase =
  | 'pending'
  | 'spec'
  | 'cp2'
  | 'design'
  | 'build'
  | 'verify'
  | 'milestone_review'
  | 'cp4'
  | 'merging'
  | 'merged'
  | 'halted';

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ['ready', 'blocked', 'escalated', 'cancelled'],
  ready: ['running', 'blocked', 'escalated', 'cancelled'],
  running: ['checks', 'ready', 'blocked', 'escalated', 'cancelled'],
  checks: ['review', 'done', 'ready', 'blocked', 'escalated', 'cancelled'],
  review: ['qa', 'done', 'ready', 'blocked', 'escalated', 'cancelled'],
  qa: ['done', 'ready', 'blocked', 'escalated', 'cancelled'],
  blocked: ['ready', 'escalated', 'cancelled'],
  escalated: ['ready', 'cancelled'],
  done: [],
  cancelled: [],
};

// An attempt stays running while its task is in checks: any check failure means the attempt failed.
export const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  starting: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['succeeded', 'failed', 'timeout', 'budget_exceeded', 'invalid_output', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  timeout: [],
  budget_exceeded: [],
  invalid_output: [],
  cancelled: [],
  interrupted: [],
};

export const PROJECT_TRANSITIONS: Record<ProjectPhase, readonly ProjectPhase[]> = {
  intake: ['discovery', 'halted'],
  discovery: ['cp1', 'halted'],
  cp1: ['discovery', 'active', 'halted'],
  active: ['closed', 'halted'],
  closed: [],
  halted: [],
};

export const MILESTONE_TRANSITIONS: Record<MilestonePhase, readonly MilestonePhase[]> = {
  pending: ['spec', 'halted'],
  spec: ['cp2', 'halted'],
  cp2: ['spec', 'design', 'halted'],
  design: ['build', 'halted'],
  build: ['verify', 'halted'],
  verify: ['build', 'milestone_review', 'halted'],
  milestone_review: ['cp4', 'build', 'halted'],
  cp4: ['build', 'merging', 'halted'],
  merging: ['merged', 'build', 'halted'],
  merged: [],
  halted: [],
};

export class IllegalTransition extends Error {
  constructor(
    readonly kind: 'task' | 'attempt' | 'project' | 'milestone',
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${kind} transition: ${from} → ${to}`);
    this.name = 'IllegalTransition';
  }
}

export function assertTaskTransition(from: string, to: string): void {
  if (!(TASK_TRANSITIONS[from as TaskState] ?? []).includes(to as TaskState)) {
    throw new IllegalTransition('task', from, to);
  }
}

export function assertAttemptTransition(from: string, to: string): void {
  if (!(ATTEMPT_TRANSITIONS[from as AttemptState] ?? []).includes(to as AttemptState)) {
    throw new IllegalTransition('attempt', from, to);
  }
}

export function assertProjectTransition(from: string, to: string): void {
  if (!(PROJECT_TRANSITIONS[from as ProjectPhase] ?? []).includes(to as ProjectPhase)) {
    throw new IllegalTransition('project', from, to);
  }
}

export function assertMilestoneTransition(from: string, to: string): void {
  if (!(MILESTONE_TRANSITIONS[from as MilestonePhase] ?? []).includes(to as MilestonePhase)) {
    throw new IllegalTransition('milestone', from, to);
  }
}
