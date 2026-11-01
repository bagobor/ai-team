import type { TaskState } from '../../../src/engine/fsm.ts';
import type { MilestoneRow } from '../../../src/engine/store.ts';
import type { TaskSummary } from '../api.ts';

export const BOARD_COLUMNS = ['Ready', 'Running', 'Review', 'QA', 'Blocked', 'Done'] as const;
export type Column = (typeof BOARD_COLUMNS)[number];
export type BoardTask = TaskSummary & { reviewer: TaskState | null };
export type BoardFilter = { milestone: number | null; specialty: string | null };
export type DiffLine = { kind: 'add' | 'del' | 'hunk' | 'ctx'; text: string };

const COLUMN_OF: Record<TaskState, Column | null> = {
  queued: 'Ready',
  ready: 'Ready',
  running: 'Running',
  checks: 'Running',
  review: 'Review',
  qa: 'QA',
  blocked: 'Blocked',
  escalated: 'Blocked',
  done: 'Done',
  cancelled: null,
};

function columnOf(task: TaskSummary): Column | null {
  const column = COLUMN_OF[task.state];
  return task.kind === 'qa_verify' && column !== null && column !== 'Done' ? 'QA' : column;
}

export function boardColumns(tasks: TaskSummary[]): Record<Column, BoardTask[]> {
  const reviewer = new Map<number, TaskState>();
  for (const { kind, state, parent_task_id: parent } of [...tasks].sort((a, b) => a.id - b.id)) {
    if (kind === 'code_review' && parent !== null && state !== 'cancelled') reviewer.set(parent, state);
  }

  const columns: Record<Column, BoardTask[]> = { Ready: [], Running: [], Review: [], QA: [], Blocked: [], Done: [] };
  for (const task of tasks) {
    const column = task.kind === 'code_review' ? null : columnOf(task);
    if (column) columns[column].push({ ...task, reviewer: reviewer.get(task.id) ?? null });
  }
  return columns;
}

// A review is filed under the Code Reviewer, but it stays with the ticket it reads.
export function selectTasks(tasks: TaskSummary[], { milestone, specialty }: BoardFilter): TaskSummary[] {
  return tasks.filter((task) => (milestone === null || task.milestone === milestone) && (specialty === null || task.kind === 'code_review' || task.specialty === specialty));
}

export function waitsOnYou({ state, blocked_on: blockedOn }: Pick<TaskSummary, 'state' | 'blocked_on'>): boolean {
  return state === 'escalated' || (state === 'blocked' && blockedOn === 'human_request');
}

export function boardSummary(tasks: TaskSummary[]): { tickets: number; busy: number; queued: number; onYou: number } {
  const count = (test: (task: TaskSummary) => boolean) => tasks.filter(test).length;
  return {
    tickets: count(({ kind, state }) => kind === 'ticket' && state !== 'cancelled'),
    busy: count(({ state }) => state === 'running' || state === 'checks'),
    queued: count(({ state }) => state === 'queued' || state === 'ready'),
    onYou: count(waitsOnYou),
  };
}

export function currentMilestone(milestones: Pick<MilestoneRow, 'n' | 'phase'>[]): number | null {
  return (milestones.find(({ phase }) => phase !== 'merged') ?? milestones.at(-1))?.n ?? null;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

export function diffLines(text: string): DiffLine[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  // Only a hunk's own counts tell a deleted "-- note" from a "--- a/file" header.
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((line): DiffLine => {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      return { kind: 'hunk', text: line };
    }
    if (oldLeft > 0 && line.startsWith('-')) {
      oldLeft -= 1;
      return { kind: 'del', text: line };
    }
    if (newLeft > 0 && line.startsWith('+')) {
      newLeft -= 1;
      return { kind: 'add', text: line };
    }
    if (oldLeft > 0 && newLeft > 0 && line.startsWith(' ')) {
      oldLeft -= 1;
      newLeft -= 1;
    }
    return { kind: 'ctx', text: line };
  });
}
