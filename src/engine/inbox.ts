export type InboxRef =
  | { kind: 'cp1' }
  | { kind: 'cp2' | 'cp4'; milestone: number }
  | { kind: 'cr'; cr: string }
  | { kind: 'escalation'; taskId: number }
  | { kind: 'smoke' | 'base_conflict' | 'base_refused' | 'qa_cap' | 'play'; milestone: number }
  | { kind: 'fun_eval'; round: number }
  | { kind: 'must_support'; version: number }
  // `raised_in` is the task that said the item can't be met, and `why` is its reason, which a revision of the list reads.
  | { kind: 'ms_gap'; item: string; scope: 'milestone' | 'prototype'; n: number; raised_in: string; why: string }
  | { kind: 'engine_error' };

export type InboxType = 'approval' | 'question';
export type InboxState = 'pending' | 'answered' | 'withdrawn';
export type InboxEvidence = { label: string; value: string; pin?: string };

// The label of CP4's evidence that links to the milestone's build. The Inbox links no other evidence to a page off the app.
export const TRY_IT = 'Try it';
// The prefix of a fun evaluation's evidence that links to a prototype, as in `Play P-1`. Its check says to play the same link.
export const PLAY = 'Play ';

export type InboxOption = { id: string; label: string };
// A criterion only the stakeholder can judge, listed on the approval so their answer can say whether it holds.
export type InboxCheck = { ac: string; text: string; how: string };
export type CheckMark = { ac: string; status: 'passing' | 'failing'; note: string };
// A must-support item the build doesn't meet, which the stakeholder may approve the milestone without.
export type InboxWaivable = { id: string; text: string; why: string };

export type NewInboxItem = {
  project_id: number;
  milestone?: number;
  type: InboxType;
  dedupe_key: string;
  ref: InboxRef;
  title: string;
  asked_by: string;
  why: string;
  blocks: string[];
  evidence: InboxEvidence[];
  recommendation: string;
  options: InboxOption[];
  checks?: InboxCheck[];
  waivable?: InboxWaivable[];
};

// `waive` names the must-support items a milestone is approved without.
export type InboxAnswer =
  | { action: 'approve'; checks?: CheckMark[]; waive?: string[] }
  | { action: 'reject'; checks?: CheckMark[] }
  | { action: 'request_changes'; comment: string; checks?: CheckMark[] }
  | { option: string }
  | { text: string };

export type InboxRow = Omit<NewInboxItem, 'milestone' | 'checks' | 'waivable'> & {
  id: number;
  milestone: number | null;
  checks: InboxCheck[];
  waivable: InboxWaivable[];
  state: InboxState;
  answer: InboxAnswer | null;
  answered_at: string | null;
  applied_at: string | null;
  created_at: string;
};

export class AlreadyAnswered extends Error {
  constructor(id: number) {
    super(`Inbox item ${id} is not waiting for an answer`);
    this.name = 'AlreadyAnswered';
  }
}

export class InvalidAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAnswer';
  }
}

const isBlank = (text: unknown) => typeof text !== 'string' || text.trim() === '';

// What an answer's marks must cover: nothing, every check, or every check passing.
type Needs = 'none' | 'marked' | 'passing';
const RULE = { marked: 'approve needs every check marked, fun or not fun', passing: 'approve needs every check marked passing' };

// A mark becomes the criterion's status, so each one has to be a real verdict on a real check, and an approval can't stand on a check nobody judged.
// `exempt` are the checks the stakeholder approves without, which need no verdict.
function assertValidMarks(checks: InboxCheck[], marks: CheckMark[], needs: Needs, exempt: Set<string>): void {
  const named = new Set(checks.map(({ ac }) => ac));
  for (const { ac } of marks) if (!named.has(ac)) throw new InvalidAnswer(`${ac} is not one of this item's checks`);

  const marked = new Map<string, CheckMark>();
  for (const mark of marks) {
    if (marked.has(mark.ac)) throw new InvalidAnswer(`${mark.ac} is marked more than once`);
    marked.set(mark.ac, mark);
  }

  for (const { ac, status, note } of marks) {
    if (status !== 'passing' && status !== 'failing') throw new InvalidAnswer(`${ac} is marked ${JSON.stringify(status)}: a check is passing or failing`);
    if (status === 'failing' && isBlank(note)) throw new InvalidAnswer(`${ac} is failing and needs a note`);
  }

  if (needs === 'none') return;
  for (const { ac } of checks) {
    if (exempt.has(ac)) continue;
    const mark = marked.get(ac);
    if (!mark) throw new InvalidAnswer(`${ac} is not marked: ${RULE[needs]}`);
    if (needs === 'passing' && mark.status !== 'passing') throw new InvalidAnswer(`${ac} is failing: ${RULE.passing}`);
  }
}

// A fun evaluation asks the stakeholder for a verdict on each prototype, and not fun is as much a verdict as fun: approving
// it says the fun is defined, not that every prototype was fun.
const needsOf = (item: Pick<InboxRow, 'ref'>, action: 'approve' | 'request_changes'): Needs => {
  if (action !== 'approve') return 'none';
  return item.ref.kind === 'fun_eval' ? 'marked' : 'passing';
};

const MS_ID = /^MS-[1-9]\d*$/;
type Answerable = Pick<InboxRow, 'id' | 'type' | 'options' | 'checks' | 'ref'> & Partial<Pick<InboxRow, 'waivable'>>;

// A must-support item the build doesn't meet reaches the base branch only when the stakeholder says, item by item, that
// they approve without it. So only a milestone's approval takes a waiver, only for what that approval offers, and an
// approval that leaves a failing item out is refused.
function waivedBy(item: Answerable, answer: InboxAnswer): Set<string> {
  // The answer came from outside, so what it carries as waive is only known to be there.
  const given: unknown = 'waive' in answer ? answer.waive : undefined;
  const isList = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');
  if (given !== undefined && !isList(given)) throw new InvalidAnswer('waive is a list of must-support item ids');
  const waive = given ?? [];
  const approves = 'action' in answer && answer.action === 'approve';
  if (waive.length > 0 && !(item.ref.kind === 'cp4' && approves)) throw new InvalidAnswer('Only a milestone approval can waive a must-support item');
  const waivable = (item.waivable ?? []).map(({ id }) => id);
  const offered = [...waivable, ...item.checks.map(({ ac }) => ac).filter((ac) => MS_ID.test(ac))];
  for (const id of waive) if (!offered.includes(id)) throw new InvalidAnswer(`${id} is not a must-support item on this approval`);
  if (approves) for (const id of waivable) if (!waive.includes(id)) throw new InvalidAnswer(`${id} does not meet the list: approve without it, or request changes`);
  return new Set(waive);
}

export function assertValidAnswer(item: Answerable, answer: InboxAnswer): void {
  if (item.type === 'approval') {
    if (!('action' in answer) || !['approve', 'reject', 'request_changes'].includes(answer.action)) throw new InvalidAnswer(`Inbox item ${item.id} is an approval: approve, reject or request changes`);
    if (answer.action === 'request_changes' && isBlank(answer.comment)) throw new InvalidAnswer('Request changes needs a comment');
    const waived = waivedBy(item, answer);
    // A reject doesn't depend on the checks, so it isn't held to them.
    if (answer.action !== 'reject') assertValidMarks(item.checks, answer.checks ?? [], needsOf(item, answer.action), waived);
    return;
  }
  if ('option' in answer) {
    if (!item.options.some(({ id }) => id === answer.option)) throw new InvalidAnswer(`Inbox item ${item.id} does not offer ${String(answer.option)}`);
    return;
  }
  if (!('text' in answer)) throw new InvalidAnswer(`Inbox item ${item.id} is a question: pick an option or write an answer`);
  if (isBlank(answer.text)) throw new InvalidAnswer('A written answer cannot be blank');
}
