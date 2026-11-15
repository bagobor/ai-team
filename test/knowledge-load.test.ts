import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMemory, loadPlaybook } from '../src/knowledge/load.ts';
import { loadRole } from '../src/roles/role.ts';
import { tempDir } from './helpers/repo.ts';

const seedKnowledge = fileURLToPath(new URL('../seed/knowledge', import.meta.url));

describe('a role’s playbook, as a task reads it', () => {
  let knowledge: string;

  beforeEach(() => {
    knowledge = join(tempDir('aiteam-playbook-'), 'knowledge');
    cpSync(seedKnowledge, knowledge, { recursive: true });
  });

  const entry = (id: string, text: string) => `## ${id}\nAdded by: the stakeholder\nAdded: 2026-11-15\n\n${text}\n`;
  const write = (text: string) => writeFileSync(join(knowledge, 'roles', 'engineer', 'playbook.md'), text);
  const playbook = async () => loadPlaybook(knowledge, (await loadRole(knowledge, 'engineer')).role);

  it('is empty for a role that has no playbook file', async () => {
    expect(await playbook()).toEqual([]);
  });

  it('is the entries of roles/<id>/playbook.md', async () => {
    write(`# Engineer playbook\n\n${entry('PB-1', 'Run the checks first.')}\n${entry('PB-2', 'Then report.')}`);

    expect(await playbook()).toMatchObject([
      { id: 'PB-1', text: 'Run the checks first.' },
      { id: 'PB-2', text: 'Then report.' },
    ]);
  });

  it('refuses a playbook with a problem, and names every one', async () => {
    write(`${entry('PB-1', '')}\n## Notes\n`);

    await expect(playbook()).rejects.toThrow('Role engineer: roles/engineer/playbook.md can’t be given to a worker: Line 7: "## Notes" is not an entry heading such as "## PB-1"; PB-1 has no text');
  });

  it('refuses a playbook over the role’s budget for one', async () => {
    write(entry('PB-1', 'x'.repeat(8000)));

    await expect(playbook()).rejects.toThrow(/Role engineer: its playbook is \d+ tokens, over the limit of 2000/);
  });
});

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
