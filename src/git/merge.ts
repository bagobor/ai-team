import { existsSync } from 'node:fs';
import { cp, lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ENGINE_CONFIG, engineGit, git, gitOk } from './git.ts';
import { inTurn } from './state-repo.ts';
import { addAttemptWorktree, ensureIntegrationBranch, inRepoTurn, linkedLocation, removeAttemptWorktree, snapshotAttempt } from './workspace.ts';

export type MergeResult = { ok: true; sha: string; already: boolean } | { ok: false; conflicts: string[] };
export type AdvanceResult = { ok: true; sha: string } | { ok: false; reason: 'moved' | 'refused'; detail: string };

const STATE_FOLDERS = ['artifacts', 'memory'];

const headOf = (repo: string, ref: string) => gitOk(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);

async function isAncestor(repo: string, older: string, newer: string): Promise<boolean> {
  const { code, stderr } = await git(repo, ['merge-base', '--is-ancestor', older, newer]);
  if (code > 1) throw new Error(`git merge-base failed in ${repo} (exit ${code}): ${stderr.trim()}`);
  return code === 0;
}

// `git worktree list` shows a branch being rebased as detached. Read from the repo's side: an attempt's own .git can't be trusted.
async function isBeingRebased(repo: string, ref: string): Promise<boolean> {
  const common = resolve(repo, await gitOk(repo, ['rev-parse', '--git-common-dir']));
  const linked = await readdir(join(common, 'worktrees')).catch(() => []);
  for (const dir of [common, ...linked.map((name) => join(common, 'worktrees', name))]) {
    for (const kind of ['rebase-merge', 'rebase-apply']) {
      const head = await readFile(join(dir, kind, 'head-name'), 'utf8').catch(() => null);
      if (head?.trim() === ref) return true;
    }
  }
  return false;
}

// The main worktree is listed first. A linked one is told where its git dir is, so its own .git is never read.
async function checkoutOf(repo: string, ref: string): Promise<{ path: string; location: string[] } | null> {
  const listing = await gitOk(repo, ['worktree', 'list', '--porcelain']);
  for (const [index, block] of listing.split('\n\n').entries()) {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (path && lines.includes(`branch ${ref}`) && existsSync(path)) return { path, location: index === 0 ? [] : await linkedLocation(repo, path) };
  }
  return null;
}

// Moving the ref under a checkout would leave its files looking like they undo the move, so a checkout is
// fast-forwarded instead. Git refuses that over a conflicting edit or an unfinished merge, and nothing has changed.
async function moveBranch(repo: string, branch: string, to: string, from: string): Promise<{ ok: true } | { ok: false; reason: 'moved' | 'refused'; detail: string }> {
  const ref = `refs/heads/${branch}`;
  if (await isBeingRebased(repo, ref)) return { ok: false, reason: 'refused', detail: `A rebase of ${branch} is in progress` };

  const checkout = await checkoutOf(repo, ref);
  if (!checkout) {
    const swapped = await git(repo, [...ENGINE_CONFIG, 'update-ref', ref, to, from]);
    return swapped.code === 0 ? { ok: true } : { ok: false, reason: 'moved', detail: swapped.stderr.trim() };
  }
  const merged = await git(checkout.path, [...ENGINE_CONFIG, ...checkout.location, 'merge', '--ff-only', '--no-autostash', to]);
  if (merged.code === 0) return { ok: true };
  return { ok: false, reason: (await headOf(repo, ref)) === from ? 'refused' : 'moved', detail: merged.stderr.trim() };
}

function conflictedPaths(mergeTreeOutput: string): string[] {
  const lines = mergeTreeOutput.split('\n');
  const end = lines.indexOf('', 1);
  return lines.slice(1, end === -1 ? undefined : end);
}

export function mergeIntoBranch(repo: string, { target, source, message }: { target: string; source: string; message: string }): Promise<MergeResult> {
  return inRepoTurn(repo, async () => {
    for (let tries = 0; tries < 2; tries += 1) {
      const targetSha = await headOf(repo, `refs/heads/${target}`);
      if (await isAncestor(repo, source, targetSha)) return { ok: true, sha: targetSha, already: true };

      const merged = await git(repo, [...ENGINE_CONFIG, '-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', targetSha, source]);
      if (merged.code === 1) return { ok: false, conflicts: conflictedPaths(merged.stdout) };
      if (merged.code !== 0) throw new Error(`git merge-tree failed in ${repo} (exit ${merged.code}): ${merged.stderr.trim()}`);

      const tree = merged.stdout.split('\n')[0] as string;
      const sha = await engineGit(repo, ['commit-tree', tree, '-p', targetSha, '-p', source, '-m', message]);
      const moved = await moveBranch(repo, target, sha, targetSha);
      if (moved.ok) return { ok: true, sha, already: false };
      if (moved.reason === 'refused') throw new Error(`Merging into ${target}: ${moved.detail}`);
    }
    throw new Error(`${target} moved twice during a merge of ${source}`);
  });
}

export async function syncBaseIntoIntegration(repo: string, milestone: number, baseBranch: string): Promise<MergeResult> {
  const { branch } = await ensureIntegrationBranch(repo, milestone, baseBranch);
  return mergeIntoBranch(repo, { target: branch, source: `refs/heads/${baseBranch}`, message: `aiteam: merge ${baseBranch} into ${branch}` });
}

async function copyState(stateDir: string, wtPath: string): Promise<void> {
  // The branch holds what workers committed. A symlink at .aiteam would aim this rm and cp outside the worktree.
  const root = join(wtPath, '.aiteam');
  const found = await lstat(root).catch(() => null);
  if (found && !found.isDirectory()) await rm(root);
  for (const folder of STATE_FOLDERS) {
    const copy = join(root, folder);
    await rm(copy, { recursive: true, force: true });
    if (existsSync(join(stateDir, folder))) await cp(join(stateDir, folder), copy, { recursive: true });
  }
}

export function snapshotState(repo: string, milestone: number, stateDir: string, wtPath: string): Promise<{ sha: string }> {
  const target = `aiteam/m${milestone}`;
  const tempBranch = `aiteam/snapshot-m${milestone}`;
  return inRepoTurn(repo, async () => {
    const head = await headOf(repo, `refs/heads/${target}`);
    // What an earlier run left, if the daemon died during it.
    await removeAttemptWorktree(repo, wtPath, tempBranch);
    await addAttemptWorktree(repo, wtPath, tempBranch, head);
    try {
      await inTurn(stateDir, () => copyState(stateDir, wtPath));
      const { headSha } = await snapshotAttempt(repo, wtPath, `aiteam: snapshot milestone ${milestone}`);
      if (headSha === head) return { sha: head };
      const moved = await moveBranch(repo, target, headSha, head);
      if (!moved.ok) throw new Error(`Snapshotting into ${target}: ${moved.detail}`);
      return { sha: headSha };
    } finally {
      await removeAttemptWorktree(repo, wtPath, tempBranch);
    }
  });
}

export function advanceBaseBranch(repo: string, baseBranch: string, sha: string): Promise<AdvanceResult> {
  return inRepoTurn(repo, async () => {
    const ref = `refs/heads/${baseBranch}`;
    if (!(await isAncestor(repo, ref, sha))) return { ok: false, reason: 'moved', detail: `${baseBranch} has commits that ${sha} does not` };
    const moved = await moveBranch(repo, baseBranch, sha, await headOf(repo, ref));
    return moved.ok ? { ok: true, sha } : moved;
  });
}
