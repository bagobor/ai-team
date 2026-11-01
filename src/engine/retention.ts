import { removeAttemptWorktree } from '../git/workspace.ts';
import type { EngineDeps } from './runner.ts';

const DAY_MS = 86_400_000;
const ENDED_WITHOUT_SUCCESS = ['failed', 'timeout', 'budget_exceeded', 'invalid_output', 'cancelled', 'interrupted'];

export async function pruneWorktrees(deps: EngineDeps): Promise<number> {
  const { db, store, config, now } = deps;
  const current = now?.() ?? new Date();
  const cutoff = new Date(current.getTime() - config.worktreeRetentionDays * DAY_MS).toISOString();

  const candidates = await db
    .selectFrom('attempts')
    .innerJoin('tasks', 'tasks.id', 'attempts.task_id')
    .innerJoin('projects', 'projects.id', 'tasks.project_id')
    .select(['attempts.id', 'attempts.task_id', 'attempts.k', 'attempts.worktree_path', 'attempts.branch', 'tasks.state as task_state', 'projects.repo_path'])
    // A ticket cancelled in review keeps a succeeded attempt that no merge will ever clear away.
    .where((eb) => eb.or([eb('attempts.state', 'in', ENDED_WITHOUT_SUCCESS), eb.and([eb('attempts.state', '=', 'succeeded'), eb('tasks.state', '=', 'cancelled')])]))
    .where('attempts.worktree_removed_at', 'is', null)
    .where('attempts.ended_at', '<', cutoff)
    .execute();

  let removed = 0;
  for (const attempt of candidates) {
    if (attempt.task_state === 'review' && attempt.k === (await store.nextAttemptK(attempt.task_id)) - 1) continue;
    try {
      await removeAttemptWorktree(attempt.repo_path, attempt.worktree_path, attempt.branch);
      await store.patchAttempt(attempt.id, { worktree_removed_at: current.toISOString() });
      removed += 1;
    } catch (err) {
      // The removal time stays unset, so the next pass tries again.
      console.error(`Could not remove the worktree of attempt ${attempt.id}:`, err);
    }
  }
  return removed;
}
