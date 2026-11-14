import { parsePin } from '../../artifacts/format.ts';
import { approvedMustSupport, mustSupportItems, pinOf } from '../conductor/tasks.ts';
import { mustSupportProblems, nextUsed, renderMustSupport, type MsItem, type MsPrior, type MustSupportData } from '../must-support.ts';
import { commandCheckProblems, profileBody, type MsCheckCommand, type ProfileData } from './discovery.ts';
import { ENV_PROFILE, MUST_SUPPORT } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';

type MustSupportOutput = { items: MsItem[]; stakeholder_note: string };
type ChecksOutput = { must_support_checks: MsCheckCommand[]; stakeholder_note: string };

// The ids a revision may keep, and every id any version has used, so a removed one is never given to a new item. It
// may keep the ids of the list in force and of a proposal still waiting for the stakeholder. A proposal they rejected
// lends none: its new ids are used, and nothing more.
async function priorOf({ deps, project }: Pick<ApplyCtx, 'deps' | 'project'>): Promise<MsPrior> {
  const latest = await deps.artifacts.latest(project.id, MUST_SUPPORT);
  if (!latest) return { current: [], used: [] };
  const dataOf = async (pin: string) => (await deps.artifacts.read(project, pin)).fields.data as MustSupportData;
  const approved = await approvedMustSupport(deps, project);
  const live = [...(approved ? [pinOf(approved)] : []), ...(latest.status === 'proposed' ? [pinOf(latest)] : [])];
  const current = (await Promise.all(live.map(dataOf))).flatMap(({ items }) => items.map(({ id }) => id));
  return { current: [...new Set(current)], used: (await dataOf(pinOf(latest))).used };
}

export const applyMustSupport: Applier = async (ctx) => {
  const { items } = ctx.output as MustSupportOutput;
  const prior = await priorOf(ctx);
  const problems = mustSupportProblems(items, prior);
  if (problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  return withRaised(ctx, {
    message: 'discovery: must-support list',
    publish: [
      {
        id: MUST_SUPPORT,
        type: 'must_support',
        status: 'proposed',
        ownerRole: 'pm',
        derivedFrom: ctx.order.inputs.filter((pin) => parsePin(pin).id !== MUST_SUPPORT),
        body: renderMustSupport(items),
        fields: { data: { items, used: nextUsed(prior, items) } satisfies MustSupportData },
      },
    ],
  });
};

// The Tech Lead adds a command for every item checked by command to a profile the stakeholder has approved. They
// approved the items themselves, and a command that proves one is mechanical, so the new version stands under the
// approval the profile had.
export const applyMustSupportChecks: Applier = async (ctx) => {
  const { must_support_checks: checks } = ctx.output as ChecksOutput;
  const { deps, project } = ctx;
  const list = await mustSupportItems(deps, project);
  const prior = await deps.artifacts.latest(project.id, ENV_PROFILE);
  if (!list || !prior?.approved_by) throw new Error(`${ctx.task.ticket_id} needs an approved must-support list and an approved Environment Profile`);
  const problems = await commandCheckProblems(ctx, checks, list.items);
  if (problems.length > 0) return { ok: false, evidence: problems.join('\n') };

  const profile = await deps.artifacts.read(project, pinOf(prior));
  return withRaised(ctx, {
    message: 'environment profile: must-support checks',
    publish: [
      {
        id: ENV_PROFILE,
        type: 'environment_profile',
        status: 'approved',
        approvedBy: prior.approved_by,
        ownerRole: prior.owner_role,
        derivedFrom: [...prior.derived_from.filter((pin) => parsePin(pin).id !== MUST_SUPPORT), list.pin],
        body: profileBody(profile.body, checks),
        fields: { data: { ...(profile.fields.data as ProfileData), must_support_checks: checks } satisfies ProfileData },
      },
    ],
  });
};
