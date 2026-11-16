import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { playbookSection } from '../src/knowledge/entries.ts';
import { estimateTokens } from '../src/manifest/tokens.ts';
import { listRoles, roleMemory, roleProvenance, type ProvenanceDirs, type RoleProvenance } from '../src/roles/provenance.ts';
import { initRepo, run, tempDir } from './helpers/repo.ts';

const ROLE_YAML = `id: pm
specialty_of: null
department: product
mission: Turn the brief into a spec
consumes: []
produces: [spec]
write_scope: { allow: [], deny: [] }
tools: [read_repo]
defaults:
  adapter: claude
  model: sonnet
  budgets: { max_turns: 20, max_usd: 1.5, context_tokens: 12000, playbook_tokens: 800, memory_tokens: 400 }
output_schema: schemas/spec.json
output_schemas: { revise: schemas/../schemas/revise.json, escape: ../outside.json }
`;

// Each commit gets its own date, so the order of lessons doesn't hang on how fast the test runs.
function commitAt(cwd: string, message: string, date: string): string {
  run(cwd, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], { cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return run(cwd, 'rev-parse', 'HEAD');
}

const nth = <T,>(items: readonly T[], i: number): T => {
  const item = items.at(i);
  if (item === undefined) throw new Error(`Nothing at ${i}`);
  return item;
};

describe('a role’s provenance', () => {
  let home: string;
  let dirs: ProvenanceDirs;
  let seedRepo: string;
  const sha: Record<string, string> = {};

  beforeEach(() => {
    home = tempDir('aiteam-provenance-');
    // The seed sits deep in AI Team's own repo, next to files that have nothing to do with roles.
    seedRepo = join(home, 'ai-team');
    const seed = join(seedRepo, 'seed', 'knowledge');
    mkdirSync(join(seed, 'roles', 'pm'), { recursive: true });
    mkdirSync(join(seed, 'schemas'));
    initRepo(seedRepo);
    writeFileSync(join(seedRepo, 'README.md'), 'AI Team\n');
    writeFileSync(join(seed, 'roles', 'pm', 'role.yaml'), ROLE_YAML);
    writeFileSync(join(seed, 'roles', 'pm', 'charter.md'), 'line one\nline two\n');
    writeFileSync(join(seed, 'schemas', 'spec.json'), '{}\n');
    writeFileSync(join(seed, 'schemas', 'other.json'), '{}\n');
    sha.first = commitAt(seedRepo, 'seed: first pm charter', '2026-01-01T00:00:00Z');
    appendFileSync(join(seed, 'roles', 'pm', 'charter.md'), 'line three\n');
    writeFileSync(join(seed, 'schemas', 'revise.json'), '{"type":"object"}\n');
    sha.three = commitAt(seedRepo, 'seed: pm learns three\n\nBecause the stakeholder said so.', '2026-02-01T00:00:00Z');

    const knowledge = join(home, 'knowledge');
    cpSync(seed, knowledge, { recursive: true });
    initRepo(knowledge);
    sha.copied = commitAt(knowledge, 'Seed the knowledge repo', '2026-03-01T00:00:00Z');
    appendFileSync(join(knowledge, 'roles', 'pm', 'charter.md'), 'line four, curated\n');
    sha.curated = commitAt(knowledge, 'pm: curated lesson', '2026-04-01T00:00:00Z');
    appendFileSync(join(knowledge, 'roles', 'pm', 'charter.md'), 'line five, not committed\n');
    writeFileSync(join(knowledge, 'roles', 'pm', 'notes.md'), 'a new note\n');

    dirs = { knowledge, seed };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const provenance = async (id = 'pm'): Promise<RoleProvenance> => {
    const found = await roleProvenance(dirs, id);
    if (found === null) throw new Error(`No provenance for ${id}`);
    return found;
  };

  it('credits each charter line to the commit that wrote it, the seed’s first', async () => {
    const { lines } = await provenance();

    expect(lines.map(({ text, sha, source }) => [text, sha, source])).toEqual([
      ['line one', sha.first, 'seed'],
      ['line two', sha.first, 'seed'],
      ['line three', sha.three, 'seed'],
      ['line four, curated', sha.curated, 'knowledge'],
      ['line five, not committed', null, null],
    ]);
    expect(nth(lines, 2)).toMatchObject({ date: '2026-02-01T00:00:00.000Z', subject: 'seed: pm learns three' });
  });

  it('lists what was not committed first, then every commit newest first, with paths as the knowledge repo has them', async () => {
    const { lessons } = await provenance();

    expect(lessons.map(({ source, sha, subject }) => [source, sha, subject])).toEqual([
      ['uncommitted', null, 'Not committed yet'],
      ['knowledge', sha.curated, 'pm: curated lesson'],
      ['knowledge', sha.copied, 'Seed the knowledge repo'],
      ['seed', sha.three, 'seed: pm learns three'],
      ['seed', sha.first, 'seed: first pm charter'],
    ]);
    expect(nth(lessons, 0).files.map(({ path, add, untracked }) => [path, add, untracked])).toEqual([
      ['roles/pm/charter.md', 1, false],
      ['roles/pm/notes.md', 1, true],
    ]);
    expect(nth(lessons, 1).files).toEqual([expect.objectContaining({ path: 'roles/pm/charter.md', kind: 'charter', add: 1, del: 0, clipped: false })]);
    expect(nth(lessons, 1).files[0]?.diff).toMatch(/^@@ .* @@\n line one\n(.*\n)* line three\n\+line four, curated$/);
    expect(nth(lessons, 1).date).toBe('2026-04-01T00:00:00.000Z');
    expect(nth(lessons, 3)).toMatchObject({ body: 'Because the stakeholder said so.', author: 'Stakeholder' });
  });

  it('follows the schemas the role names, and no file it doesn’t', async () => {
    const { lessons } = await provenance();
    const first = nth(lessons, 4).files.map(({ path, kind }) => [path, kind]);
    const learned = nth(lessons, 3).files.map(({ path }) => path);

    expect(first).toEqual([
      ['roles/pm/charter.md', 'charter'],
      ['roles/pm/role.yaml', 'config'],
      ['schemas/spec.json', 'schema'],
    ]);
    expect(learned).toEqual(['roles/pm/charter.md', 'schemas/revise.json']);
  });

  it('reads the role’s facts from role.yaml', async () => {
    expect(await provenance()).toMatchObject({
      id: 'pm',
      department: 'product',
      model: 'sonnet',
      produces: ['spec'],
      budgets: { context_tokens: 12000, max_turns: 20, max_usd: 1.5 },
      charterTokenLimit: 600,
      error: null,
    });
  });

  it('clips a long diff', async () => {
    writeFileSync(join(dirs.knowledge, 'roles', 'pm', 'charter.md'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    commitAt(dirs.knowledge, 'pm: a long charter', '2026-05-01T00:00:00Z');

    const file = nth((await provenance()).lessons, 0).files.find(({ path }) => path === 'roles/pm/charter.md');

    expect(file).toMatchObject({ clipped: true, add: 400 });
    expect(file?.diff.split('\n')).toHaveLength(260);
  });

  it('credits the knowledge repo alone when the seed has no history', async () => {
    dirs = { ...dirs, seed: tempDir('aiteam-no-history-') };

    const { lines, lessons } = await provenance();

    expect(lines.map(({ source }) => source)).toEqual(['knowledge', 'knowledge', 'knowledge', 'knowledge', null]);
    expect(lessons.map(({ source }) => source)).toEqual(['uncommitted', 'knowledge', 'knowledge']);
  });

  it('shows a role with a broken role.yaml rather than hiding it', async () => {
    writeFileSync(join(dirs.knowledge, 'roles', 'pm', 'role.yaml'), 'id: [');

    expect(await provenance()).toMatchObject({ department: null, error: 'role.yaml is not valid YAML', lines: expect.arrayContaining([expect.objectContaining({ text: 'line one' })]) });
  });

  it.each([['nope'], ['../pm'], ['pm/..'], ['']])('knows no role %j', async (id) => {
    expect(await roleProvenance(dirs, id)).toBeNull();
  });

  it('sums up every role', async () => {
    mkdirSync(join(dirs.knowledge, 'roles', 'qa'));
    writeFileSync(join(dirs.knowledge, 'roles', 'qa', 'charter.md'), 'Check it.\n');

    expect(await listRoles(dirs)).toEqual([
      expect.objectContaining({ id: 'pm', department: 'product', charterTokenLimit: 600, lessons: 4, lastLesson: '2026-04-01T00:00:00.000Z', uncommitted: true, error: null }),
      expect.objectContaining({ id: 'qa', lessons: 0, lastLesson: null, uncommitted: true, error: 'role.yaml is missing' }),
    ]);
  });

  const entry = (id: string, text: string, kind?: string) => [`## ${id}`, ...(kind === undefined ? [] : [`Kind: ${kind}`]), 'Added by: the stakeholder', 'Added: 2026-11-15', '', text, ''].join('\n');

  describe('the playbook', () => {
    const file = () => join(dirs.knowledge, 'roles', 'pm', 'playbook.md');

    it('is empty for a role nobody has written one for', async () => {
      expect((await provenance()).playbook).toEqual({ path: 'roles/pm/playbook.md', entries: [], problems: [], tokens: 0 });
      expect(await listRoles(dirs)).toMatchObject([{ id: 'pm', playbookTokens: 0 }]);
    });

    it('credits each entry to the newest commit that changed it, and none to an entry not committed yet', async () => {
      writeFileSync(file(), `# PM playbook\n\n${entry('PB-1', 'Ask for a check.')}\n${entry('PB-2', 'Keep it small.')}`);
      sha.written = commitAt(dirs.knowledge, 'pm: a playbook', '2026-05-01T00:00:00Z');
      writeFileSync(file(), `# PM playbook\n\n${entry('PB-1', 'Ask for a check you can run.')}\n${entry('PB-2', 'Keep it small.')}`);
      sha.sharper = commitAt(dirs.knowledge, 'pm: PB-1, sharper', '2026-06-01T00:00:00Z');
      appendFileSync(file(), `\n${entry('PB-3', 'Not committed yet.')}`);

      const { playbook, lessons } = await provenance();

      expect(playbook.entries.map(({ id, text, sha: commit, subject }) => [id, text, commit, subject])).toEqual([
        ['PB-1', 'Ask for a check you can run.', sha.sharper, 'pm: PB-1, sharper'],
        ['PB-2', 'Keep it small.', sha.written, 'pm: a playbook'],
        ['PB-3', 'Not committed yet.', null, null],
      ]);
      expect(nth(playbook.entries, 0)).toMatchObject({ addedBy: 'the stakeholder', added: '2026-11-15', date: '2026-06-01T00:00:00.000Z' });
      expect(playbook.tokens).toBe(estimateTokens(playbookSection(playbook.entries)));
      expect(lessons.find(({ sha: commit }) => commit === sha.sharper)?.files).toMatchObject([{ path: 'roles/pm/playbook.md', kind: 'playbook' }]);
      expect(await listRoles(dirs)).toMatchObject([{ id: 'pm', playbookTokens: playbook.tokens }]);
    });

    it('shows a playbook with a problem, with what is wrong and the entries that are right', async () => {
      writeFileSync(file(), `${entry('PB-1', '')}\n${entry('PB-2', 'Keep it small.')}`);

      expect((await provenance()).playbook).toMatchObject({ problems: ['PB-1 has no text'], entries: [{ id: 'PB-2', sha: null }] });
    });
  });

  describe('a project’s memory for the role', () => {
    let state: string;

    beforeEach(() => {
      state = join(home, 'state');
      mkdirSync(join(state, 'memory', 'roles'), { recursive: true });
      initRepo(state);
    });

    const write = (path: string, text: string) => writeFileSync(join(state, 'memory', path), text);

    it('is empty for a project that has kept none', async () => {
      expect(await roleMemory(dirs, 'pm', state)).toEqual({
        files: { project: { path: 'memory/project.md', entries: [], problems: [] }, role: { path: 'memory/roles/pm.md', entries: [], problems: [] } },
        tokens: 0,
        omitted: [],
        problems: [],
      });
    });

    it('is the project’s file and the role’s own, each entry with its commit', async () => {
      write('project.md', entry('MEM-1', 'The stakeholder plays on a phone.', 'feedback'));
      write('roles/pm.md', entry('MEM-2', 'Criteria need a command.', 'lesson'));
      write('roles/engineer.md', entry('MEM-3', 'Not the PM’s.', 'lesson'));
      sha.memory = commitAt(state, 'memory: first notes', '2026-07-01T00:00:00Z');
      write('roles/pm.md', `${entry('MEM-2', 'Criteria need a command.', 'lesson')}\n${entry('MEM-4', 'Not committed yet.', 'structure')}`);

      const memory = (await roleMemory(dirs, 'pm', state))!;

      expect(memory.files.project.entries).toMatchObject([{ id: 'MEM-1', kind: 'feedback', sha: sha.memory, subject: 'memory: first notes' }]);
      expect(memory.files.role.entries.map(({ id, sha: commit }) => [id, commit])).toEqual([
        ['MEM-2', sha.memory],
        ['MEM-4', null],
      ]);
      expect(memory.tokens).toBeGreaterThan(0);
      expect(memory).toMatchObject({ omitted: [], problems: [] });
    });

    // The PM's budget for memory in this test is 400 tokens.
    it('says which entries a task would be given none of, and what stops any being given', async () => {
      write('project.md', `${entry('MEM-1', 'x'.repeat(4000), 'feedback')}\n${entry('MEM-2', 'Short.', 'lesson')}`);
      write('roles/pm.md', `${entry('MEM-2', 'The same id.', 'lesson')}\n${entry('MEM-5', '', 'lesson')}`);

      const memory = (await roleMemory(dirs, 'pm', state))!;

      expect(memory.omitted).toEqual([{ file: 'project', id: 'MEM-1' }]);
      expect(memory.files.role.problems).toEqual(['MEM-5 has no text']);
      expect(memory.problems).toEqual(['MEM-2 is in both memory/project.md and memory/roles/pm.md']);
    });

    it('shows what is kept for a role whose role.yaml sets no budget, none of which a task would be given', async () => {
      writeFileSync(join(dirs.knowledge, 'roles', 'pm', 'role.yaml'), 'id: [');
      write('project.md', entry('MEM-1', 'The stakeholder plays on a phone.', 'feedback'));

      const memory = (await roleMemory(dirs, 'pm', state))!;

      expect(memory.files.project.entries).toMatchObject([{ id: 'MEM-1' }]);
      expect(memory).toMatchObject({ tokens: 0, omitted: [{ file: 'project', id: 'MEM-1' }] });
    });

    it('knows no memory for a role the knowledge repo doesn’t have', async () => {
      expect(await roleMemory(dirs, 'nope', state)).toBeNull();
    });
  });
});
