import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findClaudeBinary } from '../../src/adapters/claude-binary.ts';
import { tempDir } from '../helpers/repo.ts';

describe('findClaudeBinary', () => {
  let root: string;

  beforeEach(() => {
    root = tempDir('aiteam-claude-binary-');
  });

  function file(mode: number, ...parts: string[]): string {
    const path = join(root, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, mode);
    return path;
  }
  const install = (...parts: string[]) => file(0o755, ...parts);
  // The desktop app's layout: a build id sits between the version and the binary, and changes with the version.
  const app = (version: string, build: string) => ['app', version, build, 'claude.app', 'Contents', 'MacOS', 'claude'];
  const NO_PATH = { PATH: '' };

  it('uses the path config.yaml names while it can be run, whatever sits beside it', () => {
    const configured = install(...app('2.1.309', 'aaa'));
    install(...app('2.1.325', 'bbb'));

    expect(findClaudeBinary(configured, { PATH: dirname(install('bin', 'claude')) })).toEqual({ binary: configured });
  });

  it('takes the newest version beside a path whose own version is gone, ahead of claude on PATH', () => {
    install(...app('2.1.4', 'ccc'));
    install(...app('2.1.99', 'ddd'));
    const newest = install(...app('2.1.325', 'bbb'));
    const configured = join(root, ...app('2.1.309', 'aaa'));

    expect(findClaudeBinary(configured, { PATH: dirname(install('bin', 'claude')) })).toEqual({ binary: newest, replaces: configured });
  });

  it('finds the next version of an install that keeps the binary right under the version', () => {
    const next = install('cask', '2.1.320', 'claude');

    expect(findClaudeBinary(join(root, 'cask', '2.1.311', 'claude'), NO_PATH).binary).toBe(next);
  });

  it('passes over a newer version that has nothing to run', () => {
    file(0o644, ...app('2.1.400', 'eee'));
    mkdirSync(join(root, 'app', '2.1.500'));
    const runnable = install(...app('2.1.325', 'bbb'));

    expect(findClaudeBinary(join(root, ...app('2.1.309', 'aaa')), NO_PATH).binary).toBe(runnable);
  });

  it('falls back to claude on PATH when no other version is beside it', () => {
    const onPath = install('bin', 'claude');
    const configured = join(root, ...app('2.1.309', 'aaa'));

    expect(findClaudeBinary(configured, { PATH: [join(root, 'empty'), dirname(onPath)].join(':') })).toEqual({ binary: onPath, replaces: configured });
    expect(findClaudeBinary(join(root, 'gone', 'claude'), { PATH: dirname(onPath) }).binary).toBe(onPath);
  });

  it('keeps the configured path when there is nothing to find, so the failure names it', () => {
    const configured = join(root, ...app('2.1.309', 'aaa'));

    expect(findClaudeBinary(configured, NO_PATH)).toEqual({ binary: configured });
  });

  it('leaves a bare command name to PATH', () => {
    expect(findClaudeBinary('claude', { PATH: dirname(install('bin', 'claude')) })).toEqual({ binary: 'claude' });
    expect(findClaudeBinary('claude', NO_PATH)).toEqual({ binary: 'claude' });
  });
});
