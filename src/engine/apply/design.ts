import { isDeepStrictEqual } from 'node:util';
import { isHumanCheck } from '../../artifacts/acs.ts';
import { ArtifactError, parsePin, sectionText, formatPin, type ArtifactDoc, type ArtifactStatus } from '../../artifacts/format.ts';
import type { NewVersion, StatusChange } from '../../artifacts/store.ts';
import { scriptProblems, type PlayScript } from '../../checks/play.ts';
import { proposesCurrent } from '../change-requests.ts';
import { isHarnessTicket, protectedGlobs, protectedProblems } from '../protected.ts';
import type { EngineDeps } from '../runner.ts';
import type { ArtifactVersionRow, CriterionRow, ProjectRow, TaskRow } from '../store.ts';
import { approvedProfile } from './discovery.ts';
import { techId, testPlanId } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';
import { validateTickets, type TicketDraft } from './tickets.ts';

// A play script proves a criterion only a browser can show, so an entry needs commands, a script, or both.
export type Coverage = { ac: string; commands: string[]; notes: string; regression?: boolean; play?: PlayScript };
type DesignOutput = { body: string; tickets: TicketDraft[] };
type TestPlanOutput = { body: string; coverage: Coverage[]; protected: string[]; harness_tickets: TicketDraft[] };
type Decision = { ticket: string; decision: 'still_valid' | 'superseded'; rationale: string };
// A revision rewrites every entry, so its play script is the replaced entry's unless the revision gives one, or null to clear it.
type Revised = Omit<Coverage, 'play'> & { play?: PlayScript | null };
type ReviseOutput = { unaffected: boolean; rationale: string; body: string | null; coverage: Revised[] | null; ticket_decisions: Decision[]; tickets: TicketDraft[] };

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

// A human check has no command, so the Test Plan covers the automated criteria only and leaves the rest to the stakeholder.
const automatedIds = (criteria: CriterionRow[]) => criteria.filter((criterion) => !isHumanCheck(criterion)).map(({ ac_id }) => ac_id);
const humanCheckIds = (criteria: CriterionRow[]) => criteria.filter(isHumanCheck).map(({ ac_id }) => ac_id);

// hasPlay is whether the Environment Profile says how to build and serve a page, which a play script needs.
function coverageProblems(acIds: string[], coverage: Coverage[], humanIds: string[], hasPlay: boolean): string[] {
  const problems: string[] = [];
  for (const ac of acIds) {
    const rows = coverage.filter((row) => row.ac === ac);
    if (rows.length === 0) problems.push(`${ac} is not in the coverage`);
    if (rows.length > 1) problems.push(`${ac} is in the coverage more than once`);
    if (rows.some((row) => (row.commands.length === 0 && row.play === undefined) || row.commands.some((command) => command.trim() === ''))) problems.push(`${ac} needs at least one command or a play script, and no blank commands`);
    for (const { play } of rows) {
      if (play === undefined) continue;
      if (!hasPlay) problems.push(`${ac} has a play script, but the Environment Profile has no play block, so there is no page to play`);
      problems.push(...scriptProblems(play).map((problem) => `${ac}'s play script: ${problem}`));
    }
  }
  for (const { ac } of coverage) {
    if (humanIds.includes(ac)) problems.push(`${ac} is checked by the stakeholder, so it has no place in the coverage`);
    else if (!acIds.includes(ac)) problems.push(`${ac} is in the coverage, but this milestone does not have it`);
  }
  return problems;
}

const hasPlayBlock = async (ctx: ApplyCtx): Promise<boolean> => ((await approvedProfile(ctx))?.play ?? null) !== null;

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

const testPlanDoc = (ctx: ApplyCtx, body: string, coverage: Coverage[], globs: string[], status: ArtifactStatus = 'approved'): NewVersion => ({
  id: testPlanId(ctx.task.milestone),
  type: 'test_plan',
  status,
  ownerRole: 'qa_engineer',
  approvedBy: 'owner:qa_engineer',
  milestone: ctx.task.milestone,
  derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== testPlanId(ctx.task.milestone)),
  body,
  fields: { data: { coverage, protected: globs } },
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
  const { body, coverage, harness_tickets, protected: globs } = ctx.output as TestPlanOutput;
  const { milestone } = ctx.task;
  const criteria = await lockedCriteria(ctx);
  const acIds = automatedIds(criteria);

  const validated = await validateTickets(ctx, milestone, harness_tickets, acIds, await knownTickets(ctx), 'Q', body);
  const problems = [...(validated.ok ? [] : [validated.evidence]), ...coverageProblems(acIds, coverage, humanCheckIds(criteria), await hasPlayBlock(ctx)), ...protectedProblems(globs)];
  if (!validated.ok || problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  return withRaised(ctx, { message: `milestone ${milestone}: test plan`, publish: [testPlanDoc(ctx, body, coverage, globs), ...validated.docs] });
};

export type TicketOfDoc = { id: string; row: ArtifactVersionRow | undefined; task: TaskRow | undefined; acRefs: string[]; dependsOn: string[] };

const CLOSED = ['done', 'cancelled'];
const isClosed = ({ task }: TicketOfDoc) => task !== undefined && CLOSED.includes(task.state);

// A revise speaks for its own document's tickets. Otherwise the two revisions that can run together would both decide
// the same tickets, and the QA Engineer could cancel the Tech Lead's work.
async function ticketsOfDoc(deps: Pick<EngineDeps, 'store' | 'artifacts'>, project: ProjectRow, milestone: number, prefix: Prefix): Promise<TicketOfDoc[]> {
  const mine = (id: string) => isHarnessTicket(id) === (prefix === 'Q');
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

const coverageOf = (doc: ArtifactDoc): Coverage[] => {
  const coverage = (doc.fields.data as { coverage?: unknown } | undefined)?.coverage;
  return Array.isArray(coverage) ? (coverage as Coverage[]) : [];
};

// The model is shown the play only in the reference file, and a play that is left out is not one to drop, as for the regression flag below.
// An entry that gives none takes the replaced version's; null clears it, and no key is stored for it.
function keepingPlays(revised: Revised[], replaced: ArtifactDoc): Coverage[] {
  const was = coverageOf(replaced);
  return revised.map(({ play, ...row }) => {
    const resolved = play === undefined ? was.find(({ ac }) => ac === row.ac)?.play : (play ?? undefined);
    return resolved === undefined ? row : { ...row, play: resolved };
  });
}

// The same script, whatever the order of the keys in the model's JSON.
const samePlay = (a: PlayScript | undefined, b: PlayScript | undefined): boolean => isDeepStrictEqual(a, b);

// An entry the revision writes without the flag takes the one the replaced Test Plan gave that criterion, but only for the commands and the play script the flag was approved on.
function keepingFlags(revised: Coverage[], replaced: ArtifactDoc): Coverage[] {
  const was = coverageOf(replaced);
  return revised.map((row) => {
    const before = was.find(({ ac }) => ac === row.ac);
    const flag = row.regression === undefined && before !== undefined && proposesCurrent(before, row.commands) && samePlay(before.play, row.play) ? before.regression : undefined;
    return flag === undefined ? row : { ...row, regression: flag };
  });
}

// The flag waives the check that an entry's commands fail on the base. QA can stale its own harness tickets with a request and so trigger its own revision,
// so a revision may keep or clear a flag but not add one to an entry the plan already had: that is a request the stakeholder decides.
function addedFlags(revised: Coverage[], replaced: ArtifactDoc, docId: string): string[] {
  const was = coverageOf(replaced);
  return revised
    .filter((row) => row.regression === true && was.some(({ ac, regression }) => ac === row.ac && regression !== true))
    .map(({ ac }) => `${ac} has no regression flag in ${docId}@${replaced.version}. A revision can keep or clear one, but not add it: raise a Change Request proposing ${ac}'s current commands, which the stakeholder decides.`);
}

// The flag was approved for the commands it was asked on, so a revision that changes them can't keep it, or QA could put vacuous commands under a guard.
// The same goes for the play script, which is as much of the entry's proof.
function movedFlags(revised: Coverage[], replaced: ArtifactDoc, docId: string): string[] {
  const was = coverageOf(replaced);
  const guards = (row: Coverage) => was.find((before) => before.ac === row.ac && before.regression === true);
  return revised
    .filter((row) => row.regression === true && guards(row) !== undefined)
    .flatMap((row) => {
      const before = guards(row) as Coverage;
      if (!proposesCurrent(before, row.commands)) {
        return [`${row.ac}'s commands differ from ${docId}@${replaced.version}, so its regression flag can't stay. A revision that changes a guard's commands drops the flag: raise a Change Request proposing ${row.ac}'s new commands once they are in, which the stakeholder decides.`];
      }
      return samePlay(before.play, row.play)
        ? []
        : [`${row.ac}'s play script differs from ${docId}@${replaced.version}, so its regression flag can't stay. A revision that changes a guard's play script drops the flag: raise a Change Request proposing ${row.ac}'s current commands, or the script's expect when it has none, which the stakeholder decides.`];
    });
}

const applyRevise =
  (prefix: Prefix): Applier =>
  async (ctx) => {
    const output = ctx.output as ReviseOutput;
    const { milestone } = ctx.task;
    const criteria = await lockedCriteria(ctx);
    // The Tech Design builds a human check like any other criterion, but only the Test Plan skips it.
    const acIds = prefix === 'T' ? criteria.map(({ ac_id }) => ac_id) : automatedIds(criteria);
    const docId = prefix === 'T' ? techId(milestone) : testPlanId(milestone);
    const body = output.unaffected ? null : output.body;

    // The version this one replaces is read first: its coverage limits the flags a revision may set, and, since a revision has no way to name protected paths, its globs carry over.
    const replaced = prefix === 'Q' && body !== null ? await ctx.deps.artifacts.read(ctx.project, docId) : undefined;

    const problems: string[] = [];
    if (!output.unaffected && (body === null || body.trim() === '')) problems.push('An affected document needs a new body');
    // Every rule runs on the entries as they will be published, with the replaced version's play scripts carried over.
    const carried = replaced === undefined || output.coverage === null ? undefined : keepingPlays(output.coverage, replaced);
    if (replaced !== undefined) {
      if (carried === undefined) problems.push('A new Test Plan needs its full coverage');
      else problems.push(...coverageProblems(acIds, carried, humanCheckIds(criteria), await hasPlayBlock(ctx)), ...addedFlags(carried, replaced, docId), ...movedFlags(carried, replaced, docId));
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

    const globs = replaced === undefined ? [] : protectedGlobs(replaced);
    // The revising model is shown the plan without its regression flags, so an entry that leaves one out keeps the replaced version's while its commands and play script stay the same, and only an explicit false clears it.
    const coverage = replaced === undefined || carried === undefined ? [] : keepingFlags(carried, replaced);
    const publish = [...(body === null ? [] : [prefix === 'T' ? designDoc(ctx, body, settled) : testPlanDoc(ctx, body, coverage, globs, settled)]), ...newDocs];
    return withRaised(ctx, { message: `milestone ${milestone}: revise ${docId}`, publish, status }, async (s) => {
      for (const id of superseded) {
        const task = await s.getTaskByTicket(ctx.project.id, id);
        if (task && CANCEL_IF.includes(task.state)) await s.setTaskState(task.id, 'cancelled', { reason: 'superseded' });
      }
    });
  };

export const applyReviseDesign = applyRevise('T');
export const applyReviseTestPlan = applyRevise('Q');
