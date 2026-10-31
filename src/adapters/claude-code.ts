import { execFile, type ChildProcess } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TaskManifest } from '../manifest/build.ts';
import { killGroup, killGroupNow, spawnGroup } from '../proc.ts';
import { buildClaudeInvocation, claudeEnv } from './claude-args.ts';
import { ClaudeStreamParser } from './claude-stream.ts';
import type { AttemptHandle, AttemptResult, WorkerAdapter, WorkerEvent, Workspace } from './types.ts';

export type ClaudeAdapterConfig = {
  binary: string;
  agentHome: string;
  mode: 'subscription' | 'api-key';
  denyRead: string[];
  graceS: number;
  timeoutS: number;
  parentEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
};

const STDERR_TAIL_CHARS = 4000;
const AUTH_STATUS_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
// A process outside the worker's group can still hold stdout after the worker exits.
const DRAIN_MS = 2000;

class EventQueue implements AsyncIterable<WorkerEvent> {
  private readonly items: WorkerEvent[] = [];
  private waiter: ((next: IteratorResult<WorkerEvent>) => void) | undefined;
  private ended = false;

  push(event: WorkerEvent): void {
    if (this.waiter) {
      this.waiter({ done: false, value: event });
      this.waiter = undefined;
    } else {
      this.items.push(event);
    }
  }

  end(): void {
    this.ended = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkerEvent> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ done: false, value: item });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly id = 'claude-code';
  readonly vendor = 'anthropic';
  readonly capabilities = { repoTools: true, structuredOutput: true, resume: false, costReport: 'estimate', sandbox: 'os' } as const;

  constructor(private readonly cfg: ClaudeAdapterConfig) {}

  get loginFix(): string {
    return `CLAUDE_CONFIG_DIR=${this.cfg.agentHome} claude auth login`;
  }

  // Never cached: a login can expire between two attempts.
  preflight(): Promise<{ ok: true } | { ok: false; reason: string; fix: string }> {
    const { binary, agentHome } = this.cfg;
    return new Promise((resolve) => {
      execFile(binary, ['auth', 'status'], { env: claudeEnv(this.cfg), timeout: AUTH_STATUS_TIMEOUT_MS }, (err, stdout) => {
        // `auth status` exits nonzero when logged out and still prints its JSON, so only a failed start is decisive.
        if (err && typeof err.code === 'string') {
          resolve({ ok: false, reason: `Could not run the Claude CLI at ${binary}: ${err.code}`, fix: 'Install Claude Code, or set claude.binary in config.yaml' });
          return;
        }
        resolve(
          parseLoggedIn(stdout)
            ? { ok: true }
            : { ok: false, reason: `Claude Code is not logged in under ${agentHome}`, fix: this.loginFix },
        );
      });
    });
  }

  start(m: TaskManifest, ws: Workspace): AttemptHandle {
    const { argv, env } = buildClaudeInvocation(m, ws, this.cfg);
    const events = new EventQueue();
    let settle!: (result: AttemptResult) => void;
    const result = new Promise<AttemptResult>((resolve) => {
      settle = resolve;
    });
    const failToStart = (reason: string): void => {
      events.end();
      settle({ status: 'failed', failureKind: 'spawn_error', message: reason, usage: { inTok: 0, outTok: 0 } });
    };
    const notStarted: AttemptHandle = { events, result, argv, cancel: () => Promise.resolve() };

    let parser: ClaudeStreamParser;
    let child: ChildProcess;
    let stdinFd: number | undefined;
    let transcriptFd: number | undefined;
    try {
      if (!existsSync(ws.path)) throw new Error(`The worktree is gone: ${ws.path}`);
      parser = new ClaudeStreamParser(m.outputSchema);
      stdinFd = openSync(join(ws.manifestDir, 'task.md'), 'r');
      mkdirSync(dirname(ws.transcriptPath), { recursive: true });
      transcriptFd = openSync(ws.transcriptPath, 'a');
      child = spawnGroup(this.cfg.binary, argv, { cwd: ws.path, env, stdio: [stdinFd, 'pipe', 'pipe'] });
    } catch (err) {
      if (transcriptFd !== undefined) closeSync(transcriptFd);
      failToStart(errorText(err));
      return notStarted;
    } finally {
      if (stdinFd !== undefined) closeSync(stdinFd);
    }

    const transcript = createWriteStream(ws.transcriptPath, { fd: transcriptFd });
    const transcriptClosed = new Promise<void>((resolve) => transcript.once('close', () => resolve()));
    // The attempt goes on without its record: the worker's work is worth more than stopping it here.
    transcript.on('error', (err) => events.push({ t: 'error', message: `Could not write the transcript: ${err.message}` }));

    const pid = child.pid;
    if (pid === undefined) {
      child.once('error', (err) => {
        transcript.end();
        failToStart(`Could not start ${this.cfg.binary}: ${err.message}`);
      });
      return notStarted;
    }

    createInterface({ input: child.stdout! }).on('line', (line) => {
      transcript.write(`${line}\n`);
      for (const event of parser.push(line)) events.push(event);
    });

    let stderrTail = '';
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    let stopReason: 'cancelled' | 'timeout' | undefined;
    let stopping: Promise<void> | undefined;
    let exited = false;

    const stop = (reason: 'cancelled' | 'timeout'): Promise<void> => {
      if (exited && !stopping) return Promise.resolve();
      if (!stopping) {
        stopReason = reason;
        stopping = killGroup(pid, this.cfg.graceS);
      }
      return stopping;
    };

    const timeout = setTimeout(() => void stop('timeout'), Math.min(this.cfg.timeoutS * 1000, MAX_TIMER_MS));
    let drain: NodeJS.Timeout | undefined;
    let exit: { code: number | null; signal: string | null } = { code: null, signal: null };

    child.once('exit', (code, signal) => {
      exited = true;
      exit = { code, signal };
      clearTimeout(timeout);
      // Whatever the worker left running goes with it, and stops holding stdout open.
      if (!stopping) killGroupNow(pid);
      drain = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
      }, DRAIN_MS);
    });

    child.once('close', () => {
      clearTimeout(drain);
      transcript.end();
      void transcriptClosed.then(() => {
        const parsed = parser.finish({ ...exit, stderrTail: stderrTail.trim() });
        events.end();
        // A real SIGINT ends with code 0 and an error_during_execution result, so only our own record says why it stopped.
        settle(
          stopReason
            ? { status: stopReason, usage: parsed.usage, ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}) }
            : parsed,
        );
      });
    });

    return {
      events,
      result,
      pid,
      argv,
      cancel: async () => {
        await stop('cancelled');
        await result;
      },
    };
  }
}

function parseLoggedIn(stdout: string): boolean {
  try {
    const status: unknown = JSON.parse(stdout);
    return typeof status === 'object' && status !== null && (status as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}
