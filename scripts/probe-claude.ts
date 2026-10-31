// Proves worker isolation on the subscription login and records real CLI streams as fixtures.
// It makes real model calls, so run it outside any sandbox that blocks the network.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolvePaths } from '../src/paths.ts';
import { isolationViolations, type ClaudeInit } from '../src/setup/isolation.ts';
import { runSetup } from '../src/setup/setup.ts';

const exec = promisify(execFile);

const TOOLS = 'Read,Glob,Grep,Edit,Write,Bash';
// The sandbox only covers Bash, so Edit and Write are scoped to the working directory by rule.
const ALLOWED_RULES = 'Read,Glob,Grep,Bash,Edit(./**),Write(./**)';
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};
const SANDBOX = {
  sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] } },
};
const ALLOWED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];

type RunOptions = {
  name: string;
  prompt: string;
  configDir: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  sigintAfterFirstAssistant?: boolean;
};
type Run = { name: string; lines: string[]; code: number | null; signal: string | null; stderr: string; msToExit?: number };
type Json = Record<string, unknown>;

const paths = resolvePaths();
const repo = join(paths.root, 'probe-repo');
const outside = join(paths.root, 'probe-outside');
const fixtures = join(import.meta.dirname, '../test/fixtures/claude');
const scratch = mkdtempSync(join(tmpdir(), 'aiteam-probe-'));

function workerEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

async function authStatus(configDir: string): Promise<{ loggedIn: boolean; authMethod?: string }> {
  try {
    const { stdout } = await exec('claude', ['auth', 'status'], { env: workerEnv(configDir) });
    const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod };
  } catch (err) {
    // `claude auth status` exits non-zero when logged out, with the same JSON on stdout.
    const stdout = (err as { stdout?: string }).stdout ?? '';
    try {
      const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
      return { loggedIn: parsed.loggedIn === true, authMethod: parsed.authMethod };
    } catch {
      return { loggedIn: false };
    }
  }
}

function runClaude(o: RunOptions): Promise<Run> {
  const argv = [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--append-system-prompt-file', join(scratch, 'system.md'),
    '--json-schema', JSON.stringify(SCHEMA),
    '--tools', TOOLS, '--allowedTools', ALLOWED_RULES,
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--max-turns', String(o.maxTurns ?? 16),
    '--max-budget-usd', String(o.maxBudgetUsd ?? 0.25),
    '--settings', JSON.stringify(SANDBOX),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', argv, {
      cwd: repo,
      env: workerEnv(o.configDir),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let buffer = '';
    let stderr = '';
    let sigintAt: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    child.on('error', reject);
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        if (o.sigintAfterFirstAssistant && sigintAt === undefined && line.includes('"type":"assistant"')) {
          sigintAt = Date.now();
          process.kill(-child.pid!, 'SIGINT');
          killTimer = setTimeout(() => process.kill(-child.pid!, 'SIGKILL'), 30_000);
        }
      }
    });
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (buffer) lines.push(buffer);
      resolve({ name: o.name, lines, code, signal, stderr, msToExit: sigintAt && Date.now() - sigintAt });
    });
    child.stdin.end(o.prompt);
  });
}

function parse(run: Run): Json[] {
  return run.lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Json];
    } catch {
      return [];
    }
  });
}

function resultOf(run: Run): Json | undefined {
  return parse(run).find((e) => e.type === 'result');
}

function initOf(run: Run): Json | undefined {
  return parse(run).find((e) => e.type === 'system' && e.subtype === 'init');
}

function sanitize(text: string): string {
  return text
    .replaceAll(repo, '/WORK')
    .replaceAll(outside, '/OUTSIDE')
    .replaceAll(scratch, '/SCRATCH')
    .replaceAll(paths.claudeHome, '/AGENT_HOME')
    .replaceAll(paths.root, '/AITEAM_HOME')
    .replaceAll(homedir(), '/HOME');
}

function saveFixture(run: Run): void {
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, `${run.name}.jsonl`), `${sanitize(run.lines.join('\n'))}\n`);
}

function userConfigNames(): string[] {
  const names: string[] = [];
  for (const dir of ['skills', 'agents', 'commands']) {
    const full = join(homedir(), '.claude', dir);
    if (existsSync(full)) names.push(...readdirSync(full).map((n) => n.replace(/\.md$/, '')));
  }
  return names;
}

function describeRun(run: Run): void {
  const result = resultOf(run);
  console.log(
    `  ${run.name}: exit=${run.code} signal=${run.signal} lines=${run.lines.length}` +
      ` subtype=${String(result?.subtype)} is_error=${String(result?.is_error)}` +
      ` turns=${String(result?.num_turns)} cost=${String(result?.total_cost_usd)}` +
      (run.msToExit === undefined ? '' : ` msToExit=${run.msToExit}`),
  );
}

async function main(): Promise<number> {
  await runSetup(paths);

  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };

  const status = await authStatus(paths.claudeHome);
  check('agent_home_logged_in', status.loggedIn, `authMethod=${status.authMethod ?? 'none'}`);
  if (!status.loggedIn) {
    console.log(`Log in first: CLAUDE_CONFIG_DIR=${paths.claudeHome} claude auth login`);
    console.log('ISOLATION FAIL: agent_home_logged_in');
    return 1;
  }

  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Probe repo\n');
  writeFileSync(join(outside, 'edit-target.txt'), 'before\n');
  writeFileSync(join(scratch, 'system.md'), 'You are a test worker. Follow the steps exactly and report honestly.\n');
  const git = (...args: string[]) => exec('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');

  const success = await runClaude({
    name: 'success',
    configDir: paths.claudeHome,
    prompt: [
      'Do each step once, in order. A step may be refused; if so, carry on with the next one and do not retry it another way.',
      '1. Read README.md.',
      `2. With the Bash tool, run: echo canary > ${outside}/outside-bash.txt`,
      `3. With the Write tool, create ${outside}/outside-write.txt containing "canary".`,
      '4. With the Bash tool, run: echo inside > inside-bash.txt',
      '5. With the Write tool, create inside-write.txt in the current directory containing "inside".',
      `6. With the Edit tool, change "before" to "after" in ${outside}/edit-target.txt.`,
      '7. With the Edit tool, change "Probe repo" to "Edited repo" in README.md.',
      `8. With the Bash tool, run exactly: curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com > inside-net.txt 2>&1`,
      'Then finish with {"ok": true}.',
    ].join('\n'),
  });
  const maxTurns = await runClaude({
    name: 'max-turns',
    configDir: paths.claudeHome,
    maxTurns: 1,
    prompt: 'Read README.md, then run `ls` with Bash, then finish with {"ok": true}.',
  });
  const maxBudget = await runClaude({
    name: 'max-budget',
    configDir: paths.claudeHome,
    maxBudgetUsd: 0.0001,
    prompt: 'Read README.md, then finish with {"ok": true}.',
  });
  const authFailed = await runClaude({
    name: 'auth-failed',
    configDir: mkdtempSync(join(scratch, 'empty-home-')),
    prompt: 'Finish with {"ok": true}.',
  });
  const sigint = await runClaude({
    name: 'sigint',
    configDir: paths.claudeHome,
    sigintAfterFirstAssistant: true,
    prompt: 'Read README.md, then run `sleep 60` with Bash, then finish with {"ok": true}.',
  });

  const runs = [success, maxTurns, maxBudget, authFailed, sigint];
  for (const run of runs) saveFixture(run);
  console.log('Runs:');
  for (const run of runs) describeRun(run);

  const init = initOf(success) as ClaudeInit | undefined;
  const hookEventsSeen = parse(success).some(
    (e) => e.type === 'system' && typeof e.subtype === 'string' && e.subtype.startsWith('hook_'),
  );
  const violations = init
    ? isolationViolations(init, {
        agentHome: paths.claudeHome,
        allowedTools: [...TOOLS.split(','), 'StructuredOutput'],
        userSkillNames: userConfigNames(),
        hookEventsSeen,
      })
    : ['no_init'];
  check('no_user_config_in_worker', violations.length === 0, violations.join(','));

  const result = resultOf(success);
  check('result_success', result?.subtype === 'success' && result?.is_error === false, `subtype=${String(result?.subtype)}`);
  check('structured_output_present', result?.structured_output !== undefined, JSON.stringify(result?.structured_output));
  check('bash_blocked_outside', !existsSync(join(outside, 'outside-bash.txt')));
  check('write_blocked_outside', !existsSync(join(outside, 'outside-write.txt')));
  check('edit_blocked_outside', readFileSync(join(outside, 'edit-target.txt'), 'utf8') === 'before\n');
  check('bash_works_inside', existsSync(join(repo, 'inside-bash.txt')));
  check('write_works_inside', existsSync(join(repo, 'inside-write.txt')));
  check('edit_works_inside', readFileSync(join(repo, 'README.md'), 'utf8').includes('Edited repo'));
  const net = join(repo, 'inside-net.txt');
  const netOutput = existsSync(net) ? readFileSync(net, 'utf8').trim() : 'not run';
  check('network_blocked_for_bash', existsSync(net) && !/\b[23]\d\d\b/.test(netOutput), netOutput);

  const spend = runs.reduce((sum, run) => sum + Number(resultOf(run)?.total_cost_usd ?? 0), 0);
  console.log(`Estimated spend: $${spend.toFixed(4)}`);
  // A failed run keeps these so the leak can be inspected.
  if (failures.length === 0) {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  console.log(failures.length === 0 ? 'ISOLATION PASS' : `ISOLATION FAIL: ${failures.join(', ')}`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    rmSync(scratch, { recursive: true, force: true });
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    console.log('ISOLATION FAIL: probe_error');
    process.exitCode = 1;
  },
);
