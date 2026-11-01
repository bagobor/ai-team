import type { CheckRun } from '../../src/checks/run-checks.ts';
import type { EventRow, EventType } from '../../src/events.ts';

export type LogKind = 'init' | 'msg' | 'tool' | 'usage' | 'test' | 'engine' | 'error';
export type LogRow = { seq: number; ts: string; kind: LogKind; text: string; bold?: string; tone?: 'good' | 'bad' };
export type Evidence = CheckRun & { attemptId: number | null };
export type LogState = { lastSeq: number; rows: LogRow[]; evidence: Evidence[]; usdEst: number };

export const EMPTY_LOG: LogState = { lastSeq: 0, rows: [], evidence: [], usdEst: 0 };

type Payload = EventRow['payload'];
type RowParts = Pick<LogRow, 'kind' | 'text' | 'bold' | 'tone'>;

const TOOL_INPUT_LIMIT = 300;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function tokens(value: unknown): string {
  const count = typeof value === 'number' ? value : 0;
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function usageText(p: Payload): string {
  const parts = [`in ${tokens(p.inTok)}`, `out ${tokens(p.outTok)}`];
  if (typeof p.cachedTok === 'number') parts.push(`cached ${tokens(p.cachedTok)}`);
  if (typeof p.usdEst === 'number') parts.push(`~$${p.usdEst.toFixed(2)}`);
  return parts.join(' · ');
}

function toolInput(input: unknown): string {
  if (input === undefined) return '';
  const json = JSON.stringify(input);
  return json.length > TOOL_INPUT_LIMIT ? `${json.slice(0, TOOL_INPUT_LIMIT)}…` : json;
}

export function checkOutcome(run: Pick<CheckRun, 'exitCode' | 'timedOut'>): string {
  if (run.timedOut) return 'timed out';
  return run.exitCode === null || run.exitCode === undefined ? 'stopped' : `exit ${run.exitCode}`;
}

function checkRow(p: Payload): RowParts {
  const run = p as CheckRun;
  const took = typeof run.durationMs === 'number' ? ` in ${(run.durationMs / 1000).toFixed(1)}s` : '';
  return { kind: 'test', bold: text(run.command), text: `${checkOutcome(run)}${took}`, tone: run.exitCode === 0 ? 'good' : 'bad' };
}

const change = (subject: string, p: Payload, detail: unknown): string => {
  const why = text(detail);
  return `${subject}: ${text(p.from)} → ${text(p.to)}${why ? ` (${why})` : ''}`;
};

// A Record, so that a new event type doesn't compile until it has a row. Its keys are also what the live log listens for.
const FORMAT: Record<EventType, (p: Payload) => RowParts> = {
  'worker.init': (p) => ({ kind: 'init', text: `Worker started, model ${text(p.model)}` }),
  'worker.message': (p) => ({ kind: 'msg', text: text(p.text) }),
  'worker.tool_call': (p) => ({ kind: 'tool', bold: text(p.name), text: toolInput(p.input) }),
  'worker.tool_result': (p) => ({ kind: 'tool', bold: text(p.name), text: text(p.summary), ...(p.ok === false ? { tone: 'bad' as const } : {}) }),
  'worker.usage': (p) => ({ kind: 'usage', text: usageText(p) }),
  'worker.error': (p) => ({ kind: 'error', text: text(p.message), tone: 'bad' }),
  'check.started': (p) => ({ kind: 'test', bold: text(p.command), text: 'running' }),
  'check.finished': checkRow,
  'task.state': (p) => ({ kind: 'engine', text: change('Task', p, p.reason ?? p.blockedOn) }),
  'attempt.state': (p) => ({ kind: 'engine', text: change('Attempt', p, p.failureKind) }),
  'manifest.built': (p) => ({ kind: 'engine', text: `Manifest built: ${tokens(p.totalTokens)} of ${tokens(p.contextBudget)} tokens` }),
  'vendor.paused': (p) => ({ kind: 'engine', text: `${text(p.vendor)} paused until ${text(p.until)}: ${text(p.reason)}` }),
  'recovery.interrupted': () => ({ kind: 'engine', text: 'The daemon restarted and marked this attempt interrupted' }),
  'project.phase': (p) => ({ kind: 'engine', text: change('Project', p, undefined) }),
  'milestone.phase': (p) => ({ kind: 'engine', text: change(`Milestone ${String(p.milestone)}`, p, undefined) }),
  'artifact.published': (p) => ({ kind: 'engine', text: `Published ${text(p.id)}@${String(p.version)} (${text(p.status)})` }),
  'artifact.status': (p) => ({ kind: 'engine', text: `${text(p.id)} is now ${text(p.status)}` }),
  'lineage.repinned': (p) => ({ kind: 'engine', text: `${text(p.id)} re-pinned` }),
  'ac.status': (p) => ({ kind: 'engine', text: `${text(p.acId)} is now ${text(p.status)}` }),
  'inbox.raised': (p) => ({ kind: 'engine', text: `Inbox: ${text(p.title)}` }),
  'inbox.answered': (p) => ({ kind: 'engine', text: `Inbox answered: ${text(p.title)}` }),
  'inbox.applied': (p) => ({ kind: 'engine', text: `Inbox answer applied: ${text(p.title)}` }),
  'inbox.withdrawn': (p) => ({ kind: 'engine', text: `Inbox item withdrawn: ${text(p.reason)}` }),
  'merge.done': (p) => ({ kind: 'engine', text: `Merged into ${text(p.target)}`, tone: 'good' }),
  'merge.conflict': (p) => ({ kind: 'engine', text: `Merge conflict in ${text(p.target)}`, tone: 'bad' }),
  'change_request.dropped': (p) => ({ kind: 'engine', text: `Change Request dropped: ${text(p.reason)}`, tone: 'bad' }),
  'conductor.error': (p) => ({ kind: 'error', text: text(p.message), tone: 'bad' }),
};

export const EVENT_TYPES = Object.keys(FORMAT) as EventType[];

export function applyEvent(s: LogState, e: EventRow): LogState {
  if (e.seq <= s.lastSeq) return s;

  const row: LogRow = { seq: e.seq, ts: e.ts, ...FORMAT[e.type](e.payload) };
  const usd = e.type === 'worker.usage' && typeof e.payload.usdEst === 'number' ? e.payload.usdEst : 0;
  return {
    lastSeq: e.seq,
    rows: [...s.rows, row],
    evidence: e.type === 'check.finished' ? [...s.evidence, { ...(e.payload as CheckRun), attemptId: e.attemptId }] : s.evidence,
    usdEst: s.usdEst + usd,
  };
}

export function estimateLabel(usd: number | null): string {
  return usd === null ? '—' : `~$${usd.toFixed(2)} (estimate)`;
}

const FIX_MARK = '. Fix: ';

export function splitEscalation(reason: string | null): { reason: string; fix?: string } {
  if (reason === null) return { reason: 'The engine did not record a reason.' };
  // The engine records only this code, and the reason for each failure sits on its attempt.
  if (reason === 'attempts_exhausted') {
    return { reason: 'Every attempt failed.', fix: 'Read why under each attempt below, change what caused it, then Retry.' };
  }
  const at = reason.lastIndexOf(FIX_MARK);
  return at === -1 ? { reason } : { reason: reason.slice(0, at), fix: reason.slice(at + FIX_MARK.length) };
}
