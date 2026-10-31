import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 50;

// The child leads its own process group, so signalling -pid reaches everything it started.
export function spawnGroup(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, { ...options, detached: true });
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH when the group is gone. macOS says EPERM for a group holding only zombies.
    return false;
  }
}

export function killGroupNow(pid: number): void {
  signalGroup(pid, 'SIGKILL');
}

// SIGINT, not SIGTERM: it is what lets the CLI stop cleanly and report its usage.
export async function killGroup(pid: number, graceS: number): Promise<void> {
  if (!signalGroup(pid, 'SIGINT')) return;

  const deadline = Date.now() + graceS * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!signalGroup(pid, 0)) return;
  }
  signalGroup(pid, 'SIGKILL');
}

export function processStartTime(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (err, stdout) => {
      const started = stdout.trim();
      resolve(err || !started ? null : started);
    });
  });
}
