import type { NewVersion } from '../../artifacts/store.ts';
import { runSandboxed, type CheckRun } from '../../checks/run-checks.ts';
import { addAttemptWorktree, removeAttemptWorktree } from '../../git/workspace.ts';
import { worktreePath } from '../../paths.ts';
import { ENV_PROFILE, specId, techId, testPlanId } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';
import { sandboxEnv } from './sandbox.ts';
import { fenced, oneLine, quoted } from './text.ts';
import { renderTicket, ticketIdFor, touchesProblem } from './tickets.ts';

type QaResult = { ac: string; status: 'passing' | 'failing'; commands: string[]; notes: string };
type QaBug = { ac: string; title: string; description: string; touches: string[]; commands: string[] };
type QaOutput = { results: QaResult[]; bugs: QaBug[]; summary: string };

// What the engine concludes about a criterion: what QA said is only ever part of it.
type Verdict = { ac: string; claimed: QaResult['status']; status: QaResult['status']; notes: string; runs: CheckRun[] };

const OUTPUT_TAIL = 2000;

const failedCommands = (runs: CheckRun[]) => runs.filter((run) => run.exitCode !== 0).map((run) => run.command);
const nonBlank = (commands: string[]) => commands.map((command) => command.trim()).filter((command) => command !== '');

function outputProblems({ results, bugs }: QaOutput, acIds: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { ac } of results) {
    if (!acIds.includes(ac)) problems.push(`${ac} is not a criterion of this milestone`);
    if (seen.has(ac)) problems.push(`${ac} appears twice in the results`);
    seen.add(ac);
  }
  for (const ac of acIds) if (!seen.has(ac)) problems.push(`${ac} has no result`);

  for (const { ac, title, touches } of bugs) {
    if (!acIds.includes(ac)) problems.push(`A Bug names ${ac}, which is not a criterion of this milestone`);
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

async function inFreshWorktree<T>(ctx: ApplyCtx, work: (worktree: string) => Promise<T>): Promise<T> {
  const { project, task, attempt } = ctx;
  if (attempt.base_sha === null) throw new Error(`QA attempt ${attempt.id} has no base commit`);
  const worktree = worktreePath(ctx.deps.paths, project.name, `${task.ticket_id}-verify`, attempt.k);
  const branch = `aiteam/verify/${task.ticket_id}-a${attempt.k}`;
  await addAttemptWorktree(project.repo_path, worktree, branch, attempt.base_sha);
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

async function verifyAll(ctx: ApplyCtx, worktree: string, results: QaResult[], coverage: { ac: string; commands: string[] }[]): Promise<{ ok: true; verdicts: Verdict[] } | { ok: false; evidence: string }> {
  const setup = await approvedSetup(ctx);
  if (setup) {
    const installed = await runSandboxed({ ...sandboxEnv(ctx, worktree), commands: [setup], network: true });
    if (!installed.ok) return ctx.signal.aborted ? STOPPED : { ok: false, evidence: `The Environment Profile's setup failed, so nothing could be verified.\n${installed.evidence}` };
  }

  const verdicts: Verdict[] = [];
  for (const { ac, status: claimed, commands, notes } of results) {
    const planned = coverage.filter((entry) => entry.ac === ac).flatMap((entry) => entry.commands);
    const runs = await runEach(ctx, worktree, [...new Set(nonBlank([...planned, ...commands]))]);
    if (ctx.signal.aborted) return STOPPED;
    const held = claimed === 'passing' && runs.length > 0 && runs.every((run) => run.exitCode === 0);
    verdicts.push({ ac, claimed, status: held ? 'passing' : 'failing', notes, runs });
  }
  return { ok: true, verdicts };
}

const outcomeOf = ({ timedOut, exitCode }: CheckRun) => (timedOut ? 'timed out' : exitCode === null ? 'was stopped' : `exit code ${exitCode}`);

const runLines = (runs: CheckRun[]) =>
  runs.length === 0
    ? ['No command ran.', '']
    : runs.flatMap((run) => [`Command, ${outcomeOf(run)}:`, '', fenced(run.command), '', ...(run.outputTail.trim() === '' ? ['No output.'] : ['Output:', '', fenced(run.outputTail.slice(-OUTPUT_TAIL))]), '']);

function reportSection({ ac, claimed, status, notes, runs }: Verdict, noted: QaBug[]): string[] {
  return [
    `## ${ac}`,
    '',
    `Status: ${status}`,
    `QA said: ${claimed}`,
    '',
    ...(notes.trim() === '' ? [] : [quoted(notes), '']),
    ...runLines(runs),
    ...(noted.length === 0 ? [] : ['QA also noted, with no ticket opened because the criterion passes:', '', ...noted.map(({ title, description }) => `- ${oneLine(title)}: ${oneLine(description)}`), '']),
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

// QA's claims are only claims: the engine runs its commands and the Test Plan's in a clean checkout, and records what it saw.
export const applyQaVerify: Applier = async (ctx) => {
  const output = ctx.output as QaOutput;
  const { artifacts, store } = ctx.deps;
  const { project, task } = ctx;
  const { milestone } = task;

  const criteria = await store.listCriteria(project.id, milestone);
  const problems = outputProblems(output, criteria.map(({ ac_id }) => ac_id));
  if (problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  const round = (await store.getMilestone(project.id, milestone))?.verify_round;
  if (round === undefined) throw new Error(`QA task ${task.ticket_id} names milestone ${milestone}, which does not exist`);
  const { coverage } = (await artifacts.read(project, testPlanId(milestone))).fields.data as { coverage: { ac: string; commands: string[] }[] };

  const verified = await inFreshWorktree(ctx, (worktree) => verifyAll(ctx, worktree, output.results, coverage));
  if (!verified.ok) return verified;
  const { verdicts } = verified;

  const reportId = `QA-REPORT-M${milestone}-${round}`;
  const report = [`# QA report: milestone ${milestone}, round ${round}`, '', quoted(output.summary), '', ...verdicts.flatMap((verdict) => reportSection(verdict, verdict.status === 'passing' ? output.bugs.filter(({ ac }) => ac === verdict.ac) : []))].join('\n');
  const publish: NewVersion[] = [{ id: reportId, type: 'qa_report', status: 'approved', ownerRole: 'qa_engineer', approvedBy: 'owner:qa_engineer', milestone, derivedFrom: ctx.order.inputs, body: report }];

  const failing = verdicts.filter(({ status }) => status === 'failing');
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
  });
};
