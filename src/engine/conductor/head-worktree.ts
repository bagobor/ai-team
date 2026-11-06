import { homedir } from 'node:os';
import type { CommandEnv } from '../../checks/run-checks.ts';
import { addAttemptWorktree, ensureIntegrationBranch, removeAttemptWorktree } from '../../git/workspace.ts';
import { workerDenyRead, worktreePath } from '../../paths.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';

// Each names the branch aiteam/<purpose>/M<n>, which the start-up sweep must also know (TEMP_BRANCH in git/workspace.ts)
// to clear one a crash left behind.
export type HeadPurpose = 'smoke' | 'play';

// The sandbox a ticket gets, for a command the engine runs in one of its own checkouts of the project.
export const checkoutEnv = (deps: EngineDeps, project: ProjectRow, worktree: string): CommandEnv => ({
  worktree,
  repoPath: project.repo_path,
  denyRead: workerDenyRead(deps.paths, homedir()),
  timeoutS: deps.config.checkTimeoutS,
});

// A check of the integration head runs in a checkout of its own, with the sandbox a ticket gets, and leaves nothing behind.
// Every git call goes through the workspace helpers, from the repo's side: what runs in the checkout can rewrite its .git,
// and git run from inside it would trust that.
export async function withHeadWorktree<T>(
  deps: EngineDeps,
  project: ProjectRow,
  n: number,
  purpose: HeadPurpose,
  run: (env: CommandEnv, headSha: string) => Promise<T>,
): Promise<T> {
  const { headSha } = await ensureIntegrationBranch(project.repo_path, n, project.base_branch);
  const worktree = worktreePath(deps.paths, project.name, `M${n}-${purpose}`, 1);
  const branch = `aiteam/${purpose}/M${n}`;
  // A crash can leave the last one behind, at an older head.
  await removeAttemptWorktree(project.repo_path, worktree, branch);
  await addAttemptWorktree(project.repo_path, worktree, branch, headSha);
  try {
    return await run(checkoutEnv(deps, project, worktree), headSha);
  } finally {
    await removeAttemptWorktree(project.repo_path, worktree, branch);
  }
}
