import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getProject, listProjectTasks, useProjectEvents } from '../api.ts';
import { BOARD_COLUMNS, boardColumns, boardSummary, currentMilestone, selectTasks, waitsOnYou, type BoardTask } from '../lib/board.ts';
import { Link } from '../router.tsx';

const ALL = 'all';
// Project-level work, such as discovery, belongs to no milestone and is stored under 0.
const PROJECT_WORK = 0;

const WAITING_FOR: Record<string, string> = {
  dependency: 'Waiting for a ticket it depends on',
  path_lock: 'Waiting for a ticket on the same files',
  human_request: 'Waiting for you',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Foot({ task }: { task: BoardTask }) {
  if (task.state === 'running' || task.state === 'checks') {
    return (
      <div className="card-foot">
        <span className="lamp run live" />
        {task.state === 'checks' ? 'Running checks' : 'Running'}
      </div>
    );
  }
  if (task.state === 'escalated') {
    return (
      <div className="card-foot">
        <span className="lamp human" />
        Needs you, see the Inbox
      </div>
    );
  }
  if (task.state === 'blocked') {
    return (
      <div className="card-foot">
        <span className={`lamp ${waitsOnYou(task) ? 'human' : 'idle'}`} />
        {(task.blocked_on && WAITING_FOR[task.blocked_on]) ?? `Blocked on ${task.blocked_on ?? 'something'}`}
      </div>
    );
  }
  if (task.reviewer) {
    return (
      <div className="card-foot">
        <span className={`lamp ${task.reviewer === 'running' || task.reviewer === 'checks' ? 'run live' : 'idle'}`} />
        Reviewer: {task.reviewer}
      </div>
    );
  }
  return null;
}

function Card({ task }: { task: BoardTask }) {
  const look = task.state === 'running' || task.state === 'checks' ? ' running' : waitsOnYou(task) ? ' waiting' : task.state === 'done' ? ' done' : '';
  return (
    <Link to={`/tasks/${task.id}`} className={`card${look}`}>
      <div className="card-top">
        <span className="id">{task.ticket_id}</span>
        <span className="spec">{task.specialty}</span>
      </div>
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        {task.ac_refs.length > 0 && <span className="mono">{task.ac_refs.join(', ')}</span>}
        {task.attempts > 0 && <span>attempt {task.attempts}</span>}
        {task.usdEst !== null && <span className="mono">~${task.usdEst.toFixed(2)} est.</span>}
      </div>
      <Foot task={task} />
    </Link>
  );
}

export function Board({ project }: { project: string }) {
  useProjectEvents(project);
  const { data: tasks, error } = useQuery({ queryKey: ['tasks', project], queryFn: () => listProjectTasks(project) });
  const { data: details } = useQuery({ queryKey: ['project', project], queryFn: () => getProject(project) });
  const [chosenMilestone, setChosenMilestone] = useState<string | null>(null);
  const [specialty, setSpecialty] = useState(ALL);

  if (!tasks) {
    return error ? (
      <p className="notice">
        {error.message}. <Link to="/">See all projects</Link>
      </p>
    ) : (
      <p className="notice">Loading…</p>
    );
  }

  const milestones = details?.milestones ?? [];
  const current = currentMilestone(milestones);
  const milestoneValue = chosenMilestone ?? (current === null ? ALL : String(current));
  const milestone = milestoneValue === ALL ? null : Number(milestoneValue);
  const titled = milestones.find(({ n }) => n === milestone);

  const inMilestone = selectTasks(tasks, { milestone, specialty: null });
  const { tickets, busy, queued, onYou } = boardSummary(inMilestone);
  const columns = boardColumns(selectTasks(inMilestone, { milestone: null, specialty: specialty === ALL ? null : specialty }));
  // From the whole project, so that a choice stays on the list when the milestone changes.
  const specialties = [...new Set(tasks.filter(({ kind }) => kind !== 'code_review').map((task) => task.specialty))].sort();

  return (
    <>
      <header className="ph">
        <div>
          <div className="crumbs">
            <span className="mono">{project}</span>
            <span>/</span>
          </div>
          <h1>Board</h1>
          <div className="ph-sub">
            <span>{titled ? `M${titled.n} ${titled.title}` : milestone === PROJECT_WORK ? 'Discovery' : 'All milestones'}</span>
            <span>{plural(tickets, 'ticket')}</span>
            <span>
              {plural(busy, 'worker')} busy, {queued} queued
            </span>
            {onYou > 0 && <span style={{ color: 'var(--human-ink)' }}>{onYou} blocked on you</span>}
          </div>
        </div>
        <div className="ph-actions board-tools">
          <select aria-label="Milestone" value={milestoneValue} onChange={(event) => setChosenMilestone(event.target.value)}>
            <option value={ALL}>All milestones</option>
            <option value={PROJECT_WORK}>Discovery</option>
            {milestones.map(({ n, title }) => (
              <option key={n} value={n}>
                M{n} {title}
              </option>
            ))}
          </select>
          <select aria-label="Specialty" value={specialty} onChange={(event) => setSpecialty(event.target.value)}>
            <option value={ALL}>All specialties</option>
            {specialties.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="board">
        {BOARD_COLUMNS.map((column) => (
          <div className="bcol" key={column}>
            <div className="bcol-h">
              {column} <span className="n">{columns[column].length}</span>
            </div>
            <div className="bcol-b">
              {columns[column].map((task) => (
                <Card key={task.id} task={task} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
