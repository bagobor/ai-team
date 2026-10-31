import { execFile } from 'node:child_process';

export type GitResult = { stdout: string; stderr: string; code: number };

// Engine writes never run the repo's hooks or signing setup, and never borrow the stakeholder's identity.
export const ENGINE_CONFIG = [
  '-c',
  'user.name=aiteam',
  '-c',
  'user.email=aiteam@localhost',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.fsmonitor=false',
];

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// A GIT_DIR or GIT_INDEX_FILE inherited from a shell or hook would point git at the wrong repo.
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_TERMINAL_PROMPT: '0' };
}

// Resolves with git's exit code; rejects only when git could not run at all.
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnv(), maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') reject(err);
      else resolve({ stdout, stderr, code: err ? (err.code as number) : 0 });
    });
  });
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr, code } = await git(cwd, args);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd} (exit ${code}): ${stderr.trim()}`);
  return stdout.replace(/\n$/, '');
}

export function engineGit(cwd: string, args: string[]): Promise<string> {
  return gitOk(cwd, [...ENGINE_CONFIG, ...args]);
}

// Commits the index if it differs from HEAD and returns the resulting HEAD.
// location holds git options naming the repo, for a cwd whose own .git can't be trusted.
export async function commitStaged(cwd: string, message: string, location: string[] = []): Promise<string> {
  const diff = await git(cwd, [...location, 'diff', '--no-ext-diff', '--cached', '--quiet']);
  if (diff.code > 1) throw new Error(`git diff --cached failed in ${cwd} (exit ${diff.code}): ${diff.stderr.trim()}`);
  if (diff.code === 1) await engineGit(cwd, [...location, 'commit', '-q', '-m', message]);
  return gitOk(cwd, [...location, 'rev-parse', 'HEAD']);
}
