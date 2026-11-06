import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../git/git.ts';
import { addAttemptWorktree, removeAttemptWorktree } from '../../git/workspace.ts';
import { worktreePath } from '../../paths.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';

// Where the stakeholder tries a milestone before approving it. It is outside their repo, so their own checkout stays as it is, and the branch name keeps it apart from smoke and attempt branches.
export function tryWorktree({ paths }: EngineDeps, project: ProjectRow, n: number): { worktree: string; branch: string } {
  return { worktree: worktreePath(paths, project.name, `M${n}-try`, 1), branch: `aiteam/try/M${n}` };
}

// CP4 can be raised again for the same head, so a checkout whose HEAD hasn't moved is left as it is. A commit made inside it moves its HEAD, and the next call replaces it, as it does for a head that moved.
export async function ensureTryWorktree(deps: EngineDeps, project: ProjectRow, n: number, headSha: string): Promise<string> {
  const { worktree, branch } = tryWorktree(deps, project, n);
  // The head comes from the repo's side: whatever builds in the checkout can rewrite its .git, and git run from there would trust it (see linkedLocation).
  const tip = await git(project.repo_path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (existsSync(join(worktree, '.git')) && tip.code === 0 && tip.stdout.trim() === headSha) return worktree;
  await removeAttemptWorktree(project.repo_path, worktree, branch);
  await addAttemptWorktree(project.repo_path, worktree, branch, headSha);
  return worktree;
}

export async function removeTryWorktree(deps: EngineDeps, project: ProjectRow, n: number): Promise<void> {
  const { worktree, branch } = tryWorktree(deps, project, n);
  await removeAttemptWorktree(project.repo_path, worktree, branch);
}
