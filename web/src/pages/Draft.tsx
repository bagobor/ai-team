import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { MEMORY_KINDS, type Entry, type MemoryKind } from '../../../src/knowledge/entries.ts';
import type { DraftFileView, DraftView, EntryFile } from '../../../src/trials/drafts.ts';
import {
  addDraftEntry,
  changeDraftEntry,
  discardDraft,
  getDraft,
  keepDraft,
  listDraftTrials,
  listPastAttempts,
  listProjects,
  removeDraftEntry,
  setDraftCharter,
  startTrial,
  type EntryBody,
} from '../api.ts';
import { DiffView } from '../components/DiffTab.tsx';
import { when } from '../lib/ledger.ts';
import { roleName, rolePath } from '../lib/roles.ts';
import { cannotStart, cost, MAX_EXPECTATIONS, pick, sourcesOf, TASKS, trialPath, trialState, type Selection } from '../lib/trials.ts';
import { Link, navigate } from '../router.tsx';

const FILE_TITLE: Record<EntryFile, string> = { playbook: 'Playbook', memory_project: 'Memory known to the whole team', memory_role: 'This role’s own notes' };

type Act = (act: () => Promise<DraftView>) => void;

function FileHead({ title, file }: { title: string; file: DraftFileView }) {
  return (
    <div className="panel-h">
      <h2>{title}</h2>
      <span className="aside">
        {file.path !== null && <span className="mono">{file.path}</span>}
        {file.limit !== null && (
          <span>
            {file.tokens.toLocaleString()} of {file.limit.toLocaleString()} tokens
          </span>
        )}
        {file.changed ? <span className="tag run">changed</span> : <span>as it is live</span>}
        {file.stale && <span className="tag back">the live file has changed since</span>}
      </span>
    </div>
  );
}

function FileDiff({ file }: { file: DraftFileView }) {
  if (!file.changed) return null;
  return (
    <details className="draft-diff">
      <summary>What this changes in the live file</summary>
      <DiffView text={file.diff} />
    </details>
  );
}

function CharterEditor({ draft, file, act, open }: { draft: DraftView; file: DraftFileView; act: Act; open: boolean }) {
  const [text, setText] = useState(file.text);
  // What the engine saved is what the box holds next, so its own tidying shows.
  useEffect(() => setText(file.text), [file.text]);
  return (
    <section className="panel">
      <FileHead title="Charter" file={file} />
      <div className="panel-b">
        <textarea className="mono charter-edit" value={text} readOnly={!open} onChange={(event) => setText(event.target.value)} aria-label="Charter" />
        {open && (
          <div className="row-end">
            <button type="button" className="btn" disabled={text === file.text} onClick={() => setText(file.text)}>
              Put back
            </button>
            <button type="button" className="btn primary" disabled={text === file.text} onClick={() => act(() => setDraftCharter(draft.id, text))}>
              Save to the draft
            </button>
          </div>
        )}
      </div>
      <FileDiff file={file} />
    </section>
  );
}

function EntryForm({ memory, entry, onSave, onCancel }: { memory: boolean; entry?: Entry; onSave: (body: EntryBody) => void; onCancel?: () => void }) {
  const [text, setText] = useState(entry?.text ?? '');
  const [sources, setSources] = useState(entry?.sources.join(', ') ?? '');
  const [kind, setKind] = useState<MemoryKind>(entry?.kind ?? 'lesson');
  const save = () => {
    onSave({ text, sources: sourcesOf(sources), ...(memory ? { kind } : {}) });
    if (!entry) {
      setText('');
      setSources('');
    }
  };
  return (
    <div className="entry-form">
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="A rule or a fact, at most 100 words" aria-label="Entry text" />
      <div className="row">
        {memory && (
          <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} aria-label="Kind">
            {MEMORY_KINDS.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
        )}
        <input type="text" value={sources} onChange={(event) => setSources(event.target.value)} placeholder="What it came from: a ticket, a decision, your note" aria-label="Sources" />
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn primary" disabled={text.trim() === ''} onClick={save}>
          {entry ? 'Save to the draft' : 'Add to the draft'}
        </button>
      </div>
    </div>
  );
}

function EntriesEditor({ draft, file, project, act, open }: { draft: DraftView; file: DraftFileView; project: string | null; act: Act; open: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const name = file.file as EntryFile;
  const memory = name !== 'playbook';
  const withProject = (body: EntryBody): EntryBody => (memory && project !== null ? { ...body, project } : body);
  return (
    <section className="panel">
      <FileHead title={FILE_TITLE[name]} file={file} />
      {file.problems.length > 0 && (
        <div className="entry-problems">
          <b>This file has to be fixed by hand before it can be edited here:</b>
          <ul>
            {file.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {file.entries.length === 0 && file.problems.length === 0 && <div className="panel-b muted">No entries.</div>}
      {file.entries.map((entry) => (
        <div key={entry.id} className="entry" id={`${name}-${entry.id}`}>
          <div className="entry-h">
            <b className="mono">{entry.id}</b>
            {entry.kind !== null && <span className="tag">{entry.kind}</span>}
            <span className="by">
              Added by {entry.addedBy} on {entry.added}
            </span>
            {open && editing !== entry.id && (
              <span className="commit">
                <button type="button" onClick={() => setEditing(entry.id)}>
                  Edit
                </button>
                {' · '}
                <button type="button" onClick={() => act(() => removeDraftEntry(draft.id, name, entry.id))}>
                  Remove
                </button>
              </span>
            )}
          </div>
          {editing === entry.id ? (
            <EntryForm
              memory={memory}
              entry={entry}
              onCancel={() => setEditing(null)}
              onSave={(body) => {
                act(() => changeDraftEntry(draft.id, name, entry.id, body));
                setEditing(null);
              }}
            />
          ) : (
            <>
              <div className="entry-t">{entry.text}</div>
              {entry.sources.length > 0 && <div className="entry-src">From {entry.sources.join(', ')}</div>}
            </>
          )}
        </div>
      ))}
      {open && file.problems.length === 0 && (!memory || project !== null) && (
        <div className="panel-b">
          <EntryForm memory={memory} onSave={(body) => act(() => addDraftEntry(draft.id, name, withProject(body)))} />
        </div>
      )}
      <FileDiff file={file} />
    </section>
  );
}

function TrialForm({ draft }: { draft: DraftView }) {
  // A draft that changes one project's memory can only be tried on that project's tasks.
  const memoryChanged = draft.files.some(({ file, changed }) => changed && file.startsWith('memory'));
  const { data, error } = useQuery({ queryKey: ['past-attempts', draft.role_id, memoryChanged ? draft.project : null], queryFn: () => listPastAttempts(draft.role_id, memoryChanged ? draft.project : null) });
  const [expectations, setExpectations] = useState<string[]>(Array(MAX_EXPECTATIONS).fill(''));
  const [chosen, setChosen] = useState<Selection | null>(null);
  const [cap, setCap] = useState('');
  const selection = chosen ?? { problem: [], fine: data?.fine ?? [] };
  const start = useMutation({
    mutationFn: () => startTrial(draft.id, { expectations: expectations.filter((one) => one.trim() !== ''), ...selection, ...(cap.trim() === '' ? {} : { capUsd: Number(cap) }) }),
    onSuccess: (trial) => navigate(trialPath(trial.id)),
  });
  const missing = data ? cannotStart(expectations, selection, data.attempts) : 'Loading the role’s past work…';

  return (
    <div className="panel-b trial-form">
      <p className="muted">
        A trial runs this draft on {TASKS.min} to {TASKS.max} of the role’s past tasks and compares each result with what the role produces without it. Say first what you
        expected and did not see, as questions that can be answered from a task’s result.
      </p>
      {expectations.map((expectation, i) => (
        <input
          key={i}
          type="text"
          value={expectation}
          placeholder={i === 0 ? 'Such as: Does the report list every command it ran?' : 'Another question, if there is one'}
          aria-label={`Expectation ${i + 1}`}
          onChange={(event) => setExpectations(expectations.map((one, at) => (at === i ? event.target.value : one)))}
        />
      ))}
      {error && <p className="err">Couldn’t load the role’s past work: {error.message}</p>}
      {data && data.attempts.length === 0 && <p className="muted">This role has no past work{memoryChanged ? ` on ${draft.project}` : ''} to try the draft on.</p>}
      {data && data.attempts.length > 0 && (
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Past task</th>
                <th>What it was</th>
                <th>How it ended</th>
                <th>Cost</th>
                <th>In this trial as</th>
              </tr>
            </thead>
            <tbody>
              {data.attempts.map((attempt) => {
                const group = selection.problem.includes(attempt.attemptId) ? 'problem' : selection.fine.includes(attempt.attemptId) ? 'fine' : 'none';
                return (
                  <tr key={attempt.attemptId} className={attempt.replayable ? '' : 'dim'}>
                    <td>
                      <b className="mono">{attempt.ticketId}</b> attempt {attempt.k}
                      <div className="muted">
                        {attempt.project}
                        {attempt.endedAt !== null && `, ${when(attempt.endedAt)}`}
                      </div>
                    </td>
                    <td>
                      {attempt.title}
                      <div className="muted mono">{attempt.purpose}</div>
                    </td>
                    <td>
                      {attempt.firstPass ? 'Went through first time' : attempt.failureKind === null ? attempt.state : `${attempt.state}: ${attempt.failureKind}`}
                      {!attempt.replayable && <div className="err-line">Can’t be run again: {attempt.why}</div>}
                    </td>
                    <td className="nw">{cost(attempt.usd)}</td>
                    <td className="nw">
                      <select value={group} disabled={!attempt.replayable} aria-label={`${attempt.ticketId} in this trial`} onChange={(event) => setChosen(pick(selection, attempt.attemptId, event.target.value as 'problem' | 'fine' | 'none'))}>
                        <option value="none">Not in it</option>
                        <option value="problem">Showed the problem</option>
                        <option value="fine">Went fine</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <label className="muted">
          Stop at $ <input type="text" className="cap" value={cap} onChange={(event) => setCap(event.target.value)} placeholder="10" aria-label="Spending cap in dollars" />
        </label>
        <span className="muted">
          {selection.problem.length} that showed the problem, {selection.fine.length} that went fine
        </span>
        <span className="grow" />
        {missing !== null && <span className="muted">{missing}</span>}
        <button type="button" className="btn primary" disabled={missing !== null || start.isPending} onClick={() => start.mutate()}>
          Start the trial
        </button>
      </div>
      {start.error && <p className="err">{start.error.message}</p>}
    </div>
  );
}

export function DraftPage({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const { data: draft, error } = useQuery({ queryKey: ['draft', id], queryFn: () => getDraft(id) });
  const { data: trials } = useQuery({ queryKey: ['draft-trials', id], queryFn: () => listDraftTrials(id) });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const [project, setProject] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (act: () => Promise<DraftView>) => act(),
    onSuccess: (next) => {
      queryClient.setQueryData(['draft', id], next);
      void queryClient.invalidateQueries({ queryKey: ['open-draft', next.role_id] });
    },
  });

  if (!draft) {
    return error ? (
      <p className="notice">
        {error.message}. <Link to="/roles">See all roles</Link>
      </p>
    ) : (
      <p className="notice">Loading…</p>
    );
  }

  const open = draft.state === 'open';
  const fileOf = (name: string) => draft.files.find(({ file }) => file === name)!;
  const memoryOf = draft.project ?? project ?? projects?.at(-1)?.name ?? null;
  const underWay = trials?.find(({ state }) => state !== 'agreed' && state !== 'not_agreed');
  const act: Act = (work) => change.mutate(work);

  return (
    <>
      <header className="ph">
        <div>
          <div className="crumbs">
            <Link to="/roles">Roles</Link>
            <span>/</span>
            <Link to={rolePath(draft.role_id)}>{roleName(draft.role_id)}</Link>
            <span>/</span>
          </div>
          <h1>Draft: {draft.title}</h1>
          <div className="ph-sub">
            <span>{open ? 'Open. Live tasks keep reading the committed files until this passes a trial.' : `This draft was ${draft.state}.`}</span>
            {draft.changed ? <span className="tag run">has changes</span> : <span>changes nothing yet</span>}
          </div>
        </div>
        {open && (
          <button type="button" className="btn danger" onClick={() => window.confirm('Discard this draft and everything in it?') && act(() => discardDraft(id))}>
            Discard the draft
          </button>
        )}
      </header>
      <div className="content draft">
        {change.error && <p className="banner bad">{change.error.message}</p>}
        {draft.stale && open && (
          <p className="banner">
            A live file changed after this draft first changed it, so the draft would overwrite that change. Look at what each file changes below.{' '}
            <button type="button" className="btn sm" onClick={() => act(() => keepDraft(id))}>
              Keep the draft’s version
            </button>
          </p>
        )}
        <CharterEditor draft={draft} file={fileOf('charter')} act={act} open={open} />
        <EntriesEditor draft={draft} file={fileOf('playbook')} project={null} act={act} open={open} />
        <section className="panel">
          <div className="panel-h">
            <h2>Project memory</h2>
            <span className="aside">
              {draft.project !== null ? (
                <span>
                  This draft changes the memory of <b>{draft.project}</b>
                </span>
              ) : (
                projects &&
                projects.length > 0 && (
                  <>
                    <span>A draft changes one project’s memory:</span>
                    <select aria-label="Project" value={memoryOf ?? ''} onChange={(event) => setProject(event.target.value)}>
                      {projects.map(({ name }) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </>
                )
              )}
            </span>
          </div>
          {memoryOf === null && <div className="panel-b muted">There is no project yet, so no memory to change.</div>}
        </section>
        {memoryOf !== null && (
          <>
            <EntriesEditor draft={draft} file={fileOf('memory_project')} project={memoryOf} act={act} open={open} />
            <EntriesEditor draft={draft} file={fileOf('memory_role')} project={memoryOf} act={act} open={open} />
          </>
        )}
        <section className="panel">
          <div className="panel-h">
            <h2>Trials</h2>
            <span className="aside">{trials === undefined || trials.length === 0 ? 'none yet' : `${trials.length} of this draft`}</span>
          </div>
          {trials?.map((trial) => (
            <div key={trial.id} className="entry">
              <div className="entry-h">
                <Link to={trialPath(trial.id)}>Trial {trial.id}</Link>
                <span>{trialState(trial)}</span>
                {trial.stopReason !== null && <span className="by">because {trial.stopReason}</span>}
                <span className="commit">
                  {when(trial.createdAt)}, {cost(trial.spentUsd)} of {cost(trial.capUsd)}
                </span>
              </div>
            </div>
          ))}
          {open && underWay && (
            <div className="panel-b muted">
              <Link to={trialPath(underWay.id)}>Trial {underWay.id}</Link> has not ended. Answer it, or stop it, before the draft is tried again.
            </div>
          )}
          {open && !underWay && !draft.changed && <div className="panel-b muted">Change something above, and it can be tried.</div>}
          {open && !underWay && draft.changed && !draft.stale && <TrialForm draft={draft} />}
        </section>
      </div>
    </>
  );
}
