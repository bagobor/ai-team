import type { ArtifactChange } from '../../artifacts/store.ts';
import type { EventType } from '../../events.ts';
import type { EngineDeps } from '../runner.ts';
import type { ArtifactVersionRow, AttemptRow, ProjectRow, Store, TaskRow } from '../store.ts';
import type { Purpose, WorkOrder } from '../workorder.ts';
import { applyReviseDesign, applyReviseTestPlan, applyTechDesign, applyTestPlan } from './design.ts';
import { applyDiscovery, applyEnvironmentProfile } from './discovery.ts';
import { applyMilestoneReview, applyMilestoneSpec } from './milestone.ts';
import { applyQaVerify } from './qa.ts';
import { applyCodeReview, applyCrRecommendation } from './review.ts';

export type ApplyCtx = {
  deps: EngineDeps;
  project: ProjectRow;
  task: TaskRow;
  attempt: AttemptRow;
  order: WorkOrder;
  output: unknown;
  worktree: string;
  signal: AbortSignal;
  report: { onEvent: (type: EventType, payload: unknown) => void; onSpawn: (pid: number) => void };
};

// after is not called then: a promise resolved with an object that has a then function calls it instead of handing the object over.
export type ApplyResult =
  | { ok: false; evidence: string }
  | { ok: true; change: ArtifactChange; after?: (s: Store, rows: ArtifactVersionRow[]) => Promise<void> };

export type Applier = (ctx: ApplyCtx) => Promise<ApplyResult>;

const APPLIERS: Record<Purpose, Applier> = {
  discovery: applyDiscovery,
  environment_profile: applyEnvironmentProfile,
  milestone_spec: applyMilestoneSpec,
  tech_design: applyTechDesign,
  test_plan: applyTestPlan,
  code_review: applyCodeReview,
  qa_verify: applyQaVerify,
  milestone_review: applyMilestoneReview,
  cr_recommendation: applyCrRecommendation,
  revise_design: applyReviseDesign,
  revise_test_plan: applyReviseTestPlan,
};

// An applier's refusal is the worker's failed attempt. An applier's exception is the engine's bug, and escalates.
export function applyOutput(ctx: ApplyCtx): Promise<ApplyResult> {
  return APPLIERS[ctx.order.purpose](ctx);
}
