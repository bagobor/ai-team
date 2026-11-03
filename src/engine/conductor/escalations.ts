import { requestOf } from '../change-requests.ts';
import { oneLine } from '../apply/text.ts';
import type { InboxEvidence } from '../inbox.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow, TaskRow } from '../store.ts';
import { openHold, pinOf, raiseHold, RETRY_OR_HALT } from './tasks.ts';

type Deps = Pick<EngineDeps, 'store' | 'artifacts'>;

function recommend(reason: string): string {
  if (reason.startsWith('attempts_exhausted')) return 'Read the last failure first. Retry if you fixed what it names or think it was a passing problem.';
  if (reason.startsWith('auth_required') || reason.startsWith('agent_home_not_logged_in')) return 'Log the agent home in, then retry.';
  if (reason.startsWith('workspace_error')) return 'Fix what the error names, then retry.';
  if (reason.startsWith('dependency_cancelled')) return 'Retry runs it without the cancelled work, so choose it only if this ticket can stand alone. Otherwise cancel it.';
  return 'Look at the reason above, then retry if it has been dealt with.';
}

// A ticket can be cancelled and the milestone goes on. Any other kind holds up a phase, and cancelling it would leave that phase stuck.
const optionsFor = (task: TaskRow) => (task.kind === 'ticket' ? [{ id: 'retry', label: 'Retry' }, { id: 'cancel', label: 'Cancel the ticket' }] : RETRY_OR_HALT);

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

const workerSaid = (output: unknown): string => {
  const { summary, notes } = (output ?? {}) as { summary?: unknown; notes?: unknown };
  return [summary, notes].filter((text): text is string => typeof text === 'string' && text.trim() !== '').join('\n\n');
};

// What the stakeholder needs to decide without opening the task: why it last failed, what its worker made of it, and what it asked to change upstream.
async function evidenceOf(deps: Deps, project: ProjectRow, task: TaskRow): Promise<InboxEvidence[]> {
  const attempts = await deps.store.listAttempts(task.id);
  const failed = attempts.filter(({ failure_evidence }) => failure_evidence).at(-1);
  const said = attempts.map(({ output }) => workerSaid(output)).filter(Boolean).at(-1);
  const evidence: InboxEvidence[] = [];
  if (failed) evidence.push({ label: 'Last failure', value: clip(`${failed.failure_kind ? `${failed.failure_kind}: ` : ''}${String(failed.failure_evidence).trimEnd()}`, 1500) });
  if (said) evidence.push({ label: 'What the worker said', value: clip(said, 1500) });
  for (const row of await deps.artifacts.list(project.id)) {
    if (row.type !== 'change_request') continue;
    const request = requestOf(await deps.artifacts.read(project, row.artifact_id));
    if (request.raised_in !== task.ticket_id) continue;
    const where = request.target_ac ? `${request.target_artifact} ${request.target_ac}` : `${request.target_artifact}#${request.target_section}`;
    evidence.push({ label: row.artifact_id, value: clip(`${row.status}, against ${where}: ${oneLine(request.rationale)}`, 300), pin: pinOf(row) });
  }
  return evidence;
}

export async function raiseEscalations(deps: Deps, project: ProjectRow): Promise<void> {
  const { store } = deps;
  for (const item of await store.listInbox({ projectId: project.id, state: 'pending' })) {
    if (item.ref.kind !== 'escalation') continue;
    if ((await store.getTask(item.ref.taskId))?.state !== 'escalated') await store.withdrawInbox(item.id, 'The task is no longer escalated');
  }
  for (const task of await store.listTasks(project.id)) {
    if (task.state !== 'escalated') continue;
    const reason = task.escalation_reason ?? 'no reason recorded';
    const prefix = `escalation:${task.id}`;
    if (await openHold(store, project, prefix)) continue;
    await raiseHold(store, project, prefix, {
      ...(task.milestone === 0 ? {} : { milestone: task.milestone }),
      type: 'question',
      ref: { kind: 'escalation', taskId: task.id },
      title: `${task.ticket_id} needs you`,
      asked_by: task.role_id,
      why: `${task.title}: ${reason}`,
      blocks: [task.kind === 'ticket' ? task.ticket_id : task.milestone === 0 ? 'Discovery' : `Milestone ${task.milestone}`],
      evidence: await evidenceOf(deps, project, task),
      recommendation: recommend(reason),
      options: optionsFor(task),
    });
  }
}
