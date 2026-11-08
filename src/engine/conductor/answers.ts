import type { StatusChange, NewVersion } from '../../artifacts/store.ts';
import type { Criterion } from '../../artifacts/acs.ts';
import { ensureIntegrationBranch } from '../../git/workspace.ts';
import { openTickets } from '../apply/design.ts';
import { ENV_PROFILE, reviewId, scopeId, specId } from '../apply/ids.ts';
import { oneLine, quoted } from '../apply/text.ts';
import { rejectChangeRequest } from '../change-requests.ts';
import type { CheckMark, InboxAnswer, InboxRow } from '../inbox.ts';
import type { EngineDeps, Runner } from '../runner.ts';
import type { ProjectRow, Store } from '../store.ts';
import { applyRequest } from './change-requests.ts';
import { removeTryWorktree } from './try.ts';
import { discoveryDocs, discoveryInputs, discoveryTask, ensureTask, funInputs, isClosed, isTerminal, latestPin, markHalted, profileTask, protoPlanTask, replanInputs, replanTask, roundOf, specSources, specTask, stopProjectWork } from './tasks.ts';

// What an answer does once the work outside SQLite is finished. It never holds a key named then: Effect comes out of async functions, and a promise would take it for a thenable.
type Effect = { status?: StatusChange[]; after?: (s: Store) => Promise<void> };

const LABELS: Record<string, string> = { approve: 'Approve', request_changes: 'Request changes', reject: 'Reject' };

// A written answer to a Question takes the first option, and its words go in the Decision Record.
function choiceOf(item: InboxRow, answer: InboxAnswer): string {
  if ('action' in answer) return answer.action;
  if ('option' in answer) return answer.option;
  return item.options[0]?.id ?? 'retry';
}

function wordsOf(answer: InboxAnswer): string | undefined {
  if ('comment' in answer) return answer.comment;
  return 'text' in answer ? answer.text : undefined;
}

// Only an approval of a milestone or of a prototype round carries marks, and the inbox has already checked each one against that item's checks.
const marksOf = (answer: InboxAnswer): CheckMark[] => ('checks' in answer ? (answer.checks ?? []) : []);

const approved = (id: string): StatusChange => ({ id, status: 'approved', approvedBy: 'stakeholder' });

async function halt(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow): Promise<Effect> {
  await stopProjectWork(deps, runner, project);
  return { after: (s) => markHalted(s, project, `The stakeholder halted the project at: ${oneLine(item.title)}`) };
}

async function answerCp1(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, choice: string, words?: string): Promise<Effect> {
  if (choice === 'reject') return halt(deps, runner, project, item);
  if (choice === 'request_changes') {
    const k = roundOf(await deps.store.listTasks(project.id), 'DISCOVERY-PM') + 1;
    const inputs = await discoveryInputs(deps, project);
    return {
      after: async (s) => {
        await ensureTask(s, discoveryTask(project, k, inputs.pm, words));
        await ensureTask(s, profileTask(project, k, inputs.profile, words));
        await s.setProjectPhase(project.id, 'discovery');
      },
    };
  }
  const milestones = (await deps.artifacts.read(project, 'ROADMAP')).fields.data as { n: number; title: string; goal: string }[];
  return {
    status: [...(await discoveryDocs(deps, project)), ENV_PROFILE].map(approved),
    after: async (s) => {
      for (const { n, title, goal } of milestones) await s.createMilestone({ project_id: project.id, n, title, goal, phase: 'pending' });
      await s.setProjectPhase(project.id, 'active');
    },
  };
}

async function answerCp2(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, n: number, choice: string, words?: string): Promise<Effect> {
  if (choice === 'reject') return halt(deps, runner, project, item);
  if (choice === 'request_changes') {
    const k = roundOf(await deps.store.listTasks(project.id), `M${n}-SPEC`) + 1;
    const inputs = [...(await specSources(deps, project)), await latestPin(deps, project, specId(n))];
    return {
      after: async (s) => {
        await ensureTask(s, specTask(project, n, k, inputs, words));
        await s.setMilestonePhase(project.id, n, 'spec');
      },
    };
  }
  await ensureIntegrationBranch(project.repo_path, n, project.base_branch);
  const spec = await deps.artifacts.read(project, specId(n));
  const { criteria } = spec.fields.data as { criteria: Criterion[] };
  return {
    status: [approved(specId(n))],
    after: async (s) => {
      await s.lockCriteria(project.id, n, spec.version, criteria);
      await s.setMilestonePhase(project.id, n, 'design');
    },
  };
}

// A mark is the stakeholder's own word on a check, so the criterion points at the Decision Record section that holds it.
const recordMarks = (project: ProjectRow, item: InboxRow, n: number, marks: CheckMark[]) => async (s: Store): Promise<void> => {
  for (const { ac, status } of marks) {
    await s.recordVerification(project.id, n, ac, { status, evidenceRef: `DEC-${item.id}@1#${ac.toLowerCase()}`, verifiedBy: { kind: 'stakeholder', inboxId: item.id } });
  }
};

async function answerCp4(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, n: number, choice: string, words: string | undefined, marks: CheckMark[]): Promise<Effect> {
  if (choice === 'reject') {
    await removeTryWorktree(deps, project, n);
    return halt(deps, runner, project, item);
  }
  const record = recordMarks(project, item, n, marks);
  if (choice === 'request_changes') {
    const k = (await deps.store.listTasks(project.id)).filter(({ ticket_id }) => ticket_id.startsWith(`M${n}-REPLAN-`)).length + 1;
    // The Eng Lead replans the tickets; a change to the design itself goes through a Change Request.
    const scope = await deps.artifacts.latest(project.id, scopeId(n));
    if (!scope) throw new Error(`Milestone ${n} has no ticket scope to replan`);
    const open = await openTickets(deps, project, n, 'T');
    const inputs = await replanInputs(deps, project, scope, open);
    // The replan reads only this comment, so what failed has to be in it.
    const failed = marks.filter(({ status }) => status === 'failing');
    const comment = [words ?? '', ...(failed.length === 0 ? [] : ['', 'Failed checks:', ...failed.map(({ ac, note }) => `- ${ac}: ${oneLine(note)}`)])].join('\n');
    return {
      after: async (s) => {
        await record(s);
        await ensureTask(s, replanTask(project, n, k, inputs, comment, open));
        // The changes get a polish round of their own, so the Eng Lead's review of them can still be built.
        const m = await s.getMilestone(project.id, n);
        await s.patchMilestone(project.id, n, { eng_cap: (m?.eng_cap ?? 0) + 1 });
        await s.setMilestonePhase(project.id, n, 'build');
      },
    };
  }
  return {
    status: [approved(reviewId(n))],
    after: async (s) => {
      await record(s);
      await s.setMilestonePhase(project.id, n, 'merging');
    },
  };
}

// The engine never judges fun, so nothing here reads the marks: the next round's plan, or discovery, reads them in the
// Decision Records. This answer's record is published with its effect, so funInputs can't find it yet and its pin is added here.
async function answerFunEval(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, r: number, choice: string): Promise<Effect> {
  if (choice === 'reject') {
    deps.tryServer?.unmount(project.name, 0);
    return halt(deps, runner, project, item);
  }
  const record = `DEC-${item.id}@1`;
  if (choice === 'request_changes') {
    const inputs = [await latestPin(deps, project, 'BRIEF'), ...(await funInputs(deps, project)), record];
    return {
      after: async (s) => {
        await ensureTask(s, protoPlanTask(project, r + 1, inputs));
      },
    };
  }
  // The fun is defined, and the prototypes have served their purpose.
  await removeTryWorktree(deps, project, 0);
  const inputs = await discoveryInputs(deps, project);
  return {
    after: async (s) => {
      await ensureTask(s, discoveryTask(project, 1, [...inputs.pm, record]));
      await ensureTask(s, profileTask(project, 1, inputs.profile));
      await s.setProjectPhase(project.id, 'discovery');
    },
  };
}

async function answerEscalation(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, taskId: number, choice: string): Promise<Effect> {
  if (choice === 'halt') return halt(deps, runner, project, item);
  const task = await deps.store.getTask(taskId);
  if (choice === 'cancel') {
    if (task && !isClosed(task)) await runner.cancel(taskId);
  } else if (task?.state === 'escalated') {
    // The stakeholder has chosen to go on without the cancelled work. Left in place, the dependency would only ask them again.
    const cancelled = new Set((await deps.store.listTasks(project.id)).filter(({ state }) => state === 'cancelled').map(({ ticket_id }) => ticket_id));
    await deps.store.setDependencies(taskId, task.depends_on.filter((id) => !cancelled.has(id)));
    await runner.retry(taskId);
  }
  return {};
}

async function effectOf(deps: EngineDeps, runner: Runner, project: ProjectRow, item: InboxRow, answer: InboxAnswer): Promise<Effect> {
  const choice = choiceOf(item, answer);
  const words = wordsOf(answer);
  const { ref } = item;
  switch (ref.kind) {
    case 'cp1':
      return answerCp1(deps, runner, project, item, choice, words);
    case 'cp2':
      return answerCp2(deps, runner, project, item, ref.milestone, choice, words);
    case 'cp4':
      return answerCp4(deps, runner, project, item, ref.milestone, choice, words, marksOf(answer));
    case 'cr':
      if (choice === 'approve') await applyRequest(deps, project, ref.cr, item);
      else await rejectChangeRequest(deps, project, ref.cr, words ?? 'The stakeholder rejected it');
      return {};
    case 'escalation':
      return answerEscalation(deps, runner, project, item, ref.taskId, choice);
    case 'fun_eval':
      return answerFunEval(deps, runner, project, item, ref.round, choice);
    case 'qa_cap':
      if (choice === 'halt') return halt(deps, runner, project, item);
      return {
        after: async (s) => {
          const m = await s.getMilestone(project.id, ref.milestone);
          await s.patchMilestone(project.id, ref.milestone, { verify_cap: (m?.verify_cap ?? 0) + 3 });
          // The play gate raises this hold from build, which has no move to build.
          if (m?.phase === 'verify') await s.setMilestonePhase(project.id, ref.milestone, 'build');
        },
      };
    default:
      // Retry only ends the hold, and the phase's step runs again.
      return choice === 'halt' ? halt(deps, runner, project, item) : {};
  }
}

function decisionRecord(item: InboxRow, answer: InboxAnswer): NewVersion {
  const choice = choiceOf(item, answer);
  const label = LABELS[choice] ?? item.options.find(({ id }) => id === choice)?.label ?? choice;
  const words = wordsOf(answer);
  // A reject isn't held to its marks, so none of them is a verdict worth recording.
  const marks = choice === 'reject' ? [] : marksOf(answer);
  // A mark on a prototype is the stakeholder's word on whether it was fun, and reads as that.
  const verdicts = item.ref.kind === 'fun_eval' ? { passing: 'Fun.', failing: 'Not fun.' } : { passing: 'Passing.', failing: 'Failing.' };
  return {
    id: `DEC-${item.id}`,
    type: 'decision_record',
    status: 'approved',
    approvedBy: 'stakeholder',
    ownerRole: 'stakeholder',
    derivedFrom: item.evidence.flatMap(({ pin }) => (pin ? [pin] : [])),
    ...(item.milestone === null ? {} : { milestone: item.milestone }),
    fields: { data: { ref: item.ref, answer } },
    // One section per mark, named for its criterion, so that the #ac-n anchor in the criterion's evidence resolves.
    body: [
      `# ${oneLine(item.title)}`,
      '',
      `Decision: ${label}`,
      '',
      ...(words === undefined ? [] : [quoted(words), '']),
      ...marks.flatMap(({ ac, status, note }) => [`## ${ac}`, '', verdicts[status], '', ...(note.trim() === '' ? [] : [quoted(note), ''])]),
    ].join('\n'),
  };
}

// The work outside SQLite goes first and is safe to repeat. One commit then publishes the decision and does the SQLite side, so a crash in between repeats the first part and applies once.
async function applyAnswer(deps: EngineDeps, runner: Runner, projectId: number, item: InboxRow): Promise<void> {
  const project = await deps.store.getProjectById(projectId);
  const { answer } = item;
  if (!project || !answer) return;
  // The project ended while this waited, so all that's left is the record of what was said.
  const effect = isTerminal(project) ? {} : await effectOf(deps, runner, project, item, answer);
  await deps.artifacts.commit(
    project,
    { message: `decision: ${oneLine(item.title)}`, publish: [decisionRecord(item, answer)], ...(effect.status ? { status: effect.status } : {}) },
    async (s) => {
      await effect.after?.(s);
      await s.markInboxApplied(item.id);
    },
  );
}

// An answer to an engine error goes first, so that Halt still works when another answer is what keeps failing.
export async function applyAnswers(deps: EngineDeps, runner: Runner, project: ProjectRow): Promise<void> {
  const items = (await deps.store.listUnappliedAnswers()).filter(({ project_id }) => project_id === project.id);
  const isEngineError = ({ ref }: InboxRow) => ref.kind === 'engine_error';
  for (const item of [...items.filter(isEngineError), ...items.filter((other) => !isEngineError(other))]) {
    await applyAnswer(deps, runner, project.id, item);
  }
}
