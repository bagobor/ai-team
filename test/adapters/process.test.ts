import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeAdapter, type ClaudeAdapterConfig } from '../../src/adapters/claude-code.ts';
import type { AttemptHandle, WorkerEvent, Workspace } from '../../src/adapters/types.ts';
import type { TaskManifest } from '../../src/manifest/build.ts';
import { killGroup, processStartTime, spawnGroup } from '../../src/proc.ts';
import { tempDir } from '../helpers/repo.ts';

const fakeClaude = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
chmodSync(fakeClaude, 0o755);

const manifest = {
  model: 'm',
  budgets: { max_turns: 60, max_usd: 3, context_tokens: 12000, playbook_tokens: 2000, memory_tokens: 1000 },
  tools: ['read_repo', 'edit_repo', 'run_commands'],
  outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
} as TaskManifest;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function collect(handle: AttemptHandle): Promise<WorkerEvent[]> {
  const events: WorkerEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

describe('ClaudeCodeAdapter process', () => {
  let root: string;
  let ws: Workspace;
  let script: string;
  let signals: string;
  let spawnLog: string;

  beforeEach(() => {
    root = tempDir();
    ws = { path: join(root, 'wt'), transcriptPath: join(root, 'transcripts', 'p', '1.jsonl'), manifestDir: join(root, 'manifest') };
    mkdirSync(ws.path);
    mkdirSync(ws.manifestDir);
    writeFileSync(join(ws.manifestDir, 'task.md'), 'the task\n');
    writeFileSync(join(ws.manifestDir, 'system.md'), 'the system\n');
    script = join(root, 'script.json');
    signals = join(root, 'signals.log');
    spawnLog = join(root, 'spawns.log');
  });

  function adapter(steps: object[], overrides: Partial<ClaudeAdapterConfig> = {}) {
    writeFileSync(script, JSON.stringify(steps));
    return new ClaudeCodeAdapter({
      binary: fakeClaude,
      agentHome: join(root, 'agent-home'),
      mode: 'subscription',
      denyRead: [],
      graceS: 2,
      timeoutS: 30,
      parentEnv: process.env,
      extraEnv: { FAKE_SCRIPT: script, FAKE_SIGNAL_LOG: signals, FAKE_SPAWN_LOG: spawnLog },
      ...overrides,
    });
  }

  const started = (pidFile: string) => until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '');

  it('has the M1 identity and capabilities', () => {
    const a = adapter([{}]);
    expect(a.id).toBe('claude-code');
    expect(a.vendor).toBe('anthropic');
    expect(a.capabilities).toEqual({ repoTools: true, structuredOutput: true, resume: false, costReport: 'estimate', sandbox: 'os' });
  });

  it('runs in the worktree, feeds task.md on stdin, keeps a raw transcript', async () => {
    const stdinDump = join(root, 'stdin.txt');
    const handle = adapter([{ fixture: 'success.jsonl', dumpStdinTo: stdinDump }]).start(manifest, ws);

    const [events, result] = await Promise.all([collect(handle), handle.result]);

    expect(JSON.parse(readFileSync(spawnLog, 'utf8').trim()).cwd).toBe(realpathSync(ws.path));
    expect(readFileSync(stdinDump, 'utf8')).toBe('the task\n');
    const fixture = readFileSync(new URL('../fixtures/claude/success.jsonl', import.meta.url), 'utf8');
    expect(readFileSync(ws.transcriptPath, 'utf8')).toBe(fixture);
    expect(events[0]).toMatchObject({ t: 'init' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ ok: true });
  });

  it('reports the pid and argv', async () => {
    const handle = adapter([{}]).start(manifest, ws);
    expect(handle.pid).toEqual(expect.any(Number));
    expect(handle.argv).toContain('--strict-mcp-config');
    await handle.result;
  });

  it('passes only the allow-listed env', async () => {
    const dump = join(root, 'env.json');
    const a = adapter([{ dumpEnvTo: dump }], { parentEnv: { ...process.env, ANTHROPIC_API_KEY: 'secret', CLAUDECODE: '1' } });

    await a.start(manifest, ws).result;

    const env = JSON.parse(readFileSync(dump, 'utf8'));
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, 'agent-home'));
  });

  it('cancel sends SIGINT and reports cancelled', async () => {
    const pidFile = join(root, 'ready');
    const handle = adapter([{ writeFiles: { [pidFile]: 'up' }, delayMs: 60000 }]).start(manifest, ws);
    await started(pidFile);

    await handle.cancel();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(readFileSync(signals, 'utf8')).toContain('SIGINT');
    expect(result.usage.inTok).toBe(5);
  });

  it('ends the events when cancelled', async () => {
    const pidFile = join(root, 'ready');
    const handle = adapter([{ writeFiles: { [pidFile]: 'up' }, delayMs: 60000 }]).start(manifest, ws);
    const events = collect(handle);
    await started(pidFile);

    await handle.cancel();

    await expect(events).resolves.toEqual(expect.any(Array));
  });

  it('escalates to SIGKILL after grace', async () => {
    const pidFile = join(root, 'ready');
    const handle = adapter([{ writeFiles: { [pidFile]: 'up' }, delayMs: 60000, ignoreSigint: true }], { graceS: 1 }).start(manifest, ws);
    await started(pidFile);
    const before = Date.now();

    await handle.cancel();

    expect(Date.now() - before).toBeLessThan(3000);
    expect((await handle.result).status).toBe('cancelled');
    expect(alive(handle.pid!)).toBe(false);
  });

  it('kills grandchildren', async () => {
    const childPid = join(root, 'child.pid');
    const handle = adapter([{ spawnChild: childPid, delayMs: 60000 }]).start(manifest, ws);
    await started(childPid);
    const child = Number(readFileSync(childPid, 'utf8'));
    expect(alive(child)).toBe(true);

    await handle.cancel();

    await until(() => !alive(child));
  });

  it('does not hang on a background process left holding stdout', async () => {
    const childPid = join(root, 'child.pid');
    const handle = adapter([{ spawnChild: childPid, fixture: 'garbled.synthetic.jsonl' }]).start(manifest, ws);

    const result = await handle.result;

    expect(result.status).toBe('succeeded');
    await until(() => !alive(Number(readFileSync(childPid, 'utf8'))));
  });

  it('does not hang on a process that left the group and still holds stdout', async () => {
    const escapedPid = join(root, 'escaped.pid');
    const handle = adapter([{ spawnEscapee: escapedPid, fixture: 'garbled.synthetic.jsonl' }]).start(manifest, ws);

    try {
      expect((await handle.result).status).toBe('succeeded');
    } finally {
      process.kill(Number(readFileSync(escapedPid, 'utf8')), 'SIGKILL');
    }
  });

  it('lets a worker that already exited keep its own result when cancel arrives while stdout drains', async () => {
    const escapedPid = join(root, 'escaped.pid');
    const handle = adapter([{ spawnEscapee: escapedPid, fixture: 'garbled.synthetic.jsonl' }]).start(manifest, ws);
    const leader = handle.pid!;
    await until(() => !alive(leader));

    await handle.cancel();

    try {
      expect((await handle.result).status).toBe('succeeded');
      expect(existsSync(signals)).toBe(false);
    } finally {
      process.kill(Number(readFileSync(escapedPid, 'utf8')), 'SIGKILL');
    }
  });

  it('reports timeout', async () => {
    const handle = adapter([{ delayMs: 60000 }], { timeoutS: 1 }).start(manifest, ws);
    expect((await handle.result).status).toBe('timeout');
    expect(readFileSync(signals, 'utf8')).toContain('SIGINT');
  });

  it('keeps the first reason when cancel follows a timeout', async () => {
    const handle = adapter([{ delayMs: 60000, ignoreSigint: true }], { timeoutS: 1, graceS: 1 }).start(manifest, ws);
    await until(() => existsSync(signals));

    await handle.cancel();

    expect((await handle.result).status).toBe('timeout');
  });

  it('leaves a finished attempt as it was when cancelled afterwards', async () => {
    const handle = adapter([{ fixture: 'garbled.synthetic.jsonl' }]).start(manifest, ws);
    const result = await handle.result;

    await handle.cancel();

    expect(await handle.result).toBe(result);
    expect(result.status).toBe('succeeded');
    expect(existsSync(signals)).toBe(false);
  });

  it('maps a failed exit from what the stream said, with the stderr tail if it said nothing', async () => {
    const handle = adapter([{ exitCode: 3 }]).start(manifest, ws);
    expect(await handle.result).toMatchObject({ status: 'failed', failureKind: 'no_result' });
  });

  it('handles a missing binary', async () => {
    const handle = adapter([{}], { binary: join(root, 'no-such-claude') }).start(manifest, ws);

    const [events, result] = await Promise.all([collect(handle), handle.result]);

    expect(events).toEqual([]);
    expect(result).toMatchObject({ status: 'failed', failureKind: 'spawn_error' });
    expect(handle.pid).toBeUndefined();
  });

  it('handles a missing task file', async () => {
    const handle = adapter([{}]).start(manifest, { ...ws, manifestDir: join(root, 'absent') });

    const [events, result] = await Promise.all([collect(handle), handle.result]);

    expect(events).toEqual([]);
    expect(result).toMatchObject({ status: 'failed', failureKind: 'spawn_error' });
  });

  it('handles a worktree that is gone', async () => {
    const handle = adapter([{}]).start(manifest, { ...ws, path: join(root, 'absent') });
    expect(await handle.result).toMatchObject({ status: 'failed', failureKind: 'spawn_error' });
  });

  it('does not start a worker whose transcript cannot be opened', async () => {
    writeFileSync(join(root, 'transcripts'), 'a file where the folder should be');
    const handle = adapter([{ fixture: 'garbled.synthetic.jsonl' }]).start(manifest, ws);

    expect(await handle.result).toMatchObject({ status: 'failed', failureKind: 'spawn_error' });
    expect(existsSync(spawnLog)).toBe(false);
  });

  describe('preflight', () => {
    it('passes when logged in', async () => {
      expect(await adapter([{}]).preflight()).toEqual({ ok: true });
    });

    it('preflight reports logged out with the login command', async () => {
      const home = join(root, 'agent-home');
      const a = adapter([{}], { extraEnv: { FAKE_AUTH: '{"loggedIn":false}' } });
      expect(await a.preflight()).toMatchObject({ ok: false, fix: `CLAUDE_CONFIG_DIR=${home} claude auth login` });
    });

    it('checks the login under the agent home, not the parent environment', async () => {
      const a = adapter([{}], {
        parentEnv: { ...process.env, CLAUDE_CONFIG_DIR: '/elsewhere' },
        extraEnv: { FAKE_AUTH_HOME: join(root, 'agent-home') },
      });
      expect(await a.preflight()).toEqual({ ok: true });
    });

    it('preflight reports a missing binary', async () => {
      const binary = join(root, 'no-such-claude');
      const result = await adapter([{}], { binary }).preflight();
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(binary) });
    });

    it('treats unreadable auth output as logged out', async () => {
      const a = adapter([{}], { extraEnv: { FAKE_AUTH: '"odd"' } });
      expect(await a.preflight()).toMatchObject({ ok: false });
    });

    it('re-checks on every call', async () => {
      const authFile = join(root, 'auth.json');
      writeFileSync(authFile, '{"loggedIn":true}');
      const a = adapter([{}], { extraEnv: { FAKE_AUTH_FILE: authFile } });
      expect(await a.preflight()).toEqual({ ok: true });

      writeFileSync(authFile, '{"loggedIn":false}');

      expect(await a.preflight()).toMatchObject({ ok: false });
    });
  });
});

describe('proc', () => {
  it('processStartTime reads a live process and is null for a dead one', async () => {
    expect(await processStartTime(process.pid)).toEqual(expect.any(String));
    expect(await processStartTime(2 ** 22 - 1)).toBeNull();
  });

  it('killGroup finishes at once for a group that is gone', async () => {
    const child = spawnGroup('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise((resolve) => child.on('close', resolve));

    const before = Date.now();
    await killGroup(pid, 5);

    expect(Date.now() - before).toBeLessThan(1000);
  });
});
