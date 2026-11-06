import { serveStatic, type StaticServer } from '../checks/static-server.ts';

// Project names are letters, digits, - and _ (SAFE_ID), so a prefix needs no escaping as a path or in a URL.
const prefixOf = (project: string, n: number) => `${project}/m${n}`;

// Serves each milestone's build under its project and milestone, so the stakeholder can play it in their own browser at CP4.
// The daemon runs one beside the API, on the port after it: a page it serves is another origin, which the API refuses.
export class TryServer {
  readonly url: string;
  // Only in memory, as the server's own mounts are. A restart starts empty, and CP4's step mounts again.
  private readonly mounts = new Set<string>();

  private constructor(private readonly server: StaticServer) {
    this.url = server.url;
  }

  static async start(port: number): Promise<TryServer> {
    return new TryServer(await serveStatic('', { port, mounts: true }));
  }

  // `root` is a resolved directory that a check has passed, as buildSite returns it. Returns the URL it is served at.
  // Throws, serving nothing under the prefix, for a root that is gone or that the server resolves somewhere else.
  mount(project: string, n: number, root: string): string {
    const prefix = prefixOf(project, n);
    // A failed mount must not leave the build before it served.
    this.unmount(project, n);
    // Something the build left running may have swapped the root for a link once the check had passed.
    if (this.server.mount(prefix, root) !== root) {
      this.server.unmount(prefix);
      throw new Error(`${root} changed while the engine began serving it`);
    }
    this.mounts.add(prefix);
    return `${this.url}${prefix}/`;
  }

  mounted(project: string, n: number): boolean {
    return this.mounts.has(prefixOf(project, n));
  }

  unmount(project: string, n: number): void {
    const prefix = prefixOf(project, n);
    this.server.unmount(prefix);
    this.mounts.delete(prefix);
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
