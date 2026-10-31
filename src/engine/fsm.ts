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

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ['ready', 'blocked', 'escalated', 'cancelled'],
  ready: ['running', 'blocked', 'escalated', 'cancelled'],
  running: ['checks', 'ready', 'blocked', 'escalated', 'cancelled'],
  checks: ['review', 'ready', 'blocked', 'escalated', 'cancelled'],
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

export class IllegalTransition extends Error {
  constructor(
    readonly kind: 'task' | 'attempt',
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
