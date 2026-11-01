// Model and command text inside a document the engine writes: none of these can start a section of its own.
export const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ');

export const quoted = (text: string): string =>
  text
    .trimEnd()
    .split(/\r\n?|\n/)
    .map((line) => `> ${line}`)
    .join('\n');

export function fenced(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text.trimEnd()}\n${fence}`;
}
