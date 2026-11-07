import { componentCoverage, coverageTable, untestedEvidence, type CoverageComponent } from '../src/checks/coverage.ts';

const C: CoverageComponent = { name: 'loop', sources: ['src/**'], tests: ['src/**/*.test.js', 'test/**'], no_tests_reason: null };

describe('componentCoverage', () => {
  it('a source change without a test change is untested', () => {
    expect(componentCoverage([{ path: 'src/loop.js', status: 'M' }], [C])).toEqual([{ name: 'loop', untested: true, sourceChanges: ['src/loop.js'], testChanges: [], reason: null }]);
  });

  it('an added or modified test makes it tested', () => {
    for (const status of ['A', 'M', 'R100']) {
      const [row] = componentCoverage(
        [
          { path: 'src/loop.js', status: 'M' },
          { path: 'test/loop.test.js', status },
        ],
        [C],
      );
      expect(row).toEqual({ name: 'loop', untested: false, sourceChanges: ['src/loop.js'], testChanges: ['test/loop.test.js'], reason: null });
    }
  });

  it('a deleted test does not count', () => {
    const [row] = componentCoverage(
      [
        { path: 'src/loop.js', status: 'M' },
        { path: 'test/loop.test.js', status: 'D' },
      ],
      [C],
    );
    expect(row?.untested).toBe(true);
    expect(row?.testChanges).toEqual([]);
  });

  it('a test file inside the sources is not a source change', () => {
    const [row] = componentCoverage([{ path: 'src/loop.test.js', status: 'M' }], [C]);
    expect(row).toEqual({ name: 'loop', untested: false, sourceChanges: [], testChanges: ['src/loop.test.js'], reason: null });
  });

  it('a component nothing touched is not untested', () => {
    expect(componentCoverage([{ path: 'docs/readme.md', status: 'M' }], [C])).toEqual([{ name: 'loop', untested: false, sourceChanges: [], testChanges: [], reason: null }]);
    expect(componentCoverage([], [C])[0]?.untested).toBe(false);
  });

  it('no_tests_reason exempts it', () => {
    const exempt = { ...C, tests: [], no_tests_reason: 'Wiring only.' };
    expect(componentCoverage([{ path: 'src/loop.js', status: 'M' }], [exempt])).toEqual([{ name: 'loop', untested: false, sourceChanges: ['src/loop.js'], testChanges: [], reason: 'Wiring only.' }]);
  });

  it('a blank no_tests_reason exempts nothing', () => {
    const [row] = componentCoverage([{ path: 'src/loop.js', status: 'M' }], [{ ...C, no_tests_reason: '  ' }]);
    expect(row?.untested).toBe(true);
    expect(row?.reason).toBeNull();
  });

  it('a deleted source still counts as a source change', () => {
    const [row] = componentCoverage([{ path: 'src/old.js', status: 'D' }], [C]);
    expect(row).toEqual({ name: 'loop', untested: true, sourceChanges: ['src/old.js'], testChanges: [], reason: null });
  });

  it('matches case-insensitively and reaches dot files, as the protected paths do', () => {
    const [row] = componentCoverage(
      [
        { path: 'SRC/Loop.js', status: 'M' },
        { path: 'src/.hidden.js', status: 'A' },
      ],
      [C],
    );
    expect(row?.sourceChanges).toEqual(['SRC/Loop.js', 'src/.hidden.js']);
  });

  it('judges each component on its own globs', () => {
    const ui: CoverageComponent = { name: 'ui', sources: ['web/**'], tests: ['web-test/**'], no_tests_reason: null };
    const rows = componentCoverage(
      [
        { path: 'src/loop.js', status: 'M' },
        { path: 'web/hud.js', status: 'M' },
        { path: 'web-test/hud.test.js', status: 'A' },
      ],
      [C, ui],
    );
    expect(rows.map(({ name, untested }) => [name, untested])).toEqual([
      ['loop', true],
      ['ui', false],
    ]);
  });

  it('a component with no test globs can never be tested, only exempt', () => {
    const [row] = componentCoverage([{ path: 'src/loop.js', status: 'M' }], [{ ...C, tests: [] }]);
    expect(row?.untested).toBe(true);
  });
});

describe('coverageTable', () => {
  it('shows each component with its changes and status', () => {
    const table = coverageTable(
      componentCoverage(
        [
          { path: 'src/loop.js', status: 'M' },
          { path: 'src/hud.js', status: 'M' },
          { path: 'test/hud.test.js', status: 'A' },
        ],
        [C, { name: 'hud', sources: ['src/hud.js'], tests: ['test/hud.test.js'], no_tests_reason: null }, { name: 'audio', sources: ['audio/**'], tests: [], no_tests_reason: 'Sound is judged by ear.' }, { name: 'gen', sources: ['gen/**'], tests: [], no_tests_reason: 'Generated.' }],
      ),
    );
    const lines = table.split('\n');
    expect(lines[0]).toBe('| Component | Source changes | Test changes | Status |');
    expect(lines[1]).toBe('| --- | --- | --- | --- |');
    expect(table).toContain('| loop | src/loop.js, src/hud.js | test/hud.test.js | tested |');
    expect(table).toContain('| hud | src/hud.js | test/hud.test.js | tested |');
    expect(table).toContain('| audio | - | - | no change |');
  });

  it('marks an untested component', () => {
    const table = coverageTable(componentCoverage([{ path: 'src/loop.js', status: 'M' }], [C]));
    expect(table).toContain('| loop | src/loop.js | - | untested |');
  });

  it('shows exempt: <reason>', () => {
    const table = coverageTable(componentCoverage([{ path: 'src/loop.js', status: 'M' }], [{ ...C, tests: [], no_tests_reason: 'Wiring only.' }]));
    expect(table).toContain('| loop | src/loop.js | - | exempt: Wiring only. |');
  });

  it('keeps a long list short and a pipe inside its cell', () => {
    const changes = Array.from({ length: 8 }, (_, k) => ({ path: `src/f${k}.js`, status: 'M' }));
    const table = coverageTable(componentCoverage(changes, [C]));
    expect(table).toContain('src/f0.js, src/f1.js, src/f2.js, src/f3.js, src/f4.js, +3 more');
    expect(table).not.toContain('src/f7.js');
    expect(coverageTable(componentCoverage([{ path: 'src/a|b.js', status: 'M' }], [C]))).toContain('src/a\\|b.js');
  });
});

describe('untestedEvidence', () => {
  const changes = Array.from({ length: 7 }, (_, k) => ({ path: `src/f${k}.js`, status: 'M' }));
  const components = [C, { name: 'hud', sources: ['web/**'], tests: ['web-test/**'], no_tests_reason: null }];

  it('names the component, its paths and its globs', () => {
    const text = untestedEvidence(componentCoverage(changes, components), components);
    expect(text).toContain('loop');
    expect(text).toContain('src/f0.js');
    expect(text).toContain('src/f4.js');
    expect(text).toContain('src/**/*.test.js');
    expect(text).toContain('test/**');
    expect(text.trimEnd().endsWith('Add or update tests that match those globs.')).toBe(true);
  });

  it('lists the first five changed paths only', () => {
    const text = untestedEvidence(componentCoverage(changes, components), components);
    expect(text).not.toContain('src/f5.js');
    expect(text).not.toContain('src/f6.js');
    expect(text).toContain('2 more');
  });

  it('leaves out a component that is tested, exempt or untouched', () => {
    const rows = componentCoverage(
      [
        { path: 'src/loop.js', status: 'M' },
        { path: 'test/loop.test.js', status: 'A' },
      ],
      components,
    );
    expect(untestedEvidence(rows, components)).toBe('');
  });
});
