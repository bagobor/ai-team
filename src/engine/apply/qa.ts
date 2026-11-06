import { isHumanCheck } from '../../artifacts/acs.ts';
import type { NewVersion } from '../../artifacts/store.ts';
import type { PlayProblem, PlayResult, PlayScript, Player } from '../../checks/play.ts';
import { runSandboxed, TAIL_CHARS, type CheckRun } from '../../checks/run-checks.ts';
import { requestOf } from '../change-requests.ts';
import { browserWhy, buildSite, NO_BROWSER, servePage } from '../conductor/play-gate.ts';
import { addAttemptWorktree, mergeBase, overlayPaths, removeAttemptWorktree } from '../../git/workspace.ts';
import { worktreePath } from '../../paths.ts';
import { protectedPaths } from '../protected.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import type { Coverage } from './design.ts';
import { approvedProfile, type PlayBlock, type ProfileData } from './discovery.ts';
import { specId, techId, testPlanId } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { raisedOf, sentBack, withRaised, type Raised } from './raised.ts';
import { sandboxEnv } from './sandbox.ts';
import { fenced, oneLine, quoted } from './text.ts';
import { renderTicket, ticketIdFor, touchesProblem } from './tickets.ts';

type QaResult = { ac: string; status: 'passing' | 'failing'; commands: string[]; notes: string };
type QaBug = { ac: string; title: string; description: string; touches: string[]; commands: string[] };
type QaOutput = { results: QaResult[]; bugs: QaBug[]; summary: string };

// What QA wrote, apart from the commands and output around it in the report's body.
export type QaRecord = { summary: string; verdicts: { ac: string; status: 'passing' | 'failing'; notes: string; noted: string[] }[] };

// What the Test Plan's commands did on the milestone's base: red when any of them failed there, which is how a criterion shows the milestone's work.
// A base that could not be set up is red with no runs, since nothing ran there.
type OnBase = { sha: string; runs: CheckRun[]; red: boolean };

// What the engine concludes about a criterion: what QA said is only ever part of it.
// The Test Plan's runs come first, and planned says how many there are. onBase is there only for a criterion that held on the verified commit, because only then is there anything to compare.
type Verdict = { ac: string; claimed: QaResult['status']; status: QaResult['status']; notes: string; runs: CheckRun[]; planned: number; disputedIn?: string; onBase?: OnBase };

const OUTPUT_TAIL = 2000;
const COMMAND_NOT_FOUND = 127;

// A play run is recorded as a CheckRun so it reads like the rest of a criterion's evidence, but its command is a description, not something a shell runs.
const isPlayRun = ({ command }: CheckRun) => command.startsWith('play: ');
const shellRuns = (runs: CheckRun[]) => runs.filter((run) => !isPlayRun(run));
const failedCommands = (runs: CheckRun[]) => shellRuns(runs).filter((run) => run.exitCode !== 0).map((run) => run.command);
const nonBlank = (commands: string[]) => commands.map((command) => command.trim()).filter((command) => command !== '');

// A human check is the stakeholder's to judge at milestone approval, so QA reports on the automated criteria alone, and neither a result nor a Bug may name one.
function outputProblems({ results, bugs }: QaOutput, acIds: string[], humanIds: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { ac } of results) {
    if (humanIds.includes(ac)) problems.push(`${ac} is checked by the stakeholder at milestone approval; leave it out`);
    else if (!acIds.includes(ac)) problems.push(`${ac} is not a criterion of this milestone`);
    if (seen.has(ac)) problems.push(`${ac} appears twice in the results`);
    seen.add(ac);
  }
  for (const ac of acIds) if (!seen.has(ac)) problems.push(`${ac} has no result`);

  for (const { ac, title, touches } of bugs) {
    if (humanIds.includes(ac)) problems.push(`A Bug names ${ac}, which is checked by the stakeholder at milestone approval; leave it out`);
    else if (!acIds.includes(ac)) problems.push(`A Bug names ${ac}, which is not a criterion of this milestone`);
    if (title.trim() === '') problems.push(`A Bug against ${ac} has a blank title`);
    for (const glob of touches) {
      const problem = touchesProblem(glob);
      if (problem) problems.push(`A Bug against ${ac} has touches ${JSON.stringify(glob)} that ${problem}`);
    }
  }
  return problems;
}

// QA and the play gate both file Bugs, and each takes the next number either of them has used.
export async function nextBugNumber(deps: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, milestone: number): Promise<number> {
  const pattern = new RegExp(`^(?:BUG-M${milestone}|M${milestone}-B)-(\\d+)$`);
  const artifacts = await deps.artifacts.list(project.id);
  const tasks = await deps.store.listTasks(project.id);
  const taken = [...artifacts.map((row) => row.artifact_id), ...tasks.map((task) => task.ticket_id)];
  return 1 + Math.max(0, ...taken.map((id) => Number(pattern.exec(id)?.[1] ?? 0)));
}

async function approvedSetup(ctx: ApplyCtx): Promise<string | null> {
  return (await approvedProfile(ctx))?.setup ?? null;
}

// The commit QA verifies.
function verifiedHead({ attempt }: ApplyCtx): string {
  if (attempt.base_sha === null) throw new Error(`QA attempt ${attempt.id} has no base commit`);
  return attempt.base_sha;
}

// A round has two checkouts, the verified commit's and, given its sha here, the milestone's base. Each is gone before the next begins.
async function inFreshWorktree<T>(ctx: ApplyCtx, work: (worktree: string) => Promise<T>, onBase?: string): Promise<T> {
  const { project, task, attempt } = ctx;
  const sha = onBase ?? verifiedHead(ctx);
  const worktree = worktreePath(ctx.deps.paths, project.name, `${task.ticket_id}-${onBase === undefined ? 'verify' : 'base'}`, attempt.k);
  const branch = `aiteam/verify/${task.ticket_id}-a${attempt.k}${onBase === undefined ? '' : '-base'}`;
  await addAttemptWorktree(project.repo_path, worktree, branch, sha);
  try {
    return await work(worktree);
  } finally {
    await removeAttemptWorktree(project.repo_path, worktree, branch);
  }
}

// runSandboxed stops at the first failure. Each command goes alone, so every failure is on record.
async function runEach(ctx: ApplyCtx, worktree: string, commands: string[]): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const command of commands) runs.push(...(await runSandboxed({ ...sandboxEnv(ctx, worktree), commands: [command] })).runs);
  return runs;
}

// What sends QA back with the reason, and records nothing.
type Refused = { ok: false; evidence: string };
const STOPPED: Refused = { ok: false, evidence: 'QA verification was stopped before it finished' };

// Setup is the one step that gets the network. Nothing comes back when the profile has none.
async function runSetup(ctx: ApplyCtx, worktree: string) {
  const setup = await approvedSetup(ctx);
  return setup ? runSandboxed({ ...sandboxEnv(ctx, worktree), commands: [setup], network: true }) : undefined;
}

const plannedFor = (coverage: Coverage[], ac: string) => [...new Set(nonBlank(coverage.filter((entry) => entry.ac === ac).flatMap((entry) => entry.commands)))];

// A play script runs in the page the profile builds, in a browser, so it needs both of those to be there.
type Scripted = { ac: string; play: PlayScript };
type Site = { player: Player; profile: ProfileData; play: PlayBlock };

const scriptsOf = (coverage: Coverage[], acs: string[]): Scripted[] => acs.flatMap((ac) => coverage.flatMap((entry) => (entry.ac === ac && entry.play !== undefined ? [{ ac, play: entry.play }] : [])));

const playCommand = ({ steps, expect }: PlayScript) => `play: ${steps.length} steps, expect ${expect}`;

// The problems come first, since they are what a person reads, and the log's own tail fills what room is left.
function playTail(problems: PlayProblem[], log: string[]): string {
  const found = problems.map(({ kind, detail }) => `${kind}: ${detail}`).join('\n').slice(0, TAIL_CHARS);
  const room = TAIL_CHARS - found.length - 1;
  return [found, room > 0 ? log.join('\n').slice(-room) : ''].filter((part) => part !== '').join('\n');
}

export const playRun = (play: PlayScript, { ok, problems, durationMs, log }: PlayResult): CheckRun => ({
  command: playCommand(play),
  exitCode: ok && problems.length === 0 ? 0 : 1,
  timedOut: problems.some(({ kind }) => kind === 'timeout'),
  durationMs,
  outputTail: playTail(problems, log),
});

// QA is sent back, with no Bug, when a script can't be played at all: that is this machine's, not the product's.
async function playSite(ctx: ApplyCtx, scripted: Scripted[]): Promise<{ ok: true; site: Site } | Refused> {
  const { player } = ctx.deps;
  const noBrowser = (why: string): Refused => ({ ok: false, evidence: `The Test Plan has play scripts, but there is no browser to play them in, so nothing was verified.\n${why}` });
  if (!player) return noBrowser(NO_BROWSER);
  const missing = player.unavailable();
  if (missing) return noBrowser(browserWhy(missing));
  const profile = await approvedProfile(ctx);
  if (!profile?.play) return { ok: false, evidence: `${[...new Set(scripted.map(({ ac }) => ac))].join(', ')} has a play script in the Test Plan, but the approved Environment Profile has no play block, so there is no page to play and nothing was verified.` };
  return { ok: true, site: { player, profile, play: profile.play } };
}

// Builds the checkout and serves it once, then plays each script on that one server, in order. The runs come back in the order of the scripts.
// A site that won't build or serve gives every script a red run, since none has a page to run in, which on the base is the red that shows the work.
// A problem of the browser's own says nothing about the page, so it sends QA back like a browser that is not there.
async function playScripts(ctx: ApplyCtx, worktree: string, { player, profile, play }: Site, scripts: Scripted[]): Promise<{ ok: true; runs: CheckRun[] } | Refused> {
  const red = (why: string) => ({ ok: true as const, runs: scripts.map((script) => playRun(script.play, { ok: false, problems: [{ kind: 'load', detail: why }], durationMs: 0, log: [] })) });
  const built = await buildSite(sandboxEnv(ctx, worktree), profile, { setup: false });
  if (ctx.signal.aborted) return STOPPED;
  if (!built.ok) return red(built.why);

  const served = await servePage(built.root, play, async (page): Promise<PlayResult[] | Refused> => {
    const played: PlayResult[] = [];
    for (const script of scripts) {
      if (ctx.signal.aborted) return STOPPED;
      played.push(await player.script(page, script.play));
    }
    return played;
  });
  if (!served.ok) return red(served.why);
  if (!Array.isArray(served.value)) return served.value;
  if (ctx.signal.aborted) return STOPPED;

  const browser = served.value.flatMap(({ problems }) => problems).filter(({ kind }) => kind === 'browser');
  if (browser.length > 0) return { ok: false, evidence: `The browser could not play the Test Plan's scripts, so nothing was verified.\n${browserWhy(browser.map(({ detail }) => detail).join('\n'))}` };
  return { ok: true, runs: served.value.map((result, i) => playRun(scripts[i]!.play, result)) };
}

async function verifyAll(ctx: ApplyCtx, worktree: string, results: QaResult[], coverage: Coverage[], site: Site | undefined): Promise<{ ok: true; verdicts: Verdict[] } | Refused> {
  const installed = await runSetup(ctx, worktree);
  if (installed && !installed.ok) return ctx.signal.aborted ? STOPPED : { ok: false, evidence: `The Environment Profile's setup failed, so nothing could be verified.\n${installed.evidence}` };

  // Every Test Plan command and script goes before any of QA's, which share this worktree and could otherwise rewrite the tests they run or the page they play.
  // A script plays after the commands of every entry, so the page is built from the checkout as they left it.
  const planned = new Map<string, CheckRun[]>();
  for (const { ac } of results) {
    planned.set(ac, await runEach(ctx, worktree, plannedFor(coverage, ac)));
    if (ctx.signal.aborted) return STOPPED;
  }
  const scripts = site ? scriptsOf(coverage, results.map(({ ac }) => ac)) : [];
  if (site && scripts.length > 0) {
    const played = await playScripts(ctx, worktree, site, scripts);
    if (!played.ok) return played;
    scripts.forEach(({ ac }, i) => planned.get(ac)?.push(played.runs[i]!));
  }

  const verdicts: Verdict[] = [];
  const unrunnable: string[] = [];
  for (const { ac, status: claimed, commands, notes } of results) {
    const own = [...new Set(nonBlank(commands))].filter((command) => !plannedFor(coverage, ac).includes(command));
    const ownRuns = await runEach(ctx, worktree, own);
    if (ctx.signal.aborted) return STOPPED;
    // QA says this passed by running something no shell can find: that's a bad report, not a Bug for an Engineer to chase.
    if (claimed === 'passing') unrunnable.push(...ownRuns.filter((run) => run.exitCode === COMMAND_NOT_FOUND).map((run) => `${ac}: ${run.command}`));
    const runs = [...(planned.get(ac) ?? []), ...ownRuns];
    const held = claimed === 'passing' && runs.length > 0 && runs.every((run) => run.exitCode === 0);
    verdicts.push({ ac, claimed, status: held ? 'passing' : 'failing', notes, runs, planned: planned.get(ac)?.length ?? 0 });
  }
  if (unrunnable.length > 0) return { ok: false, evidence: [`Each entry in \`commands\` must be one exact shell command, because the engine runs it as written. The shell could not find these, so nothing was recorded:`, ...unrunnable.map((line) => `- ${line}`)].join('\n') };
  return { ok: true, verdicts };
}

// A command that passes with none of the milestone's work proves nothing about it, so each criterion that held is run again where the work is not.
// This run starts only after the verified commit's is done and is not overlapped with it, so a QA round now costs about twice its command time.
// QA's protected files are laid over the base first, since the Test Plan's commands run them and they exist only on the verified commit.
async function verifyOnBase(ctx: ApplyCtx, held: string[], coverage: Coverage[], site: Site | undefined): Promise<{ ok: true; onBase: Map<string, OnBase> } | Refused> {
  const { project, task } = ctx;
  const head = verifiedHead(ctx);
  const sha = await mergeBase(project.repo_path, head, `refs/heads/${project.base_branch}`);
  const globs = (await protectedPaths(ctx.deps, project, task.milestone)).map(({ glob }) => glob);

  return inFreshWorktree(
    ctx,
    async (worktree): Promise<{ ok: true; onBase: Map<string, OnBase> } | Refused> => {
      // Git runs here before any setup or command does, because worker-written code can rewrite this worktree's .git (see linkedLocation).
      await overlayPaths(worktree, head, globs);

      const onBase = new Map<string, OnBase>();
      const installed = await runSetup(ctx, worktree);
      if (installed && !installed.ok) {
        if (ctx.signal.aborted) return STOPPED;
        // A base that can't be set up has not shown that anything passes there, so it counts as red.
        for (const ac of held) onBase.set(ac, { sha, runs: [], red: true });
        return { ok: true, onBase };
      }

      const ran = new Map<string, CheckRun[]>();
      for (const ac of held) {
        ran.set(ac, await runEach(ctx, worktree, plannedFor(coverage, ac)));
        if (ctx.signal.aborted) return STOPPED;
      }
      const scripts = site ? scriptsOf(coverage, held) : [];
      if (site && scripts.length > 0) {
        const played = await playScripts(ctx, worktree, site, scripts);
        if (!played.ok) return played;
        scripts.forEach(({ ac }, i) => ran.get(ac)?.push(played.runs[i]!));
      }
      for (const [ac, runs] of ran) {
        // A run that timed out or was stopped has no exit code of 0, so it is red like any other failure.
        onBase.set(ac, { sha, runs, red: runs.some((run) => run.exitCode !== 0) });
      }
      return { ok: true, onBase };
    },
    sha,
  );
}

const outcomeOf = ({ timedOut, exitCode }: CheckRun) => (timedOut ? 'timed out' : exitCode === null ? 'was stopped' : `exit code ${exitCode}`);

// A command's output ends with what went wrong. A play run's begins with it, so it is cut from the other end.
const shown = (run: CheckRun) => (isPlayRun(run) ? run.outputTail.slice(0, OUTPUT_TAIL) : run.outputTail.slice(-OUTPUT_TAIL));

const runLines = (runs: CheckRun[]) =>
  runs.length === 0
    ? ['No command ran.', '']
    : runs.flatMap((run) => [`Command, ${outcomeOf(run)}:`, '', fenced(run.command), '', ...(run.outputTail.trim() === '' ? ['No output.'] : ['Output:', '', fenced(shown(run))]), '']);

export const notedLines = (noted: string[]): string[] => (noted.length === 0 ? [] : ['QA also noted, with no ticket opened because the criterion passes:', '', ...noted.map((line) => `- ${line}`), '']);

// A red base with no runs is one that could not be set up.
function baseLine({ sha, runs, red }: OnBase, guard: boolean): string {
  const base = sha.slice(0, 7);
  if (red) return runs.length === 0 ? `The base (${base}) could not be set up, so it counts as red.` : `On the base (${base}), failed as it should.`;
  return guard ? `On the base (${base}), passed too: a regression guard.` : `On the base (${base}), passed too, so it shows nothing.`;
}

function reportSection({ ac, claimed, status, notes, runs, disputedIn, onBase }: Verdict, noted: string[], guard: boolean): string[] {
  // A criterion QA disputes either failed its plan commands on the verified commit, or held there and passed on the base too.
  const why = onBase === undefined || onBase.red ? "only the Test Plan's commands failed" : "the Test Plan's commands pass on the base too";
  return [
    `## ${ac}`,
    '',
    `Status: ${status}`,
    `QA said: ${claimed}`,
    '',
    ...(disputedIn === undefined ? [] : [`No Bug was filed: ${why}, and QA asked to change them in ${disputedIn}. The next round runs whatever is decided.`, '']),
    ...(onBase === undefined ? [] : [baseLine(onBase, guard), '']),
    ...(notes.trim() === '' ? [] : [quoted(notes), '']),
    ...runLines(runs),
    ...notedLines(noted),
  ];
}

// Tickets take their shape from a Bug: the failing commands are its definition of done, and only a commandless Bug falls further back.
// A QA Bug is against one criterion. A game that doesn't run fails them all, so the play gate's Bug names every automated one.
export function bugTicket(milestone: number, k: number, bug: { acs: string[]; title: string; touches: string[]; definition_of_done: string[]; techPin: string; specPin: string }): NewVersion {
  const key = `B-${k}`;
  const id = ticketIdFor(milestone, key);
  const inputs = [`BUG-M${milestone}-${k}@1`, bug.techPin];
  // A milestone of human checks only leaves the play gate's Bug no criterion to name.
  const passes = bug.acs.length === 0 ? '' : bug.acs.length === 1 ? `, so that ${bug.acs[0]} passes` : `, so that ${bug.acs.join(', ')} pass`;
  const { fields, body } = renderTicket(
    milestone,
    { key, title: oneLine(bug.title), ac_refs: bug.acs, specialty: 'engineer', touches: bug.touches, depends_on: [], definition_of_done: bug.definition_of_done, inputs, size: 'S', body: `Fix what BUG-M${milestone}-${k} describes${passes}.\n` },
    { id, dependsOn: [], inputs },
  );
  return { id, type: 'ticket', status: 'approved', ownerRole: 'tech_lead', approvedBy: 'engine', milestone, derivedFrom: [...inputs, bug.specPin], fields, body };
}

function bugDoc(milestone: number, k: number, reportId: string, verdict: Verdict, filed: QaBug | undefined, title: string, touches: string[]): NewVersion {
  const { ac, runs } = verdict;
  const body = [
    `# ${oneLine(title)}`,
    '',
    `${ac} fails. QA said it was ${verdict.claimed}.`,
    '',
    '## What the engine saw',
    '',
    ...runLines(runs),
    ...(filed ? ['## What QA says', '', quoted(filed.description), ''] : []),
  ].join('\n');
  return { id: `BUG-M${milestone}-${k}`, type: 'bug', status: 'approved', ownerRole: 'qa_engineer', approvedBy: 'owner:qa_engineer', milestone, derivedFrom: [`${reportId}#${ac.toLowerCase()}`], fields: { data: { ac, touches, commands: failedCommands(runs) } }, body };
}

// The request QA raised, if any, to change this criterion's Test Plan commands.
function requestOn(raised: Raised, planId: string, ac: string): string | undefined {
  return raised.docs.find((doc) => {
    const request = requestOf({ fields: doc.fields ?? {} });
    return request.target_artifact === planId && request.target_ac === ac;
  })?.id;
}

// QA says it passes, and only the Test Plan's commands fail: QA's request to change them decides it, not an Engineer's fix of the product.
// The criterion still fails, so the milestone goes back to build, which waits on that request before the next round.
function disputed(verdict: Verdict, raised: Raised, planId: string): string | undefined {
  const { ac, claimed, runs, planned } = verdict;
  const onlyThePlan = runs.slice(0, planned).some((run) => run.exitCode !== 0) && runs.slice(planned).every((run) => run.exitCode === 0);
  if (claimed !== 'passing' || !onlyThePlan) return undefined;
  return requestOn(raised, planId, ac);
}

// QA's claims are only claims: the engine runs its commands and the Test Plan's in a clean checkout, and records what it saw.
export const applyQaVerify: Applier = async (ctx) => {
  const output = ctx.output as QaOutput;
  const { artifacts, store } = ctx.deps;
  const { project, task } = ctx;
  const { milestone } = task;

  const criteria = await store.listCriteria(project.id, milestone);
  const problems = outputProblems(
    output,
    criteria.filter((criterion) => !isHumanCheck(criterion)).map(({ ac_id }) => ac_id),
    criteria.filter(isHumanCheck).map(({ ac_id }) => ac_id),
  );
  if (problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  const round = (await store.getMilestone(project.id, milestone))?.verify_round;
  if (round === undefined) throw new Error(`QA task ${task.ticket_id} names milestone ${milestone}, which does not exist`);
  const { coverage } = (await artifacts.read(project, testPlanId(milestone))).fields.data as { coverage: Coverage[] };

  // A bad request sends QA back anyway, so nothing runs for it.
  const raised = await raisedOf(ctx);
  const back = await sentBack(ctx, raised);
  if (back) return back;

  // The browser is looked for before anything runs, so a machine without one costs no work and no Bug.
  const scripted = scriptsOf(coverage, output.results.map(({ ac }) => ac));
  const playing = scripted.length === 0 ? undefined : await playSite(ctx, scripted);
  if (playing && !playing.ok) return playing;
  const site = playing?.site;

  const verified = await inFreshWorktree(ctx, (worktree) => verifyAll(ctx, worktree, output.results, coverage, site));
  if (!verified.ok) return verified;

  // A criterion that failed on the verified commit has nothing to compare, so only the ones that held go to the base.
  const held = verified.verdicts.filter(({ status }) => status === 'passing').map(({ ac }) => ac);
  const base = held.length === 0 ? undefined : await verifyOnBase(ctx, held, coverage, site);
  if (base && !base.ok) return base;
  const judged = verified.verdicts.map((verdict): Verdict => {
    const onBase = base?.onBase.get(verdict.ac);
    return onBase === undefined ? verdict : { ...verdict, onBase };
  });

  // Commands that pass on the base too don't show this milestone's work, unless the entry says the criterion already held.
  // QA can't set that flag in its output, so the refusal names the request that does: one that proposes the entry's own commands.
  const planId = testPlanId(milestone);
  const guarded = (ac: string) => coverage.some((entry) => entry.ac === ac && entry.regression === true);
  const vacuous = (verdict: Verdict): verdict is Verdict & { onBase: OnBase } => verdict.onBase !== undefined && !verdict.onBase.red && !guarded(verdict.ac);
  const refusals = judged
    .filter(vacuous)
    .filter(({ ac }) => requestOn(raised, planId, ac) === undefined)
    .map(({ ac, onBase }) => `${ac}'s Test Plan commands pass on the base too (${onBase.sha.slice(0, 7)}), so they don't show this milestone's work. Raise a Change Request on ${ac}'s Test Plan commands with commands that fail without the work, or, if the criterion is meant to hold already, one that proposes the same commands, which asks the stakeholder to make the entry a regression guard.`);
  if (refusals.length > 0) return { ok: false, evidence: refusals.join('\n') };
  // With QA's request to change the commands on record, the criterion fails without a Bug, as one whose plan commands fail does.
  const verdicts = judged.map((verdict): Verdict => {
    const disputedIn = vacuous(verdict) ? requestOn(raised, planId, verdict.ac) : verdict.status === 'failing' ? disputed(verdict, raised, planId) : undefined;
    return disputedIn === undefined ? verdict : { ...verdict, status: 'failing', disputedIn };
  });

  const reportId = `QA-REPORT-M${milestone}-${round}`;
  const notedOn = ({ ac, status }: Verdict) => (status === 'passing' ? output.bugs.filter((bug) => bug.ac === ac).map(({ title, description }) => `${oneLine(title)}: ${oneLine(description)}`) : []);
  const report = [`# QA report: milestone ${milestone}, round ${round}`, '', quoted(output.summary), '', ...verdicts.flatMap((verdict) => reportSection(verdict, notedOn(verdict), guarded(verdict.ac)))].join('\n');
  const record: QaRecord = { summary: output.summary, verdicts: verdicts.map((verdict) => ({ ac: verdict.ac, status: verdict.status, notes: verdict.notes, noted: notedOn(verdict) })) };
  const publish: NewVersion[] = [{ id: reportId, type: 'qa_report', status: 'approved', ownerRole: 'qa_engineer', approvedBy: 'owner:qa_engineer', milestone, derivedFrom: ctx.order.inputs, fields: { data: record }, body: report }];

  const failing = verdicts.filter(({ status, disputedIn }) => status === 'failing' && disputedIn === undefined);
  if (failing.length > 0) {
    const tech = await artifacts.latest(project.id, techId(milestone));
    if (!tech) throw new Error(`QA task ${task.ticket_id} found failures, but milestone ${milestone} has no Tech Design`);
    let k = await nextBugNumber(ctx.deps, project, milestone);
    for (const verdict of failing) {
      const { ac, runs } = verdict;
      const criterion = criteria.find(({ ac_id }) => ac_id === ac);
      if (!criterion) throw new Error(`${ac} passed validation with no criterion behind it`);
      const specPin = `${specId(milestone)}@${criterion.spec_version}#${ac.toLowerCase()}`;
      const filed = output.bugs.filter((bug) => bug.ac === ac);
      for (const bug of filed.length > 0 ? filed : [undefined]) {
        const title = bug?.title ?? `${ac} failed verification`;
        const touches = bug && bug.touches.length > 0 ? bug.touches : ['**'];
        // A play run is no command for an Engineer's checks to run, so a Bug it alone fails is proved by the profile's own test command.
        const proof = site && runs.some(isPlayRun) ? nonBlank([site.profile.commands.test]) : [];
        const fallbacks = [failedCommands(runs), nonBlank(bug?.commands ?? []), proof, shellRuns(runs).map(({ command }) => command), [criterion.verification.how]];
        const definition_of_done = fallbacks.find((commands) => commands.length > 0) ?? [];
        publish.push(bugDoc(milestone, k, reportId, verdict, bug, title, touches));
        publish.push(bugTicket(milestone, k, { acs: [ac], title, touches, definition_of_done, techPin: `${tech.artifact_id}@${tech.version}`, specPin }));
        k += 1;
      }
    }
  }

  return withRaised(ctx, { message: `milestone ${milestone}: QA round ${round}`, publish }, async (s, rows) => {
    const version = rows.find((row) => row.artifact_id === reportId)?.version;
    for (const { ac, status } of verdicts) {
      await s.recordVerification(project.id, milestone, ac, { status, evidenceRef: `${reportId}@${version}#${ac.toLowerCase()}`, verifiedBy: { kind: 'qa_verify', taskId: task.id } });
    }
  }, raised);
};
