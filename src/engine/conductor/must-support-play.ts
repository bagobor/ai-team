import type { Player, PlayProblem, SmokeOptions } from '../../checks/play.ts';
import type { PlayBlock } from '../apply/discovery.ts';
import { protoPlanId, protoRoot } from '../apply/ids.ts';
import { itemLine, playRuns, VIEWPORT_LABEL, VIEWPORTS, type ItemStatus, type MsItem, type MsStatus, type PlayRun, type Viewport } from '../must-support.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow, Store } from '../store.ts';
import { browserWhy, NO_BROWSER, problemLine, servePage, siteRoot } from './play-gate.ts';
import { mustSupportItems } from './tasks.ts';

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

const PROTO_TICKET = /^PROTO-([1-9]\d*)-P-([1-9]\d*)$/;

// What the stakeholder accepted going without: in this prototype round, or for good.
export async function waivedInRound(store: Store, project: ProjectRow, r: number): Promise<string[]> {
  const rows = [...(await store.listMustSupport(project.id, { scope: 'prototype', n: r, subject: '' })), ...(await store.listMustSupport(project.id, { scope: 'project', n: 0 }))];
  return rows.filter(({ status }) => status === 'waived').map(({ item_id }) => item_id);
}

// A prototype that passed its own checks is played in each browser the list names before its ticket is done. Only a
// play item that fails sends it back: with nothing to play it in, the items are recorded as not measured and the
// stakeholder is told at the evaluation.
export async function checkPrototype(deps: EngineDeps, project: ProjectRow, ticketId: string, worktree: string): Promise<{ ok: true } | { ok: false; evidence: string }> {
  const match = PROTO_TICKET.exec(ticketId);
  const list = match && (await mustSupportItems(deps, project));
  if (!match || !list) return { ok: true };
  const r = Number(match[1]);
  const k = Number(match[2]);
  const { store, player } = deps;
  const waived = await waivedInRound(store, project, r);
  const items = list.items.filter(({ id, check }) => check === 'play' && !waived.includes(id));
  if (items.length === 0) return { ok: true };

  const record = (statuses: ItemStatus[]) =>
    store.recordMustSupport(project.id, { scope: 'prototype', n: r, subject: `P-${k}` }, statuses.map((status) => ({ ...status, source: 'prototype_check', must_support_version: list.version })));
  const each = (status: MsStatus, evidence: string): ItemStatus[] => items.map(({ id }) => ({ item_id: id, status, evidence }));
  const unplayed = async (why: string): Promise<{ ok: true }> => {
    await record(each('not_measured', why));
    return { ok: true };
  };
  if (!player) return unplayed(NO_BROWSER);
  const missing = player.unavailable();
  if (missing) return unplayed(browserWhy(missing));

  const root = protoRoot(r, k);
  const site = await siteRoot(worktree, root);
  let statuses: ItemStatus[];
  if (site.ok) {
    const plan = (await deps.artifacts.read(project, protoPlanId(r))).fields.data as { prototypes: { controls: string[] }[] };
    const played = await playMustSupport(player, site.root, { root, entry: 'index.html', keys: plan.prototypes[k - 1]?.controls ?? [], animated: true }, items);
    if (played.kind === 'unavailable') return unplayed(played.why);
    statuses = played.statuses;
  } else {
    statuses = each('failing', site.why);
  }
  await record(statuses);

  const lines = items.flatMap((item) => statuses.filter(({ item_id, status }) => item_id === item.id && status === 'failing').map(({ evidence }) => `${itemLine(item)}: ${evidence}`));
  return lines.length === 0 ? { ok: true } : { ok: false, evidence: ['The prototype does not meet what the game must support:', ...lines].join('\n') };
}
