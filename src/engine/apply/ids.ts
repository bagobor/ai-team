export const ENV_PROFILE = 'ENV-PROFILE';

export const specId = (milestone: number) => `SPEC-M${milestone}`;
export const techId = (milestone: number) => `TECH-M${milestone}`;
export const testPlanId = (milestone: number) => `TEST-PLAN-M${milestone}`;
export const scopeId = (milestone: number) => `SCOPE-M${milestone}`;
export const reviewId = (milestone: number) => `MILESTONE-REVIEW-M${milestone}`;
// One per verify round, so each polish round's review is a record of its own.
export const engReviewId = (milestone: number, round: number) => `ENG-REVIEW-M${milestone}-${round}`;
// A prototype round r: its plan, the ticket for each prototype k, and the folder in the repo that ticket builds in.
export const protoPlanId = (r: number) => `PROTO-PLAN-${r}`;
export const protoTicketId = (r: number, k: number) => `PROTO-${r}-P-${k}`;
export const protoRoot = (r: number, k: number) => `prototypes/r${r}/p${k}`;
