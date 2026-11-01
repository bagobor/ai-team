import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';

export const ARTIFACT_TYPES = [
  'brief',
  'roadmap',
  'team_proposal',
  'human_requirements',
  'environment_profile',
  'spec',
  'tech_design',
  'test_plan',
  'ticket',
  'bug',
  'change_report',
  'review_report',
  'qa_report',
  'milestone_review',
  'change_request',
  'decision_record',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

const ARTIFACT_STATUSES = ['draft', 'proposed', 'approved', 'superseded', 'stale'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export class ArtifactError extends Error {
  override name = 'ArtifactError';
}

// Artifact ids become file names, so they follow the same shape as ticket ids.
export const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type Pin = { id: string; version?: number; section?: string };

const PIN = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:@([1-9][0-9]{0,8}))?(?:#([a-z0-9][a-z0-9-]*))?$/;

export function parsePin(text: string): Pin {
  const match = PIN.exec(text);
  if (!match) throw new ArtifactError(`${JSON.stringify(text)} is not a valid artifact pin`);
  const [, id, version, section] = match;
  return { id: id as string, ...(version ? { version: Number(version) } : {}), ...(section ? { section } : {}) };
}

export function formatPin(pin: Pin): string {
  return `${pin.id}${pin.version === undefined ? '' : `@${pin.version}`}${pin.section === undefined ? '' : `#${pin.section}`}`;
}

export type ArtifactDoc = {
  id: string;
  type: ArtifactType;
  version: number;
  status: ArtifactStatus;
  ownerRole: string;
  derivedFrom: string[];
  acceptanceCriteria: string[];
  approvedBy: string | null;
  approvedAt: string | null;
  fields: Record<string, unknown>;
  body: string;
};

const RESERVED_KEYS = ['id', 'type', 'version', 'status', 'owner_role', 'derived_from', 'acceptance_criteria', 'approved_by', 'approved_at'];

// The front matter comes only from the serializer, which indents every line of a multi-line value. So the
// first bare --- is always the engine's own, and nothing in a field or a body can move it.
export function renderArtifact(doc: ArtifactDoc): string {
  const reserved = Object.keys(doc.fields).find((key) => RESERVED_KEYS.includes(key));
  if (reserved) throw new ArtifactError(`Artifact ${doc.id}: the field ${reserved} is reserved for the engine`);

  const front = stringify(
    {
      id: doc.id,
      type: doc.type,
      version: doc.version,
      status: doc.status,
      owner_role: doc.ownerRole,
      derived_from: doc.derivedFrom,
      acceptance_criteria: doc.acceptanceCriteria,
      approved_by: doc.approvedBy,
      approved_at: doc.approvedAt,
      ...doc.fields,
    },
    { lineWidth: 0, aliasDuplicateObjects: false },
  );
  return `---\n${front}---\n${doc.body}`;
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function parseArtifact(markdown: string): ArtifactDoc {
  const end = markdown.startsWith('---\n') ? markdown.indexOf('\n---\n', 3) : -1;
  if (end === -1) throw new ArtifactError('An artifact needs front matter between two --- lines');

  let parsed: unknown;
  try {
    parsed = parse(markdown.slice(4, end + 1));
  } catch (cause) {
    throw new ArtifactError('The artifact front matter is not valid YAML', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ArtifactError('The artifact front matter must be a mapping of fields');

  const { id, type, version, status, owner_role, derived_from, acceptance_criteria, approved_by, approved_at, ...fields } = parsed as Record<string, unknown>;

  if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) throw new ArtifactError('Artifact field id is not a valid id');
  if (!ARTIFACT_TYPES.includes(type as ArtifactType)) throw new ArtifactError(`Artifact ${id}: unknown type ${String(type)}`);
  if (!ARTIFACT_STATUSES.includes(status as ArtifactStatus)) throw new ArtifactError(`Artifact ${id}: unknown status ${String(status)}`);
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new ArtifactError(`Artifact ${id}: version must be a positive whole number`);
  if (typeof owner_role !== 'string') throw new ArtifactError(`Artifact ${id}: owner_role must be a string`);
  if (!isStringList(derived_from)) throw new ArtifactError(`Artifact ${id}: derived_from must be a list of pins`);
  if (!isStringList(acceptance_criteria)) throw new ArtifactError(`Artifact ${id}: acceptance_criteria must be a list of ids`);

  return {
    id,
    type: type as ArtifactType,
    version,
    status: status as ArtifactStatus,
    ownerRole: owner_role,
    derivedFrom: derived_from,
    acceptanceCriteria: acceptance_criteria,
    approvedBy: typeof approved_by === 'string' ? approved_by : null,
    approvedAt: typeof approved_at === 'string' ? approved_at : null,
    fields,
    body: markdown.slice(end + 5),
  };
}

export type Section = { slug: string; title: string; level: number; text: string; hash: string };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function closesFence(line: string, fence: string): boolean {
  const text = line.trim();
  return text.length >= fence.length && [...text].every((char) => char === fence[0]);
}

function slugFor(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

function locateSections(lines: string[]): { slug: string; title: string; level: number; line: number; end: number }[] {
  const headings: { line: number; level: number; title: string }[] = [];

  let fence: string | undefined;
  lines.forEach((raw, line) => {
    const text = raw.replace(/\r$/, '');
    if (fence) {
      if (closesFence(text, fence)) fence = undefined;
      return;
    }
    const open = FENCE.exec(text);
    if (open) {
      fence = open[1];
      return;
    }
    const heading = HEADING.exec(text);
    if (heading) headings.push({ line, level: (heading[1] as string).length, title: heading[2] ?? '' });
  });

  const taken = new Set<string>();
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((other) => other.level <= heading.level);
    return { ...heading, slug: slugFor(heading.title, taken), end: next ? next.line : lines.length };
  });
}

export function sectionsOf(body: string): Section[] {
  const lines = body.split('\n');
  return locateSections(lines).map(({ slug, title, level, line, end }) => {
    const text = lines.slice(line, end).join('\n') + (end < lines.length ? '\n' : '');
    return { slug, title, level, text, hash: createHash('sha256').update(text.trim()).digest('hex') };
  });
}

// Keeps the heading and everything outside the section. It goes by line, so two identical sections can't be confused.
export function replaceSection(body: string, slug: string, text: string): string | undefined {
  const lines = body.split('\n');
  const found = locateSections(lines).find((section) => section.slug === slug);
  if (!found) return undefined;
  return [...lines.slice(0, found.line + 1), '', text.trim(), '', ...lines.slice(found.end)].join('\n');
}

export function sectionText(body: string, slug: string): string | undefined {
  return sectionsOf(body).find((section) => section.slug === slug)?.text;
}
