import { parsePin } from '../../artifacts/format.ts';
import { componentCoverage, coverageTable, type ComponentCoverage } from '../../checks/coverage.ts';
import { diffStatuses, ensureIntegrationBranch, mergeBase } from '../../git/workspace.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow } from '../store.ts';
import { knownTickets, ownedDoc } from './design.ts';
import { engReviewId, techId } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';
import { structureOf, type PerformanceBudget, type TechStructure } from './tech-structure.ts';
import { ticketIdFor, validateTickets, type TicketDraft } from './tickets.ts';
import { oneLine, quoted } from './text.ts';

export type PerformanceResult = { metric: string; target: string; measured: string; status: 'met' | 'missed' | 'unmeasured'; evidence: string };
export type EngFinding = { severity: 'critical' | 'major' | 'minor'; file: string; line: number | null; issue: string };
// What the conductor and CP4 read back from the review. The rest is in its body.
export type EngReviewData = { verdict: 'approve' | 'polish'; performance: PerformanceResult[]; findings: EngFinding[] };
type EngReviewOutput = EngReviewData & { summary: string; polish_tickets: TicketDraft[]; stakeholder_note: string };

const SHOWN = 5;

// What the milestone's work changed, by component: from where its integration branch left the base, wherever the base
// has moved since, to the branch's head. A Tech Design without components has nothing to measure against.
export async function milestoneCoverage(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, n: number): Promise<{ from: string; to: string; rows: ComponentCoverage[] }> {
  const { branch, headSha: to } = await ensureIntegrationBranch(project.repo_path, n, project.base_branch);
  const from = await mergeBase(project.repo_path, `refs/heads/${project.base_branch}`, `refs/heads/${branch}`);
  const tech = await deps.artifacts.latest(project.id, techId(n));
  const structure = tech ? structureOf(await deps.artifacts.read(project, techId(n))) : undefined;
  return { from, to, rows: structure ? componentCoverage(await diffStatuses(project.repo_path, from, to), structure.components) : [] };
}

// The Tech Design the review's work order pinned, which is the one the worker read, or the latest when it pins none.
async function reviewedDesign(ctx: ApplyCtx): Promise<TechStructure | undefined> {
  const id = techId(ctx.task.milestone);
  const pinned = ctx.order.inputs.map(parsePin).find((pin) => pin.id === id && pin.version !== undefined);
  if (!pinned && !(await ctx.deps.artifacts.latest(ctx.project.id, id))) return undefined;
  return structureOf(await ctx.deps.artifacts.read(ctx.project, pinned ? `${id}@${pinned.version}` : id));
}

const sameMetric = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Each of the design's budgets is reported once, so none goes unchecked and none has two answers. A metric the design
// doesn't name is the Eng Lead's own measure, and stays.
function budgetProblems(budgets: PerformanceBudget[], reported: PerformanceResult[]): string[] {
  return budgets.flatMap(({ metric }) => {
    const count = reported.filter((result) => sameMetric(result.metric, metric)).length;
    if (count === 0) return [`missing budget "${metric}": report each of the Tech Design's budgets, by its metric`];
    return count > 1 ? [`"${metric}" reported ${count === 2 ? 'twice' : `${count} times`}`] : [];
  });
}

const where = ({ file, line }: EngFinding) => `${oneLine(file)}${line === null ? '' : `:${line}`}`;
const findingLine = (finding: EngFinding) => `- ${oneLine(finding.severity)} ${where(finding)}: ${oneLine(finding.issue)}`;
const cell = (text: string) => oneLine(text).replaceAll('|', '\\|');
const changed = (paths: string[]) => `${paths.slice(0, SHOWN).join(', ')}${paths.length > SHOWN ? ` and ${paths.length - SHOWN} more` : ''}`;

function verdictProblems({ verdict, findings, polish_tickets }: EngReviewOutput, rows: ComponentCoverage[]): string[] {
  if (verdict === 'polish') return polish_tickets.length === 0 ? ['polish needs at least one polish ticket'] : [];
  const problems: string[] = [];
  if (polish_tickets.length > 0) problems.push('approve needs no polish tickets: file them with polish');
  const critical = findings.filter(({ severity }) => severity === 'critical');
  if (critical.length > 0) problems.push(`approve needs no critical finding: ${critical.map((finding) => `${where(finding)}: ${oneLine(finding.issue)}`).join('; ')}`);
  // The engine's measure, not the Eng Lead's word: a component whose sources changed with no test and no reason is not done.
  const untested = rows.filter((row) => row.untested);
  if (untested.length > 0) problems.push(`approve needs a test for every changed component: ${untested.map(({ name, sourceChanges }) => `${name} changed ${changed(sourceChanges)}`).join('; ')}. File a polish ticket that adds the tests.`);
  return problems;
}

function engReviewBody(output: EngReviewOutput, n: number, k: number, coverage: { from: string; to: string; rows: ComponentCoverage[] }): string {
  const { verdict, summary, performance, findings, polish_tickets } = output;
  return [
    `# Eng review of milestone ${n}, round ${k}`,
    '',
    '## Verdict',
    '',
    verdict,
    '',
    '## Summary',
    '',
    quoted(summary),
    '',
    '## Performance',
    '',
    '| Metric | Target | Measured | Status | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...performance.map(({ metric, target, measured, status, evidence }) => `| ${[metric, target, measured, status, evidence].map(cell).join(' | ')} |`),
    '',
    ...(findings.length > 0 ? ['## Findings', '', ...findings.map(findingLine), ''] : []),
    '## Test coverage',
    '',
    `The engine's measure of ${coverage.from.slice(0, 7)}..${coverage.to.slice(0, 7)}, the milestone's work on its integration branch.`,
    '',
    coverage.rows.length > 0 ? coverageTable(coverage.rows) : 'The Tech Design names no components.',
    '',
    ...(polish_tickets.length > 0 ? ['## Polish tickets', '', ...polish_tickets.map(({ key, title }) => `- ${ticketIdFor(n, oneLine(key))}: ${oneLine(title)}`), ''] : []),
  ].join('\n');
}

// The Eng Lead's review of the milestone's code once QA has passed it. Approve takes it on to the PM; polish files E
// tickets, which the conductor builds while the polish rounds last.
export const applyEngReview: Applier = async (ctx) => {
  const output = ctx.output as EngReviewOutput;
  const { verdict, summary, performance, findings, polish_tickets } = output;
  if (summary.trim() === '') return { ok: false, evidence: 'The review has no summary' };

  const { store } = ctx.deps;
  const n = ctx.task.milestone;
  const m = await store.getMilestone(ctx.project.id, n);
  if (!m) throw new Error(`Eng review ${ctx.task.ticket_id} has no milestone ${n}`);
  const id = engReviewId(n, m.verify_round);

  const design = await reviewedDesign(ctx);
  const coverage = await milestoneCoverage(ctx.deps, ctx.project, n);
  const body = engReviewBody(output, n, m.verify_round, coverage);

  const problems = [...budgetProblems(design?.performance ?? [], performance), ...verdictProblems(output, coverage.rows)];
  const acIds = (await store.listCriteria(ctx.project.id, n)).map(({ ac_id }) => ac_id);
  const validated = await validateTickets(ctx, n, polish_tickets, acIds, await knownTickets(ctx), { prefix: 'E', docId: id, owner: 'eng_lead', ...(design ? { components: design.components } : {}) }, body);
  if (!validated.ok) problems.push(validated.evidence);
  if (problems.length > 0 || !validated.ok) return { ok: false, evidence: problems.join('\n') };

  const review = { ...ownedDoc(ctx, { id, type: 'eng_review', owner: 'eng_lead' }, body), fields: { data: { verdict, performance, findings } } };
  return withRaised(ctx, { message: `milestone ${n}: eng review ${m.verify_round}`, publish: [review, ...validated.docs] });
};
