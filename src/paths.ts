import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export type Paths = {
  root: string;
  db: string;
  config: string;
  knowledge: string;
  projects: string;
  worktrees: string;
  transcripts: string;
  claudeHome: string;
};

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const root = env.AITEAM_HOME ?? join(env.HOME ?? homedir(), '.aiteam');
  return {
    root,
    db: join(root, 'aiteam.db'),
    config: join(root, 'config.yaml'),
    knowledge: join(root, 'knowledge'),
    projects: join(root, 'projects'),
    worktrees: join(root, 'worktrees'),
    transcripts: join(root, 'transcripts'),
    claudeHome: join(root, 'agent-home', 'claude'),
  };
}

const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.npmrc', '.pypirc', '.docker', '.kube', '.git-credentials', '.claude', '.claude.json', '.codex', 'Library/Keychains'];

// What a worker's commands have no reason to read, apart from the one worktree each attempt gets back.
// It can't name every secret on a machine, so it is one line of defence.
export function workerDenyRead(p: Paths, home: string): string[] {
  return [
    p.claudeHome,
    p.db,
    `${p.db}-wal`,
    `${p.db}-shm`,
    p.config,
    p.knowledge,
    p.projects,
    p.transcripts,
    p.worktrees,
    ...HOME_SECRETS.map((name) => join(home, name)),
  ];
}

// True when child is parent or lies under it. Both paths are compared as written, without following symlinks.
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function stateRepoDir(p: Paths, project: string): string {
  return join(p.projects, project, 'state');
}

export function worktreePath(p: Paths, project: string, ticketId: string, k: number): string {
  return join(p.worktrees, project, `${ticketId}-a${k}`);
}

export function transcriptPath(p: Paths, project: string, attemptId: number): string {
  return join(p.transcripts, project, `${attemptId}.jsonl`);
}

export function manifestDir(p: Paths, project: string, ticketId: string, k: number): string {
  return join(p.projects, project, 'manifests', `${ticketId}-a${k}`);
}
