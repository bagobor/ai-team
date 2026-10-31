import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { resolvePaths, type Paths } from '../src/paths.ts';
import { runDoctor } from '../src/setup/doctor.ts';
import { tempDir } from './helpers/repo.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

describe('runDoctor', () => {
  let paths: Paths;

  beforeEach(() => {
    paths = resolvePaths({ AITEAM_HOME: join(tempDir('aiteam-doctor-'), 'home') });
    mkdirSync(paths.worktrees, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const config = (extraEnv: Record<string, string> = {}, binary = FAKE_CLAUDE): Config => ({ ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, binary, extraEnv } });

  async function check(name: string, cfg = config()) {
    const found = (await runDoctor(paths, cfg)).find((c) => c.name === name);
    if (!found) throw new Error(`No check named ${name}`);
    return found;
  }

  it('runs the five checks and passes them on a healthy machine', async () => {
    const checks = await runDoctor(paths, config());

    expect(checks.map((c) => c.name)).toEqual(['node', 'git', 'claude binary', 'agent-home login', 'instruction files']);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('reports the versions it found', async () => {
    expect((await check('node')).detail).toContain(process.versions.node);
    expect((await check('git')).detail).toMatch(/git version/);
    expect((await check('claude binary')).detail).toMatch(/\d+\.\d+/);
  });

  it('flags a Node older than 22', async () => {
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, node: '20.11.1' });

    const node = await check('node');

    expect(node.ok).toBe(false);
    expect(node.detail).toContain('20.11.1');
  });

  it('flags a missing git', async () => {
    vi.stubEnv('PATH', tempDir());

    const git = await check('git');

    expect(git.ok).toBe(false);
    expect(git.detail).toContain('git');
  });

  it('flags a missing claude binary and names it', async () => {
    const missing = join(tempDir(), 'no-such-claude');

    const binary = await check('claude binary', config({}, missing));

    expect(binary.ok).toBe(false);
    expect(binary.detail).toContain(missing);
    expect(binary.detail).toContain('claude.binary');
  });

  it('flags a logged-out agent home with the login command', async () => {
    const login = await check('agent-home login', config({ FAKE_AUTH: '{"loggedIn":false}' }));

    expect(login.ok).toBe(false);
    expect(login.detail).toContain(`CLAUDE_CONFIG_DIR=${paths.claudeHome} claude auth login`);
  });

  it('checks the login in the agent home', async () => {
    expect((await check('agent-home login', config({ FAKE_AUTH_HOME: paths.claudeHome }))).ok).toBe(true);
    expect((await check('agent-home login', config({ FAKE_AUTH_HOME: join(tempDir(), 'some-other-home') }))).ok).toBe(false);
  });

  it('flags a CLAUDE.md above the worktree root', async () => {
    const file = join(paths.root, 'CLAUDE.md');
    writeFileSync(file, 'instructions');

    const instructions = await check('instruction files');

    expect(instructions.ok).toBe(false);
    expect(instructions.detail).toContain(file);
  });

  it('looks in the folder right above the worktrees', async () => {
    const file = join(paths.worktrees, 'AGENTS.md');
    writeFileSync(file, 'instructions');

    expect((await check('instruction files')).detail).toContain(file);
  });
});
