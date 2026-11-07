import type { ArtifactDoc } from '../../artifacts/format.ts';
import { ownerOf, applyChangeRequest, ChangeRequestError, criterionText, flagsRegression, movedSince, rejectChangeRequest, requestOf, TargetMovedError, touchesCriterionText } from '../change-requests.ts';
import { openTickets } from '../apply/design.ts';
import { scopeId, techId, testPlanId } from '../apply/ids.ts';
import { recommendationOf } from '../apply/review.ts';
import type { InboxRow } from '../inbox.ts';
import { isHarnessTicket } from '../protected.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { ArtifactVersionRow, ProjectRow, Store } from '../store.ts';
import { ensureTask, isClosed, lastSucceeded, pinOf, recommendationTask, reviseInputs, reviseTask } from './tasks.ts';

type Deps = Pick<EngineDeps, 'store' | 'artifacts'>;

// Merging waits for an open request, so one approved there sends the milestone back to be verified too.
const RESET_FROM: readonly string[] = ['verify', 'milestone_review', 'cp4', 'merging'];
const crNumber = (id: string) => Number(id.slice('CR-'.length));

// A change to a project-level document lands on whichever milestone is being worked on. One to a merged milestone changes nothing that's still moving.
export async function resetVerification(s: Store, project: ProjectRow, milestone: number | null): Promise<void> {
  const milestones = await s.listMilestones(project.id);
  const m = milestone === null ? milestones.find(({ phase }) => phase !== 'merged') : milestones.find(({ n }) => n === milestone);
  if (!m || !RESET_FROM.includes(m.phase)) return;
  for (const item of await s.inboxByPrefix(project.id, `cp4:M${m.n}:`)) {
    if (item.state === 'pending') await s.withdrawInbox(item.id, 'A Change Request changed this milestone');
  }
  await s.setMilestonePhase(project.id, m.n, 'build');
}

// The version of its target an Inbox item showed, which is the one the stakeholder decided on.
const shownPin = (item: Pick<InboxRow, 'evidence'>, targetId: string): string | undefined =>
  item.evidence.find(({ label, pin }) => label === targetId && pin?.startsWith(`${targetId}@`))?.pin;

// A request that can no longer apply is closed with the reason, rather than failing again on every tick.
// One the stakeholder approved on words that have moved since stays open, and is asked again with the words it has now.
export async function applyRequest(deps: Deps, project: ProjectRow, crId: string, approvedOn?: Pick<InboxRow, 'evidence'>): Promise<void> {
  const { target_artifact } = requestOf(await deps.artifacts.read(project, crId));
  const target = await deps.artifacts.latest(project.id, target_artifact);
  const against = approvedOn && target ? shownPin(approvedOn, target.artifact_id) : undefined;
  try {
    await applyChangeRequest(deps, project, crId, (s) => resetVerification(s, project, target?.milestone ?? null), against);
  } catch (error) {
    if (!(error instanceof ChangeRequestError)) throw error;
    if (against !== undefined && error instanceof TargetMovedError) return;
    await rejectChangeRequest(deps, project, crId, error.message);
  }
}

// The stakeholder decides on the words a criterion has now. An item that showed other words is withdrawn and asked again.
// Each ask after the first has a key of its own, because a key that was used once is never raised again.
async function askStakeholder(deps: Deps, project: ProjectRow, cr: ArtifactVersionRow, doc: ArtifactDoc, target: ArtifactVersionRow, recommendation: string): Promise<void> {
  const { store, artifacts } = deps;
  const crId = cr.artifact_id;
  const input = requestOf(doc);
  const ac = input.target_ac as string;
  const current = await artifacts.read(project, pinOf(target));
  const asked = (await store.listInbox({ projectId: project.id })).filter(({ ref }) => ref.kind === 'cr' && ref.cr === crId);
  const waiting = asked.find(({ state }) => state === 'pending');
  if (waiting) {
    const shown = shownPin(waiting, target.artifact_id);
    if (shown === undefined || !(await movedSince(deps, project, input, shown, current))) return;
    await store.withdrawInbox(waiting.id, `${ac} of ${target.artifact_id} has changed since this was asked`);
  }

  const filed = cr.derived_from[0] as string;
  const moved = await movedSince(deps, project, input, filed, current);
  // QA refuses commands that pass before the work, and the Test Plan's owner is QA, so a request to waive that is asked in its own words.
  const waiver = flagsRegression(doc, current);
  await store.raiseInbox({
    project_id: project.id,
    ...(cr.milestone === null ? {} : { milestone: cr.milestone }),
    type: 'approval',
    dedupe_key: asked.length === 0 ? `cr:${crNumber(crId)}` : `cr:${crNumber(crId)}:${pinOf(target)}`,
    ref: { kind: 'cr', cr: crId },
    title: waiver ? `Let a criterion pass on the base: ${crId}` : `Change an acceptance criterion: ${crId}`,
    asked_by: ownerOf(target),
    why: [
      waiver
        ? `${crId} asks to make ${ac} of ${target.artifact_id} a regression guard: its commands pass before this milestone's work too, which QA otherwise refuses because they show nothing of it. Approve only if ${ac} is meant to hold already. A Test Plan's owner can't waive its own check.`
        : `${crId} changes the text of ${ac} in ${target.artifact_id}.`,
      ...(moved ? [`${ac} has changed since ${crId} was filed against ${filed}, so approving it replaces the text it has now.`] : []),
      ...(waiver ? [] : ['Criteria text changes only with your approval.']),
    ].join(' '),
    blocks: [`Applying ${crId}`],
    evidence: [
      ...[cr, target].map((row) => ({ label: row.artifact_id, value: pinOf(row), pin: pinOf(row) })),
      ...(moved ? [{ label: `${ac} now`, value: criterionText(current, ac) ?? '', pin: `${pinOf(target)}#${ac.toLowerCase()}` }] : []),
    ],
    recommendation,
    options: [],
  });
}

async function advanceRequest(deps: Deps, project: ProjectRow, cr: ArtifactVersionRow): Promise<void> {
  const { store, artifacts } = deps;
  const crId = cr.artifact_id;
  const doc = await artifacts.read(project, crId);
  const target = await artifacts.latest(project.id, requestOf(doc).target_artifact);
  if (!target) throw new Error(`${crId} targets ${requestOf(doc).target_artifact}, which does not exist`);

  const task = await store.getTaskByTicket(project.id, `${crId}-REC`);
  if (!task) {
    await ensureTask(store, recommendationTask(project, crId, target, [pinOf(cr), pinOf(target)]));
    return;
  }
  if (task.state !== 'done') return;

  const attempt = await lastSucceeded(store, task.id);
  if (!attempt) throw new Error(`${task.ticket_id} is done with no successful attempt`);
  const { decision, rationale } = recommendationOf(attempt);

  // Changes to criteria text, and a Test Plan request that waives QA's base check, always go to the stakeholder. Everything else, the owner decides.
  // The owner's recommendation is still asked for, and shown, but it doesn't apply or reject these.
  if (touchesCriterionText(doc, target) || (target.type === 'test_plan' && flagsRegression(doc, await artifacts.read(project, pinOf(target))))) {
    await askStakeholder(deps, project, cr, doc, target, `${decision}: ${rationale}`);
    return;
  }
  if (decision === 'approve') await applyRequest(deps, project, crId);
  else await rejectChangeRequest(deps, project, crId, rationale);
}

async function withdrawClosed(deps: Deps, project: ProjectRow): Promise<void> {
  for (const item of await deps.store.listInbox({ projectId: project.id, state: 'pending' })) {
    if (item.ref.kind !== 'cr') continue;
    const cr = await deps.artifacts.latest(project.id, item.ref.cr);
    if (cr?.status !== 'proposed') await deps.store.withdrawInbox(item.id, `${item.ref.cr} is closed`);
  }
}

async function cancelSuperseded(deps: Deps, runner: Runner, project: ProjectRow): Promise<void> {
  for (const task of await deps.store.listTasks(project.id)) {
    if (task.kind !== 'ticket' || isClosed(task)) continue;
    if ((await deps.artifacts.latest(project.id, task.ticket_id))?.status === 'superseded') await runner.cancel(task.id);
  }
}

// A stale ticket is revised through the document that owns it, even a closed one, because QA waits until nothing is stale:
// the Eng Lead's scope owns the product tickets, and the Test Plan the harness ones. The Tech Design owns no tickets.
async function reviseStale(deps: Deps, project: ProjectRow): Promise<void> {
  const { store, artifacts } = deps;
  const current = (await store.listMilestones(project.id)).find(({ phase }) => phase !== 'merged');
  if (!current) return;
  const { n } = current;

  const rows = await artifacts.list(project.id);
  const stale = new Set<string>();
  for (const row of rows) {
    if (row.milestone !== n || row.status !== 'stale') continue;
    if (row.type === 'tech_design' || row.type === 'ticket_scope' || row.type === 'test_plan') stale.add(row.artifact_id);
    else if (row.type === 'ticket') stale.add(isHarnessTicket(row.artifact_id) ? testPlanId(n) : scopeId(n));
  }

  const tasks = await store.listTasks(project.id);
  // The scope is held to the Tech Design's components, so it is revised against the design that will stand, not one being revised.
  const designMoving = rows.some((row) => row.artifact_id === techId(n) && row.status === 'stale') || tasks.some(({ milestone, purpose, state }) => milestone === n && purpose === 'revise_design' && !isClosed({ state }));
  for (const docId of stale) {
    if (docId === scopeId(n) && designMoving) continue;
    const earlier = tasks.filter(({ ticket_id }) => ticket_id.startsWith(`M${n}-REVISE-${docId}-`));
    if (earlier.some((task) => !isClosed(task))) continue;
    const doc = await artifacts.latest(project.id, docId);
    if (!doc) continue;
    const inputs = await reviseInputs(deps, project, doc);
    if (docId === techId(n)) await ensureTask(store, reviseTask(project, n, doc, earlier.length + 1, 'revise_design', inputs, []));
    else if (docId === scopeId(n)) await ensureTask(store, reviseTask(project, n, doc, earlier.length + 1, 'revise_scope', inputs, await openTickets(deps, project, n, 'T')));
    else await ensureTask(store, reviseTask(project, n, doc, earlier.length + 1, 'revise_test_plan', inputs, await openTickets(deps, project, n, 'Q')));
  }
}

// A ticket held on what it raised goes back to ready once each request is decided, unless the decision left the ticket stale,
// in which case it waits for its owner to keep or replace it rather than retry against what is about to change.
async function releaseHeld(deps: Deps, project: ProjectRow): Promise<void> {
  const held = (await deps.store.listTasks(project.id)).filter(({ state, blocked_on }) => state === 'blocked' && blocked_on === 'change_request');
  if (held.length === 0) return;
  const waiting = new Set<string>();
  for (const { artifact_id, type, status } of await deps.artifacts.list(project.id)) {
    if (type !== 'change_request' || status !== 'proposed') continue;
    const { raised_in } = requestOf(await deps.artifacts.read(project, artifact_id));
    if (raised_in) waiting.add(raised_in);
  }
  for (const task of held) {
    if (waiting.has(task.ticket_id) || (await deps.artifacts.latest(project.id, task.ticket_id))?.status === 'stale') continue;
    await deps.store.setTaskState(task.id, 'ready');
  }
}

export async function advanceChangeRequests(deps: Deps, runner: Runner, project: ProjectRow): Promise<void> {
  const requests = (await deps.artifacts.list(project.id))
    .filter(({ type, status }) => type === 'change_request' && status === 'proposed')
    .sort((a, b) => crNumber(a.artifact_id) - crNumber(b.artifact_id));
  for (const cr of requests) await advanceRequest(deps, project, cr);
  await withdrawClosed(deps, project);
  await cancelSuperseded(deps, runner, project);
  await reviseStale(deps, project);
  await releaseHeld(deps, project);
}
