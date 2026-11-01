import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runChecks, runSandboxed } from '../src/checks/run-checks.ts';
import type { EventType } from '../src/events.ts';
import { addAttemptWorktree, snapshotAttempt } from '../src/git/workspace.ts';
import { until } from './helpers/engine.ts';
import { makeRepo, tempDir } from './helpers/repo.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runChecks', () => {
  let repoPath: string;
  let baseSha: string;
  let worktree: string;

  beforeEach(async () => {
    const repo = await makeRepo();
    repoPath = repo.path;
    baseSha = repo.headSha;
    worktree = join(tempDir(), 'wt');
    await addAttemptWorktree(repoPath, worktree, 'aiteam/T-1-a1', baseSha);
  });

  async function commitFiles(...paths: string[]): Promise<void> {
    for (const path of paths) {
      mkdirSync(dirname(join(worktree, path)), { recursive: true });
      writeFileSync(join(worktree, path), 'content\n');
    }
    await snapshotAttempt(repoPath, worktree, 'attempt work');
  }

  function checks(overrides: Partial<Parameters<typeof runChecks>[0]> = {}) {
    return runChecks({
      repoPath,
      worktree,
      baseSha,
      writeScope: { allow: ['**'], deny: [] },
      commands: ['true'],
      denyRead: [],
      timeoutS: 30,
      onEvent: () => {},
      ...overrides,
    });
  }

  it('passes when commands pass and paths are in scope', async () => {
    await commitFiles('src/a.ts');
    const r = await checks({ writeScope: { allow: ['src/**'], deny: [] }, commands: ['echo hello'] });

    expect(r.ok).toBe(true);
    expect(r.runs[0]).toMatchObject({ command: 'echo hello', exitCode: 0, timedOut: false, outputTail: 'hello\n' });
    expect(r.runs[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs in the worktree', async () => {
    await commitFiles('marker.txt');
    expect((await checks({ commands: ['test -f marker.txt'] })).ok).toBe(true);
  });

  it('fails on no changes without running commands', async () => {
    const sentinel = join(worktree, 'ran');
    const r = await checks({ commands: [`touch ${sentinel}`] });

    expect(r).toMatchObject({ ok: false, kind: 'no_changes', runs: [] });
    expect(existsSync(sentinel)).toBe(false);
  });

  describe('write scope', () => {
    it('.aiteam is always a violation', async () => {
      await commitFiles('.aiteam/x.md');
      const r = await checks({ writeScope: { allow: ['**'], deny: [] } });
      expect(r).toMatchObject({ ok: false, kind: 'scope_violation', violations: ['.aiteam/x.md'] });
    });

    it('.aiteam in another case is a violation, because this filesystem folds case', async () => {
      await commitFiles('.AITeam/x.md');
      expect(await checks()).toMatchObject({ ok: false, kind: 'scope_violation', violations: ['.AITeam/x.md'] });
    });

    it('allows a folder that only starts with .aiteam', async () => {
      await commitFiles('.aiteam-notes/x.md');
      expect((await checks()).ok).toBe(true);
    });

    it.each(['.claude', '.aiteam', '.claude/settings.json', '.CLAUDE/hooks.json', 'pkg/.claude/settings.json', '.codex/config.toml', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md', 'pkg/claude.md', 'AGENTS.md'])(
      'agent config %s is always a violation, whatever the role allows',
      async (path) => {
        await commitFiles(path);
        expect(await checks({ writeScope: { allow: ['**'], deny: [] } })).toMatchObject({ ok: false, kind: 'scope_violation', violations: [path] });
      },
    );

    it.each(['.claude-notes/x.md', 'docs/claude.md.txt', 'src/mcp.json'])('allows %s, which only looks like agent config', async (path) => {
      await commitFiles(path);
      expect((await checks()).ok).toBe(true);
    });

    it('deny beats allow; dotfiles match', async () => {
      await commitFiles('secrets/.env', 'src/.config');
      const r = await checks({ writeScope: { allow: ['**'], deny: ['secrets/**'] } });
      expect(r).toMatchObject({ ok: false, kind: 'scope_violation', violations: ['secrets/.env'] });
    });

    it('deny ignores case too', async () => {
      await commitFiles('SECRETS/key');
      expect(await checks({ writeScope: { allow: ['**'], deny: ['secrets/**'] } })).toMatchObject({ ok: false, kind: 'scope_violation', violations: ['SECRETS/key'] });
    });

    it('fails a path outside allow, names it, and runs no commands', async () => {
      await commitFiles('src/a.ts', 'docs/b.md');
      const r = await checks({ writeScope: { allow: ['src/**'], deny: [] }, commands: ['touch ran'] });

      expect(r).toMatchObject({ ok: false, kind: 'scope_violation', violations: ['docs/b.md'], runs: [] });
      expect(r.ok === false && r.evidence).toContain('docs/b.md');
      expect(existsSync(join(worktree, 'ran'))).toBe(false);
    });
  });

  describe('commands', () => {
    beforeEach(() => commitFiles('src/a.ts'));

    it('stops at the first failing command', async () => {
      const r = await checks({ commands: ['echo broke; exit 3', 'touch sentinel'] });

      expect(r).toMatchObject({ ok: false, kind: 'check_failed' });
      expect(r.runs).toHaveLength(1);
      expect(r.runs[0]!.exitCode).toBe(3);
      expect(existsSync(join(worktree, 'sentinel'))).toBe(false);
      expect(r.ok === false && r.evidence).toContain('broke');
      expect(r.ok === false && r.evidence).toContain('echo broke; exit 3');
    });

    it('merges stderr into the output', async () => {
      const r = await checks({ commands: ['echo oops >&2'] });
      expect(r.runs[0]!.outputTail).toBe('oops\n');
    });

    it('kills a command at the timeout', async () => {
      const r = await checks({ commands: ['sleep 100'], timeoutS: 1 });

      expect(r.runs[0]!.timedOut).toBe(true);
      expect(r).toMatchObject({ ok: false, kind: 'check_failed' });
      expect(r.ok === false && r.evidence).toContain('timed out');
    });

    it('aborting stops the running command', async () => {
      const controller = new AbortController();
      let pid = 0;
      const before = Date.now();

      const r = await checks({
        commands: ['sleep 100', 'touch sentinel'],
        signal: controller.signal,
        onSpawn: (p) => {
          pid = p;
          controller.abort();
        },
      });

      expect(Date.now() - before).toBeLessThan(3000);
      expect(r).toMatchObject({ ok: false, kind: 'check_failed' });
      expect(r.runs).toHaveLength(1);
      expect(alive(pid)).toBe(false);
      expect(existsSync(join(worktree, 'sentinel'))).toBe(false);
    });

    it('runs nothing when already aborted', async () => {
      const r = await checks({ commands: ['touch sentinel'], signal: AbortSignal.abort() });

      expect(r).toMatchObject({ ok: false, kind: 'check_failed', runs: [] });
      expect(existsSync(join(worktree, 'sentinel'))).toBe(false);
    });

    it('keeps only the tail of huge output', async () => {
      const r = await checks({ commands: [`node -e "process.stdout.write('x'.repeat(5*1024*1024)); console.log('END')"`] });

      expect(r.runs[0]!.outputTail.length).toBeLessThanOrEqual(8000);
      expect(r.runs[0]!.outputTail).toContain('END');
    });

    it('runs with the allow-listed env', async () => {
      process.env.ANTHROPIC_API_KEY = 'secret';
      try {
        const r = await checks({ commands: ['echo "key=[$ANTHROPIC_API_KEY] path=[${PATH:+set}]"'] });
        expect(r.runs[0]!.outputTail).toBe('key=[] path=[set]\n');
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('emits check.started and check.finished', async () => {
      const seen: [EventType, unknown][] = [];
      await checks({ commands: ['true', 'false'], onEvent: (type, payload) => seen.push([type, payload]) });

      expect(seen.map(([type]) => type)).toEqual(['check.started', 'check.finished', 'check.started', 'check.finished']);
      expect(seen[0]![1]).toEqual({ command: 'true' });
      expect(seen[3]![1]).toMatchObject({ command: 'false', exitCode: 1, timedOut: false });
    });

    it('does not hang on a background process', async () => {
      const r = await checks({ commands: ['sleep 100 &'] });
      expect(r.ok).toBe(true);
    });

    it('reports each process group', async () => {
      const pids: number[] = [];
      await checks({ commands: ['true', 'true'], onSpawn: (pid) => pids.push(pid) });
      expect(pids).toHaveLength(2);
      expect(new Set(pids).size).toBe(2);
    });
  });

  // Definition-of-done commands run code the worker wrote, so they get the limits the worker's own Bash has.
  describe('sandbox', () => {
    beforeEach(() => commitFiles('src/a.ts'));

    it('blocks a write outside the worktree', async () => {
      const outside = join(homedir(), `.aiteam-sandbox-test-${process.pid}-${Date.now()}`);
      try {
        const r = await checks({ commands: [`echo planted > ${outside}`] });

        expect(r).toMatchObject({ ok: false, kind: 'check_failed' });
        expect(existsSync(outside)).toBe(false);
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it('blocks a change to the git config of the repo', async () => {
      const r = await checks({ commands: [`echo planted >> ${join(repoPath, '.git', 'config')}`] });
      expect(r).toMatchObject({ ok: false, kind: 'check_failed' });
    });

    it('allows writes in the worktree and temp folders', async () => {
      const r = await checks({ commands: ['echo a > inside.txt', 'mkdir -p build/out && echo b > build/out/c', 'f=$(mktemp) && echo c > "$f" && rm "$f"', 'echo d > /tmp/aiteam-sandbox-$$ && rm /tmp/aiteam-sandbox-$$', 'echo e > /dev/null'] });
      expect(r.ok).toBe(true);
    });

    it('blocks reaching a local service', async () => {
      let connected = false;
      const server = createServer(() => {
        connected = true;
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const script = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
        const r = await checks({ commands: [`node -e "${script}"`] });

        expect(r.runs[0]!.exitCode).toBe(3);
        expect(connected).toBe(false);
      } finally {
        server.close();
      }
    });

    it('blocks reading a denied path', async () => {
      const denied = tempDir();
      writeFileSync(join(denied, 'secret'), 'SECRET-VALUE\n');

      const r = await checks({ denyRead: [denied], commands: [`cat ${join(denied, 'secret')}`] });

      expect(r).toMatchObject({ ok: false, kind: 'check_failed' });
      expect(r.runs[0]!.outputTail).not.toContain('SECRET-VALUE');
    });

    it('blocks reading a denied file by a link in the worktree', async () => {
      const denied = tempDir();
      writeFileSync(join(denied, 'secret'), 'SECRET-VALUE\n');
      symlinkSync(join(denied, 'secret'), join(worktree, 'link'));

      const r = await checks({ denyRead: [denied], commands: ['cat link'] });

      expect(r.runs[0]!.outputTail).not.toContain('SECRET-VALUE');
    });

    it('takes a denied path that does not exist', async () => {
      expect((await checks({ denyRead: [join(tempDir(), 'missing')] })).ok).toBe(true);
    });

    it('gives the worktree back when its parent is denied, and blocks its siblings', async () => {
      const sibling = join(dirname(worktree), 'sibling');
      mkdirSync(sibling);
      writeFileSync(join(sibling, 'secret'), 'SECRET-VALUE\n');

      expect((await checks({ denyRead: [dirname(worktree)], commands: ['cat src/a.ts', 'git status --short'] })).ok).toBe(true);
      expect((await checks({ denyRead: [dirname(worktree)], commands: [`cat ${join(sibling, 'secret')}`] })).ok).toBe(false);
    });

    it('runs a real test command', async () => {
      await commitFiles('a.test.mjs');
      writeFileSync(join(worktree, 'a.test.mjs'), `import test from 'node:test'; test('ok', () => {});\n`);
      expect((await checks({ commands: ['node --test'] })).ok).toBe(true);
    });

    describe('with the worktrees folder denied, as for a real attempt', () => {
      let worktrees: string;
      let attempt: string;
      let sibling: string;

      beforeEach(async () => {
        worktrees = join(tempDir(), 'worktrees');
        attempt = join(worktrees, 'project', 'T-2-a1');
        sibling = join(worktrees, 'project', 'T-3-a1');
        await addAttemptWorktree(repoPath, attempt, 'aiteam/T-2-a1', baseSha);
        mkdirSync(sibling);
        writeFileSync(join(sibling, 'secret'), 'SECRET-VALUE\n');
        writeFileSync(join(attempt, 'a.test.mjs'), `import test from 'node:test'; test('ok', () => {});\n`);
        await snapshotAttempt(repoPath, attempt, 'work');
      });

      const denied = (command: string) => checks({ worktree: attempt, denyRead: [worktrees], commands: [command] });

      // Node resolves the real path of what it runs, which takes an lstat of each folder above it.
      it('runs a program that resolves its own path', async () => {
        const r = await denied('node --test a.test.mjs');

        expect(r.runs[0]?.outputTail).not.toContain('EPERM');
        expect(r.ok).toBe(true);
      });

      it.each(['worktrees folder', 'project folder'])('still refuses to list the %s', async (folder) => {
        const path = folder === 'worktrees folder' ? worktrees : join(worktrees, 'project');

        const r = await denied(`ls ${path}`);

        expect(r.ok).toBe(false);
        expect(r.runs[0]?.outputTail).not.toContain('T-3-a1');
      });

      it('still refuses to read or stat another attempt', async () => {
        expect((await denied(`cat ${join(sibling, 'secret')}`)).ok).toBe(false);
        expect((await denied(`stat ${sibling}`)).ok).toBe(false);
      });
    });

    it('handles a worktree path that needs escaping', async () => {
      const odd = join(tempDir(), 'odd "name" (x)', 'wt');
      await addAttemptWorktree(repoPath, odd, 'aiteam/T-2-a1', baseSha);
      writeFileSync(join(odd, 'a.txt'), 'x\n');
      await snapshotAttempt(repoPath, odd, 'work');

      const r = await checks({ worktree: odd, commands: ['echo a > inside.txt'] });

      expect(r.ok).toBe(true);
    });
  });
});

describe('runSandboxed', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = tempDir();
  });

  const sandboxed = (overrides: Partial<Parameters<typeof runSandboxed>[0]> = {}) =>
    runSandboxed({ worktree, commands: ['true'], denyRead: [], timeoutS: 30, onEvent: () => {}, ...overrides });

  async function withServer<T>(body: (connect: string, connected: () => boolean) => Promise<T>): Promise<T> {
    let connected = false;
    const server = createServer(() => {
      connected = true;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const script = `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(3))`;
      return await body(`node -e "${script}"`, () => connected);
    } finally {
      server.close();
    }
  }

  it('runSandboxed reports each command and denies network by default', async () => {
    const events: EventType[] = [];
    await withServer(async (connect, connected) => {
      const r = await sandboxed({ commands: ['echo one', connect], onEvent: (type) => events.push(type) });

      expect(r.ok).toBe(false);
      expect(r.runs.map((run) => run.exitCode)).toEqual([0, 3]);
      expect(r.runs[0]).toMatchObject({ command: 'echo one', outputTail: 'one\n' });
      expect(r.evidence).toContain('exited with 3');
      expect(connected()).toBe(false);
    });
    expect(events).toEqual(['check.started', 'check.finished', 'check.started', 'check.finished']);
  });

  it('runSandboxed allows network only when asked', async () => {
    await withServer(async (connect, connected) => {
      const r = await sandboxed({ commands: [connect], network: true });

      expect(r).toMatchObject({ ok: true, evidence: '' });
      expect(r.runs[0]!.exitCode).toBe(0);
      await until(async () => connected());
    });
  });

  it('runSandboxed keeps writes inside the worktree even with network', async () => {
    const outside = join(homedir(), `.aiteam-sandbox-probe-${process.pid}`);

    const r = await sandboxed({ commands: [`echo x > ${outside}`], network: true });

    expect(r.ok).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });

  it('runSandboxed stops at the abort signal', async () => {
    const controller = new AbortController();
    const running = sandboxed({ commands: ['sleep 30', 'echo never'], signal: controller.signal, onEvent: (type) => type === 'check.started' && setTimeout(() => controller.abort(), 50) });

    const r = await running;

    expect(r.ok).toBe(false);
    expect(r.runs.map((run) => run.command)).toEqual(['sleep 30']);
  });

  it('runSandboxed with no commands passes with no runs', async () => {
    expect(await sandboxed({ commands: [] })).toEqual({ ok: true, runs: [], evidence: '' });
  });
});
