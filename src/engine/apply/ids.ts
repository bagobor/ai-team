export const ENV_PROFILE = 'ENV-PROFILE';

export const specId = (milestone: number) => `SPEC-M${milestone}`;
export const techId = (milestone: number) => `TECH-M${milestone}`;
export const testPlanId = (milestone: number) => `TEST-PLAN-M${milestone}`;
export const scopeId = (milestone: number) => `SCOPE-M${milestone}`;
export const reviewId = (milestone: number) => `MILESTONE-REVIEW-M${milestone}`;
// One per verify round, so each polish round's review is a record of its own.
export const engReviewId = (milestone: number, round: number) => `ENG-REVIEW-M${milestone}-${round}`;
