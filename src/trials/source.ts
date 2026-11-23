import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChecksResult } from '../checks/run-checks.ts';
import { reviewInputs } from '../engine/review-inputs.ts';
import { KEPT_REFERENCE, REFERENCE_DIR, roleInputs, type Reference } from '../engine/role-inputs.ts';
import { VIEWS, type EngineDeps } from '../engine/runner.ts';
import type { AttemptRow, ProjectRow, TaskRow } from '../engine/store.ts';
import { git } from '../git/git.ts';
import { fenced, knowledgeFingerprint, systemOf, type SystemSections, type TaskManifest } from '../manifest/build.ts';
import { manifestDir } from '../paths.ts';
import type { Measured } from './types.ts';

// Everything needed to run a past attempt's task again with other knowledge in front of it.
export type ReplaySource = { attempt: AttemptRow; task: TaskRow; project: ProjectRow; manifest: TaskManifest; sections: SystemSections; fingerprint: string; reference: Reference };

export type Replayable = { ok: true; source: ReplaySource } | { ok: false; why: string };

type SourceDeps = Pick<EngineDeps, 'store' | 'paths' | 'artifacts'>;

// An attempt cut short says nothing about the role, and nor does one that failed for a reason outside the work.
const NO_RESULT = ['starting', 'running', 'interrupted', 'cancelled'];
const NOT_ABOUT_THE_WORK = ['auth_required', 'context_over_budget', 'engine_error', 'spawn_error'];

const CONTRACT = '\n\n## Output contract\n';
const INSTRUCTIONS = '\n\n## Repository instructions\n';

// A prompt from before the sections were kept is the charter, then the output contract, then any repository
// instructions. It is taken apart only when putting it back together gives the same prompt.
function sectionsOf({ system, sections }: TaskManifest): SystemSections | undefined {
  if (sections) return sections;
  const at = system.indexOf(CONTRACT);
  if (at === -1) return undefined;
  const rest = system.slice(at + 2);
  const then = rest.indexOf(INSTRUCTIONS);
  const split: SystemSections = {
    charter: system.slice(0, at),
    playbook: '',
    memory: '',
    contract: then === -1 ? rest.replace(/\n$/, '') : rest.slice(0, then),
    instructions: then === -1 ? '' : rest.slice(then + 2).replace(/\n$/, ''),
  };
  return systemOf(split) === system ? split : undefined;
}

async function keptReference(dir: string): Promise<Reference | undefined> {
  const names = await readdir(dir).catch(() => undefined);
  if (names === undefined) return undefined;
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')] as const)));
}

// A version's text never changes, but what the engine keeps about it does: approved becomes stale and then
// superseded, what it was derived from is re-pinned when a newer version of that leaves it standing, and a criterion
// goes from unverified to passing. Those are the only parts of an input that can differ from what a worker was given,
// and no reference file is made from them.
function sameVersion(text: string): string {
  const front = (lines: string) => lines.replace(/^(status|approved_by|approved_at): .*\n/gm, '').replace(/^derived_from:.*\n(?: {2}- .*\n)*/m, '');
  return text.trimEnd().replace(/^---\n[\s\S]*?\n---\n/, front).replace(/^- (AC-\d+) \(\w+\):/gm, '- $1:');
}

// The files are built from the same versions the stored task names, by the code that built them then. They are
// trusted only when every input also comes back as the stored task has it, word for word but for its status.
async function rebuiltReference(deps: SourceDeps, project: ProjectRow, task: TaskRow, stored: string): Promise<Reference | string> {
  const inputs = new Map([...stored.matchAll(/<input pin="([^"]*)">\n([\s\S]*?)<\/input>/g)].map((match) => [match[1] ?? '', match[2] ?? '']));
  const pins = [...inputs.keys()];
  const order = task.work_order;
  const rebuilt = await (order?.purpose === 'milestone_review' ? reviewInputs(deps, project, task.milestone, pins) : roleInputs(deps, project, pins, order ? VIEWS[order.purpose] : undefined)).catch(
    (err: Error) => err.message,
  );
  if (typeof rebuilt === 'string') return `its reference files can’t be rebuilt: ${rebuilt}`;
  const changed = rebuilt.inputs.find(({ pin, content }) => sameVersion(fenced('input', content)) !== sameVersion(inputs.get(pin) ?? ''));
  if (changed || rebuilt.inputs.length !== pins.length) return `its reference files can’t be rebuilt: ${changed?.pin ?? 'an input'} no longer reads as it did then`;
  return rebuilt.reference ?? 'its reference files can’t be rebuilt: the documents it read no longer give any';
}

export async function replaySource(deps: SourceDeps, attemptId: number): Promise<Replayable> {
  const { store, paths } = deps;
  const no = (why: string): Replayable => ({ ok: false, why });
  const attempt = await store.getAttempt(attemptId);
  if (!attempt) return no(`there is no attempt ${attemptId}`);
  const task = await store.getTask(attempt.task_id);
  const project = task && (await store.getProjectById(task.project_id));
  if (!task || !project) return no('its task is gone');
  const manifest = attempt.manifest as TaskManifest | null;
  if (!manifest) return no('it never got as far as a prompt');
  if (NO_RESULT.includes(attempt.state)) return no(`it was ${attempt.state}, so it has no result to compare`);
  if (NOT_ABOUT_THE_WORK.includes(attempt.failure_kind ?? '')) return no(`it failed for a reason outside the work (${attempt.failure_kind})`);
  if (attempt.base_sha === null || !existsSync(project.repo_path)) return no('its repository or starting commit is not recorded');
  const { code } = await git(project.repo_path, ['cat-file', '-e', `${attempt.base_sha}^{commit}`]).catch(() => ({ code: 1 }));
  if (code !== 0) return no('the commit it started from is no longer in the repository');
  const sections = sectionsOf(manifest);
  if (!sections) return no('its stored prompt can’t be taken apart into the charter and the output contract');

  let reference: Reference = {};
  if (manifest.task.includes(REFERENCE_DIR)) {
    const found = (await keptReference(join(manifestDir(paths, project.name, task.ticket_id, attempt.k), KEPT_REFERENCE))) ?? (await rebuiltReference(deps, project, task, manifest.task));
    if (typeof found === 'string') return no(found);
    reference = found;
  }
  // What it was given then: kept since playbooks and memory exist, and before that the charter alone on its model.
  const fingerprint = manifest.fingerprint ?? knowledgeFingerprint(sections, manifest.model);
  return { ok: true, source: { attempt, task, project, manifest, sections, fingerprint, reference } };
}

// What a ticket's checks say, in the three things counted. A gate the run never reached is left unknown.
export function ticketMeasure(checks: Pick<ChecksResult, 'ok'> & { kind?: string; evidence?: string }): Pick<Measured, 'checks' | 'changed' | 'tests' | 'note'> {
  if (checks.ok) return { changed: true, tests: true, checks: true, note: null };
  const note = checks.evidence?.trim().split('\n').slice(-12).join('\n') ?? null;
  if (checks.kind === 'no_changes') return { changed: false, tests: null, checks: null, note };
  if (checks.kind === 'tests_missing') return { changed: true, tests: false, checks: null, note };
  return { changed: true, tests: checks.kind === 'scope_violation' ? null : true, checks: false, note };
}

const TICKET_FAILURES = ['check_failed', 'scope_violation', 'tests_missing', 'no_changes'];
// These came after the attempt had passed its checks.
const SENT_BACK = ['changes_requested', 'merge_conflict'];

// The same counts for what the attempt produced at the time, read from how it ended.
export function storedMeasure(attempt: AttemptRow, task: TaskRow): Measured {
  const usd = (attempt.usage as { usdEst?: number } | null)?.usdEst ?? null;
  const kind = attempt.failure_kind;
  const passed = attempt.state === 'succeeded' || SENT_BACK.includes(kind ?? '');
  const parses = attempt.output !== null && attempt.state !== 'invalid_output';
  if (task.kind !== 'ticket') return { parses, checks: null, changed: null, tests: null, usd, note: passed || kind === null ? null : kind };
  if (passed) return { parses, usd, ...ticketMeasure({ ok: true }) };
  if (TICKET_FAILURES.includes(kind ?? '')) return { parses, usd, ...ticketMeasure({ ok: false, kind: kind!, evidence: typeof attempt.failure_evidence === 'string' ? attempt.failure_evidence : '' }) };
  return { parses, checks: null, changed: null, tests: null, usd, note: kind };
}

export type PastAttempt = { attemptId: number; project: string; ticketId: string; title: string; purpose: string; k: number; state: string; failureKind: string | null; endedAt: string | null; usd: number | null; firstPass: boolean; replayable: boolean; why: string | null };

// A role's past attempts, newest first, each with whether it can be run again. With a project, that project's only.
export async function pastAttempts(deps: SourceDeps, roleId: string, projectName?: string): Promise<PastAttempt[]> {
  const { store } = deps;
  const projects = (await store.listProjects()).filter(({ name }) => projectName === undefined || name === projectName);
  const found: PastAttempt[] = [];
  for (const project of projects) {
    for (const task of (await store.listTasks(project.id)).filter((one) => one.role_id === roleId)) {
      for (const attempt of await store.listAttempts(task.id)) {
        const source = await replaySource(deps, attempt.id);
        found.push({
          attemptId: attempt.id,
          project: project.name,
          ticketId: task.ticket_id,
          title: task.title,
          purpose: task.purpose ?? 'ticket',
          k: attempt.k,
          state: attempt.state,
          failureKind: attempt.failure_kind,
          endedAt: attempt.ended_at,
          usd: (attempt.usage as { usdEst?: number } | null)?.usdEst ?? null,
          firstPass: attempt.k === 1 && attempt.state === 'succeeded' && attempt.failure_kind === null,
          replayable: source.ok,
          why: source.ok ? null : source.why,
        });
      }
    }
  }
  return found.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || b.attemptId - a.attemptId);
}

// The tasks offered as ones that went fine: first-pass successes that can be run again, the newest of each project
// and purpose before a second of any.
export function suggestFine(attempts: PastAttempt[], count = 3): PastAttempt[] {
  const good = attempts.filter(({ firstPass, replayable }) => firstPass && replayable);
  const seen = new Set<string>();
  const firsts = good.filter(({ project, purpose }) => !seen.has(`${project} ${purpose}`) && seen.add(`${project} ${purpose}`));
  return [...firsts, ...good.filter((one) => !firsts.includes(one))].slice(0, count);
}
