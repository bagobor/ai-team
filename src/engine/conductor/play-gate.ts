import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isHumanCheck } from '../../artifacts/acs.ts';
import type { NewVersion } from '../../artifacts/store.ts';
import type { PlayProblem } from '../../checks/play.ts';
import { runSandboxed, type CommandEnv, type SandboxedInput } from '../../checks/run-checks.ts';
import { serveStatic, type StaticServer } from '../../checks/static-server.ts';
import type { PlayBlock, ProfileData } from '../apply/discovery.ts';
import { ENV_PROFILE, specId, techId } from '../apply/ids.ts';
import { bugTicket, nextBugNumber } from '../apply/qa.ts';
import { structureOf } from '../apply/tech-structure.ts';
import { fenced } from '../apply/text.ts';
import { gateStatuses, itemLine, VIEWPORT_LABEL, type ItemStatus, type MsItem } from '../must-support.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import { withHeadWorktree } from './head-worktree.ts';
import { playMustSupport, type RunProblems } from './must-support-play.ts';
import { latestPin, mustSupportItems } from './tasks.ts';

// `profile` is the one the gate built with, so the Bug's ticket proves the fix with that profile's own test command.
// `cause` says what a person must fix: this machine's browser, or the profile's setup.
// `short` is a game that runs and fails an item of the must-support list: `statuses` are what each checked item came to.
export type PlayGateResult =
  | { kind: 'skipped' }
  | { kind: 'passed'; headSha: string }
  | { kind: 'failed'; headSha: string; problems: PlayProblem[]; profile: ProfileData }
  | { kind: 'short'; headSha: string; statuses: ItemStatus[]; profile: ProfileData }
  | { kind: 'unavailable'; cause: 'browser' | 'setup'; why: string };

type Failed = Extract<PlayGateResult, { kind: 'failed' }>;
type Short = Extract<PlayGateResult, { kind: 'short' }>;
type Unavailable = Extract<PlayGateResult, { kind: 'unavailable' }>;
// What the head came to before the stakeholder's waivers are weighed. `game` is set when the game itself didn't run.
type Checked = { kind: 'checked'; headSha: string; statuses: ItemStatus[]; game?: PlayProblem[] };
type Built = { ok: true; root: string } | { ok: false; why: string };

// A caller that streams command output passes its own onEvent. The gate has no log to stream to.
type SiteEnv = CommandEnv & Partial<Pick<SandboxedInput, 'onEvent'>>;

const quiet = () => {};

// Setup is the one step that gets the network, as it is wherever the profile's setup runs.
async function runSetup(env: SiteEnv, profile: ProfileData): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!profile.setup) return { ok: true };
  const prepared = await runSandboxed({ onEvent: quiet, ...env, network: true, commands: [profile.setup] });
  return prepared.ok ? { ok: true } : { ok: false, why: `The Environment Profile's setup failed, so the game could not be built.\n${prepared.evidence}` };
}

const missingRoot = (root: string) => `play.root ${root} does not exist after the build`;

// The build ran code a worker wrote, which can leave the root as a link out of the checkout. The server only keeps
// what it serves inside the root it is given, so the root itself is checked here, and again before a build is served anew.
export async function siteRoot(worktree: string, root: string): Promise<Built> {
  let real: string;
  try {
    const base = await realpath(worktree);
    real = await realpath(join(worktree, root));
    if (real !== base && !real.startsWith(base + sep)) return { ok: false, why: `play.root ${root} leads outside the checkout` };
    if (!(await stat(real)).isDirectory()) return { ok: false, why: `play.root ${root} is not a directory after the build` };
  } catch {
    return { ok: false, why: missingRoot(root) };
  }
  // The server is given the resolved directory, so a link swapped in at play.root once this check has passed leads nowhere.
  return { ok: true, root: real };
}

// Everything runs in the sandbox, never in the engine's own process, since the build is the product's own code.
export async function buildSite(env: SiteEnv, profile: ProfileData, opts: { setup: boolean }): Promise<Built> {
  if (!profile.play) throw new Error('Only a profile with a play block has a site to build');
  if (opts.setup) {
    const prepared = await runSetup(env, profile);
    if (!prepared.ok) return prepared;
  }
  const built = await runSandboxed({ onEvent: quiet, ...env, network: false, commands: [profile.commands.build] });
  if (!built.ok) return { ok: false, why: `The build command failed, so there was nothing to play.\n${built.evidence}` };
  return siteRoot(env.worktree, profile.play.root);
}

const CHROME_SETTING = 'The engine plays the game in the Chrome that chrome.binary in ~/.aiteam/config.yaml names.';

// A browser's own problem names the path it tried. The setting that chose that path is what a person changes.
export const browserWhy = (why: string): string => (why.includes('chrome.binary') ? why : `${why}\n${CHROME_SETTING}`);

export const NO_BROWSER = 'The engine was started without a browser to play the game in.';

// In a phone or tablet run a problem says which screen it was on. The desktop run reads as it always has.
const gameProblems = (runs: RunProblems[]): PlayProblem[] =>
  runs.flatMap(({ viewport, problems }) => (viewport === 'desktop' ? problems : problems.map((problem) => ({ ...problem, detail: `${VIEWPORT_LABEL[viewport]}: ${problem.detail}` }))));

// A file name may hold a space, # or %, which a URL reads as something else.
export const entryPath = (play: PlayBlock): string => play.entry.split('/').map(encodeURIComponent).join('/');

// Serves a built site for as long as `use` runs, and hands it the address of the entry page. The play gate and QA verify
// both play a checkout this way, so what makes the root safe to serve is checked in one place.
export async function servePage<T>(root: string, play: PlayBlock, use: (page: string) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  let server: StaticServer;
  try {
    server = await serveStatic(root);
  } catch (err) {
    // What the build left running can remove the root after it was checked, and the server's realpath of it is what
    // finds that. Any other failure to start is the engine's own, and stays an error.
    if ((err as NodeJS.ErrnoException).syscall !== 'realpath') throw err;
    return { ok: false, why: missingRoot(play.root) };
  }
  try {
    // The root was checked before the server resolved it, and a process the sandbox can't stop may have swapped it in between.
    if (server.root !== root) return { ok: false, why: `play.root ${play.root} changed while the engine began serving it` };
    return { ok: true, value: await use(server.url + entryPath(play)) };
  } finally {
    await server.close();
  }
}

const NO_COMMAND = 'The Environment Profile has no command for it yet';

// A command the Tech Lead wrote proves its item, in the sandbox and without the network, as a ticket's checks run.
async function commandStatus(env: SiteEnv, profile: ProfileData, { id }: MsItem): Promise<ItemStatus> {
  const check = profile.must_support_checks?.find(({ item }) => item === id);
  if (!check) return { item_id: id, status: 'not_measured', evidence: NO_COMMAND };
  const ran = await runSandboxed({ onEvent: quiet, ...env, network: false, commands: [check.command] });
  return ran.ok ? { item_id: id, status: 'met', evidence: `\`${check.command}\` passed` } : { item_id: id, status: 'failing', evidence: ran.evidence };
}

// Checks a checkout of the integration head, as the smoke pre-flight checks one: the game is built and played once for
// each screen the list names, then each command item's command is run. A list with nothing to play in a browser gets
// the one desktop play a game got before the list. Only playing needs a browser.
async function checkHead(deps: EngineDeps, project: ProjectRow, n: number, profile: ProfileData, play: PlayBlock | null, items: MsItem[]): Promise<Checked | Unavailable> {
  const { player } = deps;
  if (play !== null) {
    if (!player) return { kind: 'unavailable', cause: 'browser', why: NO_BROWSER };
    const missing = player.unavailable();
    if (missing) return { kind: 'unavailable', cause: 'browser', why: browserWhy(missing) };
  }

  return withHeadWorktree(deps, project, n, 'play', async (env, headSha): Promise<Checked | Unavailable> => {
    // A setup that fails may be the registry or the network, not the game, so it asks rather than filing a Bug.
    const prepared = await runSetup(env, profile);
    if (!prepared.ok) return { kind: 'unavailable', cause: 'setup', why: prepared.why };
    const statuses: ItemStatus[] = [];
    if (play !== null && player) {
      const site = await buildSite(env, profile, { setup: false });
      if (!site.ok) return { kind: 'checked', headSha, statuses, game: [{ kind: 'load', detail: site.why }] };
      const played = await playMustSupport(player, site.root, play, items);
      // A problem from the browser itself says nothing about the game, so it holds instead of costing a round.
      if (played.kind === 'unavailable') return { kind: 'unavailable', cause: 'browser', why: played.why };
      statuses.push(...played.statuses);
      if (played.game.length > 0) return { kind: 'checked', headSha, statuses, game: gameProblems(played.game) };
    }
    for (const item of items.filter(({ check }) => check === 'command')) statuses.push(await commandStatus(env, profile, item));
    return { kind: 'checked', headSha, statuses };
  });
}

// A profile published before the play gate has no play block at all, and is played no more than one with null.
export async function playProfile(deps: EngineDeps, project: ProjectRow): Promise<{ profile: ProfileData; play: PlayBlock | null }> {
  const profile = (await deps.artifacts.read(project, ENV_PROFILE)).fields.data as ProfileData;
  return { profile, play: profile.play ?? null };
}

// Builds the integration head and checks it against the must-support list before a QA round, so a game that never
// starts doesn't reach QA, and one that doesn't run where it must is sent back while rounds are left.
export async function runPlayGate(deps: EngineDeps, project: ProjectRow, n: number): Promise<PlayGateResult> {
  const { store } = deps;
  const { profile, play } = await playProfile(deps, project);
  const list = await mustSupportItems(deps, project);
  // What the stakeholder accepted going without in this milestone is their word, which the gate neither checks nor
  // writes over. An item only they can judge waits for the milestone's approval.
  const waived = (await store.listMustSupport(project.id, { scope: 'milestone', n })).filter(({ status }) => status === 'waived').map(({ item_id }) => item_id);
  const items = (list?.items ?? []).filter(({ id, check }) => check !== 'human' && !waived.includes(id));
  if (play === null && !items.some(({ check }) => check === 'command')) return { kind: 'skipped' };

  const checked = await checkHead(deps, project, n, profile, play, items);
  let result: Exclude<PlayGateResult, { kind: 'skipped' }>;
  if (checked.kind === 'unavailable') {
    result = checked;
  } else {
    const { headSha, statuses, game } = checked;
    if (list && statuses.length > 0) {
      await store.recordMustSupport(project.id, { scope: 'milestone', n }, statuses.map((status) => ({ ...status, source: 'play_gate', must_support_version: list.version })));
    }
    // An item waived for good still counts when the build meets it, and never counts against the build.
    const found = gateStatuses(items, statuses, await store.listMustSupport(project.id, { scope: 'project', n: 0 }));
    if (game) result = { kind: 'failed', headSha, profile, problems: game };
    else if (found.some(({ status }) => status === 'failing')) result = { kind: 'short', headSha, statuses: found, profile };
    else result = { kind: 'passed', headSha };
  }
  await store.logEvent(project.id, 'play.result', {
    milestone: n,
    outcome: result.kind,
    ...(result.kind === 'unavailable' ? { cause: result.cause, why: result.why } : { headSha: result.headSha }),
    ...(result.kind === 'failed' ? { problems: result.problems } : {}),
    ...(result.kind === 'short' ? { statuses: result.statuses.map(({ item_id, status }) => ({ item_id, status })) } : {}),
  });
  return result;
}

// One line for a list or a hold. A build's output runs to many lines, and the Bug carries those in full.
export const problemLine = ({ kind, detail }: PlayProblem): string => `${kind}: ${detail.trim().split(/\r\n?|\n/)[0]}`;

const multiLine = ({ detail }: PlayProblem) => /[\r\n]/.test(detail.trim());

// The engine files this Bug itself: no QA ran, so what the browser saw is the whole of the evidence. A game that
// doesn't run fails every automated criterion, so its ticket names them all, and the profile's test command proves
// the fix broke nothing else.
export async function playBug(deps: EngineDeps, project: ProjectRow, n: number, round: number, { headSha, problems, profile }: Failed): Promise<{ bug: NewVersion; ticket: NewVersion }> {
  const k = await nextBugNumber(deps, project, n);
  const id = `BUG-M${n}-${k}`;
  const acs = (await deps.store.listCriteria(project.id, n)).filter((criterion) => !isHumanCheck(criterion)).map(({ ac_id }) => ac_id);
  const specPin = await latestPin(deps, project, specId(n));
  const full = problems.filter(multiLine);
  const body = [
    '# The game does not run',
    '',
    `The engine built milestone ${n} at ${headSha.slice(0, 7)}, served it and played it in a browser before QA round ${round}. It found:`,
    '',
    ...problems.map((problem) => `- ${problemLine(problem)}${multiLine(problem) ? ' (in full below)' : ''}`),
    '',
    'No QA round starts until the game loads and runs without these.',
    '',
    ...(full.length === 0 ? [] : ['## In full', '', ...full.flatMap(({ kind, detail }) => [`${kind}:`, '', fenced(detail), ''])]),
  ].join('\n');
  const bug: NewVersion = { id, type: 'bug', status: 'approved', ownerRole: 'qa_engineer', approvedBy: 'engine', milestone: n, derivedFrom: [specPin, await latestPin(deps, project, ENV_PROFILE)], fields: { data: { acs, headSha, problems } }, body };
  const techPin = await latestPin(deps, project, techId(n));
  const components = structureOf(await deps.artifacts.read(project, techPin))?.components;
  const ticket = bugTicket(n, k, { acs, title: 'The game does not run', touches: ['**'], definition_of_done: [profile.commands.test], techPin, specPin, components });
  return { bug, ticket };
}

// The engine files this Bug too: the game runs, and fails an item of the list the stakeholder confirmed. Its ticket
// proves the fix with the profile's test command and with each failing item's own command.
export async function mustSupportBug(deps: EngineDeps, project: ProjectRow, n: number, round: number, { headSha, statuses, profile }: Short): Promise<{ bug: NewVersion; ticket: NewVersion }> {
  const list = await mustSupportItems(deps, project);
  if (!list) throw new Error(`Milestone ${n} came up short of a must-support list that is no longer approved`);
  const k = await nextBugNumber(deps, project, n);
  const title = 'The game does not meet what it must support';
  const failing = list.items.flatMap((item) => statuses.filter(({ item_id, status }) => item_id === item.id && status === 'failing').map(({ evidence }) => ({ item, evidence: evidence.trim() })));
  const isLong = (evidence: string) => /[\r\n]/.test(evidence);
  const full = failing.filter(({ evidence }) => isLong(evidence));
  const body = [
    `# ${title}`,
    '',
    `The engine built milestone ${n} at ${headSha.slice(0, 7)} and checked it against ${list.pin} before QA round ${round}. These items failed:`,
    '',
    ...failing.map(({ item, evidence }) => `- ${itemLine(item)}: ${evidence.split(/\r\n?|\n/)[0]}${isLong(evidence) ? ' (in full below)' : ''}`),
    '',
    'Fix the build so that each of them holds.',
    '',
    ...(full.length === 0 ? [] : ['## In full', '', ...full.flatMap(({ item, evidence }) => [`${item.id}:`, '', fenced(evidence), ''])]),
  ].join('\n');
  const specPin = await latestPin(deps, project, specId(n));
  const ids = failing.map(({ item }) => item.id);
  const bug: NewVersion = { id: `BUG-M${n}-${k}`, type: 'bug', status: 'approved', ownerRole: 'qa_engineer', approvedBy: 'engine', milestone: n, derivedFrom: [specPin, list.pin, await latestPin(deps, project, ENV_PROFILE)], fields: { data: { items: ids, headSha, statuses } }, body };
  const techPin = await latestPin(deps, project, techId(n));
  const components = structureOf(await deps.artifacts.read(project, techPin))?.components;
  const commands = (profile.must_support_checks ?? []).filter(({ item }) => ids.includes(item)).map(({ command }) => command);
  const ticket = bugTicket(n, k, { acs: [], title, touches: ['**'], definition_of_done: [profile.commands.test, ...commands], techPin, specPin, components });
  return { bug, ticket };
}
