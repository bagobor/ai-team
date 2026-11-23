import { parseEntries } from '../knowledge/entries.ts';
import { draftKnowledge, knowledgeHash } from './drafts.ts';
import { Refused } from './errors.ts';
import { diffOf, masked } from './judging.ts';
import { replaySource } from './source.ts';
import type { TrialDeps } from './trial.ts';
import type { Arm, JudgeName, Knowledge, Letter, Measured, ResultRow, TrialRow, TrialState, TrialTask, Verdict } from './types.ts';
import { baselineOf, verdictOf } from './verdict.ts';

// One result as the page shows it. arm is null while the stakeholder has yet to answer, so they judge the work and
// not its label; the stored result of a task with three keeps its label, since knowing it gives away neither of the
// other two.
export type ResultView = { letter: Letter; arm: Arm | null; state: ResultRow['state']; output: unknown; diff: string | null; measured: Measured | null; error: string | null };

export type JudgmentView = { judge: JudgeName; state: string; error: string | null; answers: { letter: Letter; expectation: number; p: number; passage: string | null }[] };

// compare is the two results the stakeholder is asked about. answer is what they said, by letter. judgments are the
// other judges' answers, which stay hidden until the stakeholder has given theirs.
export type TaskView = {
  attemptId: number;
  group: TrialTask['group'];
  project: string;
  ticketId: string;
  title: string;
  purpose: string;
  results: ResultView[];
  compare: [Letter, Letter];
  answer: Letter | 'same' | null;
  judgments: JudgmentView[] | null;
  notes: string[];
};

export type TrialView = {
  id: number;
  draftId: number;
  roleId: string;
  state: TrialState;
  stopReason: string | null;
  expectations: string[];
  capUsd: number;
  spentUsd: number;
  createdAt: string;
  endedAt: string | null;
  // The stakeholder has answered, so every label and every other judge's answer is shown.
  revealed: boolean;
  progress: { runs: { done: number; total: number }; judgments: { done: number; total: number } };
  tasks: TaskView[];
  verdict: Verdict | null;
  commits: TrialRow['commits'];
  // The draft is no longer what this trial tried, so the trial says nothing about it as it stands.
  draftMoved: boolean;
};

export type TrialSummary = Pick<TrialView, 'id' | 'draftId' | 'roleId' | 'state' | 'stopReason' | 'createdAt' | 'endedAt' | 'spentUsd' | 'capUsd'> & { agreed: boolean | null; committed: boolean };

const ENDED: TrialState[] = ['agreed', 'not_agreed'];
const COUNTS = ['parses', 'checks', 'changed', 'tests'] as const;

export function summaryOf(trial: TrialRow): TrialSummary {
  return {
    id: trial.id,
    draftId: trial.draft_id,
    roleId: trial.role_id,
    state: trial.state,
    stopReason: trial.stop_reason,
    createdAt: trial.created_at,
    endedAt: trial.ended_at,
    spentUsd: trial.spent_usd,
    capUsd: trial.cap_usd,
    agreed: trial.verdict?.agreed ?? null,
    committed: trial.commits !== null,
  };
}

const lettersOf = (task: TrialTask): [Letter, Arm][] => (Object.entries(task.letters) as [Letter, Arm][]).sort(([a], [b]) => a.localeCompare(b));
const letterOf = (task: TrialTask, arm: Arm): Letter => lettersOf(task).find(([, one]) => one === arm)![0];

// The sources of every entry the draft adds or changes. A task named among them is where a lesson came from.
function draftSources({ current, draft }: { current: Knowledge; draft: Knowledge }): string[] {
  const entriesOf = (knowledge: Knowledge) => [...parseEntries(knowledge.playbook, 'PB').entries, ...parseEntries(knowledge.memory_project, 'MEM').entries, ...parseEntries(knowledge.memory_role, 'MEM').entries];
  const before = new Map(entriesOf(current).map((entry) => [entry.id, entry.text]));
  return entriesOf(draft).filter((entry) => before.get(entry.id) !== entry.text).flatMap(({ sources }) => sources);
}

export async function viewTrial(deps: TrialDeps, trial: TrialRow): Promise<TrialView> {
  const { trials } = deps;
  const results = await trials.listResults(trial.id);
  const judgments = await trials.listJudgments(trial.id);
  const revealed = ENDED.includes(trial.state);
  const sources = draftSources(trial.knowledge);
  const draft = await trials.getDraft(trial.draft_id);

  const tasks = await Promise.all(
    trial.tasks.map(async (task): Promise<TaskView> => {
      const found = await replaySource(deps, task.attemptId);
      const mine = results.filter((one) => one.attempt_id === task.attemptId);
      const three = lettersOf(task).length === 3;
      const shown = await Promise.all(
        lettersOf(task).map(async ([letter, arm]): Promise<ResultView> => {
          const result = mine.find((one) => one.arm === arm);
          const diff = found.ok && result?.state === 'done' ? await diffOf(deps, trial, found.source, arm) : null;
          const blind = (text: string) => (revealed ? text : masked(text));
          return {
            letter,
            arm: revealed || (three && arm === 'stored') ? arm : null,
            state: result?.state ?? 'pending',
            output: result?.output == null ? null : (JSON.parse(blind(JSON.stringify(result.output))) as unknown),
            diff: diff === null ? null : blind(diff),
            measured: result?.measured ?? null,
            error: result?.error ?? null,
          };
        }),
      );
      const [stored, current] = [mine.find(({ arm }) => arm === 'stored')?.measured, mine.find(({ arm }) => arm === 'current')?.measured];
      const ticketId = found.ok ? found.source.task.ticket_id : `attempt ${task.attemptId}`;
      const notes = [
        ...(sources.some((source) => source.includes(ticketId)) ? ['One of the draft’s entries names this task as where it came from. A better result here shows the lesson works where it was learnt, and says nothing of anywhere else.'] : []),
        ...(stored && current && COUNTS.some((count) => stored[count] !== current[count]) ? ['The result stored then and a run on the committed knowledge today differ, with no draft involved. This role’s results on this task vary from run to run, or have changed since.'] : []),
      ];
      const chosen = trial.human?.[String(task.attemptId)];
      return {
        attemptId: task.attemptId,
        group: task.group,
        project: found.ok ? found.source.project.name : '',
        ticketId,
        title: found.ok ? found.source.task.title : '',
        purpose: found.ok ? (found.source.task.purpose ?? 'ticket') : '',
        results: shown,
        compare: [letterOf(task, baselineOf(task)), letterOf(task, 'draft')].sort() as [Letter, Letter],
        answer: chosen === undefined ? null : chosen === 'same' ? 'same' : letterOf(task, chosen),
        judgments: revealed
          ? judgments.filter((one) => one.attempt_id === task.attemptId).map(({ judge, state, error, answers }) => ({ judge, state, error, answers: (answers ?? []).map(({ arm, ...answer }) => ({ letter: letterOf(task, arm), ...answer })) }))
          : null,
        notes,
      };
    }),
  );

  const doneOf = (rows: { state: string }[]) => ({ done: rows.filter(({ state }) => state === 'done' || state === 'failed').length, total: rows.length });
  return {
    ...summaryOf(trial),
    expectations: trial.expectations,
    revealed,
    progress: { runs: doneOf(results), judgments: doneOf(judgments) },
    tasks,
    verdict: trial.verdict,
    commits: trial.commits,
    draftMoved: !draft || draft.state !== 'open' || knowledgeHash((await draftKnowledge(deps, draft)).draft) !== knowledgeHash(trial.knowledge.draft),
  };
}

// The stakeholder's answer for every task: the letter of the better of the two results they compared, or that there
// is no difference. It ends the trial, agreed or not.
export async function answerTrial(deps: TrialDeps, trialId: number, choices: Record<string, string>): Promise<TrialRow> {
  const { trials } = deps;
  const trial = await trials.getTrial(trialId);
  if (!trial) throw new Refused(`There is no trial ${trialId}`, 404);
  if (trial.state !== 'awaiting_answer') throw new Refused(trial.state === 'agreed' || trial.state === 'not_agreed' ? `Trial ${trialId} has been answered` : `Trial ${trialId} is not ready to be answered: its runs and judges have not finished`, 409);

  const human: NonNullable<TrialRow['human']> = {};
  const labels: Record<number, string> = {};
  for (const task of trial.tasks) {
    const choice = choices[String(task.attemptId)];
    const compared: Arm[] = [baselineOf(task), 'draft'];
    const arm = choice === 'same' ? 'same' : compared.find((one) => letterOf(task, one) === choice);
    if (arm === undefined) throw new Refused(`Say for attempt ${task.attemptId} which of ${compared.map((one) => letterOf(task, one)).sort().join(' and ')} is better, or that there is no difference`);
    human[String(task.attemptId)] = arm;
    const found = await replaySource(deps, task.attemptId);
    labels[task.attemptId] = found.ok ? found.source.task.ticket_id : `Attempt ${task.attemptId}`;
  }
  const verdict = verdictOf(trial, await trials.listResults(trialId), await trials.listJudgments(trialId), human, labels);
  return trials.patchTrial(trialId, { human, verdict, state: verdict.agreed ? 'agreed' : 'not_agreed', ended_at: (deps.now?.() ?? new Date()).toISOString() });
}
