import type { ArtifactChange, NewVersion } from '../../artifacts/store.ts';
import { changeRequestDocs, type ChangeRequestInput } from '../change-requests.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import type { ApplyCtx, ApplyResult } from './index.ts';

// A worker that finds a problem with something upstream says so here, and the engine knows which role it was.
export async function raisedRequests(deps: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, roleId: string, output: unknown): Promise<{ docs: NewVersion[]; dropped: string[] }> {
  const raised = (output as { change_requests?: unknown } | null | undefined)?.change_requests;
  if (!Array.isArray(raised)) return { docs: [], dropped: [] };
  return changeRequestDocs(deps, project, raised.map((request) => ({ ...(request as object), raised_by: roleId }) as ChangeRequestInput));
}

// How every applier ends: its documents, what its worker raised, and a log line for each request that couldn't be filed.
export async function withRaised(ctx: ApplyCtx, change: ArtifactChange, after?: Extract<ApplyResult, { ok: true }>['after']): Promise<ApplyResult> {
  const { docs, dropped } = await raisedRequests(ctx.deps, ctx.project, ctx.task.role_id, ctx.output);
  return {
    ok: true,
    change: { ...change, publish: [...(change.publish ?? []), ...docs] },
    after: async (s, rows) => {
      await after?.(s, rows);
      for (const reason of dropped) await s.logEvent(ctx.project.id, 'change_request.dropped', { reason });
    },
  };
}
