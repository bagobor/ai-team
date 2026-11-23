import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commitStaged, ENGINE_CONFIG, engineGit, git, gitOk } from '../git/git.ts';
import { commitFiles, inTurn } from '../git/state-repo.ts';
import { memoryPaths, playbookPath } from '../knowledge/load.ts';
import { stateRepoDir } from '../paths.ts';
import { draftKnowledge, knowledgeHash } from './drafts.ts';
import { Refused } from './errors.ts';
import type { TrialDeps } from './trial.ts';
import { KNOWLEDGE_FILES, type KnowledgeFile, type TrialRow } from './types.ts';

// What the commit says: whose knowledge, what the draft was for, and the trial that it passed with who found what.
function messageOf(trial: TrialRow, title: string): string {
  const said = Object.entries(trial.verdict?.judges ?? {}).map(([judge, { why }]) => `- ${judge === 'model' ? 'The model judge' : judge === 'evaluator' ? 'The evaluator' : judge === 'local' ? 'The local judge (not counted)' : 'The stakeholder'}: ${why}`);
  return [`${trial.role_id}: ${title}`, '', `Passed trial ${trial.id}, on ${trial.tasks.length} past tasks of the role. Nothing that can be counted got worse.`, ...said].join('\n');
}

// A draft becomes the live knowledge only through a trial that ended agreed, of the draft as it is now, against the
// live files as they are now. The charter and playbook go to the knowledge repo and memory to the project's state
// repo, each as one commit that names the trial.
export async function commitTrial(deps: TrialDeps, trialId: number): Promise<TrialRow> {
  const { trials, paths } = deps;
  const trial = await trials.getTrial(trialId);
  if (!trial) throw new Refused(`There is no trial ${trialId}`, 404);
  if (trial.commits !== null) throw new Refused(`Trial ${trialId}’s draft has been committed already`, 409);
  if (trial.state !== 'agreed') throw new Refused(`Trial ${trialId} did not end agreed, so its draft can’t be committed`, 409);
  const draft = await trials.getDraft(trial.draft_id);
  if (!draft || draft.state !== 'open') throw new Refused('Its draft is no longer open', 409);

  const now = await draftKnowledge(deps, draft);
  if (knowledgeHash(now.draft) !== knowledgeHash(trial.knowledge.draft)) throw new Refused('The draft has changed since this trial tried it. Try it again as it is now.', 409);
  const changed = KNOWLEDGE_FILES.filter((file) => trial.knowledge.draft[file] !== trial.knowledge.current[file]);
  const role = draft.role_id;
  const memory = memoryPaths(role);
  const pathOf: Record<KnowledgeFile, string> = { charter: `roles/${role}/charter.md`, playbook: playbookPath(role), memory_project: memory.project, memory_role: memory.role };
  const moved = changed.find((file) => now.current[file] !== trial.knowledge.current[file]);
  if (moved) throw new Refused(`${pathOf[moved]} has changed since this trial began, so the trial no longer says what committing the draft would do. Try it again.`, 409);

  const message = messageOf(trial, draft.title);
  const commits: NonNullable<TrialRow['commits']> = {};
  const [known, remembered] = [changed.filter((file) => file === 'charter' || file === 'playbook'), changed.filter((file) => file !== 'charter' && file !== 'playbook')];

  if (known.length > 0) {
    const files = known.map((file) => pathOf[file]);
    // A hand edit nobody committed would go in under this trial's name, which it never passed.
    const waiting = await gitOk(paths.knowledge, ['status', '--porcelain', '--', ...files]);
    if (waiting !== '') throw new Refused(`${files.join(' and ')} in the knowledge repo has a change nobody committed. Commit it or drop it, then try the draft again.`, 409);
    for (const file of known) {
      await mkdir(dirname(join(paths.knowledge, pathOf[file])), { recursive: true });
      await writeFile(join(paths.knowledge, pathOf[file]), trial.knowledge.draft[file]);
    }
    await engineGit(paths.knowledge, ['add', '--', ...files]);
    commits.knowledge = await commitStaged(paths.knowledge, message);
  }
  if (remembered.length > 0) {
    const state = stateRepoDir(paths, trial.knowledge.project!);
    const { sha } = await inTurn(state, () => commitFiles(state, remembered.map((file) => ({ path: pathOf[file], content: trial.knowledge.draft[file] })), message));
    commits.state = sha;
  }
  await trials.patchDraft(draft.id, { state: 'committed' });
  return trials.patchTrial(trialId, { commits });
}

// Takes a trial's commits back with commits of their own, so the history keeps both. A later change to the same
// lines stands in the way, and then the files are a person's to put right.
export async function undoTrial(deps: TrialDeps, trialId: number): Promise<TrialRow> {
  const { trials, paths } = deps;
  const trial = await trials.getTrial(trialId);
  if (!trial) throw new Refused(`There is no trial ${trialId}`, 404);
  if (trial.commits === null) throw new Refused(`Trial ${trialId} has committed nothing to undo`, 409);
  if (trial.commits.undone) throw new Refused(`Trial ${trialId}’s commit has been undone already`, 409);

  const revert = async (repo: string, sha: string): Promise<string> => {
    const { code } = await git(repo, [...ENGINE_CONFIG, 'revert', '--no-edit', sha]);
    if (code !== 0) {
      await git(repo, ['revert', '--abort']);
      throw new Refused('A later change to the same lines stands in the way of undoing this. Change the files by hand instead.', 409);
    }
    return gitOk(repo, ['rev-parse', 'HEAD']);
  };
  const undone: NonNullable<NonNullable<TrialRow['commits']>['undone']> = {};
  if (trial.commits.knowledge !== undefined) undone.knowledge = await revert(paths.knowledge, trial.commits.knowledge);
  if (trial.commits.state !== undefined) {
    const state = stateRepoDir(paths, trial.knowledge.project!);
    const sha = trial.commits.state;
    undone.state = await inTurn(state, () => revert(state, sha));
  }
  return trials.patchTrial(trialId, { commits: { ...trial.commits, undone } });
}
