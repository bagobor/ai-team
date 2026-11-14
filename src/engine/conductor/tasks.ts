import { formatPin, parsePin } from '../../artifacts/format.ts';
import { ENG_REVIEW_ID, ENV_PROFILE, FUN_DEFINITION, isPolishTicket, MUST_SUPPORT, PROTO_PLAN_ID, protoPlanId, techId } from '../apply/ids.ts';
import { oneLine } from '../apply/text.ts';
import { IllegalTransition } from '../fsm.ts';
import type { InboxOption, InboxRef, InboxRow, NewInboxItem } from '../inbox.ts';
import { gateStatuses, itemLine, STATUS_LABEL, type ItemStatus, type MsItem, type MustSupportData } from '../must-support.ts';
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
// A scope is held to the Tech Design's components, so it waits for the design that will stand: not a stale one, nor one being revised.
export const designMoving = (rows: Pick<ArtifactVersionRow, 'artifact_id' | 'status'>[], tasks: Pick<TaskRow, 'milestone' | 'purpose' | 'state'>[], n: number): boolean =>
  rows.some((row) => row.artifact_id === techId(n) && row.status === 'stale') || tasks.some(({ milestone, purpose, state }) => milestone === n && purpose === 'revise_design' && !isClosed({ state }));
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

// A role that reads the list is told what to do when it can't meet an item. The schemas of these purposes take gaps.
export const GAPS_LINE = "If an item on the must-support list can't be met, name it in gaps and say why. Never leave an item out silently.";
const GAP_PURPOSES: Purpose[] = ['prototype_plan', 'environment_profile', 'milestone_spec', 'tech_design', 'ticket_scope', 'test_plan', 'qa_verify', 'eng_review'];
const asksForGaps = (purpose: Purpose, inputs: string[]) => GAP_PURPOSES.includes(purpose) && inputs.some((pin) => parsePin(pin).id === MUST_SUPPORT);

const workOrder = (purpose: Purpose, instructions: string, inputs: string[], base: WorkOrder['base'], extra: Pick<WorkOrder, 'comment' | 'subject'> = {}): WorkOrder => ({
  purpose,
  instructions: asksForGaps(purpose, inputs) ? `${instructions}\n\n${GAPS_LINE}` : instructions,
  inputs,
  checks: [],
  base,
  ...extra,
});
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

// The list of what the game must run on comes before discovery, from the brief alone. A revision reads the stakeholder's comment.
export function mustSupportTask(project: ProjectRow, k: number, inputs: string[], comment?: string): TaskSpec {
  return {
    project,
    ticket_id: roundId('MUST-SUPPORT-PM', k),
    title: 'Must support: what the game runs on and how it is built',
    milestone: 0,
    role_id: 'pm',
    kind: 'authoring',
    order: workOrder(
      'must_support',
      comment === undefined ? MUST_SUPPORT_INSTRUCTIONS : `${MUST_SUPPORT_INSTRUCTIONS}\n\nThe stakeholder asked for changes: ${comment}`,
      inputs,
      BASE,
      withComment(comment),
    ),
  };
}

const MUST_SUPPORT_INSTRUCTIONS =
  "List what this game must run on and how it is played (group runs_on), and what the brief says about how it must be built (group built_with). Quote the brief's own words in brief_quote for every item it states. If the brief says nothing about where the game runs, propose what a game like this needs: set proposed to true and give the reason. The stakeholder confirms every item. Check an item by play when a browser can show it: name the viewport (desktop, phone_portrait, phone_landscape or tablet), the input (keys, touch, mouse, or null for none) and whether it must fit the screen. Check it by command when a shell command can prove it, and by human when only the stakeholder can judge it, saying how. Keep the ids of the items you keep, and give a new item the next id above every id used before.";

// A prototype round belongs to no milestone, as discovery doesn't. What the PM reads of the stakeholder's verdicts is in its inputs.
export function protoPlanTask(project: ProjectRow, r: number, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: protoPlanId(r),
    title: `Prototype round ${r}: plan`,
    milestone: 0,
    role_id: 'pm',
    kind: 'authoring',
    order: workOrder('prototype_plan', `Plan prototype round ${r}. Suggest candidate fun elements from general knowledge as hypotheses, and the smallest playable prototype for each. Only the stakeholder judges fun: read their notes in the Decision Records and build on what they found fun.`, inputs, BASE),
  };
}

// A profile's worker reads the list, so it is told to write a command for each item a command can prove.
const CHECKS_LINE =
  'For every must-support item checked by command, add a must_support_checks entry: a shell command that exits 0 only when the item holds (it runs in the sandbox, without network, at the head of each milestone), and the files it reads that tickets must not change (protected).';
const PROFILE_INSTRUCTIONS = 'Write the Environment Profile: the toolchains, the build, test, lint and smoke commands, any setup command, and the network hosts the work needs. The smoke command must pass in this repository as it stands.';
const readsList = (inputs: string[]) => inputs.some((pin) => parsePin(pin).id === MUST_SUPPORT);

export function profileTask(project: ProjectRow, round: number, inputs: string[], comment?: string): TaskSpec {
  return {
    project,
    ticket_id: roundId('DISCOVERY-TL', round),
    title: 'Discovery: Environment Profile',
    milestone: 0,
    role_id: 'tech_lead',
    kind: 'authoring',
    depends_on: [roundId('DISCOVERY-PM', round)],
    order: workOrder('environment_profile', readsList(inputs) ? `${PROFILE_INSTRUCTIONS}\n\n${CHECKS_LINE}` : PROFILE_INSTRUCTIONS, inputs, BASE, withComment(comment)),
  };
}

export const CHECKS_TASK = 'MS-CHECKS-TL';

// A profile approved before the list had these items has no command for them, so the Tech Lead adds the commands
// before the next milestone starts. `missing` are the items with none yet.
export function mustSupportChecksTask(project: ProjectRow, k: number, inputs: string[], missing: MsItem[]): TaskSpec {
  const named = missing.map(({ id, text }) => `${id} (${oneLine(text).trim()})`).join(', ');
  return {
    project,
    ticket_id: roundId(CHECKS_TASK, k),
    title: 'Must support: check commands',
    milestone: 0,
    role_id: 'tech_lead',
    kind: 'authoring',
    order: workOrder(
      'must_support_checks',
      `Write must_support_checks for the Environment Profile: one entry for every item on the must-support list that is checked by command. Each entry is a shell command that exits 0 only when the item holds (it runs in the sandbox, without network, at the head of each milestone), and the files it reads that tickets must not change (protected). Keep a command the profile already has when it still proves its item. These items have no command yet: ${named}.`,
      inputs,
      BASE,
    ),
  };
}

// A Spec reads FUN-DEFINITION when the project has one, and is then told what to do about it. The rule is not in the PM's
// charter, which has no room for it.
const FUN_CHECK = 'When a milestone changes an element of FUN-DEFINITION, its Spec carries a human check that names the F-n element, so the stakeholder confirms at CP4 that the fun still holds.';

export function specTask(project: ProjectRow, n: number, round: number, inputs: string[], comment?: string): TaskSpec {
  const instructions = `Write the Spec for milestone ${n} from the Roadmap and the Human Requirements, with acceptance criteria that a command can verify, or a human check where only a person can judge.`;
  return {
    project,
    ticket_id: roundId(`M${n}-SPEC`, round),
    title: `Milestone ${n}: Spec`,
    milestone: n,
    role_id: 'pm',
    kind: 'authoring',
    order: workOrder('milestone_spec', inputs.some((pin) => parsePin(pin).id === FUN_DEFINITION) ? `${instructions}\n\n${FUN_CHECK}` : instructions, inputs, BASE, withComment(comment)),
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
    order: workOrder('tech_design', `Write the Tech Design for milestone ${n}: its components, each with the globs of its sources and of its tests, the complexity, the performance budgets and how each is measured, the test strategy, and the risks. Do not split the work into tickets: the Eng Lead does that from your components.`, inputs, INTEGRATION),
  };
}

export function scopeTask(project: ProjectRow, n: number, inputs: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-SCOPE`,
    title: `Milestone ${n}: Ticket scope`,
    milestone: n,
    role_id: 'eng_lead',
    kind: 'authoring',
    order: workOrder('ticket_scope', `Split milestone ${n} into tickets from the Tech Design's components. Every acceptance criterion must be covered by a ticket. Each ticket names its components and adds or updates their tests.`, inputs, BASE),
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
    order: workOrder('test_plan', `Write the Test Plan for milestone ${n}. Name the commands that verify each automated acceptance criterion. Add a harness ticket only for test tooling those commands need that the product won't include. The Eng Lead splits the product into tickets after the Tech Design and this plan are in, and those tickets build the product and everything its criteria ask it to include, such as its tests.`, inputs, INTEGRATION),
  };
}

// `found` is what the engine's own check of the build against the must-support list came to, where the list has items.
export function qaTask(project: ProjectRow, n: number, round: number, inputs: string[], found?: string): TaskSpec {
  const instructions = `Verify every automated acceptance criterion of milestone ${n} on the integration branch. Where a criterion refers to the Tech Design, check the build against it. Report a Bug for each criterion that fails.`;
  return {
    project,
    ticket_id: `M${n}-QA-${round}`,
    title: `Milestone ${n}: QA round ${round}`,
    milestone: n,
    role_id: 'qa_engineer',
    kind: 'qa_verify',
    order: workOrder('qa_verify', found === undefined ? instructions : `${instructions}\n\n${found}`, inputs, INTEGRATION),
  };
}

// k is the milestone's verify round, so each polish round's review is a task and a record of its own.
export function engReviewTask(project: ProjectRow, n: number, k: number, inputs: string[], instructions: string): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-ENGREV-${k}`,
    title: `Milestone ${n}: Eng review`,
    milestone: n,
    role_id: 'eng_lead',
    kind: 'authoring',
    order: workOrder('eng_review', instructions, inputs, INTEGRATION),
  };
}

// note is the engine's word on what the PM must carry, such as an eng review's findings that no polish round will fix.
export function milestoneReviewTask(project: ProjectRow, n: number, round: number, inputs: string[], note?: string): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-REVIEW-${round}`,
    title: `Milestone ${n}: Milestone Review`,
    milestone: n,
    role_id: 'pm',
    kind: 'authoring',
    order: workOrder('milestone_review', `Write the Milestone Review of milestone ${n} for the stakeholder: what was built, known issues, and any deviations from the Spec or the Tech Design. Your inputs leave out the verification commands and their output, because each automated criterion has passed or been waived, and the stakeholder checks the rest: its status is the engine's record.${note === undefined ? '' : ` ${note}`}`, inputs, INTEGRATION),
  };
}

const decideTickets = (open: string[]) => (open.length > 0 ? ` Decide on each open ticket, still valid or superseded: ${open.join(', ')}.` : '');

export function replanTask(project: ProjectRow, n: number, k: number, inputs: string[], comment: string, open: string[]): TaskSpec {
  return {
    project,
    ticket_id: `M${n}-REPLAN-${k}`,
    title: `Milestone ${n}: Replan after the stakeholder's comment`,
    milestone: n,
    role_id: 'eng_lead',
    kind: 'authoring',
    order: workOrder('revise_scope', `The stakeholder asked for changes at the end of milestone ${n}. Revise the ticket scope and add the tickets their comment calls for. If the design itself must change, raise a Change Request against TECH-M${n}.${decideTickets(open)}`, inputs, INTEGRATION, { comment }),
  };
}

export function reviseTask(project: ProjectRow, n: number, doc: ArtifactVersionRow, k: number, purpose: 'revise_design' | 'revise_scope' | 'revise_test_plan', inputs: string[], open: string[]): TaskSpec {
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

// What a revision reads: the newest version of each source of the document, then the document itself. The list is the
// one in force: its newest version may still be waiting for the stakeholder.
export async function reviseInputs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, doc: ArtifactVersionRow): Promise<string[]> {
  const sources = [...new Set(doc.derived_from.map((pin) => parsePin(pin).id))].filter((id) => id !== doc.artifact_id);
  const pins: string[] = [];
  for (const id of sources) {
    const row = id === MUST_SUPPORT ? await approvedMustSupport(deps, project) : await deps.artifacts.latest(project.id, id);
    if (row) pins.push(pinOf(row));
  }
  return [...pins, pinOf(doc)];
}

// What a replan after CP4 reads: what the scope was based on and the scope itself, as any revision of it does, and the
// eng review behind each open polish ticket, which the replan must decide on and would otherwise know only by its id.
export async function replanInputs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, scope: ArtifactVersionRow, open: string[]): Promise<string[]> {
  const reviews: string[] = [];
  for (const id of open.filter(isPolishTicket)) {
    const row = await deps.artifacts.latest(project.id, id);
    for (const pin of row?.derived_from ?? []) {
      const { id: source, version } = parsePin(pin);
      if (ENG_REVIEW_ID.test(source)) reviews.push(formatPin({ id: source, ...(version === undefined ? {} : { version }) }));
    }
  }
  return [...(await reviseInputs(deps, project, scope)), ...new Set(reviews)];
}

// What discovery hands the stakeholder at CP1 besides the Environment Profile. A prototyping project's also holds its FUN-DEFINITION.
export async function discoveryDocs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<string[]> {
  return (await deps.artifacts.latest(project.id, FUN_DEFINITION)) ? [...DISCOVERY_DOCS, FUN_DEFINITION] : DISCOVERY_DOCS;
}

// What a Spec reads of discovery: the Roadmap and the Human Requirements, the fun the stakeholder approved where there
// is one, and the must-support list.
export async function specSources(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<string[]> {
  const ids = (await deps.artifacts.latest(project.id, FUN_DEFINITION)) ? ['ROADMAP', 'HUMAN-REQUIREMENTS', FUN_DEFINITION] : ['ROADMAP', 'HUMAN-REQUIREMENTS'];
  return withMustSupport(deps, project, await Promise.all(ids.map((id) => latestPin(deps, project, id))));
}

// What the prototype rounds found, oldest first: each round's plan, then the stakeholder's verdict on it. A verdict being
// applied has no record yet, so its answer adds it.
export async function funInputs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<string[]> {
  const found: { round: number; verdict: boolean; pin: string }[] = [];
  for (const row of await deps.artifacts.list(project.id)) {
    const plan = row.type === 'prototype_plan' ? PROTO_PLAN_ID.exec(row.artifact_id) : null;
    if (plan) found.push({ round: Number(plan[1]), verdict: false, pin: pinOf(row) });
    if (row.type !== 'decision_record') continue;
    const data = (await deps.artifacts.read(project, pinOf(row))).fields.data as { ref?: InboxRef } | undefined;
    if (data?.ref?.kind === 'fun_eval') found.push({ round: data.ref.round, verdict: true, pin: pinOf(row) });
  }
  return found.sort((a, b) => a.round - b.round || Number(a.verdict) - Number(b.verdict)).map(({ pin }) => pin);
}

// The list work is checked against: the newest version the stakeholder approved. A newer one may be waiting for them,
// and one they rejected stays proposed.
export async function approvedMustSupport(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<ArtifactVersionRow | undefined> {
  let row = await deps.artifacts.latest(project.id, MUST_SUPPORT);
  while (row && !row.approved_by) row = row.version > 1 ? await deps.artifacts.version(project.id, MUST_SUPPORT, row.version - 1) : undefined;
  return row;
}

export async function mustSupportItems(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<{ pin: string; version: number; items: MsItem[] } | undefined> {
  const row = await approvedMustSupport(deps, project);
  if (!row) return undefined;
  const { items } = (await deps.artifacts.read(project, pinOf(row))).fields.data as MustSupportData;
  return { pin: pinOf(row), version: row.version, items };
}

// Every plan and discovery reads the approved list. A project still waiting on its first has none.
export async function mustSupportPins(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<string[]> {
  const row = await approvedMustSupport(deps, project);
  return row ? [pinOf(row)] : [];
}

// Every milestone document and ticket is written against the list in force, so each one pins it, last.
export async function withMustSupport(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, inputs: string[]): Promise<string[]> {
  const [pin] = await mustSupportPins(deps, project);
  return pin === undefined ? inputs : [...inputs.filter((input) => parsePin(input).id !== MUST_SUPPORT), pin];
}

// What each item on the list in force has come to in a milestone: what the gate or the stakeholder last found, with
// their waivers for good counted. A project with no approved list has nothing to hold a milestone to.
export async function milestoneStatuses(deps: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, n: number): Promise<{ pin: string; items: MsItem[]; statuses: ItemStatus[] } | undefined> {
  const list = await mustSupportItems(deps, project);
  if (!list) return undefined;
  const statuses = gateStatuses(list.items, await deps.store.listMustSupport(project.id, { scope: 'milestone', n }), await deps.store.listMustSupport(project.id, { scope: 'project', n: 0 }));
  return { pin: list.pin, items: list.items, statuses };
}

// The same, one line an item. `forHuman` is what to say of an item only the stakeholder can judge and hasn't yet.
export function statusLines({ items, statuses }: { items: MsItem[]; statuses: ItemStatus[] }, forHuman?: string): string[] {
  return items.map((item, index) => {
    const { status, evidence } = statuses[index]!;
    const first = item.check === 'human' && status === 'not_measured' && forHuman !== undefined ? forHuman : oneLine(evidence.trim().split(/\r\n?|\n/)[0] ?? '');
    return `${itemLine(item)}: ${STATUS_LABEL[status]}${first === '' ? '' : ` — ${first}`}`;
  });
}

// The same, as the paragraph QA and the Eng Lead read in their work orders. A list with no items says nothing.
export async function mustSupportFound(deps: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, n: number): Promise<string | undefined> {
  const found = await milestoneStatuses(deps, project, n);
  const lines = found ? statusLines(found) : [];
  return lines.length === 0 ? undefined : ['What the game must support, as the engine last found it:', ...lines.map((line) => `- ${line}`)].join('\n');
}

// A ticket pins the list it was written against. Its work is checked against the list in force now, so that is the
// one its worker reads.
export async function withListInForce(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, inputs: string[]): Promise<string[]> {
  const isList = (pin: string) => parsePin(pin).id === MUST_SUPPORT;
  if (!inputs.some(isList)) return inputs;
  const [current] = await mustSupportPins(deps, project);
  return current === undefined ? inputs : [...new Set(inputs.map((pin) => (isList(pin) ? current : pin)))];
}

// What a prototype round's plan reads: the brief, the list, and what the rounds before it found.
export async function protoPlanInputs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<string[]> {
  return [await latestPin(deps, project, 'BRIEF'), ...(await mustSupportPins(deps, project)), ...(await funInputs(deps, project))];
}

// The Tech Lead reworks its profile alongside the PM's new documents, which don't exist until the PM finishes: an unversioned pin reads the latest.
// Every discovery round reads what the prototype rounds found, since the PM writes down the fun from the stakeholder's verdicts.
export async function discoveryInputs(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<{ pm: string[]; profile: string[] }> {
  const brief = [await latestPin(deps, project, 'BRIEF'), ...(await mustSupportPins(deps, project))];
  const prior = await Promise.all((await discoveryDocs(deps, project)).map((id) => deps.artifacts.latest(project.id, id)));
  const priorProfile = await deps.artifacts.latest(project.id, ENV_PROFILE);
  return {
    pm: [...brief, ...prior.flatMap((row) => (row ? [pinOf(row)] : [])), ...(await funInputs(deps, project))],
    profile: [...brief, ...DISCOVERY_DOCS, ...(priorProfile ? [pinOf(priorProfile)] : [])],
  };
}
