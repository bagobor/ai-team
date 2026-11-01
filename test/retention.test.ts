import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { addAttemptWorktree, ensureIntegrationBranch } from '../src/git/workspace.ts';
import { addProject, addTicket } from '../src/engine/intake.ts';
import type { AttemptState, TaskState } from '../src/engine/fsm.ts';
import { pruneWorktrees } from '../src/engine/retention.ts';
import type { AttemptRow, TaskRow } from '../src/engine/store.ts';
import { worktreePath } from '../src/paths.ts';
import { makeEngine, ticket, type TestEngine } from './helpers/engine.ts';
import { makeRepo } from './helpers/repo.ts';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const DAY_MS = 86_400_000;

const ROUTE: Partial<Record<TaskState, TaskState[]>> = {
  escalated: ['ready', 'escalated'],
  review: ['ready', 'running', 'checks', 'review'],
  cancelled: ['cancelled'],
};

describe('pruneWorktrees', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [], now: () => NOW });
  });

  afterEach(async () => {
    await e.cleanup();
  });

  let nextTicket = 0;

  async function taskIn(state: TaskState, project = 'p'): Promise<TaskRow> {
    nextTicket += 1;
    const t = await addTicket({ store: e.store, paths: e.paths }, project, ticket({ id: `T-${nextTicket}`, touches: [`d${nextTicket}/**`] }));
    for (const step of ROUTE[state] ?? []) await e.store.setTaskState(t.id, step);
    return t;
  }

  async function endedAttempt(t: TaskRow, state: AttemptState, daysAgo: number, repoPath = e.repoPath, project = 'p'): Promise<AttemptRow> {
    const k = await e.store.nextAttemptK(t.id);
    const worktree = worktreePath(e.paths, project, t.ticket_id, k);
    const branch = `aiteam/attempt/${t.ticket_id}-a${k}`;
    const { headSha } = await ensureIntegrationBranch(repoPath, 1, 'main');
    await addAttemptWorktree(repoPath, worktree, branch, headSha);
    const attempt = await e.store.createAttempt({ task_id: t.id, adapter: 'claude-code', model: 'm', worktree_path: worktree, branch });
    await e.store.setAttemptState(attempt.id, 'running');
    await e.store.setAttemptState(attempt.id, state);
    return e.store.patchAttempt(attempt.id, { ended_at: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString() });
  }

  const removedAt = async (a: AttemptRow) => (await e.store.listAttempts(a.task_id)).find((row) => row.id === a.id)!.worktree_removed_at;
  const branchExists = (repo: string, branch: string) =>
    execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== '';

  it('removes the worktree of a ticket cancelled in review once it is old enough', async () => {
    const old = await endedAttempt(await taskIn('cancelled'), 'succeeded', 8);
    const recent = await endedAttempt(await taskIn('cancelled'), 'succeeded', 6);

    expect(await pruneWorktrees(e)).toBe(1);

    expect(await removedAt(old)).toBe(NOW.toISOString());
    expect(await removedAt(recent)).toBeNull();
  });

  it('keeps the succeeded attempt of a ticket still in review', async () => {
    const kept = await endedAttempt(await taskIn('review'), 'succeeded', 8);

    expect(await pruneWorktrees(e)).toBe(0);

    expect(await removedAt(kept)).toBeNull();
  });

  it('removes failed worktrees after 7 days, not before', async () => {
    const old = await endedAttempt(await taskIn('escalated'), 'failed', 8);
    const recent = await endedAttempt(await taskIn('escalated'), 'failed', 6);

    expect(await pruneWorktrees(e)).toBe(1);

    expect(existsSync(old.worktree_path)).toBe(false);
    expect(branchExists(e.repoPath, old.branch)).toBe(false);
    expect(await removedAt(old)).toBe(NOW.toISOString());
    expect(existsSync(recent.worktree_path)).toBe(true);
    expect(await removedAt(recent)).toBeNull();
  });

  it('takes the retention period from the config', async () => {
    e.config.worktreeRetentionDays = 1;
    const old = await endedAttempt(await taskIn('escalated'), 'failed', 2);

    expect(await pruneWorktrees(e)).toBe(1);

    expect(existsSync(old.worktree_path)).toBe(false);
  });

  it.each(['failed', 'timeout', 'budget_exceeded', 'invalid_output', 'interrupted', 'cancelled'] as const)('removes an old %s attempt', async (state) => {
    const old = await endedAttempt(await taskIn('escalated'), state, 8);

    expect(await pruneWorktrees(e)).toBe(1);

    expect(existsSync(old.worktree_path)).toBe(false);
  });

  it('keeps a succeeded attempt', async () => {
    const kept = await endedAttempt(await taskIn('escalated'), 'succeeded', 30);

    expect(await pruneWorktrees(e)).toBe(0);

    expect(existsSync(kept.worktree_path)).toBe(true);
  });

  it('never removes the latest attempt of a task in review', async () => {
    const t = await taskIn('review');
    const earlier = await endedAttempt(t, 'failed', 30);
    const latest = await endedAttempt(t, 'interrupted', 30);

    expect(await pruneWorktrees(e)).toBe(1);

    expect(existsSync(earlier.worktree_path)).toBe(false);
    expect(existsSync(latest.worktree_path)).toBe(true);
    expect(await removedAt(latest)).toBeNull();
  });

  it('tolerates a directory already gone', async () => {
    const old = await endedAttempt(await taskIn('escalated'), 'failed', 8);
    rmSync(old.worktree_path, { recursive: true });

    expect(await pruneWorktrees(e)).toBe(1);

    expect(await removedAt(old)).toBe(NOW.toISOString());
    expect(branchExists(e.repoPath, old.branch)).toBe(false);
  });

  it('does not remove anything twice', async () => {
    await endedAttempt(await taskIn('escalated'), 'failed', 8);

    expect(await pruneWorktrees(e)).toBe(1);
    expect(await pruneWorktrees(e)).toBe(0);
  });

  it('carries on past a repo that has gone, and tries it again next time', async () => {
    const other = await makeRepo();
    await addProject({ store: e.store, paths: e.paths }, { name: 'q', repoPath: other.path, create: false });
    const lost = await endedAttempt(await taskIn('escalated', 'q'), 'failed', 8, other.path, 'q');
    const old = await endedAttempt(await taskIn('escalated'), 'failed', 8);
    rmSync(other.path, { recursive: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await pruneWorktrees(e)).toBe(1);

    expect(existsSync(old.worktree_path)).toBe(false);
    expect(await removedAt(lost)).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
