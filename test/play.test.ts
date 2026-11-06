import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectCdp } from '../src/checks/cdp.ts';
import { liveGroups } from '../src/checks/chrome.ts';
import {
  blankProblem,
  chromePath,
  chromePlayer,
  keyProblem,
  scriptProblems,
  type PlayResult,
  type PlayScript,
  type PlayStep,
} from '../src/checks/play.ts';
import { serveStatic } from '../src/checks/static-server.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { groupAlive, killGroupNow } from '../src/proc.ts';
import { until } from './helpers/engine.ts';
import { tempDir } from './helpers/repo.ts';

// No process can be made to survive SIGKILL, so to play out a group that will not die, a test has every group read
// as alive for a while.
const stuck = vi.hoisted(() => ({ on: false }));
vi.mock('../src/proc.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/proc.ts')>();
  return { ...real, groupAlive: (pid: number) => stuck.on || real.groupAlive(pid) };
});

const config = DEFAULT_CONFIG;
const chrome = chromePath(config);
const FIXTURES = join(import.meta.dirname, 'fixtures', 'play');
// Nothing listens here, so a run that gets past launching Chrome would fail to load, not pass.
const NOWHERE = 'http://127.0.0.1:9/index.html';

function profiles(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('aiteam-chrome-'));
}

type FakeChrome = {
  dir: string;
  binary: string;
  args: () => string[];
  env: () => string[];
  profile: () => string;
  pid: () => number;
};

// A stand-in for the Chrome binary that records how it was started, then does whatever `body` says.
function fakeChrome(body: string): FakeChrome {
  const dir = tempDir('aiteam-fake-chrome-');
  const binary = join(dir, 'chrome');
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\nenv > '${dir}/env'\necho $$ > '${dir}/pid'\n${body}\n`);
  chmodSync(binary, 0o755);
  const lines = (name: string) => readFileSync(join(dir, name), 'utf8').trimEnd().split('\n');
  return {
    dir,
    binary,
    args: () => lines('args'),
    env: () => lines('env'),
    profile: () => lines('args').find((arg) => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length),
    pid: () => Number(readFileSync(join(dir, 'pid'), 'utf8')),
  };
}

const PROJECT = join(import.meta.dirname, '..');

describe('keys and scripts', () => {
  it('names a key it does not know', () => {
    expect(keyProblem('ArrowLeft')).toBeUndefined();
    expect(keyProblem('KeyZ')).toBeUndefined();
    expect(keyProblem('Digit0')).toBeUndefined();
    expect(keyProblem('Fire')).toMatch(/Fire is not a key/);
    expect(keyProblem('toString')).toMatch(/toString is not a key/);
  });

  it('holds a script to its limits', () => {
    expect(scriptProblems({ steps: [{ key: 'Space' }, { wait_ms: 100 }, { eval: 'window.go()' }], expect: 'window.ok' })).toEqual([]);
    expect(scriptProblems({ steps: Array.from({ length: 51 }, () => ({ wait_ms: 1 })), expect: 'true' })).toContainEqual(
      expect.stringMatching(/at most 50 steps/),
    );
    expect(scriptProblems({ steps: [{ wait_ms: 15_000 }, { key: 'Space', hold_ms: 5_001 }], expect: 'true' })).toContainEqual(
      expect.stringMatching(/20000 ms/),
    );
    expect(scriptProblems({ steps: [{ key: 'Fire' }], expect: 'true' })).toContainEqual(expect.stringMatching(/Fire is not a key/));
    expect(scriptProblems({ steps: [], expect: '  ' })).toContainEqual(expect.stringMatching(/expect/));
    // A script is parsed from an agent's output, so it may not be a mapping at all, nor its steps.
    expect(scriptProblems(null as unknown as PlayScript)).toEqual([expect.stringMatching(/steps.*expect/)]);
    for (const step of ['ArrowLeft', null, 5]) {
      expect(scriptProblems({ steps: [step as unknown as PlayStep], expect: 'true' })).toEqual([
        expect.stringMatching(/Step 1 needs a key, a wait_ms or an eval/),
      ]);
    }
    // A step that is two kinds at once would be counted as one and played as the other.
    const both = { key: 'Space', hold_ms: 60_000, wait_ms: 0 } as unknown as PlayStep;
    const twice = scriptProblems({ steps: [both], expect: 'true' });
    expect(twice).toContainEqual('Step 1 has more than one of key, wait_ms and eval');
    expect(twice).toContainEqual(expect.stringMatching(/at most 20000 ms in all, not 60000 ms/));
    const withEval = { wait_ms: 10, eval: 'go()' } as unknown as PlayStep;
    expect(scriptProblems({ steps: [{ wait_ms: 1 }, withEval], expect: 'true' })).toEqual([
      'Step 2 has more than one of key, wait_ms and eval',
    ]);
  });

  it('counts a screenshot whose colors could not be read as blank', () => {
    expect(blankProblem(2)).toBeUndefined();
    expect(blankProblem(40)).toBeUndefined();
    expect(blankProblem(1)).toMatch(/one flat color/);
    for (const count of [Number.NaN, undefined, null, 'many']) expect(blankProblem(count)).toMatch(/could not be counted/);
  });
});

describe('chromePlayer without a working Chrome', () => {
  it('says why when Chrome cannot start', () => {
    expect(chromePlayer({ ...config, chrome: { binary: '/nope' } }).unavailable()).toMatch(/\/nope/);
  });

  it('fails, naming the path, when the binary is missing', async () => {
    const player = chromePlayer({ ...config, chrome: { binary: '/nope' } });
    const smoked = await player.smoke(NOWHERE, ['Space']);
    const scripted = await player.script(NOWHERE, { steps: [], expect: 'true' });

    for (const result of [smoked, scripted]) {
      expect(result.ok).toBe(false);
      expect(result.problems).toEqual([{ kind: 'browser', detail: expect.stringContaining('/nope') }]);
    }
  });

  it('starts Chrome with its own sandbox, a fresh profile and the network shut off', async () => {
    const fake = fakeChrome('exit 3');
    await chromePlayer({ ...config, chrome: { binary: fake.binary } }).smoke(NOWHERE, ['Space']);

    const args = fake.args();
    expect(args).toEqual(
      expect.arrayContaining([
        '--headless=new',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--mute-audio',
        '--use-mock-keychain',
        '--autoplay-policy=no-user-gesture-required',
        '--proxy-server=http://127.0.0.1:9',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ]),
    );
    // Only the played page's own origin goes direct: NOWHERE is on port 9.
    expect(args.filter((arg) => arg.startsWith('--proxy-bypass-list'))).toEqual(['--proxy-bypass-list=<-loopback>;127.0.0.1:9']);
    expect(args).not.toContain('--no-sandbox');
    expect(dirname(fake.profile())).toBe(tmpdir());
    expect(fake.profile()).toMatch(/\/aiteam-chrome-[^/]+$/);
  });

  it('gives Chrome none of the engine environment, and a home inside its profile', async () => {
    process.env.AITEAM_PLAY_SENTINEL = 'engine only';
    try {
      const fake = fakeChrome('exit 3');
      await chromePlayer({ ...config, chrome: { binary: fake.binary } }).smoke(NOWHERE, ['Space']);

      const env = fake.env();
      const home = join(fake.profile(), 'home');
      expect(env).toContain('CHROME_HEADLESS=1');
      expect(env).toContain(`HOME=${home}`);
      expect(env).toContain(`CFFIXED_USER_HOME=${home}`);
      // The shell that stands in for Chrome sets PWD, SHLVL and _ itself.
      const allowed = new Set(['PATH', 'TMPDIR', 'LANG', 'HOME', 'CFFIXED_USER_HOME', 'CHROME_HEADLESS', 'PWD', 'SHLVL', '_']);
      expect(env.map((line) => line.split('=')[0]).filter((name) => !allowed.has(name!))).toEqual([]);
    } finally {
      delete process.env.AITEAM_PLAY_SENTINEL;
    }
  });

  it('refuses a malformed script without starting Chrome', async () => {
    const fake = fakeChrome('exit 3');
    const steps = ['ArrowLeft'] as unknown as PlayStep[];
    const result = await chromePlayer({ ...config, chrome: { binary: fake.binary } }).script(NOWHERE, { steps, expect: 'true' });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'expect', detail: expect.stringMatching(/Step 1/) }]);
    expect(existsSync(join(fake.dir, 'args'))).toBe(false);
  });

  it('plays only a page served on 127.0.0.1, and says so', async () => {
    const fake = fakeChrome('exit 3');
    const player = chromePlayer({ ...config, chrome: { binary: fake.binary } });

    for (const url of ['http://localhost:9/index.html', 'https://127.0.0.1:9/', 'file:///tmp/index.html', 'not a url']) {
      const result = await player.smoke(url, []);
      expect(result.ok).toBe(false);
      expect(result.problems).toEqual([{ kind: 'browser', detail: expect.stringContaining(url) }]);
    }
    expect(existsSync(join(fake.dir, 'args'))).toBe(false);
  });

  it('stops Chrome when the engine exits in the middle of a run', async () => {
    // Forks busily, as Chrome does while it starts: a group signal races a fork, and what is forked meanwhile escapes
    // a single kill.
    const fake = fakeChrome(
      'for j in 1 2 3 4; do (i=0; while [ $i -lt 40 ]; do sleep 60 & i=$((i+1)); done; wait) & done; wait',
    );
    const scratch = tempDir('aiteam-play-exit-');
    const script = join(scratch, 'run.mts');
    writeFileSync(
      script,
      [
        `import { readFileSync } from 'node:fs';`,
        `import { chromePlayer } from ${JSON.stringify(join(PROJECT, 'src/checks/play.ts'))};`,
        `import { DEFAULT_CONFIG } from ${JSON.stringify(join(PROJECT, 'src/config.ts'))};`,
        `const [binary, pidFile] = process.argv.slice(2);`,
        `const url = ${JSON.stringify(NOWHERE)};`,
        `void chromePlayer({ ...DEFAULT_CONFIG, chrome: { binary } }).smoke(url, ['Space']);`,
        `const written = () => { try { return /^\\d+\\n/.test(readFileSync(pidFile, 'utf8')); } catch { return false; } };`,
        // As the daemon's signal handler does, while the run still waits for DevTools. The pid has to be in the file
        // first: a fake killed between creating it and writing it would leave the test no group to look at.
        `setInterval(() => written() && process.exit(0), 20);`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script, fake.binary, join(fake.dir, 'pid')], {
      cwd: PROJECT,
      stdio: 'ignore',
    });
    // Signalling group 0 would mean the test's own, so a pid that was never written reads as none.
    const pid = () => (existsSync(join(fake.dir, 'pid')) ? fake.pid() || 0 : 0);
    try {
      // A child that never exits fails the test rather than hanging it.
      const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(10_000) });

      expect(code).toBe(0);
      expect(pid()).toBeGreaterThan(1);
      await until(async () => !groupAlive(pid()), 3_000);
      expect(existsSync(fake.profile())).toBe(false);
    } finally {
      // Whatever the outcome, neither the child nor the fake may outlive the test.
      child.kill('SIGKILL');
      if (pid() > 1) killGroupNow(pid());
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);

  it('gives up on a group that will not die, says so, and stops tracking it', async () => {
    const fake = fakeChrome('exit 3');
    const player = chromePlayer({ ...config, chrome: { binary: fake.binary } });
    let result: PlayResult;
    stuck.on = true;
    try {
      result = await player.smoke(NOWHERE, []);
    } finally {
      stuck.on = false;
    }

    expect(result.log).toContainEqual(expect.stringMatching(new RegExp(`group ${fake.pid()} could not be stopped`)));
    // A pid the system hands out again must never be signalled on the engine's behalf.
    expect(liveGroups()).not.toContain(fake.pid());
    expect(existsSync(fake.profile())).toBe(false);
  }, 20_000);

  it('fails, naming the path, when Chrome exits before DevTools opens, and removes the profile', async () => {
    const fake = fakeChrome('exit 3');
    const result = await chromePlayer({ ...config, chrome: { binary: fake.binary } }).smoke(NOWHERE, ['Space']);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'browser', detail: expect.stringContaining(fake.binary) }]);
    expect(existsSync(fake.profile())).toBe(false);
  });

  it('fails, naming the path, when DevTools never opens, and stops everything it started', async () => {
    const fake = fakeChrome('sleep 60 &\nsleep 60');
    const result = await chromePlayer({ ...config, chrome: { binary: fake.binary } }).script(NOWHERE, { steps: [], expect: 'true' });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'browser', detail: expect.stringContaining(fake.binary) }]);
    expect(result.problems[0]!.detail).toMatch(/DevTools/);
    expect(groupAlive(fake.pid())).toBe(false);
    expect(existsSync(fake.profile())).toBe(false);
  }, 20_000);

  it('reports a run past its timeout, and stops everything it started', async () => {
    const fake = fakeChrome('sleep 60 &\nsleep 60');
    const result = await chromePlayer({ ...config, chrome: { binary: fake.binary } }, { timeoutMs: 1000 }).smoke(NOWHERE, ['Space']);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'timeout', detail: expect.stringContaining('1000 ms') }]);
    expect(result.durationMs).toBeLessThan(5000);
    expect(groupAlive(fake.pid())).toBe(false);
    expect(existsSync(fake.profile())).toBe(false);
  });
});

describe.skipIf(!chrome && process.env.AITEAM_REQUIRE_CHROME !== '1')('chromePlayer', () => {
  const player = chromePlayer(config);

  async function served<T>(name: string, use: (url: string) => Promise<T>): Promise<T> {
    const server = await serveStatic(join(FIXTURES, name));
    try {
      return await use(server.url);
    } finally {
      await server.close();
    }
  }

  const smoke = (name: string, opts?: { animated?: boolean }): Promise<PlayResult> => served(name, (url) => player.smoke(url + 'index.html', ['ArrowLeft', 'Space'], opts));
  const kinds = (result: PlayResult) => result.problems.map((problem) => problem.kind);

  it('passes a page with no animation loop when the profile says it has none', async () => {
    const result = await smoke('static', { animated: false });
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.log).toContainEqual(expect.stringMatching(/^\d+ colors, 0 frames$/));
  });

  it('fails the same page as frozen and still when the profile says nothing', async () => {
    const result = await smoke('static');
    expect(result.ok).toBe(false);
    expect(kinds(result).sort()).toEqual(['frozen', 'still']);
  });

  it('still catches a page with no animation loop that draws nothing', async () => {
    const result = await smoke('blank', { animated: false });
    expect(kinds(result)).toEqual(['blank']);
  });

  it('passes a page that paints, animates and takes keys', async () => {
    const result = await smoke('ok');
    expect(result).toMatchObject({ ok: true, problems: [] });
  });

  it('catches an exception on load', async () => {
    const result = await smoke('throws');
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'exception', detail: expect.stringMatching(/boom.*index\.html:\d+/) }]);
  });

  it('catches a console error', async () => {
    const result = await smoke('console-error');
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'console', detail: expect.stringContaining('bad') }]);
  });

  it('catches a missing script', async () => {
    const result = await smoke('missing-script');
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'request', detail: expect.stringMatching(/missing\.js.*404/) }]);
  });

  it('catches a canvas that never paints', async () => {
    const result = await smoke('blank');
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('blank');
  });

  it('catches frames that do not advance', async () => {
    const result = await smoke('frozen');
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('frozen');
    expect(kinds(result)).not.toContain('blank');
    // The count starts at load, so it spans both settles and the keys.
    expect(result.problems.find((problem) => problem.kind === 'frozen')!.detail).toMatch(/0 animation frames in [2-9]\.\d s after load/);
  });

  it('answers a dialog and plays on', async () => {
    const result = await smoke('alert');
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.log).toContain('dialog alert: start');
  }, 30_000);

  it('passes an animating WebGL canvas', async () => {
    const result = await smoke('webgl');
    expect(result).toMatchObject({ ok: true, problems: [] });
  });

  it('keeps the page off the network', async () => {
    const result = await smoke('network');
    const offMachine = result.problems.filter((problem) => problem.detail.includes('1.1.1.1'));

    expect(result.ok).toBe(false);
    expect(offMachine.length).toBeGreaterThan(0);
    for (const problem of offMachine) expect(problem).toEqual({ kind: 'request', detail: expect.stringContaining('ERR_PROXY_CONNECTION_FAILED') });
    expect(result.log.join('\n')).toContain('ERR_PROXY_CONNECTION_FAILED');
  });

  it('lets the page reach its own origin and no other server on this machine', async () => {
    const arrived: string[] = [];
    const servers: Server[] = [];
    const listen = async (port: number, host: string): Promise<number> => {
      const server = createServer((_, res) => res.end('reached'));
      server.on('connection', () => arrived.push(host));
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve()));
      servers.push(server);
      return (server.address() as AddressInfo).port;
    };
    const other = await listen(0, '127.0.0.1');
    const v6 = await listen(other, '::1').then(
      () => true,
      () => false,
    );
    // Not every machine has 127.0.0.2 on its loopback; the probe goes out either way.
    await listen(other, '127.0.0.2').catch(() => undefined);

    try {
      const page = `index.html?other=${other}${v6 ? '' : '&v6=0'}`;
      const result = await served('isolation', (url) => player.smoke(url + page, []));
      const log = result.log.join('\n');

      expect(log).toContain('console.log: probes done');
      expect(log).toContain(`http://127.0.0.1:${other}/ failed: net::ERR_PROXY_CONNECTION_FAILED`);
      expect(arrived).toEqual([]);
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });

  it("keeps Chrome's crash database inside the run's profile", async () => {
    const before = new Set(profiles());
    const running = smoke('ok');
    const profile = join(tmpdir(), await until(async () => profiles().find((name) => !before.has(name))));
    const crashpad = join(profile, 'home', 'Library', 'Application Support', 'Google', 'Chrome', 'Crashpad');
    const seen = await until(async () => existsSync(crashpad)).catch(() => false);

    expect((await running).ok).toBe(true);
    expect(seen).toBe(true);
    expect(existsSync(profile)).toBe(false);
  });

  it('runs a play script and its expectation', async () => {
    const steps = [{ key: 'ArrowLeft', hold_ms: 300 }, { wait_ms: 100 }];
    const passed = await served('ok', (url) => player.script(url + 'index.html', { steps, expect: 'window.ship.x < 100' }));
    const failed = await served('ok', (url) => player.script(url + 'index.html', { steps, expect: 'false' }));

    expect(passed).toMatchObject({ ok: true, problems: [] });
    expect(failed.ok).toBe(false);
    expect(failed.problems).toEqual([{ kind: 'expect', detail: expect.stringContaining('false') }]);
  });

  it('reports a page that never settles as a timeout', async () => {
    const result = await served('ok', (url) =>
      chromePlayer(config, { timeoutMs: 3000 }).script(url + 'index.html', { steps: [{ eval: 'new Promise(() => {})' }], expect: 'true' }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'timeout', detail: expect.stringContaining('3000 ms') }]);
  });

  it('leaves no Chrome process or profile behind', async () => {
    const before = new Set(profiles());
    const running = smoke('ok');
    const profile = join(tmpdir(), await until(async () => profiles().find((name) => !before.has(name))));
    await running;

    expect(existsSync(profile)).toBe(false);
    // pgrep exits 1 when nothing matches.
    expect(() => execFileSync('pgrep', ['-f', profile], { stdio: 'pipe' })).toThrow();
  });
});

type Peer = { send: (message: object) => void; drop: () => void };

// A WebSocket peer small enough to script: it reads the client's masked text frames and answers with unmasked ones.
async function fakeCdp(onMessage: (message: { id: number; method: string; params?: object; sessionId?: string }, peer: Peer) => void) {
  const server: Server = createServer();
  const sockets = new Set<Socket>();
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer: Peer = {
      send: (message) => {
        const payload = Buffer.from(JSON.stringify(message));
        const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
        socket.write(Buffer.concat([header, payload]));
      },
      drop: () => socket.destroy(),
    };
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let frame = readFrame(buffered); frame; frame = readFrame(buffered)) {
        buffered = buffered.subarray(frame.size);
        if (frame.opcode === 1) onMessage(JSON.parse(frame.text), peer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/fake`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readFrame(buf: Buffer): { opcode: number; text: string; size: number } | undefined {
  if (buf.length < 2) return undefined;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return undefined;
    length = buf.readUInt16BE(2);
    offset = 4;
  }
  if (buf.length < offset + 4 + length) return undefined;
  const mask = buf.subarray(offset, offset + 4);
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i++) payload[i] = buf[offset + 4 + i]! ^ mask[i % 4]!;
  return { opcode: buf[0]! & 0x0f, text: payload.toString('utf8'), size: offset + 4 + length };
}

describe('connectCdp', () => {
  it('answers each command by its id and routes events with their session', async () => {
    const peer = await fakeCdp((message, p) => {
      if (message.method === 'Page.loadEventFired.emit') p.send({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' });
      p.send({ id: message.id, result: { method: message.method, params: message.params, sessionId: message.sessionId } });
    });
    const cdp = await connectCdp(peer.url);
    const seen: unknown[] = [];
    const off = cdp.on('Page.loadEventFired', (params, sessionId) => seen.push([params, sessionId]));

    const [a, b] = await Promise.all([cdp.send('A.one', { x: 1 }, 'S1'), cdp.send('B.two')]);
    expect(a).toEqual({ method: 'A.one', params: { x: 1 }, sessionId: 'S1' });
    expect(b).toEqual({ method: 'B.two', params: {} });

    await cdp.send('Page.loadEventFired.emit');
    off();
    await cdp.send('Page.loadEventFired.emit');
    expect(seen).toEqual([[{ timestamp: 1 }, 'S1']]);

    cdp.close();
    await peer.close();
  });

  it('rejects a command that answers with an error', async () => {
    const peer = await fakeCdp((message, p) => p.send({ id: message.id, error: { code: -32601, message: `'${message.method}' wasn't found` } }));
    const cdp = await connectCdp(peer.url);

    await expect(cdp.send('Target.nope')).rejects.toThrow(/Target\.nope.*wasn't found/);

    cdp.close();
    await peer.close();
  });

  it('rejects every pending command when the socket closes', async () => {
    let received = 0;
    const peer = await fakeCdp((_message, p) => {
      received += 1;
      if (received === 2) p.drop();
    });
    const cdp = await connectCdp(peer.url);

    const first = cdp.send('Runtime.evaluate');
    const second = cdp.send('Runtime.evaluate');
    await expect(first).rejects.toThrow(/closed/);
    await expect(second).rejects.toThrow(/closed/);
    await expect(cdp.send('Runtime.evaluate')).rejects.toThrow(/closed/);

    await peer.close();
  });

  it('rejects a command once it has been closed', async () => {
    const peer = await fakeCdp(() => {});
    const cdp = await connectCdp(peer.url);
    const pending = cdp.send('Runtime.evaluate');

    cdp.close();
    await expect(pending).rejects.toThrow(/closed/);
    await expect(cdp.send('Runtime.evaluate')).rejects.toThrow(/closed/);

    await peer.close();
  });

  it('rejects when nothing listens', async () => {
    const peer = await fakeCdp(() => {});
    const url = peer.url;
    await peer.close();

    await expect(connectCdp(url)).rejects.toThrow();
  });
});
