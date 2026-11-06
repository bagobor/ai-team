import { replaceSection, type ArtifactDoc } from '../artifacts/format.ts';
import type { ManifestInput } from '../manifest/build.ts';
import { charsForTokens } from '../manifest/tokens.ts';
import { criteriaSlug } from './apply/milestone.ts';
import { notedLines, type QaRecord } from './apply/qa.ts';
import { oneLine, quoted } from './apply/text.ts';
import { designReference, type Reference } from './role-inputs.ts';
import type { EngineDeps } from './runner.ts';
import type { CriterionRow, ProjectRow } from './store.ts';

// Nothing before the review bounds what QA writes, and running out of room here would stop a finished milestone.
// The rest is the PM's own, which may include a table of the criteria under its own heading.
// It gave up 100 when the Tech Design's pointer came in.
const QA_WORDS_TOKENS = 2400;

// The longest texts give way first, so a short note always survives whole.
function limitFor(lengths: number[], room: number): number {
  let left = room;
  const sorted = [...lengths].sort((a, b) => a - b);
  for (const [i, length] of sorted.entries()) {
    const share = left / (sorted.length - i);
    if (length > share) return Math.floor(share);
    left -= length;
  }
  return Infinity;
}

function specView(doc: ArtifactDoc, criteria: CriterionRow[]): string {
  const list = criteria.map(({ ac_id, status, text }) => `- ${ac_id} (${status}): ${oneLine(text)}`).join('\n');
  const slug = criteriaSlug(doc.body);
  return (slug === undefined ? undefined : replaceSection(doc.body, slug, list)) ?? doc.body;
}

function qaView(doc: ArtifactDoc): string {
  const { summary, verdicts } = doc.fields.data as QaRecord;
  const limit = limitFor([summary, ...verdicts.flatMap(({ notes, noted }) => [notes, ...noted])].map(({ length }) => length), charsForTokens(QA_WORDS_TOKENS));
  const cut = (text: string) => (text.length <= limit ? text : `${text.slice(0, limit)} [cut: ${text.length - limit} more characters]`);
  const sections = verdicts
    .filter(({ notes, noted }) => notes.trim() !== '' || noted.length > 0)
    .flatMap(({ ac, status, notes, noted }) => [`## ${ac} (${status})`, '', ...(notes.trim() === '' ? [] : [quoted(cut(notes)), '']), ...notedLines(noted.map(cut))]);
  return [quoted(cut(summary)), '', ...sections].join('\n');
}

// The review starts once every criterion has passed or been waived, and the engine writes the criteria table itself.
// So the PM reads what people wrote, not the commands that fill these documents. The pins stay whole, for the lineage.
export async function reviewInputs({ artifacts, store }: Pick<EngineDeps, 'artifacts' | 'store'>, project: ProjectRow, milestone: number, pins: string[]): Promise<{ inputs: ManifestInput[]; reference?: Reference }> {
  const criteria = await store.listCriteria(project.id, milestone);
  let reference: Reference | undefined;
  const inputs = await Promise.all(
    pins.map(async (pin) => {
      const input = await artifacts.readInput(project, pin);
      const doc = await artifacts.read(project, pin);
      if (doc.type === 'spec') return { ...input, content: specView(doc, criteria) };
      if (doc.type === 'qa_report') return { ...input, content: qaView(doc) };
      if (doc.type === 'test_plan') return { ...input, content: doc.body };
      if (doc.type === 'tech_design') {
        const design = designReference(doc);
        reference = design.reference;
        return { ...input, content: design.content };
      }
      return input;
    }),
  );
  return { inputs, ...(reference ? { reference } : {}) };
}
