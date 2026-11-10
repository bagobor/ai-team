import type { EventRow, EventType } from '../src/events.ts';
import type { InboxAnswer, InboxRef, InboxRow, InboxState } from '../src/engine/inbox.ts';
import { buildLedger, type LedgerInput, type LedgerVisit } from '../src/engine/ledger.ts';
import type { AttemptRow, MilestoneRow, ProjectRow, TaskRow } from '../src/engine/store.ts';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const project = { id: 1, name: 'p', repo_path: '/repo', base_branch: 'main', created_at: at(0), phase: 'active', prototyping: 0 } as ProjectRow;
const milestone = (n: number, title: string) => ({ project_id: 1, n, title, goal: '', phase: 'build' }) as MilestoneRow;

let seq = 0;
const event = (s: number, type: EventType, payload: Record<string, unknown>): EventRow => ({ seq: ++seq, ts: at(s), projectId: 1, taskId: null, attemptId: null, type, payload });
const phase = (s: number, from: string, to: string) => event(s, 'project.phase', { from, to });
const mPhase = (s: number, n: number, from: string, to: string) => event(s, 'milestone.phase', { milestone: n, from, to });

const ask = (id: number, s: number, ref: InboxRef, state: InboxState, answer: InboxAnswer | null = null, answeredAt: number | null = null, title = `Question ${id}`) =>
  ({ id, project_id: 1, milestone: 'milestone' in ref ? ref.milestone : null, ref, title, state, answer, answered_at: answeredAt === null ? null : at(answeredAt), created_at: at(s) }) as InboxRow;

const task = (id: number, ticketId: string, milestoneN: number, s: number, extra: Partial<TaskRow> = {}) =>
  ({ id, project_id: 1, ticket_id: ticketId, title: `Do ${ticketId}`, milestone: milestoneN, role_id: 'engineer', kind: 'ticket', purpose: null, parent_task_id: null, created_at: at(s), ...extra }) as TaskRow;

const attempt = (id: number, taskId: number, k: number, from: number, to: number | null, state: string, usd: number, failureKind: string | null = null) =>
  ({ id, task_id: taskId, k, state, failure_kind: failureKind, started_at: at(from), ended_at: to === null ? null : at(to), usage: { usdEst: usd } }) as AttemptRow;

const stages = (visits: LedgerVisit[]) => visits.map(({ stage, round }) => `${stage}#${round}`);

// An item the test needs: a missing one fails the test here.
const nth = <T,>(items: readonly T[], i: number): T => {
  const item = items.at(i);
  if (item === undefined) throw new Error(`Nothing at ${i}`);
  return item;
};

describe('the iteration ledger', () => {
  // Discovery goes back once from CP1; milestone 1 fails verification once, takes one polish round and is building now.
  const input: LedgerInput = {
    project,
    milestones: [milestone(1, 'Core loop')],
    tasks: [
      task(1, 'M1-T-1', 1, 700),
      task(2, 'M1-T-1-review', 1, 790, { kind: 'code_review', role_id: 'tech_lead', parent_task_id: 1 }),
      task(3, 'M1-E-1', 1, 1210, { title: 'Tighten input' }),
    ],
    attempts: [attempt(1, 1, 1, 710, 760, 'failed', 0.5, 'check_failed'), attempt(2, 1, 2, 765, 790, 'succeeded', 0.3), attempt(3, 2, 1, 791, 799, 'succeeded', 0.1), attempt(4, 3, 1, 1250, null, 'running', 0)],
    inbox: [
      ask(1, 99, { kind: 'cp1' }, 'answered', { action: 'request_changes', comment: 'Make it faster' }, 190),
      ask(2, 299, { kind: 'cp1' }, 'answered', { action: 'approve' }, 390),
      ask(3, 499, { kind: 'cp2', milestone: 1 }, 'answered', { action: 'approve' }, 590),
      ask(4, 850, { kind: 'cr', cr: 'CR-1' }, 'answered', { action: 'approve' }, 880, 'Slow the enemies down'),
    ],
    events: [
      phase(10, 'intake', 'discovery'),
      phase(100, 'discovery', 'cp1'),
      phase(200, 'cp1', 'discovery'),
      phase(300, 'discovery', 'cp1'),
      phase(400, 'cp1', 'active'),
      mPhase(401, 1, 'pending', 'spec'),
      mPhase(500, 1, 'spec', 'cp2'),
      mPhase(600, 1, 'cp2', 'design'),
      mPhase(700, 1, 'design', 'build'),
      mPhase(800, 1, 'build', 'verify'),
      event(850, 'ac.status', { acId: 'AC-1', status: 'failing' }),
      event(880, 'artifact.status', { id: 'CR-1', status: 'approved' }),
      mPhase(900, 1, 'verify', 'build'),
      mPhase(1000, 1, 'build', 'verify'),
      event(1050, 'ac.status', { acId: 'AC-1', status: 'passing' }),
      mPhase(1100, 1, 'verify', 'eng_review'),
      mPhase(1200, 1, 'eng_review', 'build'),
    ],
    now: new Date(at(1500)),
  };
  const ledger = buildLedger(input);
  const setup = nth(ledger.sections, 0);
  const m1 = nth(ledger.sections, 1);
  const visit = (visits: LedgerVisit[], name: string) => visits.find((v) => `${v.stage}#${v.round}` === name) as LedgerVisit;

  it('lists every visit to every stage, numbering repeat visits', () => {
    expect(ledger.sections.map(({ title }) => title)).toEqual(['Project setup', 'M1 Core loop']);
    expect(stages(setup.visits)).toEqual(['intake#1', 'discovery#1', 'cp1#1', 'discovery#2', 'cp1#2']);
    expect(stages(m1.visits)).toEqual(['spec#1', 'cp2#1', 'design#1', 'build#1', 'verify#1', 'build#2', 'verify#2', 'eng_review#1', 'build#3']);
  });

  it('marks a visit that went back to an earlier stage', () => {
    expect(setup.visits.filter((v) => v.back).map((v) => `${v.stage}#${v.round}`)).toEqual(['cp1#1']);
    expect(m1.visits.filter((v) => v.back).map((v) => `${v.stage}#${v.round}`)).toEqual(['verify#1', 'eng_review#1']);
    expect(visit(setup.visits, 'cp1#2')).toMatchObject({ exit: 'active', back: false });
    expect([setup.loops, m1.loops]).toEqual([1, 2]);
  });

  it('puts a gate request in the gate it opens, with the answer and how long it waited', () => {
    const cp1 = visit(setup.visits, 'cp1#1');
    expect(cp1.questions).toMatchObject([{ id: 1, answer: 'request_changes', comment: 'Make it faster', waitedSeconds: 91 }]);
    expect(cp1).toMatchObject({ asked: 1, answered: 1, waitingSeconds: 91 });
    expect(cp1.notes).toContainEqual({ kind: 'you', text: 'You asked for changes on CP1', quote: 'Make it faster' });
    expect(visit(setup.visits, 'cp1#2').notes).toContainEqual({ kind: 'ok', text: 'You approved CP1' });
    expect(visit(m1.visits, 'cp2#1').questions.map(({ id }) => id)).toEqual([3]);
  });

  it('says why verification went back: failing criteria and an approved change request', () => {
    const verify = visit(m1.visits, 'verify#1');
    expect(verify.notes).toContainEqual({ kind: 'fail', text: 'AC-1 failing' });
    expect(verify.notes).toContainEqual({ kind: 'loop', text: 'CR-1 approved, changing the milestone' });
    expect(verify.notes).toContainEqual({ kind: 'you', text: 'You decided 1 change request: 1 approved, 0 rejected', list: ['CR-1 approved: Slow the enemies down'] });
    expect(visit(m1.visits, 'verify#2').notes).toContainEqual({ kind: 'ok', text: '1 criterion passing' });
  });

  it('names the polish tickets an eng review opened', () => {
    expect(visit(m1.visits, 'eng_review#1').notes).toContainEqual({ kind: 'loop', text: 'Eng Lead opened 1 polish ticket', list: ['M1-E-1: Tighten input'] });
  });

  it('folds a code review under the ticket it reviewed and adds up the runs', () => {
    const build = visit(m1.visits, 'build#1');
    expect(build).toMatchObject({ runs: 3, failed: 1, seconds: 100 });
    expect(build.usdEst).toBeCloseTo(0.9);
    expect(build.tasks).toHaveLength(1);
    expect(nth(build.tasks, 0)).toMatchObject({ ticketId: 'M1-T-1', runs: [{ outcome: 'fail', failureKind: 'check_failed', review: false }, { outcome: 'ok', review: false }, { outcome: 'ok', review: true, seconds: 8 }] });
  });

  it('shows the visit in progress as running now', () => {
    const build = visit(m1.visits, 'build#3');
    expect(build).toMatchObject({ to: null, exit: null, seconds: 300 });
    expect(build.notes.at(-1)).toEqual({ kind: 'run', text: 'Running now: M1-E-1' });
    expect(nth(nth(build.tasks, 0).runs, 0)).toMatchObject({ outcome: 'run', seconds: 250 });
  });

  it('totals each section', () => {
    expect(m1).toMatchObject({ runs: 4, failed: 1, decisions: 2, seconds: 1099 });
    expect(setup).toMatchObject({ runs: 0, decisions: 2, seconds: 400, usdEst: null });
  });
});

describe('the end of a milestone', () => {
  const input: LedgerInput = {
    project,
    milestones: [milestone(1, 'Core loop'), milestone(2, 'Bosses')],
    tasks: [],
    attempts: [],
    inbox: [
      ask(1, 49, { kind: 'cp4', milestone: 1 }, 'withdrawn'),
      ask(2, 69, { kind: 'cp4', milestone: 1 }, 'answered', { action: 'approve', checks: [{ ac: 'AC-2', status: 'passing', note: '' }] }, 80),
    ],
    events: [
      phase(10, 'intake', 'discovery'),
      phase(20, 'discovery', 'cp1'),
      phase(30, 'cp1', 'active'),
      mPhase(50, 1, 'milestone_review', 'cp4'),
      event(60, 'inbox.withdrawn', { reason: 'The build changed under it' }),
      mPhase(60, 1, 'cp4', 'build'),
      mPhase(70, 1, 'build', 'cp4'),
      mPhase(80, 1, 'cp4', 'merging'),
      mPhase(81, 1, 'merging', 'merged'),
      mPhase(82, 2, 'pending', 'spec'),
      phase(90, 'active', 'halted'),
    ],
    now: new Date(at(5000)),
  };
  const { sections } = buildLedger(input);
  const m1 = nth(sections, 1);
  const m2 = nth(sections, 2);

  it('says why a gate request was withdrawn', () => {
    expect(nth(m1.visits, 0)).toMatchObject({ stage: 'cp4', back: true, waitingSeconds: 11 });
    expect(nth(m1.visits, 0).notes).toContainEqual({ kind: 'loop', text: 'CP4 request withdrawn before you answered: The build changed under it' });
  });

  it('ends a merged milestone on one merged row', () => {
    expect(stages(m1.visits)).toEqual(['cp4#1', 'build#1', 'cp4#2', 'merged#1']);
    expect(m1.visits.at(-1)).toMatchObject({ stage: 'merged', seconds: 0, back: false });
    expect(m1.visits.at(-1)?.notes).toEqual([{ kind: 'ok', text: 'You approved the merge with 1 check marked' }]);
  });

  it('stops the clock when the project halts, without calling it a loop', () => {
    expect(m2.visits).toMatchObject([{ stage: 'spec', exit: 'halted', back: false, seconds: 8 }]);
    expect(nth(m2.visits, 0).notes).toEqual([]);
  });

  it('keeps a gate answered at once in its own row', () => {
    const quick = buildLedger({
      ...input,
      inbox: [ask(9, 19.8, { kind: 'cp1' }, 'answered', { action: 'approve' }, 20.3)],
      events: [phase(10, 'intake', 'discovery'), phase(20, 'discovery', 'cp1'), phase(20.4, 'cp1', 'active'), mPhase(20.5, 1, 'pending', 'spec')],
    });
    expect(nth(quick.sections, 0).visits.at(-1)).toMatchObject({ stage: 'cp1', asked: 1, answered: 1 });
    expect(nth(nth(quick.sections, 1).visits, 0)).toMatchObject({ stage: 'spec', asked: 0 });
  });

  it('says only that it waits for you while a gate is open', () => {
    const waiting = buildLedger({ ...input, inbox: [ask(9, 69, { kind: 'cp4', milestone: 1 }, 'pending')], events: input.events.slice(0, 7) });
    expect(nth(waiting.sections, 1).visits.at(-1)?.notes).toEqual([{ kind: 'you', text: 'Waiting for you on CP4' }]);
  });

  it('leaves a milestone that never started empty', () => {
    const m3 = nth(buildLedger({ ...input, milestones: [...input.milestones, milestone(3, 'Polish')] }).sections, 3);
    expect(m3).toMatchObject({ title: 'M3 Polish', visits: [], seconds: 0 });
  });
});
