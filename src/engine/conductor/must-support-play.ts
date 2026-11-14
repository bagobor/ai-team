import type { Player, PlayProblem, SmokeOptions } from '../../checks/play.ts';
import type { PlayBlock } from '../apply/discovery.ts';
import { playRuns, VIEWPORT_LABEL, VIEWPORTS, type ItemStatus, type MsItem, type PlayRun, type Viewport } from '../must-support.ts';
import { browserWhy, problemLine, servePage } from './play-gate.ts';

export type RunProblems = { viewport: Viewport; problems: PlayProblem[] };
// `game` holds the runs in which the game itself didn't run, whatever the list asks of it.
export type PlayedItems = { kind: 'played'; statuses: ItemStatus[]; game: RunProblems[] } | { kind: 'unavailable'; why: string };

// A touch or fits problem is about one item of the list. Every other problem is about the game.
const isGameProblem = ({ kind }: PlayProblem) => kind !== 'touch' && kind !== 'fits';

function itemStatuses(run: PlayRun, problems: PlayProblem[]): ItemStatus[] {
  const label = VIEWPORT_LABEL[run.viewport];
  const { width, height } = VIEWPORTS[run.viewport];
  const game = problems.filter(isGameProblem);
  const details = (kind: PlayProblem['kind']) => problems.filter((problem) => problem.kind === kind).map(({ detail }) => detail);
  return run.items.map((item): ItemStatus => {
    const failed = game.length > 0 ? game.map(problemLine) : [...(item.input === 'touch' ? details('touch') : []), ...(item.fits_screen ? details('fits') : [])];
    if (failed.length > 0) return { item_id: item.id, status: 'failing', evidence: `${label}: ${failed.join('; ')}` };
    return { item_id: item.id, status: 'met', evidence: `Played in a ${label} at ${width}×${height}` };
  });
}

// Plays a built site once for each viewport the list's play items name, and says what each of those items came to.
// A touch run presses no keys, so a game played only by touch isn't failed for ignoring a keyboard a phone doesn't have.
export async function playMustSupport(player: Player, root: string, play: PlayBlock, items: MsItem[]): Promise<PlayedItems> {
  const statuses: ItemStatus[] = [];
  const game: RunProblems[] = [];
  for (const run of playRuns(items)) {
    const keys = run.touch ? [] : play.keys;
    // The run with no items is the smoke a list without play items gets: Chrome's own window, as before the list.
    const opts: SmokeOptions = { animated: play.animated, touch: run.touch, fitsScreen: run.fitsScreen, ...(run.items.length > 0 ? { viewport: VIEWPORTS[run.viewport] } : {}) };
    const served = await servePage(root, play, (page) => player.smoke(page, keys, opts));
    const found: PlayProblem[] = served.ok ? served.value.problems : [{ kind: 'load', detail: served.why }];
    // A run that failed and named nothing would otherwise read as every item met.
    const problems: PlayProblem[] = served.ok && !served.value.ok && found.length === 0 ? [{ kind: 'load', detail: 'The play run failed and named no problem' }] : found;

    // A problem from the browser itself says nothing about the game or the list.
    const browser = problems.filter(({ kind }) => kind === 'browser');
    if (browser.length > 0) return { kind: 'unavailable', why: browserWhy(browser.map(({ detail }) => detail).join('\n')) };

    const broken = problems.filter(isGameProblem);
    if (broken.length > 0) game.push({ viewport: run.viewport, problems: broken });
    statuses.push(...itemStatuses(run, problems));
  }
  return { kind: 'played', statuses, game };
}
