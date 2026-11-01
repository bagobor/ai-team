import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ArtifactStatus } from '../../../src/artifacts/format.ts';
import { getArtifact, getArtifactDiff, getLineage, getProject, listArtifacts, useProjectEvents } from '../api.ts';
import { DiffView } from '../components/DiffTab.tsx';
import { LineageGraph } from '../components/LineageGraph.tsx';
import { PinLink, Traceability } from '../components/Traceability.tsx';
import { currentMilestone } from '../lib/board.ts';
import { groupDocuments } from '../lib/documents.ts';
import { documentPin, type DocumentPin } from '../lib/inbox.ts';
import { staleNotes } from '../lib/lineageLayout.ts';
import { Link } from '../router.tsx';

const BADGE: Record<ArtifactStatus, string> = { draft: 'draft', proposed: 'draft', approved: 'ok', superseded: 'draft', stale: 'stale' };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function StatusBadge({ status }: { status: ArtifactStatus }) {
  return (
    <span className={`bd ${BADGE[status]}`}>
      {status === 'stale' && <i className="lamp stale" />}
      {status}
    </span>
  );
}

function Compare({ project, id, versions, shown }: { project: string; id: string; versions: number[]; shown: number }) {
  const earlier = versions.filter((version) => version < shown).at(-1);
  const [from, setFrom] = useState(earlier ?? shown);
  const [to, setTo] = useState(earlier === undefined ? (versions.find((version) => version > shown) ?? shown) : shown);
  const { data, error } = useQuery({
    queryKey: ['artifacts', project, 'diff', id, from, to],
    queryFn: () => getArtifactDiff(project, id, from, to),
    enabled: from !== to,
  });

  const picker = (label: string, value: number, choose: (version: number) => void) => (
    <select aria-label={label} value={value} onChange={(event) => choose(Number(event.target.value))}>
      {versions.map((version) => (
        <option key={version} value={version}>
          v{version}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="doc-compare">
        <span>Compare</span>
        {picker('Compare from version', from, setFrom)}
        <span>with</span>
        {picker('Compare with version', to, setTo)}
      </div>
      {from === to && <p className="empty">Pick two different versions.</p>}
      {from !== to && error && <p className="empty err">{error.message}</p>}
      {from !== to && data && (data.diff === '' ? <p className="empty">These two versions are the same.</p> : <DiffView text={data.diff} />)}
    </>
  );
}

function DocumentPanel({ project, pin, onOpen }: { project: string; pin: DocumentPin; onOpen: (pin: DocumentPin) => void }) {
  const { id, version } = pin;
  const { data, error } = useQuery({ queryKey: ['artifacts', project, 'document', id, version], queryFn: () => getArtifact(project, id, version) });

  if (!data) {
    return <div className="panel">{error ? <p className="empty err">{error.message}</p> : <p className="empty">Loading…</p>}</div>;
  }

  const versions = data.versions.map((row) => row.version).sort((a, b) => a - b);
  return (
    <div className="panel" data-testid="document">
      <div className="panel-h">
        <h2 className="mono">{data.id}</h2>
        <div className="aside">
          <span>{data.ownerRole}</span>
          <StatusBadge status={data.status} />
        </div>
      </div>
      <div className="attempt-pick">
        {versions.map((v) => (
          <button key={v} type="button" className={`btn sm mono${v === data.version ? ' on' : ''}`} onClick={() => onOpen({ id, version: v })}>
            v{v}
          </button>
        ))}
      </div>
      {data.derivedFrom.length > 0 && (
        <div className="doc-sources">
          <span>Derived from</span>
          {data.derivedFrom.map((source) => (
            <PinLink key={source} pin={source} onOpen={onOpen} />
          ))}
        </div>
      )}
      <pre className="doc-body">{data.body}</pre>
      {versions.length > 1 && <Compare key={data.version} project={project} id={id} versions={versions} shown={data.version} />}
    </div>
  );
}

export function Documents({ project }: { project: string }) {
  useProjectEvents(project);
  const { data: documents, error } = useQuery({ queryKey: ['artifacts', project], queryFn: () => listArtifacts(project) });
  const { data: lineage } = useQuery({ queryKey: ['artifacts', project, 'lineage'], queryFn: () => getLineage(project) });
  const { data: details } = useQuery({ queryKey: ['project', project], queryFn: () => getProject(project) });
  const [pin, setPin] = useState(() => documentPin(window.location.hash));

  // Pasting another document's link into this tab changes only the hash, which doesn't reload the page.
  useEffect(() => {
    const read = () => setPin(documentPin(window.location.hash));
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  if (!documents) {
    return error ? (
      <p className="notice">
        {error.message}. <Link to="/">See all projects</Link>
      </p>
    ) : (
      <p className="notice">Loading…</p>
    );
  }

  const milestone = currentMilestone(details?.milestones ?? []);
  const open = (id: string) => setPin({ id, version: null });

  return (
    <>
      <header className="ph">
        <div>
          <div className="crumbs">
            <span className="mono">{project}</span>
            <span>/</span>
          </div>
          <h1>Documents</h1>
          <div className="ph-sub">
            <span>{plural(documents.length, 'document')}</span>
            <span>{documents.filter(({ status }) => status === 'stale').length} stale</span>
            <span>Every document records what it was derived from</span>
          </div>
        </div>
      </header>
      <div className="docs">
        <aside className="panel doclist" aria-label="Documents by type">
          {documents.length === 0 && <p className="empty">No documents yet. The team writes them once it has a brief.</p>}
          {groupDocuments(documents).map(({ label, documents: rows }) => (
            <div key={label} className="dl-g">
              <h3>{label}</h3>
              {rows.map(({ artifact_id, version, status }) => (
                <button key={artifact_id} type="button" className={`dl-i${pin?.id === artifact_id ? ' sel' : ''}`} title={artifact_id} onClick={() => open(artifact_id)}>
                  <span className="nm">
                    {artifact_id} <span className="mono muted">v{version}</span>
                  </span>
                  <StatusBadge status={status} />
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="stack">
          {pin && <DocumentPanel key={pin.id} project={project} pin={pin} onOpen={setPin} />}

          <div className="panel">
            <div className="panel-h">
              <h2>Lineage</h2>
              <div className="aside">
                <span>Arrows point from source to derived document</span>
              </div>
            </div>
            {lineage && staleNotes(lineage).length > 0 && (
              <div className="lg-notes">
                {staleNotes(lineage).map(({ source, version, citing }) => (
                  <div key={source} className="note stale" data-testid="stale-note">
                    <span className="lamp stale" />
                    <span>
                      {source} v{version} changed. Still citing the old text: {citing.join(', ')}.
                    </span>
                  </div>
                ))}
              </div>
            )}
            {lineage && <LineageGraph graph={lineage} selected={pin?.id ?? null} onSelect={open} />}
          </div>

          {milestone !== null && <Traceability project={project} milestone={milestone} onOpen={setPin} />}
        </div>
      </div>
    </>
  );
}
