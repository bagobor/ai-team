import { memo, useLayoutEffect, useRef } from 'react';
import type { LogRow } from '../logState.ts';

// Close enough to the bottom to count as following the log, given fractional scroll positions.
const FOLLOW_WITHIN_PX = 24;

const KIND_CLASS: Partial<Record<LogRow['kind'], string>> = { engine: 'eng', test: 'test', init: 'init', usage: 'usage' };

function clock(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

const Row = memo(function Row({ row }: { row: LogRow }) {
  return (
    <div className="ln">
      <span className="t">{clock(row.ts)}</span>
      <span className={`ty ${KIND_CLASS[row.kind] ?? ''}`}>{row.kind}</span>
      <span className={`x${row.kind === 'msg' ? ' msgx' : ''}${row.tone ? ` ${row.tone}` : ''}`}>
        {row.bold && <b>{row.bold} </b>}
        {row.text}
      </span>
    </div>
  );
});

export function LiveLog({ rows, connected }: { rows: LogRow[]; connected: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const onScroll = () => {
    const el = box.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_WITHIN_PX;
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, connected]);

  return (
    <div className="log" role="log" ref={box} onScroll={onScroll}>
      {rows.length === 0 && connected && <div className="ln empty">No events yet.</div>}
      {rows.map((row) => (
        <Row key={row.seq} row={row} />
      ))}
      {!connected && (
        <div className="ln">
          <span className="t" />
          <span className="ty" />
          <span className="x status">Reconnecting…</span>
        </div>
      )}
    </div>
  );
}
