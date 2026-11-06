export const AC_ID = /^AC-\d+$/;
export const AC_SLUG = /^ac-\d+(-\d+)?$/;

export type VerificationMethod = 'automated' | 'human';

// A human check exists because some promises, such as how a game feels or looks, only a person can judge. The stakeholder
// makes it at milestone approval by doing what `how` says, so QA never runs one.
export type Criterion = { id: string; text: string; verification: { method: VerificationMethod; how: string } };

export const isHumanCheck = (c: { verification: { method: string } }): boolean => c.verification.method === 'human';

// The line under a criterion that says who proves it. The engine writes it, and a Change Request that rewrites the criterion has to keep the same one.
export const verificationLabel = (c: { verification: { method: string } }): string => (isHumanCheck(c) ? 'Checked by the stakeholder' : 'Verified by');

// Each one costs the stakeholder minutes at milestone approval, so a Spec keeps them to what no command can judge.
export const MAX_HUMAN_CHECKS = 3;

export type CriterionStatus = 'unverified' | 'passing' | 'failing' | 'waived';

export type Verification = { status: 'passing' | 'failing'; evidenceRef: string; verifiedBy: { kind: 'qa_verify'; taskId: number } | { kind: 'stakeholder'; inboxId: number } };
