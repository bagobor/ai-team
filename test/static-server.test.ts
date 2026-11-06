import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { serveStatic, type StaticServer } from '../src/checks/static-server.ts';
import { tempDir } from './helpers/repo.ts';

// A swap that lands between the server's realpath and its open can't be timed from a test, so a test stands in for the
// realpath that ran before it: given a path, it says what that realpath saw, or undefined to ask the real one.
const resolved = vi.hoisted(() => ({ as: undefined as ((path: string) => string | undefined) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: async (path: string, options?: never) => resolved.as?.(String(path)) ?? actual.realpath(path, options) };
});

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// fetch() normalizes `..` and `%2e%2e` away before sending, so traversal has to go out as written.
// `host` replaces the Host header, and null sends none.
function get(server: StaticServer, path: string, host?: string | null): Promise<Reply> {
  const headers = typeof host === 'string' ? { host } : {};
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port: server.port, path, method: 'GET', headers, setHost: host !== null };
    const req = request(options, (res) => {
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
    resolved.as = undefined;
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

  // A process the sandbox can't stop can still write the checkout, and swap the root for a link while the server runs.
  it('refuses its root once it has been swapped for a link', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
    writeFileSync(join(outside, 'index.html'), 'outside-index');
    renameSync(site, join(base, 'moved'));
    symlinkSync(outside, site);

    const replies = [await get(server, '/secret.txt'), await get(server, '/'), await get(server, '/index.html')];
    expect(replies.map(({ status }) => status)).toEqual([404, 404, 404]);
    for (const { body } of replies) expect(body).not.toMatch(/outside-/);
  });

  // A process can swap a directory and a link back and forth, so realpath may see the directory and the open the link.
  it('refuses a path whose component turns into a link after it was resolved', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
    const asked = [join(site, 'sub', 'secret.txt'), join(site, 'secret.txt')];
    resolved.as = (path) => (asked.includes(path) ? path : undefined);

    renameSync(join(site, 'sub'), join(base, 'sub-moved'));
    symlinkSync(outside, join(site, 'sub'));
    const inside = await get(server, '/sub/secret.txt');
    renameSync(site, join(base, 'moved'));
    symlinkSync(outside, site);
    const root = await get(server, '/secret.txt');

    expect([inside.status, root.status]).toEqual([404, 404]);
    expect(inside.body + root.body).not.toMatch(/outside-/);
  });

  // The open that keeps a request inside its root refuses a link in any component, and only macOS has it.
  it('refuses to start anywhere but macOS', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      await expect(serveStatic(site)).rejects.toThrow(/macOS/);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  // A caller that checked the root before starting the server compares this with what it checked.
  it('says which directory it serves from', async () => {
    symlinkSync(site, join(base, 'link'));
    const linked = await serveStatic(join(base, 'link'));
    try {
      expect(linked.root).toBe(site);
      expect(server.root).toBe(site);
    } finally {
      await linked.close();
    }
  });

  // Opening first would wait for a writer that never comes, and hold a thread for ever.
  it('answers 404 for a pipe without waiting on it', async () => {
    execFileSync('mkfifo', [join(site, 'pipe.html')]);
    expect((await get(server, '/pipe.html')).status).toBe(404);
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

  it('answers only a request addressed to it on this machine', async () => {
    expect((await get(server, '/index.html', `evil.example:${server.port}`)).status).toBe(403);
    expect((await get(server, '/index.html', '127.0.0.1')).status).toBe(403);
    expect((await get(server, '/index.html', null)).status).toBe(403);

    expect((await get(server, '/index.html', `127.0.0.1:${server.port}`)).status).toBe(200);
    expect((await get(server, '/index.html', `localhost:${server.port}`)).status).toBe(200);
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

  it('refuses a mount whose root has been swapped for a link', async () => {
    const base = tempDir();
    const dir = join(base, 'a');
    const outside = join(base, 'outside');
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(dir, 'index.html'), '<p>a</p>');
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
    server = await serveStatic('', { mounts: true });
    server.mount('a', dir);
    expect(await get(server, '/a/index.html')).toMatchObject({ status: 200, body: '<p>a</p>' });

    renameSync(dir, join(base, 'moved'));
    symlinkSync(outside, dir);

    const reply = await get(server, '/a/secret.txt');
    expect(reply.status).toBe(404);
    expect(reply.body).not.toMatch(/outside-/);
  });
});
