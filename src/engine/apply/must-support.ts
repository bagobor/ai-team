import { parsePin } from '../../artifacts/format.ts';
import { mustSupportProblems, nextUsed, renderMustSupport, type MsItem, type MsPrior, type MustSupportData } from '../must-support.ts';
import { MUST_SUPPORT } from './ids.ts';
import type { Applier, ApplyCtx } from './index.ts';
import { withRaised } from './raised.ts';

type MustSupportOutput = { items: MsItem[]; stakeholder_note: string };

// The ids of the latest list, whatever its status, and every id any version has used: a revision keeps the ids it keeps
// and never gives a removed one to a new item.
async function priorOf({ deps, project }: Pick<ApplyCtx, 'deps' | 'project'>): Promise<MsPrior> {
  if (!(await deps.artifacts.latest(project.id, MUST_SUPPORT))) return { current: [], used: [] };
  const { items, used } = (await deps.artifacts.read(project, MUST_SUPPORT)).fields.data as MustSupportData;
  return { current: items.map(({ id }) => id), used };
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
