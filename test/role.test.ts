import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../src/manifest/tokens.ts';
import { loadRole } from '../src/roles/role.ts';
import { tempDir } from './helpers/repo.ts';

const seedKnowledge = fileURLToPath(new URL('../seed/knowledge', import.meta.url));

describe('loadRole', () => {
  let knowledge: string;
  const roleFile = (name: string) => join(knowledge, 'roles', 'engineer', name);

  beforeEach(() => {
    knowledge = join(tempDir(), 'knowledge');
    cpSync(seedKnowledge, knowledge, { recursive: true });
  });

  it('estimates tokens', () => expect(estimateTokens('abcdefg')).toBe(2));

  it('seed charter is within 600 tokens', async () => {
    const { charter } = await loadRole(seedKnowledge, 'engineer');
    expect(estimateTokens(charter)).toBeLessThanOrEqual(600);
  });

  it('loads §5.2 budgets', async () => {
    const { role } = await loadRole(seedKnowledge, 'engineer');
    expect(role.defaults.budgets).toEqual({ max_turns: 60, max_usd: 3, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000 });
  });

  it('loads tools, write scope and the output schema', async () => {
    const { role, schema } = await loadRole(seedKnowledge, 'engineer');
    expect(role.tools).toEqual(['read_repo', 'edit_repo', 'run_commands', { network: 'restricted' }]);
    expect(role.write_scope).toEqual({ allow: ['**'], deny: ['.aiteam/**'] });
    expect(schema).toMatchObject({ title: 'Change Report' });
  });

  it('rejects an oversized charter', async () => {
    writeFileSync(roleFile('charter.md'), 'x'.repeat(3000));
    await expect(loadRole(knowledge, 'engineer')).rejects.toThrow(/charter.*600/);
  });

  it('rejects a role whose file names another id', async () => {
    writeFileSync(roleFile('role.yaml'), readFileSync(roleFile('role.yaml'), 'utf8').replace('id: engineer', 'id: other'));
    await expect(loadRole(knowledge, 'engineer')).rejects.toThrow(/Role engineer: .*other/);
  });

  it('rejects a role.yaml with a missing section', async () => {
    writeFileSync(roleFile('role.yaml'), 'id: engineer\nmission: x\n');
    await expect(loadRole(knowledge, 'engineer')).rejects.toThrow(/role\.yaml/);
  });

  it('rejects an output schema that does not compile', async () => {
    writeFileSync(join(knowledge, 'schemas', 'change_report.json'), '{"type":"not-a-type"}');
    await expect(loadRole(knowledge, 'engineer')).rejects.toThrow(/output schema/);
  });

  it('rejects an output schema path outside the knowledge repo', async () => {
    writeFileSync(roleFile('role.yaml'), readFileSync(roleFile('role.yaml'), 'utf8').replace('schemas/change_report.json', '../secret.json'));
    await expect(loadRole(knowledge, 'engineer')).rejects.toThrow(/output schema/);
  });

  it('fails clearly for a role that does not exist', async () => {
    await expect(loadRole(knowledge, 'designer')).rejects.toThrow(/designer/);
  });

  it.each(['../engineer', 'a/b', '.hidden', ''])('rejects the unsafe role id %j', async (id) => {
    await expect(loadRole(knowledge, id)).rejects.toThrow(/role id/);
  });
});
