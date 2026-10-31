import type { Attempt } from '../api.ts';
import { checkOutcome, type Evidence } from '../logState.ts';

export function EvidenceTab({ evidence, attempts }: { evidence: Evidence[]; attempts: Attempt[] }) {
  const attemptName = (id: number | null) => {
    const k = attempts.find((attempt) => attempt.id === id)?.k;
    return k === undefined ? '' : `a${k}`;
  };

  return (
    <>
      <p className="tab-note">Worker-run information: these checks ran on the worker's own worktree, so they aren't QA evidence.</p>
      {evidence.length === 0 && <div className="empty">No checks have run yet.</div>}
      {evidence.map((run, i) => {
        const passed = run.exitCode === 0;
        return (
          <div className="run-card" key={i}>
            <div className="head">
              <span className="mono">{attemptName(run.attemptId)}</span>
              <b className="mono">{run.command}</b>
              <span className={passed ? 'good' : 'bad'}>{checkOutcome(run)}</span>
              <span className="muted num">{(run.durationMs / 1000).toFixed(1)}s</span>
            </div>
            {run.outputTail !== '' && (
              <details open={!passed}>
                <summary>Output</summary>
                <pre>{run.outputTail}</pre>
              </details>
            )}
          </div>
        );
      })}
    </>
  );
}
