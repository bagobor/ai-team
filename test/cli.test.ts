import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.ts';
import { startDaemon } from '../src/daemon.ts';
import { resolvePaths, type Paths } from '../src/paths.ts';
import { runSetup } from '../src/setup/setup.ts';
import { ticket } from './helpers/engine.ts';
import { makeRepo, tempDir } from './helpers/repo.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

type Outcome = { code: number | null; stdout: string; stderr: string };

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  probe.close();
  await once(probe, 'close');
  return port;
}

describe('the aiteam command', () => {
  let root: string;
  let paths: Paths;
  let daemon: { stop(): Promise<void> } | undefined;

  beforeEach(async () => {
    root = tempDir('aiteam-cli-');
    paths = resolvePaths({ AITEAM_HOME: join(root, 'home') });
    await runSetup(paths);
    writeFileSync(paths.config, stringify({ port: await freePort(), claude: { binary: FAKE_CLAUDE } }));
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  async function aiteam(args: string[], opts: { cwd?: string; home?: string } = {}): Promise<Outcome> {
    const child = spawn(process.execPath, ['--import', join(PROJECT_ROOT, 'node_modules/tsx/dist/loader.mjs'), CLI, ...args], {
      cwd: opts.cwd ?? PROJECT_ROOT,
      env: { ...process.env, AITEAM_HOME: opts.home ?? paths.root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const [code] = (await once(child, 'close')) as [number | null];
    return { code, stdout, stderr };
  }

  async function withDaemon(): Promise<void> {
    daemon = await startDaemon({ paths, config: loadConfig(paths) });
  }

  const apiGet = async (path: string) => {
    const { port } = loadConfig(paths);
    return (await fetch(`http://127.0.0.1:${port}${path}`)).json();
  };

  it('prints usage and exits 2 for an unknown command', async () => {
    const { code, stderr } = await aiteam(['nonsense']);

    expect(code).toBe(2);
    expect(stderr).toContain('aiteam project add');
    expect(stderr).toContain('aiteam ticket add');
    expect(stderr).toContain('aiteam brief add');
    expect(stderr).toContain('aiteam doctor');
  });

  it.each([[['project']], [['project', 'add', 'only-a-name']], [['ticket', 'add', 'p']], [['project', 'remove', 'a', 'b']], [['project', 'add', 'a', 'b', 'c']], [['ticket', 'add', 'p', 'a.md', 'b.md']], [['brief', 'add', 'p']], [['brief', 'remove', 'p', 'a.md']], [['brief', 'add', 'p', 'a.md', 'b.md']], [['--nope']]])('prints usage for %j', async (args) => {
    expect((await aiteam(args)).code).toBe(2);
  });

  it('doctor prints each check and exits 0 when they pass', async () => {
    const { code, stdout } = await aiteam(['doctor']);

    expect(stdout).toMatch(/ok\s+node/);
    expect(stdout).toMatch(/ok\s+agent-home login/);
    expect(code).toBe(0);
  });

  it('doctor exits 1 and says how to fix a failing check', async () => {
    writeFileSync(paths.config, stringify({ claude: { binary: FAKE_CLAUDE, extra_env: { FAKE_AUTH: '{"loggedIn":false}' } } }));

    const { code, stdout } = await aiteam(['doctor']);

    expect(code).toBe(1);
    expect(stdout).toMatch(/FAIL\s+agent-home login/);
    expect(stdout).toContain('claude auth login');
  });

  it('adds a project and a ticket through the daemon', async () => {
    await withDaemon();
    const repo = await makeRepo();
    const file = join(root, 'T-1.md');
    writeFileSync(file, ticket());

    const added = await aiteam(['project', 'add', 'p', repo.path]);
    const ticketed = await aiteam(['ticket', 'add', 'p', file]);

    expect(added.code).toBe(0);
    expect(added.stdout).toContain('Added project p');
    expect(ticketed.code).toBe(0);
    expect(ticketed.stdout).toContain('Added ticket T-1');
    expect(await apiGet('/api/tasks?project=p')).toMatchObject([{ ticket_id: 'T-1' }]);
  });

  it('posts a brief to the daemon', async () => {
    await withDaemon();
    const repo = await makeRepo();
    const file = join(root, 'brief.md');
    writeFileSync(file, '# Brief\n\nA small tool.\n');
    await aiteam(['project', 'add', 'p', repo.path]);

    const { code, stdout } = await aiteam(['brief', 'add', 'p', file]);

    expect(code).toBe(0);
    expect(stdout).toContain('Added the brief to p');
    expect(await apiGet('/api/projects/p/artifacts/BRIEF')).toMatchObject({ type: 'brief', body: '# Brief\n\nA small tool.\n' });
  });

  it('reports a brief file it cannot read', async () => {
    await withDaemon();

    const { code, stderr } = await aiteam(['brief', 'add', 'p', join(root, 'missing.md')]);

    expect(code).toBe(1);
    expect(stderr).toContain('missing.md');
  });

  it('creates the repo with --create', async () => {
    await withDaemon();

    const { code } = await aiteam(['project', 'add', 'p', join(root, 'fresh'), '--create']);

    expect(code).toBe(0);
    expect(await apiGet('/api/projects')).toMatchObject([{ name: 'p', repo_path: join(root, 'fresh') }]);
  });

  it('takes a relative repo path from where it was run, not where the daemon was', async () => {
    await withDaemon();
    const repo = await makeRepo();

    const { code } = await aiteam(['project', 'add', 'p', '.'], { cwd: repo.path });

    expect(code).toBe(0);
    const [project] = (await apiGet('/api/projects')) as [{ repo_path: string }];
    expect(project.repo_path.endsWith(repo.path.split('/').at(-1)!)).toBe(true);
  });

  it("prints the daemon's error and exits 1", async () => {
    await withDaemon();
    const notARepo = tempDir();

    const { code, stderr } = await aiteam(['project', 'add', 'p', notARepo]);

    expect(code).toBe(1);
    expect(stderr).toContain('not a git repository');
    expect(stderr).not.toContain('{');
  });

  it('reports a ticket file it cannot read', async () => {
    await withDaemon();

    const { code, stderr } = await aiteam(['ticket', 'add', 'p', join(root, 'missing.md')]);

    expect(code).toBe(1);
    expect(stderr).toContain('missing.md');
  });

  it('says when the daemon is not running', async () => {
    const { code, stderr } = await aiteam(['project', 'add', 'p', root]);

    expect(code).toBe(1);
    expect(stderr).toContain('aiteam daemon');
  });

  it('daemon asks for setup when it has not been run', async () => {
    const { code, stderr } = await aiteam(['daemon'], { home: join(root, 'empty') });

    expect(code).toBe(1);
    expect(stderr).toContain('aiteam setup');
  });
});
