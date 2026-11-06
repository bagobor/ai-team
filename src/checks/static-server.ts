import { constants, realpathSync } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream';

export type StaticServer = {
  url: string;
  port: number;
  // The path every request is held to, resolved once at start. Empty with mounts, which each have their own.
  root: string;
  mount(prefix: string, root: string): void;
  unmount(prefix: string): void;
  close(): Promise<void>;
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  // Browsers compile wasm while streaming it only when it comes with its own type.
  '.wasm': 'application/wasm',
};

function trimSlashes(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, '');
}

type Opened = { handle: FileHandle; size: number; file: string };

// macOS's flag to refuse a link in any component of the path, not only the last; Node passes it through without naming it.
// It turns a component swapped for a link after the realpath below into a failed open, never a file outside the root.
const O_NOFOLLOW_ANY = 0x20000000;

// Resolves first, and opens only a path that lies inside `base`, so nothing outside the root is ever opened.
// `base` is resolved once, by the caller. A root, or a directory in it, swapped for a link after that is refused, not followed.
async function openInside(base: string, target: string, index = true): Promise<Opened | undefined> {
  let handle: FileHandle | undefined;
  try {
    const real = await realpath(target);
    if (real !== base && !real.startsWith(base + sep)) return undefined;
    // A pipe would hold the open until something wrote to it; non-blocking makes it just another non-file.
    handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
    const opened = await handle.stat();
    if (opened.isDirectory() && index) {
      await shut(handle);
      return await openInside(base, join(real, 'index.html'), false);
    }
    if (!opened.isFile()) return await shut(handle);
    return { handle, size: opened.size, file: real };
  } catch {
    // Missing, unreadable, a broken link or a link swapped in: all the same to a browser.
    if (handle) await shut(handle);
    return undefined;
  }
}

async function shut(handle: FileHandle): Promise<undefined> {
  await handle.close().catch(() => {});
  return undefined;
}

function answer(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(`${text}\n`);
}

// Serves one directory, or with `mounts` several under their own prefixes, to the play browser and the stakeholder on this machine.
export async function serveStatic(root: string, opts: { port?: number; mounts?: boolean } = {}): Promise<StaticServer> {
  if (process.platform !== 'darwin') throw new Error('serveStatic needs macOS: it keeps each request inside its root with O_NOFOLLOW_ANY, which only macOS has');
  // Each root is resolved once, here or at mount(), and every request is held to that path. A process the sandbox can't
  // stop may swap a root for a link while the server runs; from then on the server answers 404 rather than follow it.
  const base = opts.mounts ? '' : await realpath(root);
  const mounts = new Map<string, string>();
  // Filled in once the port is known, which is before the first request can arrive.
  let hosts: string[] = [];

  // The longest prefix wins, so a mount can sit under another one's path.
  function rootFor(path: string): { root: string; rest: string } | undefined {
    if (!opts.mounts) return { root: base, rest: path };
    const prefix = [...mounts.keys()].sort((a, b) => b.length - a.length).find((p) => path === `/${p}` || path.startsWith(`/${p}/`));
    return prefix === undefined ? undefined : { root: mounts.get(prefix)!, rest: path.slice(prefix.length + 1) || '/' };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A page on any other site can rebind its own name to 127.0.0.1, but it can't make the browser send this Host.
    const host = req.headers.host;
    if (host === undefined || !hosts.includes(host)) return answer(res, 403, 'This Host is not allowed');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return answer(res, 405, 'Method not allowed');
    }
    const raw = req.url ?? '';
    if (!raw.startsWith('/')) return answer(res, 400, 'Bad request');
    let path: string;
    try {
      path = decodeURIComponent(raw.replace(/[?#].*$/s, ''));
    } catch {
      return answer(res, 400, 'Bad request');
    }
    // The filesystem calls throw on a NUL byte rather than failing to find the file.
    if (path.includes('\0')) return answer(res, 400, 'Bad request');

    const target = rootFor(path);
    const found = target && (await openInside(target.root, join(target.root, target.rest)));
    if (!found) return answer(res, 404, 'Not found');

    res.writeHead(200, {
      'Content-Type': TYPES[extname(found.file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': found.size,
      // A rebuilt game must reach the browser as built, never from a cache of the last round.
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      await shut(found.handle);
      return;
    }
    // The body comes from the descriptor that was checked, never from the name again.
    // pipeline() closes the descriptor however the response ends, a browser hanging up halfway included.
    pipeline(found.handle.createReadStream(), res, () => {});
  }

  // Node would answer a request with no Host 400 itself; refusing it here keeps every Host refusal the same 403.
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else answer(res, 500, 'Internal error');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Only this machine may load what an agent built.
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as AddressInfo).port;
      hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        root: base,
        mount(prefix, dir) {
          if (!opts.mounts) throw new Error('This server was started without mounts');
          const key = trimSlashes(prefix);
          if (key === '') throw new Error('A mount needs a prefix');
          mounts.set(key, realpathSync(dir));
        },
        unmount(prefix) {
          mounts.delete(trimSlashes(prefix));
        },
        close() {
          return new Promise((done) => {
            server.close(() => done());
            // A browser's keep-alive connections would otherwise hold the close open.
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
