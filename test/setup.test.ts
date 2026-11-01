import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, type Paths } from '../src/paths.ts';
import { runSetup } from '../src/setup/setup.ts';

function freshHome(): Paths {
  return resolvePaths({ AITEAM_HOME: mkdtempSync(join(tmpdir(), 'aiteam-setup-')) });
}

describe('runSetup', () => {
  it('creates the knowledge repo and an empty agent home', async () => {
    const p = freshHome();
    const r = await runSetup(p);
    expect(existsSync(join(p.knowledge, '.git'))).toBe(true);
    expect(existsSync(join(p.knowledge, 'roles/engineer/role.yaml'))).toBe(true);
    expect(existsSync(join(p.knowledge, 'schemas/change_report.json'))).toBe(true);
    expect(statSync(p.claudeHome).mode & 0o777).toBe(0o700);
    expect(readdirSync(p.claudeHome)).toEqual([]);
    expect(r.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${p.claudeHome} claude auth login`);
    const log = execFileSync('git', ['-C', p.knowledge, 'log', '--oneline'], { encoding: 'utf8' });
    expect(log.trim().split('\n')).toHaveLength(1);
  });

  it('never overwrites a curated charter on re-run', async () => {
    const p = freshHome();
    await runSetup(p);
    const charter = join(p.knowledge, 'roles/engineer/charter.md');
    writeFileSync(charter, 'curated by a human\n');
    const second = await runSetup(p);
    expect(readFileSync(charter, 'utf8')).toBe('curated by a human\n');
    expect(second.created).toEqual([]);
  });

  it('reports a kept file and adds missing ones when re-run', async () => {
    const p = freshHome();
    await runSetup(p);
    writeFileSync(join(p.knowledge, 'roles/engineer/charter.md'), 'curated by a human\n');
    rmSync(join(p.knowledge, 'roles/pm'), { recursive: true });

    const second = await runSetup(p);

    expect(second.kept).toEqual(['roles/engineer/charter.md']);
    expect(second.added).toEqual(['roles/pm/charter.md', 'roles/pm/role.yaml']);
  });

  it('keeps existing agent-home files when re-run', async () => {
    const p = freshHome();
    await runSetup(p);
    writeFileSync(join(p.claudeHome, '.credentials.json'), '{}');
    await runSetup(p);
    expect(readdirSync(p.claudeHome)).toEqual(['.credentials.json']);
  });
});
