import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../git/git.ts';
import { addAttemptWorktree, removeAttemptWorktree } from '../../git/workspace.ts';
import { workerDenyRead, worktreePath } from '../../paths.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import { buildSite, entryPath, playProfile, siteRoot } from './play-gate.ts';

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
  // Nothing may be served from a checkout that is about to go.
  deps.tryServer?.unmount(project.name, n);
  const { worktree, branch } = tryWorktree(deps, project, n);
  await removeAttemptWorktree(project.repo_path, worktree, branch);
}

// What CP4's Try it shows: a link to the milestone's build, or the checkout when there is nothing the engine can serve.
// A build that fails here doesn't hold CP4: QA and the play gate already passed this head, and the stakeholder can still look.
export async function offerTry(deps: EngineDeps, project: ProjectRow, n: number, headSha: string): Promise<{ value: string; link: boolean }> {
  const { tryServer } = deps;
  // The last CP4's link must not go on serving a checkout that is about to be replaced, or a build that fails below.
  tryServer?.unmount(project.name, n);
  const worktree = await ensureTryWorktree(deps, project, n, headSha);
  if (!tryServer) return { value: worktree, link: false };
  const { profile, play } = await playProfile(deps, project);
  if (play === null) return { value: worktree, link: false };

  const env = { worktree, repoPath: project.repo_path, denyRead: workerDenyRead(deps.paths, homedir()), timeoutS: deps.config.checkTimeoutS };
  const built = await buildSite(env, profile, { setup: true });
  let why: string;
  if (built.ok) {
    try {
      return { value: tryServer.mount(project.name, n, built.root) + entryPath(play), link: true };
    } catch (err) {
      why = `play.root ${play.root} could not be served: ${(err as Error).message}`;
    }
  } else {
    why = built.why;
  }
  return { value: `The build failed here: ${why}. The checkout is at ${worktree}.`, link: false };
}

// The try server keeps its mounts only in memory, so after a restart a pending CP4's link answers 404 until this serves it
// again. It never builds: the build CP4 offered is the one to serve, and the root is checked again since something the
// build left running may have changed it.
export async function serveTryAgain(deps: EngineDeps, project: ProjectRow, n: number): Promise<void> {
  const { tryServer, store } = deps;
  if (!tryServer || tryServer.mounted(project.name, n)) return;
  // A CP4 that offered the checkout, because its build failed, has nothing to serve.
  const cp4 = (await store.inboxByPrefix(project.id, `cp4:M${n}:`)).filter(({ state }) => state === 'pending').at(-1);
  const offered = cp4?.evidence.find(({ label }) => label === 'Try it')?.value;
  if (!offered?.startsWith(tryServer.url)) return;
  const { play } = await playProfile(deps, project);
  if (play === null) return;
  const root = await siteRoot(tryWorktree(deps, project, n).worktree, play.root);
  if (!root.ok) return;
  try {
    tryServer.mount(project.name, n, root.root);
  } catch {
    // The link answers 404, as it would for a root the check refused; CP4 still stands.
  }
}
