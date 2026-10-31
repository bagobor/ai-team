import { resolvePaths, workerDenyRead } from '../src/paths.ts';

describe('workerDenyRead', () => {
  const paths = resolvePaths({ AITEAM_HOME: '/data/aiteam' });
  const denied = workerDenyRead(paths, '/Users/me');

  it('covers the agent login and this app’s own state', () => {
    expect(denied).toEqual(expect.arrayContaining([
      paths.claudeHome,
      paths.db,
      `${paths.db}-wal`,
      `${paths.db}-shm`,
      paths.config,
      paths.knowledge,
      paths.projects,
      paths.transcripts,
    ]));
  });

  it('covers the logins and keys in the home folder', () => {
    expect(denied).toEqual(expect.arrayContaining([
      '/Users/me/.ssh',
      '/Users/me/.aws',
      '/Users/me/.claude',
      '/Users/me/Library/Keychains',
    ]));
  });

  it('leaves worktrees readable, because the worker runs in one', () => {
    expect(denied.some((path) => paths.worktrees.startsWith(path) || path.startsWith(paths.worktrees))).toBe(false);
    expect(denied).not.toContain(paths.root);
  });
});
