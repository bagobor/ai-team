import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitArtifact, commitFiles, initStateRepo } from '../src/git/state-repo.ts';
import { revParse, run, tempDir } from './helpers/repo.ts';

describe('project state repo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tempDir(), 'projects', 'p', 'state');
    await initStateRepo(dir);
  });

  it('init is safe to repeat', async () => {
    const head = await revParse(dir);
    await initStateRepo(dir);
    expect(await revParse(dir)).toBe(head);
  });

  it('commitArtifact returns the HEAD sha', async () => {
    const { sha } = await commitArtifact(dir, 'artifacts/tickets/T-1.md', '# T-1\n', 'ticket T-1');

    expect(sha).toBe(await revParse(dir));
    expect(readFileSync(join(dir, 'artifacts/tickets/T-1.md'), 'utf8')).toBe('# T-1\n');
    expect(run(dir, 'log', '-1', '--format=%s %an')).toBe('ticket T-1 aiteam');
  });

  it('identical content is not an error and returns HEAD', async () => {
    const first = await commitArtifact(dir, 'a.md', 'same\n', 'first');
    const count = run(dir, 'rev-list', '--count', 'HEAD');

    const second = await commitArtifact(dir, 'a.md', 'same\n', 'second');

    expect(second.sha).toBe(first.sha);
    expect(run(dir, 'rev-list', '--count', 'HEAD')).toBe(count);
  });

  it('keeps one history when two artifacts are committed at once', async () => {
    const count = Number(run(dir, 'rev-list', '--count', 'HEAD'));

    const results = await Promise.all([
      commitArtifact(dir, 'a.md', 'a\n', 'a'),
      commitArtifact(dir, 'b.md', 'b\n', 'b'),
      commitArtifact(dir, 'c.md', 'c\n', 'c'),
    ]);

    expect(new Set(results.map((r) => r.sha)).size).toBe(3);
    expect(Number(run(dir, 'rev-list', '--count', 'HEAD'))).toBe(count + 3);
  });

  it('refuses a path outside the repo and writes nothing', async () => {
    await expect(commitArtifact(dir, '../outside.md', 'x', 'escape')).rejects.toThrow(/not a safe artifact path/);
    await expect(commitArtifact(dir, '/tmp/absolute.md', 'x', 'escape')).rejects.toThrow(/not a safe artifact path/);
    expect(existsSync(join(dir, '..', 'outside.md'))).toBe(false);
  });

  it.each(['.git/hooks/post-commit', '.GIT/config', 'a/.git/x', 'git~1/config', '.git‌/config', 'a./b', 'a /b', 'a*[b].md'])(
    'refuses the risky path %s and writes nothing',
    async (path) => {
      const head = await revParse(dir);
      await expect(commitArtifact(dir, path, 'PLANTED', 'escape')).rejects.toThrow(/not a safe artifact path/);
      // On a case-insensitive disk .GIT/config is the real .git/config, so it exists; it must be unchanged.
      const target = join(dir, path);
      expect(existsSync(target) ? readFileSync(target, 'utf8') : '').not.toContain('PLANTED');
      expect(await revParse(dir)).toBe(head);
    },
  );

  it('accepts ordinary artifact paths with ids, dots and dashes', async () => {
    const { sha } = await commitArtifact(dir, 'artifacts/ticket/T-1_a.v2.md', 'x\n', 'ordinary');
    expect(sha).toBe(await revParse(dir));
  });
});

describe('commitFiles', () => {
  const stateDir = async () => {
    const dir = join(tempDir(), 'projects', 'p', 'state');
    await initStateRepo(dir);
    return dir;
  };

  it('writes several files in one commit', async () => {
    const dir = await stateDir();
    const before = Number(run(dir, 'rev-list', '--count', 'HEAD'));

    const { sha } = await commitFiles(
      dir,
      [
        { path: 'artifacts/brief/BRIEF.md', content: 'brief' },
        { path: 'artifacts/roadmap/ROADMAP.md', content: 'roadmap' },
      ],
      'plan',
    );

    expect(sha).toBe(run(dir, 'rev-parse', 'HEAD'));
    expect(Number(run(dir, 'rev-list', '--count', 'HEAD'))).toBe(before + 1);
    expect(run(dir, 'show', `${sha}:artifacts/brief/BRIEF.md`)).toBe('brief');
    expect(run(dir, 'show', `${sha}:artifacts/roadmap/ROADMAP.md`)).toBe('roadmap');
  });

  it('returns the current head when nothing changed, so a retry after a crash can record it', async () => {
    const dir = await stateDir();
    const files = [{ path: 'artifacts/brief/BRIEF.md', content: 'brief' }];
    const first = await commitFiles(dir, files, 'one');

    const second = await commitFiles(dir, files, 'two');

    expect(second.sha).toBe(first.sha);
    expect(run(dir, 'log', '-1', '--format=%s')).toBe('one');
  });

  it.each(['../escape.md', 'artifacts/../../escape.md', '.git/config', 'artifacts/.GIT/x'])('refuses the unsafe path %s and writes nothing', async (path) => {
    const dir = await stateDir();

    await expect(commitFiles(dir, [{ path: 'artifacts/ok.md', content: 'ok' }, { path, content: 'x' }], 'bad')).rejects.toThrow('not a safe artifact path');

    expect(existsSync(join(dir, 'artifacts/ok.md'))).toBe(false);
  });
});
