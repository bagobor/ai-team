import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { addBrief, haltProject, listProjects, type ProjectSummary } from '../api.ts';
import { projectPath } from '../lib/inbox.ts';
import { Link } from '../router.tsx';

const POLL_MS = 3000;

const isStopped = ({ phase }: Pick<ProjectSummary, 'phase'>) => phase === 'closed' || phase === 'halted';

function HaltForm({ project, onClose }: { project: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const halt = useMutation({
    mutationFn: () => haltProject(project, reason.trim()),
    onSuccess: onClose,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    halt.mutate();
  };

  return (
    <form className="confirm" onSubmit={submit}>
      <label>
        Halting stops {project}'s work for good. Why are you halting it?
        <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
      </label>
      <div className="acts">
        <button type="submit" className="btn danger" disabled={reason.trim() === '' || halt.isPending}>
          Halt {project}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Keep it running
        </button>
      </div>
      {halt.error && <p className="err">{halt.error.message}</p>}
    </form>
  );
}

function Row({ project }: { project: ProjectSummary }) {
  const [halting, setHalting] = useState(false);
  const { name, phase, milestone, pending } = project;

  return (
    <>
      <tr>
        <td className="mono">
          <Link to={projectPath(name, 'inbox')}>{name}</Link>
        </td>
        <td>{phase}</td>
        <td>{milestone ? `M${milestone.n} ${milestone.phase}` : <span className="muted">None yet</span>}</td>
        <td className="num">{pending === 0 ? <span className="muted">0</span> : <span className="badge">{pending}</span>}</td>
        <td className="num">
          {!isStopped(project) && !halting && (
            <button type="button" className="btn sm danger" onClick={() => setHalting(true)}>
              Halt
            </button>
          )}
        </td>
      </tr>
      {halting && !isStopped(project) && (
        <tr>
          <td colSpan={5}>
            <HaltForm project={name} onClose={() => setHalting(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

function BriefForm({ projects }: { projects: ProjectSummary[] }) {
  const queryClient = useQueryClient();
  const [project, setProject] = useState('');
  const [markdown, setMarkdown] = useState('');
  const chosen = project || projects[0]?.name || '';
  const add = useMutation({
    mutationFn: () => addBrief(chosen, markdown),
    onSuccess: () => setMarkdown(''),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };

  return (
    <form className="panel" onSubmit={submit}>
      <div className="panel-h">
        <h2>Add a brief</h2>
        <span className="aside">The team reads it and comes back to the Inbox with a plan</span>
      </div>
      <div className="panel-b stack">
        <label className="field">
          Project
          <select value={chosen} onChange={(event) => setProject(event.target.value)}>
            {projects.map(({ name }) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Brief
          <textarea rows={6} value={markdown} onChange={(event) => setMarkdown(event.target.value)} placeholder="What should exist when this is done, and why it matters" />
        </label>
        {add.error && <p className="err">{add.error.message}</p>}
        {add.isSuccess && markdown === '' && <p className="muted">Brief added. The team has started on it.</p>}
        <div>
          <button type="submit" className="btn primary" disabled={markdown.trim() === '' || chosen === '' || add.isPending}>
            Add brief
          </button>
        </div>
      </div>
    </form>
  );
}

export function Projects() {
  const { data, error } = useQuery({ queryKey: ['projects'], queryFn: listProjects, refetchInterval: POLL_MS });
  const running = data?.filter((project) => !isStopped(project)) ?? [];

  return (
    <>
      <header className="ph">
        <h1>Projects</h1>
      </header>
      <div className="content stack">
        {error && <p className="err">Couldn't load the projects: {error.message}</p>}
        {data && data.length === 0 && (
          <div className="panel empty">
            No projects yet. Add one with <span className="mono">aiteam project add &lt;name&gt; &lt;path&gt;</span>.
          </div>
        )}
        {data && data.length > 0 && (
          <div className="panel scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Phase</th>
                  <th>Milestone</th>
                  <th className="num">Waiting on you</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((project) => (
                  <Row key={project.id} project={project} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {running.length > 0 && <BriefForm projects={running} />}
      </div>
    </>
  );
}
