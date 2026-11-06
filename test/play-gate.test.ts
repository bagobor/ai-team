import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileData } from '../src/engine/apply/discovery.ts';
import { buildSite } from '../src/engine/conductor/play-gate.ts';
import { tempDir } from './helpers/repo.ts';

// The build is the product's own code, so each of these is something a build can leave behind.
describe('buildSite', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = join(tempDir(), 'checkout');
    mkdirSync(worktree);
  });

  const profile = (build: string, root = 'dist'): ProfileData => ({
    commands: { build, test: 'true', lint: 'true', smoke: 'true' },
    toolchains: [],
    network_allow: [],
    setup: null,
    play: { root, entry: 'index.html', keys: ['Space'] },
  });
  const built = (build: string, root?: string) => buildSite({ worktree, denyRead: [], timeoutS: 30 }, profile(build, root), { setup: false });

  it('serves the directory the root leads to, not the link the build left', async () => {
    expect(await built('mkdir out && ln -s out dist')).toEqual({ ok: true, root: join(worktree, 'out') });
  });

  it('refuses a root the build turns into a link out of the checkout', async () => {
    const outside = join(worktree, '..', 'outside');
    mkdirSync(outside);
    expect(await built(`ln -s ${outside} dist`)).toEqual({ ok: false, why: 'play.root dist leads outside the checkout' });
  });

  it('refuses a root that is not a directory', async () => {
    expect(await built('echo game > dist')).toEqual({ ok: false, why: 'play.root dist is not a directory after the build' });
  });

  it('refuses a root the build never made', async () => {
    expect(await built('true')).toEqual({ ok: false, why: 'play.root dist does not exist after the build' });
  });
});
