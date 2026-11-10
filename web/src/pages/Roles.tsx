import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { Lesson, RoleProvenance, RoleSummary } from '../../../src/roles/provenance.ts';
import { getRoleProvenance, listRoles } from '../api.ts';
import { DiffView } from '../components/DiffTab.tsx';
import { plural, roleChip, when } from '../lib/ledger.ts';
import { changeKey, charterRows, day, fileLabel, linesFrom, roleName, rolePath, shortSha, sourceLabel, unwrap } from '../lib/roles.ts';
import { Link } from '../router.tsx';

function Memory({ budgets }: { budgets: RoleSummary['budgets'] }) {
  if (budgets === null) return <span className="muted">–</span>;
  return (
    <>
      Empty
      <div className="muted">
        0 of {budgets.playbook_tokens.toLocaleString()} and 0 of {budgets.memory_tokens.toLocaleString()} tokens
      </div>
    </>
  );
}

function RosterRow({ role }: { role: RoleSummary }) {
  const limit = role.charterTokenLimit;
  return (
    <tr>
      <td>
        <div className="who">
          <span className="rchip">{roleChip(role.id)}</span>
          <div>
            <Link to={rolePath(role.id)}>{roleName(role.id)}</Link>
            <div className="muted mono">{role.id}</div>
          </div>
        </div>
        {role.error !== null && <div className="err-line">{role.error}</div>}
      </td>
      <td className="mission">{role.mission ?? <span className="muted">–</span>}</td>
      <td className="mono">{role.model ?? '–'}</td>
      <td className="nw">
        <span className={`meter${role.charterTokens >= limit ? ' warn' : ''}`}>
          <i style={{ width: `${Math.min(100, (100 * role.charterTokens) / limit)}%` }} />
        </span>
        <div className="muted">
          {role.charterTokens} of {limit} tokens
        </div>
      </td>
      <td className="nw">
        <b>{role.lessons}</b> {role.lessons === 1 ? 'change' : 'changes'}
        <div className="muted">{role.lastLesson === null ? 'none committed' : `last on ${day(role.lastLesson)}`}</div>
        {role.uncommitted && <span className="tag back">not committed</span>}
      </td>
      <td className="nw">
        <Memory budgets={role.budgets} />
      </td>
    </tr>
  );
}

export function Roles() {
  const { data: roles, error } = useQuery({ queryKey: ['roles'], queryFn: listRoles });

  return (
    <>
      <header className="ph">
        <div>
          <h1>Roles</h1>
          {roles && (
            <div className="ph-sub">
              <span>{plural(roles.length, 'role')}</span>
              <span>{plural(roles.filter(({ uncommitted }) => uncommitted).length, 'role')} with changes not committed</span>
            </div>
          )}
        </div>
      </header>
      <div className="content">
        <p className="lede">
          A role is a charter and a config file in the knowledge repo, and nothing else carries over from one task to the next. Each role sets budget aside for a playbook and a
          project memory, but nothing writes to either yet: every lesson so far is a change someone committed. Open a role to see which change wrote each line of its charter.
        </p>
        {error && <p className="err">Couldn't load the roles: {error.message}</p>}
        {roles && roles.length === 0 && <div className="panel empty">The knowledge repo has no roles.</div>}
        {roles && roles.length > 0 && (
          <div className="panel scroll-x">
            <table className="tbl roster">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Mission</th>
                  <th>Model</th>
                  <th>Charter</th>
                  <th>Lessons</th>
                  <th>Playbook and memory</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <RosterRow key={role.id} role={role} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function RoleNav({ current }: { current: string }) {
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: listRoles });
  return (
    <nav className="rolelist" aria-label="Roles">
      {roles?.map((role) => (
        <Link key={role.id} to={rolePath(role.id)} className={role.id === current ? 'on' : ''}>
          <span className="rchip">{roleChip(role.id)}</span>
          {roleName(role.id)}
          <span className="c">{role.lessons}</span>
        </Link>
      ))}
    </nav>
  );
}

function Charter({ role, selected, onSelect }: { role: RoleProvenance; selected: string | null; onSelect: (key: string | null) => void }) {
  const rows = charterRows(role.lines, selected);
  const hits = selected === null ? 0 : linesFrom(role.lines, selected);
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>Charter</h2>
        <span className="aside">
          {selected === null ? (
            <span>
              {role.charterTokens} of {role.charterTokenLimit} tokens
            </span>
          ) : (
            <>
              <span>{hits === 0 ? 'No line of today’s charter comes from this change' : `${plural(hits, 'line')} from this change`}</span>
              <button type="button" className="btn sm" onClick={() => onSelect(null)}>
                Show all lines
              </button>
            </>
          )}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="panel-b muted">This role has no charter.</div>
      ) : (
        <div className="panel-b charter-body">
          {rows.map((row, i) => (
            <div key={i} className={`ln${row.first ? ' first' : ''}${row.sha === null ? ' unc' : ''} ${row.look}`}>
              <span className="g">
                {row.first && (
                  <button type="button" onClick={() => onSelect(row.key)} title={row.subject ?? 'Not committed yet'}>
                    {row.sha === null || row.date === null ? (
                      'not committed'
                    ) : (
                      <>
                        {day(row.date)} <span className="mono">{shortSha(row.sha)}</span>
                      </>
                    )}
                  </button>
                )}
              </span>
              <span className="age" style={row.ink === null ? undefined : { background: `color-mix(in srgb, var(--ink) ${row.ink}%, transparent)` }} />
              <span className="tx">{row.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LessonItem({ lesson, on, onToggle }: { lesson: Lesson; on: boolean; onToggle: () => void }) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onToggle();
  };
  return (
    <div id={`lesson-${changeKey(lesson)}`} className={`lesson${on ? ' on' : ''}${lesson.source === 'uncommitted' ? ' unc' : ''}`}>
      <div className="lesson-h" role="button" tabIndex={0} aria-expanded={on} onClick={onToggle} onKeyDown={onKeyDown}>
        <div className="when">
          <span>{lesson.date === null ? 'now' : when(lesson.date)}</span>
          {lesson.sha !== null && <span className="mono">{shortSha(lesson.sha)}</span>}
          <span>{sourceLabel(lesson.source)}</span>
        </div>
        <div className="what">{lesson.subject}</div>
        <div className="files">
          {lesson.files.map((file) => (
            <span key={file.path} className={`ftag ${file.kind}`} title={file.path}>
              {fileLabel(file)} <span className="p">+{file.add}</span> <span className="m">−{file.del}</span>
            </span>
          ))}
        </div>
      </div>
      {on && (
        <div className="lesson-diff">
          {lesson.body !== '' && <p className="body">{unwrap(lesson.body)}</p>}
          {lesson.files.map((file) => (
            <div key={file.path}>
              <h4>
                {file.path}
                {file.untracked && ', a file git has never seen'}
                {file.clipped && ', cut short'}
              </h4>
              <DiffView text={file.diff} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoleDetail({ id }: { id: string }) {
  const { data: role, error } = useQuery({ queryKey: ['role', id], queryFn: () => getRoleProvenance(id) });
  const [selected, setSelected] = useState<string | null>(null);
  // A change picked from the charter's gutter scrolls into view in the list; one picked in the list is already there.
  const [reveal, setReveal] = useState<string | null>(null);

  useEffect(() => {
    if (reveal !== null) document.getElementById(`lesson-${reveal}`)?.scrollIntoView({ block: 'nearest' });
  }, [reveal]);

  if (!role) {
    return error ? (
      <p className="notice">
        {error.message}. <Link to="/roles">See all roles</Link>
      </p>
    ) : (
      <p className="notice">Loading…</p>
    );
  }

  const commits = role.lessons.filter(({ sha }) => sha !== null).length;
  const pending = role.lessons.length > commits;
  const b = role.budgets;

  return (
    <>
      <header className="ph">
        <div>
          <div className="crumbs">
            <Link to="/roles">Roles</Link>
            <span>/</span>
          </div>
          <h1>{roleName(role.id)}</h1>
          <div className="ph-sub">
            <span className="mono">{role.id}</span>
            {role.department !== null && <span>{role.department}</span>}
            <span>{plural(commits, 'change')}</span>
            {pending && <span className="tag back">changes not committed</span>}
            {role.error !== null && <span className="err-line">{role.error}</span>}
          </div>
        </div>
      </header>
      <div className="content">
        {role.mission !== null && <p className="lede">{role.mission}</p>}
        <div className="prov">
          <RoleNav current={role.id} />
          <div className="prov-main">
            <Charter
              role={role}
              selected={selected}
              onSelect={(key) => {
                setSelected(key);
                setReveal(key);
              }}
            />
            <div className="mem-empty">
              <section className="panel">
                <div className="panel-h">
                  <h2>Playbook</h2>
                  <span className="aside">0 of {b?.playbook_tokens.toLocaleString() ?? '–'} tokens</span>
                </div>
                <div className="panel-b">Empty. Nothing writes a role’s playbook yet, so every run starts without one.</div>
              </section>
              <section className="panel">
                <div className="panel-h">
                  <h2>Project memory</h2>
                  <span className="aside">0 of {b?.memory_tokens.toLocaleString() ?? '–'} tokens</span>
                </div>
                <div className="panel-b">Empty. Nothing a role learns about a project is kept for its next task.</div>
              </section>
            </div>
            <section className="panel">
              <div className="kv">
                <div>
                  <span>Model</span>
                  <b className="mono">{role.model ?? '–'}</b>
                </div>
                <div>
                  <span>Context budget</span>
                  <b>{b === null ? '–' : `${b.context_tokens.toLocaleString()} tokens`}</b>
                </div>
                <div>
                  <span>Per task</span>
                  <b>{b === null ? '–' : `${b.max_turns} turns, $${b.max_usd.toFixed(2)}`}</b>
                </div>
                <div>
                  <span>Produces</span>
                  <b>{role.produces.length === 0 ? '–' : role.produces.join(', ')}</b>
                </div>
              </div>
            </section>
          </div>
          <section className="panel lessons-col">
            <div className="panel-h">
              <h2>Lessons</h2>
              <span className="aside">{role.lessons.length === 0 ? 'none yet' : `${plural(role.lessons.length, 'change')}, newest first`}</span>
            </div>
            <div className="lessons">
              {role.lessons.map((lesson) => {
                const key = changeKey(lesson);
                return (
                  <LessonItem
                    key={key}
                    lesson={lesson}
                    on={selected === key}
                    onToggle={() => {
                      setSelected(selected === key ? null : key);
                      setReveal(null);
                    }}
                  />
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
