import type { ArtifactDoc } from '../../artifacts/format.ts';
import { ownerOf, applyChangeRequest, ChangeRequestError, criterionText, movedSince, rejectChangeRequest, requestOf, TargetMovedError, touchesCriterionText } from '../change-requests.ts';
import { openTickets } from '../apply/design.ts';
import { techId, testPlanId } from '../apply/ids.ts';
import { recommendationOf } from '../apply/review.ts';
import type { InboxRow } from '../inbox.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { ArtifactVersionRow, ProjectRow, Store } from '../store.ts';
import { ensureTask, isClosed, lastSucceeded, pinOf, recommendationTask, reviseInputs, reviseTask } from './tasks.ts';

type Deps = Pick<EngineDeps, 'store' | 'artifacts'>;

const RESET_FROM: readonly string[] = ['verify', 'milestone_review', 'cp4'];
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
  await store.raiseInbox({
    project_id: project.id,
    ...(cr.milestone === null ? {} : { milestone: cr.milestone }),
    type: 'approval',
    dedupe_key: asked.length === 0 ? `cr:${crNumber(crId)}` : `cr:${crNumber(crId)}:${pinOf(target)}`,
    ref: { kind: 'cr', cr: crId },
    title: `Change an acceptance criterion: ${crId}`,
    asked_by: ownerOf(target),
    why: [
      `${crId} changes the text of ${ac} in ${target.artifact_id}.`,
      ...(moved ? [`${ac} has changed since ${crId} was filed against ${filed}, so approving it replaces the text it has now.`] : []),
      'Criteria text changes only with your approval.',
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

  // Changes to criteria text always go to the stakeholder. Everything else, the owner decides.
  if (touchesCriterionText(doc, target)) {
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

// A stale ticket is revised through the document that owns it, even a closed one, because QA waits until nothing is stale.
async function reviseStale(deps: Deps, project: ProjectRow): Promise<void> {
  const { store, artifacts } = deps;
  const current = (await store.listMilestones(project.id)).find(({ phase }) => phase !== 'merged');
  if (!current) return;
  const { n } = current;

  const stale = new Set<string>();
  for (const row of await artifacts.list(project.id)) {
    if (row.milestone !== n || row.status !== 'stale') continue;
    if (row.type === 'tech_design' || row.type === 'test_plan') stale.add(row.artifact_id);
    else if (row.type === 'ticket') stale.add(/-Q-\d+$/.test(row.artifact_id) ? testPlanId(n) : techId(n));
  }

  const tasks = await store.listTasks(project.id);
  for (const docId of stale) {
    const earlier = tasks.filter(({ ticket_id }) => ticket_id.startsWith(`M${n}-REVISE-${docId}-`));
    if (earlier.some((task) => !isClosed(task))) continue;
    const doc = await artifacts.latest(project.id, docId);
    if (!doc) continue;
    const isDesign = docId === techId(n);
    const open = await openTickets(deps, project, n, isDesign ? 'T' : 'Q');
    const inputs = await reviseInputs(deps, project, doc);
    await ensureTask(store, reviseTask(project, n, doc, earlier.length + 1, isDesign ? 'revise_design' : 'revise_test_plan', inputs, open));
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
