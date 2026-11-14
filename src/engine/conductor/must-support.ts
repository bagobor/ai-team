import { isDeepStrictEqual } from 'node:util';
import { parsePin } from '../../artifacts/format.ts';
import { MUST_SUPPORT } from '../apply/ids.ts';
import { oneLine, sentence } from '../apply/text.ts';
import type { InboxRef, InboxRow } from '../inbox.ts';
import { itemLine, itemSource, type MsItem, type MustSupportData } from '../must-support.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { ArtifactVersionRow, ProjectRow, TaskRow } from '../store.ts';
import { halt, type Effect } from './answers.ts';
import { approvedMustSupport, ensureTask, latestPin, mustSupportItems, mustSupportPins, mustSupportTask, noteOf, pinOf, roundId, roundOf } from './tasks.ts';

export { approvedMustSupport, mustSupportItems };

const PM_TASK = 'MUST-SUPPORT-PM';
const CONFIRM_TITLE = "Confirm what the game must run on and how it's played";
const REVISION_TITLE = 'Confirm the change to what the game must run on';
const CONFIRM_WHY =
  "Before anything is built, confirm what the game must run on, how it's played and how it's built. Every prototype and milestone is checked against this list, and anything that can't be met comes back to you.";

const itemsOf = async (deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, row: ArtifactVersionRow): Promise<MsItem[]> =>
  ((await deps.artifacts.read(project, pinOf(row))).fields.data as MustSupportData).items;

export type MsState = { approved?: ArtifactVersionRow; pending: boolean };

// Each tick: the PM writes the list from the brief, and nothing waiting on it starts until the stakeholder approves it.
// A project from before the list gets one the same way. A change to an approved list holds only what waits on the list.
export async function advanceMustSupport(deps: EngineDeps, project: ProjectRow): Promise<MsState> {
  const approved = await approvedMustSupport(deps, project);
  const state = (pending: boolean): MsState => (approved ? { approved, pending } : { pending });
  const tasks = await deps.store.listTasks(project.id);
  const k = roundOf(tasks, PM_TASK);
  if (k === 0 && !approved) {
    const brief = await deps.artifacts.latest(project.id, 'BRIEF');
    if (brief) await ensureTask(deps.store, mustSupportTask(project, 1, [pinOf(brief)]));
    return state(true);
  }
  const task = tasks.find(({ ticket_id }) => ticket_id === roundId(PM_TASK, k));
  if (task && task.state !== 'done') return state(true);
  const latest = await deps.artifacts.latest(project.id, MUST_SUPPORT);
  if (latest?.status !== 'proposed') return state(false);
  await raiseConfirm(deps, project, latest, approved, task);
  return state(true);
}

const sourceLine = (item: MsItem): string => `- ${itemLine(item)}: ${itemSource(item)}`;

function changeLines(before: MsItem[], after: MsItem[]): string[] {
  const old = new Map(before.map((item) => [item.id, item]));
  const kept = new Set(after.map(({ id }) => id));
  const lines = [
    ...after.filter(({ id }) => !old.has(id)).map((item) => `Added: ${itemLine(item)}`),
    ...before.filter(({ id }) => !kept.has(id)).map((item) => `Removed: ${itemLine(item)}`),
    ...after.filter((item) => old.has(item.id) && !isDeepStrictEqual(old.get(item.id), item)).map((item) => `Changed: ${itemLine(item)}`),
  ];
  return lines.length > 0 ? lines : ['No item changed.'];
}

async function raiseConfirm(deps: EngineDeps, project: ProjectRow, proposed: ArtifactVersionRow, approved: ArtifactVersionRow | undefined, task: TaskRow | undefined): Promise<void> {
  const dedupe_key = `must_support:${proposed.version}`;
  if ((await deps.store.inboxByPrefix(project.id, dedupe_key)).some((item) => item.dedupe_key === dedupe_key)) return;
  const items = await itemsOf(deps, project, proposed);
  const why = approved
    ? [`The PM changed the list. Approve to build against the new one, or reject to keep ${pinOf(approved)}.`, '', ...changeLines(await itemsOf(deps, project, approved), items)]
    : [CONFIRM_WHY, '', ...items.map(sourceLine)];
  // Only a project still at intake waits on its first list before anything else starts.
  const blocks = !approved && project.phase === 'intake' ? [project.prototyping === 1 ? 'Prototyping' : 'Discovery'] : ['The next milestone'];
  const pins = [pinOf(proposed), await latestPin(deps, project, 'BRIEF'), ...(approved ? [pinOf(approved)] : [])];
  await deps.store.raiseInbox({
    project_id: project.id,
    type: 'approval',
    dedupe_key,
    ref: { kind: 'must_support', version: proposed.version },
    title: approved ? REVISION_TITLE : CONFIRM_TITLE,
    asked_by: 'pm',
    why: why.join('\n'),
    blocks,
    evidence: pins.map((pin) => ({ label: parsePin(pin).id, value: pin, pin })),
    recommendation: task ? await noteOf(deps.store, task.id) : '',
    options: [],
  });
}

// An answer to a version the PM has since replaced is only recorded: the newer version asks again.
export async function answerMustSupport(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, version: number, choice: string, words?: string): Promise<Effect> {
  if ((await deps.artifacts.latest(project.id, MUST_SUPPORT))?.version !== version) return {};
  if (choice === 'approve') return { status: [{ id: MUST_SUPPORT, status: 'approved', approvedBy: 'stakeholder' }] };
  if (choice === 'request_changes') {
    const k = roundOf(await deps.store.listTasks(project.id), PM_TASK) + 1;
    const inputs = [await latestPin(deps, project, 'BRIEF'), `${MUST_SUPPORT}@${version}`];
    return { after: (s) => ensureTask(s, mustSupportTask(project, k, inputs, words)).then(() => {}) };
  }
  const approved = await approvedMustSupport(deps, project);
  if (!approved) return halt(deps, runner, project, item);
  // The approved list comes back as the newest version, so the one the stakeholder rejected is no longer the latest.
  const kept = await deps.artifacts.read(project, pinOf(approved));
  return {
    message: `The stakeholder kept ${pinOf(approved)}`,
    publish: [{ id: MUST_SUPPORT, type: 'must_support', status: 'approved', approvedBy: approved.approved_by ?? 'stakeholder', ownerRole: approved.owner_role, derivedFrom: approved.derived_from, body: kept.body, fields: kept.fields }],
  };
}

// A gap is the stakeholder's to settle: go without the item in this round or milestone, go without it for good, or
// have the PM change the list, which then comes back to them at the confirm item.
export async function answerGap(deps: EngineDeps, project: ProjectRow, item: InboxRow, ref: Extract<InboxRef, { kind: 'ms_gap' }>, choice: string, words?: string): Promise<Effect> {
  if (choice === 'change') {
    const k = roundOf(await deps.store.listTasks(project.id), PM_TASK) + 1;
    const inputs = [await latestPin(deps, project, 'BRIEF'), ...(await mustSupportPins(deps, project))];
    const comment = `${ref.raised_in} says ${ref.item} can't be met: ${sentence(oneLine(ref.why))}${words === undefined ? '' : ` The stakeholder wrote: ${words}`}`;
    return { after: (s) => ensureTask(s, mustSupportTask(project, k, inputs, comment)).then(() => {}) };
  }
  const list = await approvedMustSupport(deps, project);
  if (!list) throw new Error(`Inbox item ${item.id} is a gap against a must-support list that is no longer approved`);
  const at = choice === 'for_good' ? { scope: 'project' as const, n: 0 } : { scope: ref.scope, n: ref.n };
  return {
    after: (s) => s.recordMustSupport(project.id, at, [{ item_id: ref.item, status: 'waived', evidence: `DEC-${item.id}@1`, source: 'stakeholder', must_support_version: list.version }]),
  };
}
