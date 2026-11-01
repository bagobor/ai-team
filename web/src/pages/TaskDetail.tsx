import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TASK_TRANSITIONS, type AttemptState } from '../../../src/engine/fsm.ts';
import type { TaskRow } from '../../../src/engine/store.ts';
import { cancelTask, getTask, retryTask, useTaskLog, type Attempt, type TaskDetails } from '../api.ts';
import { DiffTab } from '../components/DiffTab.tsx';
import { EvidenceTab } from '../components/EvidenceTab.tsx';
import { LiveLog } from '../components/LiveLog.tsx';
import { ManifestTab } from '../components/ManifestTab.tsx';
import { StatePill } from '../components/StatePill.tsx';
import { estimateLabel, splitEscalation } from '../logState.ts';
import { Link } from '../router.tsx';

const POLL_MS = 5000;

const TABS = [
  { id: 'log', label: 'Live log' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'diff', label: 'Diff' },
  { id: 'evidence', label: 'Evidence' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const ATTEMPT_LOOK: Record<AttemptState, string> = {
  starting: 'run',
  running: 'run',
  succeeded: 'pass',
  failed: 'fail',
  timeout: 'fail',
  budget_exceeded: 'fail',
  invalid_output: 'fail',
  cancelled: 'todo',
  interrupted: 'todo',
};

function took(attempt: Attempt): string | undefined {
  if (!attempt.started_at || !attempt.ended_at) return undefined;
  const seconds = Math.round((Date.parse(attempt.ended_at) - Date.parse(attempt.started_at)) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

function evidenceText(evidence: unknown): string {
  return typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2);
}

function AttemptItem({ attempt }: { attempt: Attempt }) {
  const usd = (attempt.usage as { usdEst?: number } | null)?.usdEst;
  const facts = [attempt.model, took(attempt), usd === undefined ? undefined : `~$${usd.toFixed(2)}`].filter(Boolean);
  return (
    <li className={ATTEMPT_LOOK[attempt.state]}>
      <span className="dot" />
      <div className="h">
        a{attempt.k} {attempt.state}
      </div>
      {facts.length > 0 && <div className="b">{facts.join(', ')}</div>}
      {attempt.failure_kind && <div className="n">{attempt.failure_kind}</div>}
      {attempt.failure_evidence != null && (
        <details>
          <summary>Why</summary>
          <pre>{evidenceText(attempt.failure_evidence)}</pre>
        </details>
      )}
    </li>
  );
}

function Escalation({ task, onRetry, busy }: { task: TaskRow; onRetry: () => void; busy: boolean }) {
  const { reason, fix } = splitEscalation(task.escalation_reason);
  return (
    <div className="banner human" role="alert">
      <div>
        <p>{reason}</p>
        {fix && (
          <p className="fix">
            Fix: <span className="mono">{fix}</span>
          </p>
        )}
      </div>
      <button type="button" className="btn primary" onClick={onRetry} disabled={busy}>
        Retry
      </button>
    </div>
  );
}

function TaskView({ details: { task, attempts } }: { details: TaskDetails }) {
  const queryClient = useQueryClient();
  const { log, connected } = useTaskLog(task.id);
  const [tab, setTab] = useState<TabId>('log');

  const action = useMutation({
    mutationFn: (run: (id: number) => Promise<unknown>) => run(task.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['task', task.id] }),
  });

  return (
    <>
      <header className="ph">
        <div>
          <div className="crumbs">
            <Link to="/tasks">Tasks</Link>
            <span>/</span>
          </div>
          <h1>
            <span className="mono" style={{ fontSize: '.86em', fontWeight: 500, color: 'var(--ink-2)' }}>
              {task.ticket_id}
            </span>{' '}
            {task.title}
          </h1>
          <div className="ph-sub">
            <StatePill state={task.state} />
            {task.state === 'blocked' && task.blocked_on && <span>Blocked on {task.blocked_on}</span>}
            {log.usdEst > 0 && <span>{estimateLabel(log.usdEst)}</span>}
          </div>
        </div>
        <div className="ph-actions">
          {action.error && <span className="err">{action.error.message}</span>}
          {task.kind === 'ticket' && TASK_TRANSITIONS[task.state].includes('cancelled') && (
            <button type="button" className="btn danger" onClick={() => action.mutate(cancelTask)} disabled={action.isPending}>
              {action.isPending ? 'Working…' : 'Cancel'}
            </button>
          )}
        </div>
      </header>

      <div className="content stack">
        {task.state === 'escalated' && <Escalation task={task} onRetry={() => action.mutate(retryTask)} busy={action.isPending} />}
        {task.state === 'review' && (
          <div className="banner">
            <p>Waiting for the Code Reviewer.</p>
          </div>
        )}

        {attempts.length > 0 && (
          <div className="panel">
            <ol className="atl" aria-label="Attempts">
              {attempts.map((attempt) => (
                <AttemptItem key={attempt.id} attempt={attempt} />
              ))}
            </ol>
          </div>
        )}

        <div className="panel">
          <div className="tabs" role="tablist">
            {TABS.map(({ id, label }) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'log' && <LiveLog rows={log.rows} connected={connected} />}
          {tab === 'manifest' && <ManifestTab attempts={attempts} />}
          {tab === 'diff' && <DiffTab attempts={attempts} />}
          {tab === 'evidence' && <EvidenceTab evidence={log.evidence} attempts={attempts} />}
        </div>
      </div>
    </>
  );
}

export function TaskDetail({ id }: { id: number }) {
  const { data, error } = useQuery({ queryKey: ['task', id], queryFn: () => getTask(id), refetchInterval: POLL_MS });

  if (data) return <TaskView details={data} />;
  if (error) {
    return (
      <p className="notice">
        {error.message}. <Link to="/tasks">See all tasks</Link>
      </p>
    );
  }
  return <p className="notice">Loading…</p>;
}
