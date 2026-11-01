import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { startDaemon } from './daemon.ts';
import { resolvePaths, type Paths } from './paths.ts';
import { runDoctor } from './setup/doctor.ts';
import { runSetup } from './setup/setup.ts';

const USAGE = `Usage:
  aiteam setup                                      Create ~/.aiteam and print the agent-home login command
  aiteam doctor                                     Check this machine can run workers
  aiteam daemon                                     Run the engine and serve the API until stopped
  aiteam project add <name> <repoPath> [--create]   Register a repo with the running daemon
  aiteam ticket add <project> <file.md>             Import a ticket into the running daemon`;

function usage(): number {
  console.error(USAGE);
  return 2;
}

function messageFrom(text: string): string {
  try {
    const { error } = JSON.parse(text) as { error?: string };
    return error ?? text;
  } catch {
    return text;
  }
}

async function postToDaemon<T>(paths: Paths, path: string, body: unknown): Promise<T> {
  const { port } = loadConfig(paths);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(`The daemon isn't running on port ${port}. Start it with: aiteam daemon`, { cause });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(messageFrom(text));
  return JSON.parse(text) as T;
}

async function doctor(paths: Paths): Promise<number> {
  const checks = await runDoctor(paths, loadConfig(paths));
  for (const { name, ok, detail } of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${detail}`);
  return checks.every((check) => check.ok) ? 0 : 1;
}

async function daemon(paths: Paths): Promise<number> {
  if (!existsSync(paths.knowledge)) {
    console.error(`${paths.root} isn't set up yet. Run: aiteam setup`);
    return 1;
  }
  const running = await startDaemon({ paths, config: loadConfig(paths) });
  console.log(`Listening on http://127.0.0.1:${running.port}`);
  const stopThenExit = () => {
    running.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', stopThenExit);
  process.once('SIGTERM', stopThenExit);
  return new Promise<number>(() => {});
}

async function projectAdd(paths: Paths, name: string, repoPath: string, create: boolean): Promise<number> {
  // The daemon may have been started somewhere else, so a relative path has to be settled here.
  const project = await postToDaemon<{ name: string; repo_path: string; base_branch: string }>(paths, '/api/projects', {
    name,
    repoPath: resolve(repoPath),
    create,
  });
  console.log(`Added project ${project.name}: ${project.repo_path} (base branch ${project.base_branch})`);
  return 0;
}

async function ticketAdd(paths: Paths, project: string, file: string): Promise<number> {
  let markdown: string;
  try {
    markdown = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new Error(`Could not read ${file}`, { cause });
  }
  const task = await postToDaemon<{ id: number; ticket_id: string }>(paths, `/api/projects/${encodeURIComponent(project)}/tickets`, { markdown });
  console.log(`Added ticket ${task.ticket_id} to ${project} as task ${task.id}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { create: { type: 'boolean', default: false } } });
  } catch {
    return usage();
  }
  const { positionals, values } = parsed;
  const [command, action, first, second, ...rest] = positionals;
  const paths = resolvePaths();

  switch (command) {
    case 'setup': {
      const { created, added, kept, loginCommand } = await runSetup(paths);
      for (const path of created) console.log(`Created ${path}`);
      for (const file of added) console.log(`Added ${file}`);
      for (const file of kept) console.log(`Kept your version of ${file}; it differs from the seed`);
      console.log(`Log the agent home in once, in your own terminal:\n  ${loginCommand}`);
      return 0;
    }
    case 'doctor':
      return doctor(paths);
    case 'daemon':
      return daemon(paths);
    case 'project':
      if (action !== 'add' || first === undefined || second === undefined || rest.length > 0) return usage();
      return projectAdd(paths, first, second, values.create);
    case 'ticket':
      if (action !== 'add' || first === undefined || second === undefined || rest.length > 0) return usage();
      return ticketAdd(paths, first, second);
    default:
      return usage();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
