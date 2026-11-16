import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateTokens } from '../manifest/tokens.ts';
import type { Role } from '../roles/role.ts';
import { parseEntries, playbookSection, type Entry, type EntryPrefix, type Memory, type MemoryFile, type ParsedEntries } from './entries.ts';

// Where each file sits: a playbook in the knowledge repo, memory in the project's state repo.
export const playbookPath = (roleId: string): string => `roles/${roleId}/playbook.md`;

export const memoryPaths = (roleId: string): Record<MemoryFile, string> => ({ project: 'memory/project.md', role: `memory/roles/${roleId}.md` });

// A file nobody has written yet is an empty one.
export async function readEntries(root: string, path: string, prefix: EntryPrefix): Promise<ParsedEntries> {
  const text = await readFile(join(root, path), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  return parseEntries(text, prefix);
}

// A worker never gets part of a file a person wrote wrongly: the task stops, and says what to fix.
async function whole(root: string, path: string, prefix: EntryPrefix): Promise<Entry[]> {
  const { entries, problems } = await readEntries(root, path, prefix);
  if (problems.length > 0) throw new Error(`${path} can’t be given to a worker: ${problems.join('; ')}`);
  return entries;
}

// What counts against the limit is what the worker gets, which leaves out who added each entry and from what.
export async function loadPlaybook(knowledgeDir: string, role: Role): Promise<Entry[]> {
  const entries = await whole(knowledgeDir, playbookPath(role.id), 'PB').catch((cause: Error) => {
    throw new Error(`Role ${role.id}: ${cause.message}`, { cause });
  });
  const tokens = estimateTokens(playbookSection(entries));
  const limit = role.defaults.budgets.playbook_tokens;
  if (tokens > limit) throw new Error(`Role ${role.id}: its playbook is ${tokens} tokens, over the limit of ${limit}`);
  return entries;
}

export async function loadMemory(stateDir: string, roleId: string): Promise<Memory> {
  const paths = memoryPaths(roleId);
  const project = await whole(stateDir, paths.project, 'MEM');
  const role = await whole(stateDir, paths.role, 'MEM');
  const shared = role.find(({ id }) => project.some((entry) => entry.id === id));
  if (shared) throw new Error(`${shared.id} is in both ${paths.project} and ${paths.role}`);
  return { project, role };
}
