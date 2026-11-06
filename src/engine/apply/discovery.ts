import { isAbsolute } from 'node:path';
import { parsePin } from '../../artifacts/format.ts';
import { keyProblem } from '../../checks/play.ts';
import { runSandboxed } from '../../checks/run-checks.ts';
import { ENV_PROFILE } from './ids.ts';
import type { Applier } from './index.ts';
import { withRaised } from './raised.ts';
import { sandboxEnv } from './sandbox.ts';

type DiscoveryOutput = {
  roadmap: { body: string; milestones: { n: number; title: string; goal: string }[] };
  team_proposal: { body: string };
  human_requirements: { body: string };
};

export type PlayBlock = { root: string; entry: string; keys: string[] };

// What a published Environment Profile holds as data, for everything that builds or plays the product.
// A profile published before the play gate has no play at all, which its readers take as null.
export type ProfileData = {
  commands: { build: string; test: string; lint: string; smoke: string };
  toolchains: string[];
  network_allow: string[];
  setup: string | null;
  play: PlayBlock | null;
};

type ProfileOutput = ProfileData & { body: string };

const DISCOVERY_IDS = new Set(['ROADMAP', 'TEAM-PROPOSAL', 'HUMAN-REQUIREMENTS']);

export const applyDiscovery: Applier = async (ctx) => {
  const { roadmap, team_proposal, human_requirements } = ctx.output as DiscoveryOutput;
  const { milestones } = roadmap;

  if (milestones.length === 0) return { ok: false, evidence: 'The roadmap has no milestones' };
  const gap = milestones.findIndex(({ n }, i) => n !== i + 1);
  if (gap !== -1) return { ok: false, evidence: `Milestones must be numbered 1, 2, 3 with no gap, but number ${gap + 1} is ${milestones[gap]!.n}` };
  const untitled = milestones.find(({ title }) => title.trim() === '');
  if (untitled) return { ok: false, evidence: `Milestone ${untitled.n} has a blank title` };

  // A redo round reads the documents it replaces: those are its history, not its sources.
  const derivedFrom = ctx.order.inputs.filter((pin) => !DISCOVERY_IDS.has(parsePin(pin).id));
  const doc = { status: 'proposed', ownerRole: 'pm', derivedFrom } as const;
  return withRaised(ctx, {
    message: 'discovery: roadmap, team proposal and human requirements',
    publish: [
      { ...doc, id: 'ROADMAP', type: 'roadmap', body: roadmap.body, fields: { data: milestones } },
      { ...doc, id: 'TEAM-PROPOSAL', type: 'team_proposal', body: team_proposal.body },
      { ...doc, id: 'HUMAN-REQUIREMENTS', type: 'human_requirements', body: human_requirements.body },
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
  const { root, entry, keys } = play;
  if (typeof root !== 'string' || root.trim() === '' || climbs(root)) problems.push(`play.root must be a directory inside the repo, such as . or dist, not ${JSON.stringify(root)}`);
  if (typeof entry !== 'string' || !entry.endsWith('.html') || climbs(entry)) problems.push(`play.entry must be an .html page under play.root, not ${JSON.stringify(entry)}`);
  if (!Array.isArray(keys) || keys.length === 0) problems.push('play.keys needs at least one key the game reads');
  else problems.push(...keys.flatMap((key) => keyProblem(key) ?? []).map((problem) => `play.keys: ${problem}`));
  return problems;
}

export const applyEnvironmentProfile: Applier = async (ctx) => {
  const { body, commands, toolchains, network_allow, setup, play } = ctx.output as ProfileOutput;

  const bad = network_allow.filter((entry) => !isBareDomain(entry));
  if (bad.length > 0) return { ok: false, evidence: `network_allow takes bare domains, not ${bad.map((entry) => JSON.stringify(entry)).join(', ')}` };
  if (commands.smoke.trim() === '') return { ok: false, evidence: 'The smoke command is blank' };
  const unplayable = playProblems(play);
  if (unplayable.length > 0) return { ok: false, evidence: unplayable.join('\n') };

  const smoke = await runSandboxed({ ...sandboxEnv(ctx), commands: [commands.smoke] });
  if (!smoke.ok) return { ok: false, evidence: smoke.evidence };

  return withRaised(ctx, {
    message: 'discovery: environment profile',
    publish: [{ id: ENV_PROFILE, type: 'environment_profile', status: 'proposed', ownerRole: 'tech_lead', derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== ENV_PROFILE), body, fields: { data: { commands, toolchains, network_allow, setup, play } satisfies ProfileData } }],
  });
};
