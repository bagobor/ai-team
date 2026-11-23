import type { LessonFile } from '../src/roles/provenance.ts';
import type { PastAttempt } from '../src/trials/source.ts';
import type { Measured } from '../src/trials/types.ts';
import type { TaskView, TrialView } from '../src/trials/view.ts';
import { answerWords, armLabel, cannotCommit, cannotStart, cost, howTried, isWorking, judgeLabel, measuredChips, pick, pretty, sourcesOf, trialState, unanswered } from '../web/src/lib/trials.ts';

const GOOD: Measured = { parses: true, checks: true, changed: true, tests: true, usd: 0.21, note: null };
const attempt = (attemptId: number, replayable = true) => ({ attemptId, replayable }) as PastAttempt;

describe('a trial, as the pages say it', () => {
  it('says what a trial is doing or how it ended', () => {
    expect(trialState({ state: 'running', committed: false })).toBe('Making its runs');
    expect(trialState({ state: 'awaiting_answer', committed: false })).toBe('Waiting for your answer');
    expect(trialState({ state: 'agreed', committed: false })).toBe('Agreed');
    expect(trialState({ state: 'agreed', committed: true })).toBe('Agreed and committed');
    expect(trialState({ state: 'agreed', committed: true }, true)).toBe('Agreed, committed, then undone');
    expect(['running', 'judging', 'awaiting_answer', 'stopped', 'agreed'].map((state) => isWorking({ state } as TrialView))).toEqual([true, true, false, false, false]);
  });

  it('names each result, each judge and each answer for people', () => {
    expect(armLabel('current')).toBe('A run today on the committed knowledge');
    expect(judgeLabel('local')).toBe('Local judge (not counted)');
    expect(judgeLabel('stakeholder')).toBe('You');
    expect([1, 0.7, 2 / 3, 0.31, 0.3, 0].map(answerWords)).toEqual(['Yes (100%)', 'Yes (70%)', 'Unsure (67%)', 'Unsure (31%)', 'No (30%)', 'No (0%)']);
    expect([cost(0.214), cost(null)]).toEqual(['$0.21', 'cost unknown']);
    expect(pretty({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(pretty(null)).toBe('');
  });

  it('shows what was counted about a result, and only what applies to its task', () => {
    expect(measuredChips(GOOD, true)).toEqual([
      { label: 'Answer fits what was asked', ok: true },
      { label: 'Changed something', ok: true },
      { label: 'No tests missing', ok: true },
      { label: 'Commands pass', ok: true },
    ]);
    expect(measuredChips({ ...GOOD, changed: false, tests: null, checks: null }, true).slice(1)).toEqual([
      { label: 'Changed nothing', ok: false },
      { label: 'No tests missing', ok: null },
      { label: 'Commands pass', ok: null },
    ]);
    expect(measuredChips({ ...GOOD, tests: false, checks: false }, true).slice(2).map(({ label }) => label)).toEqual(['Tests missing', 'Commands fail']);
    expect(measuredChips({ ...GOOD, parses: false, checks: null, changed: null, tests: null }, false)).toEqual([{ label: 'Answer doesn’t fit what was asked', ok: false }]);
    expect(measuredChips(null, true)).toEqual([]);
  });

  it('keeps a task in one group or neither', () => {
    const start = { problem: [1, 2], fine: [3] };

    expect(pick(start, 3, 'problem')).toEqual({ problem: [1, 2, 3], fine: [] });
    expect(pick(start, 1, 'fine')).toEqual({ problem: [2], fine: [3, 1] });
    expect(pick(start, 2, 'none')).toEqual({ problem: [1], fine: [3] });
    expect(pick(start, 1, 'problem')).toEqual({ problem: [2, 1], fine: [3] });
  });

  it('says what a trial still needs before it can start', () => {
    const past = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => attempt(id, id !== 8));
    const asked = ['Does it list every command?', ' '];

    expect(cannotStart([' '], { problem: [1, 2, 3], fine: [4, 5] }, past)).toBe('Say what you expected, as at least one question');
    expect(cannotStart(asked, { problem: [1], fine: [4, 5, 6] }, past)).toBe('Pick at least 2 tasks that showed the problem');
    expect(cannotStart(asked, { problem: [1, 2, 3], fine: [4] }, past)).toBe('Pick at least 2 tasks that went fine');
    expect(cannotStart(asked, { problem: [1, 2], fine: [4, 5] }, past)).toBe('Pick 1 more: a trial takes 5 to 7 tasks');
    expect(cannotStart(asked, { problem: [1, 2, 3, 4], fine: [5, 6, 7, 8] }, past)).toBe('Drop 1: a trial takes 5 to 7 tasks');
    expect(cannotStart(asked, { problem: [1, 2, 3], fine: [4, 8] }, past)).toBe('Attempt 8 can’t be run again');
    expect(cannotStart(asked, { problem: [1, 2, 3], fine: [4, 5] }, past)).toBeNull();
  });

  it('knows which tasks the stakeholder has yet to answer', () => {
    const tasks = [{ attemptId: 1 }, { attemptId: 2 }, { attemptId: 3 }] as TaskView[];

    expect(unanswered(tasks, { 1: 'A', 3: 'same' }).map(({ attemptId }) => attemptId)).toEqual([2]);
    expect(unanswered(tasks, { 1: 'A', 2: 'B', 3: 'same' })).toEqual([]);
  });

  it('says why a draft can’t be committed from a trial', () => {
    const ended: Pick<TrialView, 'state' | 'commits' | 'draftMoved' | 'verdict'> = { state: 'agreed', commits: null, draftMoved: false, verdict: { worse: [], judges: {}, agreed: true } };

    expect(cannotCommit(ended)).toBeNull();
    expect(cannotCommit({ ...ended, draftMoved: true })).toBe('The draft has changed since this trial tried it. Try it again as it is now.');
    expect(cannotCommit({ ...ended, state: 'awaiting_answer' })).toBe('The trial has not ended');
    expect(cannotCommit({ ...ended, state: 'not_agreed', verdict: { worse: [], judges: {}, agreed: false } })).toBe('Not everyone who counts called the draft an improvement');
    expect(cannotCommit({ ...ended, state: 'not_agreed', verdict: { worse: ['T-1: its commands no longer pass'], judges: {}, agreed: false } })).toBe('Something that can be counted got worse with the draft');
    expect(cannotCommit({ ...ended, commits: { knowledge: 'abc' } })).toBe('This draft has been committed');
    expect(cannotCommit({ ...ended, commits: { knowledge: 'abc', undone: { knowledge: 'def' } } })).toBe('This draft was committed and then undone');
  });

  it('reads the sources of an entry from what was typed', () => {
    expect(sourcesOf('DEC-1@1, M1-T-4 attempt 2\n\n your note of 11 Nov ')).toEqual(['DEC-1@1', 'M1-T-4 attempt 2', 'your note of 11 Nov']);
    expect(sourcesOf(' ')).toEqual([]);
  });

  it('tells a change that passed a trial from one made by hand, and leaves the seed’s and other files’ alone', () => {
    const touching = (...kinds: LessonFile['kind'][]) => kinds.map((kind) => ({ kind }) as LessonFile);

    expect(howTried({ trial: 4, source: 'knowledge', files: touching('playbook') })).toBe('trial');
    expect(howTried({ undoes: 4, source: 'knowledge', files: touching('playbook') })).toBe('undo');
    expect(howTried({ source: 'knowledge', files: touching('config', 'charter') })).toBe('untried');
    expect(howTried({ source: 'knowledge', files: touching('schema') })).toBeNull();
    expect(howTried({ source: 'seed', files: touching('charter') })).toBeNull();
    expect(howTried({ source: 'uncommitted', files: touching('playbook') })).toBeNull();
  });
});
