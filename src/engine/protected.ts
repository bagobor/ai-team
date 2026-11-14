import picomatch from 'picomatch';
import { formatPin, type ArtifactDoc } from '../artifacts/format.ts';
import { ENV_PROFILE, testPlanId } from './apply/ids.ts';
import { touchesProblem } from './apply/tickets.ts';
import type { EngineDeps } from './runner.ts';
import type { ProjectRow } from './store.ts';

// source is the document that named the glob, so a refusal can say who protects the path.
export type ProtectedPath = { glob: string; source: string };

// Only QA's harness tickets write what a Test Plan protects. Bug tickets are the engineers', so they are held out like any other.
export const isHarnessTicket = (ticketId: string): boolean => /-Q-\d+$/.test(ticketId);

// A Test Plan stored before plans named protected paths has no such field, and names none.
export function protectedGlobs(doc: Pick<ArtifactDoc, 'fields'>): string[] {
  const globs = (doc.fields.data as { protected?: unknown } | undefined)?.protected;
  return Array.isArray(globs) ? (globs as string[]) : [];
}

// What the Environment Profile's must-support checks read. No ticket may change these, in any milestone or prototype
// round, since the commands that read them judge every milestone. A profile gone stale was still approved.
export async function checkProtectedPaths(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow): Promise<ProtectedPath[]> {
  const row = await deps.artifacts.latest(project.id, ENV_PROFILE);
  if (row?.status !== 'approved' && row?.status !== 'stale') return [];
  const doc = await deps.artifacts.read(project, formatPin({ id: ENV_PROFILE, version: row.version }));
  const checks = (doc.fields.data as { must_support_checks?: { protected?: string[] }[] } | undefined)?.must_support_checks ?? [];
  return [...new Set(checks.flatMap((check) => check.protected ?? []))].map((glob) => ({ glob, source: ENV_PROFILE }));
}

// A milestone's Test Plan protects its acceptance tests in every later milestone too, because those tests keep judging the work.
export async function protectedPaths(deps: Pick<EngineDeps, 'artifacts'>, project: ProjectRow, milestone: number): Promise<ProtectedPath[]> {
  const found: ProtectedPath[] = [];
  for (let k = 1; k <= milestone; k += 1) {
    const id = testPlanId(k);
    const row = await deps.artifacts.latest(project.id, id);
    if (!row) continue;
    const doc = await deps.artifacts.read(project, formatPin({ id, version: row.version }));
    found.push(...protectedGlobs(doc).map((glob) => ({ glob, source: id })));
  }
  return [...found, ...(await checkProtectedPaths(deps, project))];
}

// Tickets may touch ** (touchesProblem lets it by), but a protected ** would leave every product ticket nothing to write.
// A glob that takes both a top-level file and one in a folder no glob names takes the whole repository.
const coversRepository = (glob: string): boolean => {
  const matches = picomatch(glob, { dot: true });
  return matches('zz-probe.x') && matches('zz-dir/zz-probe.x');
};

const globProblem = (glob: unknown): string | undefined => {
  if (typeof glob !== 'string') return 'is not a glob';
  return touchesProblem(glob) ?? (coversRepository(glob) ? 'covers the whole repository' : undefined);
};

// A model wrote the list, and a missing one is refused rather than read as none, so a Test Plan can't protect nothing by forgetting to say.
export function protectedProblems(globs: unknown): string[] {
  if (!Array.isArray(globs)) return ['protected: the list is missing. Name the globs of the acceptance tests your commands run, or give an empty list if there are none'];
  return globs.flatMap((glob) => {
    const problem = globProblem(glob);
    return problem ? [`protected: ${JSON.stringify(glob)} ${problem}`] : [];
  });
}
