import { applyRevise, checkedTickets, designComponents, ownedDoc } from './design.ts';
import { scopeId } from './ids.ts';
import type { Applier } from './index.ts';
import { withRaised } from './raised.ts';
import type { TicketDraft } from './tickets.ts';

type ScopeOutput = { body: string; tickets: TicketDraft[]; stakeholder_note: string };

// The Eng Lead splits the Tech Design into tickets, each held to the components it names.
export const applyTicketScope: Applier = async (ctx) => {
  const { body, tickets } = ctx.output as ScopeOutput;
  const { milestone } = ctx.task;
  const docId = scopeId(milestone);

  const checked = await checkedTickets(ctx, tickets, { prefix: 'T', docId, owner: 'eng_lead', components: await designComponents(ctx) }, body);
  if (!checked.ok) return checked;

  return withRaised(ctx, { message: `milestone ${milestone}: ticket scope`, publish: [ownedDoc(ctx, { id: docId, type: 'ticket_scope', owner: 'eng_lead' }, body), ...checked.docs] });
};

export const applyReviseScope = applyRevise('T', { docId: scopeId, type: 'ticket_scope', owner: 'eng_lead', components: true });
