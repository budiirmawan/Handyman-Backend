import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewServiceChargeReadiness,
  ServiceChargeReadinessFilters,
  ServiceChargeReadinessRecord,
  UpdateServiceChargeReadinessInput,
} from './service-charge-readiness.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", building_id AS "buildingId",
  space_id AS "spaceId", service_charge_type AS "serviceChargeType",
  charge_basis AS "chargeBasis", tenant_charge_id AS "tenantChargeId",
  effective_from::text AS "effectiveFrom", effective_to::text AS "effectiveTo",
  readiness_status AS "readinessStatus", notes,
  evaluated_by_user_id AS "evaluatedByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

type Action = 'CREATED' | 'UPDATED';
async function appendHistory(
  client: PoolClient,
  record: ServiceChargeReadinessRecord,
  action: Action,
  actorUserId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO service_charge_readiness_history
       (id, service_charge_readiness_id, action, service_charge_type,
        charge_basis, tenant_charge_id, effective_from, effective_to,
        readiness_status, notes, changed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), record.id, action, record.serviceChargeType,
      record.chargeBasis, record.tenantChargeId, record.effectiveFrom,
      record.effectiveTo, record.readinessStatus, record.notes, actorUserId],
  );
}

async function create(input: NewServiceChargeReadiness): Promise<ServiceChargeReadinessRecord> {
  return withTransaction(async (client) => {
    const result = await client.query<ServiceChargeReadinessRecord>(
      `INSERT INTO service_charge_readiness
         (id, client_id, tenant_company_id, building_id, space_id,
          service_charge_type, charge_basis, tenant_charge_id, effective_from,
          effective_to, readiness_status, notes, evaluated_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${SELECT}`,
      [randomUUID(), input.clientId, input.tenantCompanyId, input.buildingId,
        input.spaceId, input.serviceChargeType, input.chargeBasis,
        input.tenantChargeId, input.effectiveFrom, input.effectiveTo,
        input.readinessStatus, input.notes, input.evaluatedByUserId],
    );
    const record = result.rows[0];
    await appendHistory(client, record, 'CREATED', input.evaluatedByUserId);
    return record;
  });
}
async function findById(id: string): Promise<ServiceChargeReadinessRecord | null> {
  const result = await getPool().query<ServiceChargeReadinessRecord>(
    `SELECT ${SELECT} FROM service_charge_readiness WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}
async function list(
  filters: ServiceChargeReadinessFilters,
  buildingIds: string[],
): Promise<ServiceChargeReadinessRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id = ANY($1::uuid[])'];
  const exact: [keyof ServiceChargeReadinessFilters, string][] = [
    ['tenantCompanyId', 'tenant_company_id'],
    ['buildingId', 'building_id'],
    ['status', 'readiness_status'],
  ];
  for (const [key, column] of exact) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  if (filters.periodFrom) {
    values.push(filters.periodFrom);
    clauses.push(`effective_from >= $${values.length}::date`);
  }
  if (filters.periodTo) {
    values.push(filters.periodTo);
    clauses.push(`effective_to <= $${values.length}::date`);
  }
  const result = await getPool().query<ServiceChargeReadinessRecord>(
    `SELECT ${SELECT} FROM service_charge_readiness
     WHERE ${clauses.join(' AND ')}
     ORDER BY effective_from DESC, created_at DESC`, values,
  );
  return result.rows;
}
async function update(
  id: string,
  input: UpdateServiceChargeReadinessInput,
  actorUserId: string,
): Promise<ServiceChargeReadinessRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];
    const fields: [keyof UpdateServiceChargeReadinessInput, string][] = [
      ['serviceChargeType', 'service_charge_type'],
      ['chargeBasis', 'charge_basis'], ['tenantChargeId', 'tenant_charge_id'],
      ['effectiveFrom', 'effective_from'], ['effectiveTo', 'effective_to'],
      ['readinessStatus', 'readiness_status'], ['notes', 'notes'],
    ];
    for (const [key, column] of fields) {
      if (input[key] !== undefined) {
        values.push(input[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return findById(id);
    values.push(id);
    sets.push('updated_at = NOW()');
    const result = await client.query<ServiceChargeReadinessRecord>(
      `UPDATE service_charge_readiness SET ${sets.join(', ')}
       WHERE id = $${values.length} RETURNING ${SELECT}`, values,
    );
    const record = result.rows[0] ?? null;
    if (record) await appendHistory(client, record, 'UPDATED', actorUserId);
    return record;
  });
}
export const serviceChargeReadinessRepository = { create, findById, list, update };
