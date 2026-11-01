import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getAttemptDiff, type Attempt } from '../api.ts';
import { diffLines, type DiffLine } from '../lib/board.ts';

const LOOK: Record<DiffLine['kind'], string> = { add: 'l a', del: 'l d', hunk: 'l h', ctx: 'l' };

export function DiffView({ text }: { text: string }) {
  return (
    <div className="diff">
      <div className="diff-lines">
        {diffLines(text).map((line, i) => (
          <div key={i} className={LOOK[line.kind]}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiffTab({ attempts }: { attempts: Attempt[] }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const attempt = attempts.find((a) => a.id === chosen) ?? attempts.at(-1);
  // A running attempt gets its head when it stops, and that's when its diff exists.
  const { data, error } = useQuery({
    queryKey: ['diff', attempt?.id, attempt?.head_sha],
    queryFn: () => getAttemptDiff(attempt!.id),
    enabled: attempt !== undefined,
  });

  return (
    <>
      {attempts.length > 1 && (
        <div className="attempt-pick">
          {attempts.map((a) => (
            <button key={a.id} type="button" className={`btn sm${a.id === attempt?.id ? ' on' : ''}`} onClick={() => setChosen(a.id)}>
              a{a.k}
            </button>
          ))}
        </div>
      )}
      {error && <div className="empty">{error.message}</div>}
      {!error && (!attempt || data?.diff === null) && <div className="empty">No diff yet</div>}
      {data?.diff === '' && <div className="empty">This attempt changed nothing.</div>}
      {data?.diff && <DiffView text={data.diff} />}
    </>
  );
}
