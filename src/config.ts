import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Paths } from './paths.ts';

export type Config = {
  port: number;
  maxWorkers: number;
  maxAttempts: number;
  attemptTimeoutS: number;
  checkTimeoutS: number;
  cancelGraceS: number;
  worktreeRetentionDays: number;
  claude: {
    binary: string;
    mode: 'subscription' | 'api-key';
    extraEnv?: Record<string, string>;
  };
  // Null means the usual install path, which the play module knows.
  chrome: { binary: string | null };
  // Trying a change to what a role knows. judgeRuns is how many times the model judge is asked each question; a
  // local judge is an OpenAI-compatible address and a model, and null means there is none.
  trials: { judgeModel: string; judgeRuns: number; capUsd: number; localJudge: { url: string; model: string } | null };
};

const NUMERIC_KEYS = {
  port: 'port',
  max_workers: 'maxWorkers',
  max_attempts: 'maxAttempts',
  attempt_timeout_s: 'attemptTimeoutS',
  check_timeout_s: 'checkTimeoutS',
  cancel_grace_s: 'cancelGraceS',
  worktree_retention_days: 'worktreeRetentionDays',
} as const;

export const DEFAULT_CONFIG: Config = {
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
};

export function loadConfig(p: Paths): Config {
  const config: Config = { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude }, chrome: { ...DEFAULT_CONFIG.chrome }, trials: { ...DEFAULT_CONFIG.trials } };
  if (!existsSync(p.config)) return config;

  const raw: unknown = parse(readFileSync(p.config, 'utf8')) ?? {};
  if (!isRecord(raw)) throw new Error(`${p.config}: expected a mapping`);

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'claude') {
      applyClaude(config, value);
    } else if (key === 'chrome') {
      applyChrome(config, value);
    } else if (key === 'trials') {
      applyTrials(config, value);
    } else if (key in NUMERIC_KEYS) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`config.yaml: ${key} must be a non-negative number`);
      }
      config[NUMERIC_KEYS[key as keyof typeof NUMERIC_KEYS]] = value;
    } else {
      throw new Error(`config.yaml: unknown key ${key}`);
    }
  }
  return config;
}

function applyClaude(config: Config, raw: unknown): void {
  if (!isRecord(raw)) throw new Error('config.yaml: claude must be a mapping');
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'binary' && typeof value === 'string') {
      config.claude.binary = value;
    } else if (key === 'mode' && (value === 'subscription' || value === 'api-key')) {
      config.claude.mode = value;
    } else if (key === 'extra_env' && isRecord(value)) {
      config.claude.extraEnv = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
    } else {
      throw new Error(`config.yaml: invalid or unknown key claude.${key}`);
    }
  }
}

function applyChrome(config: Config, raw: unknown): void {
  if (!isRecord(raw)) throw new Error('config.yaml: chrome must be a mapping');
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'binary' && typeof value === 'string' && value.trim() !== '') {
      config.chrome.binary = value;
    } else {
      throw new Error(`config.yaml: invalid or unknown key chrome.${key}`);
    }
  }
}

function applyTrials(config: Config, raw: unknown): void {
  if (!isRecord(raw)) throw new Error('config.yaml: trials must be a mapping');
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'judge_model' && typeof value === 'string' && value.trim() !== '') {
      config.trials.judgeModel = value;
    } else if (key === 'judge_runs' && positive(value) && Number.isInteger(value)) {
      config.trials.judgeRuns = value;
    } else if (key === 'cap_usd' && positive(value)) {
      config.trials.capUsd = value;
    } else if (key === 'local_judge' && isRecord(value) && typeof value.url === 'string' && typeof value.model === 'string' && Object.keys(value).length === 2) {
      config.trials.localJudge = { url: value.url, model: value.model };
    } else {
      throw new Error(`config.yaml: invalid or unknown key trials.${key}`);
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
