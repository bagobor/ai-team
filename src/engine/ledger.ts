import type { EventLog, EventRow } from '../events.ts';
import { isPolishTicket } from './apply/ids.ts';
import type { InboxRef, InboxRow, InboxState } from './inbox.ts';
import type { AttemptRow, MilestoneRow, ProjectRow, Store, TaskRow } from './store.ts';

// A run as a list of visits to stages. A visit holds the agent runs and the questions put to the stakeholder
// while it lasted, and notes on what happened in it: most of all, what made it go back to an earlier stage.

export type LedgerNote = { kind: 'you' | 'ok' | 'loop' | 'fail' | 'run'; text: string; quote?: string; list?: string[] };
export type RunOutcome = 'ok' | 'fail' | 'back' | 'run' | 'idle';
export type LedgerRun = { attemptId: number; k: number; outcome: RunOutcome; failureKind: string | null; startedAt: string; seconds: number; usdEst: number | null; review: boolean };
export type LedgerTask = { taskId: number; ticketId: string; title: string; roleId: string; purpose: string | null; runs: LedgerRun[]; usdEst: number | null };
export type LedgerQuestion = { id: number; title: string; state: InboxState; askedAt: string; waitedSeconds: number | null; answer: string | null; comment: string | null };
export type LedgerVisit = {
  scope: number;
  stage: string;
  round: number;
  from: string;
  to: string | null;
  exit: string | null;
  back: boolean;
  seconds: number;
  runs: number;
  failed: number;
  usdEst: number | null;
  asked: number;
  answered: number;
  waitingSeconds: number;
  notes: LedgerNote[];
  tasks: LedgerTask[];
  questions: LedgerQuestion[];
};
export type LedgerSection = { scope: number; title: string; visits: LedgerVisit[]; seconds: number; runs: number; failed: number; usdEst: number | null; decisions: number; loops: number };
export type Ledger = { sections: LedgerSection[] };

export type LedgerInput = { project: ProjectRow; milestones: MilestoneRow[]; tasks: TaskRow[]; attempts: AttemptRow[]; inbox: InboxRow[]; events: EventRow[]; now: Date };

const PROJECT_STAGES = ['intake', 'prototype', 'discovery', 'cp1'];
const MILESTONE_STAGES = ['spec', 'cp2', 'design', 'build', 'verify', 'eng_review', 'milestone_review', 'cp4', 'merging', 'merged'];
const order = (stage: string) => (PROJECT_STAGES.includes(stage) ? PROJECT_STAGES.indexOf(stage) : stage === 'active' ? 5 : 10 + MILESTONE_STAGES.indexOf(stage));
const ENDS = ['closed', 'halted'];

// The gate's request is written a moment before the phase event that opens the gate.
const GATE_LEAD_MS = 1500;
// How far around a loop's turn to look for what caused it.
const CR_BEFORE_MS = 120_000;
const CR_AFTER_MS = 15_000;
const STALE_BEFORE_MS = 2_000;
const STALE_AFTER_MS = 60_000;
const VERIFY_SLACK_BEFORE_MS = 1_000;
const VERIFY_SLACK_AFTER_MS = 3_000;
const POLISH_BEFORE_MS = 5_000;
const POLISH_AFTER_MS = 180_000;

const GATES = ['cp1', 'cp2', 'cp4', 'fun_eval'];

type Visit = { scope: number; stage: string; from: number; to: number | null; exit: string | null; round: number; back: boolean; attempts: AttemptRow[]; inbox: Asked[] };
type Asked = InboxRow & { start: number; end: number | null };

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const usdOf = (attempt: AttemptRow): number | null => {
  const usd = (attempt.usage as { usdEst?: unknown } | null)?.usdEst;
  return typeof usd === 'number' ? usd : null;
};
const addUsd = (values: (number | null)[]): number | null => values.reduce<number | null>((total, value) => (value === null ? total : (total ?? 0) + value), null);

export function outcomeOf(attempt: Pick<AttemptRow, 'state' | 'failure_kind'>): RunOutcome {
  if (attempt.state === 'running' || attempt.state === 'starting') return 'run';
  if (attempt.failure_kind === 'changes_requested') return 'back';
  if (attempt.failure_kind) return 'fail';
  return attempt.state === 'succeeded' ? 'ok' : 'idle';
}

// The length of the union of some intervals.
function covered(intervals: [number, number][]): number {
  let total = 0;
  let reach = -Infinity;
  for (const [a, b] of intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])) {
    const from = Math.max(a, reach);
    if (b > from) total += b - from;
    reach = Math.max(reach, b);
  }
  return total;
}

function visitsOf(input: LedgerInput): { visits: Visit[]; endedAt: number | null } {
  const visits: Visit[] = [];
  const open = new Map<number, Visit>();
  let endedAt: number | null = null;

  const begin = (scope: number, stage: string, at: number) => {
    const visit: Visit = { scope, stage, from: at, to: null, exit: null, round: 0, back: false, attempts: [], inbox: [] };
    visits.push(visit);
    open.set(scope, visit);
  };
  const end = (scope: number, at: number, exit: string) => {
    const visit = open.get(scope);
    if (visit) Object.assign(visit, { to: at, exit });
    open.delete(scope);
  };

  begin(0, 'intake', ms(input.project.created_at));
  for (const event of input.events) {
    const at = ms(event.ts);
    if (event.type === 'project.phase') {
      const to = String(event.payload.to);
      if (to === 'halted') for (const scope of [...open.keys()]) end(scope, at, 'halted');
      else end(0, at, to);
      if (ENDS.includes(to)) endedAt = at;
      else if (to !== 'active') begin(0, to, at);
    } else if (event.type === 'milestone.phase') {
      const n = Number(event.payload.milestone);
      const [from, to] = [String(event.payload.from), String(event.payload.to)];
      // A merge that goes through is one moment, shown as the milestone's last row.
      if (from === 'merging' && to === 'merged') {
        const merging = open.get(n);
        if (merging) Object.assign(merging, { stage: 'merged', to: at, exit: null });
        open.delete(n);
        continue;
      }
      end(n, at, to);
      if (to === 'merged') visits.push({ scope: n, stage: 'merged', from: at, to: at, exit: null, round: 0, back: false, attempts: [], inbox: [] });
      else if (to !== 'halted') begin(n, to, at);
    }
  }

  const rounds = new Map<string, number>();
  for (const visit of visits) {
    const key = `${visit.scope}:${visit.stage}`;
    visit.round = (rounds.get(key) ?? 0) + 1;
    rounds.set(key, visit.round);
    visit.back = visit.exit !== null && !ENDS.includes(visit.exit) && order(visit.exit) < order(visit.stage);
  }
  return { visits, endedAt };
}

// Places a gate's request in the last visit to the gate that had begun by then: a gate answered at once can end before that moment.
// Places anything else in the visit of its own scope that held it, else any visit that held it, else its scope's last visit before it.
function placer(visits: Visit[]): (scope: number, at: number, stage?: string) => Visit | undefined {
  const live = visits.filter(({ stage }) => stage !== 'merged');
  const holds = (visit: Visit, at: number) => visit.from <= at && at < (visit.to ?? Infinity);
  return (scope, at, stage) => {
    const begun = live.filter((visit) => visit.scope === scope && visit.from <= at);
    const gate = stage === undefined ? undefined : begun.filter((visit) => visit.stage === stage).at(-1);
    return gate ?? begun.find((visit) => holds(visit, at)) ?? live.find((visit) => holds(visit, at)) ?? begun.at(-1) ?? live.find((visit) => visit.scope === scope);
  };
}

const GATE_STAGE: Partial<Record<InboxRef['kind'], string>> = { cp1: 'cp1', cp2: 'cp2', cp4: 'cp4', fun_eval: 'prototype' };

function gateName(item: InboxRow): string {
  return item.ref.kind === 'fun_eval' ? `prototype round ${item.ref.round}` : item.ref.kind.toUpperCase();
}

const actionOf = (item: InboxRow): string | null => (item.answer === null ? null : 'action' in item.answer ? item.answer.action : 'option' in item.answer ? item.answer.option : 'answered');
const commentOf = (item: InboxRow): string | null => (item.answer !== null && 'comment' in item.answer && item.answer.comment !== '' ? item.answer.comment : null);

// What happened in a visit, most decisive first: the stakeholder's answers, withdrawn gates, change requests,
// documents gone stale, failing criteria, polish tickets, dropped requests.
function notesOf(input: LedgerInput, visit: Visit, now: number, tasks: Map<number, TaskRow>): LedgerNote[] {
  const notes: LedgerNote[] = [];
  const end = visit.to ?? now;
  const within = (event: EventRow, a: number, b: number) => ms(event.ts) >= a && ms(event.ts) <= b;
  const events = (type: string) => input.events.filter((event) => event.type === type);

  if (visit.stage === 'merged') {
    const cp4 = input.inbox.filter((item) => item.milestone === visit.scope && item.ref.kind === 'cp4' && actionOf(item) === 'approve').at(-1);
    const checks = cp4?.answer && 'checks' in cp4.answer ? (cp4.answer.checks ?? []) : [];
    return cp4 ? [{ kind: 'ok', text: `You approved the merge${checks.length > 0 ? ` with ${plural(checks.length, 'check')} marked` : ''}` }] : [];
  }

  for (const item of visit.inbox.filter(({ ref }) => GATES.includes(ref.kind))) {
    const what = gateName(item);
    const action = actionOf(item);
    const quote = commentOf(item) ?? undefined;
    if (action === 'request_changes') notes.push({ kind: 'you', text: `You asked for changes on ${what}`, ...(quote ? { quote } : {}) });
    else if (action === 'approve') notes.push({ kind: 'ok', text: `You approved ${what}`, ...(quote ? { quote } : {}) });
    else if (action === 'reject') notes.push({ kind: 'you', text: `You rejected ${what}`, ...(quote ? { quote } : {}) });
    else if (item.state === 'withdrawn') {
      const reason = events('inbox.withdrawn').find((event) => ms(event.ts) >= item.start)?.payload.reason;
      notes.push({ kind: 'loop', text: `${what} request withdrawn before you answered${typeof reason === 'string' && reason !== '' ? `: ${reason}` : ''}` });
    } else if (item.state === 'pending') notes.push({ kind: 'you', text: `Waiting for you on ${what}` });
  }

  const crs = visit.inbox.filter((item) => item.ref.kind === 'cr' && item.state === 'answered');
  if (crs.length > 0) {
    const approved = crs.filter((item) => actionOf(item) === 'approve');
    notes.push({
      kind: 'you',
      text: `You decided ${plural(crs.length, 'change request')}: ${approved.length} approved, ${crs.length - approved.length} rejected`,
      list: crs.map((item) => `${item.ref.kind === 'cr' ? item.ref.cr : ''} ${actionOf(item) === 'approve' ? 'approved' : 'rejected'}: ${item.title}`),
    });
  }

  const escalations = visit.inbox.filter((item) => item.ref.kind === 'escalation' && item.state === 'answered');
  if (escalations.length > 0) {
    const counts = new Map<string, number>();
    for (const item of escalations) counts.set(actionOf(item) ?? 'answered', (counts.get(actionOf(item) ?? 'answered') ?? 0) + 1);
    notes.push({
      kind: 'you',
      text: `You answered ${plural(escalations.length, 'escalation')}: ${[...counts].map(([option, n]) => `${n} ${option}`).join(', ')}`,
      list: escalations.map((item) => `${item.title}: ${actionOf(item) ?? ''}`),
    });
  }

  if (visit.to !== null && visit.back) {
    const turn = visit.to;
    const statuses = events('artifact.status');
    const crIds = [...new Set(statuses.filter((event) => /^CR-/.test(String(event.payload.id)) && event.payload.status === 'approved' && within(event, turn - CR_BEFORE_MS, turn + CR_AFTER_MS)).map((event) => String(event.payload.id)))];
    if (crIds.length > 0) notes.push({ kind: 'loop', text: `${crIds.join(', ')} approved, changing the milestone` });
    const stale = [...new Set(statuses.filter((event) => event.payload.status === 'stale' && within(event, turn - STALE_BEFORE_MS, turn + STALE_AFTER_MS)).map((event) => String(event.payload.id)))];
    if (stale.length > 0) notes.push({ kind: 'loop', text: `${plural(stale.length, 'document')} went stale and had to be redone`, list: stale });
  }

  if (visit.stage === 'verify') {
    const last = new Map<string, string>();
    for (const event of events('ac.status')) if (within(event, visit.from - VERIFY_SLACK_BEFORE_MS, end + VERIFY_SLACK_AFTER_MS)) last.set(String(event.payload.acId), String(event.payload.status));
    const failing = [...last].filter(([, status]) => status === 'failing').map(([ac]) => ac);
    const passing = [...last].filter(([, status]) => status === 'passing');
    if (failing.length > 0) notes.push({ kind: 'fail', text: `${failing.join(', ')} failing` });
    else if (passing.length > 0) notes.push({ kind: 'ok', text: `${plural(passing.length, 'criterion', 'criteria')} passing` });
  }

  for (const event of events('play.result').filter((event) => event.payload.milestone === visit.scope && within(event, visit.from, end))) {
    const { outcome, why, problems } = event.payload as { outcome?: string; why?: string; problems?: { detail?: string }[] };
    if (outcome === 'passed') notes.push({ kind: 'ok', text: 'The play test passed' });
    else if (outcome === 'failed') notes.push({ kind: 'fail', text: 'The play test failed', list: (problems ?? []).map(({ detail }) => String(detail)) });
    else if (outcome === 'unavailable') notes.push({ kind: 'fail', text: `The play test could not run${why ? `: ${why}` : ''}` });
  }

  if (visit.stage === 'eng_review' && visit.exit === 'build' && visit.to !== null) {
    const turn = visit.to;
    const opened = input.tasks.filter(
      (task) => task.kind === 'ticket' && isPolishTicket(task.ticket_id) && task.milestone === visit.scope && ms(task.created_at) >= turn - POLISH_BEFORE_MS && ms(task.created_at) <= turn + POLISH_AFTER_MS,
    );
    notes.push({ kind: 'loop', text: `Eng Lead opened ${plural(opened.length, 'polish ticket')}`, list: opened.map((task) => `${task.ticket_id}: ${task.title}`) });
  }

  const dropped = events('change_request.dropped').filter((event) => within(event, visit.from, end));
  if (dropped.length > 0) notes.push({ kind: 'fail', text: `${plural(dropped.length, 'change request')} dropped by the engine`, list: [...new Set(dropped.map((event) => String(event.payload.reason)))] });

  if (visit.to === null && !visit.inbox.some(({ state }) => state === 'pending')) {
    const running = visit.attempts.filter((attempt) => outcomeOf(attempt) === 'run').map((attempt) => tasks.get(attempt.task_id)?.ticket_id ?? `#${attempt.task_id}`);
    notes.push({ kind: 'run', text: running.length > 0 ? `Running now: ${[...new Set(running)].join(', ')}` : 'In progress now' });
  }
  return notes;
}

// The tasks that ran in a visit, each with its attempts in order. A code review folds under the ticket it reviewed.
function tasksOf(attempts: AttemptRow[], tasks: Map<number, TaskRow>, now: number): LedgerTask[] {
  const byTask = new Map<number, AttemptRow[]>();
  for (const attempt of attempts) byTask.set(attempt.task_id, [...(byTask.get(attempt.task_id) ?? []), attempt]);

  const rows = new Map<number, { task: TaskRow; runs: [AttemptRow, boolean][] }>();
  const reviews: [number, AttemptRow[]][] = [];
  for (const [id, list] of byTask) {
    const task = tasks.get(id);
    if (!task) continue;
    if (task.kind === 'code_review' && task.parent_task_id !== null && byTask.has(task.parent_task_id)) reviews.push([task.parent_task_id, list]);
    else rows.set(id, { task, runs: list.map((attempt) => [attempt, false]) });
  }
  for (const [parent, list] of reviews) rows.get(parent)?.runs.push(...list.map((attempt): [AttemptRow, boolean] => [attempt, true]));

  const started = (row: { runs: [AttemptRow, boolean][] }) => Math.min(...row.runs.map(([attempt]) => ms(attempt.started_at)));
  return [...rows.values()]
    .sort((a, b) => started(a) - started(b))
    .map(({ task, runs }) => {
      const ordered = runs.sort(([a], [b]) => ms(a.started_at) - ms(b.started_at));
      return {
        taskId: task.id,
        ticketId: task.ticket_id,
        title: task.title,
        roleId: task.role_id,
        purpose: task.purpose,
        usdEst: addUsd(ordered.map(([attempt]) => usdOf(attempt))),
        runs: ordered.map(([attempt, review]) => ({
          attemptId: attempt.id,
          k: attempt.k,
          outcome: outcomeOf(attempt),
          failureKind: attempt.failure_kind,
          startedAt: attempt.started_at,
          seconds: Math.max(0, ((attempt.ended_at ? ms(attempt.ended_at) : outcomeOf(attempt) === 'run' ? now : ms(attempt.started_at)) - ms(attempt.started_at)) / 1000),
          usdEst: usdOf(attempt),
          review,
        })),
      };
    });
}

export function buildLedger(input: LedgerInput): Ledger {
  const { visits, endedAt } = visitsOf(input);
  const now = endedAt ?? input.now.getTime();
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const place = placer(visits);

  for (const attempt of input.attempts) place(tasks.get(attempt.task_id)?.milestone ?? 0, ms(attempt.started_at))?.attempts.push(attempt);

  const withdrawals = input.events.filter((event) => event.type === 'inbox.withdrawn');
  for (const item of input.inbox) {
    const start = ms(item.created_at);
    const withdrawn = item.state === 'withdrawn' ? withdrawals.find((event) => ms(event.ts) >= start) : undefined;
    const end = item.answered_at ? ms(item.answered_at) : item.state === 'withdrawn' ? (withdrawn ? ms(withdrawn.ts) : start) : null;
    place(item.milestone ?? 0, start + GATE_LEAD_MS, GATE_STAGE[item.ref.kind])?.inbox.push({ ...item, start, end });
  }

  const toVisit = (visit: Visit): LedgerVisit => ({
    scope: visit.scope,
    stage: visit.stage,
    round: visit.round,
    from: iso(visit.from),
    to: visit.to === null ? null : iso(visit.to),
    exit: visit.exit,
    back: visit.back,
    seconds: visit.stage === 'merged' ? 0 : ((visit.to ?? now) - visit.from) / 1000,
    runs: visit.attempts.length,
    failed: visit.attempts.filter(({ failure_kind }) => failure_kind).length,
    usdEst: addUsd(visit.attempts.map(usdOf)),
    asked: visit.inbox.length,
    answered: visit.inbox.filter(({ state }) => state === 'answered').length,
    waitingSeconds: covered(visit.inbox.map(({ start, end }) => [start, end ?? now])) / 1000,
    notes: notesOf(input, visit, now, tasks),
    tasks: tasksOf(visit.attempts, tasks, now),
    questions: visit.inbox.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
      askedAt: item.created_at,
      waitedSeconds: item.end === null ? null : (item.end - item.start) / 1000,
      answer: actionOf(item),
      comment: commentOf(item),
    })),
  });

  const scopes = [0, ...[...input.milestones].sort((a, b) => a.n - b.n).map(({ n }) => n)];
  const sections = scopes.map((scope): LedgerSection => {
    const mine = visits.filter((visit) => visit.scope === scope).map(toVisit);
    const milestone = input.milestones.find(({ n }) => n === scope);
    const title = scope === 0 ? 'Project setup' : `M${scope} ${milestone?.title ?? ''}`.trim();
    const first = mine[0];
    const last = Math.max(...mine.map((visit) => (visit.to === null ? now : ms(visit.to))));
    return {
      scope,
      title,
      visits: mine,
      seconds: first ? (last - ms(first.from)) / 1000 : 0,
      runs: mine.reduce((n, visit) => n + visit.runs, 0),
      failed: mine.reduce((n, visit) => n + visit.failed, 0),
      usdEst: addUsd(mine.map((visit) => visit.usdEst)),
      decisions: mine.reduce((n, visit) => n + visit.answered, 0),
      loops: mine.filter((visit) => visit.back).length,
    };
  });
  return { sections };
}

export async function projectLedger(deps: { store: Store; log: EventLog }, project: ProjectRow, now: Date): Promise<Ledger> {
  const [milestones, tasks, attempts, inbox, events] = await Promise.all([
    deps.store.listMilestones(project.id),
    deps.store.listTasks(project.id),
    deps.store.listProjectAttempts(project.id),
    deps.store.listInbox({ projectId: project.id }),
    deps.log.list({ projectId: project.id, workerLines: false }),
  ]);
  return buildLedger({ project, milestones, tasks, attempts, inbox, events, now });
}
