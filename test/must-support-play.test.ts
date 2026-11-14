import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayBlock } from '../src/engine/apply/discovery.ts';
import { playMustSupport } from '../src/engine/conductor/must-support-play.ts';
import type { MsItem } from '../src/engine/must-support.ts';
import { fakePlayer, playResult } from './helpers/play.ts';
import { tempDir } from './helpers/repo.ts';

const played = (id: string, text: string, rest: Pick<MsItem, 'viewport' | 'input' | 'fits_screen'>): MsItem => ({ id, group: 'runs_on', text, brief_quote: 'On phones and tablets', check: 'play', ...rest });
const phoneTouch = played('MS-1', 'Plays in a phone browser held upright', { viewport: 'phone_portrait', input: 'touch', fits_screen: false });
const phoneFitsKeys = played('MS-2', 'Fits a phone screen', { viewport: 'phone_portrait', input: 'keys', fits_screen: true });
const tabletMouse = played('MS-3', 'Plays in a tablet browser', { viewport: 'tablet', input: 'mouse', fits_screen: false });
const cmd: MsItem = { id: 'MS-4', group: 'built_with', text: 'Has no build step', brief_quote: 'No build step', check: 'command' };

const TOUCH = { kind: 'touch' as const, detail: 'Nothing on the page answered a tap, a drag or a hold' };
const FITS = { kind: 'fits' as const, detail: 'The page is 2000px tall on a 844px-tall screen after load, so part of it is off screen' };
const PHONE = 'Phone browser, held upright';
const MET_ON_PHONE = `Played in a ${PHONE} at 390×844`;

describe('playMustSupport', () => {
  const play: PlayBlock = { root: '.', entry: 'index.html', keys: ['ArrowLeft'], animated: false };
  let root: string;

  beforeEach(() => {
    root = tempDir();
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>game</title>');
  });

  it('plays once on the desktop, as before, when no item is played', async () => {
    const player = fakePlayer(playResult());

    const result = await playMustSupport(player, root, play, [cmd]);

    expect(player.calls).toHaveLength(1);
    expect(player.calls[0]).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/), keys: ['ArrowLeft'] });
    expect(player.calls[0]!.opts).toEqual({ animated: false, touch: false, fitsScreen: false });
    expect(result).toEqual({ kind: 'played', statuses: [], game: [] });
  });

  it("plays once per viewport with that viewport's size and touch", async () => {
    const player = fakePlayer(playResult());

    const result = await playMustSupport(player, root, play, [phoneTouch, tabletMouse]);

    expect(player.calls.map((call) => [call.keys, call.opts!.viewport, call.opts!.touch])).toEqual([
      [[], { width: 390, height: 844, mobile: true, touch: true }, true],
      [['ArrowLeft'], { width: 820, height: 1180, mobile: false, touch: true }, false],
    ]);
    expect(result).toEqual({
      kind: 'played',
      statuses: [
        { item_id: 'MS-1', status: 'met', evidence: MET_ON_PHONE },
        { item_id: 'MS-3', status: 'met', evidence: 'Played in a Tablet browser at 820×1180' },
      ],
      game: [],
    });
  });

  it('a touch problem fails only the items played by touch', async () => {
    const result = await playMustSupport(fakePlayer(playResult([TOUCH])), root, play, [phoneTouch, phoneFitsKeys]);

    expect(result).toEqual({
      kind: 'played',
      statuses: [
        { item_id: 'MS-1', status: 'failing', evidence: `${PHONE}: ${TOUCH.detail}` },
        { item_id: 'MS-2', status: 'met', evidence: MET_ON_PHONE },
      ],
      game: [],
    });
  });

  it('a fits problem fails only the items that must fit', async () => {
    const result = await playMustSupport(fakePlayer(playResult([FITS])), root, play, [phoneTouch, phoneFitsKeys]);

    expect(result).toEqual({
      kind: 'played',
      statuses: [
        { item_id: 'MS-1', status: 'met', evidence: MET_ON_PHONE },
        { item_id: 'MS-2', status: 'failing', evidence: `${PHONE}: ${FITS.detail}` },
      ],
      game: [],
    });
  });

  it('a game that does not load fails every played item in that run, and no other run', async () => {
    const boom = [{ kind: 'exception' as const, detail: 'boom at game.js:3\n  at start' }, TOUCH];

    const result = await playMustSupport(fakePlayer([playResult(boom), playResult()]), root, play, [phoneTouch, phoneFitsKeys, tabletMouse]);

    const evidence = `${PHONE}: exception: boom at game.js:3`;
    expect(result).toEqual({
      kind: 'played',
      statuses: [
        { item_id: 'MS-1', status: 'failing', evidence },
        { item_id: 'MS-2', status: 'failing', evidence },
        { item_id: 'MS-3', status: 'met', evidence: 'Played in a Tablet browser at 820×1180' },
      ],
      game: [{ viewport: 'phone_portrait', problems: [boom[0]] }],
    });
  });

  it('a run that failed without naming a problem counts against the game', async () => {
    const result = await playMustSupport(fakePlayer({ ...playResult(), ok: false }), root, play, [cmd]);

    expect(result).toEqual({ kind: 'played', statuses: [], game: [{ viewport: 'desktop', problems: [{ kind: 'load', detail: 'The play run failed and named no problem' }] }] });
  });

  it('a root that is gone counts against the game', async () => {
    rmSync(root, { recursive: true });
    const player = fakePlayer(playResult());

    const result = await playMustSupport(player, root, play, [phoneTouch]);

    expect(player.calls).toEqual([]);
    expect(result).toEqual({
      kind: 'played',
      statuses: [{ item_id: 'MS-1', status: 'failing', evidence: `${PHONE}: load: play.root . does not exist after the build` }],
      game: [{ viewport: 'phone_portrait', problems: [{ kind: 'load', detail: 'play.root . does not exist after the build' }] }],
    });
  });

  it("the browser's own failure makes the result unavailable, with nothing more played", async () => {
    const player = fakePlayer(playResult([{ kind: 'browser', detail: 'Chrome at /x exited before DevTools opened' }]));

    const result = await playMustSupport(player, root, play, [phoneTouch, tabletMouse]);

    expect(player.calls).toHaveLength(1);
    expect(result).toEqual({ kind: 'unavailable', why: 'Chrome at /x exited before DevTools opened\nThe engine plays the game in the Chrome that chrome.binary in ~/.aiteam/config.yaml names.' });
  });
});
