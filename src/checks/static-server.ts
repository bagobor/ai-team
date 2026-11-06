import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';

export type StaticServer = {
  url: string;
  port: number;
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

// Resolves symlinks first, so a link inside the root can't hand out a file from outside it.
async function locate(root: string, path: string): Promise<{ file: string; size: number } | undefined> {
  try {
    const base = await realpath(root);
    const inside = (p: string) => p === base || p.startsWith(base + sep);
    let file = await realpath(join(base, path));
    if (!inside(file)) return undefined;
    let info = await stat(file);
    if (info.isDirectory()) {
      file = await realpath(join(file, 'index.html'));
      if (!inside(file)) return undefined;
      info = await stat(file);
    }
    return info.isFile() ? { file, size: info.size } : undefined;
  } catch {
    // Missing, unreadable or a broken link: all the same to a browser.
    return undefined;
  }
}

function answer(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(`${text}\n`);
}

// Serves one directory, or with `mounts` several under their own prefixes, to the play browser and the stakeholder on this machine.
export function serveStatic(root: string, opts: { port?: number; mounts?: boolean } = {}): Promise<StaticServer> {
  const mounts = new Map<string, string>();
  // Filled in once the port is known, which is before the first request can arrive.
  let hosts: string[] = [];

  // The longest prefix wins, so a mount can sit under another one's path.
  function rootFor(path: string): { root: string; rest: string } | undefined {
    if (!opts.mounts) return { root, rest: path };
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
    const found = target && (await locate(target.root, target.rest));
    if (!found) return answer(res, 404, 'Not found');

    res.writeHead(200, {
      'Content-Type': TYPES[extname(found.file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': found.size,
      // A rebuilt game must reach the browser as built, never from a cache of the last round.
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(found.file)
      .on('error', () => res.destroy())
      .pipe(res);
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
        mount(prefix, dir) {
          if (!opts.mounts) throw new Error('This server was started without mounts');
          const key = trimSlashes(prefix);
          if (key === '') throw new Error('A mount needs a prefix');
          mounts.set(key, dir);
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
