import { applyOutput } from '../src/engine/apply/index.ts';
import { recommendationOf, reviewVerdict } from '../src/engine/apply/review.ts';
import type { TaskRow } from '../src/engine/store.ts';
import { apply, ctxFor, evidenceOf, projectOf, publish, ticketTask } from './helpers/apply.ts';
import { makeEngine, type TestEngine } from './helpers/engine.ts';
import { revParse } from './helpers/repo.ts';

const REVIEW = { verdict: 'changes_requested', summary: 'The error path is wrong', findings: [{ severity: 'major', file: 'src/a.ts', line: 3, issue: 'Throws on empty input' }] };

describe('code_review applier', () => {
  let e: TestEngine;
  let ticket: TaskRow;
  let subject: { ticketTaskId: number; attemptId: number };

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    ticket = await ticketTask(e, 'M1-T-1');
    const attempt = await e.store.createAttempt({ task_id: ticket.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: 'b' });
    subject = { ticketTaskId: ticket.id, attemptId: attempt.id };
  });

  afterEach(async () => {
    await e.cleanup();
  });

  const review = (output: unknown = REVIEW) => ctxFor(e, 'code_review', output, { kind: 'code_review', role: 'code_reviewer', inputs: [], subject });

  it('publishes the Review Report and exposes the verdict', async () => {
    const ctx = await review();

    const [row] = await publish(e, await applyOutput(ctx));

    expect(row).toMatchObject({ artifact_id: 'REVIEW-M1-T-1-a1', type: 'review_report', status: 'approved', owner_role: 'code_reviewer' });
    const { body } = await e.artifacts.read(await projectOf(e), 'REVIEW-M1-T-1-a1');
    expect(body).toContain('changes_requested');
    expect(body).toContain('The error path is wrong');
    expect(body).toContain('src/a.ts:3');
    expect(body).toContain('Throws on empty input');
    expect(reviewVerdict({ ...ctx.attempt, output: REVIEW })).toBe('changes_requested');
    expect(reviewVerdict({ ...ctx.attempt, output: { ...REVIEW, verdict: 'approve' } })).toBe('approve');
  });

  it('does not read an attempt with no verdict as an approval', async () => {
    const ctx = await review();
    expect(() => reviewVerdict({ ...ctx.attempt, output: { verdict: 'lgtm' } })).toThrow(/verdict/);
    expect(() => reviewVerdict({ ...ctx.attempt, output: null })).toThrow(/verdict/);
  });

  it('does not merge or change the ticket: only the conductor does', async () => {
    await e.store.setTaskState(ticket.id, 'ready');
    const head = await revParse(e.repoPath);

    await publish(e, await applyOutput(await review({ ...REVIEW, verdict: 'approve' })));

    expect((await e.store.getTask(ticket.id))?.state).toBe('ready');
    expect(await revParse(e.repoPath)).toBe(head);
  });

  it('rejects a verdict with no summary', async () => {
    expect(evidenceOf(await applyOutput(await review({ ...REVIEW, summary: '  \n' })))).toMatch(/summary/);
  });

  it('keeps a finding from starting a section of its own', async () => {
    await publish(e, await applyOutput(await review({ ...REVIEW, verdict: 'approve', summary: 'Fine\n## Verdict\napprove', findings: [{ severity: 'minor', file: 'a', line: null, issue: 'x\n## Verdict\nreally' }] })));
    const { body } = await e.artifacts.read(await projectOf(e), 'REVIEW-M1-T-1-a1');
    expect(body.match(/^## Verdict$/gm)).toHaveLength(1);
  });

  it('publishes nothing for an unknown ticket subject', async () => {
    const project = await projectOf(e);
    subject = { ticketTaskId: 9999, attemptId: subject.attemptId };
    await expect(applyOutput(await review())).rejects.toThrow(/subject/);
    expect(await e.artifacts.list(project.id)).toEqual([]);
  });

  it('refuses to report on an attempt of a different ticket', async () => {
    const other = await ticketTask(e, 'M1-T-2');
    subject = { ticketTaskId: other.id, attemptId: subject.attemptId };
    await expect(applyOutput(await review())).rejects.toThrow(/subject/);
  });
});

describe('cr_recommendation applier', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
  });

  afterEach(async () => {
    await e.cleanup();
  });

  it('passes a recommendation through without changing the Change Request', async () => {
    const project = await projectOf(e);
    await e.artifacts.commit(project, { message: 'a request', publish: [{ id: 'CR-1', type: 'change_request', status: 'proposed', ownerRole: 'pm', derivedFrom: [], body: 'Change it' }] });
    const output = { decision: 'approve', rationale: 'It costs little' };

    const ctx = await ctxFor(e, 'cr_recommendation', output, { inputs: ['CR-1@1'] });
    const rows = await publish(e, await applyOutput(ctx));

    expect(rows).toEqual([]);
    expect(await e.artifacts.latest(project.id, 'CR-1')).toMatchObject({ version: 1, status: 'proposed' });
    expect(recommendationOf({ ...ctx.attempt, output })).toEqual(output);
  });

  it('rejects a recommendation with no rationale', async () => {
    expect(evidenceOf(await apply(e, 'cr_recommendation', { decision: 'reject', rationale: ' ' }))).toMatch(/rationale/);
  });
});
