export const AC_ID = /^AC-\d+$/;
export const AC_SLUG = /^ac-\d+(-\d+)?$/;

// The method is automated only until M6, which adds the checks a person has to run.
export type Criterion = { id: string; text: string; verification: { method: 'automated'; how: string } };

export type CriterionStatus = 'unverified' | 'passing' | 'failing' | 'waived';

export type Verification = { status: 'passing' | 'failing'; evidenceRef: string; verifiedBy: { kind: 'qa_verify'; taskId: number } };
