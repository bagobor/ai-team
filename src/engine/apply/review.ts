import type { AttemptRow } from '../store.ts';
import type { Applier } from './index.ts';
import { withRaised } from './raised.ts';
import { oneLine, quoted } from './text.ts';

export type ReviewVerdict = 'approve' | 'changes_requested';
export type Recommendation = { decision: 'approve' | 'reject'; rationale: string };
type Finding = { severity: string; file: string; line: number | null; issue: string };
type ReviewOutput = { verdict: ReviewVerdict; summary: string; findings: Finding[] };

export function reviewVerdict(attempt: AttemptRow): ReviewVerdict {
  const verdict = (attempt.output as Partial<ReviewOutput> | null)?.verdict;
  if (verdict !== 'approve' && verdict !== 'changes_requested') throw new Error(`Attempt ${attempt.id} has no review verdict`);
  return verdict;
}

export function recommendationOf(attempt: AttemptRow): Recommendation {
  const { decision, rationale } = (attempt.output ?? {}) as Partial<Recommendation>;
  if ((decision !== 'approve' && decision !== 'reject') || rationale === undefined) throw new Error(`Attempt ${attempt.id} has no recommendation`);
  return { decision, rationale };
}

const findingLine = ({ severity, file, line, issue }: Finding) => `- ${oneLine(severity)} ${oneLine(file)}${line === null ? '' : `:${line}`}: ${oneLine(issue)}`;

// Publishes what the reviewer said, and nothing more: the conductor reads the verdict and decides what happens to the ticket.
export const applyCodeReview: Applier = async (ctx) => {
  const { verdict, summary, findings } = ctx.output as ReviewOutput;
  if (summary.trim() === '') return { ok: false, evidence: 'The review has no summary' };

  const { store } = ctx.deps;
  const { project, task, order } = ctx;
  const ticket = order.subject ? await store.getTask(order.subject.ticketTaskId) : undefined;
  const reviewed = order.subject ? await store.getAttempt(order.subject.attemptId) : undefined;
  if (!ticket || !reviewed || reviewed.task_id !== ticket.id || ticket.project_id !== project.id) {
    throw new Error(`Review task ${task.ticket_id} has no valid ticket subject`);
  }

  const body = [
    `# Review of ${ticket.ticket_id}, attempt ${reviewed.k}`,
    '',
    '## Verdict',
    '',
    verdict,
    '',
    '## Summary',
    '',
    quoted(summary),
    '',
    ...(findings.length > 0 ? ['## Findings', '', ...findings.map(findingLine), ''] : []),
  ].join('\n');

  return withRaised(ctx, {
    message: `${ticket.ticket_id}: review of attempt ${reviewed.k}`,
    publish: [{ id: `REVIEW-${ticket.ticket_id}-a${reviewed.k}`, type: 'review_report', status: 'approved', ownerRole: task.role_id, approvedBy: `owner:${task.role_id}`, milestone: task.milestone, derivedFrom: order.inputs, fields: { data: { verdict, findings } }, body }],
  });
};

// The recommendation stays on the attempt. The conductor reads it: the Change Request itself changes only when it's applied or rejected.
export const applyCrRecommendation: Applier = async (ctx) => {
  const { rationale } = ctx.output as Recommendation;
  if (rationale.trim() === '') return { ok: false, evidence: 'The recommendation has no rationale' };
  return withRaised(ctx, { message: `${ctx.task.ticket_id}: recommendation`, publish: [] });
};
