import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { TryServer } from '../src/engine/try-server.ts';
import { tempDir } from './helpers/repo.ts';

const fetched = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
};

describe('the try server', () => {
  let server: TryServer;
  let build: string;

  beforeEach(async () => {
    build = tempDir('aiteam-try-build-');
    mkdirSync(join(build, 'assets'));
    writeFileSync(join(build, 'index.html'), '<p>the game</p>');
    writeFileSync(join(build, 'assets', 'game.js'), 'play();');
    server = await TryServer.start(0);
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves a mounted build under its project and milestone', async () => {
    const url = server.mount('demo', 1, build);

    expect(url).toBe(`${server.url}demo/m1/`);
    expect(server.mounted('demo', 1)).toBe(true);
    expect(server.mounted('demo', 2)).toBe(false);
    expect(await fetched(`${url}index.html`)).toEqual({ status: 200, body: '<p>the game</p>' });
    expect(await fetched(`${url}assets/game.js`)).toEqual({ status: 200, body: 'play();' });
    expect((await fetched(`${server.url}demo/m2/index.html`)).status).toBe(404);
  });

  it('stops serving it once unmounted', async () => {
    const url = server.mount('demo', 1, build);

    server.unmount('demo', 1);

    expect(server.mounted('demo', 1)).toBe(false);
    expect((await fetched(`${url}index.html`)).status).toBe(404);
  });

  // The root comes from a check that resolved it. A link where that check found a directory was put there afterwards.
  it('refuses a root that resolves somewhere else, and serves nothing in its place', async () => {
    const url = server.mount('demo', 1, build);
    const link = join(tempDir('aiteam-try-link-'), 'build');
    symlinkSync(build, link);

    expect(() => server.mount('demo', 1, link)).toThrow(/changed/);

    expect(server.mounted('demo', 1)).toBe(false);
    expect((await fetched(`${url}index.html`)).status).toBe(404);
  });

  it('listens on 127.0.0.1 only', async () => {
    const { hostname, port } = new URL(server.url);
    expect(hostname).toBe('127.0.0.1');

    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && address.family === 'IPv4' && !address.internal);
    if (external === undefined) return;
    const client = connect(Number(port), external.address);
    const outcome = await new Promise((resolve) => {
      client.once('connect', () => resolve('connected'));
      client.once('error', () => resolve('refused'));
    });
    client.destroy();
    expect(outcome).toBe('refused');
  });
});
