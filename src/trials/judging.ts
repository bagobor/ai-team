import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeJudge } from '../judge/claude.ts';
import type { Judged, Question } from '../judge/judge.ts';
import { localJudge } from '../judge/local.ts';
import { git } from '../git/git.ts';
import { playbookSection } from '../knowledge/entries.ts';
import { loadPlaybook } from '../knowledge/load.ts';
import { fenced, REVIEW_DIFF_TOKENS } from '../manifest/build.ts';
import { charsForTokens } from '../manifest/tokens.ts';
import { loadRole } from '../roles/role.ts';
import { trialDir } from './drafts.ts';
import { replaySource, type ReplaySource } from './source.ts';
import type { TrialDeps } from './trial.ts';
import type { Answer, Arm, JudgmentRow, Letter, ResultRow, TrialRow, TrialTask } from './types.ts';

const MAX_TASK_CHARS = 6000;
const MAX_OUTPUT_CHARS = 30_000;

// An entry's id in a result would say which side had that entry to cite, so no judge sees one.
export const masked = (text: string): string => text.replace(/\b(?:PB|MEM)-\d+\b/g, 'an entry');

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max} more characters]`);

// What a ticket's run changed: the stored attempt's from its own commits, a fresh run's from the diff it left.
export async function diffOf(deps: TrialDeps, trial: TrialRow, { attempt, task, project }: ReplaySource, arm: Arm): Promise<string | null> {
  if (task.kind !== 'ticket') return null;
  if (arm !== 'stored') return readFile(join(trialDir(deps.paths, trial.id), `${arm}-${attempt.id}.diff`), 'utf8').catch(() => null);
  if (attempt.head_sha === null) return null;
  const { stdout, code } = await git(project.repo_path, ['diff', '--no-color', '--no-ext-diff', attempt.base_sha!, attempt.head_sha]).catch(() => ({ stdout: '', code: 1 }));
  return code === 0 ? stdout : null;
}

const lettersOf = (task: TrialTask): [Letter, Arm][] => (Object.entries(task.letters) as [Letter, Arm][]).sort(([a], [b]) => a.localeCompare(b));

// The task, then each of its results under its letter: what it answered and, for a ticket, what it changed.
export async function judgeState(deps: TrialDeps, trial: TrialRow, task: TrialTask, results: ResultRow[], source: ReplaySource): Promise<string> {
  const parts = ['## The task', '', `<task>\n${fenced('task', cut(source.manifest.task, MAX_TASK_CHARS))}\n</task>`, '', '## The results', '', 'Each result is one answer to that task, from a run of its own.'];
  for (const [letter, arm] of lettersOf(task)) {
    const result = results.find((one) => one.attempt_id === task.attemptId && one.arm === arm);
    const diff = await diffOf(deps, trial, source, arm);
    const body = [
      result?.output === null || result?.output === undefined ? `This run produced no answer${result?.measured?.note ? `: ${result.measured.note}` : '.'}` : cut(JSON.stringify(result.output, null, 2), MAX_OUTPUT_CHARS),
      ...(diff === null || diff.trim() === '' ? [] : ['', 'What it changed:', '', cut(diff, charsForTokens(REVIEW_DIFF_TOKENS))]),
    ].join('\n');
    parts.push('', `### Result ${letter}`, '', `<result letter="${letter}">\n${fenced('result', masked(body))}\n</result>`);
  }
  return parts.join('\n');
}

// One question per result and expectation, named by the result's letter and the expectation's number.
export function judgeQuestions(trial: TrialRow, task: TrialTask): Question[] {
  return lettersOf(task).flatMap(([letter]) => trial.expectations.map((expectation, i) => ({ id: `${letter}-${i + 1}`, ask: `About result ${letter}: ${expectation}` })));
}

// One judge's answers about one task of the trial, turned back from letters into which run each was about.
export async function judgeTask(deps: TrialDeps, trial: TrialRow, judgment: JudgmentRow, signal: AbortSignal): Promise<{ answers: Answer[]; usd: number }> {
  const { paths, config, trials } = deps;
  const task = trial.tasks.find(({ attemptId }) => attemptId === judgment.attempt_id);
  const found = await replaySource(deps, judgment.attempt_id);
  if (!task || !found.ok) throw new Error(`attempt ${judgment.attempt_id} can no longer be read${found.ok ? '' : `: ${found.why}`}`);
  const request = { state: await judgeState(deps, trial, task, await trials.listResults(trial.id), found.source), questions: judgeQuestions(trial, task) };
  const place = { dir: trialDir(paths, trial.id), name: `${judgment.judge}-${judgment.attempt_id}`, signal };

  let judged: Judged;
  if (judgment.judge === 'local') {
    if (config.trials.localJudge === null) throw new Error('no local judge is set in config.yaml');
    judged = await localJudge(config.trials.localJudge, request, signal);
  } else if (judgment.judge === 'model') {
    const { role } = await loadRole(paths.knowledge, trial.role_id);
    judged = await claudeJudge(deps, request, { ...place, adapter: role.defaults.adapter, model: config.trials.judgeModel, runs: config.trials.judgeRuns });
  } else {
    // The evaluator judges as itself: its own charter and playbook come before the judge's instructions, and it is asked once.
    const evaluator = (await loadRole(paths.knowledge, trial.role_id)).role.evaluator;
    if (evaluator === undefined) throw new Error(`${trial.role_id} no longer has an evaluator`);
    const { role, charter } = await loadRole(paths.knowledge, evaluator);
    const preface = [charter.trimEnd(), playbookSection(await loadPlaybook(paths.knowledge, role))].filter((part) => part !== '').join('\n\n');
    judged = await claudeJudge(deps, request, { ...place, adapter: role.defaults.adapter, model: role.defaults.model, runs: 1, preface });
  }

  const answers = lettersOf(task).flatMap(([letter, arm]) =>
    trial.expectations.map((_, expectation): Answer => {
      const answer = judged.answers[`${letter}-${expectation + 1}`];
      if (!answer) throw new Error(`the judge gave no answer to ${letter}-${expectation + 1}`);
      return { arm, expectation, p: answer.p, passage: answer.passage };
    }),
  );
  return { answers, usd: judged.usd };
}
