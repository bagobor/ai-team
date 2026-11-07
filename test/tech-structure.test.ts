import { renderTechDesign, structureOf, structureProblems, type ComponentSpec, type TechStructure } from '../src/engine/apply/tech-structure.ts';

const component = (overrides: Partial<ComponentSpec> = {}): ComponentSpec => ({
  name: 'loop',
  responsibility: 'Runs the frame loop.',
  sources: ['src/loop/**'],
  tests: ['test/loop/**'],
  no_tests_reason: null,
  complexity: 'M',
  complexity_notes: 'O(enemies x bullets) per frame',
  ...overrides,
});

const structure = (overrides: Partial<TechStructure> = {}): TechStructure => ({
  components: [component(), component({ name: 'render', responsibility: 'Draws the frame.', sources: ['src/render/**'], tests: [], no_tests_reason: 'Pixels are checked by the play gate.', complexity: 'S', complexity_notes: 'One draw call per entity' })],
  complexity: { overall: 'M', rationale: 'The loop is the only hot path.' },
  performance: [{ metric: 'Frame time', target: '16.7 ms at 200 entities', how_measured: 'Bench script in the play gate', component: 'loop' }],
  test_strategy: 'Unit tests per component, one play script for the whole page.',
  risks: [{ risk: 'Collision cost grows with bullets', mitigation: 'Grid the playfield' }],
  ...overrides,
});

describe('structureProblems', () => {
  it('accepts a valid structure', () => {
    expect(structureProblems(structure())).toEqual([]);
  });

  it('refuses no components', () => {
    expect(structureProblems(structure({ components: [] }))).toEqual([expect.stringContaining('components')]);
  });

  it('refuses duplicate or blank names', () => {
    expect(structureProblems(structure({ components: [component(), component({ sources: ['src/other/**'] })] }))).toEqual([expect.stringContaining('"loop"')]);
    expect(structureProblems(structure({ components: [component(), component({ name: ' loop ' })] }))).toEqual([expect.stringContaining('"loop"')]);

    const blank = structureProblems(structure({ components: [component(), component({ name: '  ' })] }));
    expect(blank).toHaveLength(1);
    expect(blank[0]).toContain('component 2');
    expect(blank[0]).toContain('blank');
  });

  it('refuses a source glob that touchesProblem rejects', () => {
    expect(structureProblems(structure({ components: [component({ sources: ['src/**', '../outside/**'] })] }))).toEqual(['component "loop": sources glob "../outside/**" contains ..']);
    expect(structureProblems(structure({ components: [component({ sources: ['/etc/**'] })] }))).toEqual(['component "loop": sources glob "/etc/**" is absolute']);
    expect(structureProblems(structure({ components: [component({ sources: ['.aiteam/**'] })] }))).toEqual(['component "loop": sources glob ".aiteam/**" names the state folder']);
  });

  it('refuses a test glob that touchesProblem rejects', () => {
    expect(structureProblems(structure({ components: [component({ tests: ['  '] })] }))).toEqual(['component "loop": tests glob "  " is blank']);
  });

  it('refuses a component with no sources', () => {
    expect(structureProblems(structure({ components: [component({ sources: [] })] }))).toEqual([expect.stringMatching(/component "loop": sources is empty/)]);
  });

  it('refuses empty tests without a reason', () => {
    const empty = component({ tests: [], no_tests_reason: null });
    expect(structureProblems(structure({ components: [empty] }))).toEqual(['component "loop": tests is empty and there is no no_tests_reason']);
    expect(structureProblems(structure({ components: [component({ tests: [], no_tests_reason: '   ' })] }))).toEqual(['component "loop": tests is empty and there is no no_tests_reason']);
    expect(structureProblems(structure({ components: [component({ tests: [], no_tests_reason: 'Config only.' })] }))).toEqual([]);
  });

  it('refuses a complexity that is not S, M or L, or has no notes', () => {
    expect(structureProblems(structure({ components: [component({ complexity: 'XL' as 'L' })] }))).toEqual([expect.stringContaining('component "loop": complexity')]);
    expect(structureProblems(structure({ components: [component({ complexity_notes: ' ' })] }))).toEqual([expect.stringContaining('component "loop": complexity_notes')]);
    expect(structureProblems(structure({ complexity: { overall: 'huge' as 'L', rationale: 'x' } }))).toEqual([expect.stringContaining('complexity.overall')]);
    expect(structureProblems(structure({ complexity: { overall: 'L', rationale: '' } }))).toEqual([expect.stringContaining('complexity.rationale')]);
  });

  it('refuses no performance entry', () => {
    expect(structureProblems(structure({ performance: [] }))).toEqual([expect.stringContaining('performance')]);
  });

  it('refuses a blank metric, target or how_measured', () => {
    const entry = { metric: 'Frame time', target: '16.7 ms', how_measured: 'Bench', component: null };
    expect(structureProblems(structure({ performance: [{ ...entry, metric: '' }] }))).toEqual([expect.stringContaining('metric')]);
    expect(structureProblems(structure({ performance: [{ ...entry, target: '  ' }] }))).toEqual([expect.stringContaining('target')]);
    expect(structureProblems(structure({ performance: [{ ...entry, how_measured: '' }] }))).toEqual([expect.stringContaining('how_measured')]);
    expect(structureProblems(structure({ performance: [entry, { ...entry, metric: '' }] }))).toEqual([expect.stringContaining('performance entry 2')]);
  });

  it('refuses a blank test_strategy', () => {
    expect(structureProblems(structure({ test_strategy: '  \n' }))).toEqual([expect.stringContaining('test_strategy')]);
  });

  it('reports every problem at once', () => {
    expect(structureProblems(structure({ components: [component({ tests: [] })], performance: [], test_strategy: '' }))).toHaveLength(3);
  });
});

describe('renderTechDesign', () => {
  const rendered = renderTechDesign('We keep one loop.\n', structure());

  it('puts the headings in order', () => {
    const headings = ['## Overview', '## Components', '### loop', '### render', '## Complexity', '## Performance', '## Test strategy', '## Risks'];
    const lines = rendered.split('\n');
    const at = headings.map((heading) => lines.indexOf(heading));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at[0]).toBe(0);
  });

  it('puts the body under Overview and the structure under its headings', () => {
    expect(rendered).toContain('## Overview\n\nWe keep one loop.\n');
    expect(rendered).toContain('Runs the frame loop.');
    expect(rendered).toContain('`src/loop/**`');
    expect(rendered).toContain('Pixels are checked by the play gate.');
    expect(rendered).toContain('The loop is the only hot path.');
    expect(rendered).toContain('Unit tests per component');
    expect(rendered).toContain('Collision cost grows with bullets');
    expect(rendered).toContain('Grid the playfield');
  });

  it('renders the performance section as a table', () => {
    expect(rendered).toContain('| Metric | Target | How measured | Component |');
    expect(rendered).toContain('| --- | --- | --- | --- |');
    expect(rendered).toContain('| Frame time | 16.7 ms at 200 entities | Bench script in the play gate | loop |');
  });

  it('keeps a model-written cell from breaking the table or starting a section', () => {
    const text = renderTechDesign('x', structure({ performance: [{ metric: 'a | b\n## Risks', target: 't', how_measured: 'h', component: null }] }));
    expect(text).toContain('| a \\| b ## Risks | t | h | - |');
    expect(text.match(/^## Risks$/gm)).toHaveLength(1);
  });

  it('names every section a pin can point at', () => {
    expect(rendered.match(/^## /gm)).toHaveLength(6);
  });
});

describe('structureOf', () => {
  it('reads the structure from fields.data', () => {
    const s = structure();
    expect(structureOf({ fields: { data: s } })).toEqual(s);
  });

  it('returns undefined for a doc without fields.data.components', () => {
    expect(structureOf(undefined)).toBeUndefined();
    expect(structureOf({})).toBeUndefined();
    expect(structureOf({ fields: {} })).toBeUndefined();
    expect(structureOf({ fields: { data: null } })).toBeUndefined();
    expect(structureOf({ fields: { data: { coverage: [] } } })).toBeUndefined();
    expect(structureOf({ fields: { data: { components: 'loop' } } })).toBeUndefined();
    expect(structureOf({ fields: { data: { components: [] } } })).toBeUndefined();
  });
});
