import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewTenantCharge,
  TenantChargeFilters,
  TenantChargeRecord,
  UpdateTenantChargeInput,
} from './tenant-charge.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", building_id AS "buildingId",
  space_id AS "spaceId", charge_type AS "chargeType", description,
  amount::text AS amount, currency_code AS "currencyCode",
  charge_date::text AS "chargeDate",
  due_date::text AS "dueDate", status, reference, notes,
  created_by_user_id AS "createdByUserId", cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

type ChargeHistoryAction = 'CREATED' | 'UPDATED' | 'CANCELLED';

async function appendHistory(
  client: PoolClient,
  record: TenantChargeRecord,
  action: ChargeHistoryAction,
  actorUserId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO tenant_charge_history
       (id, tenant_charge_id, action, charge_type, description, amount,
        currency_code, charge_date, due_date, status, reference, notes,
        changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), record.id, action, record.chargeType, record.description,
      record.amount, record.currencyCode, record.chargeDate, record.dueDate,
      record.status, record.reference, record.notes, actorUserId],
  );
}

async function create(input: NewTenantCharge): Promise<TenantChargeRecord> {
  return withTransaction(async (client) => {
    const result = await client.query<TenantChargeRecord>(
      `INSERT INTO tenant_charges
         (id, client_id, tenant_company_id, building_id, space_id, charge_type,
          description, amount, currency_code, charge_date, due_date,
          reference, notes, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${SELECT}`,
      [randomUUID(), input.clientId, input.tenantCompanyId, input.buildingId,
        input.spaceId, input.chargeType, input.description, input.amount,
        input.currencyCode, input.chargeDate, input.dueDate, input.reference,
        input.notes, input.createdByUserId],
    );
    const record = result.rows[0];
    await appendHistory(client, record, 'CREATED', input.createdByUserId);
    return record;
  });
}

async function findById(id: string): Promise<TenantChargeRecord | null> {
  const result = await getPool().query<TenantChargeRecord>(
    `SELECT ${SELECT} FROM tenant_charges WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: TenantChargeFilters,
  accessibleBuildingIds: string[],
): Promise<TenantChargeRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];
  const exact: [keyof TenantChargeFilters, string][] = [
    ['tenantCompanyId', 'tenant_company_id'],
    ['buildingId', 'building_id'],
    ['spaceId', 'space_id'],
    ['chargeType', 'charge_type'],
    ['status', 'status'],
  ];
  for (const [key, column] of exact) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  if (filters.chargeDateFrom) {
    values.push(filters.chargeDateFrom);
    clauses.push(`charge_date >= $${values.length}::date`);
  }
  if (filters.chargeDateTo) {
    values.push(filters.chargeDateTo);
    clauses.push(`charge_date <= $${values.length}::date`);
  }
  const result = await getPool().query<TenantChargeRecord>(
    `SELECT ${SELECT} FROM tenant_charges
     WHERE ${clauses.join(' AND ')}
     ORDER BY charge_date DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateTenantChargeInput,
  actorUserId: string,
): Promise<TenantChargeRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];
    const fields: [keyof UpdateTenantChargeInput, string][] = [
      ['chargeType', 'charge_type'], ['description', 'description'],
      ['amount', 'amount'], ['currencyCode', 'currency_code'],
      ['chargeDate', 'charge_date'], ['dueDate', 'due_date'],
      ['reference', 'reference'], ['notes', 'notes'],
    ];
    for (const [key, column] of fields) {
      if (input[key] !== undefined) {
        values.push(input[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) {
      const current = await client.query<TenantChargeRecord>(
        `SELECT ${SELECT} FROM tenant_charges WHERE id = $1`, [id],
      );
      return current.rows[0] ?? null;
    }
    values.push(id);
    sets.push('updated_at = NOW()');
    const result = await client.query<TenantChargeRecord>(
      `UPDATE tenant_charges SET ${sets.join(', ')}
       WHERE id = $${values.length} AND status = 'ACTIVE'
       RETURNING ${SELECT}`,
      values,
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'UPDATED', actorUserId);
    return record;
  });
}

async function cancel(
  id: string,
  actorUserId: string,
  cancellationNote: string | null,
): Promise<TenantChargeRecord | null> {
  return withTransaction(async (client) => {
    const result = await client.query<TenantChargeRecord>(
      `UPDATE tenant_charges
       SET status = 'CANCELLED', cancelled_at = NOW(),
           cancelled_by_user_id = $2,
           notes = CASE WHEN $3::text IS NULL THEN notes ELSE $3 END,
           updated_at = NOW()
       WHERE id = $1 AND status = 'ACTIVE'
       RETURNING ${SELECT}`,
      [id, actorUserId, cancellationNote],
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'CANCELLED', actorUserId);
    return record;
  });
}

export const tenantChargeRepository = { cancel, create, findById, list, update };
