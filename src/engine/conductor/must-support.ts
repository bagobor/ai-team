import { isDeepStrictEqual } from 'node:util';
import { parsePin } from '../../artifacts/format.ts';
import { MUST_SUPPORT, PROTO_PLAN_ID } from '../apply/ids.ts';
import { oneLine, sentence } from '../apply/text.ts';
import type { InboxRef, InboxRow } from '../inbox.ts';
import { itemLine, itemSource, type MsItem, type MustSupportData } from '../must-support.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { ArtifactVersionRow, MsScope, ProjectRow, Store, TaskRow } from '../store.ts';
import { halt, type Effect } from './answers.ts';
import { resetVerification } from './change-requests.ts';
import { approvedMustSupport, ensureTask, isClosed, latestPin, mustSupportItems, mustSupportTask, noteOf, pinOf, roundId, roundOf, type TaskSpec } from './tasks.ts';

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
  const earlier = await deps.store.inboxByPrefix(project.id, 'must_support:');
  if (earlier.some((item) => item.dedupe_key === dedupe_key)) return;
  // A question about a version this one replaces has nothing left to decide.
  for (const item of earlier) await deps.store.withdrawInbox(item.id, `${pinOf(proposed)} replaces the list this asked about`);
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

// A revision builds on the newest list there is: one still waiting for the stakeholder, else the one in force. While
// the PM is still writing a round, the next one waits for it and reads what it comes to, so no change asked for is
// lost to another asked for at the same time.
async function revisionTask(deps: EngineDeps, project: ProjectRow, comment: string | undefined): Promise<TaskSpec> {
  const tasks = await deps.store.listTasks(project.id);
  const k = roundOf(tasks, PM_TASK);
  const open = tasks.find(({ ticket_id, state }) => ticket_id === roundId(PM_TASK, k) && !isClosed({ state }));
  const brief = await latestPin(deps, project, 'BRIEF');
  if (open) return { ...mustSupportTask(project, k + 1, [brief, MUST_SUPPORT], comment), depends_on: [open.ticket_id] };
  const latest = await deps.artifacts.latest(project.id, MUST_SUPPORT);
  const base = latest?.status === 'proposed' ? latest : await approvedMustSupport(deps, project);
  return mustSupportTask(project, k + 1, [brief, ...(base ? [pinOf(base)] : [])], comment);
}

// A waiver was given for the item as it read then. Once the stakeholder approves the item changed, it no longer stands:
// for good, in a milestone still open, or in a prototype round. The row stays, and says why it ended.
async function endWaivers(s: Store, project: ProjectRow, tasks: TaskRow[], changed: string[], version: number): Promise<void> {
  if (changed.length === 0) return;
  const milestones: MsScope[] = (await s.listMilestones(project.id)).filter(({ phase }) => phase !== 'merged').map(({ n }) => ({ scope: 'milestone', n }));
  const rounds: MsScope[] = tasks.flatMap(({ ticket_id }) => PROTO_PLAN_ID.exec(ticket_id)?.slice(1) ?? []).map((r) => ({ scope: 'prototype', n: Number(r), subject: '' }));
  for (const at of [{ scope: 'project' as const, n: 0 }, ...milestones, ...rounds]) {
    const ended = (await s.listMustSupport(project.id, at)).filter(({ status, subject, item_id }) => status === 'waived' && subject === '' && changed.includes(item_id));
    const why = (evidence: string) => `${MUST_SUPPORT}@${version} changed this item, so the earlier waiver (${evidence}) no longer stands`;
    await s.recordMustSupport(project.id, at, ended.map(({ item_id, evidence }) => ({ item_id, status: 'not_measured', evidence: why(evidence), source: 'stakeholder', must_support_version: version })));
  }
}

// An answer to a version the PM has since replaced is only recorded: the newer version asks again.
export async function answerMustSupport(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, version: number, choice: string, words?: string): Promise<Effect> {
  const latest = await deps.artifacts.latest(project.id, MUST_SUPPORT);
  if (latest?.version !== version) return {};
  const approved = await approvedMustSupport(deps, project);
  if (choice === 'approve') {
    const before = approved ? await itemsOf(deps, project, approved) : [];
    const after = await itemsOf(deps, project, latest);
    const added = after.some((now) => !before.some(({ id }) => id === now.id));
    const changed = after.filter((now) => before.some((was) => was.id === now.id && !isDeepStrictEqual(was, now))).map(({ id }) => id);
    const tasks = await deps.store.listTasks(project.id);
    return {
      status: [{ id: MUST_SUPPORT, status: 'approved', approvedBy: 'stakeholder' }],
      after: async (s) => {
        await endWaivers(s, project, tasks, changed, version);
        // A milestone already checked, or waiting for approval, was checked against the list as it was: its approval
        // offers nothing for a new item, and the merge guard would refuse it for ever. So it goes back to be checked,
        // as it does when a Change Request changes any other project-level document.
        if (added || changed.length > 0) await resetVerification(s, project, null);
      },
    };
  }
  if (choice === 'request_changes') {
    const revision = await revisionTask(deps, project, words);
    return { after: (s) => ensureTask(s, revision).then(() => {}) };
  }
  if (!approved) return halt(deps, runner, project, item);
  // The list in force stays the version it is, so nothing written against it has anything new to read. The rejected
  // version is retired, and is no longer the one waiting.
  return { status: [{ id: MUST_SUPPORT, status: 'superseded' }] };
}

// A gap is the stakeholder's to settle: go without the item in this round or milestone, go without it for good, or
// have the PM change the list, which then comes back to them at the confirm item.
export async function answerGap(deps: EngineDeps, project: ProjectRow, item: InboxRow, ref: Extract<InboxRef, { kind: 'ms_gap' }>, choice: string, words?: string): Promise<Effect> {
  if (choice === 'change') {
    const comment = `${ref.raised_in} says ${ref.item} can't be met: ${sentence(oneLine(ref.why))}${words === undefined ? '' : ` The stakeholder wrote: ${words}`}`;
    const revision = await revisionTask(deps, project, comment);
    return { after: (s) => ensureTask(s, revision).then(() => {}) };
  }
  const list = await approvedMustSupport(deps, project);
  if (!list) throw new Error(`Inbox item ${item.id} is a gap against a must-support list that is no longer approved`);
  const at = choice === 'for_good' ? { scope: 'project' as const, n: 0 } : { scope: ref.scope, n: ref.n };
  return {
    after: (s) => s.recordMustSupport(project.id, at, [{ item_id: ref.item, status: 'waived', evidence: `DEC-${item.id}@1`, source: 'stakeholder', must_support_version: list.version }]),
  };
}
