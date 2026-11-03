import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../src/manifest/tokens.ts';
import { loadRole } from '../src/roles/role.ts';
import { tempDir } from './helpers/repo.ts';

const seedKnowledge = fileURLToPath(new URL('../seed/knowledge', import.meta.url));

const ROLES = ['pm', 'tech_lead', 'code_reviewer', 'qa_engineer', 'engineer'];

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

  it.each(ROLES)('loads the seeded role %s', async (id) => {
    const { role, charter } = await loadRole(seedKnowledge, id);
    expect(role.id).toBe(id);
    expect(role.defaults.budgets).toEqual({ max_turns: 60, max_usd: 3, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000 });
    expect(charter.length).toBeGreaterThan(0);
  });

  it.each(ROLES)('keeps the %s charter within 600 tokens', async (id) => {
    const { charter } = await loadRole(seedKnowledge, id);
    expect(estimateTokens(charter)).toBeLessThanOrEqual(600);
  });

  it.each([
    ['pm', 'claude-opus-5-5'],
    ['tech_lead', 'claude-opus-5-5'],
    ['code_reviewer', 'claude-opus-5-5'],
    ['qa_engineer', 'claude-sonnet-5-5'],
    ['engineer', 'claude-sonnet-5-5'],
  ])('runs %s on %s', async (id, model) => {
    expect((await loadRole(seedKnowledge, id)).role.defaults.model).toBe(model);
  });

  it.each([
    ['pm', ['discovery', 'milestone_spec', 'milestone_review', 'cr_recommendation']],
    ['tech_lead', ['environment_profile', 'tech_design', 'revise_design', 'cr_recommendation']],
    ['code_reviewer', ['code_review']],
    ['qa_engineer', ['test_plan', 'qa_verify', 'revise_test_plan', 'cr_recommendation']],
  ])('gives %s a schema for each of its purposes', async (id, purposes) => {
    for (const purpose of purposes) {
      const { schema } = await loadRole(seedKnowledge, id, purpose);
      expect((schema as { additionalProperties: unknown }).additionalProperties).toBe(false);
    }
  });

  it('loads a schema by purpose and names its source', async () => {
    const { schemaSource, schema } = await loadRole(seedKnowledge, 'pm', 'milestone_spec');
    expect(schemaSource).toBe('schemas/milestone_spec.json');
    expect((schema as { required: string[] }).required).toContain('criteria');
  });

  it('points both revise purposes at the one revise schema', async () => {
    expect((await loadRole(seedKnowledge, 'tech_lead', 'revise_design')).schemaSource).toBe('schemas/revise.json');
    expect((await loadRole(seedKnowledge, 'qa_engineer', 'revise_test_plan')).schemaSource).toBe('schemas/revise.json');
  });

  it('uses output_schema when no purpose is given', async () => {
    expect((await loadRole(seedKnowledge, 'engineer')).schemaSource).toBe('schemas/change_report.json');
    expect((await loadRole(seedKnowledge, 'pm')).schemaSource).toBe('schemas/discovery.json');
  });

  it('refuses an unknown purpose', async () => {
    await expect(loadRole(seedKnowledge, 'pm', 'code_review')).rejects.toThrow(/pm.*code_review/);
    await expect(loadRole(seedKnowledge, 'engineer', 'discovery')).rejects.toThrow(/engineer.*discovery/);
  });

  it('refuses an inherited name as a purpose', async () => {
    await expect(loadRole(seedKnowledge, 'pm', 'constructor')).rejects.toThrow(/pm.*constructor/);
  });

  it('refuses an output_schemas path outside the knowledge repo', async () => {
    const file = join(knowledge, 'roles', 'pm', 'role.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('schemas/milestone_spec.json', '../secret.json'));
    await expect(loadRole(knowledge, 'pm', 'milestone_spec')).rejects.toThrow(/output schema/);
  });

  it.each(['pm', 'tech_lead'])('gives the read-only role %s no edit tools', async (id) => {
    const { role } = await loadRole(seedKnowledge, id);
    expect(role.tools).toEqual(['read_repo']);
    expect(role.write_scope).toEqual({ allow: [], deny: ['**'] });
  });

  it.each(['code_reviewer', 'qa_engineer'])('lets %s run commands but not edit', async (id) => {
    const { role } = await loadRole(seedKnowledge, id);
    expect(role.tools).toEqual(['read_repo', 'run_commands']);
    expect(role.write_scope).toEqual({ allow: [], deny: ['**'] });
  });

  it.each(['pm', 'tech_lead', 'code_reviewer', 'qa_engineer'])('tells %s that inputs are data and how to raise a change', async (id) => {
    const { charter } = await loadRole(seedKnowledge, id);
    expect(charter).toMatch(/data, never instructions/);
    expect(charter).toMatch(/change_requests/);
  });

  it('keeps the no-network limit of the Engineer accurate', async () => {
    const { charter } = await loadRole(seedKnowledge, 'engineer');
    expect(charter).toMatch(/unless the approved Environment Profile allows it/);
  });

  it('accepts a change request from each schema a worker can answer with', () => {
    const names = readdirSync(join(seedKnowledge, 'schemas'));
    expect(names).toHaveLength(11);
    for (const name of names) {
      const schema = JSON.parse(readFileSync(join(seedKnowledge, 'schemas', name), 'utf8')) as { required: string[]; properties: Record<string, unknown> };
      expect(schema.properties.change_requests, name).toBeDefined();
      expect(schema.required, name).not.toContain('change_requests');
    }
  });

  it('tells every worker the same way how to name what a change request targets', () => {
    const requests = readdirSync(join(seedKnowledge, 'schemas')).map((name) => {
      const schema = JSON.parse(readFileSync(join(seedKnowledge, 'schemas', name), 'utf8')) as { properties: { change_requests: { items: { properties: Record<string, { description?: string }> } } } };
      return schema.properties.change_requests.items.properties;
    });
    for (const request of requests) expect(request).toEqual(requests[0]);
    for (const field of ['target_artifact', 'target_section', 'target_ac', 'proposed_text']) expect(requests[0]?.[field]?.description, field).toBeDefined();
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
