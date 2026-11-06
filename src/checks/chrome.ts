import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.ts';
import { groupAlive, killGroupNow, spawnGroup } from '../proc.ts';

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function chromePath(config: Config): string | undefined {
  const path = config.chrome.binary ?? DEFAULT_CHROME;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

const START_TIMEOUT_MS = 10_000;
const EXIT_WAIT_MS = 5_000;
const POLL_MS = 50;
const STDERR_TAIL = 2_000;

// Chrome's own sandbox stays on. Every request goes to a proxy that isn't there, except those to the played page's
// own origin: <-loopback> drops Chrome's built-in bypass for loopback, which would let the page reach any port on
// this machine.
function chromeArgs(profile: string, port: number): string[] {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    // Otherwise Chrome reads its Safe Storage key from the stakeholder's login keychain.
    '--use-mock-keychain',
    '--autoplay-policy=no-user-gesture-required',
    '--proxy-server=http://127.0.0.1:9',
    `--proxy-bypass-list=<-loopback>;127.0.0.1:${port}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
}

// Chrome gets none of the engine's variables. CHROME_HEADLESS marks the run unattended, which turns crash uploads off.
// Crashpad keeps its database under the default profile whatever --user-data-dir says, and macOS takes that home from
// CFFIXED_USER_HOME, so pointing it into the run's profile keeps the stakeholder's own Chrome data out of reach.
function chromeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'TMPDIR', 'LANG']) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, HOME: home, CFFIXED_USER_HOME: home, CHROME_HEADLESS: '1' };
}

// A detached group outlives the engine unless something kills it, and an exit handler may only do synchronous work.
// One handler serves every run. Each live group maps to its run's profile.
const live = new Map<number, string>();
let hooked = false;
const EXIT_KILL_MS = 200;
const EXIT_PAUSE_MS = 5;
const pause = new Int32Array(new SharedArrayBuffer(4));

// A group signal races a fork inside the group, and a helper forked meanwhile escapes it, so the kill repeats until
// the group is empty. An exit handler can't await, so it blocks between kills, for a moment at most.
function killAllNow(): void {
  const deadline = Date.now() + EXIT_KILL_MS;
  for (;;) {
    for (const group of live.keys()) killGroupNow(group);
    if (![...live.keys()].some(groupAlive) || Date.now() > deadline) break;
    Atomics.wait(pause, 0, 0, EXIT_PAUSE_MS);
  }
  // No close() will run once the engine is exiting, so the profiles go here. Nobody is left to hear of a failure.
  for (const profile of live.values()) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

// The groups the exit hook would kill if the engine exited now.
export function liveGroups(): number[] {
  return [...live.keys()];
}

function track(pid: number, profile: string): void {
  live.set(pid, profile);
  if (hooked) return;
  hooked = true;
  process.once('exit', killAllNow);
}

export type Chrome = {
  readonly profile: string;
  // The last of what Chrome wrote to stderr, for a run that failed to start.
  stderr(): string;
  // The browser's DevTools WebSocket URL, once Chrome has written it into the profile.
  devTools(signal: AbortSignal): Promise<string>;
  kill(): void;
  // Kills the group, waits for it, then removes the profile. Returns what went wrong, for the run's log.
  close(): Promise<string[]>;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function devToolsUrl(profile: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
    const [port, path] = text.split('\n').map((line) => line.trim());
    return port && /^\d+$/.test(port) && path ? `ws://127.0.0.1:${port}${path}` : undefined;
  } catch {
    return undefined;
  }
}

// `port` is the played page's, the one origin Chrome may reach. `onExit` hears of a Chrome that dies or never starts,
// so the run waiting on it can stop at once.
export async function startChrome(
  binary: string,
  port: number,
  signal: AbortSignal,
  onExit: (why: Error) => void,
): Promise<Chrome> {
  const profile = await mkdtemp(join(tmpdir(), 'aiteam-chrome-'));
  let child: ChildProcess;
  try {
    const home = join(profile, 'home');
    await mkdir(home);
    // A run that timed out while the profile was being made must not start a browser nobody will stop.
    signal.throwIfAborted();
    const options: SpawnOptions = { stdio: ['ignore', 'ignore', 'pipe'], env: chromeEnv(home) };
    child = spawnGroup(binary, chromeArgs(profile, port), options);
  } catch (err) {
    await rm(profile, { recursive: true, force: true });
    throw err;
  }
  const pid = child.pid;
  if (pid !== undefined) track(pid, profile);
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_TAIL)));
  child.once('error', (err) => onExit(new Error(`could not start: ${err.message}`)));
  child.once('exit', (code, sig) => onExit(new Error(`exited with ${code === null ? sig : `code ${code}`}`)));
  const kill = () => {
    if (pid !== undefined) killGroupNow(pid);
  };

  return {
    profile,
    stderr: () => stderr,
    async devTools(signal) {
      const deadline = Date.now() + START_TIMEOUT_MS;
      for (;;) {
        const url = await devToolsUrl(profile);
        if (url) return url;
        if (Date.now() > deadline) throw new Error(`did not open DevTools within ${START_TIMEOUT_MS / 1000} s`);
        await sleep(POLL_MS, undefined, { signal });
      }
    },
    kill,
    // Chrome forks helpers into its process group, so the whole group goes, and the profile only once nothing writes
    // to it.
    async close() {
      const problems: string[] = [];
      kill();
      if (pid !== undefined) {
        const running = child.exitCode === null && child.signalCode === null;
        if (running) await Promise.race([once(child, 'exit'), sleep(EXIT_WAIT_MS)]);
        const deadline = Date.now() + EXIT_WAIT_MS;
        while (groupAlive(pid) && Date.now() < deadline) {
          await sleep(POLL_MS);
          // For a helper Chrome forked while the last kill went out.
          kill();
        }
        if (groupAlive(pid)) problems.push(`Chrome's process group ${pid} could not be stopped`);
        // Even a group that would not die is forgotten: once it does, its pid may go to someone else's process.
        live.delete(pid);
      }
      // Chrome's crash reporter leaves the group on purpose and inherits this pipe, so our end is closed, not held
      // for it.
      child.stderr?.destroy();
      try {
        await rm(profile, { recursive: true, force: true, maxRetries: 5 });
      } catch (err) {
        problems.push(`could not remove ${profile}: ${messageOf(err)}`);
      }
      return problems;
    },
  };
}
