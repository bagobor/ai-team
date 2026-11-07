import picomatch from 'picomatch';
import { oneLine } from '../engine/apply/text.ts';
import type { ComponentSpec } from '../engine/apply/tech-structure.ts';

export type PathChange = { path: string; status: string };
export type CoverageComponent = Pick<ComponentSpec, 'name' | 'sources' | 'tests' | 'no_tests_reason'>;
export type ComponentCoverage = { name: string; sourceChanges: string[]; testChanges: string[]; untested: boolean; reason: string | null };

const SHOWN = 5;
const TESTS_BACK = 'Add or update tests that match those globs.';

// As run-checks matches protected paths. An empty list matches nothing.
const matcher = (globs: string[]) => picomatch(globs, { dot: true, nocase: true });

// A source change is any change under the sources that is not itself a test; a deleted test is no test, since it proves nothing about the new code.
export function componentCoverage(changes: PathChange[], components: CoverageComponent[]): ComponentCoverage[] {
  return components.map(({ name, sources, tests, no_tests_reason }) => {
    const isSource = matcher(sources);
    const isTest = matcher(tests);
    const sourceChanges = changes.filter(({ path }) => isSource(path) && !isTest(path)).map(({ path }) => path);
    const testChanges = changes.filter(({ path, status }) => isTest(path) && !status.startsWith('D')).map(({ path }) => path);
    const reason = no_tests_reason !== null && no_tests_reason.trim() !== '' ? no_tests_reason : null;
    return { name, sourceChanges, testChanges, untested: sourceChanges.length > 0 && testChanges.length === 0 && reason === null, reason };
  });
}

const cell = (text: string): string => oneLine(text).replaceAll('|', '\\|');
const paths = (list: string[]): string => (list.length === 0 ? '-' : cell([...list.slice(0, SHOWN), ...(list.length > SHOWN ? [`+${list.length - SHOWN} more`] : [])].join(', ')));

function statusOf(row: ComponentCoverage): string {
  if (row.sourceChanges.length === 0) return 'no change';
  if (row.untested) return 'untested';
  return row.testChanges.length > 0 ? 'tested' : `exempt: ${row.reason}`;
}

export function coverageTable(rows: ComponentCoverage[]): string {
  return ['| Component | Source changes | Test changes | Status |', '| --- | --- | --- | --- |', ...rows.map((row) => `| ${cell(row.name)} | ${paths(row.sourceChanges)} | ${paths(row.testChanges)} | ${cell(statusOf(row))} |`)].join('\n');
}

// Empty when nothing is untested. The paths are a few of the changed ones, enough to find the code, and the globs are what the new tests must match.
export function untestedEvidence(rows: ComponentCoverage[], components: CoverageComponent[]): string {
  const untested = rows.filter((row) => row.untested);
  if (untested.length === 0) return '';
  const lines = untested.map(({ name, sourceChanges }) => {
    const globs = components.find((component) => component.name === name)?.tests ?? [];
    const more = sourceChanges.length > SHOWN ? ` and ${sourceChanges.length - SHOWN} more` : '';
    return `- ${name}: changed ${sourceChanges.slice(0, SHOWN).join(', ')}${more}; test globs: ${globs.length > 0 ? globs.join(', ') : 'none'}`;
  });
  return ['These components changed source files and have no added or updated test:', ...lines, TESTS_BACK].join('\n');
}
