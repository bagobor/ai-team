import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { MemoryFile } from '../../../src/knowledge/entries.ts';
import type { EntriesView, EntryView, Lesson, RoleProvenance, RoleSummary } from '../../../src/roles/provenance.ts';
import { getRoleMemory, getRoleProvenance, listProjects, listRoles } from '../api.ts';
import { DiffView } from '../components/DiffTab.tsx';
import { plural, roleChip, when } from '../lib/ledger.ts';
import { changeKey, charterRows, day, entryByline, fileLabel, linesFrom, roleName, rolePath, shortSha, sourceLabel, unwrap } from '../lib/roles.ts';
import { Link } from '../router.tsx';

function Knowledge({ role }: { role: RoleSummary }) {
  if (role.budgets === null) return <span className="muted">–</span>;
  return (
    <>
      {role.playbookTokens === 0 ? 'No playbook' : `Playbook: ${role.playbookTokens.toLocaleString()} of ${role.budgets.playbook_tokens.toLocaleString()} tokens`}
      <div className="muted">Memory is kept per project, up to {role.budgets.memory_tokens.toLocaleString()} tokens</div>
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
        <Knowledge role={role} />
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
          A role is a charter, a playbook and a config file in the knowledge repo. A task is given all of the charter and the playbook, and what fits of the memory kept for its
          project. Open a role to see which change wrote each line of its charter and each entry of its playbook, and what it remembers about a project.
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

// onCommit is given for a file whose commits are among the role's lessons, so that an entry's commit can be opened there.
function Entries({ view, leftOut, onCommit }: { view: EntriesView; leftOut?: string[]; onCommit?: (key: string) => void }) {
  const commitOf = ({ sha, date }: EntryView) =>
    sha === null || date === null ? (
      'not committed'
    ) : (
      <>
        {day(date)} <span className="mono">{shortSha(sha)}</span>
      </>
    );
  return (
    <>
      {view.problems.length > 0 && (
        <div className="entry-problems">
          <b>Every task that would read this file is stopped until this is fixed in {view.path}:</b>
          <ul>
            {view.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {view.entries.map((entry) => (
        <div key={entry.id} className={`entry${entry.sha === null ? ' unc' : ''}`}>
          <div className="entry-h">
            <b className="mono">{entry.id}</b>
            {entry.kind !== null && <span className="tag">{entry.kind}</span>}
            {leftOut?.includes(entry.id) && <span className="tag back">too long to fit, so no task is given it</span>}
            <span className="by">{entryByline(entry)}</span>
            <span className="commit" title={entry.subject ?? 'Not committed yet'}>
              {onCommit ? (
                <button type="button" onClick={() => onCommit(changeKey(entry))}>
                  {commitOf(entry)}
                </button>
              ) : (
                commitOf(entry)
              )}
            </span>
          </div>
          <div className="entry-t">{entry.text}</div>
          {entry.sources.length > 0 && <div className="entry-src">From {entry.sources.join(', ')}</div>}
        </div>
      ))}
    </>
  );
}

function Playbook({ role, onCommit }: { role: RoleProvenance; onCommit: (key: string) => void }) {
  const { playbook, budgets } = role;
  return (
    <section className="panel">
      <div className="panel-h">
        <h2>Playbook</h2>
        <span className="aside">
          {playbook.tokens.toLocaleString()} of {budgets?.playbook_tokens.toLocaleString() ?? '–'} tokens{playbook.problems.length === 0 && playbook.tokens > 0 && ', all of it given to every task'}
        </span>
      </div>
      {playbook.entries.length === 0 && playbook.problems.length === 0 ? (
        <div className="panel-b muted">
          Empty. A playbook is how to do this role’s work well in any project. For now it is written by hand, in <span className="mono">{playbook.path}</span> in the knowledge repo.
        </div>
      ) : (
        <Entries view={playbook} onCommit={onCommit} />
      )}
    </section>
  );
}

const MEMORY_FILES: { file: MemoryFile; title: string }[] = [
  { file: 'project', title: 'Known to the whole team' },
  { file: 'role', title: 'This role’s own notes' },
];

function ProjectMemory({ role }: { role: RoleProvenance }) {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const [picked, setPicked] = useState<string | null>(null);
  // The newest project is the one most likely in hand.
  const project = picked ?? projects?.at(-1)?.name ?? null;
  const { data: memory, error } = useQuery({ queryKey: ['role-memory', role.id, project], queryFn: () => getRoleMemory(role.id, project!), enabled: project !== null });
  const empty = memory !== undefined && MEMORY_FILES.every(({ file }) => memory.files[file].entries.length === 0 && memory.files[file].problems.length === 0);

  return (
    <section className="panel">
      <div className="panel-h">
        <h2>Project memory</h2>
        <span className="aside">
          {memory && (
            <span>
              {memory.tokens.toLocaleString()} of {role.budgets?.memory_tokens.toLocaleString() ?? '–'} tokens given to a task
            </span>
          )}
          {projects && projects.length > 0 && (
            <select aria-label="Project" value={project ?? ''} onChange={(event) => setPicked(event.target.value)}>
              {projects.map(({ name }) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </span>
      </div>
      {projects?.length === 0 && <div className="panel-b muted">There is no project yet, so nothing to remember.</div>}
      {error && <div className="panel-b err-line">Couldn’t load the memory: {error.message}</div>}
      {memory && memory.problems.length > 0 && (
        <div className="entry-problems">
          <b>Every task of this role on this project is stopped until this is fixed:</b>
          <ul>
            {memory.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {empty && <div className="panel-b muted">Empty. Nothing has been kept about {project} yet.</div>}
      {memory &&
        !empty &&
        MEMORY_FILES.map(({ file, title }) => {
          const view = memory.files[file];
          return (
            <div key={file} className="entry-file">
              <h3>
                {title} <span className="mono">{view.path}</span>
              </h3>
              {view.entries.length === 0 && view.problems.length === 0 ? (
                <div className="panel-b muted">Nothing yet.</div>
              ) : (
                <Entries view={view} leftOut={memory.omitted.filter((ref) => ref.file === file).map(({ id }) => id)} />
              )}
            </div>
          );
        })}
    </section>
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
            <Playbook
              role={role}
              onCommit={(key) => {
                setSelected(key);
                setReveal(key);
              }}
            />
            <ProjectMemory role={role} />
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
