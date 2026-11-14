import type { LineageGraph } from '../src/artifacts/lineage.ts';
import type { CharterLine } from '../src/roles/provenance.ts';
import { PLAY, type InboxRef } from '../src/engine/inbox.ts';
import type { ArtifactSummary, TaskSummary } from '../web/src/api.ts';
import { BOARD_COLUMNS, boardColumns, boardSummary, currentMilestone, diffLines, selectTasks } from '../web/src/lib/board.ts';
import { groupDocuments } from '../web/src/lib/documents.ts';
import {
  ageLabel,
  canApprove,
  canApproveItem,
  canRequestChanges,
  changesComment,
  checkMarks,
  checksHeading,
  documentLink,
  documentPin,
  failedChecksComment,
  groupInbox,
  inboxLabel,
  isTryLink,
  markLabels,
  newPendingIds,
  noteLabel,
  pinParts,
  rejectConfirm,
  requestChangesLabel,
  waiveLabel,
  waivers,
  type InboxItem,
} from '../web/src/lib/inbox.ts';
import { duration, foldedQuote, ledgerTotals, purposeLabel, roleChip, runLabel, thenOf, when } from '../web/src/lib/ledger.ts';
import { layoutLineage, staleNotes } from '../web/src/lib/lineageLayout.ts';
import { changeKey, charterRows, day, fileLabel, linesFrom, roleName, rolePath, unwrap } from '../web/src/lib/roles.ts';

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

  it('labels a fun evaluation FUN-R2', () => {
    expect(inboxLabel({ id: 9, ref: { kind: 'fun_eval', round: 2 } })).toBe('FUN-R2');
  });

  it('labels the must-support items', () => {
    expect(inboxLabel({ id: 7, ref: { kind: 'must_support', version: 1 } })).toBe('What it must run on');
    expect(inboxLabel({ id: 8, ref: { kind: 'ms_gap', item: 'MS-1', scope: 'milestone', n: 2, raised_in: 'M2-SPEC', why: 'Too wide' } })).toBe("Can't meet MS-1");
  });
});

describe('the checks the stakeholder marks', () => {
  const checks = [
    { ac: 'AC-2', text: 'Dodging feels fair', how: 'Play' },
    { ac: 'AC-3', text: 'Sounds right', how: 'Listen' },
  ];
  const passing = { status: 'passing', note: '' } as const;

  it('approves only when every check is marked passing', () => {
    expect(canApprove(checks, { 'AC-2': passing })).toBe(false);
    expect(canApprove(checks, { 'AC-2': passing, 'AC-3': { status: 'failing', note: 'quiet' } })).toBe(false);
    expect(canApprove(checks, { 'AC-2': passing, 'AC-3': { note: 'half typed' } })).toBe(false);
    expect(canApprove(checks, { 'AC-2': passing, 'AC-3': passing })).toBe(true);
    expect(canApprove([], {})).toBe(true);
  });

  it('approves a check item as canApprove does', () => {
    const CP4: InboxRef = { kind: 'cp4', milestone: 1 };

    expect(canApproveItem(CP4, checks, { 'AC-2': passing })).toBe(false);
    expect(canApproveItem(CP4, checks, { 'AC-2': passing, 'AC-3': { status: 'failing', note: 'quiet' } })).toBe(false);
    expect(canApproveItem(CP4, checks, { 'AC-2': passing, 'AC-3': passing })).toBe(true);
    expect(canApproveItem(CP4, [], {})).toBe(true);
  });

  describe('approving without a must-support item', () => {
    const CP4: InboxRef = { kind: 'cp4', milestone: 1 };
    const waivable = [{ id: 'MS-1', text: 'Plays on a phone', why: 'too tall' }];
    const sound = { ac: 'MS-4', text: 'Sounds right', how: 'Listen' };

    it('approve needs every failing item waived', () => {
      expect(canApproveItem(CP4, [], {}, waivable, [])).toBe(false);
      expect(canApproveItem(CP4, [], {}, waivable, ['MS-1'])).toBe(true);
      expect(canApproveItem(CP4, checks, { 'AC-2': passing, 'AC-3': passing }, waivable, [])).toBe(false);
    });

    it('a waived MS check needs no mark, and every other check still does', () => {
      expect(canApproveItem(CP4, [sound], {}, [], ['MS-4'])).toBe(true);
      expect(canApproveItem(CP4, [sound], { 'MS-4': { status: 'failing', note: 'Tinny' } }, [], ['MS-4'])).toBe(true);
      expect(canApproveItem(CP4, [sound], {}, [], [])).toBe(false);
      expect(canApproveItem(CP4, [...checks, sound], { 'AC-2': passing }, [], ['MS-4'])).toBe(false);
    });

    it('labels a waiver', () => {
      expect(waiveLabel('Plays on a phone')).toBe('Approve without: Plays on a phone');
    });

    it('offers a waiver for each failing item, and for each check on the list', () => {
      expect(waivers({ ref: CP4, waivable, checks: [...checks, sound] })).toEqual([
        { id: 'MS-1', text: 'Plays on a phone', why: 'too tall' },
        { id: 'MS-4', text: 'Sounds right', why: 'Yours to judge: Listen' },
      ]);
      expect(waivers({ ref: { kind: 'cp2', milestone: 1 }, waivable: [], checks: [sound] })).toEqual([]);
    });
  });

  const FUN: InboxRef = { kind: 'fun_eval', round: 1 };
  const notFun = { status: 'failing', note: 'Dull' } as const;

  it('a fun evaluation can be approved with a not-fun mark once every check is marked', () => {
    expect(canApproveItem(FUN, checks, { 'AC-2': passing, 'AC-3': notFun })).toBe(true);
    expect(canApproveItem(FUN, checks, { 'AC-2': notFun, 'AC-3': notFun })).toBe(true);
    expect(canApproveItem(FUN, checks, { 'AC-2': passing })).toBe(false);
    expect(canApproveItem(FUN, checks, { 'AC-2': passing, 'AC-3': { note: 'half typed' } })).toBe(false);
    expect(canApproveItem(FUN, checks, {})).toBe(false);
  });

  it('fun marks read Fun and Not fun', () => {
    expect(markLabels(FUN)).toEqual({ passing: 'Fun', failing: 'Not fun' });
    expect(markLabels({ kind: 'cp4', milestone: 1 })).toEqual({ passing: 'Passing', failing: 'Failing' });
    expect(markLabels({ kind: 'cp1' })).toEqual({ passing: 'Passing', failing: 'Failing' });
  });

  it('a fun evaluation asks what the stakeholder felt', () => {
    expect(noteLabel(FUN, false)).toBe('What did you feel? (optional)');
    expect(noteLabel(FUN, true)).toBe('What did you feel? (required)');
    expect(noteLabel({ kind: 'cp4', milestone: 1 }, false)).toBe('Note (optional)');
    expect(noteLabel({ kind: 'cp4', milestone: 1 }, true)).toBe('What was wrong? (required)');
  });

  it('turns failed checks into the request comment', () => {
    expect(failedChecksComment(checks, { 'AC-3': { status: 'failing', note: 'Too quiet' } })).toBe('Failed checks:\n- AC-3 (Sounds right): Too quiet');
    expect(failedChecksComment(checks, {})).toBe('');
  });

  it('lists every failed check in the order of the checks, and skips the passing ones', () => {
    const marks = { 'AC-3': { status: 'failing', note: ' Too quiet ' }, 'AC-2': { status: 'failing', note: 'Unfair' } } as const;

    expect(failedChecksComment(checks, marks)).toBe('Failed checks:\n- AC-2 (Dodging feels fair): Unfair\n- AC-3 (Sounds right): Too quiet');
    expect(failedChecksComment(checks, { 'AC-2': passing, 'AC-3': { status: 'failing', note: 'quiet' } })).toBe('Failed checks:\n- AC-3 (Sounds right): quiet');
    expect(failedChecksComment(checks, { 'AC-2': passing })).toBe('');
  });

  it('leaves the colon off a failed check that has no note yet', () => {
    expect(failedChecksComment(checks, { 'AC-3': { status: 'failing', note: '  ' } })).toBe('Failed checks:\n- AC-3 (Sounds right)');
  });

  it('sends only marked checks', () => {
    expect(checkMarks(checks, { 'AC-3': { status: 'passing', note: '' } })).toEqual([{ ac: 'AC-3', status: 'passing', note: '' }]);
    expect(checkMarks(checks, { 'AC-3': { note: 'typed before choosing' } })).toEqual([]);
    expect(checkMarks([], {})).toEqual([]);
  });

  it('sends the marks in the order of the checks, with trimmed notes', () => {
    const marks = { 'AC-3': { status: 'failing', note: ' Too quiet ' }, 'AC-2': passing } as const;

    expect(checkMarks(checks, marks)).toEqual([
      { ac: 'AC-2', status: 'passing', note: '' },
      { ac: 'AC-3', status: 'failing', note: 'Too quiet' },
    ]);
  });

  it('holds back a request for changes while a failed check has no note', () => {
    expect(canRequestChanges(checks, {})).toBe(true);
    expect(canRequestChanges(checks, { 'AC-2': passing, 'AC-3': { status: 'failing', note: 'quiet' } })).toBe(true);
    expect(canRequestChanges(checks, { 'AC-3': { status: 'failing', note: '' } })).toBe(false);
    expect(canRequestChanges(checks, { 'AC-3': { status: 'failing', note: '   ' } })).toBe(false);
    expect(canRequestChanges(checks, { 'AC-2': { status: 'failing', note: 'unfair' }, 'AC-3': { status: 'failing', note: '' } })).toBe(false);
    expect(canRequestChanges(checks, { 'AC-3': passing })).toBe(true);
  });
});

describe('documentLink', () => {
  it('points a pin at its project\'s Documents page', () => {
    expect(documentLink('temp conv', 'SPEC-M1@2')).toBe('/projects/temp%20conv/documents#SPEC-M1%402');
  });
});

// A fun evaluation asks whether prototypes are fun, so its words differ from a milestone's wherever a check would read as a test.
describe('the words of a fun evaluation', () => {
  const FUN: InboxRef = { kind: 'fun_eval', round: 1 };
  const OTHERS: InboxRef[] = [{ kind: 'cp4', milestone: 1 }, { kind: 'cp1' }, { kind: 'cp2', milestone: 2 }];
  const checks = [
    { ac: 'P-1', text: 'One ship', how: 'Play it' },
    { ac: 'P-2', text: 'Two ships', how: 'Play it' },
  ];
  const marks = { 'P-1': { status: 'passing', note: '' }, 'P-2': { status: 'failing', note: 'Dull' } } as const;

  it('heads the checks Prototypes to play', () => {
    expect(checksHeading(FUN)).toBe('Prototypes to play');
    for (const ref of OTHERS) expect(checksHeading(ref)).toBe('Checks for you');
  });

  it('asks for another round rather than changes', () => {
    expect(requestChangesLabel(FUN)).toBe('Another round');
    for (const ref of OTHERS) expect(requestChangesLabel(ref)).toBe('Request changes');
  });

  // Not fun is a verdict, not a failure, and the PM reads each mark and note from the decision record anyway.
  it('starts the comment for another round empty', () => {
    expect(changesComment(FUN, checks, marks)).toBe('');
    expect(changesComment(OTHERS[0]!, checks, marks)).toBe('Failed checks:\n- P-2 (Two ships): Dull');
    expect(changesComment(OTHERS[0]!, checks, marks)).toBe(failedChecksComment(checks, marks));
  });

  it('says that rejecting ends the project for good and does not use the marks', () => {
    expect(rejectConfirm(FUN)).toBe('Reject this? Rejecting ends the project for good, and your marks are not used.');
    for (const ref of OTHERS) expect(rejectConfirm(ref)).toBe('Reject this?');
  });
});

describe('isTryLink', () => {
  const CP4: InboxRef = { kind: 'cp4', milestone: 1 };
  const TRY = 'http://127.0.0.1:4781/p/m1/index.html';

  it('links CP4\'s Try it when it leads to a port on this machine', () => {
    expect(isTryLink(CP4, { label: 'Try it', value: TRY })).toBe(true);
  });

  it.each([
    // The URL parser reads 127.0.0.1 and 4781 as a username and password, so the host is evil.example.
    ['an address whose host comes after a userinfo', 'Try it', 'http://127.0.0.1:4781@evil.example/p/m1/index.html'],
    ['a host that only starts with 127.0.0.1', 'Try it', 'http://127.0.0.1.evil.example:4781/'],
    ['https, which the try server never speaks', 'Try it', 'https://127.0.0.1:4781/'],
    ['no port', 'Try it', 'http://127.0.0.1/p/m1/'],
    ['a value that does not parse', 'Try it', 'http://127.0.0.1:port/'],
    // A worker's own summary starts this evidence, so it can hold any address.
    ['a try address under any other label', 'What the worker said', TRY],
  ])('leaves %s as text', (_case, label, value) => {
    expect(isTryLink(CP4, { label, value })).toBe(false);
  });

  it('leaves a Try it on any other item as text', () => {
    expect(isTryLink({ kind: 'escalation', taskId: 3 }, { label: 'Try it', value: TRY })).toBe(false);
  });

  const FUN: InboxRef = { kind: 'fun_eval', round: 1 };

  // The engine labels each prototype's link with the same prefix, so a label it makes is one the Inbox opens.
  it("opens the engine's own Play label", () => {
    expect(PLAY).toBe('Play ');
    expect(isTryLink(FUN, { label: `${PLAY}P-2`, value: TRY })).toBe(true);
  });

  it('Play links of a fun evaluation open like Try it', () => {
    expect(isTryLink(FUN, { label: 'Play P-1', value: 'http://127.0.0.1:4781/p/proto/p-1/index.html' })).toBe(true);
    expect(isTryLink(FUN, { label: 'Play P-3', value: TRY })).toBe(true);
  });

  it.each([
    ['a checkout path, when no try server is mounted', 'Play P-1', '/work/checkout/proto/p-1/index.html'],
    ['an address whose host comes after a userinfo', 'Play P-1', 'http://127.0.0.1:4781@evil.example/p-1/'],
    ['https', 'Play P-1', 'https://127.0.0.1:4781/'],
    ['no port', 'Play P-1', 'http://127.0.0.1/p-1/'],
    ['a plan pin, which is no Play link', 'PROTO-PLAN-1', TRY],
    ['a Try it, which only CP4 has', 'Try it', TRY],
    ['a label that only contains Play', 'Replay P-1', TRY],
  ])('leaves %s of a fun evaluation as text', (_case, label, value) => {
    expect(isTryLink(FUN, { label, value })).toBe(false);
  });

  it('leaves a Play link on any other item as text', () => {
    expect(isTryLink(CP4, { label: 'Play P-1', value: TRY })).toBe(false);
    expect(isTryLink({ kind: 'escalation', taskId: 3 }, { label: 'Play P-1', value: TRY })).toBe(false);
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

describe('the iteration ledger’s wording', () => {
  it('says how long something took in the unit that reads best', () => {
    expect([duration(0.2), duration(29), duration(90), duration(59 * 60), duration(3 * 3600 + 5 * 60), duration(3 * 86400)]).toEqual(['1 s', '29 s', '2 min', '59 min', '3 h 05 min', '3 days']);
  });

  it('gives the day and the local time a visit started', () => {
    expect(when(new Date(2026, 10, 9, 14, 5).toISOString())).toBe('9 Nov 14:05');
  });

  it('labels a run by what came of it, with a failure named', () => {
    const run = { attemptId: 1, k: 2, outcome: 'fail' as const, failureKind: 'check_failed', startedAt: '', seconds: 90, usdEst: 0.1, review: false };
    expect(runLabel(run)).toBe('Attempt 2: checks failed, 2 min, $0.10');
    expect(runLabel({ ...run, k: 1, outcome: 'ok', failureKind: null, seconds: 8, usdEst: null, review: true })).toBe('Review 1: passed, 8 s, –');
    expect(runLabel({ ...run, outcome: 'back', failureKind: 'changes_requested' })).toBe('Attempt 2: sent back by review, 2 min, $0.10');
  });

  it('names a task by its purpose, and plain work as a ticket', () => {
    expect([purposeLabel(null), purposeLabel('cr_recommendation'), purposeLabel('new_kind_of_work')]).toEqual(['ticket', 'change request advice', 'new kind of work']);
    expect([roleChip('qa_engineer'), roleChip('designer')]).toEqual(['QA', 'DES']);
  });

  it('folds a long quote and leaves a short one whole', () => {
    expect(foldedQuote('Make it faster')).toBeNull();
    const folded = foldedQuote(`${'a'.repeat(179)} ${'b'.repeat(60)}`);
    expect(folded).toBe(`${'a'.repeat(179)}…`);
  });

  it('says where a visit went next', () => {
    const visit = { stage: 'verify', to: '2026-11-01T10:00:00Z', exit: 'build', back: true };
    expect(thenOf(visit)).toEqual({ tag: 'back', text: 'back to Build' });
    expect(thenOf({ ...visit, exit: 'eng_review', back: false })).toEqual({ tag: null, text: 'Eng review' });
    expect(thenOf({ ...visit, to: null, exit: null, back: false })).toEqual({ tag: 'run', text: 'in progress' });
    expect(thenOf({ ...visit, stage: 'merged', exit: null, back: false })).toEqual({ tag: 'ok', text: 'merged' });
    expect(thenOf({ ...visit, exit: 'halted', back: false })).toEqual({ tag: null, text: 'Halted' });
  });

  it('adds up the sections, with no cost when no run had one', () => {
    const section = { scope: 0, title: '', visits: [], seconds: 0, runs: 3, failed: 1, usdEst: 0.5, decisions: 2, loops: 1 };
    expect(ledgerTotals({ sections: [section, { ...section, usdEst: null }] })).toEqual({ runs: 6, failed: 2, usdEst: 0.5, decisions: 4, loops: 2 });
    expect(ledgerTotals({ sections: [{ ...section, usdEst: null }] }).usdEst).toBeNull();
  });
});

describe('a role’s provenance, as the page draws it', () => {
  const line = (text: string, sha: string | null, date: string | null): CharterLine => ({ text, sha, date, source: sha === null ? null : 'knowledge', subject: sha === null ? null : `${sha} subject` });
  const lines = [
    line('one', 'aaa', '2026-01-01T00:00:00.000Z'),
    line('two', 'aaa', '2026-01-01T00:00:00.000Z'),
    line('three', 'bbb', '2026-03-01T00:00:00.000Z'),
    line('four', null, null),
    line('five', 'aaa', '2026-01-01T00:00:00.000Z'),
  ];

  it('names a commit on the first line of each run of lines it wrote, and shades older lines lighter', () => {
    const rows = charterRows(lines, null);

    expect(rows.map(({ first }) => first)).toEqual([true, false, true, true, true]);
    expect(rows.map(({ ink }) => ink)).toEqual([25, 25, 90, null, 25]);
    expect(rows.map(({ look }) => look)).toEqual(['', '', '', '', '']);
  });

  it('lights the selected change’s lines and dims the rest, what no commit has yet included', () => {
    expect(charterRows(lines, 'aaa').map(({ look }) => look)).toEqual(['hit', 'hit', 'dim', 'dim', 'hit']);
    expect(charterRows(lines, changeKey({ sha: null })).map(({ look }) => look)).toEqual(['dim', 'dim', 'dim', 'hit', 'dim']);
    expect(linesFrom(lines, 'aaa')).toBe(3);
    expect(linesFrom(lines, 'ccc')).toBe(0);
  });

  it('shades a charter from a single commit as new, and one no commit has seen not at all', () => {
    expect(charterRows([line('x', 'aaa', '2026-01-01T00:00:00.000Z')], null).map(({ ink }) => ink)).toEqual([90]);
    expect(charterRows([line('x', null, null)], null)).toEqual([expect.objectContaining({ ink: null, first: true, key: 'uncommitted' })]);
    expect(charterRows([], 'aaa')).toEqual([]);
  });

  it('names roles, files and days for people', () => {
    expect(roleName('pm')).toBe('Product Manager');
    expect(roleName('engineer.watchos')).toBe('Engineer watchos');
    expect(roleName('data_scientist')).toBe('Data scientist');
    expect(rolePath('a b')).toBe('/roles/a%20b');
    expect(fileLabel({ kind: 'schema', path: 'schemas/spec.json' })).toBe('spec.json');
    expect(fileLabel({ kind: 'other', path: 'roles/pm/notes.md' })).toBe('notes.md');
    expect(fileLabel({ kind: 'charter', path: 'roles/pm/charter.md' })).toBe('charter');
    expect(day('2026-11-07T12:00:00.000Z')).toBe('7 Nov 2026');
  });

  it('joins a commit message’s wrapped lines and keeps its list items and paragraphs', () => {
    const body = ['- QA tickets carry a Tests section from the', '  Tech Design, and the engineer', 'charter says so.', '- One Play label.', 'Then a sentence.', '', 'Co-Authored-By: someone'].join('\n');

    expect(unwrap(body)).toBe(
      ['- QA tickets carry a Tests section from the Tech Design, and the engineer charter says so.', '- One Play label.', 'Then a sentence.', '', 'Co-Authored-By: someone'].join('\n'),
    );
    expect(unwrap('')).toBe('');
  });
});
