import type { ArtifactChange, NewVersion } from '../../artifacts/store.ts';
import type { ApplyCtx, ApplyResult } from './index.ts';

// A worker that finds a problem with something upstream says so here. The Change Request flow arrives in a later task.
export async function raisedRequests(_ctx: ApplyCtx, _output: unknown): Promise<{ docs: NewVersion[]; dropped: string[] }> {
  return { docs: [], dropped: [] };
}

// How every applier ends: its documents, what its worker raised, and a log line for each request that couldn't be filed.
export async function withRaised(ctx: ApplyCtx, change: ArtifactChange, after?: Extract<ApplyResult, { ok: true }>['after']): Promise<ApplyResult> {
  const { docs, dropped } = await raisedRequests(ctx, ctx.output);
  return {
    ok: true,
    change: { ...change, publish: [...(change.publish ?? []), ...docs] },
    after: async (s, rows) => {
      await after?.(s, rows);
      for (const reason of dropped) await s.logEvent(ctx.project.id, 'change_request.dropped', { reason });
    },
  };
}
