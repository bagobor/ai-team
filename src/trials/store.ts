import type { Kysely, Selectable } from 'kysely';
import type { DB, DraftsTable, TrialJudgmentsTable, TrialResultsTable, TrialsTable } from '../db/schema.ts';
import type { DraftRow, JudgmentRow, ResultRow, TrialRow } from './types.ts';

const json = (value: string | null): unknown => (value === null ? null : JSON.parse(value));

// Every key of a patch that holds JSON is written as text; the rest go in as they are.
function columns<T extends object>(patch: T, jsonKeys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, jsonKeys.includes(key) && value !== null ? JSON.stringify(value) : value]));
}

const toDraft = (row: Selectable<DraftsTable>): DraftRow => ({ ...row, base: json(row.base) } as DraftRow);
const toTrial = (row: Selectable<TrialsTable>): TrialRow =>
  ({ ...row, expectations: json(row.expectations), tasks: json(row.tasks), knowledge: json(row.knowledge), human: json(row.human), verdict: json(row.verdict), commits: json(row.commits) }) as TrialRow;
const toResult = (row: Selectable<TrialResultsTable>): ResultRow => ({ ...row, output: json(row.output), measured: json(row.measured) }) as ResultRow;
const toJudgment = (row: Selectable<TrialJudgmentsTable>): JudgmentRow => ({ ...row, answers: json(row.answers) }) as JudgmentRow;

const TRIAL_JSON = ['expectations', 'tasks', 'knowledge', 'human', 'verdict', 'commits'];

export type NewTrial = Pick<TrialRow, 'draft_id' | 'role_id' | 'expectations' | 'tasks' | 'knowledge' | 'cap_usd'> & {
  results: Pick<ResultRow, 'attempt_id' | 'arm' | 'state' | 'output' | 'measured' | 'fingerprint'>[];
  judgments: Pick<JudgmentRow, 'attempt_id' | 'judge'>[];
};

// Drafts and trials keep to their own tables. Nothing here writes a row a project's own flow reads.
export class TrialStore {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createDraft(draft: Pick<DraftRow, 'role_id' | 'title'>): Promise<DraftRow> {
    const at = this.now().toISOString();
    const row = await this.db.insertInto('drafts').values({ ...draft, project_id: null, state: 'open', created_at: at, updated_at: at }).returningAll().executeTakeFirstOrThrow();
    return toDraft(row);
  }

  async getDraft(id: number): Promise<DraftRow | undefined> {
    const row = await this.db.selectFrom('drafts').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toDraft(row);
  }

  async openDraft(roleId: string): Promise<DraftRow | undefined> {
    const row = await this.db.selectFrom('drafts').selectAll().where('role_id', '=', roleId).where('state', '=', 'open').executeTakeFirst();
    return row && toDraft(row);
  }

  async patchDraft(id: number, patch: Partial<Pick<DraftRow, 'project_id' | 'title' | 'state' | 'base'>>): Promise<DraftRow> {
    const row = await this.db.updateTable('drafts').set({ ...columns(patch, ['base']), updated_at: this.now().toISOString() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return toDraft(row);
  }

  // A trial begins with every result and judgment it will need, so what is left to do is always a question of rows.
  async createTrial({ results, judgments, ...trial }: NewTrial): Promise<TrialRow> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('trials')
        .values({ ...(columns(trial, TRIAL_JSON) as Pick<Selectable<TrialsTable>, 'draft_id' | 'role_id' | 'expectations' | 'tasks' | 'knowledge' | 'cap_usd'>), state: 'running', created_at: this.now().toISOString() })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (const result of results) {
        await trx
          .insertInto('trial_results')
          .values({ trial_id: row.id, attempt_id: result.attempt_id, arm: result.arm, state: result.state, output: result.output === null ? null : JSON.stringify(result.output), measured: result.measured === null ? null : JSON.stringify(result.measured), fingerprint: result.fingerprint })
          .execute();
      }
      for (const judgment of judgments) await trx.insertInto('trial_judgments').values({ trial_id: row.id, ...judgment, state: 'pending' }).execute();
      return toTrial(row);
    });
  }

  async getTrial(id: number): Promise<TrialRow | undefined> {
    const row = await this.db.selectFrom('trials').selectAll().where('id', '=', id).executeTakeFirst();
    return row && toTrial(row);
  }

  async listTrials(where: { draftId?: number; roleId?: string; states?: TrialRow['state'][] } = {}): Promise<TrialRow[]> {
    let query = this.db.selectFrom('trials').selectAll().orderBy('id');
    if (where.draftId !== undefined) query = query.where('draft_id', '=', where.draftId);
    if (where.roleId !== undefined) query = query.where('role_id', '=', where.roleId);
    if (where.states !== undefined) query = query.where('state', 'in', where.states);
    return (await query.execute()).map(toTrial);
  }

  async patchTrial(id: number, patch: Partial<Pick<TrialRow, 'state' | 'stop_reason' | 'cap_usd' | 'human' | 'verdict' | 'commits' | 'ended_at'>>): Promise<TrialRow> {
    const row = await this.db.updateTable('trials').set(columns(patch, TRIAL_JSON)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return toTrial(row);
  }

  async addSpend(id: number, usd: number): Promise<TrialRow> {
    const row = await this.db.updateTable('trials').set((eb) => ({ spent_usd: eb('spent_usd', '+', usd) })).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return toTrial(row);
  }

  async listResults(trialId: number): Promise<ResultRow[]> {
    return (await this.db.selectFrom('trial_results').selectAll().where('trial_id', '=', trialId).orderBy('id').execute()).map(toResult);
  }

  async patchResult(id: number, patch: Partial<Pick<ResultRow, 'state' | 'output' | 'measured' | 'fingerprint' | 'error'>>): Promise<ResultRow> {
    const row = await this.db.updateTable('trial_results').set(columns(patch, ['output', 'measured'])).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return toResult(row);
  }

  async listJudgments(trialId: number): Promise<JudgmentRow[]> {
    return (await this.db.selectFrom('trial_judgments').selectAll().where('trial_id', '=', trialId).orderBy('id').execute()).map(toJudgment);
  }

  async patchJudgment(id: number, patch: Partial<Pick<JudgmentRow, 'state' | 'answers' | 'error'>>): Promise<JudgmentRow> {
    const row = await this.db.updateTable('trial_judgments').set(columns(patch, ['answers'])).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    return toJudgment(row);
  }

  // What a daemon that died left half done is done again from the start.
  async requeueRunning(): Promise<void> {
    await this.db.updateTable('trial_results').set({ state: 'pending' }).where('state', '=', 'running').execute();
    await this.db.updateTable('trial_judgments').set({ state: 'pending' }).where('state', '=', 'running').execute();
  }
}
