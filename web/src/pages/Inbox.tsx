import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { InboxAnswer } from '../../../src/engine/inbox.ts';
import { answerInbox, ApiError, useInbox, useProjectEvents } from '../api.ts';
import { ageLabel, documentLink, groupInbox, inboxLabel, projectPath, type InboxItem } from '../lib/inbox.ts';
import { Link } from '../router.tsx';

const hasNotifications = () => 'Notification' in window;

function NotifyMe() {
  const [permission, setPermission] = useState(() => (hasNotifications() ? Notification.permission : 'denied'));

  if (!hasNotifications()) return null;
  if (permission === 'granted') return <span className="muted">Notifications on</span>;
  if (permission === 'denied') return <span className="muted">Notifications are blocked in this browser</span>;
  return (
    <button type="button" className="btn sm" onClick={() => void Notification.requestPermission().then(setPermission)}>
      Notify me
    </button>
  );
}

function Actions({ item, onAnswer, busy }: { item: InboxItem; onAnswer: (answer: InboxAnswer) => void; busy: boolean }) {
  const [mode, setMode] = useState<'choose' | 'changes' | 'reject'>('choose');
  const [text, setText] = useState('');
  const blank = text.trim() === '';

  if (item.type === 'question' && item.options.length > 0) {
    return (
      <div className="acts">
        {item.options.map(({ id, label }) => (
          <button key={id} type="button" className="btn" disabled={busy} onClick={() => onAnswer({ option: id })}>
            {label}
          </button>
        ))}
      </div>
    );
  }

  if (item.type === 'question') {
    return (
      <div className="d-answer">
        <label className="field">
          Your answer
          <textarea value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <div className="acts">
          <button type="button" className="btn primary" disabled={busy || blank} onClick={() => onAnswer({ text: text.trim() })}>
            Send answer
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'changes') {
    return (
      <div className="d-answer">
        <label className="field">
          What needs to change?
          <textarea value={text} onChange={(event) => setText(event.target.value)} autoFocus />
        </label>
        <div className="acts">
          <button type="button" className="btn" onClick={() => setMode('choose')}>
            Back
          </button>
          <button type="button" className="btn primary" disabled={busy || blank} onClick={() => onAnswer({ action: 'request_changes', comment: text.trim() })}>
            Send changes
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'reject') {
    return (
      <div className="acts">
        <span>Reject this?</span>
        <button type="button" className="btn" onClick={() => setMode('choose')}>
          Keep it
        </button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => onAnswer({ action: 'reject' })}>
          Yes, reject
        </button>
      </div>
    );
  }

  return (
    <div className="acts">
      <button type="button" className="btn danger" disabled={busy} onClick={() => setMode('reject')}>
        Reject
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => setMode('changes')}>
        Request changes
      </button>
      <button type="button" className="btn primary" disabled={busy} onClick={() => onAnswer({ action: 'approve' })}>
        Approve
      </button>
    </div>
  );
}

function Detail({ item, onSettled }: { item: InboxItem; onSettled: (message: string) => void }) {
  const queryClient = useQueryClient();
  const answer = useMutation({
    mutationFn: (body: InboxAnswer) => answerInbox(item.id, body),
    onSuccess: () => onSettled('Answer saved. Pick the next item from the list.'),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) onSettled('Already answered');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['inbox'] }),
  });

  return (
    <div className="ib-detail">
      <div className="d-head">
        <div className="d-kind">
          <span className="st human">
            <i className="lamp human" />
            {item.type === 'approval' ? 'Approval' : 'Question'}
          </span>
          <span className="mono">{inboxLabel(item)}</span>
          <span>
            From {item.asked_by} in {item.project}, {ageLabel(item.ageS)}
          </span>
        </div>
        <h2 className="d-title">{item.title}</h2>
        <p className="d-lede">{item.why}</p>
        <div className="d-facts">
          <div>
            <span>Blocks</span>
            <b>{item.blocks.length > 0 ? item.blocks.join(', ') : 'Nothing yet'}</b>
          </div>
          <div>
            <span>Recommendation</span>
            <b>{item.recommendation}</b>
          </div>
        </div>
      </div>
      <div className="d-sec">
        <h3>Evidence</h3>
        {item.evidence.length === 0 && <p className="muted">The team attached no evidence to this.</p>}
        <dl className="d-evidence">
          {item.evidence.map(({ label, value, pin }) => (
            <div key={`${label}:${value}`}>
              <dt className="mono">{label}</dt>
              <dd>{pin === undefined ? value : <Link to={documentLink(item.project, pin)}>{value}</Link>}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="d-foot">
        <div className="d-note">
          {item.type === 'question' && <span className="muted">Team recommends: {item.recommendation}</span>}
          {answer.error && !(answer.error instanceof ApiError && answer.error.status === 409) && <p className="err">{answer.error.message}</p>}
        </div>
        <Actions item={item} busy={answer.isPending} onAnswer={(body) => answer.mutate(body)} />
      </div>
    </div>
  );
}

function ListItem({ item, selected, onSelect }: { item: InboxItem; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`ib-item${selected ? ' sel' : ''}`} role="option" aria-selected={selected} onClick={onSelect}>
      <span className="k">
        <span className="lamp human" />
        <span className="mono">{inboxLabel(item)}</span>
        <span className="grow">from {item.asked_by}</span>
        <span>{ageLabel(item.ageS)}</span>
      </span>
      <span className="ttl">{item.title}</span>
      {item.blocks.length > 0 && (
        <span className="blocks">
          blocks
          {item.blocks.map((blocked) => (
            <span key={blocked} className="mono">
              {blocked}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function ProjectEvents({ name }: { name: string }) {
  useProjectEvents(name);
  return null;
}

export function Inbox({ project }: { project?: string }) {
  const { data, error, refetch } = useInbox();
  const [everywhere, setEverywhere] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const all = data?.items ?? [];
  const own = project === undefined ? all : all.filter((item) => item.project === project);
  const items = project === undefined || everywhere ? all : own;
  const groups = groupInbox(items);
  const first = groups[0]?.items[0]?.id ?? null;
  const item = items.find(({ id }) => id === selected);

  // An item stays chosen until someone chooses another. Moving on by itself would put the next item's Approve under a double click.
  useEffect(() => {
    if (selected === null && first !== null) setSelected(first);
  }, [selected, first]);

  const choose = (id: number) => {
    setSelected(id);
    setMessage(null);
  };

  const filter = (toAll: boolean) => {
    setEverywhere(toAll);
    setSelected(null);
    setMessage(null);
  };

  return (
    <section className="screen fill">
      {project !== undefined && <ProjectEvents name={project} />}
      <header className="ph">
        <div>
          {project !== undefined && (
            <div className="crumbs">
              <Link to={projectPath(project, 'inbox')}>{project}</Link>
              <span>/</span>
            </div>
          )}
          <h1>Inbox</h1>
          <div className="ph-sub">
            <span>The team only asks you for things here. Each item says what it holds up.</span>
          </div>
        </div>
      </header>
      {error && <p className="err content">Couldn't load the Inbox: {error.message}</p>}
      <div className="ib">
        <div className="ib-list" role="listbox" aria-label="Inbox items">
          <div className="ib-filter">
            <div className="seg">
              {project !== undefined && (
                <button type="button" className={everywhere ? '' : 'on'} onClick={() => filter(false)}>
                  This project<span>{own.length}</span>
                </button>
              )}
              <button type="button" className={project === undefined || everywhere ? 'on' : ''} onClick={() => filter(true)}>
                All projects<span>{all.length}</span>
              </button>
            </div>
            <NotifyMe />
          </div>
          {data && items.length === 0 && <p className="empty">Nothing is waiting for you.</p>}
          {groups.map((group) => (
            <div key={group.type} className="ib-group">
              <h3>
                {group.label} <span>{group.items.length}</span>
              </h3>
              {group.items.map((entry) => (
                <ListItem key={entry.id} item={entry} selected={entry.id === selected} onSelect={() => choose(entry.id)} />
              ))}
            </div>
          ))}
        </div>
        {item ? (
          <Detail
            key={item.id}
            item={item}
            onSettled={(text) => {
              setMessage(text);
              void refetch();
            }}
          />
        ) : (
          <div className="ib-detail">
            {selected !== null && data && (
              <div className="d-sec">
                <h2 className="d-title">{message ?? 'This item is no longer waiting for you.'}</h2>
                {message === null && <p className="muted">Pick another from the list.</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
