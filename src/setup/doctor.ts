import { execFile } from 'node:child_process';
import { findClaudeBinary } from '../adapters/claude-binary.ts';
import { claudeAdapterFor } from '../adapters/claude-code.ts';
import type { Config } from '../config.ts';
import type { Paths } from '../paths.ts';

export type DoctorCheck = { name: string; ok: boolean; detail: string };

const MIN_NODE_MAJOR = 22;
const VERSION_TIMEOUT_MS = 30_000;

function versionOf(binary: string): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? { ok: false, reason: err.message } : { ok: true, version: stdout.trim() });
    });
  });
}

function checkNode(): DoctorCheck {
  const version = process.versions.node;
  const ok = Number(version.split('.')[0]) >= MIN_NODE_MAJOR;
  return { name: 'node', ok, detail: ok ? version : `${version} is too old: the engine needs Node ${MIN_NODE_MAJOR} or newer` };
}

async function checkGit(): Promise<DoctorCheck> {
  const found = await versionOf('git');
  return found.ok ? { name: 'git', ok: true, detail: found.version } : { name: 'git', ok: false, detail: `Could not run git: ${found.reason}` };
}

async function checkClaudeBinary(config: Config): Promise<DoctorCheck> {
  const { binary, replaces } = findClaudeBinary(config.claude.binary);
  const found = await versionOf(binary);
  if (!found.ok) return { name: 'claude binary', ok: false, detail: `Could not run ${binary}, the path set as claude.binary in config.yaml: ${found.reason}` };
  const instead = replaces === undefined ? '' : `, found in place of ${replaces}, the path set as claude.binary in config.yaml, which is gone`;
  return { name: 'claude binary', ok: true, detail: `${binary}: ${found.version}${instead}` };
}

async function checkLogin(paths: Paths, config: Config): Promise<DoctorCheck> {
  const result = await claudeAdapterFor(paths, config).preflight();
  return result.ok
    ? { name: 'agent-home login', ok: true, detail: `Logged in under ${paths.claudeHome}` }
    : { name: 'agent-home login', ok: false, detail: `${result.reason}. Run: ${result.fix}` };
}

export async function runDoctor(paths: Paths, config: Config): Promise<DoctorCheck[]> {
  return [checkNode(), await checkGit(), await checkClaudeBinary(config), await checkLogin(paths, config)];
}
