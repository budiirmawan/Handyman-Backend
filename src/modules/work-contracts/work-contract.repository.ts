import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewWorkContract,
  UpdateWorkContractInput,
  WorkContractFilters,
  WorkContractRecord,
  WorkContractStatus,
} from './work-contract.types';

const SELECT = `
  id, client_id AS "clientId", building_id AS "buildingId",
  vendor_id AS "vendorId", purchase_order_id AS "purchaseOrderId",
  spk_number AS "spkNumber", spk_date::text AS "spkDate",
  title, scope_description AS "scopeDescription",
  start_date::text AS "startDate", end_date::text AS "endDate",
  notes, status, created_by_user_id AS "createdByUserId",
  activated_at AS "activatedAt", activated_by_user_id AS "activatedByUserId",
  completed_at AS "completedAt", completed_by_user_id AS "completedByUserId",
  cancelled_at AS "cancelledAt", cancelled_by_user_id AS "cancelledByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

type HistoryAction =
  | 'CREATED'
  | 'UPDATED'
  | 'ACTIVATED'
  | 'COMPLETED'
  | 'CANCELLED';

/** Append-only audit trail; mirrors purchase_order_history (0269). */
async function appendHistory(
  client: PoolClient,
  record: WorkContractRecord,
  action: HistoryAction,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO work_contract_history
       (id, work_contract_id, action, spk_date, title, scope_description,
        start_date, end_date, status, notes, changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      randomUUID(),
      record.id,
      action,
      record.spkDate,
      record.title,
      record.scopeDescription,
      record.startDate,
      record.endDate,
      record.status,
      record.notes,
      actor,
    ],
  );
}

async function selectById(
  client: PoolClient,
  id: string,
): Promise<WorkContractRecord | null> {
  const result = await client.query<WorkContractRecord>(
    `SELECT ${SELECT} FROM work_contracts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function create(input: NewWorkContract): Promise<WorkContractRecord> {
  return withTransaction(async (client) => {
    const result = await client.query<WorkContractRecord>(
      `INSERT INTO work_contracts
         (id, client_id, building_id, vendor_id, purchase_order_id,
          spk_number, spk_date, title, scope_description, start_date,
          end_date, notes, status, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${SELECT}`,
      [
        randomUUID(),
        input.clientId,
        input.buildingId,
        input.vendorId,
        input.purchaseOrderId,
        input.spkNumber,
        input.spkDate,
        input.title,
        input.scopeDescription,
        input.startDate,
        input.endDate,
        input.notes,
        input.status,
        input.createdByUserId,
      ],
    );
    await appendHistory(
      client,
      result.rows[0],
      'CREATED',
      input.createdByUserId,
    );
    return result.rows[0];
  });
}

async function findById(id: string): Promise<WorkContractRecord | null> {
  const result = await getPool().query<WorkContractRecord>(
    `SELECT ${SELECT} FROM work_contracts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Finds the live (DRAFT or ACTIVE) SPK occupying a Purchase Order, if any.
 * Mirrors the `work_contracts_po_live_unique` partial index so the service
 * can fail fast with a deterministic error before hitting the constraint.
 */
async function findLiveByPurchaseOrder(
  purchaseOrderId: string,
): Promise<WorkContractRecord | null> {
  const result = await getPool().query<WorkContractRecord>(
    `SELECT ${SELECT} FROM work_contracts
     WHERE purchase_order_id = $1 AND status IN ('DRAFT', 'ACTIVE')`,
    [purchaseOrderId],
  );
  return result.rows[0] ?? null;
}

/** Scoped list: never returns rows outside the accessible Building set. */
async function list(
  filters: WorkContractFilters,
  buildingIds: string[],
): Promise<WorkContractRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];

  const exact: [keyof WorkContractFilters, string][] = [
    ['purchaseOrderId', 'purchase_order_id'],
    ['vendorId', 'vendor_id'],
    ['buildingId', 'building_id'],
    ['status', 'status'],
  ];
  for (const [key, column] of exact) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  if (filters.spkDateFrom) {
    values.push(filters.spkDateFrom);
    clauses.push(`spk_date >= $${values.length}::date`);
  }
  if (filters.spkDateTo) {
    values.push(filters.spkDateTo);
    clauses.push(`spk_date <= $${values.length}::date`);
  }

  const result = await getPool().query<WorkContractRecord>(
    `SELECT ${SELECT} FROM work_contracts
     WHERE ${clauses.join(' AND ')}
     ORDER BY spk_date DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

/** DRAFT-only update; the status guard lives in the WHERE clause. */
async function update(
  id: string,
  input: UpdateWorkContractInput,
  actor: string,
): Promise<WorkContractRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];
    const fields: [keyof UpdateWorkContractInput, string][] = [
      ['spkDate', 'spk_date'],
      ['title', 'title'],
      ['scopeDescription', 'scope_description'],
      ['startDate', 'start_date'],
      ['endDate', 'end_date'],
      ['notes', 'notes'],
    ];
    for (const [key, column] of fields) {
      if (input[key] !== undefined) {
        values.push(input[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return selectById(client, id);

    values.push(id);
    sets.push('updated_at = NOW()');
    const result = await client.query<WorkContractRecord>(
      `UPDATE work_contracts SET ${sets.join(', ')}
       WHERE id = $${values.length} AND status = 'DRAFT'
       RETURNING ${SELECT}`,
      values,
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'UPDATED', actor);
    return record;
  });
}

/**
 * Applies a lifecycle transition.
 *
 * The expected source status lives in the WHERE clause, so the transition is
 * atomic: two concurrent commands cannot both succeed, and a contract that
 * has moved on simply matches no row (returns null). Each target state stamps
 * its own provenance columns, satisfying
 * `work_contracts_status_provenance_check`.
 */
async function transition(
  id: string,
  from: WorkContractStatus,
  to: Exclude<WorkContractStatus, 'DRAFT'>,
  actor: string,
): Promise<WorkContractRecord | null> {
  const stamp: Record<typeof to, string> = {
    ACTIVE: 'activated_at = NOW(), activated_by_user_id = $3',
    COMPLETED: 'completed_at = NOW(), completed_by_user_id = $3',
    CANCELLED: 'cancelled_at = NOW(), cancelled_by_user_id = $3',
  };
  const action: Record<typeof to, HistoryAction> = {
    ACTIVE: 'ACTIVATED',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
  };

  return withTransaction(async (client) => {
    const result = await client.query<WorkContractRecord>(
      `UPDATE work_contracts
       SET status = $4, ${stamp[to]}, updated_at = NOW()
       WHERE id = $1 AND status = $2
       RETURNING ${SELECT}`,
      [id, from, actor, to],
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, action[to], actor);
    return record;
  });
}

export const workContractRepository = {
  create,
  findById,
  findLiveByPurchaseOrder,
  list,
  transition,
  update,
};
