import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ManifestPart } from '../../../src/manifest/build.ts';
import { getManifest, type Attempt } from '../api.ts';

function Meter({ used, budget }: { used: number; budget: number }) {
  const share = budget > 0 ? used / budget : used > 0 ? 1 : 0;
  return (
    <div className={`meter${share > 1 ? ' warn' : ''}`} role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={budget}>
      <i style={{ width: `${Math.min(share, 1) * 100}%` }} />
    </div>
  );
}

function PartRow({ part }: { part: ManifestPart }) {
  return (
    <div className="row">
      <b className="mono">{part.name}</b>
      <span className="mono">{part.budget === null ? `${part.tokens} tokens, no budget of its own` : `${part.tokens} / ${part.budget}`}</span>
      {part.budget !== null && <Meter used={part.tokens} budget={part.budget} />}
      {part.sources.length > 0 && (
        <ul className="sources">
          {part.sources.map((source) => (
            <li key={source}>{source}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One line per option, with the option's value beside it.
function flagLines(flags: string[]): string {
  const lines: string[] = [];
  for (const flag of flags) {
    if (flag.startsWith('-') || lines.length === 0) lines.push(flag);
    else lines[lines.length - 1] += ` ${flag}`;
  }
  return lines.join('\n');
}

export function ManifestTab({ attempts }: { attempts: Attempt[] }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const attempt = attempts.find((a) => a.id === chosen) ?? attempts.at(-1);
  const { data: manifest, error } = useQuery({
    queryKey: ['manifest', attempt?.id],
    queryFn: () => getManifest(attempt!.id),
    enabled: attempt !== undefined,
  });

  if (!attempt) return <div className="empty">No attempt has started yet, so there's no manifest.</div>;

  return (
    <>
      {attempts.length > 1 && (
        <div className="attempt-pick">
          {attempts.map((a) => (
            <button key={a.id} type="button" className={`btn sm${a.id === attempt.id ? ' on' : ''}`} onClick={() => setChosen(a.id)}>
              a{a.k}
            </button>
          ))}
        </div>
      )}
      {!manifest && error && <div className="empty">a{attempt.k} has no manifest yet.</div>}
      {manifest && (
        <div className="mf">
          <div className="mf-main">
            <div className="mf-sec">
              <h3>Budget</h3>
              <div className="budget" style={{ padding: 0, border: 0 }}>
                <div className="row">
                  <b className="mono">context_tokens: {manifest.contextBudget}</b>
                  <span className="mono">{manifest.totalTokens} used</span>
                  <Meter used={manifest.totalTokens} budget={manifest.contextBudget} />
                </div>
                {manifest.parts.map((part) => (
                  <PartRow key={part.name} part={part} />
                ))}
              </div>
            </div>
            <div className="mf-sec">
              <h3>What the worker was given</h3>
              <details>
                <summary>System prompt</summary>
                <pre>{manifest.system}</pre>
              </details>
              <details>
                <summary>Task</summary>
                <pre>{manifest.task}</pre>
              </details>
            </div>
          </div>
          <div>
            <div className="mf-sec">
              <h3>Worker</h3>
              <div className="kv" style={{ padding: 0 }}>
                <div>
                  <span>Model</span>
                  <b className="mono">{manifest.model}</b>
                </div>
                <div>
                  <span>Adapter</span>
                  <b className="mono">{manifest.adapter}</b>
                </div>
                <div>
                  <span>Role</span>
                  <b className="mono">{manifest.roleId}</b>
                </div>
              </div>
            </div>
            <div className="mf-sec">
              <h3>Flags</h3>
              {manifest.flags ? <pre className="flags">{flagLines(manifest.flags)}</pre> : <span className="muted">Not recorded for this attempt.</span>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
