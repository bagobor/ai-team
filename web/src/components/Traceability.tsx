import { useQuery } from '@tanstack/react-query';
import { listCriteria, type CriterionSummary } from '../api.ts';
import { pinParts, type DocumentPin } from '../lib/inbox.ts';

const LOOK: Record<CriterionSummary['status'], string> = { unverified: '', passing: 'pass', failing: 'fail', waived: '' };

export function PinLink({ pin, onOpen }: { pin: string; onOpen: (pin: DocumentPin) => void }) {
  const parts = pinParts(pin);
  if (!parts) return <span className="mono">{pin}</span>;
  return (
    <button type="button" className="link mono" onClick={() => onOpen(parts)}>
      {pin}
    </button>
  );
}

export function Traceability({ project, milestone, onOpen }: { project: string; milestone: number; onOpen: (pin: DocumentPin) => void }) {
  const { data, error } = useQuery({ queryKey: ['artifacts', project, 'criteria', milestone], queryFn: () => listCriteria(project, milestone) });

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>M{milestone} acceptance criteria traceability</h2>
        <div className="aside">
          <span>Only QA evidence can mark a criterion passing</span>
        </div>
      </div>
      {error && <p className="empty err">{error.message}</p>}
      {data?.length === 0 && <p className="empty">This milestone has no acceptance criteria yet.</p>}
      {data && data.length > 0 && (
        <div className="scroll-x">
          <table className="tbl trace">
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Tickets</th>
                <th>Tests</th>
                <th>Latest evidence</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map(({ ac_id, text, tickets, commands, evidence_ref, status }) => (
                <tr key={ac_id}>
                  <td className="crit">
                    <span className="id">{ac_id}</span> {text}
                  </td>
                  <td>
                    {tickets.map((ticket) => (
                      <span key={ticket} className="mono tk">
                        {ticket}
                      </span>
                    ))}
                  </td>
                  <td className="cmds">
                    {commands.map((command) => (
                      <div key={command} className="mono">
                        {command}
                      </div>
                    ))}
                  </td>
                  <td>{evidence_ref ? <PinLink pin={evidence_ref} onOpen={onOpen} /> : <span className="muted">None from QA yet</span>}</td>
                  <td>
                    <span className={`st ${LOOK[status]}`}>
                      <i className={`lamp ${LOOK[status] || 'idle'}`} />
                      {status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
