import { AC_SLUG, type Criterion } from '../artifacts/acs.ts';
import { parsePin, replaceSection, sectionsOf, type ArtifactDoc, type ArtifactType, type Pin, type Section } from '../artifacts/format.ts';
import type { NewVersion } from '../artifacts/store.ts';
import type { Coverage } from './apply/design.ts';
import { fenced, oneLine, quoted } from './apply/text.ts';
import type { EngineDeps } from './runner.ts';
import type { ArtifactVersionRow, ProjectRow, Store } from './store.ts';

export type ChangeRequestInput = {
  target_artifact: string;
  target_section?: string;
  target_ac?: string;
  proposed_text: string;
  rationale: string;
  evidence: string;
  raised_by: string;
  // The task whose worker raised it. A ticket that failed on what it raised waits for it to be decided.
  raised_in?: string;
};

export class ChangeRequestError extends Error {
  override name = 'ChangeRequestError';
}

type Deps = Pick<EngineDeps, 'artifacts' | 'store'>;
type Then = (s: Store, rows: ArtifactVersionRow[]) => Promise<void>;

// Each of these is owned by a role that can recommend. Everything else is either the stakeholder's or a record of what happened.
const CR_TARGET_TYPES: ArtifactType[] = ['roadmap', 'team_proposal', 'human_requirements', 'environment_profile', 'spec', 'tech_design', 'test_plan', 'ticket'];

// Each request costs a Recommendation task on the owner's model.
const MAX_RAISED = 5;

export const ownerOf = (target: ArtifactVersionRow): string => target.owner_role;

export const requestOf = (cr: Pick<ArtifactDoc, 'fields'>): ChangeRequestInput => cr.fields.data as ChangeRequestInput;

// A Test Plan's criterion is its commands, which its owner decides like any other section.
export const touchesCriterionText = (cr: Pick<ArtifactDoc, 'fields'>, target: Pick<ArtifactVersionRow, 'type'>): boolean => target.type === 'spec' && Boolean(requestOf(cr).target_ac);

const pinIn = (text: string): Pin | undefined => {
  try {
    return parsePin(text);
  } catch {
    return undefined;
  }
};

// A worker's schema may have made it fill in the target it doesn't mean, so blank counts as not named.
// Workers name what they read, which is a pin. The request is filed against the latest version, and applying it checks nothing moved.
function normalized(raw: ChangeRequestInput): ChangeRequestInput {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const named = text(raw.target_artifact).trim();
  const pin = pinIn(named);
  const ac = text(raw.target_ac).trim();
  const section = text(raw.target_section).trim() || (ac ? '' : (pin?.section ?? ''));
  const raisedIn = text(raw.raised_in).trim();
  return {
    target_artifact: pin?.id ?? named,
    ...(section ? { target_section: section } : {}),
    ...(ac ? { target_ac: ac } : {}),
    proposed_text: text(raw.proposed_text),
    rationale: text(raw.rationale),
    evidence: text(raw.evidence),
    raised_by: text(raw.raised_by),
    ...(raisedIn ? { raised_in: raisedIn } : {}),
  };
}

function withoutHeading(proposed: string, section: Section): string {
  const [first, ...rest] = proposed.trim().split('\n');
  const text = first?.trim() === section.text.split('\n')[0]?.trim() ? rest.join('\n').trim() : proposed.trim();
  if (!text) throw new ChangeRequestError(`The proposed text for ${section.slug} has only its heading`);
  return text;
}

// What a replacement must leave alone: everything but the section, what's under it and the sections that contain it.
function untouched(sections: Section[], slug: string): string[] {
  const index = sections.findIndex((section) => section.slug === slug);
  const level = sections[index]?.level ?? 0;
  const after = sections.findIndex((section, i) => i > index && section.level <= level);
  const end = after === -1 ? sections.length : after;

  const containers = new Set<number>();
  let depth = level;
  for (let i = index - 1; i >= 0; i -= 1) {
    if ((sections[i] as Section).level < depth) {
      containers.add(i);
      depth = (sections[i] as Section).level;
    }
  }
  return sections.filter((_, i) => (i < index || i >= end) && !containers.has(i)).map(({ slug: other, hash }) => `${other} ${hash}`);
}

const criteriaIn = (sections: Section[], except?: string): string[] =>
  sections.filter(({ slug }) => AC_SLUG.test(slug) && slug !== except).map(({ slug, hash }) => `${slug} ${hash}`);

const same = (a: string[], b: string[]): boolean => a.join('\n') === b.join('\n');

// Model text can hold a heading or an unclosed fence, which would rewrite sections the request never named.
function replaced(doc: ArtifactDoc, slug: string, text: string): { body: string; before: Section[]; after: Section[] } {
  const body = replaceSection(doc.body, slug, text) as string;
  const before = sectionsOf(doc.body);
  const after = sectionsOf(body);
  if (!same(untouched(before, slug), untouched(after, slug))) {
    throw new ChangeRequestError(`The proposed text for ${slug} in ${doc.id} would change sections outside it: a heading at that level, or a fence left open`);
  }
  return { body, before, after };
}

type Replacement = { body: string; fields: Record<string, unknown>; criterionText?: string };

function sectionReplacement(target: ArtifactVersionRow, doc: ArtifactDoc, slug: string, proposed: string): Replacement {
  const sections = sectionsOf(doc.body);
  const section = sections.find((other) => other.slug === slug);
  if (!section) throw new ChangeRequestError(`${doc.id} has no section ${JSON.stringify(slug)}. ${sections.length === 0 ? 'It has no sections' : `Its sections are ${sections.map((other) => other.slug).join(', ')}`}`);

  const { body, before, after } = replaced(doc, slug, withoutHeading(proposed, section));
  if (target.type === 'spec' && !same(criteriaIn(before), criteriaIn(after))) {
    throw new ChangeRequestError(`Section ${slug} of ${doc.id} would change criteria text: name the criterion with target_ac, which goes to the stakeholder`);
  }
  return { body, fields: doc.fields };
}

const coverageIn = (doc: ArtifactDoc): Coverage[] => {
  const coverage = (doc.fields.data as { coverage?: unknown } | undefined)?.coverage;
  return Array.isArray(coverage) ? (coverage as Coverage[]) : [];
};

// What QA verify runs is the coverage, not the prose, so a Test Plan criterion takes new commands, one per line.
function commandsReplacement(doc: ArtifactDoc, ac: string, proposed: string): Replacement {
  const coverage = coverageIn(doc);
  if (!coverage.some((row) => row.ac === ac)) throw new ChangeRequestError(`${doc.id} has no commands for ${ac}. It covers ${coverage.map((row) => row.ac).join(', ')}`);
  const commands = proposed.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const data = doc.fields.data as Record<string, unknown>;
  return { body: doc.body, fields: { ...doc.fields, data: { ...data, coverage: coverage.map((row) => (row.ac === ac ? { ...row, commands } : row)) } } };
}

async function criterionReplacement(deps: Deps, project: ProjectRow, target: ArtifactVersionRow, doc: ArtifactDoc, ac: string, proposed: string): Promise<Replacement> {
  if (target.type === 'test_plan') return commandsReplacement(doc, ac, proposed);
  if (target.type !== 'spec' || target.milestone === null) throw new ChangeRequestError(`${doc.id} is a ${target.type}, and only a Spec or a Test Plan holds criteria`);
  const criterion = (await deps.store.listCriteria(project.id, target.milestone)).find((row) => row.ac_id === ac);
  const slug = ac.toLowerCase();
  const section = sectionsOf(doc.body).find((other) => other.slug === slug);
  if (!criterion || !section) throw new ChangeRequestError(`${ac} is not a locked criterion of ${doc.id}`);

  const text = withoutHeading(proposed, section);
  const verified = section.text.includes('\nVerified by: ') ? `\n\nVerified by: ${criterion.verification.how}` : '';
  const { body, before, after } = replaced(doc, slug, `${text}${verified}`);
  if (after.length !== before.length) throw new ChangeRequestError(`The proposed text for ${ac} has a heading in it`);

  const data = doc.fields.data as { criteria?: Criterion[] } | undefined;
  const fields = Array.isArray(data?.criteria)
    ? { ...doc.fields, data: { ...data, criteria: data.criteria.map((other) => (other.id === ac ? { ...other, text } : other)) } }
    : doc.fields;
  return { body, fields, criterionText: text };
}

function replacement(deps: Deps, project: ProjectRow, target: ArtifactVersionRow, doc: ArtifactDoc, input: ChangeRequestInput): Replacement | Promise<Replacement> {
  return input.target_ac
    ? criterionReplacement(deps, project, target, doc, input.target_ac, input.proposed_text)
    : sectionReplacement(target, doc, input.target_section as string, input.proposed_text);
}

async function currentTarget(deps: Deps, project: ProjectRow, input: ChangeRequestInput): Promise<{ target: ArtifactVersionRow; doc: ArtifactDoc }> {
  const target = await deps.artifacts.latest(project.id, input.target_artifact);
  if (!target) throw new ChangeRequestError(`There is no document ${JSON.stringify(input.target_artifact)}`);
  // A proposed document isn't settled yet: Request changes is the way to change one.
  if (target.status !== 'approved' && target.status !== 'stale') throw new ChangeRequestError(`${target.artifact_id} is ${target.status}, and only an approved or stale document takes a Change Request`);
  return { target, doc: await deps.artifacts.read(project, `${target.artifact_id}@${target.version}`) };
}

async function validated(deps: Deps, project: ProjectRow, raw: ChangeRequestInput): Promise<{ input: ChangeRequestInput; target: ArtifactVersionRow }> {
  const input = normalized(raw);
  for (const field of ['proposed_text', 'rationale', 'evidence'] as const) {
    if (!input[field].trim()) throw new ChangeRequestError(`The request against ${JSON.stringify(input.target_artifact)} has a blank ${field}`);
  }
  const { target, doc } = await currentTarget(deps, project, input);
  if (!CR_TARGET_TYPES.includes(target.type)) throw new ChangeRequestError(`${target.artifact_id} is a ${target.type}, which no role can recommend on`);
  if (!input.target_section && !input.target_ac) throw new ChangeRequestError(`The request against ${target.artifact_id} names neither a section nor a criterion`);
  const resolved = input.target_section && input.target_ac ? oneTarget(input, target) : input;
  await replacement(deps, project, target, doc, resolved);
  return { input: resolved, target };
}

// Workers name the heading a criterion sits under as well as the criterion. Only a Spec or a Test Plan has criteria to mean.
function oneTarget(input: ChangeRequestInput, target: ArtifactVersionRow): ChangeRequestInput {
  const { target_section, target_ac, ...rest } = input;
  return target.type === 'spec' || target.type === 'test_plan' ? { ...rest, target_ac: target_ac as string } : { ...rest, target_section: target_section as string };
}

function requestBody(id: string, input: ChangeRequestInput, target: ArtifactVersionRow): string {
  const where = !input.target_ac ? `section ${input.target_section}` : target.type === 'test_plan' ? `the commands for ${input.target_ac}` : `criterion ${input.target_ac}`;
  return [
    `# ${id}`,
    `Raised by ${oneLine(input.raised_by)}${input.raised_in ? ` in ${oneLine(input.raised_in)}` : ''} against ${oneLine(`${target.artifact_id}@${target.version}, ${where}`)}.`,
    '## Proposed text',
    fenced(input.proposed_text),
    '## Rationale',
    quoted(input.rationale),
    '## Evidence',
    `${quoted(input.evidence)}\n`,
  ].join('\n\n');
}

function requestDoc(id: string, input: ChangeRequestInput, target: ArtifactVersionRow): NewVersion {
  return {
    id,
    type: 'change_request',
    status: 'proposed',
    ownerRole: ownerOf(target),
    derivedFrom: [`${target.artifact_id}@${target.version}`],
    ...(target.milestone === null ? {} : { milestone: target.milestone }),
    fields: { data: input },
    body: requestBody(id, input, target),
  };
}

// Numbers are picked before the commit, and attempts finish side by side, so the store alone can't say which are taken.
// A gap, from a commit that never came, is harmless.
const reservations = new WeakMap<object, Map<number, number>>();

async function reserveNumbers(deps: Deps, project: ProjectRow, count: number): Promise<number> {
  const taken = (await deps.artifacts.list(project.id)).map((row) => /^CR-(\d+)$/.exec(row.artifact_id)?.[1]).filter((n) => n !== undefined).map(Number);
  const held = reservations.get(deps.artifacts) ?? new Map<number, number>();
  reservations.set(deps.artifacts, held);
  const first = Math.max(0, ...taken, held.get(project.id) ?? 0) + 1;
  held.set(project.id, first + count - 1);
  return first;
}

export async function fileChangeRequest(deps: Deps, project: ProjectRow, raw: ChangeRequestInput): Promise<ArtifactVersionRow> {
  const { input, target } = await validated(deps, project, raw);
  const id = `CR-${await reserveNumbers(deps, project, 1)}`;
  const [row] = await deps.artifacts.commit(project, { message: `${id}: change request against ${target.artifact_id}`, publish: [requestDoc(id, input, target)] });
  return row as ArtifactVersionRow;
}

// What can't be filed comes back as a reason: the caller sends the worker back with it, or logs it when it keeps the work anyway.
export async function changeRequestDocs(deps: Deps, project: ProjectRow, inputs: ChangeRequestInput[]): Promise<{ docs: NewVersion[]; dropped: string[] }> {
  const accepted: Awaited<ReturnType<typeof validated>>[] = [];
  const dropped: string[] = [];
  for (const raw of inputs) {
    if (accepted.length === MAX_RAISED) {
      dropped.push(`The request against ${JSON.stringify(raw.target_artifact)} was dropped: one attempt can raise at most ${MAX_RAISED}`);
      continue;
    }
    try {
      accepted.push(await validated(deps, project, raw));
    } catch (error) {
      if (!(error instanceof ChangeRequestError)) throw error;
      dropped.push(error.message);
    }
  }
  if (accepted.length === 0) return { docs: [], dropped };
  const first = await reserveNumbers(deps, project, accepted.length);
  return { docs: accepted.map(({ input, target }, index) => requestDoc(`CR-${first + index}`, input, target)), dropped };
}

async function requestRow(deps: Deps, project: ProjectRow, crId: string): Promise<ArtifactVersionRow> {
  const cr = await deps.artifacts.latest(project.id, crId);
  if (cr?.type !== 'change_request') throw new ChangeRequestError(`${crId} is not a Change Request`);
  return cr;
}

// The request was written against one version. Another change to the same words since then would be silently undone.
async function refuseIfMoved(deps: Deps, project: ProjectRow, cr: ArtifactVersionRow, input: ChangeRequestInput, doc: ArtifactDoc): Promise<void> {
  const filedAgainst = cr.derived_from[0] as string;
  if (filedAgainst === `${doc.id}@${doc.version}`) return;
  const slug = input.target_ac?.toLowerCase() ?? (input.target_section as string);
  const wordsOf = (version: ArtifactDoc): string | undefined => {
    if (version.type === 'test_plan' && input.target_ac) {
      const commands = coverageIn(version).find((row) => row.ac === input.target_ac)?.commands;
      return commands === undefined ? undefined : JSON.stringify(commands);
    }
    return sectionsOf(version.body).find((section) => section.slug === slug)?.hash;
  };
  const was = wordsOf(await deps.artifacts.read(project, filedAgainst));
  if (was === undefined || was !== wordsOf(doc)) throw new ChangeRequestError(`${slug} of ${doc.id} has changed since ${cr.artifact_id} was filed against ${filedAgainst}`);
}

export async function applyChangeRequest(deps: Deps, project: ProjectRow, crId: string, then?: Then): Promise<void> {
  const cr = await requestRow(deps, project, crId);
  if (cr.status === 'approved') {
    await deps.artifacts.commit(project, { message: `${crId}: already applied` }, then);
    return;
  }
  if (cr.status !== 'proposed') throw new ChangeRequestError(`${crId} is ${cr.status}, so it can't be applied`);

  const request = await deps.artifacts.read(project, `${crId}@${cr.version}`);
  const input = requestOf(request);
  const { target, doc } = await currentTarget(deps, project, input);
  await refuseIfMoved(deps, project, cr, input, doc);
  const { body, fields, criterionText } = await replacement(deps, project, target, doc, input);

  const stillStale = target.status === 'stale';
  await deps.artifacts.commit(
    project,
    {
      message: `${crId}: apply to ${target.artifact_id}`,
      publish: [{
        id: target.artifact_id,
        type: target.type,
        status: 'approved',
        ownerRole: doc.ownerRole,
        approvedBy: `change_request:${crId}`,
        derivedFrom: doc.derivedFrom,
        ...(target.milestone === null ? {} : { milestone: target.milestone }),
        fields,
        acceptanceCriteria: doc.acceptanceCriteria,
        body,
      }],
      status: [{ id: crId, status: 'approved', approvedBy: touchesCriterionText(request, target) ? 'stakeholder' : `owner:${cr.owner_role}` }],
    },
    async (s, rows) => {
      if (criterionText !== undefined) {
        const spec = rows.find((row) => row.artifact_id === target.artifact_id) as ArtifactVersionRow;
        await s.reviseCriterion(project.id, target.milestone as number, input.target_ac as string, { text: criterionText, crId, specVersion: spec.version });
      }
      if (!stillStale) await then?.(s, rows);
    },
  );

  // Publishing approved is what marks the dependents, and it also clears what the target itself was stale about.
  // The Conductor's revise task hangs on that, so it goes back.
  if (stillStale) {
    await deps.artifacts.commit(project, { message: `${target.artifact_id}: still stale after ${crId}`, status: [{ id: target.artifact_id, status: 'stale', staleSections: target.stale_sections }] }, then);
  }
}

export async function rejectChangeRequest(deps: Deps, project: ProjectRow, crId: string, reason: string, then?: Then): Promise<void> {
  const cr = await requestRow(deps, project, crId);
  if (cr.status === 'approved') throw new ChangeRequestError(`${crId} has been applied, so it can't be rejected`);
  const change = cr.status === 'superseded'
    ? { message: `${crId}: already rejected` }
    : { message: `${crId}: rejected`, status: [{ id: crId, status: 'superseded' as const, rationale: reason }] };
  await deps.artifacts.commit(project, change, then);
}
