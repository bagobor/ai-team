export const ENV_PROFILE = 'ENV-PROFILE';
// What a prototyping project's stakeholder found fun, written down in discovery.
export const FUN_DEFINITION = 'FUN-DEFINITION';

export const specId = (milestone: number) => `SPEC-M${milestone}`;
export const techId = (milestone: number) => `TECH-M${milestone}`;
export const testPlanId = (milestone: number) => `TEST-PLAN-M${milestone}`;
export const scopeId = (milestone: number) => `SCOPE-M${milestone}`;
export const reviewId = (milestone: number) => `MILESTONE-REVIEW-M${milestone}`;
// One per verify round, so each polish round's review is a record of its own.
export const engReviewId = (milestone: number, round: number) => `ENG-REVIEW-M${milestone}-${round}`;
export const ENG_REVIEW_ID = /^ENG-REVIEW-M[1-9]\d*-[1-9]\d*$/;
// An eng review's polish ticket, as M1-E-2.
export const isPolishTicket = (id: string): boolean => /-E-\d+$/.test(id);
// A prototype round r: its plan, the ticket for each prototype k, and the folder in the repo that ticket builds in.
export const protoPlanId = (r: number) => `PROTO-PLAN-${r}`;
// A plan's id, which its task's ticket id also is, with the round as the first group.
export const PROTO_PLAN_ID = /^PROTO-PLAN-([1-9]\d*)$/;
export const protoTicketId = (r: number, k: number) => `PROTO-${r}-P-${k}`;
export const protoRoot = (r: number, k: number) => `prototypes/r${r}/p${k}`;
