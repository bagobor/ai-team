import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { isWithin } from '../paths.ts';
import { commitStaged, engineGit } from './git.ts';
import { prepareRepo } from './workspace.ts';

// Tasks finish in parallel, and two git commands on one index would collide on its lock.
const queues = new Map<string, Promise<unknown>>();

function inTurn<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const result = (queues.get(dir) ?? Promise.resolve()).then(fn);
  queues.set(dir, result.catch(() => undefined));
  return result;
}

export async function initStateRepo(dir: string): Promise<void> {
  await prepareRepo(dir, { create: true });
}

export async function commitArtifact(dir: string, relPath: string, content: string, message: string): Promise<{ sha: string }> {
  const target = resolve(dir, relPath);
  const rel = relative(resolve(dir), target);
  if (rel === '' || !isWithin(resolve(dir), target) || rel.split(sep)[0] === '.git') {
    throw new Error(`Artifact path ${relPath} is outside the state repo`);
  }

  return inTurn(dir, async () => {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    await engineGit(dir, ['--literal-pathspecs', 'add', '--', rel]);
    return { sha: await commitStaged(dir, message) };
  });
}
