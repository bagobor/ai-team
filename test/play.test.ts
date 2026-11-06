import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectCdp } from '../src/checks/cdp.ts';
import { chromePath, chromePlayer, keyProblem, scriptProblems, type PlayResult } from '../src/checks/play.ts';
import { serveStatic } from '../src/checks/static-server.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { groupAlive } from '../src/proc.ts';
import { until } from './helpers/engine.ts';
import { tempDir } from './helpers/repo.ts';

const config = DEFAULT_CONFIG;
const chrome = chromePath(config);
const FIXTURES = join(import.meta.dirname, 'fixtures', 'play');
// Nothing listens here, so a run that gets past launching Chrome would fail to load, not pass.
const NOWHERE = 'http://127.0.0.1:9/index.html';

function profiles(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('aiteam-chrome-'));
}

// A stand-in for the Chrome binary that records how it was started, then does whatever `body` says.
function fakeChrome(body: string): { binary: string; args: () => string[]; profile: () => string; pid: () => number } {
  const dir = tempDir('aiteam-fake-chrome-');
  const binary = join(dir, 'chrome');
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\necho $$ > '${dir}/pid'\n${body}\n`);
  chmodSync(binary, 0o755);
  const args = () => readFileSync(join(dir, 'args'), 'utf8').trimEnd().split('\n');
  return {
    binary,
    args,
    profile: () => args().find((arg) => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length),
    pid: () => Number(readFileSync(join(dir, 'pid'), 'utf8')),
  };
}

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
        '--autoplay-policy=no-user-gesture-required',
        '--proxy-server=http://127.0.0.1:9',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ]),
    );
    // A bypass list of <-loopback> would send the page on 127.0.0.1 itself to the dead proxy.
    expect(args.filter((arg) => arg.startsWith('--proxy-bypass-list'))).toEqual([]);
    expect(args).not.toContain('--no-sandbox');
    expect(dirname(fake.profile())).toBe(tmpdir());
    expect(fake.profile()).toMatch(/\/aiteam-chrome-[^/]+$/);
  });

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

  const smoke = (name: string): Promise<PlayResult> => served(name, (url) => player.smoke(url + 'index.html', ['ArrowLeft', 'Space']));
  const kinds = (result: PlayResult) => result.problems.map((problem) => problem.kind);

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
  });

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
