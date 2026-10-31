import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isWithin } from '../paths.ts';
import { commitStaged, ENGINE_CONFIG, engineGit, git, gitOk } from './git.ts';

// The stakeholder may be working in the target repo at any moment, so the engine never moves its HEAD,
// index or files: branches come from `git branch`, checkouts only from `git worktree add`.

// A folder inside some other repo is not that repo: `git rev-parse` alone would say it is.
async function isRepoRoot(path: string): Promise<boolean> {
  const isDir = await stat(path).then((s) => s.isDirectory(), () => false);
  if (!isDir) return false;
  const top = await git(path, ['rev-parse', '--show-toplevel']);
  return top.code === 0 && (await realpath(top.stdout.trim())) === (await realpath(path));
}

// Plumbing rather than `git commit`, which would also commit whatever the stakeholder has staged.
async function createRootCommit(repoPath: string, branch: string): Promise<void> {
  const tree = await engineGit(repoPath, ['hash-object', '-w', '-t', 'tree', '/dev/null']);
  const sha = await engineGit(repoPath, ['commit-tree', tree, '-m', 'aiteam: root commit']);
  await engineGit(repoPath, ['update-ref', `refs/heads/${branch}`, sha, '']);
}

export async function prepareRepo(repoPath: string, opts: { create: boolean }): Promise<{ baseBranch: string }> {
  if (!(await isRepoRoot(repoPath))) {
    if (!opts.create) throw new Error(`${repoPath} is not a git repository`);
    await mkdir(repoPath, { recursive: true });
    await engineGit(repoPath, ['init', '-q']);
  }

  const head = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.code !== 0) {
    throw new Error(`${repoPath} is on a detached HEAD: check out the branch this project should build on`);
  }
  const baseBranch = head.stdout.trim();

  const commit = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (commit.code !== 0) await createRootCommit(repoPath, baseBranch);
  return { baseBranch };
}

// Attempts start side by side and the first to reach a milestone creates its branch, so finding it missing and
// creating it must not interleave. Only the daemon runs this, so a queue in this process is enough.
const branchQueues = new Map<string, Promise<unknown>>();

export function ensureIntegrationBranch(
  repoPath: string,
  milestone: number,
  baseBranch: string,
): Promise<{ branch: string; headSha: string }> {
  const work = (branchQueues.get(repoPath) ?? Promise.resolve()).then(() => findOrCreateBranch(repoPath, milestone, baseBranch));
  branchQueues.set(repoPath, work.catch(() => {}));
  return work;
}

async function findOrCreateBranch(repoPath: string, milestone: number, baseBranch: string): Promise<{ branch: string; headSha: string }> {
  const branch = `aiteam/m${milestone}`;
  const existing = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (existing.code === 0) return { branch, headSha: existing.stdout.trim() };

  const base = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}^{commit}`]);
  if (base.code !== 0) throw new Error(`Base branch ${baseBranch} not found in ${repoPath}`);
  const headSha = base.stdout.trim();
  await engineGit(repoPath, ['branch', branch, headSha]);
  return { branch, headSha };
}

export async function addAttemptWorktree(repoPath: string, wtPath: string, branch: string, baseSha: string): Promise<void> {
  await mkdir(dirname(wtPath), { recursive: true });
  await engineGit(repoPath, ['branch', branch, baseSha]);
  await engineGit(repoPath, ['worktree', 'add', '--quiet', wtPath, branch]);
}

// A worker can rewrite anything in its worktree, .git included, and engine git runs outside the sandbox.
// A planted .git would run its config's filters here or aim the commit elsewhere, so the attempt's git
// dir is found from the repo's side, and git is told where it is instead of reading the worktree's .git.
async function attemptLocation(repoPath: string, wtPath: string): Promise<string[]> {
  const common = resolve(repoPath, await gitOk(repoPath, ['rev-parse', '--git-common-dir']));
  const adminRoot = join(common, 'worktrees');
  const expected = join(await realpath(wtPath), '.git');
  for (const name of await readdir(adminRoot).catch(() => [])) {
    const adminDir = join(adminRoot, name);
    const pointer = await readFile(join(adminDir, 'gitdir'), 'utf8').catch(() => null);
    if (pointer !== null && resolve(adminDir, pointer.trim()) === expected) {
      return [`--git-dir=${adminDir}`, `--work-tree=${wtPath}`];
    }
  }
  throw new Error(`${wtPath} is not a worktree of ${repoPath}`);
}

export async function snapshotAttempt(repoPath: string, wtPath: string, message: string): Promise<{ headSha: string }> {
  const location = await attemptLocation(repoPath, wtPath);
  await engineGit(wtPath, [...location, 'add', '-A']);
  return { headSha: await commitStaged(wtPath, message, location) };
}

export async function changedPaths(repoPath: string, wtPath: string, baseSha: string): Promise<string[]> {
  const location = await attemptLocation(repoPath, wtPath);
  const out = await gitOk(wtPath, [...location, 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', baseSha, 'HEAD']);
  return out.split('\0').filter(Boolean);
}

export async function removeAttemptWorktree(repoPath: string, wtPath: string, branch: string): Promise<void> {
  if (isWithin(resolve(wtPath), resolve(repoPath))) {
    throw new Error(`Refusing to remove ${wtPath}: it holds the repository ${repoPath}`);
  }
  // Fails if the worktree has already gone or its .git file was deleted; the rm below covers both.
  await git(repoPath, [...ENGINE_CONFIG, 'worktree', 'remove', '--force', wtPath]);
  await rm(wtPath, { recursive: true, force: true });
  await pruneGitWorktrees(repoPath);
  // Fails if the branch has already gone or the stakeholder has it checked out; both are fine to leave.
  await git(repoPath, [...ENGINE_CONFIG, 'branch', '-D', branch]);
}

export async function pruneGitWorktrees(repoPath: string): Promise<void> {
  await engineGit(repoPath, ['worktree', 'prune']);
}
