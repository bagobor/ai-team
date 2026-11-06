import { constants, realpathSync } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream';

export type StaticServer = {
  url: string;
  port: number;
  // The directory every request is held to, resolved once at start. Empty with mounts, which each have their own.
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

// Opens first and checks after, so a link swapped in between the check and the read can't hand out a file from outside `base`.
// `base` is resolved once, by the caller, so a root swapped for a link while the server runs doesn't move it.
async function openInside(base: string, target: string, index = true): Promise<Opened | undefined> {
  let handle: FileHandle | undefined;
  try {
    // A pipe would hold the open until something wrote to it; non-blocking makes it just another non-file.
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const opened = await handle.stat();
    const real = await realpath(target);
    // The name leads to what was opened only if both are the same inode, and only then does `real` say where it lives.
    const named = await stat(real);
    const same = named.dev === opened.dev && named.ino === opened.ino;
    if (!same || (real !== base && !real.startsWith(base + sep))) return await shut(handle);
    if (opened.isDirectory() && index) {
      await shut(handle);
      return await openInside(base, join(real, 'index.html'), false);
    }
    if (!opened.isFile()) return await shut(handle);
    return { handle, size: opened.size, file: real };
  } catch {
    // Missing, unreadable or a broken link: all the same to a browser.
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
  // Each root is resolved once, here or at mount(), and every request is held to that fixed path.
  // A process the sandbox can't stop may swap a root for a link while the server runs; the server keeps serving where it started.
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
