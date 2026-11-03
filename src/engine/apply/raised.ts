import type { ArtifactChange, NewVersion } from '../../artifacts/store.ts';
import { changeRequestDocs, type ChangeRequestInput } from '../change-requests.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow, TaskRow } from '../store.ts';
import type { ApplyCtx, ApplyResult } from './index.ts';

export type Raised = { docs: NewVersion[]; dropped: string[] };

// A worker that finds a problem with something upstream says so here, and the engine knows which role and task it was.
export async function raisedRequests(deps: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, task: Pick<TaskRow, 'role_id' | 'ticket_id'>, output: unknown): Promise<Raised> {
  const raised = (output as { change_requests?: unknown } | null | undefined)?.change_requests;
  if (!Array.isArray(raised)) return { docs: [], dropped: [] };
  return changeRequestDocs(deps, project, raised.map((request) => ({ ...(request as object), raised_by: task.role_id, raised_in: task.ticket_id }) as ChangeRequestInput));
}

export const raisedOf = (ctx: ApplyCtx): Promise<Raised> => raisedRequests(ctx.deps, ctx.project, ctx.task, ctx.output);

const isLastAttempt = async (ctx: ApplyCtx): Promise<boolean> => (await ctx.deps.store.failedAttemptCount(ctx.task.id)) + 1 >= ctx.deps.config.maxAttempts;

const sendBack = (dropped: string[]): string =>
  ['These change_requests could not be filed. Correct each one, or leave it out, and send your whole output again:', ...dropped.map((reason) => `- ${reason}`)].join('\n');

// A request that can't be filed is one nobody would read, so the worker goes back to correct it.
// A last attempt keeps its work instead, since losing a request costs less than losing the work, and the log says what was lost.
export async function sentBack(ctx: ApplyCtx, { dropped }: Raised): Promise<Extract<ApplyResult, { ok: false }> | undefined> {
  return dropped.length > 0 && !(await isLastAttempt(ctx)) ? { ok: false, evidence: sendBack(dropped) } : undefined;
}

// How every applier ends: its documents and what its worker raised.
export async function withRaised(ctx: ApplyCtx, change: ArtifactChange, after?: Extract<ApplyResult, { ok: true }>['after'], raised?: Raised): Promise<ApplyResult> {
  const { docs, dropped } = raised ?? (await raisedOf(ctx));
  const back = await sentBack(ctx, { docs, dropped });
  if (back) return back;
  return {
    ok: true,
    change: { ...change, publish: [...(change.publish ?? []), ...docs] },
    after: async (s, rows) => {
      await after?.(s, rows);
      for (const reason of dropped) await s.logEvent(ctx.project.id, 'change_request.dropped', { reason });
    },
  };
}
