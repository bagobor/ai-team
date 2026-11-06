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
import { fenced } from '../apply/text.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import { withHeadWorktree } from './head-worktree.ts';
import { latestPin } from './tasks.ts';

// `profile` is the one the gate built with, so the Bug's ticket proves the fix with that profile's own test command.
// `cause` says what a person must fix: this machine's browser, or the profile's setup.
export type PlayGateResult =
  | { kind: 'skipped' }
  | { kind: 'passed'; headSha: string }
  | { kind: 'failed'; headSha: string; problems: PlayProblem[]; profile: ProfileData }
  | { kind: 'unavailable'; cause: 'browser' | 'setup'; why: string };

type Failed = Extract<PlayGateResult, { kind: 'failed' }>;
type Played = Exclude<PlayGateResult, { kind: 'skipped' }>;
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
// what it serves inside the root it is given, so the root itself is checked here.
async function siteRoot(worktree: string, root: string): Promise<Built> {
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
const browserWhy = (why: string): string => (why.includes('chrome.binary') ? why : `${why}\n${CHROME_SETTING}`);

// A problem from the browser itself says nothing about the game, so it holds instead of costing a round.
function judged(headSha: string, problems: PlayProblem[], ok: boolean, profile: ProfileData): Played {
  const browser = problems.filter(({ kind }) => kind === 'browser');
  if (browser.length > 0) return { kind: 'unavailable', cause: 'browser', why: browserWhy(browser.map(({ detail }) => detail).join('\n')) };
  if (ok && problems.length === 0) return { kind: 'passed', headSha };
  // A Bug with nothing in it would give an Engineer nothing to fix.
  return { kind: 'failed', headSha, profile, problems: problems.length > 0 ? problems : [{ kind: 'load', detail: 'The play run failed and named no problem' }] };
}

// Plays in a checkout of the integration head, as the smoke pre-flight checks one.
async function playHead(deps: EngineDeps, project: ProjectRow, n: number, profile: ProfileData, play: PlayBlock): Promise<Played> {
  const { player } = deps;
  if (!player) return { kind: 'unavailable', cause: 'browser', why: 'The engine was started without a browser to play the game in.' };
  const missing = player.unavailable();
  if (missing) return { kind: 'unavailable', cause: 'browser', why: browserWhy(missing) };

  return withHeadWorktree(deps, project, n, 'play', async (env, headSha): Promise<Played> => {
    // A setup that fails may be the registry or the network, not the game, so it asks rather than filing a Bug.
    const prepared = await runSetup(env, profile);
    if (!prepared.ok) return { kind: 'unavailable', cause: 'setup', why: prepared.why };
    const site = await buildSite(env, profile, { setup: false });
    if (!site.ok) return { kind: 'failed', headSha, profile, problems: [{ kind: 'load', detail: site.why }] };
    let server: StaticServer;
    try {
      server = await serveStatic(site.root);
    } catch (err) {
      // What the build left running can remove the root after it was checked, and the server's realpath of it is what
      // finds that. Any other failure to start is the engine's own, and stays an error.
      if ((err as NodeJS.ErrnoException).syscall !== 'realpath') throw err;
      return { kind: 'failed', headSha, profile, problems: [{ kind: 'load', detail: missingRoot(play.root) }] };
    }
    try {
      // The root was checked before the server resolved it, and a process the sandbox can't stop may have swapped it in between.
      if (server.root !== site.root) return { kind: 'failed', headSha, profile, problems: [{ kind: 'load', detail: `play.root ${play.root} changed while the engine began serving it` }] };
      // A file name may hold a space, # or %, which a URL reads as something else.
      const page = play.entry.split('/').map(encodeURIComponent).join('/');
      const played = await player.smoke(server.url + page, play.keys);
      return judged(headSha, played.problems, played.ok, profile);
    } finally {
      await server.close();
    }
  });
}

// Builds, serves and smoke-plays the integration head before a QA round, so a game that never starts doesn't reach QA.
export async function runPlayGate(deps: EngineDeps, project: ProjectRow, n: number): Promise<PlayGateResult> {
  const profile = (await deps.artifacts.read(project, ENV_PROFILE)).fields.data as ProfileData;
  // A profile published before the play gate has no play block at all, and is played no more than one with null.
  const play = profile.play ?? null;
  if (play === null) return { kind: 'skipped' };
  const result = await playHead(deps, project, n, profile, play);
  await deps.store.logEvent(project.id, 'play.result', {
    milestone: n,
    outcome: result.kind,
    ...(result.kind === 'unavailable' ? { cause: result.cause, why: result.why } : { headSha: result.headSha }),
    ...(result.kind === 'failed' ? { problems: result.problems } : {}),
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
  const ticket = bugTicket(n, k, { acs, title: 'The game does not run', touches: ['**'], definition_of_done: [profile.commands.test], techPin: await latestPin(deps, project, techId(n)), specPin });
  return { bug, ticket };
}
