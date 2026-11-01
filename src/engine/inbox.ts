export type InboxRef =
  | { kind: 'cp1' }
  | { kind: 'cp2' | 'cp4'; milestone: number }
  | { kind: 'cr'; cr: string }
  | { kind: 'escalation'; taskId: number }
  | { kind: 'smoke' | 'base_conflict' | 'base_refused' | 'qa_cap'; milestone: number }
  | { kind: 'engine_error' };

export type InboxType = 'approval' | 'question';
export type InboxState = 'pending' | 'answered' | 'withdrawn';
export type InboxEvidence = { label: string; value: string; pin?: string };
export type InboxOption = { id: string; label: string };

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
};

export type InboxAnswer = { action: 'approve' | 'reject' } | { action: 'request_changes'; comment: string } | { option: string } | { text: string };

export type InboxRow = Omit<NewInboxItem, 'milestone'> & {
  id: number;
  milestone: number | null;
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

export function assertValidAnswer(item: Pick<InboxRow, 'id' | 'type' | 'options'>, answer: InboxAnswer): void {
  if (item.type === 'approval') {
    if (!('action' in answer) || !['approve', 'reject', 'request_changes'].includes(answer.action)) throw new InvalidAnswer(`Inbox item ${item.id} is an approval: approve, reject or request changes`);
    if (answer.action === 'request_changes' && isBlank(answer.comment)) throw new InvalidAnswer('Request changes needs a comment');
    return;
  }
  if ('option' in answer) {
    if (!item.options.some(({ id }) => id === answer.option)) throw new InvalidAnswer(`Inbox item ${item.id} does not offer ${String(answer.option)}`);
    return;
  }
  if (!('text' in answer)) throw new InvalidAnswer(`Inbox item ${item.id} is a question: pick an option or write an answer`);
  if (isBlank(answer.text)) throw new InvalidAnswer('A written answer cannot be blank');
}
