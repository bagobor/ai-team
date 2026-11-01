import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { openDb } from '../src/db/open.ts';
import type { DB } from '../src/db/schema.ts';
import { addProject, addTicket, type IntakeDeps } from '../src/engine/intake.ts';
import { Store } from '../src/engine/store.ts';
import { EventLog } from '../src/events.ts';
import { commitArtifact } from '../src/git/state-repo.ts';
import { resolvePaths, stateRepoDir } from '../src/paths.ts';
import { TicketError } from '../src/tickets/ticket.ts';
import { makeRepo, revParse, run, tempDir } from './helpers/repo.ts';

const seedKnowledge = fileURLToPath(new URL('../seed/knowledge', import.meta.url));
const t1 = readFileSync(new URL('./fixtures/tickets/T-1.md', import.meta.url), 'utf8');
const withField = (md: string, field: string, yaml: string) => md.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: ${yaml}`);

describe('intake', () => {
  let db: Kysely<DB>;
  let deps: IntakeDeps;
  let repo: string;

  beforeEach(async () => {
    const paths = resolvePaths({ AITEAM_HOME: tempDir() });
    cpSync(seedKnowledge, paths.knowledge, { recursive: true });
    db = await openDb(':memory:');
    deps = { store: new Store(db, new EventLog(db)), paths };
    repo = (await makeRepo()).path;
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('addProject', () => {
    it('records the project with its base branch and makes its state repo', async () => {
      const project = await addProject(deps, { name: 'p', repoPath: repo, create: false });

      expect(project).toMatchObject({ name: 'p', repo_path: repo, base_branch: 'main' });
      expect(run(stateRepoDir(deps.paths, 'p'), 'rev-list', '--count', 'HEAD')).toBe('1');
    });

    it('creates a new repo when asked', async () => {
      const path = join(tempDir(), 'greenfield');
      const project = await addProject(deps, { name: 'p', repoPath: path, create: true });
      expect(project.repo_path).toBe(path);
      expect(existsSync(join(path, '.git'))).toBe(true);
    });

    it('refuses a path that is not a repo without create', async () => {
      await expect(addProject(deps, { name: 'p', repoPath: tempDir(), create: false })).rejects.toThrow(/not a git repository/);
      expect(await deps.store.getProject('p')).toBeUndefined();
    });

    it.each(['../x', 'a/b', '.hidden', 'a b', ''])('rejects the unsafe name %j', async (name) => {
      await expect(addProject(deps, { name, repoPath: repo, create: false })).rejects.toThrow(/project name/i);
      expect(await deps.store.listProjects()).toEqual([]);
    });

    it('rejects a duplicate name, ignoring case', async () => {
      await addProject(deps, { name: 'Proj', repoPath: repo, create: false });
      await expect(addProject(deps, { name: 'proj', repoPath: repo, create: false })).rejects.toThrow(/already exists/);
    });
  });

  describe('addTicket', () => {
    beforeEach(async () => {
      await addProject(deps, { name: 'p', repoPath: repo, create: false });
    });

    const stateHead = () => revParse(stateRepoDir(deps.paths, 'p'));

    it('refuses a hand-added ticket whose input does not resolve', async () => {
      const added = addTicket(deps, 'p', withField(t1, 'inputs', '[SPEC-M1@1#ac-1]'));

      await expect(added).rejects.toBeInstanceOf(TicketError);
      await expect(addTicket(deps, 'p', withField(t1, 'inputs', '[SPEC-M1@1#ac-1]'))).rejects.toThrow(/SPEC-M1@1#ac-1/);
      expect(await deps.store.listTasks((await deps.store.getProject('p'))!.id)).toEqual([]);
    });

    it('refuses an input that names a section the artifact lacks', async () => {
      const project = (await deps.store.getProject('p'))!;
      await new ArtifactStore(deps.store, deps.paths).commit(project, {
        message: 'spec',
        publish: [{ id: 'SPEC-M1', type: 'spec', status: 'approved', ownerRole: 'pm', derivedFrom: [], body: '# AC-1\nGreets.\n' }],
      });

      await expect(addTicket(deps, 'p', withField(t1, 'inputs', '[SPEC-M1#ac-9]'))).rejects.toThrow(/SPEC-M1#ac-9/);
    });

    it('accepts a ticket whose inputs resolve', async () => {
      const project = (await deps.store.getProject('p'))!;
      await new ArtifactStore(deps.store, deps.paths).commit(project, {
        message: 'spec',
        publish: [{ id: 'SPEC-M1', type: 'spec', status: 'approved', ownerRole: 'pm', derivedFrom: [], body: '# AC-1\nGreets.\n' }],
      });

      const t = await addTicket(deps, 'p', withField(t1, 'inputs', '[SPEC-M1@1#ac-1]'));

      expect(t.ticket_id).toBe('T-1');
    });

    it('refuses a specialty that cannot edit the repo', async () => {
      await expect(addTicket(deps, 'p', withField(t1, 'specialty', 'pm'))).rejects.toThrow(/pm.*edit/);
    });

    it('commits the ticket first, then records its sha', async () => {
      const t = await addTicket(deps, 'p', t1);

      expect(t.ticket_sha).toBe(await stateHead());
      expect(t.state).toBe('queued');
      expect(t).toMatchObject({
        ticket_id: 'T-1',
        milestone: 1,
        role_id: 'engineer',
        ticket_path: 'artifacts/ticket/T-1.md',
        touches: ['src/**'],
        depends_on: [],
        dod: ['node --test'],
      });
      expect(readFileSync(join(stateRepoDir(deps.paths, 'p'), t.ticket_path), 'utf8')).toBe(t1);
    });

    it('imports a ticket whose earlier import crashed between its commit and its row', async () => {
      const { sha } = await commitArtifact(stateRepoDir(deps.paths, 'p'), 'artifacts/ticket/T-1.md', t1, 'ticket: T-1');

      const t = await addTicket(deps, 'p', t1);

      expect(t.ticket_sha).toBe(sha);
      expect(await stateHead()).toBe(sha);
    });

    it('rejects a duplicate ticket without a new commit', async () => {
      await addTicket(deps, 'p', t1);
      const head = await stateHead();

      await expect(addTicket(deps, 'p', t1)).rejects.toThrow(TicketError);

      expect(await stateHead()).toBe(head);
    });

    it('treats ids differing only in case as duplicates, since they share a file on macOS', async () => {
      await addTicket(deps, 'p', t1);
      await expect(addTicket(deps, 'p', withField(t1, 'id', 't-1'))).rejects.toThrow(/already exists/);
    });

    it('rejects an unknown dependency', async () => {
      const head = await stateHead();
      await expect(addTicket(deps, 'p', withField(t1, 'depends_on', '[T-9]'))).rejects.toThrow(/T-9/);
      expect(await stateHead()).toBe(head);
    });

    it('rejects a ticket that depends on itself', async () => {
      await expect(addTicket(deps, 'p', withField(t1, 'depends_on', '[T-1]'))).rejects.toThrow(/T-1/);
    });

    it('accepts a dependency that is already imported', async () => {
      await addTicket(deps, 'p', t1);
      const t2 = await addTicket(deps, 'p', withField(withField(t1, 'id', 'T-2'), 'depends_on', '[T-1]'));
      expect(t2.depends_on).toEqual(['T-1']);
    });

    it('rejects a specialty with no role', async () => {
      const head = await stateHead();
      await expect(addTicket(deps, 'p', withField(t1, 'specialty', 'designer'))).rejects.toThrow(/designer/);
      expect(await stateHead()).toBe(head);
    });

    it('fails clearly for an unknown project', async () => {
      await expect(addTicket(deps, 'nope', t1)).rejects.toThrow(/nope/);
    });
  });
});
