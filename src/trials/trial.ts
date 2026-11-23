import { randomInt } from 'node:crypto';
import type { EngineDeps } from '../engine/runner.ts';
import { JudgeStopped } from '../judge/judge.ts';
import { knowledgeFingerprint } from '../manifest/build.ts';
import { loadRole } from '../roles/role.ts';
import { draftKnowledge, liveKnowledge, trialDir, viewDraft } from './drafts.ts';
import { Refused } from './errors.ts';
import { judgeTask } from './judging.ts';
import { replay, replaySections, type ReplayDeps } from './replay.ts';
import { replaySource, storedMeasure, type ReplaySource } from './source.ts';
import type { NewTrial, TrialStore } from './store.ts';
import type { Arm, JudgeName, JudgmentRow, Knowledge, Letter, ResultRow, TrialRow, TrialState, TrialTask } from './types.ts';

// shuffle decides which of a task's results gets which letter. It is random unless a test says otherwise.
export type TrialDeps = ReplayDeps & Pick<EngineDeps, 'store'> & { trials: TrialStore; now?: () => Date; shuffle?: <T>(items: T[]) => T[] };

export type NewTrialInput = { expectations: string[]; problem: number[]; fine: number[]; capUsd?: number };

export const MAX_EXPECTATIONS = 3;
export const TASKS = { min: 5, max: 7, ofEachGroup: 2 };
const MAX_EXPECTATION_CHARS = 300;

// A trial that has not ended. A draft has one of these at most.
export const UNDER_WAY: TrialState[] = ['running', 'judging', 'awaiting_answer', 'stopped'];
const STOPPED_BY_STAKEHOLDER = 'the stakeholder stopped it';

// What a task of this project reads in one arm of the trial.
export function armKnowledge({ project, elsewhere, ...arms }: TrialRow['knowledge'], arm: 'current' | 'draft', taskProject: string): Knowledge {
  return taskProject === project ? arms[arm] : { ...arms[arm], memory_project: '', memory_role: '', ...elsewhere[taskProject] };
}

function shuffled<T>(items: T[]): T[] {
  const rest = [...items];
  return items.map(() => rest.splice(randomInt(rest.length), 1)[0]!);
}

const LETTERS: Letter[] = ['A', 'B', 'C'];

// Checks everything that could make a trial meaningless before a cent is spent, then lays out all it will run.
export async function startTrial(deps: TrialDeps, draftId: number, input: NewTrialInput): Promise<TrialRow> {
  const { trials, paths, config } = deps;
  const draft = await trials.getDraft(draftId);
  if (!draft) throw new Refused(`There is no draft ${draftId}`, 404);
  if (draft.state !== 'open') throw new Refused(`Draft ${draftId} was ${draft.state}, and can no longer be tried`, 409);
  const view = await viewDraft(deps, draft);
  if (!view.changed) throw new Refused('This draft changes nothing yet, so there is nothing to try');
  if (view.stale) throw new Refused('A live file changed after this draft first changed it. Look at the draft again, then keep its version or discard it.', 409);
  const problems = view.files.flatMap((file) => file.problems);
  if (problems.length > 0) throw new Refused(`A file of this draft has a problem: ${problems.join('; ')}`, 409);
  const [going] = await trials.listTrials({ draftId, states: UNDER_WAY });
  if (going) throw new Refused(`Trial ${going.id} of this draft has not ended. Answer it, or stop and discard it, first.`, 409);

  const expectations = input.expectations.map((expectation) => expectation.trim()).filter((expectation) => expectation !== '');
  if (expectations.length < 1 || expectations.length > MAX_EXPECTATIONS) throw new Refused(`Say what you expected as one to ${MAX_EXPECTATIONS} questions`);
  if (expectations.some((expectation) => expectation.length > MAX_EXPECTATION_CHARS)) throw new Refused(`An expectation is one question, at most ${MAX_EXPECTATION_CHARS} characters`);

  const ids = [...input.problem, ...input.fine];
  if (new Set(ids).size !== ids.length) throw new Refused('A task can be in a trial once');
  if (ids.length < TASKS.min || ids.length > TASKS.max || input.problem.length < TASKS.ofEachGroup || input.fine.length < TASKS.ofEachGroup) {
    throw new Refused(`A trial takes ${TASKS.min} to ${TASKS.max} tasks: at least ${TASKS.ofEachGroup} that showed the problem and at least ${TASKS.ofEachGroup} that went fine`);
  }
  const capUsd = input.capUsd ?? config.trials.capUsd;
  if (!(capUsd > 0)) throw new Refused('The spending cap must be more than nothing');

  const { role } = await loadRole(paths.knowledge, draft.role_id);
  if (role.evaluator !== undefined) {
    await loadRole(paths.knowledge, role.evaluator).catch((cause: Error) => {
      throw new Refused(`${draft.role_id}’s evaluator can’t be used: ${cause.message}`, 409);
    });
  }

  const sources: ReplaySource[] = [];
  for (const id of ids) {
    const found = await replaySource(deps, id);
    if (!found.ok) throw new Refused(`Attempt ${id} can’t be run again: ${found.why}`);
    if (found.source.task.role_id !== draft.role_id) throw new Refused(`Attempt ${id} is ${found.source.task.role_id}’s work, and this draft is for ${draft.role_id}`);
    sources.push(found.source);
  }
  const changesMemory = view.files.some(({ file, changed }) => changed && file !== 'charter' && file !== 'playbook');
  const other = sources.find(({ project }) => project.name !== view.project);
  if (changesMemory && other) throw new Refused(`This draft changes the memory of ${view.project}, so it can only be tried on tasks of ${view.project}. Attempt ${other.attempt.id} is of ${other.project.name}.`);

  const { current, draft: drafted } = await draftKnowledge(deps, draft);
  const elsewhere: TrialRow['knowledge']['elsewhere'] = {};
  for (const name of new Set(sources.map(({ project }) => project.name))) {
    if (name === view.project) continue;
    const { memory_project, memory_role } = await liveKnowledge(paths, draft.role_id, name);
    elsewhere[name] = { memory_project, memory_role };
  }
  const knowledge = { project: view.project, current, draft: drafted, elsewhere };

  const judges: JudgeName[] = ['model', ...(role.evaluator === undefined ? [] : (['evaluator'] as const)), ...(config.trials.localJudge === null ? [] : (['local'] as const))];
  const tasks: TrialTask[] = [];
  const results: NewTrial['results'] = [];
  for (const source of sources) {
    const { attempt, task } = source;
    // What the committed knowledge would put in front of this task today. Where the attempt was given the same, its
    // stored result is the baseline, and nothing but the draft is run.
    const today = knowledgeFingerprint(replaySections(armKnowledge(knowledge, 'current', source.project.name), role, source.sections), role.defaults.model);
    const arms: Arm[] = ['stored', ...(today === source.fingerprint ? [] : (['current'] as const)), 'draft'];
    const order = (deps.shuffle ?? shuffled)(arms);
    tasks.push({ attemptId: attempt.id, group: input.problem.includes(attempt.id) ? 'problem' : 'fine', letters: Object.fromEntries(order.map((arm, i) => [LETTERS[i]!, arm])) });
    results.push({ attempt_id: attempt.id, arm: 'stored', state: 'done', output: attempt.output, measured: storedMeasure(attempt, task), fingerprint: source.fingerprint });
    for (const arm of arms.slice(1)) results.push({ attempt_id: attempt.id, arm, state: 'pending', output: null, measured: null, fingerprint: null });
  }
  return trials.createTrial({ draft_id: draft.id, role_id: draft.role_id, expectations, tasks, knowledge, cap_usd: capUsd, results, judgments: ids.flatMap((attempt_id) => judges.map((judge) => ({ attempt_id, judge }))) });
}

type Live = { trialId: number; abort: AbortController; done: Promise<void> };

// Does a trial's work a piece at a time, when the scheduler has a worker to spare: first every run, then the judging.
export class TrialRunner {
  private readonly live = new Map<string, Live>();
  private closing = false;

  constructor(protected readonly deps: TrialDeps) {}

  liveCount(): number {
    return this.live.size;
  }

  // Starts at most `free` pieces of work. Each goes on after this returns.
  async tick(free: number): Promise<void> {
    if (this.closing) return;
    let left = free;
    for (const trial of await this.deps.trials.listTrials({ states: ['running', 'judging'] })) {
      if (left <= 0) return;
      left -= trial.state === 'running' ? await this.startRuns(trial, left) : await this.startJudging(trial, left);
    }
  }

  // Until everything started so far has ended.
  async idle(): Promise<void> {
    while (this.live.size > 0) await Promise.all([...this.live.values()].map(({ done }) => done));
  }

  async stop(trialId: number, reason = STOPPED_BY_STAKEHOLDER): Promise<TrialRow> {
    const trial = await this.deps.trials.getTrial(trialId);
    if (!trial) throw new Refused(`There is no trial ${trialId}`, 404);
    if (!UNDER_WAY.includes(trial.state)) throw new Refused(`Trial ${trialId} has ended`, 409);
    const stopped = await this.deps.trials.patchTrial(trialId, { state: 'stopped', stop_reason: reason });
    for (const run of this.live.values()) if (run.trialId === trialId) run.abort.abort();
    return stopped;
  }

  // Goes on from where it stopped: the runs that are left, then the judging, then the stakeholder.
  async resume(trialId: number, capUsd?: number): Promise<TrialRow> {
    const { trials } = this.deps;
    const trial = await trials.getTrial(trialId);
    if (!trial) throw new Refused(`There is no trial ${trialId}`, 404);
    if (trial.state !== 'stopped') throw new Refused(`Trial ${trialId} is not stopped`, 409);
    const cap = capUsd ?? trial.cap_usd;
    const left = (await trials.listResults(trialId)).some(({ state }) => state !== 'done') || (await this.judgingLeft(trial));
    if (left && trial.spent_usd >= cap) throw new Refused(`This trial has spent $${trial.spent_usd.toFixed(2)} of its cap of $${cap.toFixed(2)}. Raise the cap to go on.`, 409);
    return this.settle(await trials.patchTrial(trialId, { state: 'running', stop_reason: null, cap_usd: cap }));
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const { abort } of this.live.values()) abort.abort();
    await this.idle();
  }

  // Each judge's judgment of each task is one piece of work, which takes a worker as a run does.
  private async startJudging(trial: TrialRow, free: number): Promise<number> {
    const { trials } = this.deps;
    const pending = (await trials.listJudgments(trial.id)).filter(({ state }) => state === 'pending');
    if (pending.length === 0) {
      if (![...this.live.values()].some(({ trialId }) => trialId === trial.id)) await this.settle(trial);
      return 0;
    }
    if (trial.spent_usd >= trial.cap_usd) {
      await this.stopFor(trial.id, `it reached its spending cap of $${trial.cap_usd.toFixed(2)}`);
      return 0;
    }
    const starting = pending.slice(0, free);
    for (const judgment of starting) {
      await trials.patchJudgment(judgment.id, { state: 'running', error: null });
      this.begin(`judgment ${judgment.id}`, trial.id, (signal) => this.judge(trial, judgment, signal));
    }
    return starting.length;
  }

  // The model judge and the evaluator count, so one of them failing stops the trial until it can be asked again. The
  // local judge is shown and does not count, so its failure is kept as that and the trial goes on.
  private async judge(trial: TrialRow, judgment: JudgmentRow, signal: AbortSignal): Promise<void> {
    const { trials } = this.deps;
    try {
      const { answers, usd } = await judgeTask(this.deps, trial, judgment, signal);
      if (usd > 0) await trials.addSpend(trial.id, usd);
      await trials.patchJudgment(judgment.id, { state: 'done', answers, error: null });
    } catch (err) {
      if (err instanceof JudgeStopped && err.usd > 0) await trials.addSpend(trial.id, err.usd);
      const why = err instanceof Error ? err.message : String(err);
      const local = judgment.judge === 'local';
      await trials.patchJudgment(judgment.id, { state: local && !signal.aborted ? 'failed' : 'pending', error: why });
      if (!local) await this.stopFor(trial.id, `the ${judgment.judge === 'model' ? 'model judge' : 'evaluator'} could not judge attempt ${judgment.attempt_id}: ${why}`);
    }
    const now = await trials.getTrial(trial.id);
    if (now) await this.settle(now);
  }

  private async judgingLeft(trial: TrialRow): Promise<boolean> {
    return (await this.deps.trials.listJudgments(trial.id)).some(({ state }) => state === 'pending' || state === 'running');
  }

  // Moves a trial on once a stage of it has nothing left to do: from its runs to the judging, and from that to the
  // stakeholder.
  private async settle(trial: TrialRow): Promise<TrialRow> {
    const { trials } = this.deps;
    if (trial.state !== 'running' && trial.state !== 'judging') return trial;
    const stage = (await trials.listResults(trial.id)).some(({ state }) => state !== 'done') ? 'running' : (await this.judgingLeft(trial)) ? 'judging' : 'awaiting_answer';
    return stage === trial.state ? trial : trials.patchTrial(trial.id, { state: stage });
  }

  protected begin(key: string, trialId: number, work: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    const done = work(abort.signal)
      .catch((err: unknown) => console.error(`Trial ${trialId} failed at ${key}:`, err))
      .finally(() => this.live.delete(key));
    this.live.set(key, { trialId, abort, done });
  }

  // A stop that comes from a run ends the trial's work for now, unless it has been stopped already or the daemon is
  // going down, in which case the next one picks the work up where it was.
  protected async stopFor(trialId: number, reason: string): Promise<void> {
    const trial = await this.deps.trials.getTrial(trialId);
    if (this.closing || !trial || (trial.state !== 'running' && trial.state !== 'judging')) return;
    await this.deps.trials.patchTrial(trialId, { state: 'stopped', stop_reason: reason });
  }

  private async startRuns(trial: TrialRow, free: number): Promise<number> {
    const { trials } = this.deps;
    const pending = (await trials.listResults(trial.id)).filter(({ state }) => state === 'pending');
    if (pending.length === 0) {
      if (![...this.live.values()].some(({ trialId }) => trialId === trial.id)) await this.settle(trial);
      return 0;
    }
    if (trial.spent_usd >= trial.cap_usd) {
      await this.stopFor(trial.id, `it reached its spending cap of $${trial.cap_usd.toFixed(2)}`);
      return 0;
    }
    const starting = pending.slice(0, free);
    for (const result of starting) {
      await trials.patchResult(result.id, { state: 'running', error: null });
      this.begin(`run ${result.id}`, trial.id, (signal) => this.run(trial, result, signal));
    }
    return starting.length;
  }

  private async run(trial: TrialRow, result: ResultRow, signal: AbortSignal): Promise<void> {
    const { trials, paths } = this.deps;
    const again = async (why: string) => {
      await trials.patchResult(result.id, { state: 'pending', error: why });
      await this.stopFor(trial.id, why);
    };
    try {
      const found = await replaySource(this.deps, result.attempt_id);
      if (!found.ok) return await again(`attempt ${result.attempt_id} can no longer be run again: ${found.why}`);
      const name = `${result.arm}-${result.attempt_id}`;
      const outcome = await replay(this.deps, found.source, armKnowledge(trial.knowledge, result.arm as 'current' | 'draft', found.source.project.name), { dir: trialDir(paths, trial.id), name, branch: `aiteam/trial/${trial.id}/${name}`, signal });
      if (outcome.usd > 0) await trials.addSpend(trial.id, outcome.usd);
      if (outcome.kind === 'stopped') return await again(outcome.why);
      await trials.patchResult(result.id, { state: 'done', output: outcome.output, measured: outcome.measured, fingerprint: outcome.fingerprint, error: null });
      const now = await trials.getTrial(trial.id);
      if (now) await this.settle(now);
    } catch (err) {
      await again(`a run of it failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
