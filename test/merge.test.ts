import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { advanceBaseBranch, mergeIntoBranch, snapshotState, syncBaseIntoIntegration } from '../src/git/merge.ts';
import { commitAll, makeRepo, porcelain, revParse, run, symbolicHead, tempDir } from './helpers/repo.ts';

const hooks = vi.hoisted(() => ({ beforeGit: undefined as ((args: string[]) => void) | undefined }));

vi.mock('../src/git/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git/git.ts')>();
  return {
    ...actual,
    git: async (cwd: string, args: string[]) => {
      hooks.beforeGit?.(args);
      return actual.git(cwd, args);
    },
  };
});

// A commit on top of parent, made away from the stakeholder's checkout.
function commitFrom(repo: string, parent: string, files: Record<string, string>, message = 'work'): string {
  const wt = join(tempDir('merge-wt-'), 'wt');
  run(repo, 'worktree', 'add', '--quiet', '--detach', wt, parent);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(wt, path, '..'), { recursive: true });
    writeFileSync(join(wt, path), content);
  }
  const sha = commitAll(wt, message);
  run(repo, 'worktree', 'remove', '--force', wt);
  return sha;
}

const isAncestor = (repo: string, older: string, newer: string): boolean => {
  try {
    run(repo, 'merge-base', '--is-ancestor', older, newer);
    return true;
  } catch {
    return false;
  }
};

describe('merges', () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    hooks.beforeGit = undefined;
    ({ path: repo, headSha: base } = await makeRepo());
    run(repo, 'branch', 'aiteam/m1');
  });

  describe('mergeIntoBranch', () => {
    it('merges a source into the target without touching HEAD, index or files', async () => {
      const sha = commitFrom(repo, base, { 'a.txt': 'a\n' });
      writeFileSync(join(repo, 'README.md'), 'a local edit\n');
      run(repo, 'add', 'README.md');
      writeFileSync(join(repo, 'scratch.txt'), 'untracked\n');
      const before = [await symbolicHead(repo), await revParse(repo), await porcelain(repo)];

      const result = await mergeIntoBranch(repo, { target: 'aiteam/m1', source: sha, message: 'merge M1-T-1' });

      expect(result.ok).toBe(true);
      expect([await symbolicHead(repo), await revParse(repo), await porcelain(repo)]).toEqual(before);
      expect(existsSync(join(repo, 'a.txt'))).toBe(false);
      expect(run(repo, 'show', 'aiteam/m1:a.txt')).toBe('a');
    });

    it('makes a two-parent merge commit', async () => {
      const first = commitFrom(repo, base, { 'a.txt': 'a\n' });
      const second = commitFrom(repo, base, { 'b.txt': 'b\n' });
      await mergeIntoBranch(repo, { target: 'aiteam/m1', source: first, message: 'merge a' });
      const before = await revParse(repo, 'aiteam/m1');

      const result = await mergeIntoBranch(repo, { target: 'aiteam/m1', source: second, message: 'merge b' });

      const head = await revParse(repo, 'aiteam/m1');
      expect(result).toEqual({ ok: true, sha: head, already: false });
      expect(run(repo, 'rev-list', '--parents', '-n', '1', head)).toBe(`${head} ${before} ${second}`);
      expect(run(repo, 'log', '-1', '--format=%s', head)).toBe('merge b');
      expect(run(repo, 'log', '-1', '--format=%an', head)).toBe('aiteam');
      expect(run(repo, 'show', 'aiteam/m1:a.txt')).toBe('a');
      expect(run(repo, 'show', 'aiteam/m1:b.txt')).toBe('b');
    });

    it('returns the conflicted paths and leaves the target where it was', async () => {
      const first = commitFrom(repo, base, { 'a.txt': 'one\n', 'clean.txt': 'c\n' });
      const second = commitFrom(repo, base, { 'a.txt': 'two\n', 'other.txt': 'o\n' });
      await mergeIntoBranch(repo, { target: 'aiteam/m1', source: first, message: 'merge one' });
      const before = await revParse(repo, 'aiteam/m1');

      const result = await mergeIntoBranch(repo, { target: 'aiteam/m1', source: second, message: 'merge two' });

      expect(result).toEqual({ ok: false, conflicts: ['a.txt'] });
      expect(await revParse(repo, 'aiteam/m1')).toBe(before);
    });

    it('reports already when the source is already merged', async () => {
      const sha = commitFrom(repo, base, { 'a.txt': 'a\n' });
      const first = await mergeIntoBranch(repo, { target: 'aiteam/m1', source: sha, message: 'merge' });
      const head = await revParse(repo, 'aiteam/m1');

      const again = await mergeIntoBranch(repo, { target: 'aiteam/m1', source: sha, message: 'merge' });

      expect(first).toMatchObject({ ok: true, already: false });
      expect(again).toEqual({ ok: true, sha: head, already: true });
      expect(await revParse(repo, 'aiteam/m1')).toBe(head);
    });

    it('survives the target moving between read and update', async () => {
      const sha = commitFrom(repo, base, { 'a.txt': 'a\n' });
      const moved = commitFrom(repo, base, { 'moved.txt': 'm\n' });
      hooks.beforeGit = (args) => {
        if (!args.includes('merge-tree')) return;
        hooks.beforeGit = undefined;
        run(repo, 'update-ref', 'refs/heads/aiteam/m1', moved);
      };

      const result = await mergeIntoBranch(repo, { target: 'aiteam/m1', source: sha, message: 'merge' });

      const head = await revParse(repo, 'aiteam/m1');
      expect(result).toEqual({ ok: true, sha: head, already: false });
      expect(isAncestor(repo, moved, head)).toBe(true);
      expect(isAncestor(repo, sha, head)).toBe(true);
    });

    it('gives up rather than overwrite a target that keeps moving', async () => {
      const sha = commitFrom(repo, base, { 'a.txt': 'a\n' });
      const moves = [commitFrom(repo, base, { 'x.txt': 'x\n' }), commitFrom(repo, base, { 'y.txt': 'y\n' })];
      hooks.beforeGit = (args) => {
        if (args.includes('merge-tree')) run(repo, 'update-ref', 'refs/heads/aiteam/m1', moves.shift() as string);
      };

      await expect(mergeIntoBranch(repo, { target: 'aiteam/m1', source: sha, message: 'merge' })).rejects.toThrow(/moved/);
    });

    it('keeps a checkout of the target in step, when the stakeholder is looking at it', async () => {
      const sha = commitFrom(repo, base, { 'a.txt': 'a\n' });
      run(repo, 'checkout', '-q', 'aiteam/m1');

      await mergeIntoBranch(repo, { target: 'aiteam/m1', source: sha, message: 'merge' });

      expect(await porcelain(repo)).toBe('');
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n');
    });

    it('says so when that checkout refuses', async () => {
      const sha = commitFrom(repo, base, { 'README.md': 'merged\n' });
      run(repo, 'checkout', '-q', 'aiteam/m1');
      writeFileSync(join(repo, 'README.md'), 'my edit\n');
      const before = await revParse(repo, 'aiteam/m1');

      await expect(mergeIntoBranch(repo, { target: 'aiteam/m1', source: sha, message: 'merge' })).rejects.toThrow(/aiteam\/m1/);

      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('my edit\n');
      expect(await revParse(repo, 'aiteam/m1')).toBe(before);
    });
  });

  describe('syncBaseIntoIntegration', () => {
    it('syncs a moved base branch into integration, and does nothing when it has not moved', async () => {
      const before = await revParse(repo, 'aiteam/m1');
      expect(await syncBaseIntoIntegration(repo, 1, 'main')).toEqual({ ok: true, sha: before, already: true });

      writeFileSync(join(repo, 'later.txt'), 'later\n');
      const later = commitAll(repo, 'the stakeholder commits');

      const moved = await syncBaseIntoIntegration(repo, 1, 'main');

      const head = await revParse(repo, 'aiteam/m1');
      expect(moved).toEqual({ ok: true, sha: head, already: false });
      expect(isAncestor(repo, later, head)).toBe(true);
    });

    it('returns the conflicts when base and integration disagree', async () => {
      await mergeIntoBranch(repo, { target: 'aiteam/m1', source: commitFrom(repo, base, { 'a.txt': 'team\n' }), message: 'merge' });
      writeFileSync(join(repo, 'a.txt'), 'stakeholder\n');
      commitAll(repo, 'the stakeholder commits');

      expect(await syncBaseIntoIntegration(repo, 1, 'main')).toEqual({ ok: false, conflicts: ['a.txt'] });
    });

    it('creates the integration branch if it is missing', async () => {
      run(repo, 'branch', '-D', 'aiteam/m1');
      expect(await syncBaseIntoIntegration(repo, 1, 'main')).toEqual({ ok: true, sha: base, already: true });
      expect(await revParse(repo, 'aiteam/m1')).toBe(base);
    });
  });

  describe('snapshotState', () => {
    let stateDir: string;
    let wtPath: string;

    beforeEach(() => {
      stateDir = tempDir('merge-state-');
      wtPath = join(tempDir('merge-snap-'), 'snapshot');
      mkdirSync(join(stateDir, 'artifacts', 'spec'), { recursive: true });
      writeFileSync(join(stateDir, 'artifacts', 'spec', 'SPEC-M1.md'), '# Spec\n');
    });

    it('snapshots artifacts into .aiteam as the last commit', async () => {
      mkdirSync(join(stateDir, 'memory'));
      writeFileSync(join(stateDir, 'memory', 'note.md'), 'remembered\n');
      writeFileSync(join(stateDir, 'not-copied.txt'), 'x\n');

      const { sha } = await snapshotState(repo, 1, stateDir, wtPath);

      expect(await revParse(repo, 'aiteam/m1')).toBe(sha);
      expect(sha).not.toBe(base);
      expect(run(repo, 'show', 'aiteam/m1:.aiteam/artifacts/spec/SPEC-M1.md')).toBe('# Spec');
      expect(run(repo, 'show', 'aiteam/m1:.aiteam/memory/note.md')).toBe('remembered');
      expect(run(repo, 'ls-tree', '--name-only', 'aiteam/m1:.aiteam').split('\n').sort()).toEqual(['artifacts', 'memory']);
      expect(existsSync(wtPath)).toBe(false);
      expect(run(repo, 'worktree', 'list')).not.toContain(wtPath);
    });

    it('does not touch the checkout', async () => {
      const before = [await symbolicHead(repo), await revParse(repo), await porcelain(repo)];
      await snapshotState(repo, 1, stateDir, wtPath);
      expect([await symbolicHead(repo), await revParse(repo), await porcelain(repo)]).toEqual(before);
      expect(existsSync(join(repo, '.aiteam'))).toBe(false);
    });

    it('snapshot is a no-op on a second run', async () => {
      const { sha } = await snapshotState(repo, 1, stateDir, wtPath);
      expect(await snapshotState(repo, 1, stateDir, wtPath)).toEqual({ sha });
      expect(await revParse(repo, 'aiteam/m1')).toBe(sha);
    });

    it('drops what is no longer in the state repo', async () => {
      writeFileSync(join(stateDir, 'artifacts', 'spec', 'SPEC-M2.md'), '# Two\n');
      await snapshotState(repo, 1, stateDir, wtPath);
      rmSync(join(stateDir, 'artifacts', 'spec', 'SPEC-M2.md'));

      await snapshotState(repo, 1, stateDir, wtPath);

      expect(run(repo, 'ls-tree', '-r', '--name-only', 'aiteam/m1:.aiteam')).toBe('artifacts/spec/SPEC-M1.md');
    });

    it('removes the temp worktree when the snapshot fails', async () => {
      const head = await revParse(repo, 'aiteam/m1');
      chmodSync(join(stateDir, 'artifacts'), 0o000);
      try {
        await expect(snapshotState(repo, 1, stateDir, wtPath)).rejects.toThrow();
      } finally {
        chmodSync(join(stateDir, 'artifacts'), 0o755);
      }
      expect(existsSync(wtPath)).toBe(false);
      expect(run(repo, 'worktree', 'list')).not.toContain(wtPath);
      expect(await revParse(repo, 'aiteam/m1')).toBe(head);
      await expect(snapshotState(repo, 1, stateDir, wtPath)).resolves.toMatchObject({ sha: expect.any(String) });
    });
  });

  describe('advanceBaseBranch', () => {
    let merged: string;

    beforeEach(async () => {
      merged = commitFrom(repo, base, { 'README.md': 'merged\n', 'feature.txt': 'feature\n' });
    });

    it('advances an unchecked-out base branch with compare-and-swap', async () => {
      run(repo, 'branch', 'develop');
      expect(await advanceBaseBranch(repo, 'develop', merged)).toEqual({ ok: true, sha: merged });
      expect(await revParse(repo, 'develop')).toBe(merged);
      expect(await revParse(repo, 'main')).toBe(base);
      expect(await porcelain(repo)).toBe('');
    });

    it('fast-forwards a checked-out base branch and updates its files', async () => {
      expect(await advanceBaseBranch(repo, 'main', merged)).toEqual({ ok: true, sha: merged });
      expect(await revParse(repo, 'main')).toBe(merged);
      expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
      expect(await porcelain(repo)).toBe('');
    });

    it('is safe to run again after a crash', async () => {
      await advanceBaseBranch(repo, 'main', merged);
      expect(await advanceBaseBranch(repo, 'main', merged)).toEqual({ ok: true, sha: merged });
    });

    it('keeps a dirty checkout: an unrelated edit survives the fast-forward', async () => {
      writeFileSync(join(repo, 'notes.txt'), 'mine');
      expect((await advanceBaseBranch(repo, 'main', merged)).ok).toBe(true);
      expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine');
    });

    it('refuses, with nothing half-done, when a dirty file overlaps', async () => {
      const tracked = join(repo, 'README.md');
      writeFileSync(tracked, 'my edit');

      expect(await advanceBaseBranch(repo, 'main', merged)).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringContaining('README.md') });

      expect(readFileSync(tracked, 'utf8')).toBe('my edit');
      expect(await revParse(repo, 'main')).toBe(base);
      expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    });

    it('refuses rather than stash, even when the stakeholder has autostash on', async () => {
      run(repo, 'config', 'merge.autoStash', 'true');
      writeFileSync(join(repo, 'README.md'), 'my edit');

      expect(await advanceBaseBranch(repo, 'main', merged)).toMatchObject({ ok: false, reason: 'refused' });

      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('my edit');
      expect(run(repo, 'stash', 'list')).toBe('');
    });

    it('reports moved when the stakeholder committed to base after the last sync', async () => {
      writeFileSync(join(repo, 'mine.txt'), 'mine\n');
      const theirs = commitAll(repo, 'the stakeholder commits');

      expect(await advanceBaseBranch(repo, 'main', merged)).toMatchObject({ ok: false, reason: 'moved' });

      expect(await revParse(repo, 'main')).toBe(theirs);
    });

    it('reports moved when an unchecked-out base moves at the last moment', async () => {
      run(repo, 'branch', 'develop');
      const late = commitFrom(repo, base, { 'late.txt': 'l\n' });
      const onTop = commitFrom(repo, merged, { 'top.txt': 't\n' });
      hooks.beforeGit = (args) => {
        if (!args.includes('update-ref')) return;
        hooks.beforeGit = undefined;
        run(repo, 'update-ref', 'refs/heads/develop', late);
      };

      expect(await advanceBaseBranch(repo, 'develop', onTop)).toMatchObject({ ok: false, reason: 'moved' });

      expect(await revParse(repo, 'develop')).toBe(late);
    });

    it('refuses when a merge of the stakeholder is in progress', async () => {
      const other = commitFrom(repo, base, { 'README.md': 'theirs\n' });
      writeFileSync(join(repo, 'README.md'), 'ours\n');
      commitAll(repo, 'the stakeholder commits');
      expect(() => run(repo, 'merge', other)).toThrow();
      const head = await revParse(repo);
      const onTop = commitFrom(repo, head, { 'feature.txt': 'feature\n' });

      expect(await advanceBaseBranch(repo, 'main', onTop)).toMatchObject({ ok: false, reason: 'refused' });

      expect(await revParse(repo)).toBe(head);
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
      run(repo, 'merge', '--abort');
    });

    it('refuses when the base is partway through a rebase', async () => {
      const other = commitFrom(repo, base, { 'README.md': 'theirs\n' });
      writeFileSync(join(repo, 'README.md'), 'ours\n');
      const mine = commitAll(repo, 'the stakeholder commits');
      const onTop = commitFrom(repo, mine, { 'feature.txt': 'feature\n' });
      expect(() => run(repo, 'rebase', other)).toThrow();

      expect(await advanceBaseBranch(repo, 'main', onTop)).toMatchObject({ ok: false, reason: 'refused', detail: expect.stringContaining('rebase') });

      expect(await revParse(repo, 'refs/heads/main')).toBe(mine);
      run(repo, 'rebase', '--abort');
      expect(await revParse(repo)).toBe(mine);
    });

    it('does not run the repo hooks', async () => {
      const marker = join(repo, 'hook-ran');
      const hook = join(repo, '.git', 'hooks', 'post-merge');
      mkdirSync(join(hook, '..'), { recursive: true });
      writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(hook, 0o755);
      // The hook is live: an ordinary merge runs it.
      const first = commitFrom(repo, base, { 'one.txt': '1\n' });
      run(repo, 'merge', '--ff-only', first);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      const second = commitFrom(repo, first, { 'two.txt': '2\n' });

      expect((await advanceBaseBranch(repo, 'main', second)).ok).toBe(true);

      expect(existsSync(join(repo, 'two.txt'))).toBe(true);
      expect(existsSync(marker)).toBe(false);
    });

    it('fast-forwards the base in a linked worktree when that is where it is checked out', async () => {
      run(repo, 'checkout', '-q', '--detach');
      const linked = join(tempDir('merge-linked-'), 'wt');
      run(repo, 'worktree', 'add', '--quiet', linked, 'main');

      expect(await advanceBaseBranch(repo, 'main', merged)).toEqual({ ok: true, sha: merged });

      expect(readFileSync(join(linked, 'feature.txt'), 'utf8')).toBe('feature\n');
      expect(await porcelain(linked)).toBe('');
      expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    });

    it('is not fooled by a worktree whose folder has gone', async () => {
      run(repo, 'checkout', '-q', '--detach');
      const linked = join(tempDir('merge-linked-'), 'wt');
      run(repo, 'worktree', 'add', '--quiet', linked, 'main');
      rmSync(linked, { recursive: true });

      expect(await advanceBaseBranch(repo, 'main', merged)).toEqual({ ok: true, sha: merged });
      expect(await revParse(repo, 'main')).toBe(merged);
    });
  });
});
