import { useQuery } from '@tanstack/react-query';
import { listTasks } from '../api.ts';
import { StatePill } from '../components/StatePill.tsx';
import { estimateLabel } from '../logState.ts';
import { Link } from '../router.tsx';

const POLL_MS = 3000;

export function TaskList() {
  const { data, error } = useQuery({ queryKey: ['tasks'], queryFn: listTasks, refetchInterval: POLL_MS });

  return (
    <>
      <header className="ph">
        <h1>Tasks</h1>
      </header>
      <div className="content">
        {error && <p className="err">Couldn't load the tasks: {error.message}</p>}
        {data && data.length === 0 && (
          <div className="panel empty">
            No tasks yet. Add one with <span className="mono">aiteam ticket add &lt;project&gt; &lt;file.md&gt;</span>.
          </div>
        )}
        {data && data.length > 0 && (
          <div className="panel">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Title</th>
                  <th>State</th>
                  <th className="num">Attempts</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.map((task) => (
                  <tr key={task.id}>
                    <td className="mono">
                      <Link to={`/tasks/${task.id}`}>{task.ticket_id}</Link>
                    </td>
                    <td>{task.title}</td>
                    <td>
                      <StatePill state={task.state} />
                    </td>
                    <td className="num">{task.attempts}</td>
                    <td className="num">{estimateLabel(task.usdEst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
