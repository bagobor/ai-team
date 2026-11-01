import { parsePin } from '../../artifacts/format.ts';
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

type ProfileOutput = {
  body: string;
  commands: { build: string; test: string; lint: string; smoke: string };
  toolchains: string[];
  network_allow: string[];
  setup: string | null;
};

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

export const applyEnvironmentProfile: Applier = async (ctx) => {
  const { body, commands, toolchains, network_allow, setup } = ctx.output as ProfileOutput;

  const bad = network_allow.filter((entry) => !isBareDomain(entry));
  if (bad.length > 0) return { ok: false, evidence: `network_allow takes bare domains, not ${bad.map((entry) => JSON.stringify(entry)).join(', ')}` };
  if (commands.smoke.trim() === '') return { ok: false, evidence: 'The smoke command is blank' };

  const smoke = await runSandboxed({ ...sandboxEnv(ctx), commands: [commands.smoke] });
  if (!smoke.ok) return { ok: false, evidence: smoke.evidence };

  return withRaised(ctx, {
    message: 'discovery: environment profile',
    publish: [{ id: ENV_PROFILE, type: 'environment_profile', status: 'proposed', ownerRole: 'tech_lead', derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== ENV_PROFILE), body, fields: { data: { commands, toolchains, network_allow, setup } } }],
  });
};
