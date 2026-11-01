import type { TaskSummary } from '../web/src/api.ts';
import { BOARD_COLUMNS, boardColumns, boardSummary, currentMilestone, diffLines, selectTasks } from '../web/src/lib/board.ts';
import { ageLabel, documentLink, groupInbox, inboxLabel, newPendingIds, type InboxItem } from '../web/src/lib/inbox.ts';

const item = (id: number, type: InboxItem['type']): InboxItem => ({ id, type, title: `Item ${id}` }) as InboxItem;

describe('groupInbox', () => {
  it('groups approvals before questions and drops empty groups', () => {
    const groups = groupInbox([item(1, 'question'), item(2, 'approval'), item(3, 'question')]);

    expect(groups.map(({ type, label, items }) => [type, label, items.map(({ id }) => id)])).toEqual([
      ['approval', 'Approvals', [2]],
      ['question', 'Questions', [1, 3]],
    ]);
    expect(groupInbox([item(1, 'question')]).map(({ type }) => type)).toEqual(['question']);
    expect(groupInbox([])).toEqual([]);
  });
});

describe('ageLabel', () => {
  it.each([
    [30, 'just now'],
    [59, 'just now'],
    [60, '1 min'],
    [300, '5 min'],
    [3599, '59 min'],
    [7200, '2 h'],
    [86399, '23 h'],
    [172800, '2 d'],
  ])('labels %i seconds as %s', (seconds, label) => {
    expect(ageLabel(seconds)).toBe(label);
  });
});

describe('newPendingIds', () => {
  it('finds only ids that are new', () => {
    expect(newPendingIds([1, 2], [2, 3, 4])).toEqual([3, 4]);
    expect(newPendingIds([1, 2], [1])).toEqual([]);
  });
});

describe('inboxLabel', () => {
  it.each([
    [{ kind: 'cp1' }, 7, 'CP1'],
    [{ kind: 'cp4', milestone: 2 }, 7, 'CP4-M2'],
    [{ kind: 'cr', cr: 'CR-3' }, 7, 'CR-3'],
    [{ kind: 'escalation', taskId: 4 }, 7, 'Q-7'],
    [{ kind: 'qa_cap', milestone: 1 }, 8, 'Q-8'],
  ] as const)('names %j, item %i, as %s', (ref, id, label) => {
    expect(inboxLabel({ id, ref })).toBe(label);
  });
});

describe('documentLink', () => {
  it('points a pin at its project\'s Documents page', () => {
    expect(documentLink('temp conv', 'SPEC-M1@2')).toBe('/projects/temp%20conv/documents#SPEC-M1%402');
  });
});

const task = (id: number, state: TaskSummary['state'], extra: Partial<TaskSummary> = {}): TaskSummary =>
  ({ id, state, kind: 'ticket', milestone: 1, specialty: 'engineer', parent_task_id: null, blocked_on: null, ...extra }) as TaskSummary;

describe('boardColumns', () => {
  const idsIn = (tasks: TaskSummary[]) => Object.fromEntries(BOARD_COLUMNS.map((column) => [column, boardColumns(tasks)[column].map(({ id }) => id)]));

  it('puts each state in its column and hides cancelled', () => {
    const tasks = [task(1, 'queued'), task(2, 'ready'), task(3, 'running'), task(4, 'checks'), task(5, 'review'), task(6, 'blocked'), task(7, 'escalated'), task(8, 'done'), task(9, 'cancelled')];

    expect(idsIn(tasks)).toEqual({ Ready: [1, 2], Running: [3, 4], Review: [5], QA: [], Blocked: [6, 7], Done: [8] });
  });

  it('puts a running QA task in QA', () => {
    const tasks = [task(1, 'running', { kind: 'qa_verify' }), task(2, 'queued', { kind: 'qa_verify' }), task(3, 'done', { kind: 'qa_verify' }), task(4, 'cancelled', { kind: 'qa_verify' })];

    expect(idsIn(tasks)).toEqual({ Ready: [], Running: [], Review: [], QA: [1, 2], Blocked: [], Done: [3] });
  });

  it('folds a code review into its ticket', () => {
    const columns = boardColumns([task(1, 'review'), task(2, 'running', { kind: 'code_review', parent_task_id: 1 })]);

    expect(columns.Running).toEqual([]);
    expect(columns.Review.map(({ id, reviewer }) => [id, reviewer])).toEqual([[1, 'running']]);
  });

  it('reports the newest review of a ticket, and leaves out a cancelled one', () => {
    const reviewOf = (...reviews: [number, TaskSummary['state']][]) =>
      boardColumns([task(1, 'review'), ...reviews.map(([id, state]) => task(id, state, { kind: 'code_review', parent_task_id: 1 }))]).Review[0]?.reviewer;

    expect(reviewOf()).toBeNull();
    expect(reviewOf([2, 'done'], [3, 'queued'])).toBe('queued');
    expect(reviewOf([2, 'done'], [3, 'cancelled'])).toBe('done');
    expect(reviewOf([2, 'cancelled'])).toBeNull();
  });
});

describe('selectTasks', () => {
  const tasks = [task(1, 'review', { milestone: 1, specialty: 'engineer' }), task(2, 'running', { milestone: 1, specialty: 'code_reviewer', kind: 'code_review', parent_task_id: 1 }), task(3, 'done', { milestone: 2, specialty: 'qa_engineer' }), task(4, 'done', { milestone: 0, specialty: 'pm' })];
  const ids = (filter: Parameters<typeof selectTasks>[1]) => selectTasks(tasks, filter).map(({ id }) => id);

  it('filters by milestone', () => {
    expect(ids({ milestone: 2, specialty: null })).toEqual([3]);
    expect(ids({ milestone: 0, specialty: null })).toEqual([4]);
    expect(ids({ milestone: null, specialty: null })).toEqual([1, 2, 3, 4]);
  });

  it('keeps each review with its ticket when filtering by specialty', () => {
    expect(ids({ milestone: 1, specialty: 'engineer' })).toEqual([1, 2]);
    expect(boardColumns(selectTasks(tasks, { milestone: 1, specialty: 'engineer' })).Review[0]?.reviewer).toBe('running');
    expect(ids({ milestone: 1, specialty: 'qa_engineer' })).not.toContain(1);
  });
});

describe('boardSummary', () => {
  it('counts tickets, busy workers, the queue and what waits on the stakeholder', () => {
    const tasks = [
      task(1, 'running'),
      task(2, 'checks', { kind: 'authoring' }),
      task(3, 'running', { kind: 'code_review', parent_task_id: 9 }),
      task(4, 'queued'),
      task(5, 'ready', { kind: 'qa_verify' }),
      task(6, 'escalated'),
      task(7, 'blocked', { blocked_on: 'human_request' }),
      task(8, 'blocked', { blocked_on: 'M1-T-1' }),
      task(9, 'cancelled'),
    ];

    expect(boardSummary(tasks)).toEqual({ tickets: 5, busy: 3, queued: 2, onYou: 2 });
  });
});

describe('currentMilestone', () => {
  const milestone = (n: number, phase: string) => ({ n, phase }) as Parameters<typeof currentMilestone>[0][number];

  it('opens on the first milestone that is not merged', () => {
    expect(currentMilestone([milestone(1, 'merged'), milestone(2, 'build'), milestone(3, 'pending')])).toBe(2);
  });

  it('falls back to the last one, then to none', () => {
    expect(currentMilestone([milestone(1, 'merged'), milestone(2, 'merged')])).toBe(2);
    expect(currentMilestone([])).toBeNull();
  });
});

describe('diffLines', () => {
  const DIFF = [
    'diff --git a/q.sql b/q.sql',
    'index 1111111..2222222 100644',
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -1,3 +1,3 @@ select',
    ' keep',
    '--- an old comment',
    '+++ a new comment',
    ' keep',
    '\\ No newline at end of file',
    'diff --git a/b b/b',
    '--- a/b',
    '+++ b/b',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '',
  ].join('\n');

  it('classifies diff lines, without treating +++ and --- headers as changes', () => {
    expect(diffLines(DIFF).map(({ kind }) => kind)).toEqual(['ctx', 'ctx', 'ctx', 'ctx', 'hunk', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'ctx', 'ctx', 'hunk', 'del', 'add']);
  });

  it('keeps each line as written', () => {
    expect(diffLines('@@ -0,0 +1 @@\n+<script>alert(1)</script>\n')).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1 @@' },
      { kind: 'add', text: '+<script>alert(1)</script>' },
    ]);
  });

  it('gives no lines for an empty diff', () => {
    expect(diffLines('')).toEqual([]);
  });
});
