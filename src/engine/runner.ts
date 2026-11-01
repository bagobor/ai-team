import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { AttemptHandle, AttemptResult, FailureKind, WorkerAdapter } from '../adapters/types.ts';
import type { ArtifactStore } from '../artifacts/store.ts';
import { runChecks } from '../checks/run-checks.ts';
import type { Config } from '../config.ts';
import type { DB } from '../db/schema.ts';
import type { EventLog } from '../events.ts';
import { addAttemptWorktree, ensureIntegrationBranch, removeAttemptWorktree, snapshotAttempt } from '../git/workspace.ts';
import { buildManifest, readRepoInstructions } from '../manifest/build.ts';
import { manifestDir, stateRepoDir, transcriptPath, workerDenyRead, worktreePath, type Paths } from '../paths.ts';
import { processStartTime } from '../proc.ts';
import { loadRole, type Role } from '../roles/role.ts';
import { parseTicket, type Ticket } from '../tickets/ticket.ts';
import { IllegalTransition } from './fsm.ts';
import type { AttemptPatch, AttemptRow, ProjectRow, Store, TaskRow } from './store.ts';

export type EngineDeps = {
  db: Kysely<DB>;
  store: Store;
  log: EventLog;
  paths: Paths;
  config: Config;
  adapters: Record<string, WorkerAdapter>;
  artifacts: ArtifactStore;
  now?: () => Date;
};

export type AttemptFailureKind = FailureKind | 'check_failed' | 'scope_violation' | 'no_changes' | 'context_over_budget' | 'engine_error';

// Set from begin until execute ends. cancel and shutdown reach whatever is running through it.
type Live = {
  stop?: 'cancel' | 'shutdown';
  project?: ProjectRow;
  attempt?: AttemptRow;
  handle?: AttemptHandle;
  checks?: AbortController;
  done: Promise<void>;
  finish: () => void;
};

type Work = {
  task: TaskRow;
  project: ProjectRow;
  role: Role;
  charter: string;
  schema: object;
  schemaSource: string;
  adapter: WorkerAdapter;
  ticket: Ticket;
  ticketMarkdown: string;
  baseSha: string;
};

const EVENT_STRING_CAP = 4000;
const INITIAL_BACKOFF_S = 300;
const MAX_BACKOFF_S = 3600;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function capStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.length > EVENT_STRING_CAP ? `${value.slice(0, EVENT_STRING_CAP - 1)}…` : value;
  if (Array.isArray(value)) return value.map(capStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item)]));
  }
  return value;
}

function resultPatch(result: AttemptResult): AttemptPatch {
  return {
    usage: result.usage,
    ...(result.sessionId !== undefined ? { session_id: result.sessionId } : {}),
    ...(result.output !== undefined ? { output: result.output } : {}),
  };
}

function failure(kind: AttemptFailureKind | null, evidence: string): AttemptPatch {
  return { failure_kind: kind, failure_evidence: evidence };
}

export class Runner {
  private readonly live = new Map<number, Live>();
  private stopping = false;

  constructor(private readonly deps: EngineDeps) {}

  liveCount(): number {
    return this.live.size;
  }

  async begin(taskId: number): Promise<void> {
    if (this.stopping) throw new Error('The engine is shutting down');
    if (this.live.has(taskId)) throw new Error(`Task ${taskId} is already running`);
    // Registered before the first await, so the scheduler's next look at liveCount already includes it.
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.live.set(taskId, { done, finish });
    try {
      await this.deps.store.setTaskState(taskId, 'running');
    } catch (err) {
      this.live.delete(taskId);
      finish();
      throw err;
    }
  }

  async execute(taskId: number): Promise<void> {
    const live = this.live.get(taskId);
    if (!live) {
      console.error(`execute: task ${taskId} was not begun`);
      return;
    }
    try {
      await this.run(taskId, live);
    } catch (err) {
      await this.failFromError(taskId, live, err);
    } finally {
      this.live.delete(taskId);
      live.finish();
    }
  }

  async cancel(taskId: number): Promise<void> {
    const { store } = this.deps;
    const live = this.live.get(taskId);
    if (!live) {
      await store.setTaskState(taskId, 'cancelled');
      return;
    }
    live.stop = 'cancel';
    live.checks?.abort();
    await live.handle?.cancel();
    await live.done;
    // An attempt can end in the moment the request arrives, and a cancel still has to win over that outcome.
    const state = (await store.getTask(taskId))?.state;
    if (state === 'ready' || state === 'escalated' || state === 'review') await store.setTaskState(taskId, 'cancelled');
  }

  // The state machine also allows review → ready, so the state is checked here.
  async retry(taskId: number): Promise<void> {
    const { store } = this.deps;
    const task = await store.getTask(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    if (task.state !== 'escalated') throw new IllegalTransition('task', task.state, 'ready');
    await store.setTaskState(taskId, 'ready');
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      [...this.live.values()].map(async (live) => {
        live.stop ??= 'shutdown';
        live.checks?.abort();
        await live.handle?.cancel();
        await live.done;
      }),
    );
  }

  private async run(taskId: number, live: Live): Promise<void> {
    const { store, paths } = this.deps;
    const work = await this.prepare(taskId, live);
    if (!work) return;
    if (live.stop) return this.applyStop(taskId, live);

    const { task, project, role, adapter } = work;
    const previous = (await store.listAttempts(taskId)).filter((a) => a.failure_evidence !== null).at(-1);

    const k = await store.nextAttemptK(taskId);
    const worktree = worktreePath(paths, project.name, task.ticket_id, k);
    const attempt = await store.createAttempt({
      task_id: taskId,
      adapter: adapter.id,
      model: role.defaults.model,
      worktree_path: worktree,
      branch: `aiteam/attempt/${task.ticket_id}-a${k}`,
      base_sha: work.baseSha,
    });
    live.attempt = attempt;
    await addAttemptWorktree(project.repo_path, worktree, attempt.branch, work.baseSha);

    const built = buildManifest({
      project: project.name,
      attemptK: k,
      role,
      charter: work.charter,
      schema: work.schema,
      schemaSource: work.schemaSource,
      taskId: work.ticket.id,
      taskMarkdown: work.ticketMarkdown,
      taskSource: task.ticket_path,
      inputs: [],
      doneCommands: work.ticket.definition_of_done,
      repoInstructions: await readRepoInstructions(worktree),
      ...(previous ? { retry: { evidence: String(previous.failure_evidence), changeReport: previous.output } } : {}),
    });
    if (!built.ok) {
      const sizes = built.parts.map((part) => `${part.name} ${part.tokens}`).join(', ');
      const reason = `context_over_budget: ${built.totalTokens} tokens against a budget of ${role.defaults.budgets.context_tokens} (${sizes})`;
      await store.setAttemptState(attempt.id, 'failed', failure('context_over_budget', reason));
      await store.setTaskState(taskId, 'escalated', { reason });
      return;
    }

    const { manifest } = built;
    const dir = manifestDir(paths, project.name, task.ticket_id, k);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'system.md'), manifest.system);
    await writeFile(join(dir, 'task.md'), manifest.task);
    await this.deps.log.append({
      projectId: project.id,
      taskId,
      attemptId: attempt.id,
      type: 'manifest.built',
      payload: { parts: manifest.parts, totalTokens: manifest.totalTokens, contextBudget: manifest.contextBudget },
    });

    // Nothing awaits between this check and the spawn, so a stop either prevents the worker or finds its handle.
    if (live.stop) return this.applyStop(taskId, live);
    const handle = adapter.start(manifest, { path: worktree, transcriptPath: transcriptPath(paths, project.name, attempt.id), manifestDir: dir });
    live.handle = handle;
    await store.setAttemptState(attempt.id, 'running', {
      pid: handle.pid ?? null,
      pid_started_at: handle.pid === undefined ? null : await processStartTime(handle.pid),
      manifest: { ...manifest, flags: handle.argv },
    });

    const [, result] = await Promise.all([this.pumpEvents(work, attempt.id, handle), handle.result]);
    await this.onWorkerResult(work, attempt, result, live);
  }

  // The role comes first because it names the adapter that preflight has to ask.
  private async prepare(taskId: number, live: Live): Promise<Work | undefined> {
    const { store, paths, adapters } = this.deps;
    const task = await store.getTask(taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    const project = await store.getProjectById(task.project_id);
    if (!project) throw new Error(`No project ${task.project_id}`);
    live.project = project;

    const workspaceError = (err: unknown) => store.setTaskState(taskId, 'escalated', { reason: `workspace_error: ${errorText(err)}` });

    let loaded: Awaited<ReturnType<typeof loadRole>>;
    let adapter: WorkerAdapter;
    try {
      loaded = await loadRole(paths.knowledge, task.role_id);
      const found = adapters[loaded.role.defaults.adapter];
      if (!found) throw new Error(`No adapter named ${loaded.role.defaults.adapter}`);
      adapter = found;
    } catch (err) {
      await workspaceError(err);
      return undefined;
    }

    const preflight = await adapter.preflight();
    if (!preflight.ok) {
      await store.setTaskState(taskId, 'escalated', { reason: `agent_home_not_logged_in: ${preflight.reason}. Fix: ${preflight.fix}` });
      return undefined;
    }

    try {
      const { headSha } = await ensureIntegrationBranch(project.repo_path, task.milestone, project.base_branch);
      const ticketMarkdown = await readFile(join(stateRepoDir(paths, project.name), task.ticket_path), 'utf8');
      return { task, project, ...loaded, adapter, ticket: parseTicket(ticketMarkdown), ticketMarkdown, baseSha: headSha };
    } catch (err) {
      await workspaceError(err);
      return undefined;
    }
  }

  private async pumpEvents(work: Work, attemptId: number, handle: AttemptHandle): Promise<void> {
    for await (const { t, ...payload } of handle.events) {
      await this.deps.log.append({
        projectId: work.project.id,
        taskId: work.task.id,
        attemptId,
        type: `worker.${t}`,
        payload: capStrings(payload) as Record<string, unknown>,
      });
    }
  }

  private async onWorkerResult(work: Work, attempt: AttemptRow, result: AttemptResult, live: Live): Promise<void> {
    const { store } = this.deps;
    const taskId = work.task.id;
    if (live.stop) return this.applyStop(taskId, live, resultPatch(result));

    switch (result.status) {
      case 'succeeded':
        await store.patchAttempt(attempt.id, resultPatch(result));
        await this.clearExpiredPause(work.adapter.vendor);
        return this.checkAttempt(work, attempt, live);
      case 'usage_limited':
        await store.setAttemptState(attempt.id, 'interrupted', resultPatch(result));
        await this.pauseVendor(work, attempt.id, result);
        await store.setTaskState(taskId, 'ready');
        return;
      case 'cancelled':
        throw new Error('The worker was cancelled with no stop requested');
      default:
    }

    const evidence = result.message ?? `The worker stopped: ${result.status}`;
    await store.setAttemptState(attempt.id, result.status, { ...resultPatch(result), ...failure(result.failureKind ?? null, evidence) });
    if (result.failureKind === 'auth_required') {
      await store.setTaskState(taskId, 'escalated', { reason: `auth_required: ${evidence}. Fix: ${work.adapter.loginFix}` });
      return;
    }
    await this.retryOrEscalate(taskId);
  }

  private async checkAttempt(work: Work, attempt: AttemptRow, live: Live): Promise<void> {
    const { store, log, paths, config } = this.deps;
    const { task, project, role } = work;
    await store.setTaskState(task.id, 'checks');
    await snapshotAttempt(project.repo_path, attempt.worktree_path, `aiteam: ${task.ticket_id} attempt ${attempt.k}`);

    // runChecks reports through synchronous callbacks, so their writes queue up here, in order.
    let writes: Promise<unknown> = Promise.resolve();
    let writeError: unknown;
    const enqueue = (write: () => Promise<unknown>): void => {
      writes = writes.then(write).catch((err: unknown) => {
        writeError ??= err;
      });
    };

    const controller = new AbortController();
    live.checks = controller;
    if (live.stop) controller.abort();
    const checks = await runChecks({
      repoPath: project.repo_path,
      worktree: attempt.worktree_path,
      baseSha: work.baseSha,
      writeScope: role.write_scope,
      commands: task.dod,
      denyRead: workerDenyRead(paths, homedir()),
      timeoutS: config.checkTimeoutS,
      signal: controller.signal,
      onEvent: (type, payload) =>
        enqueue(() => log.append({ projectId: project.id, taskId: task.id, attemptId: attempt.id, type, payload: payload as Record<string, unknown> })),
      onSpawn: (pid) => enqueue(async () => store.patchAttempt(attempt.id, { pid, pid_started_at: await processStartTime(pid) })),
    });
    await writes;

    if (live.stop) return this.applyStop(task.id, live);
    if (writeError !== undefined) throw writeError;

    if (checks.ok) {
      await store.setTaskState(task.id, 'review');
      await store.setAttemptState(attempt.id, 'succeeded');
      return;
    }
    await store.setAttemptState(attempt.id, 'failed', failure(checks.kind, checks.evidence));
    await this.retryOrEscalate(task.id);
  }

  private async retryOrEscalate(taskId: number): Promise<void> {
    const { store, config } = this.deps;
    if ((await store.failedAttemptCount(taskId)) >= config.maxAttempts) {
      await store.setTaskState(taskId, 'escalated', { reason: 'attempts_exhausted' });
    } else {
      await store.setTaskState(taskId, 'ready');
    }
  }

  private async applyStop(taskId: number, live: Live, patch: AttemptPatch = {}): Promise<void> {
    const { store } = this.deps;
    const { attempt, project, stop } = live;
    const cancelling = stop === 'cancel';
    if (attempt) await store.setAttemptState(attempt.id, cancelling ? 'cancelled' : 'interrupted', patch);
    await store.setTaskState(taskId, cancelling ? 'cancelled' : 'ready');
    if (!cancelling || !attempt || !project) return;
    try {
      await removeAttemptWorktree(project.repo_path, attempt.worktree_path, attempt.branch);
      await store.patchAttempt(attempt.id, { worktree_removed_at: new Date().toISOString() });
    } catch (err) {
      // Pruning gets another go at a worktree whose removal time was never set.
      console.error(`Could not remove the worktree of attempt ${attempt.id}: ${errorText(err)}`);
    }
  }

  // A task must never stick in running, so this reports its own failures rather than throwing them.
  private async failFromError(taskId: number, live: Live, err: unknown): Promise<void> {
    const { store } = this.deps;
    const message = errorText(err);
    try {
      await live.handle?.cancel();
      const attempt = (await store.listAttempts(taskId)).find((a) => a.id === live.attempt?.id);
      if (attempt?.state === 'starting' || attempt?.state === 'running') {
        await store.setAttemptState(attempt.id, 'failed', failure('engine_error', message));
      }
      const state = (await store.getTask(taskId))?.state;
      if (state === 'running' || state === 'checks') {
        await store.setTaskState(taskId, 'escalated', { reason: `engine_error: ${message}` });
      }
    } catch (second) {
      console.error(`Could not record the failure of task ${taskId} (${message}): ${errorText(second)}`);
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // A reset time already past would let the next attempt start at once and hit the same limit, so it counts as none.
  private async pauseVendor(work: Work, attemptId: number, result: AttemptResult): Promise<void> {
    const { store, log } = this.deps;
    const vendor = work.adapter.vendor;
    const now = this.now();
    const previous = await store.getVendorPause(vendor);
    const resetAt = result.resetAt !== undefined && Date.parse(result.resetAt) > now.getTime() ? result.resetAt : undefined;
    const doubled = previous ? Math.min(previous.backoff_s * 2, MAX_BACKOFF_S) : INITIAL_BACKOFF_S;
    const backoff_s = resetAt !== undefined ? (previous?.backoff_s ?? INITIAL_BACKOFF_S) : doubled;
    const until = resetAt ?? new Date(now.getTime() + backoff_s * 1000).toISOString();
    const reason = result.message ?? 'usage limit';

    await store.setVendorPause({ vendor, until, backoff_s, reason });
    await log.append({
      projectId: work.project.id,
      taskId: work.task.id,
      attemptId,
      type: 'vendor.paused',
      payload: { vendor, until, backoff_s, reason },
    });
  }

  // A worker that started before a pause began proves nothing about the limit, so only a pause that has run out is lifted.
  private async clearExpiredPause(vendor: string): Promise<void> {
    const { store } = this.deps;
    const pause = await store.getVendorPause(vendor);
    if (pause && Date.parse(pause.until) <= this.now().getTime()) await store.clearVendorPause(vendor);
  }
}
