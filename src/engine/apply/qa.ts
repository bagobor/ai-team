import { isHumanCheck } from '../../artifacts/acs.ts';
import type { NewVersion } from '../../artifacts/store.ts';
import { runSandboxed, type CheckRun } from '../../checks/run-checks.ts';
import { requestOf } from '../change-requests.ts';
import { addAttemptWorktree, mergeBase, overlayPaths, removeAttemptWorktree } from '../../git/workspace.ts';
import { worktreePath } from '../../paths.ts';
import { protectedPaths } from '../protected.ts';
import type { Coverage } from './design.ts';
import { ENV_PROFILE, specId, techId, testPlanId } from './ids.ts';
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

const failedCommands = (runs: CheckRun[]) => runs.filter((run) => run.exitCode !== 0).map((run) => run.command);
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

async function nextBugNumber(ctx: ApplyCtx, milestone: number): Promise<number> {
  const pattern = new RegExp(`^(?:BUG-M${milestone}|M${milestone}-B)-(\\d+)$`);
  const artifacts = await ctx.deps.artifacts.list(ctx.project.id);
  const tasks = await ctx.deps.store.listTasks(ctx.project.id);
  const taken = [...artifacts.map((row) => row.artifact_id), ...tasks.map((task) => task.ticket_id)];
  return 1 + Math.max(0, ...taken.map((id) => Number(pattern.exec(id)?.[1] ?? 0)));
}

async function approvedSetup(ctx: ApplyCtx): Promise<string | null> {
  const { artifacts } = ctx.deps;
  const row = await artifacts.latest(ctx.project.id, ENV_PROFILE);
  if (row?.status !== 'approved' && row?.status !== 'stale') return null;
  const { setup } = (await artifacts.read(ctx.project, ENV_PROFILE)).fields.data as { setup: string | null };
  return setup;
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

const STOPPED = { ok: false as const, evidence: 'QA verification was stopped before it finished' };

// Setup is the one step that gets the network. Nothing comes back when the profile has none.
async function runSetup(ctx: ApplyCtx, worktree: string) {
  const setup = await approvedSetup(ctx);
  return setup ? runSandboxed({ ...sandboxEnv(ctx, worktree), commands: [setup], network: true }) : undefined;
}

const plannedFor = (coverage: Coverage[], ac: string) => [...new Set(nonBlank(coverage.filter((entry) => entry.ac === ac).flatMap((entry) => entry.commands)))];

async function verifyAll(ctx: ApplyCtx, worktree: string, results: QaResult[], coverage: Coverage[]): Promise<{ ok: true; verdicts: Verdict[] } | { ok: false; evidence: string }> {
  const installed = await runSetup(ctx, worktree);
  if (installed && !installed.ok) return ctx.signal.aborted ? STOPPED : { ok: false, evidence: `The Environment Profile's setup failed, so nothing could be verified.\n${installed.evidence}` };

  // Every Test Plan command goes before any of QA's, which share this worktree and could otherwise rewrite the tests they run.
  const planned = new Map<string, CheckRun[]>();
  for (const { ac } of results) {
    planned.set(ac, await runEach(ctx, worktree, plannedFor(coverage, ac)));
    if (ctx.signal.aborted) return STOPPED;
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
async function verifyOnBase(ctx: ApplyCtx, held: string[], coverage: Coverage[]): Promise<{ ok: true; onBase: Map<string, OnBase> } | typeof STOPPED> {
  const { project, task } = ctx;
  const head = verifiedHead(ctx);
  const sha = await mergeBase(project.repo_path, head, `refs/heads/${project.base_branch}`);
  const globs = (await protectedPaths(ctx.deps, project, task.milestone)).map(({ glob }) => glob);

  return inFreshWorktree(
    ctx,
    async (worktree): Promise<{ ok: true; onBase: Map<string, OnBase> } | typeof STOPPED> => {
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

      for (const ac of held) {
        const runs = await runEach(ctx, worktree, plannedFor(coverage, ac));
        if (ctx.signal.aborted) return STOPPED;
        // A run that timed out or was stopped has no exit code of 0, so it is red like any other failure.
        onBase.set(ac, { sha, runs, red: runs.some((run) => run.exitCode !== 0) });
      }
      return { ok: true, onBase };
    },
    sha,
  );
}

const outcomeOf = ({ timedOut, exitCode }: CheckRun) => (timedOut ? 'timed out' : exitCode === null ? 'was stopped' : `exit code ${exitCode}`);

const runLines = (runs: CheckRun[]) =>
  runs.length === 0
    ? ['No command ran.', '']
    : runs.flatMap((run) => [`Command, ${outcomeOf(run)}:`, '', fenced(run.command), '', ...(run.outputTail.trim() === '' ? ['No output.'] : ['Output:', '', fenced(run.outputTail.slice(-OUTPUT_TAIL))]), '']);

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
export function bugTicket(milestone: number, k: number, bug: { ac: string; title: string; touches: string[]; definition_of_done: string[]; techPin: string; specPin: string }): NewVersion {
  const key = `B-${k}`;
  const id = ticketIdFor(milestone, key);
  const inputs = [`BUG-M${milestone}-${k}@1`, bug.techPin];
  const { fields, body } = renderTicket(
    milestone,
    { key, title: oneLine(bug.title), ac_refs: [bug.ac], specialty: 'engineer', touches: bug.touches, depends_on: [], definition_of_done: bug.definition_of_done, inputs, size: 'S', body: `Fix what BUG-M${milestone}-${k} describes, so that ${bug.ac} passes.\n` },
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

  const verified = await inFreshWorktree(ctx, (worktree) => verifyAll(ctx, worktree, output.results, coverage));
  if (!verified.ok) return verified;

  // A criterion that failed on the verified commit has nothing to compare, so only the ones that held go to the base.
  const held = verified.verdicts.filter(({ status }) => status === 'passing').map(({ ac }) => ac);
  const base = held.length === 0 ? undefined : await verifyOnBase(ctx, held, coverage);
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
    .map(({ ac, onBase }) => `${ac}'s Test Plan commands pass on the base too (${onBase.sha.slice(0, 7)}), so they don't show this milestone's work. Raise a Change Request on ${ac}'s Test Plan commands with commands that fail without the work, or, if the criterion is meant to hold already, one that proposes the same commands, which makes the entry a regression guard.`);
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
    let k = await nextBugNumber(ctx, milestone);
    for (const verdict of failing) {
      const { ac, runs } = verdict;
      const criterion = criteria.find(({ ac_id }) => ac_id === ac);
      if (!criterion) throw new Error(`${ac} passed validation with no criterion behind it`);
      const specPin = `${specId(milestone)}@${criterion.spec_version}#${ac.toLowerCase()}`;
      const filed = output.bugs.filter((bug) => bug.ac === ac);
      for (const bug of filed.length > 0 ? filed : [undefined]) {
        const title = bug?.title ?? `${ac} failed verification`;
        const touches = bug && bug.touches.length > 0 ? bug.touches : ['**'];
        const fallbacks = [failedCommands(runs), nonBlank(bug?.commands ?? []), runs.map(({ command }) => command), [criterion.verification.how]];
        const definition_of_done = fallbacks.find((commands) => commands.length > 0) ?? [];
        publish.push(bugDoc(milestone, k, reportId, verdict, bug, title, touches));
        publish.push(bugTicket(milestone, k, { ac, title, touches, definition_of_done, techPin: `${tech.artifact_id}@${tech.version}`, specPin }));
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
