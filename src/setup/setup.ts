import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { engineGit, git, gitOk } from '../git/git.ts';
import type { Paths } from '../paths.ts';

const run = promisify(execFile);

const DEFAULT_SEED = fileURLToPath(new URL('../../seed/knowledge', import.meta.url));

function seedFiles(seedDir: string): string[] {
  return readdirSync(seedDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(seedDir, join(entry.parentPath, entry.name)))
    .sort();
}

// The knowledge repo is curated by people, so a seed only ever fills gaps in it.
export async function syncSeed(p: Paths, seedDir: string = DEFAULT_SEED): Promise<{ added: string[]; kept: string[] }> {
  if (!existsSync(p.knowledge)) return { added: [], kept: [] };

  const added: string[] = [];
  const kept: string[] = [];
  for (const file of seedFiles(seedDir)) {
    const target = join(p.knowledge, file);
    if (!existsSync(target)) added.push(file);
    else if (!readFileSync(target).equals(readFileSync(join(seedDir, file)))) kept.push(file);
  }

  if (added.length > 0) {
    for (const file of added) cpSync(join(seedDir, file), join(p.knowledge, file));
    await gitOk(p.knowledge, ['add', '--', ...added]);
    // A tracked file someone deleted without committing comes back identical, which leaves nothing to commit.
    const staged = await git(p.knowledge, ['diff', '--cached', '--quiet', '--', ...added]);
    if (staged.code !== 0) await engineGit(p.knowledge, ['commit', '-q', '-m', 'seed: add new roles and schemas', '--', ...added]);
  }
  return { added, kept };
}

export async function runSetup(
  p: Paths,
  seedDir: string = DEFAULT_SEED,
): Promise<{ created: string[]; added: string[]; kept: string[]; loginCommand: string }> {
  const created: string[] = [];
  let synced: { added: string[]; kept: string[] } = { added: [], kept: [] };

  mkdirSync(p.root, { recursive: true });

  if (!existsSync(p.knowledge)) {
    cpSync(seedDir, p.knowledge, { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: p.knowledge });
    await run('git', ['add', '-A'], { cwd: p.knowledge });
    await run(
      'git',
      [
        '-c', 'user.name=aiteam',
        '-c', 'user.email=aiteam@localhost',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null',
        'commit', '-q', '-m', 'Seed the knowledge repo',
      ],
      { cwd: p.knowledge },
    );
    created.push(p.knowledge);
  } else {
    synced = await syncSeed(p, seedDir);
  }

  if (!existsSync(p.claudeHome)) {
    mkdirSync(p.claudeHome, { recursive: true });
    created.push(p.claudeHome);
  }
  // The agent home holds a login, so only this user may read it.
  chmodSync(p.claudeHome, 0o700);

  return { created, ...synced, loginCommand: `CLAUDE_CONFIG_DIR=${p.claudeHome} claude auth login` };
}
