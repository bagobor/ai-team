import type { Context, Hono } from 'hono';
import type { EngineDeps } from '../engine/runner.ts';
import { MEMORY_KINDS, type MemoryKind } from '../knowledge/entries.ts';
import { addEntry, changeEntry, discardDraft, keepOverLive, removeEntry, setCharter, startDraft, viewDraft, type DraftDeps, type EntryFile, type EntryInput } from '../trials/drafts.ts';
import { Refused } from '../trials/errors.ts';
import { TrialStore } from '../trials/store.ts';
import { TrialRunner } from '../trials/trial.ts';

const ENTRY_FILES: EntryFile[] = ['playbook', 'memory_project', 'memory_role'];

async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Refused('The request body must be a JSON object');
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw new Refused(`${field} must be text`);
  return value;
}

function idOf(c: Context, name = 'n'): number {
  const raw = c.req.param(name) ?? '';
  if (!/^\d{1,15}$/.test(raw)) throw new Refused(`There is no ${raw}`, 404);
  return Number(raw);
}

function entryFile(c: Context): EntryFile {
  const file = c.req.param('file') as EntryFile;
  if (!ENTRY_FILES.includes(file)) throw new Refused(`${file} is not a file with entries`, 404);
  return file;
}

// What an entry is given as, checked for shape only: the draft checks what it says.
function entryInput(body: Record<string, unknown>, needsText: boolean): EntryInput {
  const { sources, kind } = body;
  if (sources !== undefined && !(Array.isArray(sources) && sources.every((source) => typeof source === 'string'))) throw new Refused('sources must be a list of texts');
  if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) throw new Refused(`kind must be ${MEMORY_KINDS.join(', ')}`);
  return { text: needsText || body.text !== undefined ? text(body, 'text') : '', ...(sources === undefined ? {} : { sources: sources as string[] }), ...(kind === undefined ? {} : { kind: kind as MemoryKind }) };
}

// Drafts of a change to what a role knows, and trying them. Each answer is the draft as it now stands.
export function trialRoutes(app: Hono, deps: EngineDeps & { trialRunner?: TrialRunner }): void {
  const trials = new TrialStore(deps.db, deps.now);
  const drafts: DraftDeps = { paths: deps.paths, store: deps.store, trials, ...(deps.now ? { now: deps.now } : {}) };
  const runner = deps.trialRunner ?? new TrialRunner({ ...deps, trials });

  const shown = async (c: Context, id: number) => {
    const draft = await trials.getDraft(id);
    if (!draft) throw new Refused(`There is no draft ${id}`, 404);
    return c.json(await viewDraft(drafts, draft));
  };

  app.get('/api/roles/:id/draft', async (c) => {
    const open = await trials.openDraft(c.req.param('id'));
    return c.json(open ? await viewDraft(drafts, open) : null);
  });

  app.post('/api/roles/:id/draft', async (c) => shown(c, (await startDraft(drafts, c.req.param('id'), text(await bodyOf(c), 'title'))).id));

  app.get('/api/drafts/:n', async (c) => shown(c, idOf(c)));

  app.post('/api/drafts/:n/charter', async (c) => shown(c, (await setCharter(drafts, idOf(c), text(await bodyOf(c), 'text'))).id));

  app.post('/api/drafts/:n/entries/:file', async (c) => {
    const body = await bodyOf(c);
    const project = body.project === undefined ? {} : { project: text(body, 'project') };
    return shown(c, (await addEntry(drafts, idOf(c), entryFile(c), { ...entryInput(body, true), ...project })).draft.id);
  });

  app.post('/api/drafts/:n/entries/:file/:entry', async (c) => shown(c, (await changeEntry(drafts, idOf(c), entryFile(c), c.req.param('entry'), entryInput(await bodyOf(c), true))).id));

  app.post('/api/drafts/:n/entries/:file/:entry/remove', async (c) => shown(c, (await removeEntry(drafts, idOf(c), entryFile(c), c.req.param('entry'))).id));

  app.post('/api/drafts/:n/keep', async (c) => shown(c, (await keepOverLive(drafts, idOf(c))).id));

  app.post('/api/drafts/:n/discard', async (c) => shown(c, (await discardDraft(drafts, idOf(c))).id));
}
