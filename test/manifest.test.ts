import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, readRepoInstructions, type BuildInput, type TaskManifest } from '../src/manifest/build.ts';
import { loadRole } from '../src/roles/role.ts';
import { parseTicket } from '../src/tickets/ticket.ts';
import { tempDir } from './helpers/repo.ts';

const seedKnowledge = fileURLToPath(new URL('../seed/knowledge', import.meta.url));
const t1 = readFileSync(new URL('./fixtures/tickets/T-1.md', import.meta.url), 'utf8');

describe('buildManifest', () => {
  let input: BuildInput;

  beforeEach(async () => {
    const { role, charter, schema } = await loadRole(seedKnowledge, 'engineer');
    input = { project: 'p', attemptK: 1, role, charter, schema, ticket: parseTicket(t1), ticketMarkdown: t1, repoInstructions: [] };
  });

  const built = (i: BuildInput) => {
    const r = buildManifest(i);
    if (!r.ok) throw new Error(`over budget: ${r.totalTokens}`);
    return r.manifest;
  };

  it('reports each part with budget', () => {
    const m = built(input);
    const by = Object.fromEntries(m.parts.map((p) => [p.name, p]));
    expect(by.playbook).toMatchObject({ tokens: 0, budget: 2000 });
    expect(by.memory).toMatchObject({ tokens: 0, budget: 1000 });
    expect(by.charter!.budget).toBe(600);
    expect(by.charter!.tokens).toBeGreaterThan(0);
    expect(by.task_inputs!.sources).toEqual(['artifacts/ticket/T-1.md']);
    expect(by.output_contract!.sources).toEqual(['schemas/change_report.json']);
    expect(m.contextBudget).toBe(12000);
    expect(m.totalTokens).toBe(m.parts.reduce((sum, p) => sum + p.tokens, 0));
  });

  it('carries what the adapter and the checks need', () => {
    const m = built(input);
    expect(m).toMatchObject({ project: 'p', ticketId: 'T-1', attemptK: 1, roleId: 'engineer', adapter: 'claude-code', model: 'claude-sonnet-5-5' });
    expect(m.budgets.max_turns).toBe(60);
    expect(m.tools).toContain('edit_repo');
    expect(m.outputSchema).toBe(input.schema);
    expect(m.writeScope).toEqual({ allow: ['**'], deny: ['.aiteam/**'] });
  });

  it('puts the charter and the output contract in system, and the ticket in task', () => {
    const m = built(input);
    expect(m.system).toContain('# Engineer');
    expect(m.system).toContain('## Output contract');
    expect(m.system).toContain('Change Report');
    expect(m.system).toContain('.aiteam/**');
    expect(m.system).toContain('node --test');
    expect(m.task).toBe(t1);
    expect(m.task).not.toContain('## Previous attempt');
  });

  it('fails when the ticket is too large', () => {
    expect(buildManifest({ ...input, ticketMarkdown: 'x'.repeat(60000) })).toMatchObject({ ok: false, reason: 'context_over_budget' });
  });

  it('reports the parts when over budget', () => {
    const r = buildManifest({ ...input, ticketMarkdown: 'x'.repeat(60000) });
    if (r.ok) throw new Error('expected over budget');
    expect(r.totalTokens).toBeGreaterThan(12000);
    expect(r.parts.find((p) => p.name === 'task_inputs')!.tokens).toBeGreaterThan(12000);
  });

  describe('repo instructions', () => {
    const content = 'INSTRUCTION'.padEnd(700, 'x');
    const instructionsPart = (m: TaskManifest) => m.parts.find((p) => p.name === 'repo_instructions')!;

    it('refuses a manifest whose instructions are over budget', () => {
      const repoInstructions = [{ path: 'CLAUDE.md', content: 'x'.repeat(70000) }];
      expect(buildManifest({ ...input, repoInstructions })).toMatchObject({ ok: false, reason: 'context_over_budget' });
    });

    it('delivers the files in the repo through the system prompt', () => {
      const m = built({ ...input, repoInstructions: [{ path: 'CLAUDE.md', content }] });

      expect(m.system).toContain(content);
      expect(m.system).toContain('### CLAUDE.md');
      expect(m.task).not.toContain('INSTRUCTION');
    });

    it('counts all that it delivers', () => {
      const m = built({ ...input, repoInstructions: [{ path: 'CLAUDE.md', content }] });

      expect(instructionsPart(m).sources).toEqual(['CLAUDE.md']);
      expect(instructionsPart(m).tokens).toBeGreaterThan(200);
    });

    it('puts the output contract ahead of them', () => {
      const m = built({ ...input, repoInstructions: [{ path: 'CLAUDE.md', content }] });

      expect(m.system.indexOf('## Output contract')).toBeLessThan(m.system.indexOf('INSTRUCTION'));
    });

    it('adds no section when the repo has none', () => {
      expect(built(input).system).not.toContain('Repository instructions');
    });
  });

  it('counts the output schema, which the worker also sees', () => {
    const small = built(input).parts.find((p) => p.name === 'output_contract')!.tokens;
    const big = built({ ...input, schema: { description: 'x'.repeat(3500) } }).parts.find((p) => p.name === 'output_contract')!.tokens;
    expect(big).toBeGreaterThan(small);
  });

  describe('on a retry', () => {
    it('fits 5 MB of evidence and keeps its tail', () => {
      const m = built({ ...input, retry: { evidence: 'a'.repeat(5e6) + 'LAST', changeReport: { summary: 's' } } });
      expect(m.totalTokens).toBeLessThanOrEqual(12000);
      expect(m.task).toContain('## Previous attempt');
      expect(m.task).toContain('LAST');
      expect(m.task).toMatch(/\[… \d+ chars trimmed\]/);
      expect(m.task.indexOf(t1)).toBe(0);
    });

    it('reports exactly how many characters it trimmed', () => {
      const evidence = 'a'.repeat(100000);
      const m = built({ ...input, retry: { evidence, changeReport: null } });
      const trimmed = Number(/\[… (\d+) chars trimmed\]/.exec(m.task)![1]);
      const kept = /chars trimmed\]\n(a+)/.exec(m.task)![1]!.length;
      expect(trimmed + kept).toBe(evidence.length);
    });

    it('keeps short evidence whole', () => {
      const m = built({ ...input, retry: { evidence: 'exit 1: boom', changeReport: { summary: 'tried' } } });
      expect(m.task).toContain('exit 1: boom');
      expect(m.task).toContain('tried');
      expect(m.task).not.toMatch(/chars trimmed/);
    });

    it('a huge Change Report cannot push the manifest over budget', () => {
      const m = built({ ...input, retry: { evidence: 'LAST', changeReport: { summary: 'z'.repeat(5e6) } } });
      expect(m.totalTokens).toBeLessThanOrEqual(12000);
      expect(m.task).toContain('LAST');
    });

    it('drops the previous attempt rather than go over budget', () => {
      const fixed = built(input).totalTokens - built(input).parts.find((p) => p.name === 'task_inputs')!.tokens;
      const fullTicket = 'x'.repeat(Math.floor((12000 - fixed) * 3.5));

      const m = built({ ...input, ticketMarkdown: fullTicket, retry: { evidence: 'e'.repeat(1000), changeReport: { summary: 's' } } });

      expect(m.totalTokens).toBeLessThanOrEqual(12000);
      expect(m.task).toBe(fullTicket);
    });

    it('notes the previous attempt among the sources', () => {
      const m = built({ ...input, retry: { evidence: 'e', changeReport: null } });
      expect(m.parts.find((p) => p.name === 'task_inputs')!.sources).toContain('previous attempt');
    });
  });
});

describe('repo instruction files', () => {
  it('reads the worktree files and none above it, since those never reach a worker', async () => {
    const root = tempDir();
    const worktree = join(root, 'wt');
    mkdirSync(join(worktree, '.claude'), { recursive: true });
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, 'AGENTS.md'), 'above');
    writeFileSync(join(root, 'CLAUDE.md'), 'above');
    writeFileSync(join(root, '.claude', 'CLAUDE.md'), 'above');
    writeFileSync(join(worktree, 'CLAUDE.md'), 'one');
    writeFileSync(join(worktree, '.claude', 'CLAUDE.md'), 'two');
    writeFileSync(join(worktree, 'AGENTS.md'), 'three');

    const files = await readRepoInstructions(worktree);

    expect(files.map(({ path, content }) => [path, content])).toEqual([
      ['CLAUDE.md', 'one'],
      [join('.claude', 'CLAUDE.md'), 'two'],
      ['AGENTS.md', 'three'],
    ]);
  });

  describe('symlinks', () => {
    let root: string;
    let worktree: string;

    beforeEach(() => {
      root = tempDir();
      worktree = join(root, 'wt');
      mkdirSync(worktree);
      mkdirSync(join(root, 'outside'));
      writeFileSync(join(root, 'outside', 'secret'), 'SECRET');
      writeFileSync(join(root, 'outside', 'CLAUDE.md'), 'SECRET');
    });

    it('does not read a link to a file outside the worktree', async () => {
      symlinkSync(join(root, 'outside', 'secret'), join(worktree, 'CLAUDE.md'));

      expect(await readRepoInstructions(worktree)).toEqual([]);
    });

    it('does not read through a linked folder outside the worktree', async () => {
      symlinkSync(join(root, 'outside'), join(worktree, '.claude'));

      expect(await readRepoInstructions(worktree)).toEqual([]);
    });

    it('does not read a chain of links that ends outside the worktree', async () => {
      symlinkSync(join(root, 'outside', 'secret'), join(worktree, 'hop'));
      symlinkSync('hop', join(worktree, 'CLAUDE.md'));

      expect(await readRepoInstructions(worktree)).toEqual([]);
    });

    it('does not read a link to a device', async () => {
      symlinkSync('/dev/zero', join(worktree, 'CLAUDE.md'));

      expect(await readRepoInstructions(worktree)).toEqual([]);
    });

    it('reads a link that stays inside the worktree', async () => {
      writeFileSync(join(worktree, 'AGENTS.md'), 'shared');
      symlinkSync('AGENTS.md', join(worktree, 'CLAUDE.md'));

      expect(await readRepoInstructions(worktree)).toEqual(
        expect.arrayContaining([
          { path: 'CLAUDE.md', content: 'shared' },
          { path: 'AGENTS.md', content: 'shared' },
        ]),
      );
    });

    it('reads a worktree that is itself reached through a link', async () => {
      writeFileSync(join(worktree, 'CLAUDE.md'), 'mine');
      symlinkSync(worktree, join(root, 'alias'));

      expect(await readRepoInstructions(join(root, 'alias'))).toEqual([{ path: 'CLAUDE.md', content: 'mine' }]);
    });
  });

  it('treats a folder named CLAUDE.md as no instructions', async () => {
    const worktree = join(tempDir(), 'wt');
    mkdirSync(join(worktree, 'CLAUDE.md'), { recursive: true });

    expect((await readRepoInstructions(worktree)).filter((f) => f.path === 'CLAUDE.md')).toEqual([]);
  });
});
