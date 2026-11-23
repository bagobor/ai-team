import type { Answer, Arm, JudgeName, JudgmentRow, Knowledge, Measured, ResultRow, TrialRow, TrialTask } from '../src/trials/types.ts';
import { baselineOf, judgeVerdict, measuredWorse, stakeholderVerdict, verdictOf } from '../src/trials/verdict.ts';

const NONE: Knowledge = { charter: '', playbook: '', memory_project: '', memory_role: '' };
const GOOD: Measured = { parses: true, checks: true, changed: true, tests: true, usd: 0.2, note: null };

// Tasks 1 to 3 showed the problem and 4 and 5 went fine. Task 3 was run on the committed knowledge too.
const TASKS: TrialTask[] = [
  { attemptId: 1, group: 'problem', letters: { A: 'stored', B: 'draft' } },
  { attemptId: 2, group: 'problem', letters: { A: 'draft', B: 'stored' } },
  { attemptId: 3, group: 'problem', letters: { A: 'stored', B: 'current', C: 'draft' } },
  { attemptId: 4, group: 'fine', letters: { A: 'stored', B: 'draft' } },
  { attemptId: 5, group: 'fine', letters: { A: 'stored', B: 'draft' } },
];
const trial = { id: 1, tasks: TASKS, expectations: ['Lists every command?', 'Says what each returned?'], knowledge: { project: null, current: NONE, draft: NONE, elsewhere: {} } } as unknown as TrialRow;
const LABELS = { 1: 'T-1', 2: 'T-2', 3: 'T-3', 4: 'T-4', 5: 'T-5' };

const result = (attempt_id: number, arm: Arm, measured: Partial<Measured> = {}): ResultRow => ({ id: 0, trial_id: 1, attempt_id, arm, state: 'done', output: {}, measured: { ...GOOD, ...measured }, fingerprint: null, error: null });
const everyResult = (over: ResultRow[] = []): ResultRow[] =>
  TASKS.flatMap((task) => Object.values(task.letters).map((arm) => over.find((one) => one.attempt_id === task.attemptId && one.arm === arm) ?? result(task.attemptId, arm)));

// met is how many of the two expectations each side meets on each task: [baseline, draft].
const judgment = (judge: JudgeName, attempt_id: number, [before, after]: [number, number], p = 1): JudgmentRow => {
  const task = TASKS.find(({ attemptId }) => attemptId === attempt_id)!;
  const side = (arm: Arm, met: number): Answer[] => [0, 1].map((expectation) => ({ arm, expectation, p: expectation < met ? p : 0, passage: null }));
  return { id: 0, trial_id: 1, attempt_id, judge, state: 'done', answers: [...side(baselineOf(task), before), ...side('draft', after)], error: null };
};
const judgedBy = (judge: JudgeName, met: [number, number][]): JudgmentRow[] => met.map((counts, i) => judgment(judge, i + 1, counts));

describe('what a draft is compared with', () => {
  it('is the run on the committed knowledge where there is one, else the stored result', () => {
    expect(TASKS.map(baselineOf)).toEqual(['stored', 'stored', 'current', 'stored', 'stored']);
  });
});

describe('what can be counted', () => {
  it('finds nothing worse when every count holds and the cost is about the same', () => {
    expect(measuredWorse(trial, everyResult([result(1, 'draft', { usd: 0.28 })]), LABELS)).toEqual([]);
  });

  it('names each count that was right before and is not with the draft', () => {
    const results = everyResult([result(1, 'draft', { checks: false }), result(2, 'draft', { parses: false, checks: null, changed: null, tests: null }), result(4, 'draft', { changed: false, tests: null, checks: null })]);

    expect(measuredWorse(trial, results, LABELS)).toEqual([
      'T-1: its commands no longer pass',
      'T-2: its answer no longer fits what was asked for',
      'T-2: it changed nothing',
      'T-2: the tests it had to add are missing',
      'T-2: its commands no longer pass',
      'T-4: it changed nothing',
      'T-4: the tests it had to add are missing',
      'T-4: its commands no longer pass',
    ]);
  });

  it('holds the draft to the run on the committed knowledge, not to the stored result, where both exist', () => {
    expect(measuredWorse(trial, everyResult([result(3, 'stored', { checks: true }), result(3, 'current', { checks: false }), result(3, 'draft', { checks: false })]), LABELS)).toEqual([]);
    expect(measuredWorse(trial, everyResult([result(3, 'stored', { checks: false }), result(3, 'current', { checks: true }), result(3, 'draft', { checks: false })]), LABELS)).toEqual(['T-3: its commands no longer pass']);
  });

  it('doesn’t count against the draft what was already wrong, or what a task has nothing to count for', () => {
    const document = { checks: null, changed: null, tests: null };
    expect(measuredWorse(trial, everyResult([result(1, 'stored', { checks: false }), result(1, 'draft', { checks: false }), result(2, 'stored', document), result(2, 'draft', document)]), LABELS)).toEqual([]);
  });

  it('counts the cost only when it is more than half as much again over all the tasks', () => {
    const costing = (usd: number) => everyResult(TASKS.map((task) => result(task.attemptId, 'draft', { usd })));

    expect(measuredWorse(trial, costing(0.3), LABELS)).toEqual([]);
    expect(measuredWorse(trial, costing(0.32), LABELS)).toEqual(['It cost $1.60 over these tasks against $1.00, more than half as much again']);
  });
});

describe('a judge’s verdict', () => {
  it('is an improvement when the draft meets more expectations on the problem tasks and no fewer on any that went fine', () => {
    expect(judgeVerdict(trial, judgedBy('model', [[0, 2], [1, 1], [0, 1], [2, 2], [1, 2]]))).toEqual({ improvement: true, why: 'On the tasks that showed the problem, the draft meets 4 of 6 expectations, against 1 without it.' });
  });

  it('is none when the problem tasks are no better', () => {
    expect(judgeVerdict(trial, judgedBy('model', [[1, 1], [1, 1], [0, 0], [2, 2], [2, 2]]))).toMatchObject({ improvement: false, why: 'On the tasks that showed the problem, the draft meets 2 of 6 expectations, against 2 without it.' });
  });

  it('is none when a task that went fine meets fewer, however much better the others', () => {
    expect(judgeVerdict(trial, judgedBy('model', [[0, 2], [0, 2], [0, 2], [2, 1], [2, 2]]))).toEqual({ improvement: false, why: 'On the tasks that showed the problem, the draft meets 6 of 6 expectations, against 0 without it. On 1 task that went fine it meets fewer.' });
  });

  it('takes an answer the judge was unsure of as not met', () => {
    const unsure = [judgment('model', 1, [0, 2], 2 / 3), ...judgedBy('model', [[0, 0], [0, 0], [0, 0], [2, 2], [2, 2]]).slice(1)];

    expect(judgeVerdict(trial, unsure)).toMatchObject({ improvement: false });
    expect(judgeVerdict(trial, [judgment('model', 1, [0, 2], 0.7), ...unsure.slice(1)])).toMatchObject({ improvement: true });
  });
});

describe('the stakeholder’s verdict', () => {
  it('is an improvement when the draft’s result is better on more problem tasks than it is worse, and worse on none that went fine', () => {
    expect(stakeholderVerdict(trial, { 1: 'draft', 2: 'draft', 3: 'current', 4: 'same', 5: 'draft' })).toEqual({ improvement: true, why: 'On the tasks that showed the problem, you found the draft’s result better on 2 and worse on 1 of 3.' });
  });

  it('is none when it is better on no more than it is worse, or worse on a task that went fine', () => {
    expect(stakeholderVerdict(trial, { 1: 'draft', 2: 'stored', 3: 'same', 4: 'same', 5: 'same' })).toMatchObject({ improvement: false });
    expect(stakeholderVerdict(trial, { 1: 'draft', 2: 'draft', 3: 'draft', 4: 'stored', 5: 'same' })).toEqual({ improvement: false, why: 'On the tasks that showed the problem, you found the draft’s result better on 3 and worse on 0 of 3. On 1 task that went fine you found it worse.' });
  });
});

describe('whether a draft may be committed', () => {
  const better: [number, number][] = [[0, 2], [0, 2], [0, 2], [2, 2], [2, 2]];
  const same: [number, number][] = [[1, 1], [1, 1], [1, 1], [2, 2], [2, 2]];
  const yes = { 1: 'draft', 2: 'draft', 3: 'draft', 4: 'same', 5: 'same' } as const;

  it('is agreed when nothing counted got worse and the model, the evaluator and the stakeholder each call it an improvement', () => {
    const verdict = verdictOf(trial, everyResult(), [...judgedBy('model', better), ...judgedBy('evaluator', better)], yes, LABELS);

    expect(verdict).toMatchObject({ agreed: true, worse: [], judges: { model: { improvement: true }, evaluator: { improvement: true }, stakeholder: { improvement: true } } });
    expect(verdict.judges.local).toBeUndefined();
  });

  it.each([
    ['the model judge', [...judgedBy('model', same), ...judgedBy('evaluator', better)], yes],
    ['the evaluator', [...judgedBy('model', better), ...judgedBy('evaluator', same)], yes],
    ['the stakeholder', [...judgedBy('model', better), ...judgedBy('evaluator', better)], { ...yes, 1: 'stored', 2: 'stored' } as const],
  ])('is not agreed when %s does not', (_who, judgments, human) => {
    expect(verdictOf(trial, everyResult(), judgments, human, LABELS).agreed).toBe(false);
  });

  it('is not agreed when something counted got worse, whatever the judges say', () => {
    const verdict = verdictOf(trial, everyResult([result(4, 'draft', { checks: false })]), [...judgedBy('model', better), ...judgedBy('evaluator', better)], yes, LABELS);

    expect(verdict).toMatchObject({ agreed: false, worse: ['T-4: its commands no longer pass'], judges: { model: { improvement: true }, stakeholder: { improvement: true } } });
  });

  it('needs no evaluator for a role that has none', () => {
    expect(verdictOf(trial, everyResult(), judgedBy('model', better), yes, LABELS)).toMatchObject({ agreed: true, judges: { model: { improvement: true } } });
  });

  it('shows what a local model made of it, and lets it decide nothing', () => {
    const verdict = verdictOf(trial, everyResult(), [...judgedBy('model', better), ...judgedBy('local', same)], yes, LABELS);

    expect(verdict).toMatchObject({ agreed: true, judges: { local: { improvement: false } } });
    const partly = verdictOf(trial, everyResult(), [...judgedBy('model', better), ...judgedBy('local', same).slice(0, 2)], yes, LABELS);
    expect(partly.judges.local).toBeUndefined();
  });
});
