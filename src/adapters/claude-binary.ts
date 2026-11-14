import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, sep } from 'node:path';

// The binary to run, and the configured path it stands in for when that one is gone.
export type ClaudeBinary = { binary: string; replaces?: string };

const VERSION = /^\d+(\.\d+)+$/;

function runs(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const newestFirst = (a: string, b: string): number => b.localeCompare(a, undefined, { numeric: true });

// The desktop app and Homebrew keep each version in a folder of its own and remove the old one on update, so the path
// to look for is the configured one with another version in it. The desktop app also puts a build id between the
// version and the binary, and that changes with the version too.
function newestBeside(configured: string): string | undefined {
  const parts = configured.split(sep);
  const at = parts.findLastIndex((part) => VERSION.test(part));
  const [first, ...rest] = at < 0 ? [] : parts.slice(at + 1);
  if (first === undefined) return undefined;
  const root = parts.slice(0, at).join(sep);
  for (const version of namesIn(root).filter((name) => VERSION.test(name)).sort(newestFirst)) {
    const home = join(root, version);
    const builds = rest.length > 0 ? namesIn(home).map((build) => join(home, build, ...rest)) : [];
    const found = [join(home, first, ...rest), ...builds].find(runs);
    if (found !== undefined) return found;
  }
  return undefined;
}

function onPath(env: NodeJS.ProcessEnv): string | undefined {
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((dir) => join(dir, 'claude'))
    .find(runs);
}

// The path config.yaml names is the one used while it can be run. Once it is gone, the engine looks for the same
// install at another version, then for `claude` on PATH. With nothing found it keeps the configured path, so the
// failure that follows names the path a person has to fix.
export function findClaudeBinary(configured: string, env: NodeJS.ProcessEnv = process.env): ClaudeBinary {
  // A bare name is looked up on PATH when it is run, and there is nowhere else to look for it.
  if (!configured.includes(sep) || runs(configured)) return { binary: configured };
  const found = newestBeside(configured) ?? onPath(env);
  return found === undefined ? { binary: configured } : { binary: found, replaces: configured };
}
