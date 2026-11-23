import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Store } from '../engine/store.ts';
import { git } from '../git/git.ts';
import { MEMORY_KINDS, parseEntries, playbookSection, renderEntries, titleOf, type Entry, type EntryPrefix, type MemoryKind } from '../knowledge/entries.ts';
import { memoryPaths, playbookPath } from '../knowledge/load.ts';
import { estimateTokens } from '../manifest/tokens.ts';
import { stateRepoDir, type Paths } from '../paths.ts';
import { CHARTER_TOKEN_LIMIT, loadRole } from '../roles/role.ts';
import { Refused } from './errors.ts';
import type { TrialStore } from './store.ts';
import { KNOWLEDGE_FILES, type DraftRow, type Knowledge, type KnowledgeFile } from './types.ts';

export type DraftDeps = { paths: Paths; store: Store; trials: TrialStore; now?: () => Date };

export type EntryFile = Exclude<KnowledgeFile, 'charter'>;

// One file of a draft beside the live one. path is the live file's place in its repo; text is the draft's when it
// changes the file, else the live one. stale says the live file changed after the draft first changed it.
export type DraftFileView = { file: KnowledgeFile; path: string | null; live: string; text: string; changed: boolean; stale: boolean; diff: string; tokens: number; limit: number | null; entries: Entry[]; problems: string[] };

export type DraftView = DraftRow & { project: string | null; files: DraftFileView[]; changed: boolean; stale: boolean };

export const MAX_ENTRY_WORDS = 100;

const DRAFT_FILE: Record<KnowledgeFile, string> = { charter: 'charter.md', playbook: 'playbook.md', memory_project: 'memory-project.md', memory_role: 'memory-role.md' };
const PREFIX: Record<EntryFile, EntryPrefix> = { playbook: 'PB', memory_project: 'MEM', memory_role: 'MEM' };

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');
const readOr = (path: string, otherwise: string): Promise<string> => readFile(path, 'utf8').catch(() => otherwise);

export const draftDir = (paths: Paths, id: number): string => join(paths.trials, 'drafts', String(id));

// Where a trial keeps what its runs and judges leave: prompts, transcripts and diffs.
export const trialDir = (paths: Paths, id: number): string => join(paths.trials, String(id));

// Where each live file is, as the repo it sits in and its path there. A draft with no project has no memory files.
function liveFile(paths: Paths, roleId: string, project: string | null, file: KnowledgeFile): { repo: string; path: string } | null {
  if (file === 'charter') return { repo: paths.knowledge, path: `roles/${roleId}/charter.md` };
  if (file === 'playbook') return { repo: paths.knowledge, path: playbookPath(roleId) };
  if (project === null) return null;
  return { repo: stateRepoDir(paths, project), path: memoryPaths(roleId)[file === 'memory_project' ? 'project' : 'role'] };
}

// What live tasks of the role read today.
export async function liveKnowledge(paths: Paths, roleId: string, project: string | null): Promise<Knowledge> {
  const texts = await Promise.all(
    KNOWLEDGE_FILES.map(async (file) => {
      const at = liveFile(paths, roleId, project, file);
      return [file, at === null ? '' : await readOr(join(at.repo, at.path), '')] as const;
    }),
  );
  return Object.fromEntries(texts) as Knowledge;
}

async function projectOf({ store }: DraftDeps, draft: DraftRow): Promise<string | null> {
  return draft.project_id === null ? null : ((await store.getProjectById(draft.project_id))?.name ?? null);
}

// What tasks of the role would read with the draft in place: its files where it has them, the live ones elsewhere.
export async function draftKnowledge(deps: DraftDeps, draft: DraftRow): Promise<{ current: Knowledge; draft: Knowledge }> {
  const current = await liveKnowledge(deps.paths, draft.role_id, await projectOf(deps, draft));
  const texts = await Promise.all(KNOWLEDGE_FILES.map(async (file) => [file, await readOr(join(draftDir(deps.paths, draft.id), DRAFT_FILE[file]), current[file])] as const));
  return { current, draft: Object.fromEntries(texts) as Knowledge };
}

// git's own diff of two texts, from its first hunk on, as the pages draw one everywhere else. Each diff has a folder
// of its own, since a draft's files are compared at the same time.
async function diffOf(before: string, after: string): Promise<string> {
  if (before === after) return '';
  const dir = await mkdtemp(join(tmpdir(), 'aiteam-diff-'));
  try {
    await writeFile(join(dir, 'before'), before);
    await writeFile(join(dir, 'after'), after);
    const { stdout } = await git(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', 'before', 'after']);
    const hunk = stdout.indexOf('\n@@');
    return hunk === -1 ? '' : stdout.slice(hunk + 1).trimEnd();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function viewDraft(deps: DraftDeps, draft: DraftRow): Promise<DraftView> {
  const project = await projectOf(deps, draft);
  const { current, draft: texts } = await draftKnowledge(deps, draft);
  const { role } = await loadRole(deps.paths.knowledge, draft.role_id);
  const files = await Promise.all(
    KNOWLEDGE_FILES.map(async (file): Promise<DraftFileView> => {
      const [live, text] = [current[file], texts[file]];
      const parsed = file === 'charter' ? { entries: [], problems: [] } : parseEntries(text, PREFIX[file]);
      const base = draft.base[file];
      return {
        file,
        path: liveFile(deps.paths, draft.role_id, project, file)?.path ?? null,
        live,
        text,
        changed: text !== live,
        stale: base !== undefined && base !== hashOf(live),
        diff: await diffOf(live, text),
        tokens: estimateTokens(file === 'charter' ? text : file === 'playbook' ? playbookSection(parsed.entries) : text),
        limit: file === 'charter' ? CHARTER_TOKEN_LIMIT : file === 'playbook' ? role.defaults.budgets.playbook_tokens : null,
        ...parsed,
      };
    }),
  );
  return { ...draft, project, files, changed: files.some(({ changed }) => changed), stale: files.some(({ stale }) => stale) };
}

// A fingerprint of what a draft holds, so a trial can say which draft it tried.
export const knowledgeHash = (knowledge: Knowledge): string => hashOf(JSON.stringify(KNOWLEDGE_FILES.map((file) => knowledge[file])));

export async function startDraft(deps: DraftDeps, roleId: string, title: string): Promise<DraftRow> {
  await loadRole(deps.paths.knowledge, roleId).catch((cause: Error) => {
    throw new Refused(cause.message, 404);
  });
  if (title.trim() === '') throw new Refused('A draft needs a title that says what it changes');
  const open = await deps.trials.openDraft(roleId);
  if (open) throw new Refused(`${roleId} already has an open draft, "${open.title}". Commit or discard it first.`, 409);
  return deps.trials.createDraft({ role_id: roleId, title: title.trim() });
}

async function open(deps: DraftDeps, id: number): Promise<DraftRow> {
  const draft = await deps.trials.getDraft(id);
  if (!draft) throw new Refused(`There is no draft ${id}`, 404);
  if (draft.state !== 'open') throw new Refused(`Draft ${id} was ${draft.state}, and can no longer be changed`, 409);
  return draft;
}

// The first change to a file notes what the live one was, which is how a later change underneath the draft shows.
async function save(deps: DraftDeps, draft: DraftRow, file: KnowledgeFile, live: string, text: string, patch: { project_id?: number } = {}): Promise<DraftRow> {
  const path = join(draftDir(deps.paths, draft.id), DRAFT_FILE[file]);
  await mkdir(dirname(path), { recursive: true });
  if (text === live) await rm(path, { force: true });
  else await writeFile(path, text);
  const { [file]: noted, ...others } = draft.base;
  const base = text === live ? others : { ...others, [file]: noted ?? hashOf(live) };
  return deps.trials.patchDraft(draft.id, { base, ...patch });
}

export async function setCharter(deps: DraftDeps, id: number, text: string): Promise<DraftRow> {
  const draft = await open(deps, id);
  const charter = text.endsWith('\n') ? text : `${text}\n`;
  if (charter.trim() === '') throw new Refused('A charter can’t be empty');
  const tokens = estimateTokens(charter);
  if (tokens > CHARTER_TOKEN_LIMIT) throw new Refused(`The charter would be ${tokens} tokens, over the limit of ${CHARTER_TOKEN_LIMIT}`);
  const { current } = await draftKnowledge(deps, draft);
  return save(deps, draft, 'charter', current.charter, charter);
}

export type EntryInput = { text: string; sources?: string[]; kind?: MemoryKind };

function checked(file: EntryFile, { text, sources = [], kind }: EntryInput): Pick<Entry, 'text' | 'sources' | 'kind'> {
  const body = text.trim();
  if (body === '') throw new Refused('An entry needs text');
  const words = body.split(/\s+/).length;
  if (words > MAX_ENTRY_WORDS) throw new Refused(`An entry is a rule or a fact, at most ${MAX_ENTRY_WORDS} words. This one is ${words}.`);
  if (body.split('\n').some((line) => line.startsWith('#'))) throw new Refused('No line of an entry may start with "#"');
  const from = sources.map((source) => source.trim()).filter((source) => source !== '');
  if (from.some((source) => /[,\n]/.test(source))) throw new Refused('A source can’t hold a comma or a line break');
  if (file === 'playbook') {
    if (kind !== undefined) throw new Refused('Only a memory entry has a kind');
    return { text: body, sources: from, kind: null };
  }
  if (kind === undefined || !MEMORY_KINDS.includes(kind)) throw new Refused(`A memory entry’s kind is ${MEMORY_KINDS.slice(0, -1).join(', ')} or ${MEMORY_KINDS.at(-1)}`);
  return { text: body, sources: from, kind };
}

// Every id the file's history ever gave an entry, so one that was removed is never given to another.
async function usedIn(repo: string, path: string, prefix: EntryPrefix): Promise<number[]> {
  const { stdout, code } = await git(repo, ['log', '--format=', '--patch', '--no-color', '--no-ext-diff', '--', path]).catch(() => ({ stdout: '', code: 1 }));
  return code === 0 ? [...stdout.matchAll(new RegExp(`^\\+## ${prefix}-(\\d+)$`, 'gm'))].map((match) => Number(match[1])) : [];
}

type Editing = { draft: DraftRow; live: string; text: string; entries: Entry[]; patch: { project_id?: number } };

// The file as the draft has it, ready to change. Memory is one project's: the first memory entry settles which.
async function editing(deps: DraftDeps, id: number, file: EntryFile, projectName: string | undefined): Promise<Editing> {
  let draft = await open(deps, id);
  const patch: { project_id?: number } = {};
  if (file !== 'playbook') {
    const mine = await projectOf(deps, draft);
    if (projectName === undefined && mine === null) throw new Refused('Say which project’s memory this is');
    if (projectName !== undefined && mine !== null && projectName !== mine) throw new Refused(`This draft already changes the memory of ${mine}. One draft changes one project’s memory.`, 409);
    if (mine === null) {
      const project = await deps.store.getProject(projectName!);
      if (!project) throw new Refused(`There is no project ${projectName}`, 404);
      patch.project_id = project.id;
      draft = { ...draft, project_id: project.id };
    }
  }
  const { current, draft: texts } = await draftKnowledge(deps, draft);
  const { entries, problems } = parseEntries(texts[file], PREFIX[file]);
  if (problems.length > 0) throw new Refused(`Fix the file by hand first: ${problems.join('; ')}`, 409);
  return { draft, live: current[file], text: texts[file], entries, patch };
}

async function write(deps: DraftDeps, file: EntryFile, { draft, live, text, patch }: Editing, entries: Entry[]): Promise<DraftRow> {
  const next = entries.length === 0 && titleOf(text) === null ? '' : renderEntries(titleOf(text), entries);
  if (file === 'playbook') {
    const { role } = await loadRole(deps.paths.knowledge, draft.role_id);
    const tokens = estimateTokens(playbookSection(entries));
    if (tokens > role.defaults.budgets.playbook_tokens) throw new Refused(`The playbook would be ${tokens} tokens, over the limit of ${role.defaults.budgets.playbook_tokens}`);
  }
  // A file a person wrote with other spacing reads the same as what the engine writes, and that is no change.
  const same = parseEntries(live, PREFIX[file]);
  const unchanged = same.problems.length === 0 && JSON.stringify(same.entries.map(({ line: _, ...entry }) => entry)) === JSON.stringify(entries.map(({ line: _, ...entry }) => entry));
  return save(deps, draft, file, live, unchanged ? live : next, patch);
}

// Every memory file a project keeps, whichever role's.
async function memoryTexts(stateDir: string): Promise<string[]> {
  const roles = await readdir(join(stateDir, 'memory', 'roles')).catch(() => []);
  const paths = ['memory/project.md', ...roles.filter((name) => name.endsWith('.md')).map((name) => `memory/roles/${name}`)];
  return Promise.all(paths.map((path) => readOr(join(stateDir, path), '')));
}

export async function addEntry(deps: DraftDeps, id: number, file: EntryFile, input: EntryInput & { project?: string }): Promise<{ draft: DraftRow; entryId: string }> {
  const fields = checked(file, input);
  const at = await editing(deps, id, file, input.project);
  const prefix = PREFIX[file];
  const { paths } = deps;
  const project = await projectOf(deps, at.draft);
  const { draft: texts } = await draftKnowledge(deps, at.draft);
  // A playbook has its own run of ids. A project's memory has one run across all its files, so an entry can be named
  // by its id alone. Either way the history counts, so a removed entry's id is never given to another.
  const [repo, path, live, drafted] =
    file === 'playbook'
      ? [paths.knowledge, playbookPath(at.draft.role_id), [at.live], [texts.playbook]]
      : [stateRepoDir(paths, project!), 'memory', await memoryTexts(stateRepoDir(paths, project!)), [texts.memory_project, texts.memory_role]];
  const inUse = [...live, ...drafted].flatMap((text) => parseEntries(text, prefix).entries.map((entry) => Number(entry.id.slice(prefix.length + 1))));
  const entryId = `${prefix}-${Math.max(0, ...inUse, ...(await usedIn(repo, path, prefix))) + 1}`;
  const added = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const draft = await write(deps, file, at, [...at.entries, { id: entryId, addedBy: 'the stakeholder', added, line: 0, ...fields }]);
  return { draft, entryId };
}

export async function changeEntry(deps: DraftDeps, id: number, file: EntryFile, entryId: string, input: EntryInput): Promise<DraftRow> {
  const at = await editing(deps, id, file, undefined);
  const entry = at.entries.find((one) => one.id === entryId);
  if (!entry) throw new Refused(`${entryId} is not in this file`, 404);
  const fields = checked(file, { text: input.text, sources: input.sources ?? entry.sources, ...(input.kind ?? entry.kind ? { kind: (input.kind ?? entry.kind)! } : {}) });
  return write(deps, file, at, at.entries.map((one) => (one === entry ? { ...one, ...fields } : one)));
}

export async function removeEntry(deps: DraftDeps, id: number, file: EntryFile, entryId: string): Promise<DraftRow> {
  const at = await editing(deps, id, file, undefined);
  if (!at.entries.some((one) => one.id === entryId)) throw new Refused(`${entryId} is not in this file`, 404);
  return write(deps, file, at, at.entries.filter((one) => one.id !== entryId));
}

// The live files changed underneath the draft, and the stakeholder keeps the draft's version: from here on the draft
// is compared with the files as they are now.
export async function keepOverLive(deps: DraftDeps, id: number): Promise<DraftRow> {
  const draft = await open(deps, id);
  const { current } = await draftKnowledge(deps, draft);
  return deps.trials.patchDraft(id, { base: Object.fromEntries(Object.keys(draft.base).map((file) => [file, hashOf(current[file as KnowledgeFile])])) });
}

export async function discardDraft(deps: DraftDeps, id: number): Promise<DraftRow> {
  await open(deps, id);
  await rm(draftDir(deps.paths, id), { recursive: true, force: true });
  return deps.trials.patchDraft(id, { state: 'discarded' });
}
