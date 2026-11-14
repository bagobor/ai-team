import type { ArtifactChange, NewVersion } from '../../artifacts/store.ts';
import { changeRequestDocs, type ChangeRequestInput } from '../change-requests.ts';
import { mustSupportItems } from '../conductor/tasks.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow, TaskRow } from '../store.ts';
import { gapProblems, NO_LIST, raisableGaps, raiseGaps, type Gap, type MsList } from './gaps.ts';
import type { ApplyCtx, ApplyResult } from './index.ts';

// The gaps to raise against the list in force, and what is wrong with the rest.
export type RaisedGaps = { list?: MsList; raise: Gap[]; problems: string[] };
export type Raised = { docs: NewVersion[]; dropped: string[]; gaps: RaisedGaps };

// A worker that finds a problem with something upstream says so here, and the engine knows which role and task it was.
export async function raisedRequests(deps: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, task: Pick<TaskRow, 'role_id' | 'ticket_id'>, output: unknown): Promise<Pick<Raised, 'docs' | 'dropped'>> {
  const raised = (output as { change_requests?: unknown } | null | undefined)?.change_requests;
  if (!Array.isArray(raised)) return { docs: [], dropped: [] };
  return changeRequestDocs(deps, project, raised.map((request) => ({ ...(request as object), raised_by: task.role_id, raised_in: task.ticket_id }) as ChangeRequestInput));
}

// A worker that can't meet an item on the must-support list says so in gaps. The schema keeps each one's shape.
async function raisedGaps({ deps, project, output }: ApplyCtx): Promise<RaisedGaps> {
  const gaps = (output as { gaps?: unknown } | null | undefined)?.gaps;
  if (!Array.isArray(gaps) || gaps.length === 0) return { raise: [], problems: [] };
  const list = await mustSupportItems(deps, project);
  if (!list) return { raise: [], problems: [NO_LIST] };
  return { list, raise: raisableGaps(gaps as Gap[], list.items), problems: gapProblems(gaps as Gap[], list.items, list.pin) };
}

export const raisedOf = async (ctx: ApplyCtx): Promise<Raised> => ({ ...(await raisedRequests(ctx.deps, ctx.project, ctx.task, ctx.output)), gaps: await raisedGaps(ctx) });

const isLastAttempt = async (ctx: ApplyCtx): Promise<boolean> => (await ctx.deps.store.failedAttemptCount(ctx.task.id)) + 1 >= ctx.deps.config.maxAttempts;

const listed = (head: string, reasons: string[]): string[] => (reasons.length === 0 ? [] : [[head, ...reasons.map((reason) => `- ${reason}`)].join('\n')]);

const sendBack = ({ dropped, gaps }: Raised): string =>
  [
    ...listed('These change_requests could not be filed. Correct each one, or leave it out, and send your whole output again:', dropped),
    ...listed('These gaps could not be raised. Correct each one, or leave it out, and send your whole output again:', gaps.problems),
  ].join('\n\n');

// A request that can't be filed is one nobody would read, and a gap that can't be raised is one the stakeholder would
// never see, so the worker goes back to correct it.
// A last attempt keeps its work instead, since losing a request costs less than losing the work, and the log says what was lost.
export async function sentBack(ctx: ApplyCtx, raised: Raised): Promise<Extract<ApplyResult, { ok: false }> | undefined> {
  const refused = raised.dropped.length + raised.gaps.problems.length;
  return refused > 0 && !(await isLastAttempt(ctx)) ? { ok: false, evidence: sendBack(raised) } : undefined;
}

// How every applier ends: its documents, what its worker raised, and the gaps it named.
export async function withRaised(ctx: ApplyCtx, change: ArtifactChange, after?: Extract<ApplyResult, { ok: true }>['after'], given?: Raised): Promise<ApplyResult> {
  const raised = given ?? (await raisedOf(ctx));
  const back = await sentBack(ctx, raised);
  if (back) return back;
  const { docs, dropped, gaps } = raised;
  return {
    ok: true,
    change: { ...change, publish: [...(change.publish ?? []), ...docs] },
    after: async (s, rows) => {
      await after?.(s, rows);
      if (gaps.list) await raiseGaps(s, ctx.project, ctx.task, gaps.raise, gaps.list);
      for (const reason of dropped) await s.logEvent(ctx.project.id, 'change_request.dropped', { reason });
      for (const reason of gaps.problems) await s.logEvent(ctx.project.id, 'must_support.gap_dropped', { reason });
    },
  };
}
