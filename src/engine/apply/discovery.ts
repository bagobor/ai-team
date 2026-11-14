import { isAbsolute } from 'node:path';
import picomatch from 'picomatch';
import { parsePin, sectionsOf } from '../../artifacts/format.ts';
import type { NewVersion } from '../../artifacts/store.ts';
import { keyProblem } from '../../checks/play.ts';
import { runSandboxed } from '../../checks/run-checks.ts';
import { gitOk } from '../../git/git.ts';
import { mustSupportItems } from '../conductor/tasks.ts';
import type { MsItem } from '../must-support.ts';
import { protectedProblems } from '../protected.ts';
import { ENV_PROFILE, FUN_DEFINITION } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';
import { sandboxEnv } from './sandbox.ts';
import { oneLine } from './text.ts';

type FunElement = { id: string; element: string; evidence: string[]; how_to_check: string };
type FunDefinition = { body: string; elements: FunElement[] };

type DiscoveryOutput = {
  roadmap: { body: string; milestones: { n: number; title: string; goal: string }[] };
  team_proposal: { body: string };
  human_requirements: { body: string };
  // A project that does not prototype has none. Output is not checked against the schema before it gets here, so a missing key reads as null.
  fun_definition?: FunDefinition | null;
};

// `animated` is false for a page with no animation loop; a profile that leaves it out is played as a game.
export type PlayBlock = { root: string; entry: string; keys: string[]; animated?: boolean };

// The command that proves a must-support item, and the files it reads, which no ticket may change.
export type MsCheckCommand = { item: string; command: string; protected: string[] };

// What a published Environment Profile holds as data, for everything that builds or plays the product.
// A profile published before the play gate has no play at all, which its readers take as null. One from before the
// must-support list, or for a list with nothing checked by command, has no checks.
export type ProfileData = {
  commands: { build: string; test: string; lint: string; smoke: string };
  toolchains: string[];
  network_allow: string[];
  setup: string | null;
  play: PlayBlock | null;
  must_support_checks?: MsCheckCommand[];
};

type ProfileOutput = ProfileData & { body: string };

const commandItems = (items: MsItem[]) => items.filter(({ check }) => check === 'command');

// The ids of the items checked by command that the profile has no command for.
export function missingChecks(profile: ProfileData, items: MsItem[]): string[] {
  const checked = (profile.must_support_checks ?? []).map(({ item }) => item);
  return commandItems(items).map(({ id }) => id).filter((id) => !checked.includes(id));
}

// `tracked` is every file on the base branch: a protected glob that matches none of them protects nothing the command reads.
export function checkCommandProblems(checks: MsCheckCommand[] | undefined, items: MsItem[], tracked: string[], base: string): string[] {
  const wanted = commandItems(items);
  const given = checks ?? [];
  const problems = wanted.filter(({ id }) => !given.some(({ item }) => item === id)).map(({ id, text }) => `must_support_checks has no command for ${id} (${oneLine(text).trim()})`);
  const seen = new Set<string>();
  for (const { item, command, protected: globs } of given) {
    if (!wanted.some(({ id }) => id === item)) problems.push(`must_support_checks names ${item}, which is not checked by command`);
    else if (seen.has(item)) problems.push(`must_support_checks names ${item} twice`);
    else if (command.trim() === '') problems.push(`${item}'s command is empty`);
    seen.add(item);
    const refused = protectedProblems(globs);
    problems.push(...refused);
    if (refused.length > 0) continue;
    for (const glob of globs) {
      const matches = picomatch(glob, { dot: true });
      if (!tracked.some((path) => matches(path))) problems.push(`${glob} matches no file on ${base}: protect only files the command reads`);
    }
  }
  return problems;
}

// The files on the base branch are read only when a check protects any.
export async function commandCheckProblems({ project }: Pick<ApplyCtx, 'project'>, checks: MsCheckCommand[] | undefined, items: MsItem[]): Promise<string[]> {
  const protects = (checks ?? []).some(({ protected: globs }) => Array.isArray(globs) && globs.length > 0);
  const tracked = protects ? (await gitOk(project.repo_path, ['ls-tree', '-r', '-z', '--name-only', project.base_branch])).split('\0').filter((path) => path !== '') : [];
  return checkCommandProblems(checks, items, tracked, project.base_branch);
}

const CHECKS_HEADING = '## Must-support checks';

// The engine writes the checks as the profile's last section, so a later set replaces the one before it.
export function profileBody(body: string, checks: MsCheckCommand[] = []): string {
  const at = body.lastIndexOf(`\n${CHECKS_HEADING}\n`);
  if (checks.length === 0) return at === -1 ? body : `${body.slice(0, at).trimEnd()}\n`;
  const lines = checks.map(({ item, command, protected: globs }) => `- ${item}: \`${oneLine(command).trim()}\`${globs.length > 0 ? ` (protects ${globs.join(', ')})` : ''}`);
  return `${(at === -1 ? body : body.slice(0, at)).trimEnd()}\n\n${CHECKS_HEADING}\n\n${lines.join('\n')}\n`;
}

// The profile the engine builds and plays by: one the stakeholder approved, or that went stale because something it read moved on.
// A proposed one has not been agreed, and nothing is built from it.
export async function approvedProfile({ deps, project }: Pick<ApplyCtx, 'deps' | 'project'>): Promise<ProfileData | null> {
  const row = await deps.artifacts.latest(project.id, ENV_PROFILE);
  if (row?.status !== 'approved' && row?.status !== 'stale') return null;
  return (await deps.artifacts.read(project, ENV_PROFILE)).fields.data as ProfileData;
}

const DISCOVERY_IDS = new Set(['ROADMAP', 'TEAM-PROPOSAL', 'HUMAN-REQUIREMENTS', FUN_DEFINITION]);

const FUN_ELEMENT_ID = /^F-\d+$/;
// A pin's version has no leading zero, so one that does is malformed here, before the store reads it.
const FUN_EVIDENCE = /^DEC-(\d+)@([1-9]\d*)#p-(\d+)$/;
const FUN_HEADING = /^F-\d+\b/i;
// Every Spec reads FUN-DEFINITION, and a Spec over its budget can never recover, so the definition is held to what fits.
const MAX_FUN_ELEMENTS = 6;
const MAX_FUN_BODY = 1_500;

// Why a pin is no evidence of fun, as the end of its refusal: empty when the stakeholder's own mark is what rules it out,
// and undefined when they marked the prototype fun. Only a human marks fun, so this reads the Decision Record of their answer
// and nothing the PM or the engine said about it.
async function notFun({ deps, project }: ApplyCtx, [, id, version, k]: RegExpExecArray): Promise<string | undefined> {
  const decision = `DEC-${id}`;
  const row = await deps.artifacts.version(project.id, decision, Number(version));
  if (!row) return ': there is no such decision record';
  const { ref, answer } = ((await deps.artifacts.read(project, `${decision}@${version}`)).fields.data ?? {}) as { ref?: { kind?: string }; answer?: { action?: string; checks?: { ac: string; status: string }[] } };
  if (row.type !== 'decision_record' || ref?.kind !== 'fun_eval') return ": it is not the stakeholder's verdict on a prototype round";
  // A reject keeps its marks as data and not as sections, so a pin to one would name a section that is not there.
  if (answer?.action === 'reject') return '';
  return answer?.checks?.some(({ ac, status }) => ac === `P-${k}` && status === 'passing') ? undefined : '';
}

// What discovery must write down about a prototyping project's fun, and that the PM may write down only what the stakeholder
// found fun. Each problem names the element it is about, by its place when its own id may be the problem.
async function funProblems(ctx: ApplyCtx, fun: FunDefinition | null): Promise<string[]> {
  if (ctx.project.prototyping !== 1) return fun === null ? [] : ['This project is not prototyping, so fun_definition must be null'];
  if (fun === null) return ['A prototyping project needs a fun_definition: the elements the stakeholder found fun, each citing a prototype they marked fun'];
  if (fun.elements.length === 0) return ['The fun_definition needs at least one element'];
  const size = [
    ...(fun.elements.length > MAX_FUN_ELEMENTS ? [`The fun_definition has ${fun.elements.length} elements, and at most ${MAX_FUN_ELEMENTS} fit in a Spec's budget: keep the ones the stakeholder found most fun`] : []),
    ...(fun.body.trim().length > MAX_FUN_BODY ? [`The fun_definition body is ${fun.body.trim().length} characters, and at most ${MAX_FUN_BODY} fit in a Spec's budget: shorten it`] : []),
  ];
  if (size.length > 0) return size;
  const own = sectionsOf(fun.body).find(({ title }) => FUN_HEADING.test(title));
  if (own) return [`The fun_definition body has its own element heading, ${JSON.stringify(own.title)}: the engine writes those`];

  const problems: string[] = [];
  const defined = new Set<string>();
  for (const [index, { id, element, evidence, how_to_check }] of fun.elements.entries()) {
    const say = (problem: string) => problems.push(`Element ${index + 1}: ${problem}`);
    if (!FUN_ELEMENT_ID.test(id)) say(`id ${JSON.stringify(id)} must look like F-1`);
    else if (defined.has(id)) say(`id ${id} is already used`);
    defined.add(id);
    if (element.trim() === '') say('element is blank');
    if (how_to_check.trim() === '') say('how_to_check is blank');

    const name = FUN_ELEMENT_ID.test(id) ? id : `Element ${index + 1}`;
    if (evidence.length === 0) problems.push(`${name} cites no prototype the stakeholder marked fun`);
    for (const pin of evidence) {
      const match = FUN_EVIDENCE.exec(pin);
      if (!match) {
        problems.push(`${name} evidence ${JSON.stringify(pin)} must look like DEC-12@1#p-1: the fun-eval decision record, its version and the prototype the stakeholder marked fun`);
        continue;
      }
      const why = await notFun(ctx, match);
      if (why !== undefined) problems.push(`${name} cites ${pin}, which the stakeholder did not mark fun${why}`);
    }
  }
  return problems;
}

// The PM's text, then one section per element under the engine's F-n heading, so CP1 shows each element and a pin can name
// one. Each field is flattened to a line, so none of them adds a heading.
function renderFun({ body, elements }: FunDefinition): string {
  const head = body.trimEnd();
  const sections = elements.flatMap(({ id, element, evidence, how_to_check }) => [`## ${id}`, '', oneLine(element).trim(), '', `- Evidence: ${evidence.join(', ')}`, `- How to check: ${oneLine(how_to_check).trim()}`, '']);
  return [...(head === '' ? [] : [head, '']), ...sections].join('\n');
}

// A code block the PM's text leaves open would hide the headings after it.
function hiddenHeadings(rendered: string, { elements }: FunDefinition): string[] {
  const expected = elements.map(({ id }) => id);
  const found = sectionsOf(rendered).map(({ title }) => title).filter((title) => FUN_HEADING.test(title));
  return found.length === expected.length && found.every((title, index) => title === expected[index]) ? [] : [`The fun_definition body opens a code block that hides the engine's element headings: expected ${expected.join(', ')}; found ${found.join(', ') || 'none'}`];
}

// It rests on the marks it cites, each once, and on nothing else the round read.
const funDocument = (fun: FunDefinition, body: string): NewVersion => ({
  id: FUN_DEFINITION,
  type: 'fun_definition',
  status: 'proposed',
  ownerRole: 'pm',
  derivedFrom: [...new Set(fun.elements.flatMap(({ evidence }) => evidence))],
  body,
  fields: { data: fun.elements },
});

export const applyDiscovery: Applier = async (ctx) => {
  const { roadmap, team_proposal, human_requirements, fun_definition } = ctx.output as DiscoveryOutput;
  const fun = fun_definition ?? null;
  const { milestones } = roadmap;

  if (milestones.length === 0) return { ok: false, evidence: 'The roadmap has no milestones' };
  const gap = milestones.findIndex(({ n }, i) => n !== i + 1);
  if (gap !== -1) return { ok: false, evidence: `Milestones must be numbered 1, 2, 3 with no gap, but number ${gap + 1} is ${milestones[gap]!.n}` };
  const untitled = milestones.find(({ title }) => title.trim() === '');
  if (untitled) return { ok: false, evidence: `Milestone ${untitled.n} has a blank title` };
  const unfounded = await funProblems(ctx, fun);
  if (unfounded.length > 0) return { ok: false, evidence: unfounded.join('\n') };
  const funBody = fun ? renderFun(fun) : '';
  const hidden = fun ? hiddenHeadings(funBody, fun) : [];
  if (hidden.length > 0) return { ok: false, evidence: hidden.join('\n') };

  // A redo round reads the documents it replaces: those are its history, not its sources.
  const derivedFrom = ctx.order.inputs.filter((pin) => !DISCOVERY_IDS.has(parsePin(pin).id));
  const doc = { status: 'proposed', ownerRole: 'pm', derivedFrom } as const;
  return withRaised(ctx, {
    message: fun ? 'discovery: roadmap, team proposal, human requirements and fun definition' : 'discovery: roadmap, team proposal and human requirements',
    publish: [
      { ...doc, id: 'ROADMAP', type: 'roadmap', body: roadmap.body, fields: { data: milestones } },
      { ...doc, id: 'TEAM-PROPOSAL', type: 'team_proposal', body: team_proposal.body },
      { ...doc, id: 'HUMAN-REQUIREMENTS', type: 'human_requirements', body: human_requirements.body },
      ...(fun ? [funDocument(fun, funBody)] : []),
    ],
  });
};

// The allow-list goes to the sandbox as it is, so anything but a plain domain would either fail there or mean more than it says.
function isBareDomain(entry: string): boolean {
  const labels = entry.split('.');
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) && /[a-z]/i.test(labels.at(-1)!);
}

// The root and entry are joined onto a checkout and served from it, so neither may climb out. Nothing checks the
// output against its schema before this, so a missing play is caught here too.
const climbs = (path: string) => isAbsolute(path) || path.split(/[\\/]/).includes('..');

function playProblems(play: PlayBlock | null | undefined): string[] {
  if (play === undefined) return ['play is missing: give the root, entry and keys a person plays the product with, or null when nothing runs in a browser'];
  if (play === null) return [];
  const problems: string[] = [];
  const { root, entry, keys, animated } = play;
  if (typeof root !== 'string' || root.trim() === '' || climbs(root)) problems.push(`play.root must be a directory inside the repo, such as . or dist, not ${JSON.stringify(root)}`);
  if (typeof entry !== 'string' || !entry.endsWith('.html') || climbs(entry)) problems.push(`play.entry must be an .html page under play.root, not ${JSON.stringify(entry)}`);
  if (!Array.isArray(keys) || keys.length === 0) problems.push('play.keys needs at least one key the game reads');
  else problems.push(...keys.flatMap((key) => keyProblem(key) ?? []).map((problem) => `play.keys: ${problem}`));
  if (animated !== undefined && typeof animated !== 'boolean') problems.push(`play.animated must be true or false, or left out for a page with an animation loop, not ${JSON.stringify(animated)}`);
  return problems;
}

export const applyEnvironmentProfile: Applier = async (ctx) => {
  const { body, commands, toolchains, network_allow, setup, play, must_support_checks: checks } = ctx.output as ProfileOutput;

  const bad = network_allow.filter((entry) => !isBareDomain(entry));
  if (bad.length > 0) return { ok: false, evidence: `network_allow takes bare domains, not ${bad.map((entry) => JSON.stringify(entry)).join(', ')}` };
  if (commands.smoke.trim() === '') return { ok: false, evidence: 'The smoke command is blank' };
  const unplayable = playProblems(play);
  if (unplayable.length > 0) return { ok: false, evidence: unplayable.join('\n') };
  const unchecked = await commandCheckProblems(ctx, checks, (await mustSupportItems(ctx.deps, ctx.project))?.items ?? []);
  if (unchecked.length > 0) return { ok: false, evidence: unchecked.join('\n') };

  const smoke = await runSandboxed({ ...sandboxEnv(ctx), commands: [commands.smoke] });
  if (!smoke.ok) return { ok: false, evidence: smoke.evidence };

  const data: ProfileData = { commands, toolchains, network_allow, setup, play, ...(checks && checks.length > 0 ? { must_support_checks: checks } : {}) };
  return withRaised(ctx, {
    message: 'discovery: environment profile',
    publish: [{ id: ENV_PROFILE, type: 'environment_profile', status: 'proposed', ownerRole: 'tech_lead', derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== ENV_PROFILE), body: profileBody(body, checks), fields: { data } }],
  });
};
