import { assertAttemptTransition, assertMilestoneTransition, assertProjectTransition, assertTaskTransition, IllegalTransition } from '../src/engine/fsm.ts';

describe('task transitions', () => {
  it.each([
    ['queued', 'ready'],
    ['running', 'checks'],
    ['running', 'ready'],
    ['checks', 'review'],
    ['escalated', 'ready'],
    ['blocked', 'ready'],
    ['review', 'done'],
    ['review', 'qa'],
    ['qa', 'done'],
  ])('allows %s → %s', (a, b) => {
    expect(() => assertTaskTransition(a, b)).not.toThrow();
  });

  it.each([
    ['done', 'ready'],
    ['queued', 'done'],
    ['queued', 'running'],
    ['cancelled', 'ready'],
    ['escalated', 'running'],
    ['ready', 'ready'],
    ['nonsense', 'ready'],
  ])('rejects %s → %s', (a, b) => {
    expect(() => assertTaskTransition(a, b)).toThrow(IllegalTransition);
  });

  it.each(['queued', 'ready', 'running', 'checks', 'review', 'qa', 'blocked', 'escalated'])(
    'lets %s be cancelled',
    (from) => {
      expect(() => assertTaskTransition(from, 'cancelled')).not.toThrow();
    },
  );
});

describe('attempt transitions', () => {
  it('attempt succeeded is terminal', () => {
    expect(() => assertAttemptTransition('succeeded', 'failed')).toThrow(IllegalTransition);
  });

  it('interrupted reachable from running', () => {
    expect(() => assertAttemptTransition('running', 'interrupted')).not.toThrow();
  });

  it('a starting attempt cannot succeed before it runs', () => {
    expect(() => assertAttemptTransition('starting', 'succeeded')).toThrow(IllegalTransition);
  });

  it('names both states in the error', () => {
    expect(() => assertAttemptTransition('failed', 'running')).toThrow(/failed → running/);
  });
});

describe('project transitions', () => {
  it.each([
    ['intake', 'discovery'],
    ['cp1', 'discovery'],
    ['cp1', 'active'],
    ['active', 'closed'],
    ['discovery', 'halted'],
  ])('allows %s → %s', (a, b) => {
    expect(() => assertProjectTransition(a, b)).not.toThrow();
  });

  it.each([
    ['closed', 'active'],
    ['intake', 'active'],
    ['halted', 'intake'],
    ['nonsense', 'active'],
  ])('refuses %s → %s', (a, b) => {
    expect(() => assertProjectTransition(a, b)).toThrow(IllegalTransition);
  });
});

describe('milestone transitions', () => {
  it.each([
    ['cp2', 'spec'],
    ['verify', 'build'],
    ['cp4', 'build'],
    ['merging', 'merged'],
    ['merging', 'build'],
    ['milestone_review', 'build'],
    ['build', 'halted'],
  ])('allows %s → %s', (a, b) => {
    expect(() => assertMilestoneTransition(a, b)).not.toThrow();
  });

  it.each([
    ['build', 'merged'],
    ['spec', 'build'],
    ['merged', 'build'],
    ['merging', 'cp4'],
    ['halted', 'spec'],
  ])('refuses %s → %s', (a, b) => {
    expect(() => assertMilestoneTransition(a, b)).toThrow(IllegalTransition);
  });
});

describe('tasks ended by their output', () => {
  it('lets a task go from checks to done', () => {
    expect(() => assertTaskTransition('checks', 'done')).not.toThrow();
  });
});
