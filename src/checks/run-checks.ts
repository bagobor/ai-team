import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import picomatch from 'picomatch';
import { workerEnv } from '../adapters/env.ts';
import type { EventType } from '../events.ts';
import { changedPaths } from '../git/workspace.ts';
import { killGroup, killGroupNow, spawnGroup } from '../proc.ts';

export type CheckRun = { command: string; exitCode: number | null; timedOut: boolean; durationMs: number; outputTail: string };

export type ChecksResult =
  | { ok: true; runs: CheckRun[] }
  | { ok: false; kind: 'no_changes' | 'scope_violation' | 'check_failed'; runs: CheckRun[]; evidence: string; violations?: string[] };

export type ChecksInput = {
  repoPath: string;
  worktree: string;
  baseSha: string;
  writeScope: { allow: string[]; deny: string[] };
  commands: string[];
  denyRead: string[];
  timeoutS: number;
  onEvent: (type: EventType, payload: unknown) => void;
  onSpawn?: (pid: number) => void;
  signal?: AbortSignal;
};

const TAIL_CHARS = 8000;
const KILL_GRACE_S = 2;
const MAX_TIMER_MS = 2 ** 31 - 1;
// A process outside the command's group can still hold its output open after it exits.
const DRAIN_MS = 2000;
// Engine state and the files that tell an agent what to do or let it run hooks. This filesystem folds case, so the match does too.
const ALWAYS_OFF_LIMITS = /(?:^|\/)(?:(?:\.aiteam|\.claude|\.codex)(?:\/|$)|(?:CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|\.mcp\.json)$)/i;

function scopeViolations(paths: string[], scope: ChecksInput['writeScope']): string[] {
  const allowed = picomatch(scope.allow, { dot: true });
  const denied = picomatch(scope.deny, { dot: true, nocase: true });
  return paths.filter((path) => ALWAYS_OFF_LIMITS.test(path) || denied(path) || !allowed(path));
}

// The sandbox matches real paths, so a symlink such as macOS's /tmp has to be resolved first.
function realOrAsWritten(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Checks run code the worker wrote, so they get the limits its own Bash has. Later rules win, so the worktree comes back last.
function sandboxArgs(i: ChecksInput, command: string): string[] {
  const denyRules = i.denyRead.map((_, k) => `(deny file-read* (subpath (param "DENY${k}")))`);
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(allow file-write* (subpath (param "TMP")) (subpath "/private/tmp") (subpath "/dev"))',
    // The repo stays out of reach even if it sits in a temp folder.
    '(deny file-write* (subpath (param "REPO")))',
    '(allow file-write* (subpath (param "WORKTREE")))',
    ...denyRules,
    '(allow file-read* (subpath (param "WORKTREE")))',
  ].join('\n');
  const params = [
    ['WORKTREE', realOrAsWritten(i.worktree)],
    ['REPO', realOrAsWritten(i.repoPath)],
    ['TMP', realOrAsWritten(tmpdir())],
    ...i.denyRead.map((path, k) => [`DENY${k}`, realOrAsWritten(path)]),
  ];
  return [...params.flatMap(([name, value]) => ['-D', `${name}=${value}`]), '-p', profile, 'sh', '-c', command];
}

function runCommand(i: ChecksInput, command: string): Promise<CheckRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    let outputTail = '';
    const append = (chunk: string) => {
      outputTail = (outputTail + chunk).slice(-TAIL_CHARS);
    };
    const finish = (exitCode: number | null, timedOut: boolean) =>
      resolve({ command, exitCode, timedOut, durationMs: Date.now() - started, outputTail });

    let child: ReturnType<typeof spawnGroup>;
    try {
      child = spawnGroup('sandbox-exec', sandboxArgs(i, command), { cwd: i.worktree, env: workerEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      append(`Could not start the check: ${err instanceof Error ? err.message : String(err)}\n`);
      finish(null, false);
      return;
    }

    const pid = child.pid;
    // A failed spawn (sandbox-exec missing, worktree gone) fails the check rather than skipping it.
    child.on('error', (err) => {
      if (pid === undefined) {
        append(`Could not start the check: ${err.message}\n`);
        finish(null, false);
      }
    });
    if (pid === undefined) return;

    child.stdout!.setEncoding('utf8').on('data', append);
    child.stderr!.setEncoding('utf8').on('data', append);

    let timedOut = false;
    let stopping: Promise<void> | undefined;
    const stop = (): void => {
      stopping ??= killGroup(pid, KILL_GRACE_S);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.min(i.timeoutS * 1000, MAX_TIMER_MS));
    i.signal?.addEventListener('abort', stop, { once: true });
    i.onSpawn?.(pid);

    let drain: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    child.once('exit', (code) => {
      exitCode = code;
      clearTimeout(timer);
      // Whatever the command left running goes with it, and stops holding its output open.
      if (!stopping) killGroupNow(pid);
      drain = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
      }, DRAIN_MS);
    });
    child.once('close', () => {
      clearTimeout(drain);
      i.signal?.removeEventListener('abort', stop);
      finish(exitCode, timedOut);
    });
  });
}

function failureEvidence(run: CheckRun, timeoutS: number, aborted: boolean): string {
  const how = run.timedOut ? `timed out after ${timeoutS}s` : aborted ? 'was stopped' : `exited with ${String(run.exitCode)}`;
  return `Check \`${run.command}\` ${how}.\n${run.outputTail}`;
}

export async function runChecks(i: ChecksInput): Promise<ChecksResult> {
  const paths = await changedPaths(i.repoPath, i.worktree, i.baseSha);
  if (paths.length === 0) {
    return { ok: false, kind: 'no_changes', runs: [], evidence: `The attempt changed nothing since ${i.baseSha}.` };
  }

  const violations = scopeViolations(paths, i.writeScope);
  if (violations.length > 0) {
    return { ok: false, kind: 'scope_violation', runs: [], violations, evidence: `These paths are outside the write scope:\n${violations.join('\n')}` };
  }

  const runs: CheckRun[] = [];
  for (const command of i.commands) {
    if (i.signal?.aborted) return { ok: false, kind: 'check_failed', runs, evidence: 'The checks were stopped before they finished.' };

    i.onEvent('check.started', { command });
    const run = await runCommand(i, command);
    runs.push(run);
    i.onEvent('check.finished', run);

    if (run.exitCode !== 0) {
      return { ok: false, kind: 'check_failed', runs, evidence: failureEvidence(run, i.timeoutS, i.signal?.aborted === true) };
    }
  }
  return { ok: true, runs };
}
