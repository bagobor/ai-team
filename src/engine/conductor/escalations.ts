import type { EngineDeps } from '../runner.ts';
import type { ProjectRow, TaskRow } from '../store.ts';
import { raiseHold, RETRY_OR_HALT } from './tasks.ts';

function recommend(reason: string): string {
  if (reason.startsWith('attempts_exhausted')) return 'Read the last failure first. Retry if you fixed what it names or think it was a passing problem.';
  if (reason.startsWith('auth_required') || reason.startsWith('agent_home_not_logged_in')) return 'Log the agent home in, then retry.';
  if (reason.startsWith('workspace_error')) return 'Fix what the error names, then retry.';
  if (reason.startsWith('dependency_cancelled')) return 'Retry runs it without the cancelled work, so choose it only if this ticket can stand alone. Otherwise cancel it.';
  return 'Look at the reason above, then retry if it has been dealt with.';
}

// A ticket can be cancelled and the milestone goes on. Any other kind holds up a phase, and cancelling it would leave that phase stuck.
const optionsFor = (task: TaskRow) => (task.kind === 'ticket' ? [{ id: 'retry', label: 'Retry' }, { id: 'cancel', label: 'Cancel the ticket' }] : RETRY_OR_HALT);

export async function raiseEscalations(deps: Pick<EngineDeps, 'store'>, project: ProjectRow): Promise<void> {
  const { store } = deps;
  for (const item of await store.listInbox({ projectId: project.id, state: 'pending' })) {
    if (item.ref.kind !== 'escalation') continue;
    if ((await store.getTask(item.ref.taskId))?.state !== 'escalated') await store.withdrawInbox(item.id, 'The task is no longer escalated');
  }
  for (const task of await store.listTasks(project.id)) {
    if (task.state !== 'escalated') continue;
    const reason = task.escalation_reason ?? 'no reason recorded';
    await raiseHold(store, project, `escalation:${task.id}`, {
      ...(task.milestone === 0 ? {} : { milestone: task.milestone }),
      type: 'question',
      ref: { kind: 'escalation', taskId: task.id },
      title: `${task.ticket_id} needs you`,
      asked_by: task.role_id,
      why: `${task.title}: ${reason}`,
      blocks: [task.kind === 'ticket' ? task.ticket_id : task.milestone === 0 ? 'Discovery' : `Milestone ${task.milestone}`],
      evidence: [],
      recommendation: recommend(reason),
      options: optionsFor(task),
    });
  }
}
