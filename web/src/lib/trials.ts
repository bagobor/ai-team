import type { Lesson } from '../../../src/roles/provenance.ts';
import type { PastAttempt } from '../../../src/trials/source.ts';
import type { Arm, JudgeName, Letter, Measured } from '../../../src/trials/types.ts';
import type { TaskView, TrialSummary, TrialView } from '../../../src/trials/view.ts';

// Wording and decisions for the draft and trial pages. The engine decides what is allowed; these say it to a person
// before they press the button.

export const draftPath = (id: number) => `/drafts/${id}`;
export const trialPath = (id: number) => `/trials/${id}`;

export const MAX_EXPECTATIONS = 3;
// The engine's own limits on a trial's tasks, said here so the form can say what is missing before it is sent.
export const TASKS = { min: 5, max: 7, ofEachGroup: 2 };

const STATE: Record<TrialSummary['state'], string> = {
  running: 'Making its runs',
  judging: 'Being judged',
  awaiting_answer: 'Waiting for your answer',
  agreed: 'Agreed',
  not_agreed: 'Not agreed',
  stopped: 'Stopped',
};

// What a trial is doing, or how it ended. One that was committed says so, and one undone since says that.
export function trialState({ state, committed }: Pick<TrialSummary, 'state' | 'committed'>, undone = false): string {
  if (undone) return 'Agreed, committed, then undone';
  return committed ? 'Agreed and committed' : STATE[state];
}

// A trial with work the engine is still doing, which the page keeps asking about.
export const isWorking = ({ state }: Pick<TrialSummary, 'state'>): boolean => state === 'running' || state === 'judging';

const ARM: Record<Arm, string> = { stored: 'The result stored then', current: 'A run today on the committed knowledge', draft: 'A run with the draft' };
export const armLabel = (arm: Arm): string => ARM[arm];

const JUDGE: Record<JudgeName, string> = { model: 'Model judge', evaluator: 'Evaluator', local: 'Local judge (not counted)' };
export const judgeLabel = (judge: string): string => (judge === 'stakeholder' ? 'You' : (JUDGE[judge as JudgeName] ?? judge));

// A probability as a judge's answer in words: yes, no, or unsure with the share that said yes.
export function answerWords(p: number): string {
  const share = `${Math.round(p * 100)}%`;
  return p >= 0.7 ? `Yes (${share})` : p <= 0.3 ? `No (${share})` : `Unsure (${share})`;
}

export type Chip = { label: string; ok: boolean | null };

// What was counted about one result. A count that doesn't apply to the task is left out; one the run never reached
// is shown as unknown.
export function measuredChips(measured: Measured | null, isTicket: boolean): Chip[] {
  if (measured === null) return [];
  return [
    { label: measured.parses ? 'Answer fits what was asked' : 'Answer doesn’t fit what was asked', ok: measured.parses },
    ...(isTicket
      ? [
          { label: measured.changed === false ? 'Changed nothing' : 'Changed something', ok: measured.changed },
          // A ticket with no component to test passes this too, so it says that nothing is missing, not that tests exist.
          { label: measured.tests === false ? 'Tests missing' : 'No tests missing', ok: measured.tests },
          { label: measured.checks === false ? 'Commands fail' : 'Commands pass', ok: measured.checks },
        ]
      : []),
  ];
}

export const cost = (usd: number | null): string => (usd === null ? 'cost unknown' : `$${usd.toFixed(2)}`);

export type Selection = { problem: number[]; fine: number[] };

// A task is in one group or neither. Picking it for one takes it out of the other.
export function pick({ problem, fine }: Selection, attemptId: number, group: 'problem' | 'fine' | 'none'): Selection {
  const without = (ids: number[]) => ids.filter((id) => id !== attemptId);
  return { problem: group === 'problem' ? [...without(problem), attemptId] : without(problem), fine: group === 'fine' ? [...without(fine), attemptId] : without(fine) };
}

// Why a trial can't start yet, or null when it can.
export function cannotStart(expectations: string[], { problem, fine }: Selection, attempts: PastAttempt[]): string | null {
  const asked = expectations.filter((expectation) => expectation.trim() !== '');
  if (asked.length === 0) return 'Say what you expected, as at least one question';
  const total = problem.length + fine.length;
  if (problem.length < TASKS.ofEachGroup) return `Pick at least ${TASKS.ofEachGroup} tasks that showed the problem`;
  if (fine.length < TASKS.ofEachGroup) return `Pick at least ${TASKS.ofEachGroup} tasks that went fine`;
  if (total < TASKS.min) return `Pick ${TASKS.min - total} more: a trial takes ${TASKS.min} to ${TASKS.max} tasks`;
  if (total > TASKS.max) return `Drop ${total - TASKS.max}: a trial takes ${TASKS.min} to ${TASKS.max} tasks`;
  const gone = [...problem, ...fine].find((id) => !attempts.some((attempt) => attempt.attemptId === id && attempt.replayable));
  return gone === undefined ? null : `Attempt ${gone} can’t be run again`;
}

export type Choices = Record<string, Letter | 'same'>;

// The tasks the stakeholder has yet to answer.
export const unanswered = (tasks: TaskView[], choices: Choices): TaskView[] => tasks.filter(({ attemptId }) => choices[String(attemptId)] === undefined);

// Why the draft can't be committed from this trial, or null when it can.
export function cannotCommit(trial: Pick<TrialView, 'state' | 'commits' | 'draftMoved' | 'verdict'>): string | null {
  if (trial.commits !== null) return trial.commits.undone ? 'This draft was committed and then undone' : 'This draft has been committed';
  if (trial.state === 'not_agreed') return trial.verdict?.worse.length ? 'Something that can be counted got worse with the draft' : 'Not everyone who counts called the draft an improvement';
  if (trial.state !== 'agreed') return 'The trial has not ended';
  if (trial.draftMoved) return 'The draft has changed since this trial tried it. Try it again as it is now.';
  return null;
}

// What an entry in the draft was learnt from, as the text box holds it and as the engine takes it.
export const sourcesOf = (text: string): string[] => text.split(/[,\n]/).map((source) => source.trim()).filter((source) => source !== '');

export function pretty(output: unknown): string {
  return output === null || output === undefined ? '' : JSON.stringify(output, null, 2);
}

// How a change to a role's charter or playbook got in: through a trial, as the taking back of one, or by hand with no
// trial. The seed's own changes and ones to other files are none of these.
export function howTried({ trial, undoes, source, files }: Pick<Lesson, 'trial' | 'undoes' | 'source' | 'files'>): 'trial' | 'undo' | 'untried' | null {
  if (trial !== undefined) return 'trial';
  if (undoes !== undefined) return 'undo';
  return source === 'knowledge' && files.some(({ kind }) => kind === 'charter' || kind === 'playbook') ? 'untried' : null;
}
