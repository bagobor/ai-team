import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { resolvePaths } from '../src/paths.ts';

function home(configYaml?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aiteam-config-'));
  if (configYaml !== undefined) writeFileSync(join(dir, 'config.yaml'), configYaml);
  return resolvePaths({ AITEAM_HOME: dir });
}

describe('loadConfig', () => {
  it('applies spec defaults', () => {
    expect(loadConfig(home())).toEqual({
      port: 4780,
      maxWorkers: 3,
      maxAttempts: 3,
      attemptTimeoutS: 3600,
      checkTimeoutS: 600,
      cancelGraceS: 10,
      worktreeRetentionDays: 7,
      claude: { binary: 'claude', mode: 'subscription' },
    });
  });

  it('overlays snake_case keys', () => {
    const cfg = loadConfig(home('max_workers: 5\nclaude:\n  binary: /x/fake\n  extra_env:\n    A: "1"\n'));
    expect(cfg.maxWorkers).toBe(5);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.claude).toEqual({ binary: '/x/fake', mode: 'subscription', extraEnv: { A: '1' } });
  });

  it('rejects unknown keys by name', () => {
    expect(() => loadConfig(home('max_wrkers: 5\n'))).toThrow(/max_wrkers/);
    expect(() => loadConfig(home('claude:\n  binry: x\n'))).toThrow(/binry/);
  });

  it('rejects an empty value of the wrong type', () => {
    expect(() => loadConfig(home('max_workers: lots\n'))).toThrow(/max_workers/);
  });
});

describe('resolvePaths', () => {
  it('places everything under AITEAM_HOME', () => {
    const p = resolvePaths({ AITEAM_HOME: '/h' });
    expect(p).toEqual({
      root: '/h',
      db: '/h/aiteam.db',
      config: '/h/config.yaml',
      knowledge: '/h/knowledge',
      projects: '/h/projects',
      worktrees: '/h/worktrees',
      transcripts: '/h/transcripts',
      claudeHome: '/h/agent-home/claude',
    });
  });

  it('defaults to ~/.aiteam', () => {
    expect(resolvePaths({ HOME: '/u' }).root).toBe('/u/.aiteam');
  });
});
