import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Paths } from '../paths.ts';

const run = promisify(execFile);

const DEFAULT_SEED = fileURLToPath(new URL('../../seed/knowledge', import.meta.url));

export async function runSetup(
  p: Paths,
  seedDir: string = DEFAULT_SEED,
): Promise<{ created: string[]; loginCommand: string }> {
  const created: string[] = [];

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
  }

  if (!existsSync(p.claudeHome)) {
    mkdirSync(p.claudeHome, { recursive: true });
    created.push(p.claudeHome);
  }
  // The agent home holds a login, so only this user may read it.
  chmodSync(p.claudeHome, 0o700);

  return { created, loginCommand: `CLAUDE_CONFIG_DIR=${p.claudeHome} claude auth login` };
}
