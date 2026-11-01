import { parseArtifact, type ArtifactType } from '../src/artifacts/format.ts';
import { lineageGraph, RECORD_TYPES } from '../src/artifacts/lineage.ts';
import type { NewVersion } from '../src/artifacts/store.ts';
import type { ProjectRow } from '../src/engine/store.ts';
import { stateRepoDir } from '../src/paths.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';
import { run } from './helpers/repo.ts';

const approved = (id: string, type: ArtifactType, overrides: Partial<NewVersion> = {}): NewVersion => ({
  id,
  type,
  status: 'approved',
  ownerRole: 'pm',
  derivedFrom: [],
  body: `# ${id}\n`,
  ...overrides,
});

const SPEC_V1 = '# AC 1\nfirst\n# AC 2\nsecond\n';

describe('staleness', () => {
  let e: TestEngine;
  let p: ProjectRow;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    const project = await e.store.getProject('p');
    if (!project) throw new Error('makeEngine should have created project p');
    p = project;
  });

  afterEach(() => e.cleanup());

  const publish = (...versions: NewVersion[]) => e.artifacts.commit(p, { message: 'publish', publish: versions });
  const status = async (id: string) => (await e.artifacts.latest(p.id, id))?.status;

  it('marks everything pinned to the old version stale', async () => {
    await publish(approved('SPEC', 'spec'), approved('BRIEF', 'brief'));
    await publish(approved('A', 'tech_design', { derivedFrom: ['SPEC'] }), approved('B', 'test_plan', { derivedFrom: ['SPEC@1'] }), approved('C', 'ticket', { derivedFrom: ['BRIEF'] }));

    await publish(approved('SPEC', 'spec', { body: '# Changed\n' }));

    expect(await status('A')).toBe('stale');
    expect(await status('B')).toBe('stale');
    expect(await status('C')).toBe('approved');
    expect((await e.artifacts.latest(p.id, 'A'))?.stale_sections).toEqual([]);
  });

  it('marks a section pin stale only when that section changed', async () => {
    await publish(approved('SPEC', 'spec', { body: SPEC_V1 }));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC#ac-1'] }));

    await publish(approved('SPEC', 'spec', { body: '# AC 1\nfirst\n# AC 2\nchanged\n' }));
    expect(await status('TICKET')).toBe('approved');

    await publish(approved('SPEC', 'spec', { body: '# AC 1\nchanged too\n# AC 2\nchanged\n' }));
    const row = await e.artifacts.latest(p.id, 'TICKET');
    expect(row?.status).toBe('stale');
    expect(row?.stale_sections).toEqual(['ac-1']);
  });

  it('marks a section pin stale when the section is gone', async () => {
    await publish(approved('SPEC', 'spec', { body: SPEC_V1 }));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC#ac-2'] }));

    await publish(approved('SPEC', 'spec', { body: '# AC 1\nfirst\n' }));

    const row = await e.artifacts.latest(p.id, 'TICKET');
    expect(row?.status).toBe('stale');
    expect(row?.stale_sections).toEqual(['ac-2']);
  });

  it('adds to the stale sections of an artifact that is already stale', async () => {
    await publish(approved('SPEC', 'spec', { body: SPEC_V1 }));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC#ac-1', 'SPEC#ac-2'] }));

    await publish(approved('SPEC', 'spec', { body: '# AC 1\nchanged\n# AC 2\nsecond\n' }));
    await publish(approved('SPEC', 'spec', { body: '# AC 1\nchanged\n# AC 2\nchanged\n' }));

    expect((await e.artifacts.latest(p.id, 'TICKET'))?.stale_sections).toEqual(['ac-1', 'ac-2']);
  });

  it.each(RECORD_TYPES)('never marks a %s stale', async (type) => {
    await publish(approved('SPEC', 'spec'));
    await publish(approved('RECORD', type, { derivedFrom: ['SPEC'] }));

    await publish(approved('SPEC', 'spec', { body: '# Changed\n' }));

    expect(await status('RECORD')).toBe('approved');
  });

  it('does not spread staleness past one level', async () => {
    await publish(approved('SPEC', 'spec'));
    await publish(approved('DESIGN', 'tech_design', { derivedFrom: ['SPEC'] }));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['DESIGN'] }));

    await publish(approved('SPEC', 'spec', { body: '# Changed\n' }));
    expect(await status('DESIGN')).toBe('stale');
    expect(await status('TICKET')).toBe('approved');

    await publish(approved('DESIGN', 'tech_design', { derivedFrom: ['SPEC'], body: '# Revised\n' }));
    expect(await status('DESIGN')).toBe('approved');
    expect(await status('TICKET')).toBe('stale');
  });

  it('does not mark anything stale for a proposed version, and does when that version is approved', async () => {
    await publish(approved('SPEC', 'spec'));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC'] }));

    await publish(approved('SPEC', 'spec', { status: 'proposed', body: '# Changed\n' }));
    expect(await status('TICKET')).toBe('approved');

    await e.artifacts.commit(p, { message: 'approve', status: [{ id: 'SPEC', status: 'approved', approvedBy: 'stakeholder' }] });
    expect(await status('TICKET')).toBe('stale');
  });

  it('ignores what an older version of the dependent was pinned to', async () => {
    await publish(approved('SPEC', 'spec'), approved('BRIEF', 'brief'));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC'] }));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['BRIEF'], body: '# Moved on\n' }));

    await publish(approved('SPEC', 'spec', { body: '# Changed\n' }));

    expect(await status('TICKET')).toBe('approved');
  });

  it('does not mark a dependent published in the same change', async () => {
    await publish(approved('SPEC', 'spec'));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC'] }));

    await publish(approved('SPEC', 'spec', { body: '# Changed\n' }), approved('TICKET', 'ticket', { derivedFrom: ['SPEC'], body: '# Revised\n' }));

    expect(await e.artifacts.latest(p.id, 'TICKET')).toMatchObject({ status: 'approved', version: 2, derived_from: ['SPEC@2'] });
  });

  it('does not mark a dependent re-pinned in the same change', async () => {
    await publish(approved('SPEC', 'spec'));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC'] }));

    await e.artifacts.commit(p, {
      message: 'both',
      publish: [approved('SPEC', 'spec', { body: '# Changed\n' })],
      status: [{ id: 'TICKET', status: 'approved', derivedFrom: ['SPEC'] }],
    });

    expect(await e.artifacts.latest(p.id, 'TICKET')).toMatchObject({ status: 'approved', derived_from: ['SPEC@2'] });
  });

  it('does not mark an artifact stale because of its own earlier version', async () => {
    await publish(approved('SPEC', 'spec'));
    await publish(approved('SPEC', 'spec', { derivedFrom: ['SPEC@1'], body: '# Two\n' }));

    expect(await status('SPEC')).toBe('approved');
  });

  it('re-pinning clears staleness and logs lineage.repinned', async () => {
    await publish(approved('SPEC', 'spec', { body: SPEC_V1 }));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC#ac-1'] }));
    await publish(approved('SPEC', 'spec', { body: '# AC 1\nchanged\n# AC 2\nsecond\n' }));

    await e.artifacts.commit(p, { message: 'repin', status: [{ id: 'TICKET', status: 'approved', derivedFrom: ['SPEC#ac-1'] }] });

    expect(await e.artifacts.latest(p.id, 'TICKET')).toMatchObject({ status: 'approved', stale_sections: [], derived_from: ['SPEC@2#ac-1'] });
    const events = await e.log.list({ projectId: p.id });
    expect(events.filter((event) => event.type === 'lineage.repinned').map((event) => event.payload)).toEqual([{ id: 'TICKET' }]);

    await publish(approved('SPEC', 'spec', { body: '# AC 1\nchanged\n# AC 2\nchanged\n' }));
    expect(await status('TICKET')).toBe('approved');
  });

  it('writes stale status into the file in the same commit', async () => {
    await publish(approved('SPEC', 'spec'));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC'] }));
    const dir = stateRepoDir(e.paths, 'p');
    const before = Number(run(dir, 'rev-list', '--count', 'HEAD'));

    await publish(approved('SPEC', 'spec', { body: '# Changed\n' }));

    expect(Number(run(dir, 'rev-list', '--count', 'HEAD'))).toBe(before + 1);
    expect(parseArtifact(run(dir, 'show', 'HEAD:artifacts/ticket/TICKET.md')).status).toBe('stale');
    expect((await e.artifacts.latest(p.id, 'TICKET'))?.sha).toBe(run(dir, 'rev-parse', 'HEAD'));
    expect((await e.artifacts.reconcile(p)).restored).toEqual([]);
  });

  it('lineageGraph returns source-to-derived edges and flags stale ones', async () => {
    await publish(approved('SPEC', 'spec', { body: SPEC_V1 }), approved('BRIEF', 'brief'));
    await publish(
      approved('DESIGN', 'tech_design', { derivedFrom: ['SPEC'] }),
      approved('TICKET', 'ticket', { derivedFrom: ['SPEC#ac-1', 'SPEC#ac-2', 'BRIEF'] }),
    );
    await publish(approved('SPEC', 'spec', { body: '# AC 1\nchanged\n# AC 2\nsecond\n' }));

    const graph = await lineageGraph(e.store, p.id);

    expect(graph.nodes).toEqual([
      { id: 'BRIEF', type: 'brief', version: 1, status: 'approved', staleSections: [] },
      { id: 'DESIGN', type: 'tech_design', version: 1, status: 'stale', staleSections: [] },
      { id: 'SPEC', type: 'spec', version: 2, status: 'approved', staleSections: [] },
      { id: 'TICKET', type: 'ticket', version: 1, status: 'stale', staleSections: ['ac-1'] },
    ]);
    expect(graph.edges).toEqual([
      { from: 'SPEC', to: 'DESIGN', section: null, pinnedVersion: 1, stale: true },
      { from: 'SPEC', to: 'TICKET', section: 'ac-1', pinnedVersion: 1, stale: true },
      { from: 'SPEC', to: 'TICKET', section: 'ac-2', pinnedVersion: 1, stale: false },
      { from: 'BRIEF', to: 'TICKET', section: null, pinnedVersion: 1, stale: false },
    ]);
  });

  it('lineageGraph leaves out what older versions were pinned to', async () => {
    await publish(approved('SPEC', 'spec'), approved('BRIEF', 'brief'));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['SPEC'] }));
    await publish(approved('TICKET', 'ticket', { derivedFrom: ['BRIEF'], body: '# Moved on\n' }));

    const { edges } = await lineageGraph(e.store, p.id);

    expect(edges.map((edge) => edge.from)).toEqual(['BRIEF']);
  });
});
