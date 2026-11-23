import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineDeps } from '../engine/runner.ts';
import type { TaskManifest } from '../manifest/build.ts';
import { estimateTokens } from '../manifest/tokens.ts';
import { JudgeStopped, questionsText, type Judged, type JudgeRequest } from './judge.ts';

export type ClaudeJudgeDeps = Pick<EngineDeps, 'paths' | 'adapters'>;

// preface goes before the judge's instructions: the charter and playbook of a role that judges as itself. Each run
// leaves its prompt and transcript under dir, in folders named <name>-<run>.
export type ClaudeJudgeOptions = { adapter: string; model: string; runs: number; preface?: string; dir: string; name: string; signal?: AbortSignal };

const INSTRUCTIONS = 'trials/judge.md';
const SCHEMA = 'trials/judgment.json';
const CONTRACT = '## Output contract\n\nFinish with a Judgment matching the output schema you were given: one answer for each question id, with `yes` true or false and the passage that shows it.\n\nYou may not change any files.';
// A judgment is a short answer to a long text. The folder it runs in is empty, so its tool has nothing to read.
const BUDGETS = { max_turns: 6, max_usd: 2, context_tokens: 200_000, playbook_tokens: 0, memory_tokens: 0 };

type Run = Record<string, { yes: boolean; passage: string }>;

// One run's answers, or undefined when it left a question out or answered one twice.
function readRun(output: unknown, ids: string[]): Run | undefined {
  const answers = (output as { answers?: { question: string; yes: boolean; passage: string }[] } | null)?.answers;
  if (!Array.isArray(answers)) return undefined;
  const run: Run = {};
  for (const { question, yes, passage } of answers) {
    if (question in run) return undefined;
    if (ids.includes(question)) run[question] = { yes, passage };
  }
  return ids.every((id) => id in run) ? run : undefined;
}

// Asks the same questions the given number of times, and gives the share of runs that said yes to each. A run that
// leaves a question out is made again once; a second such run fails the judgment.
export async function claudeJudge(deps: ClaudeJudgeDeps, request: JudgeRequest, options: ClaudeJudgeOptions): Promise<Judged> {
  const { paths, adapters } = deps;
  const adapter = adapters[options.adapter];
  if (!adapter) throw new Error(`No adapter named ${options.adapter}`);
  const instructions = (await readFile(join(paths.knowledge, INSTRUCTIONS), 'utf8')).trimEnd();
  const outputSchema = JSON.parse(await readFile(join(paths.knowledge, SCHEMA), 'utf8')) as object;
  const sections = { charter: [options.preface?.trimEnd(), instructions].filter(Boolean).join('\n\n'), playbook: '', memory: '', contract: CONTRACT, instructions: '' };
  const system = `${sections.charter}\n\n${CONTRACT}\n`;
  const task = `${request.state.trimEnd()}\n\n${questionsText(request.questions)}\n`;
  const ids = request.questions.map(({ id }) => id);
  const manifest: TaskManifest = {
    project: 'trials',
    ticketId: options.name,
    attemptK: 1,
    roleId: 'judge',
    adapter: options.adapter,
    model: options.model,
    budgets: BUDGETS,
    tools: ['read_repo'],
    system,
    sections,
    fingerprint: '',
    task,
    outputSchema,
    writeScope: { allow: [], deny: ['**'] },
    parts: [],
    totalTokens: estimateTokens(system) + estimateTokens(task),
    contextBudget: BUDGETS.context_tokens,
    networkAllow: [],
  };

  const preflight = await adapter.preflight();
  if (!preflight.ok) throw new JudgeStopped(`${preflight.reason}. Fix: ${preflight.fix}`, 0);

  let usd = 0;
  let again = 1;
  const runs: Run[] = [];
  for (let i = 1; runs.length < options.runs; i += 1) {
    const name = `${options.name}-${i}`;
    const [cwd, manifestDir] = [join(options.dir, 'judging', name), join(options.dir, name)];
    await mkdir(cwd, { recursive: true });
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, 'system.md'), system);
    await writeFile(join(manifestDir, 'task.md'), task);
    const handle = adapter.start(manifest, { path: cwd, transcriptPath: join(options.dir, `${name}.jsonl`), manifestDir });
    const cancel = () => void handle.cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const drained = (async () => {
      for await (const _event of handle.events);
    })();
    const [result] = await Promise.all([handle.result, drained]);
    options.signal?.removeEventListener('abort', cancel);
    usd += result.usage.usdEst ?? 0;

    if (result.status === 'usage_limited') throw new JudgeStopped(`the vendor’s usage limit was reached${result.resetAt ? `, until ${result.resetAt}` : ''}`, usd);
    if (result.status === 'cancelled') throw new JudgeStopped('it was cancelled', usd);
    if (result.failureKind === 'auth_required') throw new JudgeStopped(`the agent home is not logged in. Fix: ${adapter.loginFix}`, usd);
    if (result.failureKind === 'spawn_error') throw new JudgeStopped(`the judge could not start: ${result.message ?? 'no reason given'}`, usd);

    const run = result.status === 'succeeded' ? readRun(result.output, ids) : undefined;
    if (run) runs.push(run);
    else if (again-- === 0) throw new JudgeStopped('the judge twice gave an answer that left a question out or did not fit', usd);
  }

  const answers = Object.fromEntries(
    ids.map((id) => {
      const said = runs.map((run) => run[id]!);
      const yes = said.filter((one) => one.yes);
      // The passage is from a run on the side the runs came down on.
      const shown = yes.length * 2 >= said.length ? yes[0] : said.find((one) => !one.yes);
      return [id, { p: yes.length / said.length, passage: shown?.passage ?? null }];
    }),
  );
  return { answers, usd };
}
