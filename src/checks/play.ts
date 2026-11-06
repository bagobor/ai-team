import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.ts';
import { groupAlive, killGroupNow, spawnGroup } from '../proc.ts';
import { connectCdp, type Cdp } from './cdp.ts';

const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => [`Key${c}`, { key: c.toLowerCase(), code: `Key${c}`, keyCode: c.charCodeAt(0) }]);
const digits = [...'0123456789'].map((d) => [`Digit${d}`, { key: d, code: `Digit${d}`, keyCode: d.charCodeAt(0) }]);

// Named by KeyboardEvent.code, which is what games read.
export const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ShiftLeft: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  ...Object.fromEntries([...letters, ...digits]),
};

export function keyProblem(key: string): string | undefined {
  if (Object.hasOwn(KEYS, key)) return undefined;
  return `${key} is not a key. Keys are named by KeyboardEvent.code: ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Space, Enter, Escape, ShiftLeft, KeyA to KeyZ and Digit0 to Digit9`;
}

export type PlayStep = { key: string; hold_ms?: number } | { wait_ms: number } | { eval: string };
export type PlayScript = { steps: PlayStep[]; expect: string };

const MAX_STEPS = 50;
const MAX_WAIT_MS = 20_000;
const DEFAULT_HOLD_MS = 50;

const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// A key's hold counts as waiting, since the run spends that time too.
function totalWait(script: PlayScript): number {
  const waitOf = (step: PlayStep) => ('wait_ms' in step ? step.wait_ms : 'key' in step ? (step.hold_ms ?? DEFAULT_HOLD_MS) : 0);
  return script.steps.reduce((sum, step) => sum + (isMs(waitOf(step)) ? waitOf(step) : 0), 0);
}

// Scripts come from an agent's output, so nothing about their shape is taken on trust.
export function scriptProblems(script: PlayScript): string[] {
  if (typeof script !== 'object' || script === null) return ['A play script is a mapping with steps and an expect'];
  if (!Array.isArray(script.steps)) return ['steps must be a list'];
  const problems: string[] = [];
  if (script.steps.length > MAX_STEPS) problems.push(`A play script has at most ${MAX_STEPS} steps, not ${script.steps.length}`);
  script.steps.forEach((step, i) => {
    const at = `Step ${i + 1}`;
    if (typeof step !== 'object' || step === null) {
      problems.push(`${at} needs a key, a wait_ms or an eval`);
    } else if ('key' in step) {
      const problem = keyProblem(step.key);
      if (problem) problems.push(`${at}: ${problem}`);
      if (step.hold_ms !== undefined && !isMs(step.hold_ms)) problems.push(`${at}: hold_ms must be a number of milliseconds`);
    } else if ('wait_ms' in step) {
      if (!isMs(step.wait_ms)) problems.push(`${at}: wait_ms must be a number of milliseconds`);
    } else if (!('eval' in step) || typeof step.eval !== 'string' || step.eval.trim() === '') {
      problems.push(`${at} needs a key, a wait_ms or an eval`);
    }
  });
  const wait = totalWait(script);
  if (wait > MAX_WAIT_MS) problems.push(`A play script holds and waits at most ${MAX_WAIT_MS} ms in all, not ${wait} ms`);
  if (typeof script.expect !== 'string' || script.expect.trim() === '') problems.push('expect must be a JavaScript expression that is true when the script worked');
  return problems;
}

export type PlayProblem = {
  kind: 'load' | 'exception' | 'console' | 'request' | 'blank' | 'frozen' | 'still' | 'key' | 'expect' | 'timeout' | 'browser';
  detail: string;
};
export type PlayResult = { ok: boolean; problems: PlayProblem[]; durationMs: number; log: string[] };
export type Player = {
  unavailable(): string | undefined;
  smoke(url: string, keys: string[]): Promise<PlayResult>;
  script(url: string, script: PlayScript): Promise<PlayResult>;
};

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function chromePath(config: Config): string | undefined {
  const path = config.chrome.binary ?? DEFAULT_CHROME;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

// Chrome's own sandbox stays on. Everything off this machine goes to a proxy that isn't there; Chrome never proxies loopback, so the page itself still loads.
const FLAGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--proxy-server=http://127.0.0.1:9',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

const DEFAULT_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 10_000;
const EXIT_WAIT_MS = 5_000;
const POLL_MS = 50;
const SETTLE_MS = 1_000;
const SMOKE_HOLD_MS = 100;
const MIN_FRAMES = 30;
// Problem details become Bug evidence and the log rides along with them, so a noisy page must not flood either.
const MAX_LOG_LINES = 200;
const MAX_LINE = 200;
const MAX_DETAIL = 500;
const MAX_EVENT_PROBLEMS = 20;
const EVENT_KINDS = new Set<PlayProblem['kind']>(['exception', 'console', 'request', 'key']);

// Counts the frames in which the page itself asked for one, so a page that never animates reads 0 however often Chrome paints.
const FRAME_COUNTER = `(() => {
  const request = window.requestAnimationFrame.bind(window);
  let last;
  window.__aiteamFrames = 0;
  window.requestAnimationFrame = (callback) => request((time) => {
    if (time !== last) { last = time; window.__aiteamFrames += 1; }
    return callback(time);
  });
})();`;

// Runs in a blank tab, since Node has no PNG decoder. The screenshot is the composited frame, so a WebGL canvas counts like any other.
const COUNT_COLORS = `async (src) => {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0, 160, 90);
  const data = g.getImageData(0, 0, 160, 90).data;
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
  return seen.size;
}`;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const at = (url?: string, line?: number) => (url ? ` at ${url}:${(line ?? 0) + 1}` : '');

function exceptionText(d: any): string {
  const message: string | undefined = d?.exception?.description?.split('\n')[0] ?? (d?.exception?.value !== undefined ? String(d.exception.value) : undefined);
  const text: string = d?.text ?? 'Uncaught';
  const frame = d?.stackTrace?.callFrames?.[0];
  return `${message && !text.includes(message) ? `${text} ${message}` : text}${at(frame?.url ?? d?.url, frame?.lineNumber ?? d?.lineNumber)}`;
}

function shown(value: any): string {
  return typeof value === 'string' ? value : value === undefined ? 'undefined' : JSON.stringify(value);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parsed(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

// data:, blob: and Chrome's own error page never leave the machine.
function offMachine(url: string): boolean {
  const u = parsed(url);
  return u !== undefined && /^(https?|wss?):$/.test(u.protocol) && !LOOPBACK.has(u.hostname);
}

// Chrome asks for a favicon on its own. A game without one is no worse to play, so its absence is logged and nothing more.
const isFavicon = (url: string) => parsed(url)?.pathname === '/favicon.ico';

type Session = { id: string; send<T = any>(method: string, params?: object): Promise<T> };

class Run {
  readonly problems: PlayProblem[] = [];
  readonly log: string[] = [];
  readonly responses = new Map<string, number>();
  private readonly stopper = new AbortController();
  private dropped = 0;
  child?: ChildProcess;
  profile?: string;
  cdp?: Cdp;
  stderr = '';
  keyDown?: string;
  timedOut = false;

  constructor(readonly binary: string) {}

  get signal(): AbortSignal {
    return this.stopper.signal;
  }

  note(line: string): void {
    if (this.log.length < MAX_LOG_LINES) this.log.push(clip(line, MAX_LINE));
    else this.dropped += 1;
  }

  problem(kind: PlayProblem['kind'], detail: string): void {
    const text = clip(detail, MAX_DETAIL);
    if (this.problems.some((p) => p.kind === kind && p.detail === text)) return;
    // A page that fails every frame must not crowd out the checks made at the end of the run.
    if (EVENT_KINDS.has(kind) && this.problems.filter((p) => EVENT_KINDS.has(p.kind)).length >= MAX_EVENT_PROBLEMS) return;
    this.problems.push({ kind, detail: text });
  }

  // Ends whatever the run is waiting on: every wait rejects, and every CDP call rejects once the connection is closed.
  stop(why: Error): void {
    this.stopper.abort(why);
    this.cdp?.close();
    if (this.child?.pid !== undefined) killGroupNow(this.child.pid);
  }

  wait(ms: number): Promise<void> {
    return sleep(ms, undefined, { signal: this.signal });
  }

  // For a promise only Chrome can settle, such as an event that never comes.
  guard<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, new Promise<never>((_, reject) => this.signal.addEventListener('abort', () => reject(this.signal.reason), { once: true }))]);
  }

  // Chrome forks helpers into its process group, so the whole group goes, and the profile only once nothing writes to it.
  async cleanUp(): Promise<void> {
    this.stop(new Error('the run is over'));
    const pid = this.child?.pid;
    if (this.child && pid !== undefined) {
      if (this.child.exitCode === null && this.child.signalCode === null) await Promise.race([once(this.child, 'exit'), sleep(EXIT_WAIT_MS)]);
      for (const deadline = Date.now() + EXIT_WAIT_MS; groupAlive(pid) && Date.now() < deadline; ) await sleep(POLL_MS);
      // Chrome's crash reporter leaves the group on purpose and inherits this pipe, so our end is closed rather than held open for it.
      this.child.stderr?.destroy();
    }
    if (this.profile) await rm(this.profile, { recursive: true, force: true, maxRetries: 5 }).catch((err) => this.note(`could not remove ${this.profile}: ${messageOf(err)}`));
  }

  result(started: number): PlayResult {
    const log = this.dropped > 0 ? [...this.log, `… and ${this.dropped} more lines`] : this.log;
    return { ok: this.problems.length === 0, problems: this.problems, durationMs: Date.now() - started, log };
  }
}

async function devToolsUrl(profile: string): Promise<string | undefined> {
  try {
    const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n').map((line) => line.trim());
    return port && /^\d+$/.test(port) && path ? `ws://127.0.0.1:${port}${path}` : undefined;
  } catch {
    return undefined;
  }
}

async function launch(run: Run): Promise<Cdp> {
  run.profile = await mkdtemp(join(tmpdir(), 'aiteam-chrome-'));
  run.signal.throwIfAborted();
  const child = spawnGroup(run.binary, [...FLAGS, `--user-data-dir=${run.profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  run.child = child;
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (run.stderr = (run.stderr + chunk).slice(-2000)));
  child.once('error', (err) => run.stop(new Error(`could not start: ${err.message}`)));
  child.once('exit', (code, signal) => run.stop(new Error(`exited with ${code === null ? signal : `code ${code}`}`)));

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const url = await devToolsUrl(run.profile);
    if (url) return (run.cdp = await run.guard(connectCdp(url)));
    if (Date.now() > deadline) throw new Error(`did not open DevTools within ${START_TIMEOUT_MS / 1000} s`);
    await run.wait(POLL_MS);
  }
}

async function openTab(cdp: Cdp, browserContextId: string): Promise<Session> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  return { id: sessionId, send: (method, params) => cdp.send(method, params, sessionId) };
}

// The smoke check makes console errors and failed requests problems. A play script tests one criterion, so they only go to its log.
function watch(run: Run, cdp: Cdp, page: Session, mainFrame: string, strict: boolean): void {
  const urls = new Map<string, string>();
  const on = (event: string, handler: (params: any) => void) => cdp.on(event, (params, sessionId) => sessionId === page.id && handler(params ?? {}));

  on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const text = exceptionText(exceptionDetails);
    run.note(`exception: ${text}`);
    if (run.keyDown) run.problem('key', `${text}, while ${run.keyDown} was down`);
    else run.problem('exception', text);
  });
  on('Runtime.consoleAPICalled', ({ type, args, stackTrace }) => {
    const words = (args ?? []).map((a: any) => (a?.value !== undefined ? shown(a.value) : (a?.unserializableValue ?? a?.description ?? a?.type)));
    const frame = stackTrace?.callFrames?.[0];
    const text = `${words.join(' ')}${at(frame?.url, frame?.lineNumber)}`;
    run.note(`console.${type}: ${text}`);
    if (strict && type === 'error') run.problem('console', text);
  });
  on('Log.entryAdded', ({ entry }) => {
    const text = `${entry?.text ?? ''}${at(entry?.url, entry?.lineNumber)}`;
    run.note(`${entry?.source} ${entry?.level}: ${text}`);
    // Chrome logs each failed request here too; it is already a request problem, with its URL.
    if (strict && entry?.level === 'error' && entry?.source !== 'network') run.problem('console', text);
  });
  on('Network.requestWillBeSent', ({ requestId, request }) => urls.set(requestId, request?.url));
  on('Network.responseReceived', ({ requestId, type, frameId, response }) => {
    const { url = '', status = 0, statusText = '' } = response ?? {};
    run.responses.set(requestId, status);
    if (offMachine(url)) run.problem('request', `${url} answered ${status}, though the page must not reach anything off this machine`);
    if (status < 400) return;
    run.note(`${url} answered ${status} ${statusText}`);
    // The page's own document is judged by the load check.
    if (strict && !isFavicon(url) && !(type === 'Document' && frameId === mainFrame)) run.problem('request', `${url} answered ${status} ${statusText}`.trim());
  });
  on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
    const url = urls.get(requestId) ?? 'A request';
    run.note(`${url} failed: ${errorText}${canceled ? ' (canceled)' : ''}`);
    // A media element cancels and reissues its own requests, which is no fault of the page.
    if (strict && !canceled && !isFavicon(url)) run.problem('request', `${url} failed: ${errorText}`);
  });
}

async function load(run: Run, cdp: Cdp, page: Session, url: string): Promise<boolean> {
  const loaded = new Promise<void>((resolve) => {
    const off = cdp.on('Page.loadEventFired', (_, sessionId) => sessionId === page.id && (off(), resolve()));
  });
  const nav = await page.send<{ loaderId?: string; errorText?: string }>('Page.navigate', { url });
  if (nav.errorText) {
    run.problem('load', `${url} did not load: ${nav.errorText}`);
    return false;
  }
  await run.guard(loaded);
  const status = run.responses.get(nav.loaderId ?? '');
  if (status !== 200) run.problem('load', `${url} answered ${status ?? 'nothing'}, not 200`);
  return status === 200;
}

async function press(run: Run, page: Session, name: string, holdMs: number): Promise<void> {
  const problem = keyProblem(name);
  if (problem) return run.problem('key', problem);
  const { key, code, keyCode } = KEYS[name]!;
  // Printable keys carry text, so a game listening for keypress or input sees them as a person's would be.
  const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
  const event = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  run.note(`key ${name}, held ${holdMs} ms`);
  run.keyDown = name;
  try {
    await page.send('Input.dispatchKeyEvent', text ? { ...event, type: 'keyDown', text, unmodifiedText: text } : { ...event, type: 'rawKeyDown' });
    await run.wait(holdMs);
    await page.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
  } finally {
    run.keyDown = undefined;
  }
}

// What a script evaluates is its own business: a throw, or a value Chrome can't hand back, is the script's problem. A dead browser is not.
async function evaluate(run: Run, page: Session, expression: string): Promise<{ value?: unknown; threw?: string }> {
  try {
    const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return exceptionDetails ? { threw: exceptionText(exceptionDetails) } : { value: result?.value };
  } catch (err) {
    if (run.signal.aborted) throw err;
    return { threw: messageOf(err) };
  }
}

async function smokeSteps(run: Run, cdp: Cdp, context: string, page: Session, keys: string[]): Promise<void> {
  const frames = async () => Number((await evaluate(run, page, 'window.__aiteamFrames')).value) || 0;
  const screenshot = async () => (await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })).data;

  await run.wait(SETTLE_MS);
  const before = await screenshot();
  const framesBefore = await frames();
  const counting = Date.now();
  for (const key of keys) await press(run, page, key, SMOKE_HOLD_MS);
  await run.wait(SETTLE_MS);
  const after = await screenshot();
  const ran = (await frames()) - framesBefore;
  const seconds = ((Date.now() - counting) / 1000).toFixed(1);

  const scratch = await openTab(cdp, context);
  const counted = await evaluate(run, scratch, `(${COUNT_COLORS})(${JSON.stringify(`data:image/png;base64,${after}`)})`);
  if (counted.threw) throw new Error(`could not read the screenshot: ${counted.threw}`);
  const colors = Number(counted.value);
  if (colors < 2) run.problem('blank', `The page shows one flat color a second after the keys: nothing was drawn`);
  if (ran < MIN_FRAMES) run.problem('frozen', `The page ran ${ran} animation frames in ${seconds} s, from a second after load to a second after the keys; at least ${MIN_FRAMES} were expected`);
  if (before === after) run.problem('still', 'The screen did not change from a second after load to a second after the keys');
  run.note(`${colors} colors, ${ran} frames`);
}

async function scriptSteps(run: Run, page: Session, script: PlayScript): Promise<void> {
  for (const [i, step] of script.steps.entries()) {
    if ('key' in step) {
      await press(run, page, step.key, step.hold_ms ?? DEFAULT_HOLD_MS);
    } else if ('wait_ms' in step) {
      await run.wait(step.wait_ms);
    } else {
      run.note(`eval ${step.eval}`);
      const { threw } = await evaluate(run, page, step.eval);
      if (threw) run.problem('exception', `Step ${i + 1}, ${step.eval}, threw: ${threw}`);
    }
  }
  const { value, threw } = await evaluate(run, page, script.expect);
  if (threw) run.problem('expect', `${script.expect} threw: ${threw}`);
  else if (value !== true) run.problem('expect', `${script.expect} was ${shown(value)}`);
}

async function play(binary: string, deadlineMs: number, strict: boolean, url: string, steps: (run: Run, cdp: Cdp, context: string, page: Session) => Promise<void>): Promise<PlayResult> {
  const started = Date.now();
  const run = new Run(binary);
  const timer = setTimeout(() => {
    run.timedOut = true;
    run.stop(new Error('timed out'));
  }, deadlineMs);
  try {
    const cdp = await launch(run);
    const { browserContextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext');
    const page = await openTab(cdp, browserContextId);
    const { frameTree } = await page.send('Page.getFrameTree');
    watch(run, cdp, page, frameTree.frame.id, strict);
    await Promise.all(['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable'].map((method) => page.send(method)));
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FRAME_COUNTER });
    if (await load(run, cdp, page, url)) await steps(run, cdp, browserContextId, page);
  } catch (err) {
    if (run.timedOut) {
      run.problems.push({ kind: 'timeout', detail: `The run took longer than ${deadlineMs} ms, so it was stopped` });
    } else {
      run.problems.push({ kind: 'browser', detail: clip(`Chrome at ${binary}: ${messageOf(run.signal.aborted ? run.signal.reason : err)}`, MAX_DETAIL) });
      for (const line of run.stderr.trim().split('\n').slice(-5)) if (line) run.note(`chrome: ${line}`);
    }
  } finally {
    clearTimeout(timer);
    await run.cleanUp();
  }
  return run.result(started);
}

export function chromePlayer(config: Config, opts: { timeoutMs?: number } = {}): Player {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const unavailable = () => (chromePath(config) ? undefined : `Chrome was not found at ${config.chrome.binary ?? DEFAULT_CHROME}. Set chrome.binary in ~/.aiteam/config.yaml`);
  // Asked again on every run, so a Chrome installed since startup is picked up.
  const missing = (): PlayResult | undefined => {
    const why = unavailable();
    return why ? { ok: false, problems: [{ kind: 'browser', detail: why }], durationMs: 0, log: [] } : undefined;
  };

  return {
    unavailable,
    smoke: async (url, keys) => missing() ?? play(chromePath(config)!, timeoutMs, true, url, (run, cdp, context, page) => smokeSteps(run, cdp, context, page, keys)),
    script: async (url, script) => {
      const invalid = scriptProblems(script);
      if (invalid.length > 0) return { ok: false, problems: invalid.map((detail) => ({ kind: 'expect' as const, detail: `The play script is invalid: ${detail}` })), durationMs: 0, log: [] };
      // The timeout is for a browser or page that hangs; the script's own waits come on top of it.
      return missing() ?? play(chromePath(config)!, timeoutMs + totalWait(script), false, url, (run, _cdp, _context, page) => scriptSteps(run, page, script));
    },
  };
}
