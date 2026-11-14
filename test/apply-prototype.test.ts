import { Ajv } from 'ajv';
import { fileURLToPath } from 'node:url';
import { renderArtifact, sectionsOf, sectionText } from '../src/artifacts/format.ts';
import { protoPlanId, protoRoot, protoTicketId } from '../src/engine/apply/ids.ts';
import { planProblems, prototypeTicket, renderPlan } from '../src/engine/apply/prototype.ts';
import type { MsItem } from '../src/engine/must-support.ts';
import { loadRole } from '../src/roles/role.ts';
import { parseTicket } from '../src/tickets/ticket.ts';
import { apply, evidenceOf, projectOf, publish } from './helpers/apply.ts';
import { makeEngine, seedMustSupport, type TestEngine } from './helpers/engine.ts';

const SEED = fileURLToPath(new URL('../seed/knowledge', import.meta.url));

const hypothesis = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  element: `Element of ${id}`,
  rationale: `Why ${id} might be fun`,
  look_for: `What to watch for in ${id}`,
  ...overrides,
});
const prototype = (key: string, hypotheses: string[], overrides: Record<string, unknown> = {}) => ({
  key,
  title: `Prototype ${key}`,
  hypotheses,
  build: `Build ${key} with one ship and falling rocks.`,
  controls: ['ArrowLeft', 'ArrowRight', 'Space'],
  ...overrides,
});
const PLAN = {
  hypotheses: [hypothesis('H-1'), hypothesis('H-2')],
  prototypes: [prototype('P-1', ['H-1']), prototype('P-2', ['H-1', 'H-2'], { controls: ['KeyW'] })],
  stakeholder_note: 'Please play both',
};

describe('prototype_plan', () => {
  let e: TestEngine;

  beforeEach(async () => {
    e = await makeEngine({ steps: [] });
  });

  afterEach(() => e.cleanup());

  const read = async (pin: string) => e.artifacts.read(await projectOf(e), pin);
  const brief = async () => e.artifacts.commit(await projectOf(e), { message: 'brief', publish: [{ id: 'BRIEF', type: 'brief', status: 'approved', ownerRole: 'stakeholder', derivedFrom: [], body: '# Brief\n' }] });
  const plan = (output: Record<string, unknown> = {}, round = 1, inputs = ['BRIEF@1']) => apply(e, 'prototype_plan', { ...PLAN, ...output }, { ticketId: protoPlanId(round), milestone: 0, inputs });

  it('names the round and a prototype by their ids', () => {
    expect(protoPlanId(2)).toBe('PROTO-PLAN-2');
    expect(protoTicketId(2, 3)).toBe('PROTO-2-P-3');
    expect(protoRoot(2, 3)).toBe('prototypes/r2/p3');
  });

  it('publishes PROTO-PLAN-1 and one ticket per prototype', async () => {
    await brief();
    const rows = await publish(e, await plan());

    expect(rows.map((row) => [row.artifact_id, row.type, row.status, row.owner_role, row.approved_by, row.milestone])).toEqual([
      ['PROTO-PLAN-1', 'prototype_plan', 'approved', 'pm', 'owner:pm', 0],
      ['PROTO-1-P-1', 'ticket', 'approved', 'pm', 'owner:pm', 0],
      ['PROTO-1-P-2', 'ticket', 'approved', 'pm', 'owner:pm', 0],
    ]);
    expect(rows[0]!.derived_from).toEqual(['BRIEF@1']);
    expect(rows[1]!.derived_from).toEqual(['PROTO-PLAN-1@1', 'PROTO-PLAN-1@1#p-1']);
  });

  it('gives each ticket the page it builds, as a ticket the runner can parse', async () => {
    await brief();
    await publish(e, await plan());

    for (const k of [1, 2]) {
      const doc = await read(`PROTO-1-P-${k}`);
      const ticket = parseTicket(renderArtifact(doc));
      expect(ticket).toEqual({
        id: `PROTO-1-P-${k}`,
        title: `Prototype P-${k}: Prototype P-${k}`,
        milestone: 0,
        ac_refs: [],
        specialty: 'engineer',
        touches: [`prototypes/r1/p${k}/**`],
        depends_on: [],
        definition_of_done: [`test -f prototypes/r1/p${k}/index.html`],
        inputs: [`PROTO-PLAN-1@1#p-${k}`],
        size: 'S',
        components: [],
        body: ticket.body,
      });
    }
  });

  it('tells the engineer to build a self-contained page, with the controls and the build text', async () => {
    await brief();
    await publish(e, await plan());

    expect((await read('PROTO-1-P-1')).body).toBe(
      'Build prototype P-1 as a self-contained static page at prototypes/r1/p1/index.html: plain JavaScript, no build step, no dependencies, no network. It must open by loading index.html. Reference every other file by a relative path. Controls: ArrowLeft, ArrowRight, Space.\n\nBuild P-1 with one ship and falling rocks.\n',
    );
    expect((await read('PROTO-1-P-2')).body).toBe(
      'Build prototype P-2 as a self-contained static page at prototypes/r1/p2/index.html: plain JavaScript, no build step, no dependencies, no network. It must open by loading index.html. Reference every other file by a relative path. Controls: KeyW.\n\nBuild P-2 with one ship and falling rocks.\n',
    );
  });

  it('renders ## Hypotheses then ## P-1, ## P-2', async () => {
    await brief();
    await publish(e, await plan());
    const { body } = await read('PROTO-PLAN-1');

    expect(body.startsWith('# Prototype round 1\n')).toBe(true);
    expect(sectionsOf(body).filter(({ level }) => level <= 2).map(({ title }) => title)).toEqual(['Prototype round 1', 'Hypotheses', 'P-1', 'P-2']);
    expect(sectionsOf(body).filter(({ level }) => level === 3).map(({ title }) => title)).toEqual(['H-1 — Element of H-1', 'H-2 — Element of H-2']);

    const hypotheses = sectionText(body, 'h-1-element-of-h-1')!;
    expect(hypotheses).toContain('Why H-1 might be fun');
    expect(hypotheses).toMatch(/Look for: What to watch for in H-1/);

    const second = sectionText(body, 'p-2')!;
    expect(second).toContain('Prototype P-2');
    expect(second).toMatch(/Tests: H-1, H-2/);
    expect(second).toContain('Build P-2 with one ship and falling rocks.');
    expect(second).toMatch(/Controls: KeyW/);
    expect(second).not.toContain('Prototype P-1');
  });

  it('keeps the hypotheses and prototypes as data, for whoever evaluates the round', async () => {
    await brief();
    await publish(e, await plan());

    expect((await read('PROTO-PLAN-1')).fields.data).toEqual({ hypotheses: PLAN.hypotheses, prototypes: PLAN.prototypes });
  });

  it('numbers a later round by its task, and derives from the rounds before it', async () => {
    await brief();
    await publish(e, await plan());
    const rows = await publish(e, await plan({ prototypes: [prototype('P-1', ['H-2'])] }, 2, ['BRIEF@1', 'PROTO-PLAN-1@1']));

    expect(rows.map((row) => row.artifact_id)).toEqual(['PROTO-PLAN-2', 'PROTO-2-P-1']);
    expect(rows[0]!.derived_from).toEqual(['BRIEF@1', 'PROTO-PLAN-1@1']);
    const ticket = parseTicket(renderArtifact(await read('PROTO-2-P-1')));
    expect(ticket).toMatchObject({ touches: ['prototypes/r2/p1/**'], definition_of_done: ['test -f prototypes/r2/p1/index.html'], inputs: ['PROTO-PLAN-2@1#p-1'] });
  });

  it('pins the version the plan is published at', async () => {
    await brief();
    await e.artifacts.commit(await projectOf(e), { message: 'an earlier plan', publish: [{ id: 'PROTO-PLAN-1', type: 'prototype_plan', status: 'superseded', ownerRole: 'pm', derivedFrom: [], milestone: 0, body: '# Prototype round 1\n' }] });
    const rows = await publish(e, await plan());

    expect(rows.map((row) => [row.artifact_id, row.version])).toEqual([['PROTO-PLAN-1', 2], ['PROTO-1-P-1', 1], ['PROTO-1-P-2', 1]]);
    expect((await read('PROTO-1-P-1')).fields.inputs).toEqual(['PROTO-PLAN-1@2#p-1']);
    expect(rows[1]!.derived_from).toEqual(['PROTO-PLAN-1@2', 'PROTO-PLAN-1@2#p-1']);
  });

  it('says none for a prototype that is played without keys', async () => {
    await brief();
    await publish(e, await plan({ prototypes: [prototype('P-1', ['H-1'], { controls: [] })] }));

    expect((await read('PROTO-1-P-1')).body).toMatch(/Controls: none\.\n\nBuild P-1/);
    expect(sectionText((await read('PROTO-PLAN-1')).body, 'p-1')).toMatch(/Controls: none/);
  });

  it('sends the worker back when a change request it raised cannot be filed', async () => {
    await brief();
    const request = { target_artifact: 'NOPE', proposed_text: 'Say what a round is', rationale: 'It is vague', evidence: 'BRIEF says nothing of rounds' };

    const evidence = evidenceOf(await plan({ change_requests: [request] }));

    expect(evidence).toContain('NOPE');
    expect(evidence).toMatch(/change_requests/);
  });

  describe('refuses', () => {
    const refusal = async (output: Record<string, unknown>) => evidenceOf(await plan(output));

    it('no prototype', async () => {
      expect(await refusal({ prototypes: [] })).toMatch(/1 to 3 prototypes, not 0/);
    });

    it('four prototypes', async () => {
      const four = ['P-1', 'P-2', 'P-3', 'P-4'].map((key) => prototype(key, ['H-1']));
      expect(await refusal({ prototypes: four })).toMatch(/1 to 3 prototypes, not 4/);
    });

    it('keys out of order', async () => {
      const evidence = await refusal({ prototypes: [prototype('P-2', ['H-1']), prototype('P-1', ['H-1'])] });
      expect(evidence).toContain('Prototype P-1: key must be P-1, not "P-2"');
      expect(evidence).toContain('Prototype P-2: key must be P-2, not "P-1"');
    });

    it('an unknown hypothesis', async () => {
      expect(await refusal({ prototypes: [prototype('P-1', ['H-1', 'H-9'])] })).toContain('Prototype P-1: tests H-9, which this plan does not define');
    });

    it('a duplicate H id', async () => {
      expect(await refusal({ hypotheses: [hypothesis('H-1'), hypothesis('H-1')] })).toContain('Hypothesis 2: id H-1 is already used');
    });

    it.each(['h-1', 'H-', 'H-1a', 'X-1', ' H-1'])('the hypothesis id %j', async (id) => {
      expect(await refusal({ hypotheses: [hypothesis(id)], prototypes: [prototype('P-1', [id])] })).toContain(`Hypothesis 1: id ${JSON.stringify(id)} must look like H-1`);
    });

    it('a prototype that tests nothing', async () => {
      expect(await refusal({ prototypes: [prototype('P-1', [])] })).toContain('Prototype P-1: names no hypothesis');
    });

    it('a bad control key', async () => {
      const evidence = await refusal({ prototypes: [prototype('P-1', ['H-1'], { controls: ['ArrowLeft', 'Jump'] })] });
      expect(evidence).toMatch(/Prototype P-1: controls: Jump is not a key/);
      expect(evidence).not.toMatch(/ArrowLeft is not a key/);
    });

    it.each(['element', 'rationale', 'look_for'])('a blank hypothesis %s', async (field) => {
      expect(await refusal({ hypotheses: [hypothesis('H-1', { [field]: '  \n' })], prototypes: [prototype('P-1', ['H-1'])] })).toContain(`Hypothesis 1: ${field} is blank`);
    });

    it.each(['title', 'build'])('a blank prototype %s', async (field) => {
      expect(await refusal({ prototypes: [prototype('P-1', ['H-1'], { [field]: '  ' })] })).toContain(`Prototype P-1: ${field} is blank`);
    });

    it.each([
      ['rationale', { hypotheses: [hypothesis('H-1', { rationale: 'Because.\n## P-9\nSneaky' })] }],
      ['build', { prototypes: [prototype('P-1', ['H-1'], { build: 'Do it.\n# Another title' })] }],
    ])('a heading in the %s', async (field, output) => {
      expect(await refusal({ hypotheses: [hypothesis('H-1')], prototypes: [prototype('P-1', ['H-1'])], ...output })).toMatch(new RegExp(`${field} has a line that starts with #`));
    });

    it('a code block left open, which would hide the headings after it', async () => {
      const evidence = await refusal({ prototypes: [prototype('P-1', ['H-1'], { build: 'Do it:\n```js\nlet x' }), prototype('P-2', ['H-1'])] });
      expect(evidence).toMatch(/changes the headings the engine writes/);
    });

    it('with one line for each problem, and nothing published', async () => {
      const result = await plan({ hypotheses: [hypothesis('H-1'), hypothesis('H-1')], prototypes: [prototype('P-1', ['H-7'], { controls: ['Jump'] })] });
      const lines = evidenceOf(result).split('\n');

      expect(lines).toHaveLength(3);
      expect((await e.artifacts.list((await projectOf(e)).id)).map((row) => row.artifact_id)).toEqual([]);
    });
  });

  it('throws, as an engine bug, when the task is not a prototype round', async () => {
    await expect(apply(e, 'prototype_plan', PLAN, { milestone: 0 })).rejects.toThrow(/TASK-\d+ is not a prototype round/);
    await expect(apply(e, 'prototype_plan', PLAN, { milestone: 0, ticketId: 'PROTO-PLAN-0' })).rejects.toThrow(/is not a prototype round/);
  });

  it('is a shape the pm schema allows', async () => {
    const planned = new Ajv({ strict: false }).compile((await loadRole(SEED, 'pm', 'prototype_plan')).schema);

    expect(planned(PLAN), JSON.stringify(planned.errors)).toBe(true);
    expect(planned({ ...PLAN, change_requests: [] })).toBe(true);
    expect(planned({ hypotheses: PLAN.hypotheses, stakeholder_note: 'x' })).toBe(false);
    expect(planned({ ...PLAN, prototypes: [{ ...PLAN.prototypes[0], controls: undefined }] })).toBe(false);
    expect(planned({ ...PLAN, hypotheses: [{ ...PLAN.hypotheses[0], look_for: undefined }] })).toBe(false);
    expect(planned({ ...PLAN, prototypes: [{ ...PLAN.prototypes[0], must_support: [{ item: 'MS-1', how: 'Big touch buttons' }] }], gaps: [{ item: 'MS-2', why: 'No room' }] }), JSON.stringify(planned.errors)).toBe(true);
    expect(planned({ ...PLAN, prototypes: [{ ...PLAN.prototypes[0], must_support: [{ item: 'phones', how: 'x' }] }] })).toBe(false);
  });

  describe('against the must-support list', () => {
    const phone: MsItem = { id: 'MS-1', group: 'runs_on', text: 'Plays in a phone browser held upright', brief_quote: 'On my phone', check: 'play', viewport: 'phone_portrait', input: 'touch', fits_screen: true };
    const cmd: MsItem = { id: 'MS-2', group: 'built_with', text: 'Has no build step', brief_quote: 'No build step', check: 'command' };
    const sound: MsItem = { id: 'MS-3', group: 'runs_on', text: 'Sounds right on phone speakers', brief_quote: 'Good sound', check: 'human', how: 'Play with the sound on' };
    const line = (item: string, how = 'big touch buttons') => ({ item, how });
    const planWith = (lines: { item: string; how: string }[][], gaps?: { item: string; why: string }[]) => ({
      ...PLAN,
      prototypes: PLAN.prototypes.map((p, index) => ({ ...p, must_support: lines[index] ?? [] })),
      ...(gaps ? { gaps } : {}),
    });

    it('refuses a plan with no must-support line for a runs_on item', () => {
      expect(planProblems(PLAN, [phone, cmd])).toEqual([
        'P-1 has no must_support line for MS-1: say how it meets it, or name it in gaps',
        'P-2 has no must_support line for MS-1: say how it meets it, or name it in gaps',
      ]);
      expect(planProblems(planWith([[line('MS-1')], [line('MS-1')]]), [phone, cmd])).toEqual([]);
    });

    it('asks nothing of a plan when the list has no runs_on item', () => {
      expect(planProblems(PLAN, [cmd])).toEqual([]);
      expect(planProblems(PLAN, [])).toEqual([]);
    });

    it('lets a plan leave out an item it names in gaps', () => {
      expect(planProblems(planWith([[], []], [{ item: 'MS-1', why: 'The map needs a wide screen' }]), [phone, cmd])).toEqual([]);
    });

    it('refuses an unknown or repeated item, and a line that says nothing', () => {
      expect(planProblems(planWith([[line('MS-1'), line('MS-2')], [line('MS-1'), line('MS-1')]]), [phone, cmd])).toEqual(['P-1 names MS-2, which is not a runs_on item on the list', 'P-2 lists MS-1 twice']);
      expect(planProblems(planWith([[line('MS-1', ' \n')], [line('MS-1')]]), [phone])).toEqual(["P-1's line for MS-1 says nothing"]);
    });

    it("renders each prototype's must-support lines", () => {
      const body = renderPlan(1, planWith([[line('MS-1')], [line('MS-1', 'one thumb,\nlandscape too')]]), [phone, cmd]);

      expect(sectionText(body, 'p-1')).toContain('- Controls: ArrowLeft, ArrowRight, Space\n- Must support:\n  - MS-1 Plays in a phone browser held upright: big touch buttons\n');
      expect(sectionText(body, 'p-2')).toContain('  - MS-1 Plays in a phone browser held upright: one thumb, landscape too\n');
      expect(renderPlan(1, PLAN, [])).not.toContain('Must support');
    });

    it('a prototype ticket carries the whole list and pins it', () => {
      const proto = { ...PLAN.prototypes[0]!, must_support: [line('MS-1'), line('MS-3', 'a beep on every hit')] };
      const ticket = prototypeTicket(1, 1, proto, 'PROTO-PLAN-1@1#p-1', { pin: 'MUST-SUPPORT@1', items: [phone, cmd, sound] });

      expect(ticket.body).toContain(
        [
          '## Must support',
          '',
          'Every item below holds for this prototype. Before the ticket is done, the engine plays it in each browser the list names.',
          '',
          '- MS-1 Plays in a phone browser held upright — Checked by the engine: Phone browser, held upright, played by touch, fitting the screen: big touch buttons',
          '- MS-2 Has no build step — Not checked on prototypes',
          '- MS-3 Sounds right on phone speakers — The stakeholder checks this when they play it: a beep on every hit',
          '',
        ].join('\n'),
      );
      expect(ticket.fields!.inputs).toEqual(['PROTO-PLAN-1@1#p-1', 'MUST-SUPPORT@1']);
      // Nothing revises a prototype ticket, so a change to the list must not leave it stale and unmerged.
      expect(ticket.derivedFrom).toEqual(['PROTO-PLAN-1', 'PROTO-PLAN-1@1#p-1']);
    });

    it('a ticket written against no list, or an empty one, says nothing of it', () => {
      expect(prototypeTicket(1, 1, PLAN.prototypes[0]!, 'PROTO-PLAN-1@1#p-1').body).not.toContain('Must support');
      const listed = prototypeTicket(1, 1, PLAN.prototypes[0]!, 'PROTO-PLAN-1@1#p-1', { pin: 'MUST-SUPPORT@1', items: [] });
      expect(listed.body).not.toContain('Must support');
      expect(listed.fields!.inputs).toEqual(['PROTO-PLAN-1@1#p-1', 'MUST-SUPPORT@1']);
    });

    it('the applier holds a plan to the approved list, and its tickets carry it', async () => {
      await brief();
      await seedMustSupport(e, await projectOf(e), [phone, cmd]);

      // Each call is a task of its own, so the refused plan is another round's.
      expect(evidenceOf(await plan({}, 2))).toContain('P-1 has no must_support line for MS-1: say how it meets it, or name it in gaps');
      await publish(e, await plan(planWith([[line('MS-1')], [line('MS-1')]])));

      expect((await read('PROTO-PLAN-1')).body).toContain('  - MS-1 Plays in a phone browser held upright: big touch buttons');
      expect((await read('PROTO-1-P-2')).body).toContain('- MS-2 Has no build step — Not checked on prototypes');
      expect(parseTicket(renderArtifact(await read('PROTO-1-P-2'))).inputs).toEqual(['PROTO-PLAN-1@1#p-2', 'MUST-SUPPORT@1']);
    });
  });
});
