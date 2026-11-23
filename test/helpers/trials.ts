import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineDeps } from '../../src/engine/runner.ts';
import { stateRepoDir } from '../../src/paths.ts';
import { liveKnowledge } from '../../src/trials/drafts.ts';
import type { Knowledge } from '../../src/trials/types.ts';
import { run } from './repo.ts';

// Everything a project's own flow reads: its rows, its repository's branches, worktrees and files, and its state repo.
// A trial may change none of it.
export async function projectState(e: EngineDeps & { repoPath: string }): Promise<Record<string, unknown>> {
  const state = stateRepoDir(e.paths, 'p');
  return {
    tasks: await e.db.selectFrom('tasks').selectAll().orderBy('id').execute(),
    attempts: await e.db.selectFrom('attempts').selectAll().orderBy('id').execute(),
    artifacts: await e.db.selectFrom('artifact_versions').selectAll().execute(),
    inbox: await e.db.selectFrom('inbox_items').selectAll().execute(),
    milestones: await e.db.selectFrom('milestones').selectAll().execute(),
    events: (await e.db.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n,
    refs: run(e.repoPath, 'for-each-ref'),
    worktrees: run(e.repoPath, 'worktree', 'list'),
    files: run(e.repoPath, 'status', '--porcelain'),
    stateHead: run(state, 'rev-parse', 'HEAD'),
    stateFiles: run(state, 'status', '--porcelain'),
  };
}

export const entryText = (id: string, text: string, kind?: string): string => [`## ${id}`, ...(kind === undefined ? [] : [`Kind: ${kind}`]), 'Added by: the stakeholder', 'Added: 2026-11-15', '', text, ''].join('\n');

// What the engineer's tasks on project p read today, with other files' texts put in their place.
export async function knowledgeWith(e: EngineDeps, over: Partial<Knowledge> = {}, roleId = 'engineer'): Promise<Knowledge> {
  return { ...(await liveKnowledge(e.paths, roleId, 'p')), ...over };
}

export const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');
