import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadMemory } from '../src/knowledge/load.ts';
import { tempDir } from './helpers/repo.ts';

describe('a project’s memory, as a task reads it', () => {
  let state: string;

  beforeEach(() => {
    state = tempDir('aiteam-memory-');
  });

  const entry = (id: string, kind: string, text = `What ${id} says.`) => `## ${id}\nKind: ${kind}\nAdded by: the PM\nAdded: 2026-11-15\n\n${text}\n`;

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(state, path)), { recursive: true });
    writeFileSync(join(state, path), text);
  }

  it('is empty for a project that has kept none', async () => {
    expect(await loadMemory(state, 'engineer')).toEqual({ project: [], role: [] });
  });

  it('is the project’s file and the role’s own, and no other role’s', async () => {
    write('memory/project.md', `# Project memory\n\n${entry('MEM-1', 'feedback')}`);
    write('memory/roles/engineer.md', entry('MEM-2', 'lesson'));
    write('memory/roles/pm.md', entry('MEM-3', 'lesson'));

    const memory = await loadMemory(state, 'engineer');

    expect(memory.project).toMatchObject([{ id: 'MEM-1', kind: 'feedback' }]);
    expect(memory.role).toMatchObject([{ id: 'MEM-2', kind: 'lesson' }]);
  });

  it('refuses a file with a problem, and says which file', async () => {
    write('memory/roles/engineer.md', entry('MEM-2', 'gossip'));

    await expect(loadMemory(state, 'engineer')).rejects.toThrow('memory/roles/engineer.md can’t be given to a worker: MEM-2: "Kind" must be feedback, lesson or structure, not "gossip"');
  });

  it('refuses an id that both files use, since an entry is named by its id alone', async () => {
    write('memory/project.md', entry('MEM-1', 'feedback'));
    write('memory/roles/engineer.md', entry('MEM-1', 'lesson'));

    await expect(loadMemory(state, 'engineer')).rejects.toThrow('MEM-1 is in both memory/project.md and memory/roles/engineer.md');
  });
});
