import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { serveStatic, type StaticServer } from '../src/checks/static-server.ts';
import { tempDir } from './helpers/repo.ts';

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// fetch() normalizes `..` and `%2e%2e` away before sending, so traversal has to go out as written.
function get(server: StaticServer, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serveStatic', () => {
  let base: string;
  let site: string;
  let server: StaticServer;

  beforeEach(async () => {
    base = tempDir();
    site = join(base, 'site');
    mkdirSync(join(site, 'sub'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<p>home</p>');
    writeFileSync(join(site, 'game.js'), 'console.log(1);');
    writeFileSync(join(site, 'sub', 'index.html'), '<p>sub</p>');
    writeFileSync(join(base, 'secret.txt'), 'secret');
    server = await serveStatic(site);
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves a file with its content type', async () => {
    const page = await get(server, '/index.html');
    expect(page).toMatchObject({ status: 200, body: '<p>home</p>' });
    expect(page.headers['content-type']).toMatch(/^text\/html\b/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();

    const script = await get(server, '/game.js');
    expect(script).toMatchObject({ status: 200, body: 'console.log(1);' });
    expect(script.headers['content-type']).toMatch(/^text\/javascript\b/);
  });

  it('serves a directory as its index.html', async () => {
    expect(await get(server, '/')).toMatchObject({ status: 200, body: '<p>home</p>' });
    expect(await get(server, '/sub/')).toMatchObject({ status: 200, body: '<p>sub</p>' });
  });

  it('answers 404 for a missing file', async () => {
    expect((await get(server, '/nothing.js')).status).toBe(404);
  });

  it('refuses to leave its root', async () => {
    expect((await get(server, '/../secret.txt')).status).toBe(404);
    expect((await get(server, '/%2e%2e/secret.txt')).status).toBe(404);
    expect((await get(server, '/sub/..%2f..%2fsecret.txt')).status).toBe(404);
  });

  it('refuses a symlink that points out of its root', async () => {
    symlinkSync(join(base, 'secret.txt'), join(site, 'link.txt'));
    symlinkSync(base, join(site, 'up'));

    expect((await get(server, '/link.txt')).status).toBe(404);
    expect((await get(server, '/up/secret.txt')).status).toBe(404);
  });

  it('answers a hostile path without falling over', async () => {
    expect((await get(server, '/%E0%A4%A')).status).toBe(400);
    expect([400, 404]).toContain((await get(server, '/%00')).status);
    expect([400, 404]).toContain((await get(server, '/a%00.html')).status);

    expect((await get(server, '/index.html')).status).toBe(200);
  });

  it('listens on 127.0.0.1 only', () => {
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });
});

describe('serveStatic with mounts', () => {
  let server: StaticServer;

  afterEach(async () => {
    await server.close();
  });

  it('serves mounted roots under their prefix', async () => {
    const dirA = tempDir();
    const dirB = tempDir();
    writeFileSync(join(dirA, 'index.html'), '<p>a</p>');
    writeFileSync(join(dirB, 'index.html'), '<p>b</p>');
    server = await serveStatic('', { mounts: true });

    server.mount('a', dirA);
    server.mount('demo/m1', dirB);

    expect(await get(server, '/a/index.html')).toMatchObject({ status: 200, body: '<p>a</p>' });
    expect(await get(server, '/a/')).toMatchObject({ status: 200, body: '<p>a</p>' });
    expect(await get(server, '/demo/m1/index.html')).toMatchObject({ status: 200, body: '<p>b</p>' });
    expect((await get(server, '/ab/index.html')).status).toBe(404);
    expect((await get(server, '/')).status).toBe(404);

    server.unmount('a');
    expect((await get(server, '/a/index.html')).status).toBe(404);
    expect((await get(server, '/demo/m1/index.html')).status).toBe(200);
  });

  it('keeps each mount inside its own root', async () => {
    const base = tempDir();
    mkdirSync(join(base, 'a'));
    writeFileSync(join(base, 'a', 'index.html'), '<p>a</p>');
    writeFileSync(join(base, 'secret.txt'), 'secret');
    server = await serveStatic('', { mounts: true });
    server.mount('a', join(base, 'a'));

    expect((await get(server, '/a/../secret.txt')).status).toBe(404);
    expect((await get(server, '/a/%2e%2e/secret.txt')).status).toBe(404);
  });
});
