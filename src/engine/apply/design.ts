import { ArtifactError, parsePin, sectionText, formatPin, type ArtifactStatus } from '../../artifacts/format.ts';
import type { NewVersion, StatusChange } from '../../artifacts/store.ts';
import type { EngineDeps } from '../runner.ts';
import type { ArtifactVersionRow, CriterionRow, ProjectRow, TaskRow } from '../store.ts';
import { techId, testPlanId } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';
import { validateTickets, type TicketDraft } from './tickets.ts';

export type Coverage = { ac: string; commands: string[]; notes: string };
type DesignOutput = { body: string; tickets: TicketDraft[] };
type TestPlanOutput = { body: string; coverage: Coverage[]; harness_tickets: TicketDraft[] };
type Decision = { ticket: string; decision: 'still_valid' | 'superseded'; rationale: string };
type ReviseOutput = { unaffected: boolean; rationale: string; body: string | null; coverage: Coverage[] | null; ticket_decisions: Decision[]; tickets: TicketDraft[] };

type Prefix = 'T' | 'Q';

async function lockedCriteria(ctx: ApplyCtx): Promise<CriterionRow[]> {
  const criteria = await ctx.deps.store.listCriteria(ctx.project.id, ctx.task.milestone);
  if (criteria.length === 0) throw new Error(`Milestone ${ctx.task.milestone} has no locked criteria`);
  return criteria;
}

async function knownTickets(ctx: ApplyCtx): Promise<string[]> {
  const { store, artifacts } = ctx.deps;
  const tasks = await store.listTasks(ctx.project.id);
  const rows = await artifacts.list(ctx.project.id);
  return [...new Set([...tasks.filter((task) => task.kind === 'ticket').map((task) => task.ticket_id), ...rows.filter((row) => row.type === 'ticket').map((row) => row.artifact_id)])];
}

const uncovered = (acIds: string[], covered: string[]) => acIds.filter((ac) => !covered.includes(ac)).map((ac) => `${ac} has no ticket`);

function coverageProblems(acIds: string[], coverage: Coverage[]): string[] {
  const problems: string[] = [];
  for (const ac of acIds) {
    const rows = coverage.filter((row) => row.ac === ac);
    if (rows.length === 0) problems.push(`${ac} is not in the coverage`);
    if (rows.length > 1) problems.push(`${ac} is in the coverage more than once`);
    if (rows.some((row) => row.commands.length === 0 || row.commands.some((command) => command.trim() === ''))) problems.push(`${ac} needs at least one command, and no blank ones`);
  }
  for (const { ac } of coverage) if (!acIds.includes(ac)) problems.push(`${ac} is in the coverage, but this milestone does not have it`);
  return problems;
}

const designDoc = (ctx: ApplyCtx, body: string, status: ArtifactStatus = 'approved'): NewVersion => ({
  id: techId(ctx.task.milestone),
  type: 'tech_design',
  status,
  ownerRole: 'tech_lead',
  approvedBy: 'owner:tech_lead',
  milestone: ctx.task.milestone,
  derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== techId(ctx.task.milestone)),
  body,
});

const testPlanDoc = (ctx: ApplyCtx, body: string, coverage: Coverage[], status: ArtifactStatus = 'approved'): NewVersion => ({
  id: testPlanId(ctx.task.milestone),
  type: 'test_plan',
  status,
  ownerRole: 'qa_engineer',
  approvedBy: 'owner:qa_engineer',
  milestone: ctx.task.milestone,
  derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== testPlanId(ctx.task.milestone)),
  body,
  fields: { data: { coverage } },
});

export const applyTechDesign: Applier = async (ctx) => {
  const { body, tickets } = ctx.output as DesignOutput;
  const { milestone } = ctx.task;
  const acIds = (await lockedCriteria(ctx)).map(({ ac_id }) => ac_id);

  const validated = await validateTickets(ctx, milestone, tickets, acIds, await knownTickets(ctx), 'T', body);
  const problems = [...(validated.ok ? [] : [validated.evidence]), ...uncovered(acIds, tickets.flatMap(({ ac_refs }) => ac_refs))];
  if (!validated.ok || problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  return withRaised(ctx, { message: `milestone ${milestone}: tech design`, publish: [designDoc(ctx, body), ...validated.docs] });
};

export const applyTestPlan: Applier = async (ctx) => {
  const { body, coverage, harness_tickets } = ctx.output as TestPlanOutput;
  const { milestone } = ctx.task;
  const acIds = (await lockedCriteria(ctx)).map(({ ac_id }) => ac_id);

  const validated = await validateTickets(ctx, milestone, harness_tickets, acIds, await knownTickets(ctx), 'Q', body);
  const problems = [...(validated.ok ? [] : [validated.evidence]), ...coverageProblems(acIds, coverage)];
  if (!validated.ok || problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  return withRaised(ctx, { message: `milestone ${milestone}: test plan`, publish: [testPlanDoc(ctx, body, coverage), ...validated.docs] });
};

export type TicketOfDoc = { id: string; row: ArtifactVersionRow | undefined; task: TaskRow | undefined; acRefs: string[]; dependsOn: string[] };

const CLOSED = ['done', 'cancelled'];
const isClosed = ({ task }: TicketOfDoc) => task !== undefined && CLOSED.includes(task.state);

// A revise speaks for its own document's tickets. Otherwise the two revisions that can run together would both decide
// the same tickets, and the QA Engineer could cancel the Tech Lead's work.
async function ticketsOfDoc(deps: Pick<EngineDeps, 'store' | 'artifacts'>, project: ProjectRow, milestone: number, prefix: Prefix): Promise<TicketOfDoc[]> {
  const mine = (id: string) => /-Q-\d+$/.test(id) === (prefix === 'Q');
  const rows = (await deps.artifacts.list(project.id)).filter((row) => row.type === 'ticket' && row.milestone === milestone && mine(row.artifact_id));
  const tasks = (await deps.store.listTasks(project.id)).filter((task) => task.kind === 'ticket' && task.milestone === milestone && mine(task.ticket_id));

  const tickets: TicketOfDoc[] = [];
  for (const id of new Set([...rows.map((row) => row.artifact_id), ...tasks.map((task) => task.ticket_id)])) {
    const row = rows.find((candidate) => candidate.artifact_id === id);
    if (row?.status === 'superseded') continue;
    const task = tasks.find((candidate) => candidate.ticket_id === id);
    const fields = task ? undefined : (await deps.artifacts.read(project, id)).fields;
    tickets.push({ id, row, task, acRefs: task?.ac_refs ?? (fields!.ac_refs as string[]), dependsOn: task?.depends_on ?? (fields!.depends_on as string[]) });
  }
  return tickets;
}

// The tickets a revise must decide on, which its work order lists for the worker.
export async function openTickets(deps: Pick<EngineDeps, 'store' | 'artifacts'>, project: ProjectRow, milestone: number, prefix: Prefix): Promise<string[]> {
  return (await ticketsOfDoc(deps, project, milestone, prefix)).filter((ticket) => !isClosed(ticket)).map(({ id }) => id);
}

// Each pin moves to the latest version unless its section is gone from it, in which case the old pin says what was read.
async function repinned(ctx: ApplyCtx, row: ArtifactVersionRow, docId: string, newBody: string | null): Promise<string[]> {
  const pins: string[] = [];
  for (const text of row.derived_from) {
    const { id, section } = parsePin(text);
    const bare = formatPin({ id, ...(section === undefined ? {} : { section }) });
    if (section === undefined) {
      pins.push(bare);
    } else if (id === docId && newBody !== null) {
      pins.push(sectionText(newBody, section) === undefined ? text : bare);
    } else {
      const found = await ctx.deps.artifacts.readInput(ctx.project, bare).then(
        () => true,
        (err: unknown) => {
          if (err instanceof ArtifactError) return false;
          throw err;
        },
      );
      pins.push(found ? bare : text);
    }
  }
  return pins;
}

const CANCEL_IF = ['queued', 'ready', 'blocked', 'escalated', 'review', 'qa'];

// The work order froze what the worker read, so a source approved again since then is one it never saw. The document
// then stays stale, and the next round reads the newer version.
async function inputsMoved(ctx: ApplyCtx, docId: string): Promise<boolean> {
  for (const text of ctx.order.inputs) {
    const { id, version } = parsePin(text);
    if (id === docId || version === undefined) continue;
    const latest = await ctx.deps.artifacts.latest(ctx.project.id, id);
    if (latest && latest.version > version && (latest.status === 'approved' || latest.status === 'stale')) return true;
  }
  return false;
}

const applyRevise =
  (prefix: Prefix): Applier =>
  async (ctx) => {
    const output = ctx.output as ReviseOutput;
    const { milestone } = ctx.task;
    const acIds = (await lockedCriteria(ctx)).map(({ ac_id }) => ac_id);
    const docId = prefix === 'T' ? techId(milestone) : testPlanId(milestone);
    const body = output.unaffected ? null : output.body;

    const problems: string[] = [];
    if (!output.unaffected && (body === null || body.trim() === '')) problems.push('An affected document needs a new body');
    if (prefix === 'Q' && body !== null) {
      if (output.coverage === null) problems.push('A new Test Plan needs its full coverage');
      else problems.push(...coverageProblems(acIds, output.coverage));
    }

    const tickets = await ticketsOfDoc(ctx.deps, ctx.project, milestone, prefix);
    const open = tickets.filter((ticket) => !isClosed(ticket));
    // A ticket that isn't stale can merge while the worker decides on it, so a decision about a closed one is out of date, not wrong, and it can't undo that work.
    const closed = new Set(tickets.filter(isClosed).map(({ id }) => id));
    const current = output.ticket_decisions.filter(({ ticket }) => !closed.has(ticket));
    for (const { id } of open) {
      const count = current.filter(({ ticket }) => ticket === id).length;
      if (count === 0) problems.push(`Ticket ${id} is open and has no decision`);
      if (count > 1) problems.push(`Ticket ${id} must be decided exactly once`);
    }
    for (const { ticket } of current) if (!open.some(({ id }) => id === ticket)) problems.push(`Ticket ${ticket} is not an open ticket of this document`);

    const superseded = new Set(current.filter(({ decision }) => decision === 'superseded').map(({ ticket }) => ticket));
    const kept = tickets.filter(({ id, task }) => !superseded.has(id) && task?.state !== 'cancelled');
    for (const ticket of kept) {
      if (isClosed(ticket)) continue;
      for (const dep of ticket.dependsOn) if (superseded.has(dep)) problems.push(`Ticket ${ticket.id} stays but depends on ${dep}, which this revision supersedes`);
    }

    const validated = await validateTickets(ctx, milestone, output.tickets, acIds, await knownTickets(ctx), prefix, body ?? undefined);
    const newDocs = validated.ok ? validated.docs : [];
    if (!validated.ok) problems.push(validated.evidence);
    for (const doc of newDocs) for (const dep of doc.fields!.depends_on as string[]) if (superseded.has(dep)) problems.push(`Ticket ${doc.id} depends on ${dep}, which this revision supersedes`);

    if (prefix === 'T') problems.push(...uncovered(acIds, [...kept.flatMap(({ acRefs }) => acRefs), ...output.tickets.flatMap(({ ac_refs }) => ac_refs)]));
    if (problems.length > 0) return { ok: false, evidence: problems.join('\n') };

    const decisions = new Map(current.map((decision) => [decision.ticket, decision]));
    const settled = (await inputsMoved(ctx, docId)) ? 'stale' : 'approved';
    const status: StatusChange[] = [];
    if (body === null) status.push({ id: docId, status: settled, derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== docId), rationale: output.rationale });

    for (const ticket of tickets) {
      if (!ticket.row) continue; // Added by hand, so it has no artifact to change.
      const decision = decisions.get(ticket.id);
      if (decision?.decision === 'superseded') status.push({ id: ticket.id, status: 'superseded', rationale: decision.rationale });
      else status.push({ id: ticket.id, status: 'approved', approvedBy: 'owner:tech_lead', derivedFrom: await repinned(ctx, ticket.row, docId, body), rationale: decision?.rationale ?? `Closed before this revision of ${docId}` });
    }

    const publish = [...(body === null ? [] : [prefix === 'T' ? designDoc(ctx, body, settled) : testPlanDoc(ctx, body, output.coverage!, settled)]), ...newDocs];
    return withRaised(ctx, { message: `milestone ${milestone}: revise ${docId}`, publish, status }, async (s) => {
      for (const id of superseded) {
        const task = await s.getTaskByTicket(ctx.project.id, id);
        if (task && CANCEL_IF.includes(task.state)) await s.setTaskState(task.id, 'cancelled', { reason: 'superseded' });
      }
    });
  };

export const applyReviseDesign = applyRevise('T');
export const applyReviseTestPlan = applyRevise('Q');
