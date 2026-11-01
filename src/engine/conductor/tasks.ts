import { parsePin } from '../../artifacts/format.ts';
import { ENV_PROFILE } from '../apply/ids.ts';
import { IllegalTransition } from '../fsm.ts';
import type { InboxOption, InboxRow, NewInboxItem } from '../inbox.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { ArtifactVersionRow, AttemptRow, ProjectRow, Store, TaskRow } from '../store.ts';
import type { Purpose, TaskKind, WorkOrder } from '../workorder.ts';

export type TaskSpec = {
  project: ProjectRow;
  ticket_id: string;
  title: string;
  milestone: number;
  role_id: string;
  kind: TaskKind;
  order?: WorkOrder;
  parent_task_id?: number;
  depends_on?: string[];
  touches?: string[];
  dod?: string[];
  ticket_path?: string;
  ticket_sha?: string;
  ac_refs?: string[];
};

export const DISCOVERY_DOCS = ['ROADMAP', 'TEAM-PROPOSAL', 'HUMAN-REQUIREMENTS'];
export const RETRY_OR_HALT: InboxOption[] = [
  { id: 'retry', label: 'Retry' },
  { id: 'halt', label: 'Halt' },
];

export const pinOf = (row: Pick<ArtifactVersionRow, 'artifact_id' | 'version'>) => `${row.artifact_id}@${row.version}`;
export const isClosed = (task: Pick<TaskRow, 'state'>) => task.state === 'done' || task.state === 'cancelled';
export const isTerminal = (project: Pick<ProjectRow, 'phase'>) => project.phase === 'closed' || project.phase === 'halted';
export const roundId = (base: string, round: number) => (round <= 1 ? base : `${base}-r${round}`);

// The highest round of a task that can be redone: `base` is round 1 and `base-r<k>` is round k. No task at all is round 0.
export function roundOf(tasks: TaskRow[], base: string): number {
  let round = 0;
  for (const { ticket_id } of tasks) {
    if (ticket_id === base) round = Math.max(round, 1);
    else if (ticket_id.startsWith(`${base}-r`)) {
      const k = Number(ticket_id.slice(base.length + 2));
      if (Number.isInteger(k)) round = Math.max(round, k);
    }
  }
  return round;
}

export async function latestPin(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, id: string): Promise<string> {
  const row = await deps.artifacts.latest(project.id, id);
  if (!row) throw new Error(`${id} does not exist`);
  return pinOf(row);
}

export async function lastSucceeded(store: Store, taskId: number): Promise<AttemptRow | undefined> {
  return (await store.listAttempts(taskId)).filter((attempt) => attempt.state === 'succeeded').at(-1);
}

export async function noteOf(store: Store, taskId: number): Promise<string> {
  const output = (await lastSucceeded(store, taskId))?.output as { stakeholder_note?: unknown } | null | undefined;
  return typeof output?.stakeholder_note === 'string' ? output.stakeholder_note.trim() : '';
}

export async function ensureTask(s: Store, spec: TaskSpec): Promise<TaskRow> {
  const existing = await s.getTaskByTicket(spec.project.id, spec.ticket_id);
  if (existing) return existing;
  return s.createTask({
    project_id: spec.project.id,
    ticket_id: spec.ticket_id,
    title: spec.title,
    milestone: spec.milestone,
    role_id: spec.role_id,
    kind: spec.kind,
    ...(spec.order ? { purpose: spec.order.purpose, work_order: spec.order } : {}),
    ...(spec.parent_task_id === undefined ? {} : { parent_task_id: spec.parent_task_id }),
    ticket_path: spec.ticket_path ?? '',
    ticket_sha: spec.ticket_sha ?? '',
    touches: spec.touches ?? [],
    depends_on: spec.depends_on ?? [],
    dod: spec.dod ?? [],
    ac_refs: spec.ac_refs ?? [],
  });
}

const isOpenItem = (item: InboxRow) => item.state === 'pending' || (item.state === 'answered' && item.applied_at === null);

export async function openHold(s: Store, project: ProjectRow, prefix: string): Promise<InboxRow | undefined> {
  return (await s.inboxByPrefix(project.id, `${prefix}:`)).find(isOpenItem);
}

// A Retry that fails again asks again: the count in the key moves on, where a fixed key would land on the old item and go quiet.
export async function raiseHold(s: Store, project: ProjectRow, prefix: string, item: Omit<NewInboxItem, 'project_id' | 'dedupe_key'>): Promise<InboxRow> {
  const earlier = await s.inboxByPrefix(project.id, `${prefix}:`);
  return earlier.find(isOpenItem) ?? s.raiseInbox({ ...item, project_id: project.id, dedupe_key: `${prefix}:${earlier.length + 1}` });
}

export async function stopProjectWork(deps: Pick<EngineDeps, 'store'>, runner: Runner, project: ProjectRow): Promise<void> {
  for (const { id } of await deps.store.listTasks(project.id)) {
    const task = await deps.store.getTask(id);
    if (!task || isClosed(task)) continue;
    try {
      await runner.cancel(id);
    } catch (err) {
      // Only a closed task refuses cancelling, so this one finished after it was read.
      if (!(err instanceof IllegalTransition)) throw err;
    }
  }
}

export async function markHalted(s: Store, project: ProjectRow, reason: string): Promise<void> {
  for (const item of await s.listInbox({ projectId: project.id, state: 'pending' })) await s.withdrawInbox(item.id, reason);
  for (const { n, phase } of await s.listMilestones(project.id)) {
    if (phase !== 'merged' && phase !== 'halted') await s.setMilestonePhase(project.id, n, 'halted');
  }
  const current = await s.getProjectById(project.id);
  if (current && !isTerminal(current)) await s.setProjectPhase(project.id, 'halted');
}

export async function haltProject(deps: Pick<EngineDeps, 'store'>, runner: Runner, project: ProjectRow, reason: string): Promise<void> {
  await stopProjectWork(deps, runner, project);
  await deps.store.atomically((s) => markHalted(s, project, reason));
}

const workOrder = (purpose: Purpose, instructions: string, inputs: string[], base: WorkOrder['base'], extra: Pick<WorkOrder, 'comment' | 'subject'> = {}): WorkOrder => ({ purpose, instructions, inputs, checks: [], base, ...extra });
const withComment = (comment: string | undefined) => (comment === undefined ? {} : { comment });
const INTEGRATION: WorkOrder['base'] = { kind: 'integration' };
const BASE: WorkOrder['base'] = { kind: 'base' };

// Project-level tasks use milestone 0: they belong to no milestone, and the column can't be empty.
export function discoveryTask(project: ProjectRow, round: number, inputs: string[], comment?: string): TaskSpec {
  return {
    project,
    ticket_id: roundId('DISCOVERY-PM', round),
    title: 'Discovery: Roadmap, Team Proposal and Human Requirements',
    milestone: 0,
    role_id: 'pm',
    kind: 'authoring',
    order: workOrder('discovery', 'Turn the Brief into a Roadmap, a Team Proposal and Human Requirements. Keep the Roadmap to milestones that each deliver something the stakeholder can check.', inputs, BASE, withComment(comment)),
  };
}

export function profileTask(project: ProjectRow, round: number, inputs: string[], comment?: string): TaskSpec {
  return {
    project,
    ticket_id: roundId('DISCOVERY-TL', round),
    title: 'Discovery: Environment Profile',
    milestone: 0,
    role_id: 'tech_lead',
    kind: 'authoring',
    depends_on: [roundId('DISCOVERY-PM', round)],
    order: workOrder('environment_profile', 'Write the Environment Profile: the toolchains, the build, test, lint and smoke commands, any setup command, and the network hosts the work needs. The smoke command must pass in this repository as it stands.', inputs, BASE, withComment(comment)),
  };
}

export function specTask(project: ProjectRow, n: number, round: number, inputs: string[], comment?: string): TaskSpec {
  return {
    project,
    ticket_id: roundId(`M${n}-SPEC`, round),
    title: `Milestone ${n}: Spec`,
    milestone: n,
    role_id: 'pm',
    kind: 'authoring',
    order: workOrder('milestone_spec', `Write the Spec for milestone ${n} from the Roadmap and the Human Requirements, with acceptance criteria that an automated command can verify.`, inputs, BASE, withComment(comment)),
  };
}

export function techTask(project: ProjectRow, n: number, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-TECH`,
    title: `Milestone ${n}: Tech Design`,
    milestone: n,
    role_id: 'tech_lead',
    kind: 'authoring',
    order: workOrder('tech_design', `Write the Tech Design for milestone ${n} and split the work into tickets. Every acceptance criterion must be covered by a ticket.`, inputs, INTEGRATION),
  };
}

export function testPlanTask(project: ProjectRow, n: number, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-TESTPLAN`,
    title: `Milestone ${n}: Test Plan`,
    milestone: n,
    role_id: 'qa_engineer',
    kind: 'authoring',
    order: workOrder('test_plan', `Write the Test Plan for milestone ${n}. Name the commands that verify each acceptance criterion, and add harness tickets for anything those commands need that doesn't exist yet.`, inputs, INTEGRATION),
  };
}

export function qaTask(project: ProjectRow, n: number, round: number, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-QA-${round}`,
    title: `Milestone ${n}: QA round ${round}`,
    milestone: n,
    role_id: 'qa_engineer',
    kind: 'qa_verify',
    order: workOrder('qa_verify', `Verify every acceptance criterion of milestone ${n} on the integration branch. Report a Bug for each criterion that fails.`, inputs, INTEGRATION),
  };
}

export function milestoneReviewTask(project: ProjectRow, n: number, round: number, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-REVIEW-${round}`,
    title: `Milestone ${n}: Milestone Review`,
    milestone: n,
    role_id: 'pm',
    kind: 'authoring',
    order: workOrder('milestone_review', `Write the Milestone Review of milestone ${n} for the stakeholder: what was built, known issues, and any deviations from the Spec.`, inputs, INTEGRATION),
  };
}

const decideTickets = (open: string[]) => (open.length > 0 ? ` Decide on each open ticket, still valid or superseded: ${open.join(', ')}.` : '');

export function replanTask(project: ProjectRow, n: number, k: number, inputs: string[], comment: string, open: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-REPLAN-${k}`,
    title: `Milestone ${n}: Replan after the stakeholder's comment`,
    milestone: n,
    role_id: 'tech_lead',
    kind: 'authoring',
    order: workOrder('revise_design', `The stakeholder asked for changes at the end of milestone ${n}. Revise the Tech Design and add the tickets their comment calls for.${decideTickets(open)}`, inputs, INTEGRATION, { comment }),
  };
}

export function reviseTask(project: ProjectRow, n: number, doc: ArtifactVersionRow, k: number, purpose: 'revise_design' | 'revise_test_plan', inputs: string[], open: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-REVISE-${doc.artifact_id}-${k}`,
    title: `Milestone ${n}: Revise ${doc.artifact_id}`,
    milestone: n,
    role_id: doc.owner_role,
    kind: 'authoring',
    order: workOrder(purpose, `What ${doc.artifact_id} was based on has changed. Revise it, or say why it is unaffected.${decideTickets(open)}`, inputs, INTEGRATION),
  };
}

export function recommendationTask(project: ProjectRow, crId: string, target: ArtifactVersionRow, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: `${crId}-REC`,
    title: `Recommendation on ${crId}`,
    milestone: target.milestone ?? 0,
    role_id: target.owner_role,
    kind: 'authoring',
    order: workOrder('cr_recommendation', `${crId} asks to change ${target.artifact_id}, which your role owns. Recommend approving or rejecting it, and say why.`, inputs, target.milestone === null ? BASE : INTEGRATION),
  };
}

export function codeReviewTask(project: ProjectRow, ticket: TaskRow, attempt: AttemptRow, headSha: string, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: `${ticket.ticket_id}-R${attempt.k}`,
    title: `Review of ${ticket.ticket_id}, attempt ${attempt.k}`,
    milestone: ticket.milestone,
    role_id: 'code_reviewer',
    kind: 'code_review',
    parent_task_id: ticket.id,
    order: workOrder('code_review', `Review the change attempt ${attempt.k} made for ${ticket.ticket_id}. Approve it or request changes.`, inputs, { kind: 'sha', sha: headSha }, { subject: { ticketTaskId: ticket.id, attemptId: attempt.id } }),
  };
}

export type TicketFields = { title: string; specialty: string; touches: string[]; depends_on: string[]; definition_of_done: string[]; ac_refs: string[] };

export function ticketTask(project: ProjectRow, milestone: number, row: ArtifactVersionRow, fields: TicketFields): TaskSpec {
  return {
    project,
    ticket_id: row.artifact_id,
    title: fields.title,
    milestone,
    role_id: fields.specialty,
    kind: 'ticket',
    touches: fields.touches,
    depends_on: fields.depends_on,
    dod: fields.definition_of_done,
    ac_refs: fields.ac_refs,
    ticket_path: row.path,
    ticket_sha: row.sha,
  };
}

// What a revision reads: the newest version of each source of the document, then the document itself.
export async function reviseInputs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, doc: ArtifactVersionRow): Promise<string[]> {
  const sources = [...new Set(doc.derived_from.map((pin) => parsePin(pin).id))].filter((id) => id !== doc.artifact_id);
  const pins: string[] = [];
  for (const id of sources) {
    const row = await deps.artifacts.latest(project.id, id);
    if (row) pins.push(pinOf(row));
  }
  return [...pins, pinOf(doc)];
}

// The Tech Lead reworks its profile alongside the PM's new documents, which don't exist until the PM finishes: an unversioned pin reads the latest.
export async function discoveryInputs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<{ pm: string[]; profile: string[] }> {
  const brief = await latestPin(deps, project, 'BRIEF');
  const prior = await Promise.all(DISCOVERY_DOCS.map((id) => deps.artifacts.latest(project.id, id)));
  const priorProfile = await deps.artifacts.latest(project.id, ENV_PROFILE);
  return {
    pm: [brief, ...prior.flatMap((row) => (row ? [pinOf(row)] : []))],
    profile: [brief, ...DISCOVERY_DOCS, ...(priorProfile ? [pinOf(priorProfile)] : [])],
  };
}
