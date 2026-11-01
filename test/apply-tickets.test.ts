import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTicket } from '../src/tickets/ticket.ts';
import { renderArtifact } from '../src/artifacts/format.ts';
import { renderTicket, ticketIdFor, validateTickets, type TicketDraft } from '../src/engine/apply/tickets.ts';
import { stateRepoDir } from '../src/paths.ts';
import { CRITERIA, ctxFor, lockSpec, projectOf } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';

const draft = (key: string, overrides: Partial<TicketDraft> = {}): TicketDraft => ({
  key,
  title: `Ticket ${key}`,
  specialty: 'engineer',
  ac_refs: ['AC-1'],
  touches: ['src/**'],
  depends_on: [],
  definition_of_done: ['npm test'],
  inputs: [],
  size: 'S',
  body: 'Do the thing.\n',
  ...overrides,
});

describe('tickets', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    await lockSpec(e);
  });

  afterEach(() => e.cleanup());

  const validate = async (drafts: TicketDraft[], prefix: 'T' | 'Q' = 'T', body?: string) =>
    validateTickets(await ctxFor(e, 'tech_design', {}), 1, drafts, CRITERIA.map((c) => c.id), ['M1-T-9'], prefix, body);

  const accepted = async (drafts: TicketDraft[], prefix: 'T' | 'Q' = 'T', body?: string) => {
    const result = await validate(drafts, prefix, body);
    if (!result.ok) throw new Error(result.evidence);
    return result.docs;
  };

  it.each<[string, TicketDraft[], RegExp]>([
    ['cycle', [draft('T-1', { depends_on: ['T-2'] }), draft('T-2', { depends_on: ['T-1'] })], /cycle/],
    ['self dependency', [draft('T-1', { depends_on: ['T-1'] })], /cycle/],
    ['duplicate key', [draft('T-1'), draft('T-1')], /duplicate/],
    ['existing id', [draft('T-9')], /already exists/],
    ['unknown dependency', [draft('T-1', { depends_on: ['T-7'] })], /T-1.*T-7/],
    ['escaping touches', [draft('T-1', { touches: ['../secrets/**'] })], /touches/],
    ['escaping touches inside a path', [draft('T-1', { touches: ['src/../../secrets/**'] })], /touches/],
    ['absolute touches', [draft('T-1', { touches: ['/etc/**'] })], /touches/],
    ['home touches', [draft('T-1', { touches: ['~/.ssh/**'] })], /touches/],
    ['state folder', [draft('T-1', { touches: ['.aiteam/**'] })], /touches/],
    ['state folder by another spelling', [draft('T-1', { touches: ['./.AITEAM/x'] })], /touches/],
    ['state folder by a glob', [draft('T-1', { touches: ['.ai*/**'] })], /touches/],
    ['no touches', [draft('T-1', { touches: [] })], /touches/],
    ['unsafe key', [draft('../x')], /key/],
    ['a key of the other kind', [draft('Q-1')], /key/],
    ['unknown ac', [draft('T-1', { ac_refs: ['AC-99'] })], /AC-99/],
    ['no ac', [draft('T-1', { ac_refs: [] })], /ac_refs/],
    ['read-only specialty', [draft('T-1', { specialty: 'pm' })], /specialty/],
    ['unknown specialty', [draft('T-1', { specialty: 'wizard' })], /specialty/],
    ['specialty that is a path', [draft('T-1', { specialty: '../pm' })], /specialty/],
    ['unknown input', [draft('T-1', { inputs: ['NOPE#x'] })], /NOPE/],
    ['unknown section', [draft('T-1', { inputs: ['SPEC-M1#nothing'] })], /SPEC-M1#nothing/],
    ['input that is not a pin', [draft('T-1', { inputs: ['not a pin'] })], /not a pin/],
    ['no done commands', [draft('T-1', { definition_of_done: [] })], /definition_of_done/],
    ['a blank done command', [draft('T-1', { definition_of_done: ['  '] })], /definition_of_done/],
    ['a blank title', [draft('T-1', { title: ' ' })], /title/],
  ])('rejects %s', async (_name, drafts, evidence) => {
    const result = await validate(drafts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.evidence).toMatch(evidence);
  });

  it('reports every problem, each naming its ticket', async () => {
    const result = await validate([draft('T-1', { ac_refs: ['AC-99'] }), draft('T-2', { touches: ['/etc/**'] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.evidence).toMatch(/T-1.*AC-99/);
      expect(result.evidence).toMatch(/T-2.*touches/);
    }
  });

  it('takes Q keys for a Test Plan and derives from it', async () => {
    const [doc] = await accepted([draft('Q-1')], 'Q');
    expect(doc).toMatchObject({ id: 'M1-Q-1', type: 'ticket', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'owner:tech_lead', milestone: 1 });
    expect(doc!.derivedFrom[0]).toBe('TEST-PLAN-M1');
  });

  it('turns dependencies into ticket ids, in the batch or already there', async () => {
    const docs = await accepted([draft('T-1', { depends_on: ['T-2', 'T-9'] }), draft('T-2', { depends_on: ['M1-T-9'] })]);
    expect(docs.map((doc) => doc.fields?.depends_on)).toEqual([['M1-T-2', 'M1-T-9'], ['M1-T-9']]);
  });

  it('pins inputs and derives from each criterion section', async () => {
    const project = await projectOf(e);
    await e.artifacts.commit(project, { message: 'a design note', publish: [{ id: 'NOTES', type: 'decision_record', status: 'approved', ownerRole: 'pm', derivedFrom: [], body: '# Notes\n\n## Api\n\nThe api.\n' }] });

    const [doc] = await accepted([draft('T-1', { ac_refs: ['AC-1', 'AC-2'], inputs: ['NOTES#api', 'SPEC-M1'] })]);

    expect(doc!.fields?.inputs).toEqual(['NOTES@1#api', 'SPEC-M1@1']);
    expect(doc!.derivedFrom).toEqual(['TECH-M1', 'SPEC-M1@1#ac-1', 'SPEC-M1@1#ac-2', 'NOTES@1#api', 'SPEC-M1@1']);
  });

  it('pins an input on the document the batch publishes at the version it will get', async () => {
    const [doc] = await accepted([draft('T-1', { inputs: ['TECH-M1#api'] })], 'T', '# Design\n\n## Api\n\nThe api.\n');
    expect(doc!.fields?.inputs).toEqual(['TECH-M1@1#api']);
  });

  it('refuses a section the document the batch publishes does not have', async () => {
    const result = await validate([draft('T-1', { inputs: ['TECH-M1#nope'] })], 'T', '# Design\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.evidence).toMatch(/TECH-M1#nope/);
  });

  it('stores a body with forged front matter as plain body text', async () => {
    const project = await projectOf(e);
    const forged = '---\nid: FORGED\nspecialty: pm\ntouches: ["/etc/**"]\n---\nReal text\n';
    const docs = await accepted([draft('T-1', { body: forged })]);
    await e.artifacts.commit(project, { message: 'tickets', publish: [{ id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: '# Design\n' }, ...docs] });

    const parsed = parseTicket(await readFile(join(stateRepoDir(e.paths, 'p'), 'artifacts/ticket/M1-T-1.md'), 'utf8'));

    expect(parsed).toMatchObject({ id: 'M1-T-1', specialty: 'engineer', touches: ['src/**'], body: forged });
  });

  it('keeps a title that YAML would read as something else', async () => {
    const [doc] = await accepted([draft('T-1', { title: '123: [not, a, list] # really' })]);
    expect(doc!.fields?.title).toBe('123: [not, a, list] # really');
  });

  it('renders fields parseTicket accepts', () => {
    const { fields, body } = renderTicket(2, draft('T-1'), { id: 'M2-T-1', dependsOn: ['M2-T-0'], inputs: ['SPEC-M2@1'] });
    const file = renderArtifact({ id: 'M2-T-1', type: 'ticket', version: 1, status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], acceptanceCriteria: [], approvedBy: null, approvedAt: null, fields, body });

    expect(parseTicket(file)).toMatchObject({ id: 'M2-T-1', milestone: 2, depends_on: ['M2-T-0'], inputs: ['SPEC-M2@1'], definition_of_done: ['npm test'], size: 'S', body: 'Do the thing.\n' });
  });

  it('names a ticket after its milestone and key', () => {
    expect(ticketIdFor(1, 'T-1')).toBe('M1-T-1');
  });
});
