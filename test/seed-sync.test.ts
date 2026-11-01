import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, type Paths } from '../src/paths.ts';
import { runSetup, syncSeed } from '../src/setup/setup.ts';

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const commits = (dir: string) => gitIn(dir, 'log', '--format=%s').split('\n');

describe('syncSeed', () => {
  let p: Paths;

  beforeEach(async () => {
    p = resolvePaths({ AITEAM_HOME: mkdtempSync(join(tmpdir(), 'aiteam-seed-')) });
    await runSetup(p);
  });

  it('adds missing roles and schemas to an existing knowledge repo and commits once', async () => {
    rmSync(join(p.knowledge, 'roles/pm'), { recursive: true });
    rmSync(join(p.knowledge, 'schemas/discovery.json'));
    gitIn(p.knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    gitIn(p.knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'an older knowledge repo');

    const result = await syncSeed(p);

    expect(result.added).toEqual(['roles/pm/charter.md', 'roles/pm/role.yaml', 'schemas/discovery.json']);
    expect(existsSync(join(p.knowledge, 'roles/pm/role.yaml'))).toBe(true);
    expect(commits(p.knowledge)).toEqual(['seed: add new roles and schemas', 'an older knowledge repo', 'Seed the knowledge repo']);
    expect(gitIn(p.knowledge, 'status', '--porcelain')).toBe('');
  });

  it('never overwrites a charter a person edited, and reports it', async () => {
    const charter = join(p.knowledge, 'roles/engineer/charter.md');
    writeFileSync(charter, 'curated by a human\n');

    const result = await syncSeed(p);

    expect(readFileSync(charter, 'utf8')).toBe('curated by a human\n');
    expect(result).toEqual({ added: [], kept: ['roles/engineer/charter.md'] });
  });

  it('does nothing on a second run', async () => {
    const before = gitIn(p.knowledge, 'rev-parse', 'HEAD');

    expect(await syncSeed(p)).toEqual({ added: [], kept: [] });

    expect(gitIn(p.knowledge, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('leaves a person\'s other work out of its commit', async () => {
    rmSync(join(p.knowledge, 'roles/pm/charter.md'));
    gitIn(p.knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    gitIn(p.knowledge, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'drop');
    mkdirSync(join(p.knowledge, 'notes'));
    writeFileSync(join(p.knowledge, 'notes/draft.md'), 'in progress\n');
    gitIn(p.knowledge, 'add', 'notes/draft.md');

    await syncSeed(p);

    expect(gitIn(p.knowledge, 'show', '--name-only', '--format=', 'HEAD')).toBe('roles/pm/charter.md');
    expect(gitIn(p.knowledge, 'status', '--porcelain')).toBe('A  notes/draft.md');
  });

  it('does nothing when there is no knowledge repo yet', async () => {
    const fresh = resolvePaths({ AITEAM_HOME: mkdtempSync(join(tmpdir(), 'aiteam-seed-')) });

    expect(await syncSeed(fresh)).toEqual({ added: [], kept: [] });
    expect(existsSync(fresh.knowledge)).toBe(false);
  });
});
