import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { parse } from 'yaml';
import { git } from '../git/git.ts';
import { estimateTokens } from '../manifest/tokens.ts';
import { CHARTER_TOKEN_LIMIT, ROLE_ID, type Budgets } from './role.ts';

// Where a role's words come from: the seed shipped with AI Team, and the knowledge repo people curate.
export type ProvenanceDirs = { knowledge: string; seed: string | null };

export type Source = 'seed' | 'knowledge';

// A null sha is a line nobody has committed yet.
export type CharterLine = { text: string; sha: string | null; source: Source | null; date: string | null; subject: string | null };

export type LessonFile = { path: string; kind: 'charter' | 'config' | 'schema' | 'other'; add: number; del: number; diff: string; clipped: boolean; untracked: boolean };

export type Lesson = { sha: string | null; source: Source | 'uncommitted'; date: string | null; author: string | null; subject: string; body: string; files: LessonFile[] };

export type RoleFacts = { department: string | null; mission: string | null; model: string | null; budgets: Budgets | null; produces: string[] };

export type RoleProvenance = RoleFacts & { id: string; charterTokens: number; charterTokenLimit: number; lines: CharterLine[]; lessons: Lesson[]; error: string | null };

export type RoleSummary = RoleFacts & { id: string; charterTokens: number; charterTokenLimit: number; lessons: number; lastLesson: string | null; uncommitted: boolean; error: string | null };

const MAX_DIFF_LINES = 260;
const ZERO_SHA = /^0{40}$/;
const RECORD = '\x1e';
const FIELD = '\x1f';
const LOG_FORMAT = `--format=${RECORD}%H${FIELD}%aI${FIELD}%an${FIELD}%s${FIELD}%b${FIELD}`;

// A path from role.yaml is text someone wrote: read literally, and never outside the repo.
const LITERAL = '--literal-pathspecs';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function budgetsOf(value: unknown): Budgets | null {
  if (!isRecord(value)) return null;
  const keys = ['max_turns', 'max_usd', 'context_tokens', 'playbook_tokens', 'memory_tokens'] as const;
  return keys.every((key) => typeof value[key] === 'number') ? (value as Budgets) : null;
}

// Loose on purpose: a role.yaml the engine would refuse still has a history worth reading.
function readFacts(yamlText: string | null): { facts: RoleFacts; schemas: string[]; error: string | null } {
  const empty: RoleFacts = { department: null, mission: null, model: null, budgets: null, produces: [] };
  if (yamlText === null) return { facts: empty, schemas: [], error: 'role.yaml is missing' };
  let parsed: unknown;
  try {
    parsed = parse(yamlText);
  } catch {
    return { facts: empty, schemas: [], error: 'role.yaml is not valid YAML' };
  }
  if (!isRecord(parsed)) return { facts: empty, schemas: [], error: 'role.yaml is not a mapping' };
  const defaults = isRecord(parsed.defaults) ? parsed.defaults : {};
  const produces = Array.isArray(parsed.produces) ? parsed.produces.filter((item): item is string => typeof item === 'string') : [];
  const named = [parsed.output_schema, ...(isRecord(parsed.output_schemas) ? Object.values(parsed.output_schemas) : [])];
  const schemas = named.flatMap((source) => {
    if (typeof source !== 'string' || isAbsolute(source)) return [];
    const path = posix.normalize(source);
    return path.startsWith('..') ? [] : [path];
  });
  return {
    facts: { department: text(parsed.department), mission: text(parsed.mission), model: text(defaults.model), budgets: budgetsOf(defaults.budgets), produces },
    schemas: [...new Set(schemas)],
    error: null,
  };
}

const readOrNull = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null);

function kindOf(path: string): LessonFile['kind'] {
  if (path.endsWith('/charter.md')) return 'charter';
  if (path.endsWith('/role.yaml')) return 'config';
  if (path.startsWith('schemas/')) return 'schema';
  return 'other';
}

function lessonFile(path: string, body: string[], untracked = false): LessonFile {
  const add = body.filter((line) => line.startsWith('+')).length;
  const del = body.filter((line) => line.startsWith('-')).length;
  return { path, kind: kindOf(path), add, del, diff: body.slice(0, MAX_DIFF_LINES).join('\n'), clipped: body.length > MAX_DIFF_LINES, untracked };
}

// git's patch for one commit, one file at a time. Each file's diff starts at its first hunk, after git's own headers.
function splitPatch(patch: string): LessonFile[] {
  return patch
    .split(/^diff --git /m)
    .slice(1)
    .flatMap((chunk) => {
      const lines = chunk.replace(/\n+$/, '').split('\n');
      const path = /^a\/.* b\/(.*)$/.exec(lines[0] ?? '')?.[1];
      if (path === undefined) return [];
      const hunk = lines.findIndex((line) => line.startsWith('@@'));
      return [lessonFile(path, hunk === -1 ? [] : lines.slice(hunk))];
    });
}

async function isRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const { stdout, code } = await git(dir, ['rev-parse', '--is-inside-work-tree']).catch(() => ({ stdout: '', code: 1 }));
  return code === 0 && stdout.trim() === 'true';
}

// --relative keeps the seed's paths as they are in the knowledge repo, however deep the seed sits in its own repo.
async function commitsOf(repo: string, source: Source, paths: string[], patch: boolean): Promise<Lesson[]> {
  const { stdout, code } = await git(repo, [LITERAL, 'log', ...(patch ? ['--patch', '--no-color', '--no-ext-diff'] : []), '--relative', LOG_FORMAT, '--', ...paths]);
  if (code !== 0) return [];
  return stdout
    .split(RECORD)
    .slice(1)
    .flatMap((record) => {
      const [sha = '', date = '', author = '', subject = '', body = '', rest = ''] = record.split(FIELD);
      // In UTC, so dates from people in different time zones sort as text.
      return /^[0-9a-f]{40}$/.test(sha) ? [{ sha, source, date: new Date(date).toISOString(), author, subject, body: body.trim(), files: patch ? splitPatch(rest) : [] }] : [];
    });
}

// What the knowledge repo holds for the role that no commit has: edits, and files git has never seen.
async function uncommitted(knowledge: string, paths: string[]): Promise<Lesson | null> {
  const diff = await git(knowledge, [LITERAL, 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', ...paths]);
  const untracked = await git(knowledge, [LITERAL, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]);
  const files = diff.code === 0 ? splitPatch(diff.stdout) : [];
  if (untracked.code === 0) {
    for (const path of untracked.stdout.split('\0').filter(Boolean).sort()) {
      const content = await readOrNull(join(knowledge, path));
      if (content === null) continue;
      const lines = content.replace(/\n$/, '').split('\n');
      files.push(lessonFile(path, ['@@ new file @@', ...lines.map((line) => `+${line}`)], true));
    }
  }
  return files.length === 0 ? null : { sha: null, source: 'uncommitted', date: null, author: null, subject: 'Not committed yet', body: '', files };
}

type Blamed = { sha: string; date: string | null; subject: string | null };

// One entry per line of the given text, or null when git can't say: the file is new there, or the counts disagree.
async function blame(repo: string, path: string, contents: string | null, count: number): Promise<Blamed[] | null> {
  const args = [LITERAL, 'blame', '--line-porcelain', ...(contents === null ? [] : ['--contents', contents]), '--', path];
  const { stdout, code } = await git(repo, args);
  if (code !== 0) return null;
  const lines: Blamed[] = [];
  let current: Blamed | null = null;
  for (const line of stdout.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (head?.[1] !== undefined) current = { sha: head[1], date: null, subject: null };
    else if (current === null) continue;
    else if (line.startsWith('author-time ')) current.date = new Date(Number(line.slice('author-time '.length)) * 1000).toISOString();
    else if (line.startsWith('summary ')) current.subject = line.slice('summary '.length);
    else if (line.startsWith('\t')) {
      lines.push(current);
      current = null;
    }
  }
  return lines.length === count ? lines : null;
}

const committed = (entry: Blamed | undefined): entry is Blamed => entry !== undefined && !ZERO_SHA.test(entry.sha);

// A line the seed still has is the seed's lesson, even after the knowledge repo copied it. What the seed lacks, the knowledge repo's history explains.
async function attribute(dirs: ProvenanceDirs, seeded: boolean, id: string, charter: string): Promise<CharterLine[]> {
  const texts = charter.replace(/\n$/, '').split('\n');
  const path = `roles/${id}/charter.md`;
  const fromSeed = seeded && dirs.seed !== null ? await blame(dirs.seed, path, join(dirs.knowledge, path), texts.length) : null;
  const fromKnowledge = await blame(dirs.knowledge, path, null, texts.length);
  return texts.map((text, i): CharterLine => {
    const seed = fromSeed?.[i];
    if (committed(seed)) return { text, ...seed, source: 'seed' };
    const knowledge = fromKnowledge?.[i];
    if (committed(knowledge)) return { text, ...knowledge, source: 'knowledge' };
    return { text, sha: null, source: null, date: null, subject: null };
  });
}

function roleDir(dirs: ProvenanceDirs, id: string): string | null {
  if (!ROLE_ID.test(id)) return null;
  const dir = join(dirs.knowledge, 'roles', id);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

async function history(dirs: ProvenanceDirs, id: string, schemas: string[], patch: boolean): Promise<{ lessons: Lesson[]; seeded: boolean }> {
  const paths = [`roles/${id}`, ...schemas];
  const seeded = dirs.seed !== null && (await isRepo(dirs.seed));
  const commits = [...(await commitsOf(dirs.knowledge, 'knowledge', paths, patch)), ...(seeded && dirs.seed !== null ? await commitsOf(dirs.seed, 'seed', paths, patch) : [])];
  commits.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const pending = await uncommitted(dirs.knowledge, paths);
  return { lessons: pending === null ? commits : [pending, ...commits], seeded };
}

export async function roleProvenance(dirs: ProvenanceDirs, id: string): Promise<RoleProvenance | null> {
  const dir = roleDir(dirs, id);
  if (dir === null) return null;
  const { facts, schemas, error } = readFacts(await readOrNull(join(dir, 'role.yaml')));
  const charter = (await readOrNull(join(dir, 'charter.md'))) ?? '';
  const { lessons, seeded } = await history(dirs, id, schemas, true);
  const lines = charter === '' ? [] : await attribute(dirs, seeded, id, charter);
  return { id, ...facts, charterTokens: estimateTokens(charter), charterTokenLimit: CHARTER_TOKEN_LIMIT, lines, lessons, error };
}

export async function listRoles(dirs: ProvenanceDirs): Promise<RoleSummary[]> {
  const entries = await readdir(join(dirs.knowledge, 'roles'), { withFileTypes: true }).catch(() => []);
  const ids = entries.filter((entry) => entry.isDirectory() && ROLE_ID.test(entry.name)).map((entry) => entry.name).sort();
  return Promise.all(
    ids.map(async (id) => {
      const dir = join(dirs.knowledge, 'roles', id);
      const { facts, schemas, error } = readFacts(await readOrNull(join(dir, 'role.yaml')));
      const charter = (await readOrNull(join(dir, 'charter.md'))) ?? '';
      const { lessons } = await history(dirs, id, schemas, false);
      const commits = lessons.filter((lesson) => lesson.sha !== null);
      return {
        id,
        ...facts,
        charterTokens: estimateTokens(charter),
        charterTokenLimit: CHARTER_TOKEN_LIMIT,
        lessons: commits.length,
        lastLesson: commits[0]?.date ?? null,
        uncommitted: lessons.length > commits.length,
        error,
      };
    }),
  );
}
