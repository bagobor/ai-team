import type { LineageGraph } from '../src/artifacts/lineage.ts';
import type { ArtifactSummary, TaskSummary } from '../web/src/api.ts';
import { BOARD_COLUMNS, boardColumns, boardSummary, currentMilestone, diffLines, selectTasks } from '../web/src/lib/board.ts';
import { groupDocuments } from '../web/src/lib/documents.ts';
import { ageLabel, documentLink, documentPin, groupInbox, inboxLabel, newPendingIds, pinParts, type InboxItem } from '../web/src/lib/inbox.ts';
import { layoutLineage, staleNotes } from '../web/src/lib/lineageLayout.ts';

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

describe('documentPin', () => {
  it('reads back what a link from the Inbox carries', () => {
    const { hash } = new URL(documentLink('demo', 'SPEC-M1@2'), 'http://x');

    expect(documentPin(hash)).toEqual({ id: 'SPEC-M1', version: 2 });
  });

  it('takes a pin with no version and one with a section', () => {
    expect(pinParts('BRIEF')).toEqual({ id: 'BRIEF', version: null });
    expect(pinParts('TECH-M1@3#conversion')).toEqual({ id: 'TECH-M1', version: 3 });
    expect(pinParts('TECH-M1#conversion')).toEqual({ id: 'TECH-M1', version: null });
  });

  it('gives nothing for no hash or a broken one', () => {
    expect(documentPin('')).toBeNull();
    expect(documentPin('#')).toBeNull();
    expect(documentPin('#%E0%A4%A')).toBeNull();
    expect(documentPin('#../../etc')).toBeNull();
  });
});

describe('groupDocuments', () => {
  const row = (artifact_id: string, type: ArtifactSummary['type']) => ({ artifact_id, type }) as ArtifactSummary;

  it('groups documents in reading order and in id order within a group', () => {
    const groups = groupDocuments([row('QA-REPORT-M1-1', 'qa_report'), row('M1-T-10', 'ticket'), row('BRIEF', 'brief'), row('M1-T-2', 'ticket'), row('BUG-M1-1', 'bug'), row('SPEC-M1', 'spec')]);

    expect(groups.map(({ label, documents }) => [label, documents.map(({ artifact_id }) => artifact_id)])).toEqual([
      ['Brief', ['BRIEF']],
      ['Milestone specs', ['SPEC-M1']],
      ['Tickets', ['BUG-M1-1', 'M1-T-2', 'M1-T-10']],
      ['Reports', ['QA-REPORT-M1-1']],
    ]);
  });

  it('has no groups for no documents', () => {
    expect(groupDocuments([])).toEqual([]);
  });
});

describe('layoutLineage', () => {
  const SIZE = { nodeW: 100, nodeH: 40, gapX: 20, gapY: 10 };
  const graph = (ids: string[], edges: [string, string, boolean?, string?][] = []): LineageGraph => ({
    nodes: ids.map((id) => ({ id, type: 'spec', version: 1, status: 'approved', staleSections: [] })),
    edges: edges.map(([from, to, stale = false, section = null]) => ({ from, to, section, pinnedVersion: 1, stale })),
  });
  const places = (g: LineageGraph) => Object.fromEntries(layoutLineage(g, SIZE).nodes.map(({ id, x, y }) => [id, [x, y]]));

  it('places a document after everything it derives from', () => {
    const g = graph(['T-1', 'TECH', 'BRIEF', 'SPEC'], [['BRIEF', 'SPEC'], ['SPEC', 'TECH'], ['TECH', 'T-1'], ['BRIEF', 'T-1']]);

    expect(places(g)).toEqual({ BRIEF: [0, 0], SPEC: [120, 0], TECH: [240, 0], 'T-1': [360, 0] });
  });

  it('gives no two nodes the same position', () => {
    const g = graph(['C', 'A', 'B'], [['A', 'C']]);
    const { nodes } = layoutLineage(graph(['T-10', 'T-2', 'T-1', 'BRIEF'], [['BRIEF', 'T-10'], ['BRIEF', 'T-2'], ['BRIEF', 'T-1']]), SIZE);

    expect(places(g)).toEqual({ A: [0, 0], B: [0, 50], C: [120, 0] });
    expect(nodes.filter(({ x }) => x === 120).map(({ id, y }) => [id, y])).toEqual([['T-1', 0], ['T-2', 50], ['T-10', 100]]);
  });

  it('does not hang on a cycle in bad data', () => {
    const { nodes, edges } = layoutLineage(graph(['A', 'B', 'C'], [['A', 'B'], ['B', 'A'], ['B', 'C'], ['C', 'C']]), SIZE);

    expect(nodes.map(({ id }) => id)).toEqual(['A', 'B', 'C']);
    expect(new Set(nodes.map(({ x, y }) => `${x},${y}`)).size).toBe(3);
    expect(edges).toHaveLength(4);
  });

  it('marks stale edges', () => {
    const { edges } = layoutLineage(graph(['A', 'B', 'C'], [['A', 'B', true], ['A', 'C']]), SIZE);

    expect(edges.map(({ from, to, stale }) => [from, to, stale])).toEqual([['A', 'B', true], ['A', 'C', false]]);
  });

  it('draws a line from the right of the source to the left of the derived document', () => {
    const { edges } = layoutLineage(graph(['A', 'B'], [['A', 'B']]), SIZE);

    expect(edges[0]?.path).toBe('M100 20 C110 20 110 20 120 20');
  });

  it('draws one line between two documents, stale if any section is', () => {
    const { edges } = layoutLineage(graph(['A', 'B'], [['A', 'B', false, 'one'], ['A', 'B', true, 'two']]), SIZE);

    expect(edges.map(({ stale }) => stale)).toEqual([true]);
  });

  it('leaves out an edge to a document it does not have', () => {
    const { nodes, edges } = layoutLineage(graph(['A'], [['GONE', 'A'], ['A', 'GONE']]), SIZE);

    expect(nodes).toEqual([{ id: 'A', x: 0, y: 0 }]);
    expect(edges).toEqual([]);
  });

  it('reports the size of the whole graph', () => {
    const { width, height } = layoutLineage(graph(['A', 'B', 'C'], [['A', 'C'], ['B', 'C']]), SIZE);

    expect([width, height]).toEqual([220, 90]);
    expect(layoutLineage(graph([]), SIZE)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

describe('staleNotes', () => {
  const graph: LineageGraph = {
    nodes: [
      { id: 'SPEC-M1', type: 'spec', version: 3, status: 'approved', staleSections: [] },
      { id: 'TEST-PLAN-M1', type: 'test_plan', version: 1, status: 'stale', staleSections: ['scope'] },
      { id: 'M1-T-1', type: 'ticket', version: 1, status: 'stale', staleSections: [] },
      { id: 'TECH-M1', type: 'tech_design', version: 2, status: 'approved', staleSections: [] },
    ],
    edges: [
      { from: 'SPEC-M1', to: 'TEST-PLAN-M1', section: 'scope', pinnedVersion: 2, stale: true },
      { from: 'SPEC-M1', to: 'TEST-PLAN-M1', section: 'limits', pinnedVersion: 2, stale: true },
      { from: 'SPEC-M1', to: 'M1-T-1', section: null, pinnedVersion: 2, stale: true },
      { from: 'SPEC-M1', to: 'TECH-M1', section: null, pinnedVersion: 3, stale: false },
    ],
  };

  it('names what changed and what still cites the old text, with its sections', () => {
    expect(staleNotes(graph)).toEqual([{ source: 'SPEC-M1', version: 3, citing: ['M1-T-1', 'TEST-PLAN-M1 §limits', 'TEST-PLAN-M1 §scope'] }]);
  });

  it('has nothing to say when nothing is stale', () => {
    expect(staleNotes({ nodes: graph.nodes, edges: graph.edges.map((edge) => ({ ...edge, stale: false })) })).toEqual([]);
  });
});
