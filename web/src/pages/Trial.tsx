import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Letter } from '../../../src/trials/types.ts';
import type { ResultView, TaskView, TrialView } from '../../../src/trials/view.ts';
import { answerTrial, commitTrial, discardDraft, getTrial, resumeTrial, stopTrial, undoTrial } from '../api.ts';
import { DiffView } from '../components/DiffTab.tsx';
import { when } from '../lib/ledger.ts';
import { roleName, rolePath, shortSha } from '../lib/roles.ts';
import { answerWords, armLabel, cannotCommit, cost, draftPath, isWorking, judgeLabel, measuredChips, pretty, trialState, unanswered, type Choices } from '../lib/trials.ts';
import { Link } from '../router.tsx';

const POLL_MS = 2000;
const GROUP = { problem: 'showed the problem', fine: 'went fine' };

function Result({ result, isTicket }: { result: ResultView; isTicket: boolean }) {
  return (
    <div className="result">
      <div className="result-h">
        <b>Result {result.letter}</b>
        {result.arm !== null && <span className="muted">{armLabel(result.arm)}</span>}
        {result.measured !== null && <span className="muted">{cost(result.measured.usd)}</span>}
      </div>
      {result.state !== 'done' ? (
        <p className="muted">{result.state === 'running' ? 'Running now.' : 'Not run yet.'}</p>
      ) : (
        <>
          <div className="chips">
            {measuredChips(result.measured, isTicket).map(({ label, ok }) => (
              <span key={label} className={`chip ${ok === true ? 'ok' : ok === false ? 'bad' : 'unk'}`}>
                {label}
                {ok === null && ': never got that far'}
              </span>
            ))}
          </div>
          {result.measured?.note && <pre className="note">{result.measured.note}</pre>}
          {result.output === null ? <p className="muted">It produced no answer.</p> : <pre>{pretty(result.output)}</pre>}
          {result.diff !== null && result.diff.trim() !== '' && (
            <details>
              <summary>What it changed</summary>
              <DiffView text={result.diff} />
            </details>
          )}
        </>
      )}
      {result.error !== null && <p className="err">{result.error}</p>}
    </div>
  );
}

function Task({ task, trial, choice, onChoose }: { task: TaskView; trial: TrialView; choice: Letter | 'same' | undefined; onChoose?: (choice: Letter | 'same') => void }) {
  const isTicket = task.purpose === 'ticket';
  const letters = task.results.map(({ letter }) => letter);
  return (
    <section className="panel task">
      <div className="panel-h">
        <h2>
          <span className="mono">{task.ticketId}</span> {task.title}
        </h2>
        <span className="aside">
          <span>{task.project}</span>
          <span className={`tag ${task.group === 'problem' ? 'back' : 'ok'}`}>{GROUP[task.group]}</span>
        </span>
      </div>
      {task.notes.map((note) => (
        <p key={note} className="banner">
          {note}
        </p>
      ))}
      <div className={`results n${task.results.length}`}>
        {task.results.map((result) => (
          <Result key={result.letter} result={result} isTicket={isTicket} />
        ))}
      </div>
      {onChoose && (
        <div className="choice" role="radiogroup" aria-label={`Which result of ${task.ticketId} is better`}>
          <span>Which of {task.compare.join(' and ')} is better?</span>
          {[...task.compare, 'same' as const].map((option) => (
            <label key={option}>
              <input type="radio" name={`task-${task.attemptId}`} checked={choice === option} onChange={() => onChoose(option)} /> {option === 'same' ? 'No difference' : `${option} is better`}
            </label>
          ))}
        </div>
      )}
      {trial.revealed && (
        <div className="scroll-x">
          <table className="tbl judged">
            <thead>
              <tr>
                <th>Expectation</th>
                <th>Judge</th>
                {letters.map((letter) => (
                  <th key={letter}>
                    {letter}: {armLabel(task.results.find((one) => one.letter === letter)!.arm!)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trial.expectations.flatMap((expectation, at) =>
                (task.judgments ?? []).map((judgment, row) => (
                  <tr key={`${at}-${judgment.judge}`}>
                    {row === 0 && <td rowSpan={task.judgments!.length}>{expectation}</td>}
                    <td className="nw">{judgeLabel(judgment.judge)}</td>
                    {letters.map((letter) => {
                      const answer = judgment.answers.find((one) => one.letter === letter && one.expectation === at);
                      return (
                        <td key={letter}>
                          {answer ? <b>{answerWords(answer.p)}</b> : <span className="muted">{judgment.state === 'failed' ? `Failed: ${judgment.error}` : 'No answer'}</span>}
                          {answer?.passage && <div className="muted">“{answer.passage}”</div>}
                        </td>
                      );
                    })}
                  </tr>
                )),
              )}
              <tr>
                <td>Which is better</td>
                <td className="nw">You</td>
                <td colSpan={letters.length}>{task.answer === 'same' ? 'No difference' : task.answer === null ? '–' : <b>Result {task.answer}</b>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Verdict({ trial }: { trial: TrialView }) {
  const { verdict } = trial;
  if (verdict === null) return null;
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>{verdict.agreed ? 'Agreed: the draft is an improvement' : 'Not agreed'}</h2>
        <span className="aside">A draft is committed only when nothing counted got worse and everyone who counts calls it an improvement</span>
      </div>
      {verdict.worse.length > 0 && (
        <div className="entry-problems">
          <b>What can be counted got worse with the draft:</b>
          <ul>
            {verdict.worse.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {Object.entries(verdict.judges).map(([judge, { improvement, why }]) => (
        <div key={judge} className="entry">
          <div className="entry-h">
            <b>{judgeLabel(judge)}</b>
            <span className={`tag ${improvement ? 'ok' : 'back'}`}>{improvement ? 'an improvement' : 'no improvement'}</span>
          </div>
          <div className="entry-t">{why}</div>
        </div>
      ))}
    </section>
  );
}

export function TrialPage({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const { data: trial, error } = useQuery({ queryKey: ['trial', id], queryFn: () => getTrial(id), refetchInterval: (query) => (query.state.data && isWorking(query.state.data) ? POLL_MS : false) });
  const [choices, setChoices] = useState<Choices>({});
  const [cap, setCap] = useState('');
  const act = useMutation({
    mutationFn: (work: () => Promise<TrialView>) => work(),
    onSuccess: (next) => queryClient.setQueryData(['trial', id], next),
  });

  if (!trial) {
    return error ? (
      <p className="notice">
        {error.message}. <Link to="/roles">See all roles</Link>
      </p>
    ) : (
      <p className="notice">Loading…</p>
    );
  }

  const answering = trial.state === 'awaiting_answer';
  const left = unanswered(trial.tasks, choices);
  const blocked = cannotCommit(trial);
  const { runs, judgments } = trial.progress;

  return (
    <>
      <header className="ph">
        <div>
          <div className="crumbs">
            <Link to="/roles">Roles</Link>
            <span>/</span>
            <Link to={rolePath(trial.roleId)}>{roleName(trial.roleId)}</Link>
            <span>/</span>
            <Link to={draftPath(trial.draftId)}>Draft</Link>
            <span>/</span>
          </div>
          <h1>Trial {trial.id}</h1>
          <div className="ph-sub">
            <span>
              <b>{trialState({ state: trial.state, committed: trial.commits !== null }, trial.commits?.undone !== undefined)}</b>
              {trial.stopReason !== null && `, because ${trial.stopReason}`}
            </span>
            <span>
              {runs.done} of {runs.total} results in, {judgments.done} of {judgments.total} judgments
            </span>
            <span>
              {cost(trial.spentUsd)} spent of {cost(trial.capUsd)}
            </span>
            <span>started {when(trial.createdAt)}</span>
          </div>
        </div>
        <div className="row">
          {(isWorking(trial) || answering) && (
            <button type="button" className="btn" onClick={() => act.mutate(() => stopTrial(id))}>
              Stop
            </button>
          )}
          {trial.state === 'stopped' && (
            <>
              <input type="text" className="cap" value={cap} placeholder={`cap, now ${trial.capUsd}`} aria-label="New spending cap in dollars" onChange={(event) => setCap(event.target.value)} />
              <button type="button" className="btn primary" onClick={() => act.mutate(() => resumeTrial(id, cap.trim() === '' ? undefined : Number(cap)))}>
                Go on
              </button>
            </>
          )}
        </div>
      </header>
      <div className="content trial">
        {act.error && <p className="banner bad">{act.error.message}</p>}
        <section className="panel">
          <div className="panel-h">
            <h2>What was expected</h2>
            <span className="aside">each judge answers these about every result</span>
          </div>
          <ol className="expectations">
            {trial.expectations.map((expectation) => (
              <li key={expectation}>{expectation}</li>
            ))}
          </ol>
        </section>

        <Verdict trial={trial} />

        {trial.revealed && (
          <section className="panel">
            <div className="panel-b row">
              {trial.commits === null ? (
                <>
                  <span className="grow">{blocked ?? 'The draft can be committed. Live tasks read it from then on.'}</span>
                  <button type="button" className="btn primary" disabled={blocked !== null || act.isPending} onClick={() => act.mutate(() => commitTrial(id))}>
                    Commit the draft
                  </button>
                  {!trial.draftMoved && (
                    <button type="button" className="btn danger" disabled={act.isPending} onClick={() => window.confirm('Discard the draft this trial tried?') && act.mutate(async () => (await discardDraft(trial.draftId), getTrial(id)))}>
                      Discard the draft
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="grow">
                    {trial.commits.undone ? 'Committed, then undone.' : 'Committed.'}
                    {[trial.commits.knowledge, trial.commits.state].filter((sha) => sha !== undefined).map((sha) => (
                      <span key={sha} className="mono">
                        {' '}
                        {shortSha(sha)}
                      </span>
                    ))}
                  </span>
                  {!trial.commits.undone && (
                    <button type="button" className="btn danger" disabled={act.isPending} onClick={() => window.confirm('Undo this commit? The files go back to what they were before it.') && act.mutate(() => undoTrial(id))}>
                      Undo the commit
                    </button>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {answering && (
          <p className="banner">
            Every result is in and has been judged. Before you see what the judges found, say for each task which result is better. They are shown without saying which
            came from the draft, so that you judge the work and not its label.
          </p>
        )}

        {trial.tasks.map((task) => (
          <Task key={task.attemptId} task={task} trial={trial} choice={choices[String(task.attemptId)]} {...(answering ? { onChoose: (choice: Letter | 'same') => setChoices({ ...choices, [task.attemptId]: choice }) } : {})} />
        ))}

        {answering && (
          <section className="panel">
            <div className="panel-b row">
              <span className="grow">{left.length === 0 ? 'Every task is answered.' : `${left.length} still to answer: ${left.map(({ ticketId }) => ticketId).join(', ')}`}</span>
              <button type="button" className="btn primary" disabled={left.length > 0 || act.isPending} onClick={() => act.mutate(() => answerTrial(id, choices))}>
                Give my answer and see the judges’
              </button>
            </div>
          </section>
        )}

        <p className="lede limits">
          What a trial can and can’t show. Each side of a comparison is one run, and the same task run twice does not come out the same, so with five to seven tasks only a
          clear difference means something: one task going the other way can be chance. A run again is checked for the form of its answer and, for a ticket, by the ticket’s
          own commands; the engine’s fuller checks of a document depend on the project as it was then and are not made again.
        </p>
      </div>
    </>
  );
}
