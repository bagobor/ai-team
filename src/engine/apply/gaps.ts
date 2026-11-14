import type { InboxOption } from '../inbox.ts';
import { itemLine, itemSource, type MsItem } from '../must-support.ts';
import type { ProjectRow, Store, TaskRow } from '../store.ts';
import { MUST_SUPPORT, PROTO_PLAN_ID } from './ids.ts';
import { oneLine } from './text.ts';

// A role's word that an item on the must-support list can't be met in the work it was given.
export type Gap = { item: string; why: string };
export type GapScope = { scope: 'milestone' | 'prototype'; n: number };
// The list in force, which a gap is raised against.
export type MsList = { pin: string; version: number; items: MsItem[] };

export const NO_LIST = 'There is no confirmed must-support list yet, so there is nothing to raise a gap against';

// A round's plan speaks for its round, and a milestone's task for its milestone. Discovery, and anything else before
// the first milestone, can only mean the milestone that comes next.
export function gapScope(task: Pick<TaskRow, 'ticket_id' | 'milestone'>): GapScope {
  const round = PROTO_PLAN_ID.exec(task.ticket_id);
  if (round) return { scope: 'prototype', n: Number(round[1]) };
  return { scope: 'milestone', n: Math.max(1, task.milestone) };
}

const onList = (items: MsItem[], id: string) => items.some((item) => item.id === id);

export function gapProblems(gaps: Gap[], items: MsItem[], pin: string): string[] {
  const problems = new Set<string>();
  const seen = new Set<string>();
  for (const { item } of gaps) {
    if (!onList(items, item)) problems.add(`${item} is not on the must-support list (${pin}): name an item from it`);
    else if (seen.has(item)) problems.add(`${item} appears in gaps twice`);
    seen.add(item);
  }
  return [...problems];
}

// What is left to raise once the problems are set aside: each item on the list, as it was first named.
export function raisableGaps(gaps: Gap[], items: MsItem[]): Gap[] {
  return gaps.filter(({ item }, index) => onList(items, item) && gaps.findIndex((other) => other.item === item) === index);
}

// One question per item in each round or milestone, however many roles name it there. A milestone goes on while the
// stakeholder decides; a prototype round waits.
export async function raiseGaps(s: Store, project: ProjectRow, task: Pick<TaskRow, 'ticket_id' | 'milestone' | 'role_id'>, gaps: Gap[], ms: MsList): Promise<void> {
  if (gaps.length === 0) return;
  const { scope, n } = gapScope(task);
  const where = scope === 'prototype' ? `Prototype round ${n}` : `Milestone ${n}`;
  const options: InboxOption[] = [
    { id: 'milestone', label: scope === 'prototype' ? 'Accept it for this round' : 'Accept it for this milestone' },
    { id: 'for_good', label: 'Accept it for good' },
    { id: 'change', label: 'Change the requirement' },
  ];
  const forGood = (await s.listMustSupport(project.id, { scope: 'project', n: 0 })).filter(({ status }) => status === 'waived').map(({ item_id }) => item_id);
  for (const gap of gaps) {
    const item = ms.items.find(({ id }) => id === gap.item);
    // The stakeholder has already accepted going without it for good, so there is nothing left to ask.
    if (!item || forGood.includes(item.id)) continue;
    const why = gap.why.trim();
    await s.raiseInbox({
      project_id: project.id,
      ...(task.milestone >= 1 ? { milestone: task.milestone } : {}),
      type: 'question',
      dedupe_key: `ms_gap:${scope}:${n}:${item.id}`,
      ref: { kind: 'ms_gap', item: item.id, scope, n, raised_in: task.ticket_id, why },
      title: `${where} can't meet: ${oneLine(item.text).trim()}`,
      asked_by: task.role_id,
      why: [`${task.ticket_id} says this can't be done: ${why}`, '', `The item: ${itemLine(item)}: ${itemSource(item)}`].join('\n'),
      blocks: scope === 'prototype' ? [where] : [],
      evidence: [{ label: MUST_SUPPORT, value: ms.pin, pin: ms.pin }],
      recommendation: '',
      options,
    });
  }
}
