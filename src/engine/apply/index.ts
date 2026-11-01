import type { ArtifactChange } from '../../artifacts/store.ts';
import type { EngineDeps } from '../runner.ts';
import type { ArtifactVersionRow, AttemptRow, ProjectRow, Store, TaskRow } from '../store.ts';
import type { Purpose, WorkOrder } from '../workorder.ts';
import { applyDiscovery } from './discovery.ts';

export type ApplyCtx = {
  deps: EngineDeps;
  project: ProjectRow;
  task: TaskRow;
  attempt: AttemptRow;
  order: WorkOrder;
  output: unknown;
  worktree: string;
  signal: AbortSignal;
};

// after is not called then: a promise resolved with an object that has a then function calls it instead of handing the object over.
export type ApplyResult =
  | { ok: false; evidence: string }
  | { ok: true; change: ArtifactChange; after?: (s: Store, rows: ArtifactVersionRow[]) => Promise<void> };

export type Applier = (ctx: ApplyCtx) => Promise<ApplyResult>;

const notYet =
  (purpose: Purpose): Applier =>
  async () => {
    throw new Error(`No applier for ${purpose} yet`);
  };

const APPLIERS: Record<Purpose, Applier> = {
  discovery: applyDiscovery,
  environment_profile: notYet('environment_profile'),
  milestone_spec: notYet('milestone_spec'),
  tech_design: notYet('tech_design'),
  test_plan: notYet('test_plan'),
  code_review: notYet('code_review'),
  qa_verify: notYet('qa_verify'),
  milestone_review: notYet('milestone_review'),
  cr_recommendation: notYet('cr_recommendation'),
  revise_design: notYet('revise_design'),
  revise_test_plan: notYet('revise_test_plan'),
};

// An applier's refusal is the worker's failed attempt. An applier's exception is the engine's bug, and escalates.
export function applyOutput(ctx: ApplyCtx): Promise<ApplyResult> {
  return APPLIERS[ctx.order.purpose](ctx);
}
