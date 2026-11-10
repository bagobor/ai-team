import type { Ledger, LedgerRun, LedgerVisit } from '../../../src/engine/ledger.ts';

// Names and wording for the iteration ledger: how a visit, a run and a question read to the stakeholder.

const STAGE_NAME: Record<string, string> = {
  intake: 'Intake',
  prototype: 'Prototype',
  discovery: 'Discovery',
  cp1: 'CP1',
  spec: 'Spec',
  cp2: 'CP2',
  design: 'Design',
  build: 'Build',
  verify: 'QA verify',
  eng_review: 'Eng review',
  milestone_review: 'Milestone review',
  cp4: 'CP4',
  merging: 'Merging',
  merged: 'Merged',
  active: 'Milestones',
  closed: 'Closed',
  halted: 'Halted',
};

const PURPOSE: Record<string, string> = {
  prototype_plan: 'prototype plan',
  discovery: 'discovery',
  environment_profile: 'environment profile',
  milestone_spec: 'spec',
  tech_design: 'tech design',
  test_plan: 'test plan',
  ticket_scope: 'ticket scope',
  cr_recommendation: 'change request advice',
  code_review: 'code review',
  revise_scope: 'revise scope',
  revise_test_plan: 'revise test plan',
  revise_design: 'revise design',
  qa_verify: 'QA verify',
  eng_review: 'eng review',
  milestone_review: 'milestone review',
};

const FAILURE: Record<string, string> = {
  check_failed: 'checks failed',
  invalid_output: 'invalid output',
  context_over_budget: 'context over budget',
  tests_missing: 'tests missing',
  no_changes: 'no changes',
  changes_requested: 'sent back by review',
};

const OUTCOME: Record<LedgerRun['outcome'], string> = { ok: 'passed', fail: 'failed', back: 'sent back by review', run: 'running', idle: 'not run' };

const ROLE_CHIP: Record<string, string> = { pm: 'PM', tech_lead: 'TL', eng_lead: 'EL', qa_engineer: 'QA', engineer: 'EN', code_reviewer: 'CR', stakeholder: 'YOU' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

// Longer quotes fold, so one comment can't push the rest of the table out of sight.
const QUOTE_FOLD = 220;
const QUOTE_SHOWN = 180;

export const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

export const stageName = (stage: string) => STAGE_NAME[stage] ?? stage;

export const purposeLabel = (purpose: string | null) => (purpose === null ? 'ticket' : (PURPOSE[purpose] ?? purpose.replaceAll('_', ' ')));

export const roleChip = (roleId: string) => ROLE_CHIP[roleId] ?? roleId.slice(0, 3).toUpperCase();

export const answerLabel = (answer: string) => answer.replaceAll('_', ' ');

export function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return `${Math.max(1, Math.round(seconds))} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${pad(minutes % 60)} min` : `${Math.round(hours / 24)} days`;
}

export const dollars = (usd: number | null) => (usd === null ? '–' : `$${usd.toFixed(2)}`);

export function when(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function runLabel(run: LedgerRun): string {
  const outcome = run.outcome === 'fail' && run.failureKind !== null ? (FAILURE[run.failureKind] ?? run.failureKind.replaceAll('_', ' ')) : OUTCOME[run.outcome];
  return `${run.review ? 'Review' : 'Attempt'} ${run.k}: ${outcome}, ${duration(run.seconds)}, ${dollars(run.usdEst)}`;
}

// What the stakeholder sees of a long quote before opening it, or null when it is short enough to show whole.
export function foldedQuote(text: string): string | null {
  return text.length > QUOTE_FOLD ? `${text.slice(0, QUOTE_SHOWN).trimEnd()}…` : null;
}

export type Then = { tag: 'ok' | 'run' | 'back' | null; text: string };

// Where a visit went next: merged, still going, back to an earlier stage, or on to the next one.
export function thenOf(visit: Pick<LedgerVisit, 'stage' | 'to' | 'exit' | 'back'>): Then {
  if (visit.stage === 'merged') return { tag: 'ok', text: 'merged' };
  if (visit.to === null || visit.exit === null) return { tag: 'run', text: 'in progress' };
  if (visit.back) return { tag: 'back', text: `back to ${stageName(visit.exit)}` };
  return { tag: null, text: stageName(visit.exit) };
}

export type LedgerTotals = { runs: number; failed: number; usdEst: number | null; decisions: number; loops: number };

export function ledgerTotals({ sections }: Pick<Ledger, 'sections'>): LedgerTotals {
  const costs = sections.map(({ usdEst }) => usdEst).filter((usd): usd is number => usd !== null);
  return {
    runs: sections.reduce((n, { runs }) => n + runs, 0),
    failed: sections.reduce((n, { failed }) => n + failed, 0),
    usdEst: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    decisions: sections.reduce((n, { decisions }) => n + decisions, 0),
    loops: sections.reduce((n, { loops }) => n + loops, 0),
  };
}
