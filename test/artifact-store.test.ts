import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ArtifactError, parseArtifact } from '../src/artifacts/format.ts';
import type { NewVersion } from '../src/artifacts/store.ts';
import type { ProjectRow } from '../src/engine/store.ts';
import { stateRepoDir } from '../src/paths.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';
import { run } from './helpers/repo.ts';

const ticketMarkdown = `---
id: T1
title: A hand-added ticket
milestone: 1
ac_refs: []
specialty: engineer
touches: ['**']
depends_on: []
definition_of_done: ['true']
inputs: []
size: S
---
Do it.
`;

const version = (overrides: Partial<NewVersion> = {}): NewVersion => ({
  id: 'ROADMAP',
  type: 'roadmap',
  status: 'proposed',
  ownerRole: 'pm',
  derivedFrom: [],
  body: '# Roadmap\n',
  ...overrides,
});

describe('ArtifactStore', () => {
  let e: TestEngine;
  let p: ProjectRow;
  let dir: string;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    const project = await e.store.getProject('p');
    if (!project) throw new Error('makeEngine should have created project p');
    p = project;
    dir = stateRepoDir(e.paths, 'p');
  });

  afterEach(() => e.cleanup());

  const commitCount = () => Number(run(dir, 'rev-list', '--count', 'HEAD'));
  const onDisk = (path = 'artifacts/roadmap/ROADMAP.md') => readFileSync(join(dir, path), 'utf8');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  it('publishes a batch in one git commit and records the versions', async () => {
    const before = commitCount();

    const rows = await e.artifacts.commit(p, { message: 'plan', publish: [version({ id: 'BRIEF', type: 'brief' }), version()] });

    expect(rows.map((r) => [r.artifact_id, r.version, r.status])).toEqual([
      ['BRIEF', 1, 'proposed'],
      ['ROADMAP', 1, 'proposed'],
    ]);
    expect(rows[0]?.sha).toBe(run(dir, 'rev-parse', 'HEAD'));
    expect(rows[1]?.sha).toBe(rows[0]?.sha);
    expect(commitCount()).toBe(before + 1);
    expect(rows[1]?.path).toBe('artifacts/roadmap/ROADMAP.md');
    expect(parseArtifact(onDisk()).version).toBe(1);
  });

  it('numbers versions per artifact and supersedes the previous one', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version(), version({ id: 'BRIEF', type: 'brief' })] });

    const [second] = await e.artifacts.commit(p, { message: 'two', publish: [version({ body: '# Two\n' })] });

    expect(second?.version).toBe(2);
    expect((await e.artifacts.version(p.id, 'ROADMAP', 1))?.status).toBe('superseded');
    expect((await e.artifacts.latest(p.id, 'ROADMAP'))?.version).toBe(2);
    expect((await e.artifacts.latest(p.id, 'BRIEF'))?.version).toBe(1);
    expect((await e.artifacts.list(p.id)).map((r) => [r.artifact_id, r.version])).toEqual([
      ['BRIEF', 1],
      ['ROADMAP', 2],
    ]);
    expect(parseArtifact(onDisk()).version).toBe(2);
  });

  it('runs then with no new commit when a change has nothing to publish', async () => {
    const before = commitCount();
    const then = vi.fn(async () => undefined);

    const rows = await e.artifacts.commit(p, { message: 'nothing' }, then);

    expect(rows).toEqual([]);
    expect(then).toHaveBeenCalledOnce();
    expect(commitCount()).toBe(before);
  });

  it('commits a then that writes through its store together with the versions', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version()] }, async (s) => {
      await s.setProjectPhase(p.id, 'discovery');
    });

    expect((await e.store.getProject('p'))?.phase).toBe('discovery');
    expect(await e.artifacts.latest(p.id, 'ROADMAP')).toBeDefined();
  });

  it('reads an old version through its sha', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version({ body: '# One\n' })] });
    await e.artifacts.commit(p, { message: 'two', publish: [version({ body: '# Two\n' })] });

    const old = await e.artifacts.read(p, 'ROADMAP@1');

    expect(old.body).toBe('# One\n');
    expect(old.version).toBe(1);
    expect(old.status).toBe('superseded');
    expect((await e.artifacts.read(p, 'ROADMAP')).body).toBe('# Two\n');
  });

  it('refuses to read an artifact or a version that is not there', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version()] });

    await expect(e.artifacts.read(p, 'NOPE')).rejects.toThrow(ArtifactError);
    await expect(e.artifacts.read(p, 'ROADMAP@9')).rejects.toThrow(ArtifactError);
  });

  it('resolves a bare pin to the batch version, else the latest', async () => {
    await e.artifacts.commit(p, { message: 'brief', publish: [version({ id: 'BRIEF', type: 'brief' })] });
    await e.artifacts.commit(p, { message: 'brief 2', publish: [version({ id: 'BRIEF', type: 'brief' })] });
    await e.artifacts.commit(p, { message: 'road', publish: [version()] });

    const rows = await e.artifacts.commit(p, {
      message: 'batch',
      publish: [version({ body: '# Roadmap two\n' }), version({ id: 'SPEC-M1', type: 'spec', derivedFrom: ['ROADMAP', 'BRIEF', 'BRIEF@1'] })],
    });

    expect(rows[1]?.derived_from).toEqual(['ROADMAP@2', 'BRIEF@2', 'BRIEF@1']);
    expect((await e.artifacts.read(p, 'SPEC-M1')).derivedFrom).toEqual(['ROADMAP@2', 'BRIEF@2', 'BRIEF@1']);
    const deps = await e.db.selectFrom('artifact_deps').selectAll().where('from_id', '=', 'SPEC-M1').execute();
    expect(deps.map((d) => [d.to_id, d.to_version])).toEqual([
      ['ROADMAP', 2],
      ['BRIEF', 2],
      ['BRIEF', 1],
    ]);
  });

  it('records the hash of the section a pin names, in the batch or in git', async () => {
    await e.artifacts.commit(p, { message: 'spec', publish: [version({ id: 'SPEC-M1', type: 'spec', body: '# AC 1\nfirst\n# AC 2\nsecond\n' })] });

    await e.artifacts.commit(p, {
      message: 'batch',
      publish: [
        version({ body: '# Part\ntext\n' }),
        version({ id: 'TICKET-1', type: 'ticket', derivedFrom: ['SPEC-M1#ac-2', 'ROADMAP#part'] }),
      ],
    });

    const deps = await e.db.selectFrom('artifact_deps').selectAll().where('from_id', '=', 'TICKET-1').execute();
    expect(deps.map((d) => [d.to_id, d.to_version, d.to_section])).toEqual([
      ['SPEC-M1', 1, 'ac-2'],
      ['ROADMAP', 1, 'part'],
    ]);
    expect(deps[0]?.to_section_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(deps[1]?.to_section_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes nothing for a change that pins something missing', async () => {
    const before = commitCount();

    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ derivedFrom: ['NOPE'] })] })).rejects.toThrow(ArtifactError);
    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ derivedFrom: ['ROADMAP@7'] })] })).rejects.toThrow(ArtifactError);
    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ derivedFrom: ['ROADMAP#gone'] })] })).rejects.toThrow(ArtifactError);

    expect(commitCount()).toBe(before);
    expect(await e.artifacts.latest(p.id, 'ROADMAP')).toBeUndefined();
  });

  it('refuses a version that derives from itself', async () => {
    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ derivedFrom: ['ROADMAP'] })] })).rejects.toThrow(ArtifactError);
  });

  it('lets a version derive from an earlier version of itself', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version()] });

    const [row] = await e.artifacts.commit(p, { message: 'two', publish: [version({ derivedFrom: ['ROADMAP@1'] })] });

    expect(row?.derived_from).toEqual(['ROADMAP@1']);
  });

  it('refuses one artifact published twice in a change', async () => {
    await expect(e.artifacts.commit(p, { message: 'x', publish: [version(), version()] })).rejects.toThrow(ArtifactError);
  });

  it('refuses an id that differs from another only by case, since those name one file on macOS', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version()] });

    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ id: 'roadmap' })] })).rejects.toThrow(ArtifactError);
    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ id: 'BRIEF', type: 'brief' }), version({ id: 'brief', type: 'brief' })] })).rejects.toThrow(
      ArtifactError,
    );
  });

  it('refuses a new version under a different type, which would leave the old file behind', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version()] });

    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ type: 'spec' })] })).rejects.toThrow(ArtifactError);
  });

  it('refuses an id that could not be a safe file name', async () => {
    await expect(e.artifacts.commit(p, { message: 'x', publish: [version({ id: '../evil' })] })).rejects.toThrow(ArtifactError);
  });

  describe('status changes', () => {
    it('re-renders the file, moves the row and survives reconcile', async () => {
      await e.artifacts.commit(p, { message: 'one', publish: [version()] });
      const before = commitCount();

      const [row] = await e.artifacts.commit(p, { message: 'approve', status: [{ id: 'ROADMAP', status: 'approved', approvedBy: 'stakeholder' }] });

      expect(commitCount()).toBe(before + 1);
      expect(row).toMatchObject({ artifact_id: 'ROADMAP', version: 1, status: 'approved', approved_by: 'stakeholder' });
      expect(row?.approved_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(row?.sha).toBe(run(dir, 'rev-parse', 'HEAD'));
      expect(parseArtifact(onDisk())).toMatchObject({ status: 'approved', approvedBy: 'stakeholder', version: 1 });

      expect((await e.artifacts.reconcile(p)).restored).toEqual([]);
      expect(parseArtifact(onDisk()).status).toBe('approved');
    });

    it('applies to a version published in the same change', async () => {
      const rows = await e.artifacts.commit(p, {
        message: 'one',
        publish: [version()],
        status: [{ id: 'ROADMAP', status: 'approved', approvedBy: 'stakeholder' }],
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, status: 'approved', approved_by: 'stakeholder' });
      expect(parseArtifact(onDisk()).status).toBe('approved');
    });

    it('records stale sections and clears them when the artifact leaves stale', async () => {
      await e.artifacts.commit(p, { message: 'one', publish: [version()] });

      const [stale] = await e.artifacts.commit(p, { message: 'stale', status: [{ id: 'ROADMAP', status: 'stale', staleSections: ['ac-1'] }] });
      const [fresh] = await e.artifacts.commit(p, { message: 'fresh', status: [{ id: 'ROADMAP', status: 'approved' }] });

      expect(stale?.stale_sections).toEqual(['ac-1']);
      expect(fresh?.stale_sections).toEqual([]);
    });

    it('re-pins by replacing the dependency rows', async () => {
      await e.artifacts.commit(p, { message: 'brief', publish: [version({ id: 'BRIEF', type: 'brief' })] });
      await e.artifacts.commit(p, { message: 'road', publish: [version({ derivedFrom: ['BRIEF'] })] });
      await e.artifacts.commit(p, { message: 'brief 2', publish: [version({ id: 'BRIEF', type: 'brief', body: '# Two\n' })] });

      const [row] = await e.artifacts.commit(p, { message: 'repin', status: [{ id: 'ROADMAP', status: 'proposed', derivedFrom: ['BRIEF'] }] });

      expect(row?.derived_from).toEqual(['BRIEF@2']);
      const deps = await e.db.selectFrom('artifact_deps').selectAll().where('from_id', '=', 'ROADMAP').execute();
      expect(deps.map((d) => d.to_version)).toEqual([2]);
      expect((await e.artifacts.read(p, 'ROADMAP')).derivedFrom).toEqual(['BRIEF@2']);
    });

    it('refuses a status change for an artifact that is not there, with no commit', async () => {
      const before = commitCount();

      await expect(e.artifacts.commit(p, { message: 'x', status: [{ id: 'NOPE', status: 'approved' }] })).rejects.toThrow(ArtifactError);

      expect(commitCount()).toBe(before);
    });
  });

  describe('events', () => {
    const artifactEvents = async () =>
      (await e.log.list({ projectId: p.id })).filter((event) => event.type.startsWith('artifact.')).map((event) => [event.type, event.payload]);

    it('emits published and status events with the fields the UI reads', async () => {
      await e.artifacts.commit(p, { message: 'one', publish: [version()] });
      await e.artifacts.commit(p, { message: 'approve', status: [{ id: 'ROADMAP', status: 'approved' }] });

      expect(await artifactEvents()).toEqual([
        ['artifact.published', { id: 'ROADMAP', version: 1, status: 'proposed' }],
        ['artifact.status', { id: 'ROADMAP', status: 'approved' }],
      ]);
    });

    it('emits nothing when then throws', async () => {
      await expect(
        e.artifacts.commit(p, { message: 'one', publish: [version()] }, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await artifactEvents()).toEqual([]);
    });
  });

  describe('reconcile', () => {
    it('rolls the SQLite side back when then throws, and reconcile leaves the file for a retry', async () => {
      const change = { message: 'one', publish: [version()] };

      await expect(
        e.artifacts.commit(p, change, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await e.artifacts.latest(p.id, 'ROADMAP')).toBeUndefined();
      expect((await e.artifacts.reconcile(p)).restored).toEqual([]);

      const [row] = await e.artifacts.commit(p, change);
      expect(row?.version).toBe(1);
      expect(row?.sha).toBe(run(dir, 'rev-parse', 'HEAD'));
    });

    it('restores recorded content when HEAD disagrees', async () => {
      await e.artifacts.commit(p, { message: 'one', publish: [version({ body: '# Recorded\n' })] });
      write('artifacts/roadmap/ROADMAP.md', 'tampered\n');
      run(dir, 'add', '-A');
      run(dir, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'a commit SQLite never heard of');
      const before = commitCount();

      const { restored } = await e.artifacts.reconcile(p);

      expect(restored).toEqual(['ROADMAP']);
      expect(parseArtifact(onDisk()).body).toBe('# Recorded\n');
      expect(commitCount()).toBe(before + 1);
      expect(run(dir, 'log', '-1', '--format=%s')).toBe('reconcile: restore recorded artifact versions');
      expect((await e.artifacts.reconcile(p)).restored).toEqual([]);
    });

    it('restores a recorded file that a commit removed', async () => {
      await e.artifacts.commit(p, { message: 'one', publish: [version()] });
      run(dir, 'rm', '-q', 'artifacts/roadmap/ROADMAP.md');
      run(dir, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'gone');

      expect((await e.artifacts.reconcile(p)).restored).toEqual(['ROADMAP']);
      expect(parseArtifact(onDisk()).id).toBe('ROADMAP');
    });

    it('discards uncommitted edits in the state repo', async () => {
      await e.artifacts.commit(p, { message: 'one', publish: [version({ body: '# Recorded\n' })] });
      const before = commitCount();
      write('artifacts/roadmap/ROADMAP.md', 'half written\n');
      write('artifacts/spec/LEFTOVER.md', 'from a crash\n');

      const { restored } = await e.artifacts.reconcile(p);

      expect(restored).toEqual([]);
      expect(parseArtifact(onDisk()).body).toBe('# Recorded\n');
      expect(existsSync(join(dir, 'artifacts/spec/LEFTOVER.md'))).toBe(false);
      expect(commitCount()).toBe(before);
    });

    it('clears the lock a crash left in the state repo', async () => {
      await e.artifacts.commit(p, { message: 'one', publish: [version({ body: '# Recorded\n' })] });
      writeFileSync(join(dir, '.git', 'index.lock'), '');
      write('artifacts/roadmap/ROADMAP.md', 'half written\n');

      await e.artifacts.reconcile(p);

      expect(parseArtifact(onDisk()).body).toBe('# Recorded\n');
      await e.artifacts.commit(p, { message: 'two', publish: [version({ body: '# Next\n' })] });
      expect(parseArtifact(onDisk()).body).toBe('# Next\n');
    });

    it('leaves hand-added tickets alone', async () => {
      await e.addTicket(ticketMarkdown);

      const { restored } = await e.artifacts.reconcile(p);

      expect(restored).toEqual([]);
      expect(onDisk('artifacts/ticket/T1.md')).toBe(ticketMarkdown);
    });
  });

  it('diff returns unified text between two versions', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version({ body: 'old line\n' })] });
    await e.artifacts.commit(p, { message: 'two', publish: [version({ body: 'new line\n' })] });

    const diff = await e.artifacts.diff(p, 'ROADMAP', 1, 2);

    expect(diff).toContain('-old line');
    expect(diff).toContain('+new line');
  });

  it('refuses a diff of a version that is not there', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version()] });

    await expect(e.artifacts.diff(p, 'ROADMAP', 1, 2)).rejects.toThrow(ArtifactError);
  });

  it('readInput returns only the named section and the fully pinned id', async () => {
    await e.artifacts.commit(p, { message: 'spec', publish: [version({ id: 'SPEC-M1', type: 'spec', body: '# AC 1\nfirst\n# AC 2\nsecond\n' })] });

    const input = await e.artifacts.readInput(p, 'SPEC-M1#ac-2');

    expect(input).toEqual({ pin: 'SPEC-M1@1#ac-2', path: 'artifacts/spec/SPEC-M1.md', content: '# AC 2\nsecond\n' });
  });

  it('readInput returns the whole document for a pin with no section', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version({ body: '# One\n' })] });
    await e.artifacts.commit(p, { message: 'two', publish: [version({ body: '# Two\n' })] });

    const input = await e.artifacts.readInput(p, 'ROADMAP@1');

    expect(input.pin).toBe('ROADMAP@1');
    expect(input.content).toContain('# One\n');
    expect(input.content).not.toContain('# Two');
    expect(parseArtifact(input.content).version).toBe(1);
  });

  it('refuses an input pin with an unknown section', async () => {
    await e.artifacts.commit(p, { message: 'one', publish: [version()] });

    await expect(e.artifacts.readInput(p, 'ROADMAP#gone')).rejects.toThrow(ArtifactError);
  });
});
