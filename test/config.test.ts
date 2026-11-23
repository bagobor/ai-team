import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
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
      chrome: { binary: null },
      trials: { judgeModel: 'claude-opus-5-5', judgeRuns: 3, capUsd: 10, localJudge: null },
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

  it('reads how a change to what a role knows is tried', () => {
    const cfg = loadConfig(home('trials:\n  judge_model: some-model\n  judge_runs: 5\n  cap_usd: 2.5\n  local_judge:\n    url: http://127.0.0.1:11434/v1\n    model: qwen3\n'));

    expect(cfg.trials).toEqual({ judgeModel: 'some-model', judgeRuns: 5, capUsd: 2.5, localJudge: { url: 'http://127.0.0.1:11434/v1', model: 'qwen3' } });
    expect(DEFAULT_CONFIG.trials.localJudge).toBeNull();
  });

  it.each(['judge_runs: 0', 'judge_runs: 1.5', 'cap_usd: 0', 'judge_model: ""', 'local_judge:\n    url: http://x', 'judges: 3'])('refuses trials with %j', (line) => {
    expect(() => loadConfig(home(`trials:\n  ${line}\n`))).toThrow(/trials\./);
  });

  it('rejects an empty value of the wrong type', () => {
    expect(() => loadConfig(home('max_workers: lots\n'))).toThrow(/max_workers/);
  });

  it('reads chrome.binary', () => {
    const cfg = loadConfig(home('chrome:\n  binary: /opt/chrome/chrome\n'));
    expect(cfg.chrome).toEqual({ binary: '/opt/chrome/chrome' });
    // A loaded setting must not leak into the defaults the next load starts from.
    expect(DEFAULT_CONFIG.chrome).toEqual({ binary: null });
    expect(loadConfig(home()).chrome).toEqual({ binary: null });
  });

  it('rejects an unknown chrome key', () => {
    expect(() => loadConfig(home('chrome:\n  path: /opt/chrome/chrome\n'))).toThrow(/unknown key chrome.path/);
    expect(() => loadConfig(home('chrome:\n  binary: ""\n'))).toThrow(/chrome.binary/);
    expect(() => loadConfig(home('chrome:\n  binary: 3\n'))).toThrow(/chrome.binary/);
    expect(() => loadConfig(home('chrome: /opt/chrome\n'))).toThrow(/chrome must be a mapping/);
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
      trials: '/h/trials',
    });
  });

  it('defaults to ~/.aiteam', () => {
    expect(resolvePaths({ HOME: '/u' }).root).toBe('/u/.aiteam');
  });
});
