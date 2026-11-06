import type { CheckMark, InboxCheck, InboxRef, InboxRow, InboxType } from '../../../src/engine/inbox.ts';

export type InboxItem = InboxRow & { project: string; ageS: number };
export type InboxGroup = { type: InboxType; label: string; items: InboxItem[] };

const GROUPS: { type: InboxType; label: string }[] = [
  { type: 'approval', label: 'Approvals' },
  { type: 'question', label: 'Questions' },
];

export function groupInbox(items: InboxItem[]): InboxGroup[] {
  return GROUPS.map((group) => ({ ...group, items: items.filter(({ type }) => type === group.type) })).filter((group) => group.items.length > 0);
}

export function ageLabel(seconds: number): string {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

export function newPendingIds(prev: number[], next: number[]): number[] {
  const seen = new Set(prev);
  return next.filter((id) => !seen.has(id));
}

export function inboxLabel({ id, ref }: { id: number; ref: InboxRef }): string {
  if (ref.kind === 'cp1') return 'CP1';
  if (ref.kind === 'cp2' || ref.kind === 'cp4') return `${ref.kind.toUpperCase()}-M${ref.milestone}`;
  if (ref.kind === 'cr') return ref.cr;
  return `Q-${id}`;
}

export const projectPath = (project: string, page: 'inbox' | 'board' | 'documents') => `/projects/${encodeURIComponent(project)}/${page}`;

export const documentLink = (project: string, pin: string) => `${projectPath(project, 'documents')}#${encodeURIComponent(pin)}`;

export type DocumentPin = { id: string; version: number | null };

// A pin is SPEC-M1, SPEC-M1@2 or SPEC-M1@2#scope. This page shows whole documents, so the section isn't kept.
export function pinParts(pin: string): DocumentPin | null {
  const match = /^([A-Za-z0-9][\w.-]*)(?:@(\d+))?(?:#.*)?$/.exec(pin);
  return match?.[1] ? { id: match[1], version: match[2] === undefined ? null : Number(match[2]) } : null;
}

export function documentPin(hash: string): DocumentPin | null {
  try {
    return pinParts(decodeURIComponent(hash.replace(/^#/, '')));
  } catch {
    return null;
  }
}

// A mark starts without a status: the stakeholder can type a note before choosing, and that isn't a verdict yet.
export type Marks = Record<string, { status?: 'passing' | 'failing'; note: string }>;

const noteOf = (marks: Marks, ac: string) => marks[ac]?.note.trim() ?? '';
const failed = (checks: InboxCheck[], marks: Marks) => checks.filter(({ ac }) => marks[ac]?.status === 'failing');

// The server only takes a verdict on a check, in the order the item lists them.
export function checkMarks(checks: InboxCheck[], marks: Marks): CheckMark[] {
  return checks.flatMap(({ ac }) => {
    const status = marks[ac]?.status;
    return status === undefined ? [] : [{ ac, status, note: noteOf(marks, ac) }];
  });
}

// Approving would put a check nobody has judged, or one that failed, into the milestone as passing.
export function canApprove(checks: InboxCheck[], marks: Marks): boolean {
  return checks.every(({ ac }) => marks[ac]?.status === 'passing');
}

// The server refuses a failing mark without a note, so the page holds the request back until each one says what was wrong.
export function canRequestChanges(checks: InboxCheck[], marks: Marks): boolean {
  return failed(checks, marks).every(({ ac }) => noteOf(marks, ac) !== '');
}

// The engine lists the failed checks from the marks as well. This gives the stakeholder their words to edit rather than an empty box.
export function failedChecksComment(checks: InboxCheck[], marks: Marks): string {
  const lines = failed(checks, marks).map(({ ac, text }) => (noteOf(marks, ac) === '' ? `- ${ac} (${text})` : `- ${ac} (${text}): ${noteOf(marks, ac)}`));
  return lines.length === 0 ? '' : ['Failed checks:', ...lines].join('\n');
}
