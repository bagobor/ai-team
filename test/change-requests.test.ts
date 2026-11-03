import { sectionsOf, sectionText } from '../src/artifacts/format.ts';
import { applyOutput } from '../src/engine/apply/index.ts';
import type { NewVersion } from '../src/artifacts/store.ts';
import { applyChangeRequest, ChangeRequestError, changeRequestDocs, fileChangeRequest, ownerOf, rejectChangeRequest, touchesCriterionText, type ChangeRequestInput } from '../src/engine/change-requests.ts';
import { addProject } from '../src/engine/intake.ts';
import type { ProjectRow } from '../src/engine/store.ts';
import { apply, CRITERIA, ctxFor, evidenceOf, lockSpec, projectOf, publish, ticketTask } from './helpers/apply.ts';
import { makeEngine, okStep, runOnce, runToSettled, ticket, type TestEngine } from './helpers/engine.ts';
import { makeRepo } from './helpers/repo.ts';

const BODY = '# Design\n\n## Approach\n\nThe old approach.\n\n## Risks\n\nThere are some.\n\n## Notes\n\nNothing yet.\n';

const asked = { proposed_text: 'There are none.', rationale: 'We removed them', evidence: 'The spike in src/spike.ts', raised_by: 'engineer' };
const onSection = (overrides: Partial<ChangeRequestInput> = {}): ChangeRequestInput => ({ ...asked, target_artifact: 'TECH-M1', target_section: 'risks', ...overrides });
const onCriterion = (overrides: Partial<ChangeRequestInput> = {}): ChangeRequestInput => ({ ...asked, target_artifact: 'SPEC-M1', target_ac: 'AC-1', proposed_text: 'The first thing works twice', ...overrides });
const onCommands = (overrides: Partial<ChangeRequestInput> = {}): ChangeRequestInput => ({ ...asked, target_artifact: 'TEST-PLAN-M1', target_ac: 'AC-1', proposed_text: 'npm test -- first\nnpm run lint', ...overrides });
const COVERAGE = [
  { ac: 'AC-1', commands: ['npm test -- old'], notes: 'The first check' },
  { ac: 'AC-2', commands: ['npm test -- second'], notes: '' },
];

describe('Change Requests', () => {
  let e: TestEngine;
  let p: ProjectRow;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
    p = await projectOf(e);
  });

  afterEach(() => e.cleanup());

  const latest = (id: string) => e.artifacts.latest(p.id, id);
  const read = (pin: string) => e.artifacts.read(p, pin);
  const document = async (overrides: Partial<NewVersion> = {}) => {
    const [row] = await e.artifacts.commit(p, {
      message: 'a document',
      publish: [{ id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], milestone: 1, body: BODY, ...overrides }],
    });
    return row!;
  };
  const eventsOf = async (type: string) => (await e.log.list({ projectId: p.id })).filter((event) => event.type === type);
  const testPlan = (coverage = COVERAGE) => document({ id: 'TEST-PLAN-M1', type: 'test_plan', ownerRole: 'qa_engineer', body: '# Plan\n\nRun the checks.\n', fields: { data: { coverage } } });
  const coverageOf = async (pin = 'TEST-PLAN-M1') => ((await read(pin)).fields.data as { coverage: typeof COVERAGE }).coverage;

  describe('filing', () => {
    it('files a Change Request with target, proposed text, rationale and evidence', async () => {
      await document();

      const row = await fileChangeRequest(e, p, onSection());

      expect(row).toMatchObject({ artifact_id: 'CR-1', type: 'change_request', status: 'proposed', owner_role: 'tech_lead', milestone: 1, derived_from: ['TECH-M1@1'] });
      const doc = await read('CR-1');
      expect(doc.fields.data).toEqual(onSection());
      expect(doc.body).toContain('There are none.');
      expect(doc.body).toContain('We removed them');
      expect(doc.body).toContain('The spike in src/spike.ts');
    });

    it('numbers Change Requests per project', async () => {
      await document();
      const repo = await makeRepo();
      await addProject(e, { name: 'q', repoPath: repo.path, create: false });
      const q = (await e.store.getProject('q'))!;
      await e.artifacts.commit(q, { message: 'a document', publish: [{ id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], body: BODY }] });

      const ids = [await fileChangeRequest(e, p, onSection()), await fileChangeRequest(e, p, onSection()), await fileChangeRequest(e, q, onSection())].map((row) => row.artifact_id);

      expect(ids).toEqual(['CR-1', 'CR-2', 'CR-1']);
    });

    it('gives two requests filed at once different numbers', async () => {
      await document();

      const rows = await Promise.all([fileChangeRequest(e, p, onSection()), fileChangeRequest(e, p, onSection())]);

      expect(rows.map((row) => row.artifact_id).sort()).toEqual(['CR-1', 'CR-2']);
      expect(rows.map((row) => row.version)).toEqual([1, 1]);
    });

    it('does not reuse a number held by a request that has not been committed yet', async () => {
      await document();

      const { docs } = await changeRequestDocs(e, p, [onSection()]);
      const filed = await fileChangeRequest(e, p, onSection());

      expect(docs.map((doc) => doc.id)).toEqual(['CR-1']);
      expect(filed.artifact_id).toBe('CR-2');
    });

    it('accepts a stale target', async () => {
      await document();
      await e.artifacts.commit(p, { message: 'stale', status: [{ id: 'TECH-M1', status: 'stale', staleSections: ['risks'] }] });

      expect((await fileChangeRequest(e, p, onSection())).derived_from).toEqual(['TECH-M1@1']);
    });

    it('refuses a request against an unapproved document', async () => {
      await document({ status: 'proposed' });

      await expect(fileChangeRequest(e, p, onSection())).rejects.toThrow(ChangeRequestError);
      expect(await latest('CR-1')).toBeUndefined();
    });

    it('refuses a request against a superseded document', async () => {
      await document();
      await e.artifacts.commit(p, { message: 'gone', status: [{ id: 'TECH-M1', status: 'superseded' }] });

      await expect(fileChangeRequest(e, p, onSection())).rejects.toThrow(/superseded/);
    });

    it('refuses a request against a document that does not exist', async () => {
      await expect(fileChangeRequest(e, p, onSection())).rejects.toThrow(/TECH-M1/);
    });

    it.each([
      ['BRIEF', 'brief'],
      ['CHANGE-M1-T-1-a1', 'change_report'],
    ] as const)('refuses a request against %s, which no role can recommend on', async (id, type) => {
      await document({ id, type, ownerRole: 'stakeholder' });

      await expect(fileChangeRequest(e, p, onSection({ target_artifact: id }))).rejects.toThrow(ChangeRequestError);
    });

    it('refuses a request naming a section that does not exist', async () => {
      await document();

      await expect(fileChangeRequest(e, p, onSection({ target_section: 'nope' }))).rejects.toThrow(/nope/);
    });

    it('names the sections the document has when the one named is missing, so the worker can correct it', async () => {
      await document();

      await expect(fileChangeRequest(e, p, onSection({ target_section: 'nope' }))).rejects.toThrow(/approach, risks, notes/);
    });

    it('files a request that names its target by a pin against the document itself', async () => {
      await document();

      const row = await fileChangeRequest(e, p, onSection({ target_artifact: 'TECH-M1@1' }));

      expect(row.derived_from).toEqual(['TECH-M1@1']);
      expect((await read(row.artifact_id)).fields.data).toEqual(onSection());
    });

    it('takes the section from a pin when the request names none', async () => {
      await document();

      const row = await fileChangeRequest(e, p, { ...asked, target_artifact: 'TECH-M1@1#risks' });

      expect((await read(row.artifact_id)).fields.data).toEqual(onSection());
    });

    it('takes the criterion when a request against a spec names a section as well', async () => {
      await lockSpec(e);

      const row = await fileChangeRequest(e, p, onCriterion({ target_section: 'acceptance-criteria' }));

      expect((await read(row.artifact_id)).fields.data).toEqual(onCriterion());
    });

    it('takes the section when a request against a document without criteria names a criterion as well', async () => {
      await document();

      const row = await fileChangeRequest(e, p, onSection({ target_ac: 'AC-1' }));

      expect((await read(row.artifact_id)).fields.data).toEqual(onSection());
    });

    it('refuses a request naming neither a section nor a criterion', async () => {
      await document();

      await expect(fileChangeRequest(e, p, { ...asked, target_artifact: 'TECH-M1' })).rejects.toThrow(/neither/);
    });

    it.each(['proposed_text', 'rationale', 'evidence'] as const)('refuses a request with a blank %s', async (field) => {
      await document();

      await expect(fileChangeRequest(e, p, onSection({ [field]: '  \n' }))).rejects.toThrow(ChangeRequestError);
    });

    it('refuses a criterion the registry does not hold', async () => {
      await lockSpec(e);

      await expect(fileChangeRequest(e, p, onCriterion({ target_ac: 'AC-9' }))).rejects.toThrow(/AC-9/);
    });

    it('refuses a criterion named on anything but a spec or a test plan', async () => {
      await document();

      await expect(fileChangeRequest(e, p, onCriterion({ target_artifact: 'TECH-M1' }))).rejects.toThrow(/holds criteria/);
    });

    it('says who owns the target and whether criteria text is touched', async () => {
      const row = await document();
      await fileChangeRequest(e, p, onSection());

      expect(ownerOf(row)).toBe('tech_lead');
      expect(touchesCriterionText(await read('CR-1'), row)).toBe(false);

      const spec = await lockSpec(e);
      const cr = await fileChangeRequest(e, p, onCriterion());
      expect(touchesCriterionText(await read(cr.artifact_id), spec)).toBe(true);
    });
  });

  describe('a Test Plan criterion', () => {
    it('is a change to its commands, which the plan\'s owner decides', async () => {
      const plan = await testPlan();

      const row = await fileChangeRequest(e, p, onCommands());

      expect(row).toMatchObject({ owner_role: 'qa_engineer', derived_from: ['TEST-PLAN-M1@1'] });
      expect(touchesCriterionText(await read(row.artifact_id), plan)).toBe(false);
      expect((await read(row.artifact_id)).body).toContain('the commands for AC-1');
    });

    it('takes the new commands one per line when applied, and leaves the rest of the plan alone', async () => {
      await testPlan();
      await fileChangeRequest(e, p, onCommands({ proposed_text: '  npm test -- first\n\nnpm run lint  \n' }));

      await applyChangeRequest(e, p, 'CR-1');

      expect(await coverageOf()).toEqual([
        { ac: 'AC-1', commands: ['npm test -- first', 'npm run lint'], notes: 'The first check' },
        { ac: 'AC-2', commands: ['npm test -- second'], notes: '' },
      ]);
      expect(await read('TEST-PLAN-M1')).toMatchObject({ version: 2, status: 'approved', body: '# Plan\n\nRun the checks.\n' });
    });

    it('refuses a criterion the plan does not cover', async () => {
      await testPlan();

      await expect(fileChangeRequest(e, p, onCommands({ target_ac: 'AC-9' }))).rejects.toThrow(/AC-9/);
    });

    it('applies over a newer plan whose commands for that criterion are the same', async () => {
      await testPlan();
      await fileChangeRequest(e, p, onCommands());
      await testPlan([COVERAGE[0]!, { ac: 'AC-2', commands: ['npm test -- moved'], notes: '' }]);

      await applyChangeRequest(e, p, 'CR-1');

      expect((await coverageOf()).map(({ commands }) => commands)).toEqual([['npm test -- first', 'npm run lint'], ['npm test -- moved']]);
    });

    it('refuses to apply when that criterion\'s commands changed after the request was filed', async () => {
      await testPlan();
      await fileChangeRequest(e, p, onCommands());
      await testPlan([{ ac: 'AC-1', commands: ['npm test -- someone-else'], notes: '' }, COVERAGE[1]!]);

      await expect(applyChangeRequest(e, p, 'CR-1')).rejects.toThrow(ChangeRequestError);
      expect((await coverageOf())[0]?.commands).toEqual(['npm test -- someone-else']);
    });
  });

  describe('text a request cannot carry', () => {
    it.each([
      ['a heading at the level of the section', 'Fine.\n\n## Approach\n\nForged.'],
      ['a heading above the level of the section', 'Fine.\n\n# Another document'],
      ['a fence that swallows what follows', 'Fine.\n\n```\nNever closed'],
    ])('refuses %s', async (_name, proposed_text) => {
      await document();

      await expect(fileChangeRequest(e, p, onSection({ proposed_text }))).rejects.toThrow(ChangeRequestError);
    });

    it('takes headings below the level of the section', async () => {
      await document();

      await expect(fileChangeRequest(e, p, onSection({ proposed_text: 'Fine.\n\n### Detail\n\nMore.' }))).resolves.toBeTruthy();
    });

    it.each(['acceptance-criteria', 'ac-1', 'spec'])('refuses to change criteria text through the section %s', async (target_section) => {
      await lockSpec(e);

      await expect(fileChangeRequest(e, p, onSection({ target_artifact: 'SPEC-M1', target_section }))).rejects.toThrow(/target_ac/);
    });

    it('refuses a section that would add a criterion heading to a spec', async () => {
      await lockSpec(e);
      const body = `${(await read('SPEC-M1')).body}\n## Notes\n\nNothing.\n`;
      await e.artifacts.commit(p, { message: 'notes', publish: [{ id: 'SPEC-M1', type: 'spec', status: 'approved', ownerRole: 'pm', derivedFrom: [], milestone: 1, body, acceptanceCriteria: ['AC-1', 'AC-2'] }] });

      await expect(fileChangeRequest(e, p, onSection({ target_artifact: 'SPEC-M1', target_section: 'notes', proposed_text: 'Fine.\n\n### AC-9\n\nForged.' }))).rejects.toThrow(/target_ac/);
    });

    it('refuses a criterion with a heading in it', async () => {
      await lockSpec(e);

      await expect(fileChangeRequest(e, p, onCriterion({ proposed_text: 'Works.\n\n#### Sneaky' }))).rejects.toThrow(ChangeRequestError);
    });
  });

  describe('applying', () => {
    it('replaces only the named section', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());

      await applyChangeRequest(e, p, 'CR-1');

      const doc = await read('TECH-M1');
      expect(doc.version).toBe(2);
      expect(doc.status).toBe('approved');
      expect(doc.body).toBe('# Design\n\n## Approach\n\nThe old approach.\n\n## Risks\n\nThere are none.\n\n## Notes\n\nNothing yet.\n');
      expect((await latest('CR-1'))?.status).toBe('approved');
    });

    it('replaces the named one of two identical sections', async () => {
      await document({ body: '## Risks\n\nThe same.\n\n## Risks\n\nThe same.\n\n## Notes\n\nEnd.\n' });
      await fileChangeRequest(e, p, onSection({ target_section: 'risks-2' }));

      await applyChangeRequest(e, p, 'CR-1');

      expect((await read('TECH-M1')).body).toBe('## Risks\n\nThe same.\n\n## Risks\n\nThere are none.\n\n## Notes\n\nEnd.\n');
    });

    it('does not repeat the heading when the proposed text includes it', async () => {
      await document();
      await fileChangeRequest(e, p, onSection({ proposed_text: '## Risks\n\nThere are none.\n' }));

      await applyChangeRequest(e, p, 'CR-1');

      expect(sectionText((await read('TECH-M1')).body, 'risks')).toBe('## Risks\n\nThere are none.\n\n');
    });

    it('keeps the fields of a ticket it changes', async () => {
      const fields = { title: 'A ticket', milestone: 1, ac_refs: ['AC-1'], specialty: 'engineer', touches: ['src/**'], depends_on: [], definition_of_done: ['true'], inputs: [], size: 'S' };
      await document({ id: 'M1-T-1', type: 'ticket', fields, body: '## Goal\n\nDo it.\n' });
      await fileChangeRequest(e, p, onSection({ target_artifact: 'M1-T-1', target_section: 'goal', proposed_text: 'Do it better.' }));

      await applyChangeRequest(e, p, 'CR-1');

      const doc = await read('M1-T-1');
      expect(doc.fields).toEqual(fields);
      expect(doc.body).toBe('## Goal\n\nDo it better.\n');
    });

    it('replaces criterion text and resets it to unverified, in the same commit as the new spec', async () => {
      await lockSpec(e);
      const qa = await ticketTask(e, 'QA', { kind: 'qa_verify' });
      await e.store.recordVerification(p.id, 1, 'AC-1', { status: 'passing', evidenceRef: 'QA-REPORT-M1-1@1#ac-1', verifiedBy: { kind: 'qa_verify', taskId: qa.id } });
      await fileChangeRequest(e, p, onCriterion());

      await applyChangeRequest(e, p, 'CR-1');

      const [first, second] = await e.store.listCriteria(p.id, 1);
      expect(first).toMatchObject({ text: 'The first thing works twice', status: 'unverified', evidence_ref: null, spec_version: 2, cr_id: 'CR-1' });
      expect(second).toMatchObject({ text: 'The second thing works', spec_version: 1, cr_id: null });
      const { body } = await read('SPEC-M1');
      expect(sectionText(body, 'ac-1')).toBe('### AC-1\n\nThe first thing works twice\n\n');
      expect(sectionText(body, 'ac-2')).toBe('### AC-2\n\nThe second thing works\n');
      expect((await latest('SPEC-M1'))?.sha).toBe((await latest('CR-1'))?.sha);
    });

    it('keeps the verification line and the stored criteria of a spec the PM wrote', async () => {
      const proposed = await apply(e, 'milestone_spec', { body: '# Milestone one\n', criteria: CRITERIA, stakeholder_note: 'Note' });
      const [spec] = await publish(e, proposed);
      await e.artifacts.commit(p, { message: 'approve', status: [{ id: 'SPEC-M1', status: 'approved', approvedBy: 'stakeholder' }] });
      await e.store.lockCriteria(p.id, 1, spec!.version, CRITERIA);
      await fileChangeRequest(e, p, onCriterion());

      await applyChangeRequest(e, p, 'CR-1');

      const doc = await read('SPEC-M1');
      expect(sectionText(doc.body, 'ac-1')).toBe('### AC-1\n\nThe first thing works twice\n\nVerified by: npm test -- first\n\n');
      expect(doc.acceptanceCriteria).toEqual(['AC-1', 'AC-2']);
      expect(doc.fields.data).toEqual({
        criteria: [
          { id: 'AC-1', text: 'The first thing works twice', verification: CRITERIA[0]!.verification },
          { id: 'AC-2', text: 'The second thing works', verification: CRITERIA[1]!.verification },
        ],
      });
    });

    it('rolls the new spec and the criterion back together when the caller fails', async () => {
      await lockSpec(e);
      await fileChangeRequest(e, p, onCriterion());

      await expect(applyChangeRequest(e, p, 'CR-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');

      expect((await latest('SPEC-M1'))?.version).toBe(1);
      expect((await latest('CR-1'))?.status).toBe('proposed');
      expect((await e.store.listCriteria(p.id, 1))[0]?.text).toBe('The first thing works');

      await applyChangeRequest(e, p, 'CR-1');

      expect((await latest('SPEC-M1'))?.version).toBe(2);
    });

    it('marks only what cited the changed criterion stale', async () => {
      await lockSpec(e);
      await document({ derivedFrom: ['SPEC-M1@1#ac-1'] });
      await document({ id: 'TEST-PLAN-M1', type: 'test_plan', derivedFrom: ['SPEC-M1@1#ac-2'] });
      await fileChangeRequest(e, p, onCriterion());

      await applyChangeRequest(e, p, 'CR-1');

      expect(await latest('TECH-M1')).toMatchObject({ status: 'stale', stale_sections: ['ac-1'] });
      expect((await latest('TEST-PLAN-M1'))?.status).toBe('approved');
    });

    it('applies once when called twice', async () => {
      await lockSpec(e);
      await fileChangeRequest(e, p, onCriterion());
      await applyChangeRequest(e, p, 'CR-1');
      const qa = await ticketTask(e, 'QA', { kind: 'qa_verify' });
      await e.store.recordVerification(p.id, 1, 'AC-1', { status: 'passing', evidenceRef: 'QA-REPORT-M1-1@1#ac-1', verifiedBy: { kind: 'qa_verify', taskId: qa.id } });

      let ran = 0;
      await applyChangeRequest(e, p, 'CR-1', async () => { ran += 1; });

      expect((await latest('SPEC-M1'))?.version).toBe(2);
      expect((await e.store.listCriteria(p.id, 1))[0]?.status).toBe('passing');
      expect(ran).toBe(1);
    });

    it('never changes criterion text without a cr_id', async () => {
      await lockSpec(e);
      await fileChangeRequest(e, p, onCriterion({ target_ac: 'AC-2' }));

      await applyChangeRequest(e, p, 'CR-1');

      expect((await e.store.listCriteria(p.id, 1))[1]?.cr_id).toBe('CR-1');
      await expect(e.db.updateTable('acceptance_criteria').set({ text: 'Sneaky', cr_id: null }).where('ac_id', '=', 'AC-1').execute()).rejects.toThrow();
    });

    it('applies requests against different sections of one document', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());
      await fileChangeRequest(e, p, onSection({ target_section: 'notes', proposed_text: 'Plenty.' }));

      await applyChangeRequest(e, p, 'CR-1');
      await applyChangeRequest(e, p, 'CR-2');

      const doc = await read('TECH-M1');
      expect(doc.version).toBe(3);
      expect(doc.body).toBe('# Design\n\n## Approach\n\nThe old approach.\n\n## Risks\n\nThere are none.\n\n## Notes\n\nPlenty.\n');
    });

    it('refuses to apply over a section that changed after the request was filed', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());
      await fileChangeRequest(e, p, onSection({ proposed_text: 'There are three.' }));
      await applyChangeRequest(e, p, 'CR-1');

      await expect(applyChangeRequest(e, p, 'CR-2')).rejects.toThrow(ChangeRequestError);

      expect(sectionText((await read('TECH-M1')).body, 'risks')).toBe('## Risks\n\nThere are none.\n\n');
      expect((await latest('CR-2'))?.status).toBe('proposed');
    });

    it('refuses to apply when the section has gone from the target', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());
      await document({ body: '# Design\n\n## Approach\n\nA rewrite.\n' });

      await expect(applyChangeRequest(e, p, 'CR-1')).rejects.toThrow(ChangeRequestError);
    });

    it('refuses to apply when the target has been superseded', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());
      await e.artifacts.commit(p, { message: 'gone', status: [{ id: 'TECH-M1', status: 'superseded' }] });

      await expect(applyChangeRequest(e, p, 'CR-1')).rejects.toThrow(/superseded/);
    });

    it('leaves a stale target stale, and still marks what derives from it', async () => {
      await document({ id: 'UP', type: 'roadmap', ownerRole: 'pm' });
      await document({ derivedFrom: ['UP@1'] });
      await document({ id: 'TEST-PLAN-M1', type: 'test_plan', derivedFrom: ['TECH-M1@1'] });
      await document({ id: 'UP', type: 'roadmap', ownerRole: 'pm', body: '# Design\n\nMoved.\n' });
      const staleSections = (await latest('TECH-M1'))?.stale_sections;
      expect((await latest('TECH-M1'))?.status).toBe('stale');
      await fileChangeRequest(e, p, onSection());

      await applyChangeRequest(e, p, 'CR-1');

      expect(await latest('TECH-M1')).toMatchObject({ version: 2, status: 'stale', stale_sections: staleSections });
      expect((await latest('TEST-PLAN-M1'))?.status).toBe('stale');
      expect((await latest('CR-1'))?.status).toBe('approved');
    });
  });

  describe('rejecting', () => {
    it('keeps the target unchanged when a request is rejected', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());

      await rejectChangeRequest(e, p, 'CR-1', 'It costs too much');

      const target = await latest('TECH-M1');
      expect(target).toMatchObject({ version: 1, status: 'approved' });
      expect((await read('TECH-M1')).body).toBe(BODY);
      expect((await latest('CR-1'))?.status).toBe('superseded');
      const logged = (await eventsOf('artifact.status')).map((event) => event.payload);
      expect(logged).toContainEqual(expect.objectContaining({ id: 'CR-1', status: 'superseded', rationale: 'It costs too much' }));
    });

    it('does nothing more when rejected twice', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());
      await rejectChangeRequest(e, p, 'CR-1', 'First');
      const before = await latest('CR-1');

      let ran = 0;
      await rejectChangeRequest(e, p, 'CR-1', 'Second', async () => { ran += 1; });

      expect((await latest('CR-1'))?.sha).toBe(before?.sha);
      expect(ran).toBe(1);
    });

    it('refuses to reject a request already applied', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());
      await applyChangeRequest(e, p, 'CR-1');

      await expect(rejectChangeRequest(e, p, 'CR-1', 'Too late')).rejects.toThrow(ChangeRequestError);
    });

    it('refuses to apply a request already rejected', async () => {
      await document();
      await fileChangeRequest(e, p, onSection());
      await rejectChangeRequest(e, p, 'CR-1', 'No');

      await expect(applyChangeRequest(e, p, 'CR-1')).rejects.toThrow(ChangeRequestError);
      expect((await latest('TECH-M1'))?.version).toBe(1);
    });

    it.each([applyChangeRequest, (d: TestEngine, project: ProjectRow, id: string) => rejectChangeRequest(d, project, id, 'No')])('refuses an id that is not a Change Request', async (act) => {
      await document();

      await expect(act(e, p, 'TECH-M1')).rejects.toThrow(ChangeRequestError);
    });
  });

  describe('raised by a worker', () => {
    const { raised_by: _raisedBy, ...raised } = onSection();
    const invalid = { ...raised, target_artifact: 'NOPE' };

    type Worker = { files?: Record<string, string>; dod?: string[]; maxAttempts?: number; once?: boolean };
    const worker = async (requests: unknown[], { files = { 'src/a.mjs': '' }, dod = ['true'], maxAttempts, once = false }: Worker = {}) => {
      const engine = await makeEngine({ steps: [okStep(files, { change_requests: requests })], ...(maxAttempts ? { config: { maxAttempts } } : {}) });
      const project = await projectOf(engine);
      await engine.artifacts.commit(project, { message: 'a document', publish: [{ id: 'TECH-M1', type: 'tech_design', status: 'approved', ownerRole: 'tech_lead', derivedFrom: [], milestone: 1, body: BODY }] });
      const task = await engine.addTicket(ticket({ definition_of_done: dod }));
      await (once ? runOnce : runToSettled)(engine, task.id);
      const [attempt] = await engine.store.listAttempts(task.id);
      return { engine, project, attempt, task: await engine.store.getTask(task.id), state: (await engine.store.getTask(task.id))?.state };
    };

    it('drops an invalid request from a worker, logs why, and does not fail the attempt', async () => {
      const { engine, project, state } = await worker([invalid]);
      try {
        expect(state).toBe('review');
        expect(await engine.artifacts.latest(project.id, 'CR-1')).toBeUndefined();
        const dropped = (await engine.log.list({ projectId: project.id })).filter((event) => event.type === 'change_request.dropped');
        expect(dropped.map((event) => event.payload.reason)).toEqual([expect.stringContaining('NOPE')]);
      } finally {
        await engine.cleanup();
      }
    });

    it('files a request raised in a Change Report, naming the ticket it came from', async () => {
      const { engine, project, state } = await worker([raised]);
      try {
        expect(state).toBe('review');
        expect((await engine.artifacts.read(project, 'CR-1')).fields.data).toEqual(onSection({ raised_in: 'T-1' }));
      } finally {
        await engine.cleanup();
      }
    });

    it.each([
      ['fails its checks', { 'src/a.mjs': '' }, ['false'], 'check_failed'],
      ['changes nothing', {}, ['true'], 'no_changes'],
    ])('files what a ticket raised when it %s, and holds the ticket while the request is open', async (_how, files, dod, kind) => {
      const { engine, project, attempt, task } = await worker([raised], { files, dod, once: true });
      try {
        expect(attempt).toMatchObject({ state: 'failed', failure_kind: kind });
        expect(attempt!.failure_evidence).toContain('CR-1');
        expect((await engine.artifacts.read(project, 'CR-1')).fields.data).toEqual(onSection({ raised_in: 'T-1' }));
        expect(task).toMatchObject({ state: 'blocked', blocked_on: 'change_request' });
      } finally {
        await engine.cleanup();
      }
    });

    it('logs a request a failed attempt could not file, and lets the ticket retry', async () => {
      const { engine, project, task } = await worker([invalid], { dod: ['false'], once: true });
      try {
        expect(task?.state).toBe('ready');
        expect(await engine.artifacts.latest(project.id, 'CR-1')).toBeUndefined();
        const dropped = (await engine.log.list({ projectId: project.id })).filter((event) => event.type === 'change_request.dropped');
        expect(dropped.map((event) => event.payload.reason)).toEqual([expect.stringContaining('NOPE')]);
      } finally {
        await engine.cleanup();
      }
    });

    it('escalates a last attempt that raised a request, rather than holding it', async () => {
      const { engine, project, task } = await worker([raised], { dod: ['false'], maxAttempts: 1, once: true });
      try {
        expect(task).toMatchObject({ state: 'escalated', escalation_reason: 'attempts_exhausted' });
        expect((await engine.artifacts.latest(project.id, 'CR-1'))?.status).toBe('proposed');
      } finally {
        await engine.cleanup();
      }
    });

    const discovery = async (change_requests: unknown[]) => {
      await document();
      await e.artifacts.commit(p, { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
      return {
        roadmap: { body: '# Roadmap\n', milestones: [{ n: 1, title: 'First', goal: 'Start' }] },
        team_proposal: { body: '# Team\n' },
        human_requirements: { body: '# Needs\n' },
        stakeholder_note: 'Note',
        change_requests,
      };
    };

    it('files what an authoring worker raises, naming its role', async () => {
      const output = await discovery([raised]);

      await publish(e, await apply(e, 'discovery', output, { inputs: ['BRIEF'], role: 'pm' }));

      const [task] = await e.store.listTasks(p.id);
      expect((await read('CR-1')).fields.data).toEqual(onSection({ raised_by: 'pm', raised_in: task!.ticket_id }));
    });

    it('sends an authoring worker back with the reason when a request it raised cannot be filed', async () => {
      const output = await discovery([invalid, raised]);

      const evidence = evidenceOf(await apply(e, 'discovery', output, { inputs: ['BRIEF'], role: 'pm' }));

      expect(evidence).toContain('NOPE');
      expect(evidence).toMatch(/change_requests/);
    });

    it('keeps the work of a last attempt, and logs the request it could not file', async () => {
      const output = await discovery([invalid, raised]);
      const ctx = await ctxFor(e, 'discovery', output, { inputs: ['BRIEF'], role: 'pm' });
      for (let i = 1; i < e.config.maxAttempts; i += 1) {
        const earlier = await e.store.createAttempt({ task_id: ctx.task.id, adapter: 'claude', model: 'm', worktree_path: e.repoPath, branch: `b${i}` });
        await e.store.setAttemptState(earlier.id, 'running');
        await e.store.setAttemptState(earlier.id, 'invalid_output', { failure_kind: 'invalid_output', failure_evidence: 'A bad request' });
      }

      await publish(e, await applyOutput(ctx));

      expect((await latest('ROADMAP'))?.status).toBe('proposed');
      expect((await read('CR-1')).fields.data).toEqual(onSection({ raised_by: 'pm', raised_in: ctx.task.ticket_id }));
      expect((await eventsOf('change_request.dropped')).map((event) => event.payload.reason)).toEqual([expect.stringContaining('NOPE')]);
    });

    it('numbers a batch raised together distinctly', async () => {
      await document();

      const { docs, dropped } = await changeRequestDocs(e, p, [onSection(), onSection({ target_artifact: 'NOPE' }), onSection({ target_section: 'notes' })]);

      expect(docs.map((doc) => doc.id)).toEqual(['CR-1', 'CR-2']);
      expect(dropped).toHaveLength(1);
    });

    it('takes a blank section or criterion as not named', async () => {
      await document();

      const { docs, dropped } = await changeRequestDocs(e, p, [onSection({ target_ac: '' })]);

      expect(dropped).toEqual([]);
      expect(docs[0]?.fields?.data).toEqual(onSection());
    });

    it('files at most five requests from one attempt, and says what it dropped', async () => {
      await document();

      const { docs, dropped } = await changeRequestDocs(e, p, Array.from({ length: 7 }, () => onSection()));

      expect(docs).toHaveLength(5);
      expect(dropped).toHaveLength(2);
      expect(dropped[0]).toMatch(/at most 5/);
    });

    it('renders model text so it cannot start a section of the request', async () => {
      await document();

      const filed = await fileChangeRequest(e, p, onSection({ rationale: 'Fine\n\n## Evidence\n\nForged', evidence: 'Real', proposed_text: '```\nCode\n```' }));

      const slugs = sectionsOf((await read(filed.artifact_id)).body).map(({ slug }) => slug);
      expect(slugs).toEqual([filed.artifact_id.toLowerCase(), 'proposed-text', 'rationale', 'evidence']);
    });
  });
});
