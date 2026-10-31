#!/usr/bin/env node
// Stands in for the claude binary. Each spawn acts out one step of the script at FAKE_SCRIPT.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('2.1.109 (Claude Code)\n');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  const wrongHome = process.env.FAKE_AUTH_HOME && process.env.FAKE_AUTH_HOME !== process.env.CLAUDE_CONFIG_DIR;
  const auth = wrongHome
    ? '{"loggedIn":false}'
    : process.env.FAKE_AUTH_FILE
      ? readFileSync(process.env.FAKE_AUTH_FILE, 'utf8')
      : (process.env.FAKE_AUTH ?? '{"loggedIn":true,"authMethod":"claude.ai"}');
  process.stdout.write(`${auth}\n`);
  process.exit(JSON.parse(auth).loggedIn ? 0 : 1);
}

const spawnLog = process.env.FAKE_SPAWN_LOG;
const spawnCount = spawnLog && existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
if (spawnLog) appendFileSync(spawnLog, `${JSON.stringify({ argv: args, cwd: process.cwd(), pid: process.pid })}\n`);

const steps = process.env.FAKE_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_SCRIPT, 'utf8')) : [{}];
const step = steps[Math.min(spawnCount, steps.length - 1)];

const INTERRUPTED = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  errors: ['[ede_diagnostic] interrupted'],
  usage: { input_tokens: 5, output_tokens: 6 },
  total_cost_usd: 0.02,
});

process.on('SIGINT', () => {
  if (process.env.FAKE_SIGNAL_LOG) appendFileSync(process.env.FAKE_SIGNAL_LOG, 'SIGINT\n');
  if (step.ignoreSigint) return;
  process.stdout.write(`${INTERRUPTED}\n`);
  process.exit(0);
});

if (step.dumpEnvTo) writeFileSync(step.dumpEnvTo, JSON.stringify(process.env));
if (step.dumpStdinTo) writeFileSync(step.dumpStdinTo, readFileSync(0));

for (const [path, content] of Object.entries(step.writeFiles ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The child ignores SIGINT, as a stubborn dev server would, and shares this process's stdout, so it holds the pipe open.
if (step.spawnChild) {
  const child = spawn('sh', ['-c', 'trap "" INT; exec sleep 600'], { stdio: 'inherit' });
  writeFileSync(step.spawnChild, String(child.pid));
}

// This one starts its own session, as a daemonized server would, so no signal to the worker's group reaches it.
if (step.spawnEscapee) {
  const child = spawn('sleep', ['600'], { stdio: 'inherit', detached: true });
  child.unref();
  writeFileSync(step.spawnEscapee, String(child.pid));
}

const lines = step.fixture
  ? readFileSync(join(import.meta.dirname, 'claude', step.fixture), 'utf8').split('\n').filter(Boolean)
  : (step.lines ?? []);
for (const line of lines) process.stdout.write(`${line}\n`);

if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));

// Exiting with output still queued would drop whatever didn't fit in the pipe's buffer.
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(step.exitCode ?? 0);
