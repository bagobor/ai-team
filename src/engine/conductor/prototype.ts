import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Player } from '../../checks/play.ts';
import { ensureIntegrationBranch } from '../../git/workspace.ts';
import { PROTO_PLAN_ID, protoPlanId, protoRoot } from '../apply/ids.ts';
import { oneLine } from '../apply/text.ts';
import { PLAY, type InboxCheck } from '../inbox.ts';
import type { EngineDeps } from '../runner.ts';
import type { ProjectRow, TaskRow } from '../store.ts';
import { newTicketSpecs } from './milestone.ts';
import { browserWhy, NO_BROWSER, problemLine, servePage, siteRoot } from './play-gate.ts';
import { ensureTask, funInputs, isClosed, latestPin, noteOf, protoPlanTask } from './tasks.ts';
import { ensureTryWorktree } from './try.ts';

// What the applier keeps of a plan for the engine (apply/prototype.ts).
type PlanData = {
  hypotheses: { id: string; element: string }[];
  prototypes: { title: string; hypotheses: string[]; controls: string[] }[];
};
// A prototype that built a page, and where the stakeholder plays it.
type Page = { key: string; root: string; dir: string; controls: string[]; link: string; check: InboxCheck };

// The try server serves every round from one mount, the checkout's prototypes folder, so the links of an earlier round still open.
const PROTOTYPES = 'prototypes';
const funKey = (r: number) => `fun_eval:${r}`;

// The round is the highest plan task. Intake starts round 1, and each request for another round starts the next.
function latestRound(tasks: TaskRow[]): number {
  const rounds = tasks.flatMap(({ ticket_id }) => PROTO_PLAN_ID.exec(ticket_id)?.slice(1).map(Number) ?? []);
  return Math.max(1, ...rounds);
}

// The prototypes live on aiteam/m0, which every round's tickets merge into, so the stakeholder plays the checkout of its head.
async function prototypesCheckout(deps: EngineDeps, project: ProjectRow): Promise<string> {
  const { headSha } = await ensureIntegrationBranch(project.repo_path, 0, project.base_branch);
  return ensureTryWorktree(deps, project, 0, headSha);
}

// The URL the prototypes are served at, or undefined when the engine has nothing to serve them with.
async function mountPrototypes(deps: EngineDeps, project: ProjectRow, checkout: string): Promise<string | undefined> {
  const { tryServer } = deps;
  if (!tryServer) return undefined;
  const site = await siteRoot(checkout, PROTOTYPES);
  if (!site.ok) return undefined;
  try {
    return tryServer.mount(project.name, 0, site.root);
  } catch {
    // The links fall back to the files in the checkout, which the stakeholder can still open.
    return undefined;
  }
}

// Only a prototype whose ticket left a page in the checkout is played: a cancelled one, or one that failed, has none.
async function pagesOf(r: number, plan: PlanData, checkout: string, served: string | undefined): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [index, prototype] of plan.prototypes.entries()) {
    const k = index + 1;
    const dir = protoRoot(r, k);
    const site = await siteRoot(checkout, dir);
    if (!site.ok || !existsSync(join(site.root, 'index.html'))) continue;
    const key = `P-${k}`;
    const link = served === undefined ? join(checkout, dir, 'index.html') : `${served}r${r}/p${k}/index.html`;
    const elements = prototype.hypotheses.map((id) => oneLine(plan.hypotheses.find((hypothesis) => hypothesis.id === id)?.element ?? id).trim());
    const text = `${oneLine(prototype.title).trim()} — tests ${prototype.hypotheses.join(', ')}: ${elements.join('; ')}`;
    pages.push({ key, root: site.root, dir, controls: prototype.controls, link, check: { ac: key, text, how: `${PLAY}${link}. Mark it fun or not fun, and say what you felt.` } });
  }
  return pages;
}

// A mounted page is played at the stakeholder's own link, under the project's mount, so a path that resolves only from
// the server root fails the smoke as it would fail them. With no mount, the page is served from its own folder.
async function smokeProblem(player: Player, { key, root, dir, controls, link }: Page, served: boolean): Promise<string | undefined> {
  const play = (page: string) => player.smoke(page, controls, { animated: true });
  const played = served ? { ok: true as const, value: await play(link) } : await servePage(root, { root: dir, entry: 'index.html', keys: controls, animated: true }, play);
  if (!played.ok) return `${key}: ${oneLine(played.why)}`;
  const { ok, problems } = played.value;
  // The browser's own failure says nothing about the prototype.
  const browser = problems.filter(({ kind }) => kind === 'browser');
  if (browser.length > 0) return `${key} was not played: ${browser.map(problemLine).join('; ')}`;
  if (ok && problems.length === 0) return undefined;
  return `${key}: ${problems.length > 0 ? problems.map(problemLine).join('; ') : 'the smoke play failed and named no problem'}`;
}

// The engine plays each page only to see that it loads and runs, and what it finds is evidence for the stakeholder. Whether
// a prototype is fun is theirs to say, so nothing here holds the evaluation or files a Bug.
async function smokeLines({ player }: EngineDeps, pages: Page[], served: boolean): Promise<string[]> {
  if (pages.length === 0) return [];
  const notPlayed = 'The engine did not play the prototypes first, so play each one to see that it loads.';
  if (!player) return [`${notPlayed} ${NO_BROWSER}`];
  // As the play gate says it: the browser's own words, then the setting that chose that browser.
  const missing = player.unavailable();
  if (missing) return [`${notPlayed} ${browserWhy(missing)}`];
  const found: string[] = [];
  for (const page of pages) {
    const problem = await smokeProblem(player, page, served);
    if (problem) found.push(problem);
  }
  return found.length === 0 ? [] : ['The smoke play checks only that a page loads and runs. It found:', ...found];
}

export async function raiseFunEval(deps: EngineDeps, project: ProjectRow, r: number): Promise<void> {
  const { store, artifacts, tryServer } = deps;
  const pin = await latestPin(deps, project, protoPlanId(r));
  const plan = (await artifacts.read(project, pin)).fields.data as PlanData;
  // The last round's link must not go on serving a checkout that is about to be replaced.
  tryServer?.unmount(project.name, 0);
  const checkout = await prototypesCheckout(deps, project);
  const served = await mountPrototypes(deps, project, checkout);
  const pages = await pagesOf(r, plan, checkout, served);
  const smoke = await smokeLines(deps, pages, served !== undefined);
  const task = await store.getTaskByTicket(project.id, protoPlanId(r));
  if (!task) throw new Error(`Round ${r} has no ${protoPlanId(r)} task`);

  const intro = pages.length === 0 ? `No prototype in round ${r} built a page.` : `Round ${r}'s prototypes are built. Only you can say whether they are fun: play each one and mark it.`;
  await store.raiseInbox({
    project_id: project.id,
    type: 'approval',
    dedupe_key: funKey(r),
    ref: { kind: 'fun_eval', round: r },
    title: `Prototype round ${r}: is it fun?`,
    asked_by: 'pm',
    why: [intro, ...(smoke.length === 0 ? [] : ['', ...smoke])].join('\n'),
    blocks: ['Discovery'],
    evidence: [{ label: protoPlanId(r), value: pin, pin }, ...pages.map(({ key, link }) => ({ label: `${PLAY}${key}`, value: link }))],
    recommendation: await noteOf(store, task.id),
    options: [],
    checks: pages.map(({ check }) => check),
  });
}

// The try server keeps its mounts only in memory, so after a restart a pending evaluation's links answer 404 until this
// serves them again.
export async function serveFunAgain(deps: EngineDeps, project: ProjectRow): Promise<void> {
  const { tryServer, store } = deps;
  if (!tryServer || tryServer.mounted(project.name, 0)) return;
  if (!(await store.inboxByPrefix(project.id, 'fun_eval:')).some(({ state }) => state === 'pending')) return;
  await mountPrototypes(deps, project, await prototypesCheckout(deps, project));
}

// The PM plans a round, Engineers build its prototypes into aiteam/m0, and the stakeholder plays them. Their tickets go
// through review and merge with every other ticket (advanceReviews), which merges a prototype without a code review.
export async function advancePrototype(deps: EngineDeps, project: ProjectRow): Promise<void> {
  const { store } = deps;
  const tasks = await store.listTasks(project.id);
  const r = latestRound(tasks);
  const plan = tasks.find(({ ticket_id }) => ticket_id === protoPlanId(r));
  if (!plan) {
    const inputs = [await latestPin(deps, project, 'BRIEF'), ...(await funInputs(deps, project))];
    await ensureTask(store, protoPlanTask(project, r, inputs));
    return;
  }
  if (plan.state !== 'done') return;

  const prefix = `PROTO-${r}-P-`;
  const specs = (await newTicketSpecs(deps, project, 0, tasks)).filter(({ ticket_id }) => ticket_id.startsWith(prefix));
  if (specs.length > 0) {
    await store.atomically(async (s) => {
      for (const spec of specs) await ensureTask(s, spec);
    });
    return;
  }
  if (!tasks.filter(({ kind, ticket_id }) => kind === 'ticket' && ticket_id.startsWith(prefix)).every(isClosed)) return;

  const raised = (await store.inboxByPrefix(project.id, funKey(r))).find(({ dedupe_key }) => dedupe_key === funKey(r));
  if (!raised) await raiseFunEval(deps, project, r);
  else if (raised.state === 'pending') await serveFunAgain(deps, project);
}
