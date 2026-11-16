import type { Entry } from '../../../src/knowledge/entries.ts';
import type { CharterLine, Lesson, LessonFile } from '../../../src/roles/provenance.ts';

// Names and wording for a role's provenance: which commit wrote each charter line, and what each change taught.

const ROLE_NAME: Record<string, string> = {
  pm: 'Product Manager',
  tech_lead: 'Tech Lead',
  eng_lead: 'Eng Lead',
  qa_engineer: 'QA Engineer',
  engineer: 'Engineer',
  code_reviewer: 'Code Reviewer',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A specialty such as engineer.watchos reads as Engineer watchos.
export const roleName = (id: string) => ROLE_NAME[id] ?? id.replace(/[._-]+/g, ' ').replace(/^./, (first) => first.toUpperCase());

export const rolePath = (id: string) => `/roles/${encodeURIComponent(id)}`;

// What no commit has yet shares one key, so its lines and its lesson select each other like a commit's do.
export const UNCOMMITTED = 'uncommitted';

export const changeKey = ({ sha }: { sha: string | null }) => sha ?? UNCOMMITTED;

export const shortSha = (sha: string) => sha.slice(0, 7);

export function day(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// An entry's date is a day with no time, so it is read as written: a Date would move it a day back west of Greenwich.
export function entryByline({ addedBy, added }: Pick<Entry, 'addedBy' | 'added'>): string {
  const [year, month, date] = added.split('-').map(Number);
  return `Added by ${addedBy} on ${date} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

const SOURCE: Record<Lesson['source'], string> = { seed: 'AI Team seed', knowledge: 'knowledge repo', uncommitted: 'not committed' };

export const sourceLabel = (source: Lesson['source']) => SOURCE[source];

// A schema is named by its file: several roles can share one, and the kind alone wouldn't say which.
export const fileLabel = ({ kind, path }: Pick<LessonFile, 'kind' | 'path'>) => (kind === 'schema' || kind === 'other' ? (path.split('/').pop() ?? path) : kind);

export type CharterRow = CharterLine & { key: string; first: boolean; look: '' | 'hit' | 'dim'; ink: number | null };

const OLDEST_INK = 25;
const NEWEST_INK = 90;

// Each line with what the page draws beside it: the gutter names a commit on the first line of each run of lines it wrote,
// a selected change lights its own lines and dims the rest, and the age bar is darker the newer the line.
export function charterRows(lines: CharterLine[], selected: string | null): CharterRow[] {
  const times = lines.flatMap(({ date }) => (date === null ? [] : [Date.parse(date)]));
  const oldest = Math.min(...times);
  const span = Math.max(...times) - oldest;
  return lines.map((line, i) => {
    const key = changeKey(line);
    const ink = line.date === null ? null : Math.round(OLDEST_INK + (span > 0 ? ((NEWEST_INK - OLDEST_INK) * (Date.parse(line.date) - oldest)) / span : NEWEST_INK - OLDEST_INK));
    const look = selected === null ? '' : selected === key ? 'hit' : 'dim';
    return { ...line, key, first: i === 0 || key !== changeKey(lines[i - 1] ?? line), look, ink };
  });
}

export const linesFrom = (lines: CharterLine[], key: string) => lines.filter((line) => changeKey(line) === key).length;

// A commit message is wrapped for a terminal. An indented line, or one that goes on in lower case, carries on the line before,
// so the page joins them and wraps the text to its own width; list items and blank lines stay where they are.
export function unwrap(body: string): string {
  return body.split('\n').reduce<string[]>((out, line) => {
    const last = out.at(-1);
    if (last !== undefined && last.trim() !== '' && /^(\s+\S|[a-z(])/.test(line)) out[out.length - 1] = `${last} ${line.trim()}`;
    else out.push(line);
    return out;
  }, []).join('\n');
}
