import { AC_ID, AC_SLUG, type Criterion } from '../../artifacts/acs.ts';
import { parsePin, sectionsOf } from '../../artifacts/format.ts';
import { reviewId, specId } from './ids.ts';
import type { Applier } from './index.ts';
import { withRaised } from './raised.ts';
import { oneLine } from './text.ts';

type SpecOutput = { body: string; criteria: Criterion[] };
type ReviewOutput = { body: string; known_issues: string[]; deviations: string[] };


const CRITERIA_HEADING = 'Acceptance criteria';
const criterionSection = ({ id, text, verification }: Criterion) => `### ${id}\n\n${text.trim()}\n\nVerified by: ${verification.how}\n`;

// The engine writes these sections so that #ac-1 always resolves, which leaves nothing in the body or a criterion
// that may look like one: a ticket pinned to it would follow the forgery.
function specBody(body: string, criteria: Criterion[]): string {
  return `${body.trimEnd()}\n\n## ${CRITERIA_HEADING}\n\n${criteria.map(criterionSection).join('\n')}`;
}

// The PM may write a section under the same heading, which then takes the plain slug. The engine's always comes last.
export function criteriaSlug(body: string): string | undefined {
  return sectionsOf(body).filter(({ level, title }) => level === 2 && title === CRITERIA_HEADING).at(-1)?.slug;
}

function specProblems(body: string, criteria: Criterion[], locked: { ac_id: string; text: string }[]): string[] {
  const problems: string[] = [];
  if (criteria.length === 0) problems.push('The spec has no acceptance criteria');

  const seen = new Set<string>();
  for (const { id, text, verification } of criteria) {
    if (!AC_ID.test(id)) problems.push(`${id} is not a criterion id like AC-1`);
    if (seen.has(id)) problems.push(`${id} appears twice`);
    seen.add(id);
    if (text.trim() === '') problems.push(`${id} has no text`);
    if (verification.method !== 'automated') problems.push(`${id} must be verified by an automated method`);
  }

  for (const { slug, title } of sectionsOf(body)) if (AC_SLUG.test(slug)) problems.push(`The body has its own criterion heading, ${JSON.stringify(title)}: the engine writes those`);

  if (locked.length > 0) {
    const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
    for (const { ac_id, text } of locked) {
      const criterion = byId.get(ac_id);
      if (!criterion) problems.push(`${ac_id} is locked, so it can't be dropped. Raise a Change Request instead`);
      else if (criterion.text !== text) problems.push(`${ac_id} is locked, so its text can't change. Raise a Change Request instead`);
    }
    for (const { id } of criteria) if (!locked.some(({ ac_id }) => ac_id === id)) problems.push(`${id} is new, and this milestone's criteria are locked. Raise a Change Request instead`);
  }

  if (problems.length === 0) {
    const found = sectionsOf(specBody(body, criteria)).map(({ slug }) => slug).filter((slug) => AC_SLUG.test(slug));
    const wanted = criteria.map(({ id }) => id.toLowerCase());
    if (found.join() !== wanted.join()) problems.push(`The body or a criterion's text breaks the criterion sections: expected ${criteria.map(({ id }) => id).join(', ')}, found ${found.join(', ') || 'none'}`);
  }
  return problems;
}

export const applyMilestoneSpec: Applier = async (ctx) => {
  const { body, criteria } = ctx.output as SpecOutput;
  const { milestone } = ctx.task;
  const locked = await ctx.deps.store.listCriteria(ctx.project.id, milestone);

  const problems = specProblems(body, criteria, locked);
  if (problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  return withRaised(ctx, {
    message: `milestone ${milestone}: spec`,
    publish: [
      {
        id: specId(milestone),
        type: 'spec',
        status: 'proposed',
        ownerRole: 'pm',
        derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== specId(milestone)),
        milestone,
        body: specBody(body, criteria),
        acceptanceCriteria: criteria.map(({ id }) => id),
        fields: { data: { criteria } },
      },
    ],
  });
};

const cell = (text: string) => oneLine(text).replaceAll('|', '\\|');

const bulletSection = (title: string, items: string[]) => (items.length > 0 ? [`## ${title}`, '', ...items.map((item) => `- ${oneLine(item)}`), ''] : []);
const ENGINE_REVIEW_SECTIONS = new Set(['acceptance-criteria', 'known-issues', 'deviations', 'cost-and-time']);

export const applyMilestoneReview: Applier = async (ctx) => {
  const { body, known_issues, deviations } = ctx.output as ReviewOutput;
  const { store } = ctx.deps;
  const { milestone } = ctx.task;
  if (body.trim() === '') return { ok: false, evidence: 'The Milestone Review has an empty body' };
  const forged = sectionsOf(body).find(({ slug }) => ENGINE_REVIEW_SECTIONS.has(slug));
  if (forged) return { ok: false, evidence: `The Milestone Review body has its own heading "${forged.title}", which only the engine writes` };

  const criteria = await store.listCriteria(ctx.project.id, milestone);
  const tasks = (await store.listTasks(ctx.project.id)).filter((task) => task.milestone === milestone);
  const totals = await store.attemptTotals();

  let usd: number | null = null;
  let seconds = 0;
  for (const task of tasks) {
    const total = totals.get(task.id);
    if (total?.usdEst != null) usd = (usd ?? 0) + total.usdEst;
    seconds += total?.seconds ?? 0;
  }

  // The engine's sections come first, so nothing in the model's body (an unclosed fence, a table of its own) can swallow or pre-empt them.
  const composed = [
    '## Acceptance criteria',
    '',
    '| Criterion | Status | Evidence |',
    '| --- | --- | --- |',
    ...criteria.map(({ ac_id, text, status, evidence_ref }) => `| ${ac_id}: ${cell(text)} | ${status} | ${cell(evidence_ref ?? '')} |`),
    '',
    ...bulletSection('Known issues', known_issues),
    ...bulletSection('Deviations', deviations),
    '## Cost and time',
    '',
    `Cost (estimate): ${usd === null ? 'unknown' : `$${usd.toFixed(2)}`}`,
    `Worker time (estimate): ${Math.round(seconds / 60)} min`,
    '',
    '## Review',
    '',
    body.trimEnd(),
    '',
  ].join('\n');

  return withRaised(ctx, {
    message: `milestone ${milestone}: review`,
    publish: [{ id: reviewId(milestone), type: 'milestone_review', status: 'proposed', ownerRole: 'pm', derivedFrom: ctx.order.inputs, milestone, body: composed, fields: { data: { known_issues, deviations } } }],
  });
};
