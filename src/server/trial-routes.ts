import type { Context, Hono } from 'hono';
import type { EngineDeps } from '../engine/runner.ts';
import { MEMORY_KINDS, type MemoryKind } from '../knowledge/entries.ts';
import { commitTrial, undoTrial } from '../trials/commit.ts';
import { addEntry, changeEntry, discardDraft, keepOverLive, removeEntry, setCharter, startDraft, viewDraft, type DraftDeps, type EntryFile, type EntryInput } from '../trials/drafts.ts';
import { Refused } from '../trials/errors.ts';
import { pastAttempts, suggestFine } from '../trials/source.ts';
import { TrialStore } from '../trials/store.ts';
import { startTrial, TrialRunner, UNDER_WAY, type TrialDeps } from '../trials/trial.ts';
import { answerTrial, summaryOf, viewTrial } from '../trials/view.ts';

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

// A list the body must hold, of the one kind of thing.
function listOf<T extends 'string' | 'number'>(body: Record<string, unknown>, field: string, kind: T): (T extends 'string' ? string : number)[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((one) => typeof one !== kind || (kind === 'number' && !Number.isSafeInteger(one)))) throw new Refused(`${field} must be a list of ${kind === 'string' ? 'texts' : 'attempt ids'}`);
  return value as (T extends 'string' ? string : number)[];
}

function capOf(body: Record<string, unknown>): { capUsd?: number } {
  if (body.capUsd === undefined) return {};
  if (typeof body.capUsd !== 'number' || !Number.isFinite(body.capUsd)) throw new Refused('capUsd must be a number');
  return { capUsd: body.capUsd };
}

// Drafts of a change to what a role knows, and trying them. Each answer is the draft or the trial as it now stands.
export function trialRoutes(app: Hono, deps: EngineDeps & { trialRunner?: TrialRunner }): void {
  const trials = new TrialStore(deps.db, deps.now);
  const drafts: DraftDeps = { paths: deps.paths, store: deps.store, trials, ...(deps.now ? { now: deps.now } : {}) };
  const trying: TrialDeps = { ...deps, trials };
  const runner = deps.trialRunner ?? new TrialRunner(trying);

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

  // A trial of it that has not ended has nothing left to say, so it is stopped with the draft.
  app.post('/api/drafts/:n/discard', async (c) => {
    const id = idOf(c);
    const discarded = await discardDraft(drafts, id);
    for (const trial of await trials.listTrials({ draftId: id, states: UNDER_WAY })) await runner.stop(trial.id, 'its draft was discarded');
    return shown(c, discarded.id);
  });

  const tried = async (c: Context, id: number) => {
    const trial = await trials.getTrial(id);
    if (!trial) throw new Refused(`There is no trial ${id}`, 404);
    return c.json(await viewTrial(trying, trial));
  };

  // What a trial can be made of: the role's past attempts, and the ones offered as tasks that went fine.
  app.get('/api/roles/:id/attempts', async (c) => {
    const attempts = await pastAttempts(deps, c.req.param('id'), c.req.query('project'));
    return c.json({ attempts, fine: suggestFine(attempts).map(({ attemptId }) => attemptId) });
  });

  app.get('/api/drafts/:n/trials', async (c) => c.json((await trials.listTrials({ draftId: idOf(c) })).map(summaryOf)));

  app.post('/api/drafts/:n/trials', async (c) => {
    const body = await bodyOf(c);
    const trial = await startTrial(trying, idOf(c), { expectations: listOf(body, 'expectations', 'string'), problem: listOf(body, 'problem', 'number'), fine: listOf(body, 'fine', 'number'), ...capOf(body) });
    return tried(c, trial.id);
  });

  app.get('/api/trials/:n', async (c) => tried(c, idOf(c)));

  app.post('/api/trials/:n/stop', async (c) => tried(c, (await runner.stop(idOf(c))).id));

  app.post('/api/trials/:n/resume', async (c) => tried(c, (await runner.resume(idOf(c), capOf(await bodyOf(c)).capUsd)).id));

  app.post('/api/trials/:n/answer', async (c) => {
    const { choices } = await bodyOf(c);
    if (typeof choices !== 'object' || choices === null || Object.values(choices).some((choice) => typeof choice !== 'string')) throw new Refused('choices must give, for each attempt id, the letter of the better result or "same"');
    return tried(c, (await answerTrial(trying, idOf(c), choices as Record<string, string>)).id);
  });

  app.post('/api/trials/:n/commit', async (c) => tried(c, (await commitTrial(trying, idOf(c))).id));

  app.post('/api/trials/:n/undo', async (c) => tried(c, (await undoTrial(trying, idOf(c))).id));
}
