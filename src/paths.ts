import { homedir } from 'node:os';
import { join } from 'node:path';

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
