import { YES } from '../judge/judge.ts';
import type { Answer, Arm, JudgeName, JudgeVerdict, JudgmentRow, Measured, ResultRow, TrialRow, TrialTask, Verdict } from './types.ts';

// What a task's draft run is compared with: the fresh run on the committed knowledge where there is one, else the
// stored result.
export function baselineOf(task: TrialTask): Arm {
  return Object.values(task.letters).includes('current') ? 'current' : 'stored';
}

// A draft may cost this many times what it is compared with before the cost counts against it. Below that, the
// difference between two runs of the same thing is as large.
export const COST_TOLERANCE = 1.5;

const COUNTED: [keyof Pick<Measured, 'parses' | 'checks' | 'changed' | 'tests'>, string][] = [
  ['parses', 'its answer no longer fits what was asked for'],
  ['changed', 'it changed nothing'],
  ['tests', 'the tests it had to add are missing'],
  ['checks', 'its commands no longer pass'],
];

// Every count that was right before and is not with the draft, task by task, then the cost over all of them. labels
// names each task for the person reading.
export function measuredWorse(trial: TrialRow, results: ResultRow[], labels: Record<number, string>): string[] {
  const of = (attemptId: number, arm: Arm) => results.find((one) => one.attempt_id === attemptId && one.arm === arm)?.measured ?? null;
  const worse: string[] = [];
  let [before, after] = [0, 0];
  for (const task of trial.tasks) {
    const [base, draft] = [of(task.attemptId, baselineOf(task)), of(task.attemptId, 'draft')];
    for (const [count, words] of COUNTED) if (base?.[count] === true && draft?.[count] !== true) worse.push(`${labels[task.attemptId] ?? `Attempt ${task.attemptId}`}: ${words}`);
    if (base?.usd != null && draft?.usd != null) [before, after] = [before + base.usd, after + draft.usd];
  }
  if (before > 0 && after > before * COST_TOLERANCE) worse.push(`It cost $${after.toFixed(2)} over these tasks against $${before.toFixed(2)}, more than half as much again`);
  return worse;
}

const tasksOf = (count: number): string => `${count} ${count === 1 ? 'task' : 'tasks'}`;

// The spec's rule: on the tasks that showed the problem the draft meets more of the expectations than what it is
// compared with, and on no task that went fine does it meet fewer. An answer the judge was unsure of counts as not met.
export function judgeVerdict(trial: TrialRow, judgments: JudgmentRow[]): JudgeVerdict {
  const metBy = (answers: Answer[], arm: Arm) => answers.filter((answer) => answer.arm === arm && answer.p >= YES).length;
  let [before, after, fewer] = [0, 0, 0];
  for (const task of trial.tasks) {
    const answers = judgments.find((one) => one.attempt_id === task.attemptId)?.answers ?? [];
    const [base, draft] = [metBy(answers, baselineOf(task)), metBy(answers, 'draft')];
    if (task.group === 'problem') [before, after] = [before + base, after + draft];
    else if (draft < base) fewer += 1;
  }
  const asked = trial.tasks.filter(({ group }) => group === 'problem').length * trial.expectations.length;
  const why = [`On the tasks that showed the problem, the draft meets ${after} of ${asked} expectations, against ${before} without it.`, ...(fewer === 0 ? [] : [`On ${tasksOf(fewer)} that went fine it meets fewer.`])].join(' ');
  return { improvement: after > before && fewer === 0, why };
}

// The stakeholder says, for each task, which of the two compared results is better. That is an improvement when the
// draft's is better on more of the problem tasks than it is worse, and worse on none that went fine.
export function stakeholderVerdict(trial: TrialRow, human: NonNullable<TrialRow['human']>): JudgeVerdict {
  const pick = (task: TrialTask) => human[String(task.attemptId)];
  const problem = trial.tasks.filter(({ group }) => group === 'problem');
  const better = problem.filter((task) => pick(task) === 'draft').length;
  const worse = problem.filter((task) => pick(task) === baselineOf(task)).length;
  const fewer = trial.tasks.filter((task) => task.group === 'fine' && pick(task) === baselineOf(task)).length;
  const why = [`On the tasks that showed the problem, you found the draft’s result better on ${better} and worse on ${worse} of ${problem.length}.`, ...(fewer === 0 ? [] : [`On ${tasksOf(fewer)} that went fine you found it worse.`])].join(' ');
  return { improvement: better > worse && fewer === 0, why };
}

// A draft may be committed only when nothing that can be counted got worse and everyone who counts calls it an
// improvement: the model judge, the role's evaluator if it has one, and the stakeholder. A local model's answers are
// worked out the same way and shown beside them, and decide nothing.
export function verdictOf(trial: TrialRow, results: ResultRow[], judgments: JudgmentRow[], human: NonNullable<TrialRow['human']>, labels: Record<number, string>): Verdict {
  const worse = measuredWorse(trial, results, labels);
  const by = (judge: JudgeName) => judgments.filter((one) => one.judge === judge && one.state === 'done');
  const judges: Verdict['judges'] = { model: judgeVerdict(trial, by('model')), stakeholder: stakeholderVerdict(trial, human) };
  if (judgments.some(({ judge }) => judge === 'evaluator')) judges.evaluator = judgeVerdict(trial, by('evaluator'));
  if (by('local').length === trial.tasks.length) judges.local = judgeVerdict(trial, by('local'));
  const counting = [judges.model, judges.evaluator, judges.stakeholder].filter((one) => one !== undefined);
  return { worse, judges, agreed: worse.length === 0 && counting.every(({ improvement }) => improvement) };
}
