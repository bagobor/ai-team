import { sectionsOf } from '../../artifacts/format.ts';
import { oneLine } from './text.ts';
import { touchesProblem } from './tickets.ts';

export type Size = 'S' | 'M' | 'L';
export type ComponentSpec = { name: string; responsibility: string; sources: string[]; tests: string[]; no_tests_reason: string | null; complexity: Size; complexity_notes: string };
export type PerformanceBudget = { metric: string; target: string; how_measured: string; component: string | null };
export type TechStructure = { components: ComponentSpec[]; complexity: { overall: Size; rationale: string }; performance: PerformanceBudget[]; test_strategy: string; risks: { risk: string; mitigation: string }[] };

const SIZES: readonly string[] = ['S', 'M', 'L'];
const SECTIONS: readonly string[] = ['Overview', 'Components', 'Complexity', 'Performance', 'Test strategy', 'Risks'];
const blank = (text: string): boolean => text.trim() === '';
// The engine owns the headings, so a line of the model's that starts one would add a section a pin could name.
export const headed = (field: string, text: string): string[] => (/^\s*#/m.test(text) ? [`${field} has a line that starts with #; headings are not allowed`] : []);

// Models wrote all of it. The schema keeps the shapes right, so these are the rules a schema cannot say, and each message names what to fix.
export function structureProblems(s: TechStructure): string[] {
  const problems: string[] = [];
  if (s.components.length === 0) problems.push('components is empty; the Tech Design needs at least one component');

  const seen = new Set<string>();
  s.components.forEach((component, index) => {
    const name = component.name.trim();
    const label = name === '' ? `component ${index + 1}` : `component "${name}"`;
    if (name === '') problems.push(`${label} has a blank name`);
    else if (seen.has(name)) problems.push(`${label} appears more than once`);
    seen.add(name);

    if (component.sources.length === 0) problems.push(`${label}: sources is empty; name at least one glob`);
    for (const [field, globs] of [['sources', component.sources], ['tests', component.tests]] as const) {
      for (const glob of globs) {
        // A component's globs say which files are its own, and a negation would make that depend on the order they are read in.
        const problem = glob.trimStart().startsWith('!') ? 'is negated; negated globs are not allowed' : touchesProblem(glob);
        if (problem) problems.push(`${label}: ${field} glob ${JSON.stringify(glob)} ${problem}`);
      }
    }
    if (component.tests.length === 0 && blank(component.no_tests_reason ?? '')) problems.push(`${label}: tests is empty and there is no no_tests_reason`);
    if (!SIZES.includes(component.complexity)) problems.push(`${label}: complexity ${JSON.stringify(component.complexity)} is not S, M or L`);
    if (blank(component.complexity_notes)) problems.push(`${label}: complexity_notes is blank`);
    for (const field of ['responsibility', 'complexity_notes'] as const) problems.push(...headed(field, component[field]).map((problem) => `${label}: ${problem}`));
  });

  if (!SIZES.includes(s.complexity.overall)) problems.push(`complexity.overall ${JSON.stringify(s.complexity.overall)} is not S, M or L`);
  if (blank(s.complexity.rationale)) problems.push('complexity.rationale is blank');
  problems.push(...headed('complexity.rationale', s.complexity.rationale));

  if (s.performance.length === 0) problems.push('performance is empty; give at least one entry');
  s.performance.forEach((entry, index) => {
    for (const field of ['metric', 'target', 'how_measured'] as const) if (blank(entry[field])) problems.push(`performance entry ${index + 1}: ${field} is blank`);
  });

  if (blank(s.test_strategy)) problems.push('test_strategy is blank');
  problems.push(...headed('test_strategy', s.test_strategy));
  s.risks.forEach(({ risk, mitigation }, index) => problems.push(...headed(`risk ${index + 1}: risk`, risk), ...headed(`risk ${index + 1}: mitigation`, mitigation)));
  return problems;
}

// A Tech Design as a worker writes it: the structure's rules, no heading in the body, and, once those hold, the engine's
// headings where the rendering put them. A code block the body or a field leaves open would hide the ones after it.
export function designProblems(body: string, s: TechStructure): string[] {
  const problems = [...headed('body', body), ...structureProblems(s)];
  if (problems.length > 0) return problems;
  const found = sectionsOf(renderTechDesign(body, s))
    .filter(({ level }) => level <= 2)
    .map(({ title }) => title);
  if (found.length === SECTIONS.length && found.every((title, index) => title === SECTIONS[index])) return [];
  return [`The body or a field opens a code block that hides the engine's headings: expected ${SECTIONS.join(', ')}; found ${found.join(', ') || 'none'}`];
}

const cell = (text: string): string => oneLine(text).replaceAll('|', '\\|');
const code = (globs: string[]): string => globs.map((glob) => `\`${oneLine(glob)}\``).join(', ');
const codeCell = (globs: string[]): string => globs.map((glob) => `\`${cell(glob)}\``).join(', ');

// What a ticket is held to, a row for each component: the name a ticket gives, the files it owns and where its tests live.
export function componentTable(components: ComponentSpec[]): string {
  const tests = ({ tests, no_tests_reason }: ComponentSpec) => (tests.length > 0 ? codeCell(tests) : `none: ${cell(no_tests_reason ?? '')}`);
  return [
    '| Component | Sources | Tests | Complexity |',
    '| --- | --- | --- | --- |',
    ...components.map((component) => `| ${cell(component.name.trim())} | ${codeCell(component.sources)} | ${tests(component)} | ${component.complexity} |`),
  ].join('\n');
}

function componentSection(component: ComponentSpec): string[] {
  const tests = component.tests.length > 0 ? code(component.tests) : `none (${oneLine(component.no_tests_reason ?? '')})`;
  return [`### ${oneLine(component.name.trim())}`, '', oneLine(component.responsibility), '', `- Sources: ${code(component.sources)}`, `- Tests: ${tests}`, `- Complexity: ${component.complexity}. ${oneLine(component.complexity_notes)}`, ''];
}

// The headings are the engine's, so a pin can name a section and the model's text cannot move one: body and test_strategy are the only
// free-form parts, and every other field is flattened to a line.
export function renderTechDesign(body: string, s: TechStructure): string {
  return [
    '## Overview',
    '',
    body.trim(),
    '',
    '## Components',
    '',
    ...s.components.flatMap(componentSection),
    '## Complexity',
    '',
    `Overall: ${s.complexity.overall}. ${oneLine(s.complexity.rationale)}`,
    '',
    '## Performance',
    '',
    '| Metric | Target | How measured | Component |',
    '| --- | --- | --- | --- |',
    ...s.performance.map((entry) => `| ${cell(entry.metric)} | ${cell(entry.target)} | ${cell(entry.how_measured)} | ${entry.component === null ? '-' : cell(entry.component)} |`),
    '',
    '## Test strategy',
    '',
    s.test_strategy.trim(),
    '',
    '## Risks',
    '',
    ...(s.risks.length > 0 ? s.risks.map(({ risk, mitigation }) => `- ${oneLine(risk)}: ${oneLine(mitigation)}`) : ['None named.']),
    '',
  ].join('\n');
}

// An older Tech Design has no structure, and so no components to hold a ticket to.
export function structureOf(doc: { fields?: Record<string, unknown> } | undefined): TechStructure | undefined {
  const data = doc?.fields?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const { components } = data as { components?: unknown };
  return Array.isArray(components) && components.length > 0 ? (data as TechStructure) : undefined;
}
