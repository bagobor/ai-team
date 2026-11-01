import type { EventRow, EventType } from '../src/events.ts';
import { applyEvent, EMPTY_LOG, EVENT_TYPES, estimateLabel, splitEscalation, type LogState } from '../web/src/logState.ts';

let seq = 0;

function event(type: EventType, payload: unknown, attemptId: number | null = 1): EventRow {
  seq += 1;
  return { seq, ts: '2026-10-31T10:00:00.000Z', projectId: 1, taskId: 1, attemptId, type, payload } as EventRow;
}

const apply = (...events: EventRow[]): LogState => events.reduce(applyEvent, EMPTY_LOG);

const RUN = { command: 'npm test', exitCode: 1, timedOut: false, durationMs: 1500, outputTail: 'boom' };

describe('applyEvent', () => {
  it('renders each event type as a row', () => {
    const { rows } = apply(
      event('worker.message', { text: 'Starting on the parser' }),
      event('worker.tool_call', { name: 'Read', input: { file_path: 'src/a.ts' } }),
      event('worker.tool_result', { name: 'Read', ok: false, summary: 'no such file' }),
      event('worker.usage', { inTok: 1200, outTok: 34, usdEst: 0.05 }),
      event('check.finished', RUN),
      event('task.state', { from: 'running', to: 'checks' }),
    );

    expect(rows.map((row) => row.kind)).toEqual(['msg', 'tool', 'tool', 'usage', 'test', 'engine']);
    expect(rows[0]?.text).toBe('Starting on the parser');
    expect(rows[1]).toMatchObject({ bold: 'Read', text: expect.stringContaining('src/a.ts') });
    expect(rows[2]).toMatchObject({ bold: 'Read', text: 'no such file', tone: 'bad' });
    expect(rows[3]?.text).toContain('~$0.05');
    expect(rows[4]).toMatchObject({ bold: 'npm test', text: expect.stringContaining('exit 1'), tone: 'bad' });
    expect(rows[5]?.text).toBe('Task: running → checks');
  });

  it.each(EVENT_TYPES.map((type) => [type]))('gives %s a row with text, whatever its payload', (type) => {
    const { rows } = apply(event(type, {}));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toEqual(expect.any(String));
  });

  it('says why a document changed when the event carries a reason', () => {
    const { rows } = apply(event('lineage.repinned', { id: 'TECH-M1', rationale: 'Only wording moved' }), event('artifact.status', { id: 'M1-T-1', status: 'superseded', rationale: 'Replaced' }));

    expect(rows[0]?.text).toBe('TECH-M1 re-pinned: Only wording moved');
    expect(rows[1]?.text).toBe('M1-T-1 is now superseded: Replaced');
  });

  it('shows a timed-out check as a failure rather than as exit null', () => {
    const { rows } = apply(event('check.finished', { ...RUN, exitCode: null, timedOut: true }));

    expect(rows[0]).toMatchObject({ tone: 'bad', text: expect.stringContaining('timed out') });
  });

  it('marks a passing check and a successful tool result as good or plain', () => {
    const { rows } = apply(event('check.finished', { ...RUN, exitCode: 0 }), event('worker.tool_result', { name: 'Read', ok: true }));

    expect(rows[0]?.tone).toBe('good');
    expect(rows[1]?.tone).toBeUndefined();
  });

  it('still shows a tool call that has no input', () => {
    const { rows } = apply(event('worker.tool_call', { name: 'Bash' }));

    expect(rows[0]).toMatchObject({ bold: 'Bash', text: '' });
  });

  it('shortens a very long tool input', () => {
    const { rows } = apply(event('worker.tool_call', { name: 'Write', input: { content: 'x'.repeat(5000) } }));

    expect(rows[0]!.text.length).toBeLessThan(400);
  });

  it('ignores an already-seen seq', () => {
    const first = event('worker.message', { text: 'once' });

    const state = applyEvent(applyEvent(EMPTY_LOG, first), first);

    expect(state.rows).toHaveLength(1);
    expect(state.lastSeq).toBe(first.seq);
  });

  it('ignores an event older than the last one seen', () => {
    const older = event('worker.message', { text: 'older' });
    const newer = event('worker.message', { text: 'newer' });

    const state = apply(newer, older);

    expect(state.rows.map((row) => row.text)).toEqual(['newer']);
    expect(state.lastSeq).toBe(newer.seq);
  });

  it('leaves the state it was given alone', () => {
    const before = apply(event('worker.message', { text: 'one' }));

    applyEvent(before, event('check.finished', RUN));

    expect(before.rows).toHaveLength(1);
    expect(before.evidence).toHaveLength(0);
  });

  it('collects check.finished into evidence', () => {
    const s = apply(event('check.started', { command: 'npm test' }), event('check.finished', RUN, 7));

    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0]?.exitCode).toBe(1);
    expect(s.evidence[0]).toMatchObject({ command: 'npm test', outputTail: 'boom', attemptId: 7 });
  });

  it('sums usage into an estimate', () => {
    const s = apply(event('worker.usage', { inTok: 1, outTok: 1, usdEst: 0.1 }), event('worker.usage', { inTok: 1, outTok: 1, usdEst: 0.02 }));

    expect(s.usdEst).toBeCloseTo(0.12);
  });

  it('adds nothing to the estimate for usage with no cost', () => {
    const s = apply(event('worker.usage', { inTok: 1, outTok: 1 }));

    expect(s.usdEst).toBe(0);
    expect(s.rows[0]?.text).not.toContain('$');
  });
});

describe('estimateLabel', () => {
  it('marks the cost as an estimate', () => {
    expect(estimateLabel(0.1234)).toBe('~$0.12 (estimate)');
  });

  it('shows a dash for no figure', () => {
    expect(estimateLabel(null)).toBe('—');
  });
});

describe('splitEscalation', () => {
  it('separates the reason from the fix', () => {
    expect(splitEscalation('auth_required: login expired. Fix: claude auth login')).toEqual({ reason: 'auth_required: login expired', fix: 'claude auth login' });
  });

  it('keeps a reason that names no fix', () => {
    expect(splitEscalation('engine_error: the disk is full')).toEqual({ reason: 'engine_error: the disk is full' });
  });

  it('says what to do when the attempts ran out, since the engine records only a code', () => {
    const { reason, fix } = splitEscalation('attempts_exhausted');

    expect(reason).not.toContain('attempts_exhausted');
    expect(reason).toContain('attempt');
    expect(fix).toContain('Retry');
  });

  it('copes with a task that has no reason on record', () => {
    expect(splitEscalation(null).reason).toContain('did not record');
  });
});
