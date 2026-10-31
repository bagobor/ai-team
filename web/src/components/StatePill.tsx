import type { TaskState } from '../../../src/engine/fsm.ts';

const LOOK: Record<TaskState, string> = {
  queued: 'idle',
  ready: 'idle',
  running: 'run',
  checks: 'run',
  review: 'stale',
  qa: 'stale',
  blocked: 'stale',
  escalated: 'human',
  done: 'pass',
  cancelled: 'idle',
};

// Every look pairs its colour with a lamp shape, so a state doesn't depend on seeing colour.
export function StatePill({ state }: { state: TaskState }) {
  const look = LOOK[state];
  return (
    <span className={`st ${look === 'idle' ? '' : look}`} data-testid="state-pill">
      <i className={`lamp ${look}${look === 'run' ? ' live' : ''}`} />
      {state}
    </span>
  );
}
