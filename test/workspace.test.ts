import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addAttemptWorktree,
  changedPaths,
  ensureIntegrationBranch,
  prepareRepo,
  pruneGitWorktrees,
  removeAttemptWorktree,
  snapshotAttempt,
} from '../src/git/workspace.ts';
import { commitAll, initRepo, makeRepo, porcelain, revParse, run, symbolicHead, tempDir } from './helpers/repo.ts';

const BRANCH = 'aiteam/attempt/T-1-a1';

function installHook(repo: string, name: string, body: string): void {
  const path = join(repo, '.git', 'hooks', name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe('attempt worktrees', () => {
  let repo: string;
  let base: string;
  let wt: string;

  beforeEach(async () => {
    const made = await makeRepo();
    repo = made.path;
    base = made.headSha;
    wt = join(tempDir(), 'nested', 'T-1-a1');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  it('leaves a working repo byte-identical through a full attempt', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'committed\n');
    writeFileSync(join(repo, 'staged.txt'), 'committed\n');
    commitAll(repo, 'more files');
    run(repo, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    run(repo, 'add', 'staged.txt');
    writeFileSync(join(repo, 'dirty.txt'), 'modified\n');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
    const before = [await porcelain(repo), await symbolicHead(repo), await revParse(repo)];
    expect(before[0]).toContain('M  staged.txt');

    const { headSha } = await ensureIntegrationBranch(repo, 1, 'main');
    await addAttemptWorktree(repo, wt, BRANCH, headSha);
    writeFileSync(join(wt, 'new.txt'), 'x');
    await snapshotAttempt(wt, 'aiteam: T-1 a1');
    await removeAttemptWorktree(repo, wt, BRANCH);

    expect([await porcelain(repo), await symbolicHead(repo), await revParse(repo)]).toEqual(before);
    expect(readFileSync(join(repo, 'dirty.txt'), 'utf8')).toBe('modified\n');
  });

  it('worktree never contains uncommitted stakeholder changes', async () => {
    writeFileSync(join(repo, 'README.md'), 'uncommitted edit\n');
    writeFileSync(join(repo, 'secret.env'), 'untracked\n');

    await addAttemptWorktree(repo, wt, BRANCH, base);

    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('# test repo\n');
    expect(existsSync(join(wt, 'secret.env'))).toBe(false);
  });

  it('creates the integration branch once and names it after the milestone', async () => {
    const first = await ensureIntegrationBranch(repo, 3, 'main');
    expect(first).toEqual({ branch: 'aiteam/m3', headSha: base });
    expect(await revParse(repo, 'refs/heads/aiteam/m3')).toBe(base);
  });

  it('does not move the integration branch when main advances', async () => {
    const first = await ensureIntegrationBranch(repo, 1, 'main');
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    const advanced = commitAll(repo, 'main moves on');

    const second = await ensureIntegrationBranch(repo, 1, 'main');

    expect(advanced).not.toBe(base);
    expect(second.headSha).toBe(first.headSha);
  });

  it('fails clearly when the base branch does not exist', async () => {
    await expect(ensureIntegrationBranch(repo, 1, 'develop')).rejects.toThrow(/develop/);
  });

  it('snapshots modified, deleted and untracked files, honouring .gitignore', async () => {
    writeFileSync(join(repo, 'edited.txt'), 'one\n');
    writeFileSync(join(repo, 'deleted.txt'), 'one\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored.log\n');
    const start = commitAll(repo, 'files to change');
    await addAttemptWorktree(repo, wt, BRANCH, start);

    writeFileSync(join(wt, 'edited.txt'), 'two\n');
    rmSync(join(wt, 'deleted.txt'));
    writeFileSync(join(wt, 'new.txt'), 'new\n');
    writeFileSync(join(wt, 'ignored.log'), 'noise\n');
    const { headSha } = await snapshotAttempt(wt, 'aiteam: T-1 a1');

    expect(headSha).toBe(await revParse(wt));
    expect(headSha).not.toBe(start);
    expect((await changedPaths(wt, start)).sort()).toEqual(['deleted.txt', 'edited.txt', 'new.txt']);
  });

  it('makes no commit when the worker changed nothing', async () => {
    await addAttemptWorktree(repo, wt, BRANCH, base);

    const { headSha } = await snapshotAttempt(wt, 'aiteam: T-1 a1');

    expect(headSha).toBe(base);
    expect(await changedPaths(wt, base)).toEqual([]);
  });

  it('commits as the engine, not as the stakeholder', async () => {
    await addAttemptWorktree(repo, wt, BRANCH, base);
    writeFileSync(join(wt, 'new.txt'), 'x');

    await snapshotAttempt(wt, 'aiteam: T-1 a1');

    expect(run(wt, 'log', '-1', '--format=%an <%ae>')).toBe('aiteam <aiteam@localhost>');
  });

  it('snapshot survives a failing repo pre-commit hook', async () => {
    installHook(repo, 'pre-commit', 'exit 1');
    await addAttemptWorktree(repo, wt, BRANCH, base);
    writeFileSync(join(wt, 'new.txt'), 'x');

    const { headSha } = await snapshotAttempt(wt, 'aiteam: T-1 a1');

    expect(headSha).not.toBe(base);
  });

  it('snapshot survives the stakeholder turning on commit signing', async () => {
    run(repo, 'config', 'commit.gpgsign', 'true');
    run(repo, 'config', 'gpg.program', '/usr/bin/false');
    await addAttemptWorktree(repo, wt, BRANCH, base);
    writeFileSync(join(wt, 'new.txt'), 'x');

    const { headSha } = await snapshotAttempt(wt, 'aiteam: T-1 a1');

    expect(headSha).not.toBe(base);
  });

  it('never runs the repo hooks while creating a worktree', async () => {
    const marker = join(tempDir(), 'hook-ran');
    installHook(repo, 'post-checkout', `touch "${marker}"`);
    installHook(repo, 'reference-transaction', `touch "${marker}"`);

    await addAttemptWorktree(repo, wt, BRANCH, base);
    await removeAttemptWorktree(repo, wt, BRANCH);

    expect(existsSync(marker)).toBe(false);
  });

  it('reports both sides of a rename', async () => {
    writeFileSync(join(repo, 'a.txt'), 'content long enough to count as a rename\n');
    const start = commitAll(repo, 'a');
    await addAttemptWorktree(repo, wt, BRANCH, start);

    renameSync(join(wt, 'a.txt'), join(wt, 'b.txt'));
    await snapshotAttempt(wt, 'rename');
    const paths = await changedPaths(wt, start);

    expect(paths.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('reports unusual file names exactly', async () => {
    await addAttemptWorktree(repo, wt, BRANCH, base);
    mkdirSync(join(wt, 'with space'));
    writeFileSync(join(wt, 'with space', 'naïve "quoted".txt'), 'x');

    await snapshotAttempt(wt, 'names');

    expect(await changedPaths(wt, base)).toEqual(['with space/naïve "quoted".txt']);
  });

  it('removeAttemptWorktree is idempotent and deletes the branch', async () => {
    await addAttemptWorktree(repo, wt, BRANCH, base);

    await removeAttemptWorktree(repo, wt, BRANCH);
    await removeAttemptWorktree(repo, wt, BRANCH);

    expect(existsSync(wt)).toBe(false);
    expect(run(repo, 'branch', '--list', BRANCH)).toBe('');
    expect(run(repo, 'worktree', 'list', '--porcelain')).not.toContain('T-1-a1');
  });

  it('removes a worktree whose .git file the worker deleted', async () => {
    await addAttemptWorktree(repo, wt, BRANCH, base);
    rmSync(join(wt, '.git'));

    await removeAttemptWorktree(repo, wt, BRANCH);

    expect(existsSync(wt)).toBe(false);
    expect(run(repo, 'branch', '--list', BRANCH)).toBe('');
  });

  it('leaves the branch alone while the stakeholder has it checked out', async () => {
    await addAttemptWorktree(repo, wt, BRANCH, base);
    rmSync(wt, { recursive: true, force: true });
    run(repo, 'worktree', 'prune');
    run(repo, 'checkout', '-q', BRANCH);

    await removeAttemptWorktree(repo, wt, BRANCH);

    expect(await symbolicHead(repo)).toBe(`refs/heads/${BRANCH}`);
  });

  it('refuses to remove a path that holds the repository', async () => {
    await expect(removeAttemptWorktree(repo, repo, BRANCH)).rejects.toThrow(/Refusing to remove/);
    await expect(removeAttemptWorktree(repo, join(repo, '..'), BRANCH)).rejects.toThrow(/Refusing to remove/);
    expect(await revParse(repo)).toBe(base);
  });

  it('prunes metadata of a worktree whose directory has gone', async () => {
    await addAttemptWorktree(repo, wt, BRANCH, base);
    rmSync(wt, { recursive: true, force: true });
    expect(run(repo, 'worktree', 'list', '--porcelain')).toContain('T-1-a1');

    await pruneGitWorktrees(repo);

    expect(run(repo, 'worktree', 'list', '--porcelain')).not.toContain('T-1-a1');
  });
});

describe('prepareRepo', () => {
  it('non-git path without create throws', async () => {
    const dir = tempDir();
    await expect(prepareRepo(dir, { create: false })).rejects.toThrow(/not a git repository/);
  });

  it('a missing path without create throws', async () => {
    const dir = join(tempDir(), 'missing');
    await expect(prepareRepo(dir, { create: false })).rejects.toThrow(/not a git repository/);
    expect(existsSync(dir)).toBe(false);
  });

  it('create makes a repo with a root commit', async () => {
    const dir = join(tempDir(), 'new', 'project');

    const { baseBranch } = await prepareRepo(dir, { create: true });

    expect(run(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(await symbolicHead(dir)).toBe(`refs/heads/${baseBranch}`);
  });

  it('an existing repo with no commits gets an empty root commit', async () => {
    const dir = tempDir();
    initRepo(dir);
    writeFileSync(join(dir, 'staged.txt'), 'staged\n');
    run(dir, 'add', 'staged.txt');
    writeFileSync(join(dir, 'untracked.txt'), 'untracked\n');

    const { baseBranch } = await prepareRepo(dir, { create: false });

    expect(baseBranch).toBe('main');
    expect(run(dir, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(run(dir, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
    expect(await porcelain(dir)).toBe('A  staged.txt\n?? untracked.txt');
  });

  it('an existing repo keeps its history and reports its current branch', async () => {
    const { path, headSha } = await makeRepo();
    run(path, 'checkout', '-q', '-b', 'develop');

    const { baseBranch } = await prepareRepo(path, { create: false });

    expect(baseBranch).toBe('develop');
    expect(await revParse(path)).toBe(headSha);
  });

  it('refuses a detached HEAD instead of guessing a base branch', async () => {
    const { path, headSha } = await makeRepo();
    run(path, 'checkout', '-q', '--detach', headSha);

    await expect(prepareRepo(path, { create: false })).rejects.toThrow(/detached HEAD/);
  });

  it('does not treat a folder inside another repo as that repo', async () => {
    const { path, headSha } = await makeRepo();
    const inner = join(path, 'sub');
    mkdirSync(inner);

    await expect(prepareRepo(inner, { create: false })).rejects.toThrow(/not a git repository/);

    await prepareRepo(inner, { create: true });
    expect(await revParse(path)).toBe(headSha);
    expect(run(inner, 'rev-parse', '--show-toplevel')).toBe(inner);
  });
});
