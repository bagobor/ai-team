import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tempDir(prefix = 'aiteam-test-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function initRepo(path: string): void {
  run(path, 'init', '-q', '-b', 'main');
  run(path, 'config', 'user.name', 'Stakeholder');
  run(path, 'config', 'user.email', 'stakeholder@example.com');
}

export function commitAll(path: string, message: string): string {
  run(path, 'add', '-A');
  run(path, 'commit', '-q', '-m', message);
  return run(path, 'rev-parse', 'HEAD');
}

export async function makeRepo(): Promise<{ path: string; headSha: string }> {
  const path = tempDir();
  initRepo(path);
  writeFileSync(join(path, 'README.md'), '# test repo\n');
  return { path, headSha: commitAll(path, 'initial') };
}

// A commit on a branch past the current one, made in a throwaway worktree so the repo's own checkout, index and HEAD stay as they are.
export async function commitOnBranch(repo: string, branch: string, files: Record<string, string>): Promise<string> {
  const exists = run(repo, 'branch', '--list', branch) !== '';
  const home = tempDir('aiteam-branch-');
  const wt = join(home, 'wt');
  run(repo, 'worktree', 'add', '-q', ...(exists ? [wt, branch] : ['-b', branch, wt]));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(wt, path)), { recursive: true });
      writeFileSync(join(wt, path), content);
    }
    return commitAll(wt, `commit on ${branch}`);
  } finally {
    run(repo, 'worktree', 'remove', '--force', wt);
    rmSync(home, { recursive: true, force: true });
  }
}

export const porcelain = async (cwd: string): Promise<string> => run(cwd, 'status', '--porcelain=v1');
export const symbolicHead = async (cwd: string): Promise<string> => run(cwd, 'symbolic-ref', 'HEAD');
export const revParse = async (cwd: string, ref = 'HEAD'): Promise<string> => run(cwd, 'rev-parse', ref);
