import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { manifestDir, stateRepoDir } from '../src/paths.ts';
import { addEntry, changeEntry, discardDraft, draftDir, draftKnowledge, keepOverLive, knowledgeHash, removeEntry, setCharter, startDraft, viewDraft, type DraftDeps } from '../src/trials/drafts.ts';
import { TrialStore } from '../src/trials/store.ts';
import { makeEngine, okStep, runOnce, ticket, type TestEngine } from './helpers/engine.ts';
import { commitAll } from './helpers/repo.ts';

describe('a draft of a change to what a role knows', () => {
  let e: TestEngine;
  let deps: DraftDeps;

  beforeEach(async () => {
    e = await makeEngine({ steps: [okStep({ 'src/a.mjs': '' })] });
    deps = { paths: e.paths, store: e.store, trials: new TrialStore(e.db), now: () => new Date('2026-11-22T10:00:00Z') };
  });

  afterEach(() => e.cleanup());

  const roleFile = (name: string) => join(e.paths.knowledge, 'roles', 'engineer', name);
  const memoryFile = (name: string) => join(stateRepoDir(e.paths, 'p'), 'memory', name);
  const start = async () => (await startDraft(deps, 'engineer', 'Run the checks first')).id;
  const view = async (id: number) => viewDraft(deps, (await deps.trials.getDraft(id))!);
  const fileOf = async (id: number, file: string) => (await view(id)).files.find((one) => one.file === file)!;

  it('starts for a role that exists, one at a time', async () => {
    const id = await start();

    expect(await view(id)).toMatchObject({ role_id: 'engineer', title: 'Run the checks first', state: 'open', project: null, changed: false, stale: false });
    await expect(startDraft(deps, 'engineer', 'Another')).rejects.toMatchObject({ status: 409, message: 'engineer already has an open draft, "Run the checks first". Commit or discard it first.' });
    await expect(startDraft(deps, 'nobody', 'x')).rejects.toMatchObject({ status: 404 });
    await expect(startDraft(deps, 'pm', '  ')).rejects.toThrow('A draft needs a title');
  });

  it('adds playbook entries under ids the engine gives, and shows the file beside the live one', async () => {
    const id = await start();

    const first = await addEntry(deps, id, 'playbook', { text: 'Run every check before you report.', sources: ['M1-T-4 attempt 2'] });
    const second = await addEntry(deps, id, 'playbook', { text: 'Pass file patterns to `node --test`.' });

    expect([first.entryId, second.entryId]).toEqual(['PB-1', 'PB-2']);
    const playbook = await fileOf(id, 'playbook');
    expect(playbook).toMatchObject({ path: 'roles/engineer/playbook.md', live: '', changed: true, stale: false, limit: 2000, problems: [] });
    expect(playbook.text).toBe('## PB-1\nAdded by: the stakeholder\nAdded: 2026-11-22\nSources: M1-T-4 attempt 2\n\nRun every check before you report.\n\n## PB-2\nAdded by: the stakeholder\nAdded: 2026-11-22\n\nPass file patterns to `node --test`.\n');
    expect(playbook.diff).toMatch(/^@@ .*\n\+## PB-1\n/);
    expect(playbook.tokens).toBeGreaterThan(0);
    expect(existsSync(roleFile('playbook.md'))).toBe(false);
  });

  it('never gives a new entry an id the file’s history has used', async () => {
    writeFileSync(roleFile('playbook.md'), '# Engineer playbook\n\n## PB-7\nAdded by: the stakeholder\nAdded: 2026-11-01\n\nAn old rule.\n');
    commitAll(e.paths.knowledge, 'engineer: a rule');
    writeFileSync(roleFile('playbook.md'), '# Engineer playbook\n');
    commitAll(e.paths.knowledge, 'engineer: drop the rule');
    const id = await start();

    expect((await addEntry(deps, id, 'playbook', { text: 'A new rule.' })).entryId).toBe('PB-8');
    expect((await fileOf(id, 'playbook')).text).toBe('# Engineer playbook\n\n## PB-8\nAdded by: the stakeholder\nAdded: 2026-11-22\n\nA new rule.\n');
  });

  it('changes and removes an entry, and a draft that ends where it began changes nothing', async () => {
    writeFileSync(roleFile('playbook.md'), '## PB-1\nAdded by: the stakeholder\nAdded: 2026-11-01\nSources: DEC-1@1\n\nAn old rule.\n');
    const id = await start();

    await changeEntry(deps, id, 'playbook', 'PB-1', { text: 'A sharper rule.' });
    expect((await fileOf(id, 'playbook')).entries).toMatchObject([{ id: 'PB-1', text: 'A sharper rule.', sources: ['DEC-1@1'], added: '2026-11-01' }]);

    await changeEntry(deps, id, 'playbook', 'PB-1', { text: 'An old rule.' });
    expect(await view(id)).toMatchObject({ changed: false, base: {} });

    await removeEntry(deps, id, 'playbook', 'PB-1');
    expect(await fileOf(id, 'playbook')).toMatchObject({ text: '', changed: true, entries: [] });
    await expect(removeEntry(deps, id, 'playbook', 'PB-1')).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['no text', { text: '  ' }, 'An entry needs text'],
    ['over 100 words', { text: 'word '.repeat(101) }, 'An entry is a rule or a fact, at most 100 words. This one is 101.'],
    ['a heading in it', { text: 'First.\n## PB-9\nSecond.' }, 'No line of an entry may start with "#"'],
    ['a source with a comma', { text: 'Fine.', sources: ['a, b'] }, 'A source can’t hold a comma or a line break'],
    ['a kind, in a playbook', { text: 'Fine.', kind: 'lesson' as const }, 'Only a memory entry has a kind'],
  ])('refuses an entry with %s', async (_what, input, message) => {
    await expect(addEntry(deps, await start(), 'playbook', input)).rejects.toThrow(message);
  });

  it('refuses a playbook over the role’s budget for one, and a charter over its limit', async () => {
    const id = await start();
    const long = Array.from({ length: 95 }, (_, i) => `longword${i}-${'x'.repeat(60)}`).join(' ');
    await addEntry(deps, id, 'playbook', { text: long });

    await expect(addEntry(deps, id, 'playbook', { text: long })).rejects.toThrow(/The playbook would be \d+ tokens, over the limit of 2000/);
    await expect(setCharter(deps, id, 'x'.repeat(3000))).rejects.toThrow(/The charter would be \d+ tokens, over the limit of 600/);
    await expect(setCharter(deps, id, ' ')).rejects.toThrow('A charter can’t be empty');
  });

  it('changes the charter, and drops the change when the text is the live one again', async () => {
    const id = await start();
    const live = readFileSync(roleFile('charter.md'), 'utf8');

    await setCharter(deps, id, `${live}- Run every check before you report.`);
    expect(await fileOf(id, 'charter')).toMatchObject({ changed: true, limit: 600, text: `${live}- Run every check before you report.\n` });
    expect((await fileOf(id, 'charter')).diff).toContain('+- Run every check before you report.');

    await setCharter(deps, id, live);
    expect(await view(id)).toMatchObject({ changed: false });
  });

  it('keeps one project’s memory in a draft, under ids no file of that project has used', async () => {
    mkdirSync(memoryFile('roles'), { recursive: true });
    writeFileSync(memoryFile('project.md'), '## MEM-2\nKind: feedback\nAdded by: the engine\nAdded: 2026-11-01\n\nPlays on a phone.\n');
    writeFileSync(memoryFile('roles/pm.md'), '## MEM-5\nKind: lesson\nAdded by: pm\nAdded: 2026-11-01\n\nThe PM’s own.\n');
    const id = await start();

    await expect(addEntry(deps, id, 'memory_role', { text: 'Tests live in test/.', kind: 'structure' })).rejects.toThrow('Say which project’s memory this is');
    await expect(addEntry(deps, id, 'memory_role', { text: 'Tests live in test/.', project: 'p' })).rejects.toThrow('A memory entry’s kind is feedback, lesson or structure');
    const mine = await addEntry(deps, id, 'memory_role', { text: 'Tests live in test/.', kind: 'structure', project: 'p' });
    const shared = await addEntry(deps, id, 'memory_project', { text: 'Sized in CSS pixels.', kind: 'lesson' });

    expect([mine.entryId, shared.entryId]).toEqual(['MEM-6', 'MEM-7']);
    expect(await view(id)).toMatchObject({ project: 'p' });
    expect(await fileOf(id, 'memory_role')).toMatchObject({ path: 'memory/roles/engineer.md', entries: [{ id: 'MEM-6', kind: 'structure' }] });
    expect((await fileOf(id, 'memory_project')).entries.map(({ id: entry }) => entry)).toEqual(['MEM-2', 'MEM-7']);
    await expect(addEntry(deps, id, 'memory_project', { text: 'x', kind: 'lesson', project: 'other' })).rejects.toMatchObject({ status: 409 });
  });

  it('won’t edit a file that has a problem', async () => {
    writeFileSync(roleFile('playbook.md'), '## PB-1\nAdded by: the stakeholder\n\nNo date.\n');

    await expect(addEntry(deps, await start(), 'playbook', { text: 'A rule.' })).rejects.toMatchObject({ status: 409, message: 'Fix the file by hand first: PB-1 has no "Added" line' });
  });

  it('says when a live file changed underneath it, until the stakeholder keeps the draft’s', async () => {
    const id = await start();
    await addEntry(deps, id, 'playbook', { text: 'A rule.' });

    writeFileSync(roleFile('playbook.md'), '## PB-9\nAdded by: someone\nAdded: 2026-11-21\n\nA hand edit.\n');
    expect(await view(id)).toMatchObject({ stale: true });
    expect(await fileOf(id, 'playbook')).toMatchObject({ stale: true });
    expect(await fileOf(id, 'charter')).toMatchObject({ stale: false });

    await keepOverLive(deps, id);
    expect(await view(id)).toMatchObject({ stale: false, changed: true });
  });

  it('gives a trial the live files and the draft’s, and one hash for the same draft', async () => {
    const id = await start();
    await addEntry(deps, id, 'playbook', { text: 'A rule.' });
    const draft = (await deps.trials.getDraft(id))!;

    const knowledge = await draftKnowledge(deps, draft);

    expect(knowledge.current).toMatchObject({ playbook: '', memory_project: '', memory_role: '' });
    expect(knowledge.current.charter).toBe(readFileSync(roleFile('charter.md'), 'utf8'));
    expect(knowledge.draft.playbook).toContain('## PB-1');
    expect(knowledge.draft.charter).toBe(knowledge.current.charter);
    expect(knowledgeHash(knowledge.draft)).toBe(knowledgeHash((await draftKnowledge(deps, draft)).draft));
    expect(knowledgeHash(knowledge.draft)).not.toBe(knowledgeHash(knowledge.current));
  });

  it('leaves live tasks on the committed files while it is open', async () => {
    const id = await start();
    await addEntry(deps, id, 'playbook', { text: 'Only in the draft.' });
    await setCharter(deps, id, '# Engineer\n\nA drafted charter.\n');
    const t = await e.addTicket(ticket());

    await runOnce(e, t.id);

    const system = readFileSync(join(manifestDir(e.paths, 'p', t.ticket_id, 1), 'system.md'), 'utf8');
    expect(system).not.toContain('Only in the draft.');
    expect(system).not.toContain('A drafted charter.');
  });

  it('is gone once discarded, and can no longer be changed', async () => {
    const id = await start();
    await addEntry(deps, id, 'playbook', { text: 'A rule.' });

    expect(await discardDraft(deps, id)).toMatchObject({ state: 'discarded' });

    expect(existsSync(draftDir(e.paths, id))).toBe(false);
    await expect(addEntry(deps, id, 'playbook', { text: 'Another.' })).rejects.toMatchObject({ status: 409 });
    expect((await startDraft(deps, 'engineer', 'A new one')).id).not.toBe(id);
  });
});
