import { mergeIntoBranch } from '../../git/merge.ts';
import { ensureIntegrationBranch, removeAttemptWorktree } from '../../git/workspace.ts';
import { reviewVerdict } from '../apply/review.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { ProjectRow, TaskRow } from '../store.ts';
import { codeReviewTask, ensureTask, isClosed, lastSucceeded, pinOf } from './tasks.ts';

async function reviewInputs(deps: EngineDeps, project: ProjectRow, ticket: TaskRow, k: number): Promise<string[]> {
  // A ticket added by hand has no artifact of its own, so only its Change Report says what it was for.
  const rows = await Promise.all([ticket.ticket_id, `CHANGE-${ticket.ticket_id}-a${k}`].map((id) => deps.artifacts.latest(project.id, id)));
  return rows.flatMap((row) => (row ? [pinOf(row)] : []));
}

async function mergeTicket(deps: EngineDeps, runner: Runner, project: ProjectRow, ticket: TaskRow, attempt: { id: number; head_sha: string; worktree_path: string; branch: string; k: number }): Promise<void> {
  const { branch: target } = await ensureIntegrationBranch(project.repo_path, ticket.milestone, project.base_branch);
  const merged = await mergeIntoBranch(project.repo_path, { target, source: attempt.head_sha, message: `Merge ${ticket.ticket_id}, attempt ${attempt.k}` });
  const scope = { projectId: project.id, taskId: ticket.id, attemptId: attempt.id };
  if (!merged.ok) {
    await deps.log.append({ ...scope, type: 'merge.conflict', payload: { target, conflicts: merged.conflicts } });
    await runner.rejectFromReview(ticket.id, 'merge_conflict', `Merging into ${target} conflicts in: ${merged.conflicts.join(', ')}`);
    return;
  }
  await removeAttemptWorktree(project.repo_path, attempt.worktree_path, attempt.branch);
  await deps.store.atomically(async (s) => {
    await s.patchAttempt(attempt.id, { worktree_removed_at: new Date().toISOString() });
    await s.setTaskState(ticket.id, 'done');
  });
  await deps.log.append({ ...scope, type: 'merge.done', payload: { target } });
}

async function advanceTicket(deps: EngineDeps, runner: Runner, project: ProjectRow, ticket: TaskRow): Promise<void> {
  const { store, artifacts } = deps;
  const attempt = (await store.listAttempts(ticket.id)).at(-1);
  if (!attempt?.head_sha) throw new Error(`${ticket.ticket_id} is in review with no committed attempt`);

  const review = await store.getTaskByTicket(project.id, `${ticket.ticket_id}-R${attempt.k}`);
  if (!review) {
    const inputs = await reviewInputs(deps, project, ticket, attempt.k);
    await ensureTask(store, codeReviewTask(project, ticket, attempt, attempt.head_sha, inputs));
    return;
  }
  if (review.state !== 'done') return;

  const reviewed = await lastSucceeded(store, review.id);
  if (!reviewed) throw new Error(`${review.ticket_id} is done with no successful attempt`);
  if (reviewVerdict(reviewed) === 'changes_requested') {
    const { body } = await artifacts.read(project, `REVIEW-${ticket.ticket_id}-a${attempt.k}`);
    await runner.rejectFromReview(ticket.id, 'changes_requested', body);
    return;
  }
  // The revision of what it cited decides whether this ticket still stands, so the merge waits for it.
  if ((await artifacts.latest(project.id, ticket.ticket_id))?.status === 'stale') return;
  await mergeTicket(deps, runner, project, ticket, { ...attempt, head_sha: attempt.head_sha });
}

export async function advanceReviews(deps: EngineDeps, runner: Runner, project: ProjectRow): Promise<void> {
  const tasks = await deps.store.listTasks(project.id);
  for (const review of tasks) {
    if (review.kind !== 'code_review' || isClosed(review)) continue;
    const ticket = tasks.find(({ id }) => id === review.parent_task_id);
    if (ticket?.state === 'cancelled') await runner.cancel(review.id);
  }
  for (const task of tasks) {
    if (task.kind === 'ticket' && task.state === 'review') await advanceTicket(deps, runner, project, task);
  }
}
