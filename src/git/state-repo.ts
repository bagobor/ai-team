import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commitStaged, engineGit } from './git.ts';
import { prepareRepo } from './workspace.ts';

// Allow-listed rather than checked for ".." and ".git": macOS treats .GIT, and names with some invisible
// characters, as .git. No leading dot, no trailing dot or space, nothing git or a shell reads specially.
const SAFE_SEGMENT = /^[A-Za-z0-9_](?:[A-Za-z0-9._ -]*[A-Za-z0-9_-])?$/;

// Tasks finish in parallel, and two git commands on one index would collide on its lock.
const queues = new Map<string, Promise<unknown>>();

export function inTurn<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const result = (queues.get(dir) ?? Promise.resolve()).then(fn);
  queues.set(dir, result.catch(() => undefined));
  return result;
}

export async function initStateRepo(dir: string): Promise<void> {
  await prepareRepo(dir, { create: true });
}

// The caller holds the turn: this runs as one step of something larger, and taking it again would wait on itself.
// Writing what is already there commits nothing and returns HEAD, so a retry after a crash can record it.
export async function commitFiles(dir: string, files: { path: string; content: string }[], message: string): Promise<{ sha: string }> {
  const unsafe = files.find(({ path }) => !path.split('/').every((segment) => SAFE_SEGMENT.test(segment)));
  if (unsafe) throw new Error(`${unsafe.path} is not a safe artifact path`);

  for (const { path, content } of files) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await engineGit(dir, ['add', '--', ...files.map(({ path }) => path)]);
  return { sha: await commitStaged(dir, message) };
}

export async function commitArtifact(dir: string, relPath: string, content: string, message: string): Promise<{ sha: string }> {
  return inTurn(dir, () => commitFiles(dir, [{ path: relPath, content }], message));
}
