import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttemptResult } from '../adapters/types.ts';
import { runChecks, runSandboxed } from '../checks/run-checks.ts';
import { writeReference } from '../engine/role-inputs.ts';
import { approvedProfile, componentsFor, protectedFor, type EngineDeps } from '../engine/runner.ts';
import { gitOk } from '../git/git.ts';
import { addAttemptWorktree, removeAttemptWorktree, snapshotAttempt } from '../git/workspace.ts';
import { memorySection, parseEntries, playbookSection } from '../knowledge/entries.ts';
import { knowledgeFingerprint, systemOf, type SystemSections, type TaskManifest } from '../manifest/build.ts';
import { estimateTokens } from '../manifest/tokens.ts';
import { workerDenyRead } from '../paths.ts';
import { loadRole, type Role } from '../roles/role.ts';
import { ticketMeasure, type ReplaySource } from './source.ts';
import type { Knowledge, Measured } from './types.ts';

export type ReplayDeps = Pick<EngineDeps, 'paths' | 'config' | 'adapters' | 'artifacts'>;

// A run that came back with something to count, or one that never had the chance and can be made again: an expired
// login, a rate limit, a worker that could not start. usd is what it cost either way.
export type ReplayOutcome = { kind: 'done'; output: unknown; measured: Measured; fingerprint: string; usd: number } | { kind: 'stopped'; why: string; usd: number };

// Where one run keeps what it leaves: its prompt, its transcript and, for a ticket, the diff of what it changed.
export type ReplayPlace = { dir: string; name: string; branch: string; signal?: AbortSignal };

const NO_MEASURE = { checks: null, changed: null, tests: null } as const;

// The prompt's parts for a task of the role with this knowledge in front of it, as a live task would be given them.
// The contract and the repository's instructions are the attempt's own, since they belong to its task.
export function replaySections(knowledge: Knowledge, role: Role, { contract, instructions }: SystemSections): SystemSections {
  const entries = (text: string, prefix: 'PB' | 'MEM') => {
    const { entries: found, problems } = parseEntries(text, prefix);
    if (problems.length > 0) throw new Error(`The knowledge to try has a file with a problem: ${problems.join('; ')}`);
    return found;
  };
  const memory = memorySection({ project: entries(knowledge.memory_project, 'MEM'), role: entries(knowledge.memory_role, 'MEM') }, role.defaults.budgets.memory_tokens);
  return { charter: knowledge.charter.trimEnd(), playbook: playbookSection(entries(knowledge.playbook, 'PB')), memory: memory.text, contract, instructions };
}

function stopped(result: AttemptResult, loginFix: string): string | undefined {
  if (result.status === 'usage_limited') return `the vendor’s usage limit was reached${result.resetAt ? `, until ${result.resetAt}` : ''}`;
  if (result.status === 'cancelled') return 'it was cancelled';
  if (result.failureKind === 'auth_required') return `the agent home is not logged in. Fix: ${loginFix}`;
  if (result.failureKind === 'spawn_error') return `the worker could not start: ${result.message ?? 'no reason given'}`;
  return undefined;
}

// One past task, run again from the commit it started at with other knowledge in front of it. The model and the budgets
// are the role's today; the task, its tools, its write scope and its output schema are the attempt's. Nothing a
// project's own flow reads is written: the run has its own worktree and branch, and both are gone when it ends.
export async function replay(deps: ReplayDeps, source: ReplaySource, knowledge: Knowledge, place: ReplayPlace): Promise<ReplayOutcome> {
  const { paths, config, adapters } = deps;
  const { attempt, task, project, manifest: stored } = source;
  const { role } = await loadRole(paths.knowledge, task.role_id);
  const adapter = adapters[role.defaults.adapter];
  if (!adapter) throw new Error(`No adapter named ${role.defaults.adapter}`);
  const sections = replaySections(knowledge, role, source.sections);
  const fingerprint = knowledgeFingerprint(sections, role.defaults.model);
  const system = systemOf(sections);
  const budget = role.defaults.budgets.context_tokens;
  // The schema reaches the model too, as it does for a live task.
  const totalTokens = estimateTokens(system) + estimateTokens(JSON.stringify(stored.outputSchema)) + estimateTokens(stored.task);
  if (totalTokens > budget) {
    const note = `context_over_budget: ${totalTokens} tokens against a budget of ${budget}`;
    return { kind: 'done', output: null, measured: { parses: false, ...NO_MEASURE, usd: 0, note }, fingerprint, usd: 0 };
  }

  const preflight = await adapter.preflight();
  if (!preflight.ok) return { kind: 'stopped', why: `${preflight.reason}. Fix: ${preflight.fix}`, usd: 0 };

  const { flags: _, ...kept } = stored;
  const manifest: TaskManifest = { ...kept, adapter: role.defaults.adapter, model: role.defaults.model, budgets: role.defaults.budgets, system, sections, fingerprint, parts: [], totalTokens, contextBudget: budget };
  const worktree = join(place.dir, 'worktrees', place.name);
  const manifestDir = join(place.dir, place.name);
  const denyRead = workerDenyRead(paths, homedir());
  const base = attempt.base_sha!;
  const quiet = { onEvent: () => {} };
  await addAttemptWorktree(project.repo_path, worktree, place.branch, base);
  try {
    if (task.kind === 'ticket') {
      const { setup } = await approvedProfile(deps, project);
      const ready = setup === undefined ? { ok: true, evidence: '' } : await runSandboxed({ worktree, repoPath: project.repo_path, commands: [setup], denyRead, timeoutS: config.checkTimeoutS, network: true, ...quiet, ...(place.signal ? { signal: place.signal } : {}) });
      if (!ready.ok) return { kind: 'stopped', why: `the project’s setup command failed: ${ready.evidence.trim().split('\n').at(-1) ?? ''}`, usd: 0 };
    }
    if (Object.keys(source.reference).length > 0) await writeReference(worktree, source.reference);
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, 'system.md'), system);
    await writeFile(join(manifestDir, 'task.md'), stored.task);

    const handle = adapter.start(manifest, { path: worktree, transcriptPath: join(place.dir, `${place.name}.jsonl`), manifestDir });
    const cancel = () => void handle.cancel();
    place.signal?.addEventListener('abort', cancel, { once: true });
    if (place.signal?.aborted) cancel();
    // The transcript keeps what the worker said. Its events are a live task's to log, and this is none.
    const drained = (async () => {
      for await (const _event of handle.events);
    })();
    const [result] = await Promise.all([handle.result, drained]);
    place.signal?.removeEventListener('abort', cancel);

    const usd = result.usage.usdEst ?? 0;
    const why = stopped(result, adapter.loginFix);
    if (why !== undefined) return { kind: 'stopped', why, usd };
    if (result.status !== 'succeeded') {
      return { kind: 'done', output: result.output ?? null, measured: { parses: false, ...NO_MEASURE, usd, note: result.message ?? `The worker stopped: ${result.status}` }, fingerprint, usd };
    }
    if (task.kind !== 'ticket') return { kind: 'done', output: result.output, measured: { parses: true, ...NO_MEASURE, usd, note: null }, fingerprint, usd };

    const { headSha } = await snapshotAttempt(project.repo_path, worktree, `aiteam: trial run of ${task.ticket_id}`);
    await writeFile(join(place.dir, `${place.name}.diff`), await gitOk(project.repo_path, ['diff', '--no-color', '--no-ext-diff', base, headSha]));
    const components = await componentsFor(deps, project, task);
    const checks = await runChecks({
      repoPath: project.repo_path,
      worktree,
      baseSha: base,
      writeScope: stored.writeScope,
      protectedPaths: await protectedFor(deps, project, task),
      ...(components ? { components } : {}),
      commands: task.dod,
      denyRead,
      timeoutS: config.checkTimeoutS,
      ...quiet,
      ...(place.signal ? { signal: place.signal } : {}),
    });
    return { kind: 'done', output: result.output, measured: { parses: true, ...ticketMeasure(checks), usd }, fingerprint, usd };
  } finally {
    await removeAttemptWorktree(project.repo_path, worktree, place.branch);
  }
}
