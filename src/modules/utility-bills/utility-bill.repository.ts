import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewUtilityBill,
  UtilityBillFilters,
  UtilityBillRecord,
  UtilityBillStatus,
  UpdateUtilityBillInput,
} from './utility-bill.types';

const SELECT = `ub.id, ub.client_id AS "clientId",
  ub.tenant_company_id AS "tenantCompanyId", ub.building_id AS "buildingId",
  ub.meter_id AS "meterId", ub.tenant_assignment_id AS "tenantAssignmentId",
  ub.calculation_id AS "calculationId", ub.approval_id AS "approvalId",
  ub.space_id AS "spaceId", uc.consumption_id AS "consumptionId",
  ub.utility_type AS "utilityType", ub.period_start AS "periodStart",
  ub.period_end AS "periodEnd", uc.calculated_amount::text AS "calculatedUtilityValue",
  ub.bill_amount::text AS "billAmount",
  ub.consumption_quantity::text AS "consumptionQuantity", ub.uom_id AS "uomId",
  ub.tariff_rate::text AS "tariffRate", ub.currency,
  ub.due_date::text AS "dueDate",
  ub.status, ub.generated_by_user_id AS "generatedByUserId",
  ub.created_at AS "createdAt", ub.updated_at AS "updatedAt"`;
const FROM = `utility_bills ub
  JOIN utility_calculations uc ON uc.id = ub.calculation_id`;

async function selectById(client: PoolClient, id: string): Promise<UtilityBillRecord | null> {
  const result = await client.query<UtilityBillRecord>(
    `SELECT ${SELECT} FROM ${FROM} WHERE ub.id = $1`, [id],
  );
  return result.rows[0] ?? null;
}
async function create(input: NewUtilityBill): Promise<UtilityBillRecord> {
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO utility_bills
         (id, client_id, tenant_company_id, building_id, meter_id,
          tenant_assignment_id, calculation_id, approval_id, space_id,
          consumption_quantity, uom_id, tariff_rate, currency, utility_type,
          period_start, period_end, bill_amount, due_date, generated_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [randomUUID(), input.clientId, input.tenantCompanyId, input.buildingId,
        input.meterId, input.tenantAssignmentId, input.calculationId,
        input.approvalId, input.spaceId, input.consumptionQuantity, input.uomId,
        input.tariffRate, input.currency, input.utilityType, input.periodStart,
        input.periodEnd, input.billAmount, input.dueDate, input.generatedByUserId],
    );
    const record = await selectById(client, inserted.rows[0].id);
    if (!record) throw new Error('Created Utility bill could not be loaded.');
    await client.query(
      `INSERT INTO utility_bill_history
         (id, utility_bill_id, action, bill_amount, due_date, status, changed_by_user_id)
       VALUES ($1,$2,'CREATED',$3,$4,$5,$6)`,
      [randomUUID(), record.id, record.billAmount, record.dueDate,
        record.status, input.generatedByUserId],
    );
    return record;
  });
}

async function findById(id: string): Promise<UtilityBillRecord | null> {
  const result = await getPool().query<UtilityBillRecord>(
    `SELECT ${SELECT} FROM ${FROM} WHERE ub.id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findByContextPeriod(input: {
  tenantCompanyId: string;
  meterId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<UtilityBillRecord | null> {
  const result = await getPool().query<UtilityBillRecord>(
    `SELECT ${SELECT} FROM ${FROM}
     WHERE ub.tenant_company_id = $1 AND ub.meter_id = $2
       AND ub.period_start = $3 AND ub.period_end = $4`,
    [input.tenantCompanyId, input.meterId, input.periodStart, input.periodEnd],
  );
  return result.rows[0] ?? null;
}

async function list(filters: UtilityBillFilters, buildingIds: string[]): Promise<UtilityBillRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['ub.building_id = ANY($1::uuid[])'];
  const exact: [keyof UtilityBillFilters, string][] = [
    ['tenantCompanyId', 'ub.tenant_company_id'],
    ['buildingId', 'ub.building_id'],
    ['utilityType', 'ub.utility_type'],
    ['status', 'ub.status'],
  ];
  for (const [key, column] of exact) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  if (filters.periodFrom) {
    values.push(filters.periodFrom);
    clauses.push(`ub.period_start >= $${values.length}`);
  }
  if (filters.periodTo) {
    values.push(filters.periodTo);
    clauses.push(`ub.period_end <= $${values.length}`);
  }
  const result = await getPool().query<UtilityBillRecord>(
    `SELECT ${SELECT} FROM ${FROM}
     WHERE ${clauses.join(' AND ')}
     ORDER BY ub.period_end DESC, ub.created_at DESC`, values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateUtilityBillInput,
  expectedStatus: UtilityBillStatus,
  actorUserId: string,
): Promise<UtilityBillRecord | null> {
  return withTransaction(async (client) => {
    const values: unknown[] = [];
    const sets: string[] = [];
    if (input.dueDate !== undefined) {
      values.push(input.dueDate);
      sets.push(`due_date = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      sets.push(`status = $${values.length}`);
    }
    if (sets.length === 0) return selectById(client, id);
    values.push(id, expectedStatus);
    sets.push('updated_at = NOW()');
    const updated = await client.query<{ id: string }>(
      `UPDATE utility_bills SET ${sets.join(', ')}
       WHERE id = $${values.length - 1} AND status = $${values.length}
       RETURNING id`, values,
    );
    if (!updated.rows[0]) return null;
    const record = await selectById(client, id);
    if (!record) return null;
    await client.query(
      `INSERT INTO utility_bill_history
         (id, utility_bill_id, action, bill_amount, due_date, status, changed_by_user_id)
       VALUES ($1,$2,'UPDATED',$3,$4,$5,$6)`,
      [randomUUID(), record.id, record.billAmount, record.dueDate,
        record.status, actorUserId],
    );
    return record;
  });
}

export const utilityBillRepository = {
  create,
  findByContextPeriod,
  findById,
  list,
  update,
};
