import { useQuery } from '@tanstack/react-query';
import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { LedgerNote, LedgerSection, LedgerTask, LedgerVisit } from '../../../src/engine/ledger.ts';
import { getLedger, useProjectEvents } from '../api.ts';
import { answerLabel, dollars, duration, foldedQuote, ledgerTotals, plural, purposeLabel, roleChip, runLabel, stageName, thenOf, when } from '../lib/ledger.ts';
import { Link } from '../router.tsx';

const COLUMNS = 8;

function Quote({ text }: { text: string }) {
  const folded = foldedQuote(text);
  if (folded === null) return <q>{text}</q>;
  return (
    <details className="qd">
      <summary>
        <q>{folded}</q>
      </summary>
      <q>{text}</q>
    </details>
  );
}

function Notes({ notes }: { notes: LedgerNote[] }) {
  if (notes.length === 0) return <span className="muted">–</span>;
  return (
    <ul className="why-l">
      {notes.map((note, i) => (
        <li key={i} className={`w-${note.kind}`}>
          {note.text}
          {note.quote !== undefined && <Quote text={note.quote} />}
          {note.list !== undefined && (
            <details>
              <summary>{plural(note.list.length, 'item')}</summary>
              {note.list.map((item, j) => (
                <div key={j}>{item}</div>
              ))}
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function Runs({ tasks }: { tasks: LedgerTask[] }) {
  return (
    <table className="tbl runs-t">
      <tbody>
        {tasks.map((task) => (
          <tr key={task.taskId}>
            <td>
              <span className="rchip" title={task.roleId}>
                {roleChip(task.roleId)}
              </span>
            </td>
            <td className="mono">
              <Link to={`/tasks/${task.taskId}`}>{task.ticketId}</Link>
            </td>
            <td className="ttl">
              {task.title}
              <div className="muted">{purposeLabel(task.purpose)}</div>
            </td>
            <td className="seq">
              {task.runs.map((run) => (
                <i key={run.attemptId} className={`sq ${run.outcome}${run.review ? ' rv' : ''}`} title={runLabel(run)} aria-label={runLabel(run)} role="img" />
              ))}
            </td>
            <td className="mono">{dollars(task.usdEst)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Inside({ visit }: { visit: LedgerVisit }) {
  return (
    <>
      {visit.tasks.length > 0 ? <Runs tasks={visit.tasks} /> : <span className="muted">No agent ran in this visit.</span>}
      {visit.questions.length > 0 && (
        <ul className="inbox-l">
          {visit.questions.map((question) => (
            <li key={question.id}>
              <span className="rchip">YOU</span>
              <b>{question.title}</b>
              <span className="muted">
                {when(question.askedAt)}, {question.state}
                {question.waitedSeconds !== null && ` after ${duration(question.waitedSeconds)}`}
                {question.answer !== null && `: ${answerLabel(question.answer)}`}
              </span>
              {question.comment !== null && <q>{question.comment}</q>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function VisitRow({ visit, open, onToggle }: { visit: LedgerVisit; open: boolean; onToggle: () => void }) {
  const then = thenOf(visit);
  const look = visit.back ? 'backrow' : then.tag === 'run' ? 'nowrow' : '';
  // A click that opens a list or a quote inside the row leaves the row as it is.
  const onClick = (event: MouseEvent) => {
    if (!(event.target as Element).closest('details, a')) onToggle();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onToggle();
  };

  return (
    <>
      <tr className={`vrow ${look}${open ? ' open' : ''}`} tabIndex={0} aria-expanded={open} onClick={onClick} onKeyDown={onKeyDown}>
        <td>
          <b>{stageName(visit.stage)}</b>
          {visit.round > 1 && <span className="muted"> round {visit.round}</span>}
        </td>
        <td className="mono">{when(visit.from)}</td>
        <td className="nw">{visit.stage === 'merged' ? '–' : duration(visit.seconds)}</td>
        <td className="nw">
          {visit.runs > 0 ? (
            <>
              {visit.runs}
              {visit.failed > 0 && <em className="f"> {visit.failed} failed</em>}
            </>
          ) : (
            <span className="muted">–</span>
          )}
        </td>
        <td className="mono">{visit.runs > 0 ? dollars(visit.usdEst) : '–'}</td>
        <td className="nw">
          {visit.asked > 0 ? (
            <>
              {visit.answered} of {visit.asked} answered
              <div className="tw">{duration(visit.waitingSeconds)} waiting</div>
            </>
          ) : (
            <span className="muted">–</span>
          )}
        </td>
        <td className="nw">{then.tag === null ? then.text : <span className={`tag ${then.tag}`}>{then.text}</span>}</td>
        <td className="why">
          <Notes notes={visit.notes} />
        </td>
      </tr>
      {open && (
        <tr className="subrow">
          <td colSpan={COLUMNS}>
            <Inside visit={visit} />
          </td>
        </tr>
      )}
    </>
  );
}

function Section({ section, isOpen, onToggle }: { section: LedgerSection; isOpen: (key: string) => boolean; onToggle: (key: string) => void }) {
  if (section.visits.length === 0) {
    return (
      <section className="panel ledger-sec">
        <div className="panel-h">
          <h2>{section.title}</h2>
          <span className="aside">not started</span>
        </div>
      </section>
    );
  }
  return (
    <section className="panel ledger-sec">
      <div className="panel-h">
        <h2>{section.title}</h2>
        <span className="aside">
          <span>
            <b>{duration(section.seconds)}</b> from start
          </span>
          <span>
            <b>{section.runs}</b> runs, {section.failed} failed
          </span>
          <span>
            <b>{dollars(section.usdEst)}</b>
          </span>
          <span>
            <b>{section.decisions}</b> {section.decisions === 1 ? 'decision' : 'decisions'} by you
          </span>
          <span>
            <b>{section.loops}</b> {section.loops === 1 ? 'loop' : 'loops'} back
          </span>
        </span>
      </div>
      <div className="scroll-x">
        <table className="tbl led">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Started</th>
              <th>Took</th>
              <th>Runs</th>
              <th>Cost</th>
              <th>You</th>
              <th>Then</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {section.visits.map((visit, i) => {
              const key = `${section.scope}:${i}`;
              return <VisitRow key={key} visit={visit} open={isOpen(key)} onToggle={() => onToggle(key)} />;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Ledger({ project }: { project: string }) {
  useProjectEvents(project);
  const { data: ledger, error } = useQuery({ queryKey: ['ledger', project], queryFn: () => getLedger(project) });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  if (!ledger) {
    return error ? (
      <p className="notice">
        {error.message}. <Link to="/">See all projects</Link>
      </p>
    ) : (
      <p className="notice">Loading…</p>
    );
  }

  const totals = ledgerTotals(ledger);
  const toggle = (key: string) =>
    setOpen((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <>
      <header className="ph">
        <div>
          <div className="crumbs">
            <span className="mono">{project}</span>
            <span>/</span>
          </div>
          <h1>Iterations</h1>
          <div className="ph-sub">
            <span>
              {plural(totals.runs, 'run')}, {totals.failed} failed
            </span>
            <span>{dollars(totals.usdEst)}</span>
            <span>{plural(totals.decisions, 'decision')} by you</span>
            <span>{plural(totals.loops, 'loop')} back</span>
          </div>
        </div>
      </header>
      <div className="content">
        <p className="lede">
          Every visit to every stage, in order. A row with a coloured left edge went back to an earlier stage; the last column says what made it move on. Open a row to see
          the runs inside it, with each attempt and code review as a square, and every question you were asked.
        </p>
        <p className="sqleg">
          <span>
            <i className="sq ok" />
            passed
          </span>
          <span>
            <i className="sq fail" />
            failed
          </span>
          <span>
            <i className="sq back" />
            sent back by review
          </span>
          <span>
            <i className="sq run" />
            running
          </span>
          <span>
            <i className="sq ok rv" />a code review
          </span>
        </p>
        {ledger.sections.map((section) => (
          <Section key={section.scope} section={section} isOpen={(key) => open.has(key)} onToggle={toggle} />
        ))}
      </div>
    </>
  );
}
