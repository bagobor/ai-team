import { mustSupportTask } from '../src/engine/conductor/tasks.ts';
import type { MsItem } from '../src/engine/must-support.ts';
import type { ArtifactVersionRow } from '../src/engine/store.ts';
import { apply, evidenceOf, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';

const phone: MsItem = {
  id: 'MS-1',
  group: 'runs_on',
  text: 'Plays in a phone browser held upright, by touch',
  brief_quote: 'it must work on my phone',
  check: 'play',
  viewport: 'phone_portrait',
  input: 'touch',
  fits_screen: true,
};
const cmd: MsItem = { id: 'MS-2', group: 'built_with', text: 'Plain JavaScript, no build step', brief_quote: 'no build step', check: 'command' };
const later: MsItem = { ...cmd, id: 'MS-3', text: 'One HTML file' };

describe('must_support', () => {
  let e: TestEngine;
  let round = 0;

  // Each version of the list is its own round of the PM's task, and a revision reads the list before it.
  const output = (items: MsItem[]) => {
    round += 1;
    const inputs = round === 1 ? ['BRIEF@1'] : ['BRIEF@1', `MUST-SUPPORT@${round - 1}`];
    return apply(e, 'must_support', { items, stakeholder_note: '' }, { ticketId: `MUST-SUPPORT-PM-r${round}`, milestone: 0, inputs });
  };
  const list = async (items: MsItem[]): Promise<ArtifactVersionRow> => (await publish(e, await output(items)))[0]!;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    round = 0;
    await e.artifacts.commit(await projectOf(e), { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
  });

  afterEach(() => e.cleanup());

  it('publishes the list as a proposed MUST-SUPPORT owned by the PM', async () => {
    const row = await list([phone, cmd]);
    expect(row).toMatchObject({ artifact_id: 'MUST-SUPPORT', status: 'proposed', owner_role: 'pm', version: 1, derived_from: ['BRIEF@1'] });
    const doc = await e.artifacts.read(await projectOf(e), 'MUST-SUPPORT@1');
    expect(doc.fields.data).toEqual({ items: [phone, cmd], used: ['MS-1', 'MS-2'] });
    expect(doc.body).toContain('### MS-1');
  });

  it('sends back a list with problems', async () => {
    expect(evidenceOf(await output([]))).toContain('The list is empty');
  });

  it('keeps every id ever used', async () => {
    await list([phone, cmd]);
    // A revision reads the old list, but derives only from the brief.
    expect(await list([phone, later])).toMatchObject({ version: 2, derived_from: ['BRIEF@1'] });
    expect((await e.artifacts.read(await projectOf(e), 'MUST-SUPPORT@2')).fields.data).toMatchObject({ used: ['MS-1', 'MS-2', 'MS-3'] });
    expect(evidenceOf(await output([phone, cmd]))).toContain('MS-2 is new');
  });

  it("quotes the stakeholder's comment in the work order", async () => {
    const project = await projectOf(e);
    expect(mustSupportTask(project, 2, ['BRIEF@1'], 'Add tablets').order?.instructions).toContain('The stakeholder asked for changes: Add tablets');
    expect(mustSupportTask(project, 1, ['BRIEF@1']).ticket_id).toBe('MUST-SUPPORT-PM');
    expect(mustSupportTask(project, 2, ['BRIEF@1']).ticket_id).toBe('MUST-SUPPORT-PM-r2');
  });
});
