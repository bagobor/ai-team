import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactDepRow, ArtifactVersionRow, ProjectRow, Store } from '../engine/store.ts';
import { engineGit, git, gitOk } from '../git/git.ts';
import { commitFiles, inTurn } from '../git/state-repo.ts';
import { stateRepoDir, type Paths } from '../paths.ts';
import {
  ARTIFACT_ID,
  ArtifactError,
  formatPin,
  parseArtifact,
  parsePin,
  renderArtifact,
  sectionsOf,
  sectionText,
  type ArtifactDoc,
  type ArtifactStatus,
  type ArtifactType,
  type Pin,
} from './format.ts';

export type NewVersion = {
  id: string;
  type: ArtifactType;
  status: ArtifactStatus;
  ownerRole: string;
  derivedFrom: string[];
  body: string;
  milestone?: number;
  fields?: Record<string, unknown>;
  acceptanceCriteria?: string[];
  approvedBy?: string;
};

export type StatusChange = { id: string; status: ArtifactStatus; approvedBy?: string; staleSections?: string[]; derivedFrom?: string[] };

export type ArtifactChange = { message: string; publish?: NewVersion[]; status?: StatusChange[] };

type Dep = Omit<ArtifactDepRow, 'project_id' | 'from_id' | 'from_version'>;
type Draft = { doc: ArtifactDoc; path: string; deps: Dep[] };

const pathFor = (type: ArtifactType, id: string) => `artifacts/${type}/${id}.md`;

export class ArtifactStore {
  constructor(
    private readonly store: Store,
    private readonly paths: Paths,
  ) {}

  latest(projectId: number, id: string): Promise<ArtifactVersionRow | undefined> {
    return this.store.latestArtifact(projectId, id);
  }

  version(projectId: number, id: string, version: number): Promise<ArtifactVersionRow | undefined> {
    return this.store.artifactVersion(projectId, id, version);
  }

  list(projectId: number): Promise<ArtifactVersionRow[]> {
    return this.store.listLatestArtifacts(projectId);
  }

  // Git first, then SQLite. A crash between the two leaves a commit no row points at, which reconcile puts
  // right. then runs inside the SQLite transaction, so it must use only its store and do no git work.
  commit(project: ProjectRow, change: ArtifactChange, then?: (s: Store, rows: ArtifactVersionRow[]) => Promise<void>): Promise<ArtifactVersionRow[]> {
    const dir = stateRepoDir(this.paths, project.name);
    return inTurn(dir, async () => {
      const publish = change.publish ?? [];
      const statuses = change.status ?? [];
      const now = new Date().toISOString();
      const drafts = await this.allocate(project, publish, now);

      for (const draft of drafts.values()) {
        draft.deps = await this.resolvePins(project, drafts, draft.doc, draft.doc.derivedFrom);
        draft.doc.derivedFrom = draft.deps.map(pinOf);
      }

      const repins = new Map<string, Dep[]>();
      for (const status of statuses) {
        const draft = drafts.get(status.id) ?? (await this.draftOfLatest(project, status.id));
        drafts.set(status.id, draft);
        draft.doc.status = status.status;
        if (status.approvedBy !== undefined) {
          draft.doc.approvedBy = status.approvedBy;
          draft.doc.approvedAt = now;
        }
        if (status.derivedFrom) {
          const deps = await this.resolvePins(project, drafts, draft.doc, status.derivedFrom);
          repins.set(status.id, deps);
          draft.doc.derivedFrom = deps.map(pinOf);
        }
      }

      const files = [...drafts.values()].map(({ doc, path }) => ({ path, content: renderArtifact(doc) }));
      const sha = files.length > 0 ? (await commitFiles(dir, files, change.message)).sha : '';

      return this.store.atomically(async (s) => {
        const rows = new Map<string, ArtifactVersionRow>();

        for (const version of publish) {
          const { doc, path, deps } = drafts.get(version.id) as Draft;
          rows.set(
            version.id,
            await s.insertArtifactVersion({
              project_id: project.id,
              artifact_id: version.id,
              type: version.type,
              version: doc.version,
              status: version.status,
              owner_role: version.ownerRole,
              milestone: version.milestone ?? null,
              sha,
              path,
              derived_from: deps.map(pinOf),
              approved_by: version.approvedBy ?? null,
              approved_at: version.approvedBy === undefined ? null : now,
            }),
          );
          await s.insertArtifactDeps(deps.map((dep) => ({ ...dep, project_id: project.id, from_id: version.id, from_version: doc.version })));
        }

        for (const status of statuses) {
          const { doc } = drafts.get(status.id) as Draft;
          rows.set(
            status.id,
            await s.setArtifactStatus(project.id, status.id, doc.version, {
              status: status.status,
              sha,
              stale_sections: status.staleSections ?? [],
              ...(status.approvedBy === undefined ? {} : { approved_by: status.approvedBy, approved_at: now }),
              ...(status.derivedFrom ? { derived_from: doc.derivedFrom } : {}),
            }),
          );
          const repin = repins.get(status.id);
          if (repin) {
            await s.deleteArtifactDeps(project.id, status.id, doc.version);
            await s.insertArtifactDeps(repin.map((dep) => ({ ...dep, project_id: project.id, from_id: status.id, from_version: doc.version })));
          }
        }

        const result = [...rows.values()];
        await then?.(s, result);
        return result;
      });
    });
  }

  async read(project: ProjectRow, pin: string): Promise<ArtifactDoc> {
    return this.readRow(project, await this.rowFor(project.id, parsePin(pin)));
  }

  // What a worker receives: the fully pinned form, so its report can name exactly what it read.
  async readInput(project: ProjectRow, pin: string): Promise<{ pin: string; path: string; content: string }> {
    const parsed = parsePin(pin);
    const row = await this.rowFor(project.id, parsed);
    const doc = await this.readRow(project, row);
    const fullPin = formatPin({ ...parsed, version: row.version });

    if (parsed.section === undefined) return { pin: fullPin, path: row.path, content: renderArtifact(doc) };

    const text = sectionText(doc.body, parsed.section);
    if (text === undefined) throw new ArtifactError(`${formatPin(parsed)} names a section that ${row.artifact_id}@${row.version} does not have`);
    return { pin: fullPin, path: row.path, content: text };
  }

  async diff(project: ProjectRow, id: string, from: number, to: number): Promise<string> {
    const [a, b] = [await this.rowFor(project.id, { id, version: from }), await this.rowFor(project.id, { id, version: to })];
    return gitOk(stateRepoDir(this.paths, project.name), ['diff', '--no-ext-diff', '--no-color', a.sha, b.sha, '--', a.path]);
  }

  // Runs at startup, when this is the only daemon. Whatever a crash left in the working tree goes, and every
  // recorded artifact's file goes back to what SQLite says it is. Files with no row, such as hand-added
  // tickets, are not the engine's to judge.
  reconcile(project: ProjectRow): Promise<{ restored: string[] }> {
    const dir = stateRepoDir(this.paths, project.name);
    return inTurn(dir, async () => {
      await rm(join(dir, '.git', 'index.lock'), { force: true });
      await engineGit(dir, ['reset', '-q', '--hard']);
      await engineGit(dir, ['clean', '-q', '-fd']);

      const restored: { id: string; path: string; content: string }[] = [];
      for (const row of await this.store.listLatestArtifacts(project.id)) {
        const content = await readBlob(dir, row.sha, row.path);
        const head = await git(dir, ['show', `HEAD:${row.path}`]);
        if (head.code !== 0 || head.stdout !== content) restored.push({ id: row.artifact_id, path: row.path, content });
      }

      if (restored.length > 0) await commitFiles(dir, restored, 'reconcile: restore recorded artifact versions');
      return { restored: restored.map((file) => file.id) };
    });
  }

  private async allocate(project: ProjectRow, publish: NewVersion[], now: string): Promise<Map<string, Draft>> {
    const known = await this.store.listLatestArtifacts(project.id);
    const drafts = new Map<string, Draft>();

    for (const version of publish) {
      if (!ARTIFACT_ID.test(version.id)) throw new ArtifactError(`${JSON.stringify(version.id)} is not a valid artifact id`);
      if (drafts.has(version.id)) throw new ArtifactError(`${version.id} appears twice in one change`);

      // These ids name files, and macOS ignores case.
      const clash = [...known.map((row) => row.artifact_id), ...drafts.keys()].find((id) => id !== version.id && id.toLowerCase() === version.id.toLowerCase());
      if (clash) throw new ArtifactError(`${version.id} differs from the existing artifact ${clash} only by case`);

      const latest = known.find((row) => row.artifact_id === version.id);
      if (latest && latest.type !== version.type) throw new ArtifactError(`${version.id} is a ${latest.type}, so a new version can't be a ${version.type}`);

      drafts.set(version.id, {
        path: pathFor(version.type, version.id),
        deps: [],
        doc: {
          id: version.id,
          type: version.type,
          version: (latest?.version ?? 0) + 1,
          status: version.status,
          ownerRole: version.ownerRole,
          derivedFrom: version.derivedFrom,
          acceptanceCriteria: version.acceptanceCriteria ?? [],
          approvedBy: version.approvedBy ?? null,
          approvedAt: version.approvedBy === undefined ? null : now,
          fields: version.fields ?? {},
          body: version.body,
        },
      });
    }
    return drafts;
  }

  private async draftOfLatest(project: ProjectRow, id: string): Promise<Draft> {
    const row = await this.store.latestArtifact(project.id, id);
    if (!row) throw new ArtifactError(`Can't change the status of ${id}: no such artifact`);
    return { doc: await this.readRow(project, row), path: row.path, deps: [] };
  }

  private async resolvePins(project: ProjectRow, drafts: Map<string, Draft>, from: ArtifactDoc, pins: string[]): Promise<Dep[]> {
    const deps: Dep[] = [];
    for (const text of pins) {
      const pin = parsePin(text);
      const draft = drafts.get(pin.id);
      const version = pin.version ?? draft?.doc.version ?? (await this.rowFor(project.id, pin)).version;
      if (pin.id === from.id && version === from.version) throw new ArtifactError(`${from.id}@${from.version} can't derive from itself`);

      const body = draft?.doc.version === version ? draft.doc.body : (await this.readRow(project, await this.rowFor(project.id, { id: pin.id, version }))).body;
      const section = pin.section === undefined ? undefined : sectionsOf(body).find(({ slug }) => slug === pin.section);
      if (pin.section !== undefined && !section) throw new ArtifactError(`${text} names a section that ${pin.id}@${version} does not have`);

      deps.push({ to_id: pin.id, to_version: version, to_section: pin.section ?? null, to_section_hash: section?.hash ?? null });
    }
    return deps;
  }

  private async rowFor(projectId: number, pin: Pin): Promise<ArtifactVersionRow> {
    const row = pin.version === undefined ? await this.store.latestArtifact(projectId, pin.id) : await this.store.artifactVersion(projectId, pin.id, pin.version);
    if (!row) throw new ArtifactError(`${formatPin(pin)} names an artifact version that does not exist`);
    return row;
  }

  // SQLite decides the status: a superseded version's file still says what it said when it was current.
  private async readRow(project: ProjectRow, row: ArtifactVersionRow): Promise<ArtifactDoc> {
    const doc = parseArtifact(await readBlob(stateRepoDir(this.paths, project.name), row.sha, row.path));
    return { ...doc, status: row.status, approvedBy: row.approved_by, approvedAt: row.approved_at };
  }
}

const pinOf = (dep: Dep) => formatPin({ id: dep.to_id, version: dep.to_version, ...(dep.to_section === null ? {} : { section: dep.to_section }) });

// Not gitOk, which trims a newline that belongs to the document.
async function readBlob(dir: string, sha: string, path: string): Promise<string> {
  const { stdout, stderr, code } = await git(dir, ['show', `${sha}:${path}`]);
  if (code !== 0) throw new ArtifactError(`Can't read ${path} at ${sha}: ${stderr.trim()}`);
  return stdout;
}
