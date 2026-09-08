import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityCalculation,
  NewUtilityCalculationBasis,
  UtilityCalculationBasisFilters,
  UtilityCalculationBasisRecord,
  UtilityCalculationFilters,
  UtilityCalculationRecord,
  UtilityCalculationScope,
} from './utility-calculation.types';

/**
 * BE-18I — Utility Calculation persistence.
 *
 * History-preserving: a result is never edited in place except for the two
 * transitions that are themselves history — DRAFT → FINALIZED (freezing it)
 * and DRAFT → SUPERSEDED (retiring it in favour of a successor row). There is
 * no delete, and no path that rewrites an amount.
 *
 * No consumption value is stored or copied — only `consumption_id`. All
 * queries are scoped at the database level (`meter_id`, `building_id`,
 * `tenant_company_id`, or `client_id` in the WHERE clause) rather than
 * filtered in memory after a global fetch, per docs/data-isolation.md.
 */

const BASIS_SELECT = `
  id,
  client_id AS "clientId",
  utility_type AS "utilityType",
  name,
  description,
  uom_id AS "uomId",
  rate_value AS "rateValue",
  rate_label AS "rateLabel",
  effective_from AS "effectiveFrom",
  effective_to AS "effectiveTo",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const CALCULATION_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  meter_id AS "meterId",
  utility_type AS "utilityType",
  consumption_id AS "consumptionId",
  calculation_basis_id AS "calculationBasisId",
  consumption_quantity::text AS "consumptionQuantity",
  tariff_id AS "tariffId",
  tariff_rate::text AS "tariffRate",
  currency,
  applied_rate_value::text AS "appliedRateValue",
  calculated_amount::text AS "calculatedAmount",
  uom_id AS "uomId",
  period_start AS "periodStart",
  period_end AS "periodEnd",
  status,
  calculated_at AS "calculatedAt",
  calculated_by_user_id AS "calculatedByUserId",
  finalized_at AS "finalizedAt",
  finalized_by_user_id AS "finalizedByUserId",
  supersedes_calculation_id AS "supersedesCalculationId",
  tenant_assignment_id AS "tenantAssignmentId",
  tenant_company_id AS "tenantCompanyId",
  notes,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/* -------------------------------------------------------------------------
 * Calculation basis
 * ---------------------------------------------------------------------- */

async function createBasis(
  input: NewUtilityCalculationBasis,
): Promise<UtilityCalculationBasisRecord> {
  const result = await getPool().query<UtilityCalculationBasisRecord>(
    `INSERT INTO utility_calculation_bases
       (id, client_id, utility_type, name, description, uom_id, rate_value,
        rate_label, effective_from, effective_to, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${BASIS_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.utilityType,
      input.name,
      input.description,
      input.uomId,
      input.rateValue,
      input.rateLabel,
      input.effectiveFrom,
      input.effectiveTo,
      input.status,
    ],
  );
  return result.rows[0];
}

async function findBasisById(
  id: string,
): Promise<UtilityCalculationBasisRecord | null> {
  const result = await getPool().query<UtilityCalculationBasisRecord>(
    `SELECT ${BASIS_SELECT} FROM utility_calculation_bases
     WHERE id = $1 AND building_id IS NULL`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolves the ACTIVE basis for a (Client, utility type) whose effective
 * window covers the whole consumption period. The window must cover the
 * period end as well as its start — a rate that expires mid-period cannot
 * describe the whole of it. Newest effective_from wins when several qualify.
 */
async function findApplicableBasis(
  clientId: string,
  utilityType: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<UtilityCalculationBasisRecord | null> {
  const result = await getPool().query<UtilityCalculationBasisRecord>(
    `SELECT ${BASIS_SELECT} FROM utility_calculation_bases
     WHERE client_id = $1
       AND building_id IS NULL
       AND utility_type = $2
       AND status = 'ACTIVE'
       AND effective_from <= $3
       AND (effective_to IS NULL OR effective_to >= $4)
     ORDER BY effective_from DESC
     LIMIT 1`,
    [clientId, utilityType, periodStart, periodEnd],
  );
  return result.rows[0] ?? null;
}

async function listBasesByClient(
  clientId: string,
  filters: UtilityCalculationBasisFilters = {},
): Promise<UtilityCalculationBasisRecord[]> {
  const conditions = ['client_id = $1', 'building_id IS NULL'];
  const values: unknown[] = [clientId];
  let index = 2;

  if (filters.utilityType) {
    conditions.push(`utility_type = $${index++}`);
    values.push(filters.utilityType);
  }
  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }

  const result = await getPool().query<UtilityCalculationBasisRecord>(
    `SELECT ${BASIS_SELECT} FROM utility_calculation_bases
     WHERE ${conditions.join(' AND ')}
     ORDER BY utility_type ASC, effective_from DESC`,
    values,
  );
  return result.rows;
}

/* -------------------------------------------------------------------------
 * Calculation
 * ---------------------------------------------------------------------- */

async function create(
  input: NewUtilityCalculation,
): Promise<UtilityCalculationRecord> {
  const result = await getPool().query<UtilityCalculationRecord>(
    `INSERT INTO utility_calculations
       (id, client_id, building_id, meter_id, utility_type, consumption_id,
        calculation_basis_id, consumption_quantity, tariff_id, tariff_rate,
        currency, applied_rate_value, calculated_amount, uom_id,
        period_start, period_end, status, calculated_by_user_id,
        supersedes_calculation_id, tenant_assignment_id, tenant_company_id,
        notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10::numeric,
             $11, $12::numeric, $8::numeric * $12::numeric, $13, $14, $15,
             $16, $17, $18, $19, $20, $21)
     RETURNING ${CALCULATION_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.meterId,
      input.utilityType,
      input.consumptionId,
      input.calculationBasisId,
      input.consumptionQuantity,
      input.tariffId,
      input.tariffRate,
      input.currency,
      input.appliedRateValue,
      input.uomId,
      input.periodStart,
      input.periodEnd,
      input.status,
      input.calculatedByUserId,
      input.supersedesCalculationId,
      input.tenantAssignmentId,
      input.tenantCompanyId,
      input.notes,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<UtilityCalculationRecord | null> {
  const result = await getPool().query<UtilityCalculationRecord>(
    `SELECT ${CALCULATION_SELECT} FROM utility_calculations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** The live (DRAFT or FINALIZED) result for a consumption, if any. */
async function findLiveByConsumption(
  consumptionId: string,
): Promise<UtilityCalculationRecord | null> {
  const result = await getPool().query<UtilityCalculationRecord>(
    `SELECT ${CALCULATION_SELECT} FROM utility_calculations
     WHERE consumption_id = $1 AND status <> 'SUPERSEDED'`,
    [consumptionId],
  );
  return result.rows[0] ?? null;
}

/** Full calculation history for one consumption, newest first. */
async function listByConsumption(
  consumptionId: string,
): Promise<UtilityCalculationRecord[]> {
  const result = await getPool().query<UtilityCalculationRecord>(
    `SELECT ${CALCULATION_SELECT} FROM utility_calculations
     WHERE consumption_id = $1
     ORDER BY calculated_at DESC`,
    [consumptionId],
  );
  return result.rows;
}

/**
 * Shared filter builder. `scope` anchors the query to one authoritative
 * column so a listing can never accidentally span clients or buildings.
 *
 * Period filters select calculations whose period falls inside the requested
 * window: `from` bounds `period_start`, `to` bounds `period_end`.
 *
 * `buildingIds` further restricts the result to the caller's accessible
 * Buildings — applied in SQL, never after the fetch. `null` means
 * unrestricted; an empty array means no access at all.
 */
function buildQuery(
  scope: UtilityCalculationScope,
  filters: UtilityCalculationFilters,
  buildingIds: readonly string[] | null,
): { text: string; values: unknown[] } | null {
  const conditions = [`${scope.column} = $1`];
  const values: unknown[] = [scope.value];
  let index = 2;

  if (filters.meterId && scope.column !== 'meter_id') {
    conditions.push(`meter_id = $${index++}`);
    values.push(filters.meterId);
  }
  if (filters.tenantCompanyId && scope.column !== 'tenant_company_id') {
    conditions.push(`tenant_company_id = $${index++}`);
    values.push(filters.tenantCompanyId);
  }
  if (filters.buildingId && scope.column !== 'building_id') {
    conditions.push(`building_id = $${index++}`);
    values.push(filters.buildingId);
  }
  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }
  if (filters.utilityType) {
    conditions.push(`utility_type = $${index++}`);
    values.push(filters.utilityType);
  }
  if (filters.from) {
    conditions.push(`period_start >= $${index++}`);
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`period_end <= $${index++}`);
    values.push(filters.to);
  }
  if (buildingIds !== null) {
    if (buildingIds.length === 0) {
      return null;
    }
    conditions.push(`building_id = ANY($${index++}::uuid[])`);
    values.push([...buildingIds]);
  }

  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  values.push(limit);

  return {
    text: `SELECT ${CALCULATION_SELECT} FROM utility_calculations
           WHERE ${conditions.join(' AND ')}
           ORDER BY period_end DESC, calculated_at DESC
           LIMIT $${index}`,
    values,
  };
}

async function listByScope(
  scope: UtilityCalculationScope,
  filters: UtilityCalculationFilters = {},
  buildingIds: readonly string[] | null = null,
): Promise<UtilityCalculationRecord[]> {
  const query = buildQuery(scope, filters, buildingIds);
  if (!query) {
    return [];
  }
  const result = await getPool().query<UtilityCalculationRecord>(
    query.text,
    query.values,
  );
  return result.rows;
}

/**
 * Marks a DRAFT result as SUPERSEDED. Guarded on the current status so a
 * FINALIZED row can never be retired by a concurrent recalculation, even if
 * the service-level check passed a moment earlier.
 */
async function markSuperseded(
  id: string,
): Promise<UtilityCalculationRecord | null> {
  const result = await getPool().query<UtilityCalculationRecord>(
    `UPDATE utility_calculations
     SET status = 'SUPERSEDED', updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${CALCULATION_SELECT}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Freezes a DRAFT result. Guarded on the current status, so finalizing is
 * idempotent-safe under a race: the second writer gets null, never a silent
 * overwrite of the first finalization's stamps.
 */
async function markFinalized(
  id: string,
  finalizedByUserId: string | null,
): Promise<UtilityCalculationRecord | null> {
  const result = await getPool().query<UtilityCalculationRecord>(
    `UPDATE utility_calculations
     SET status = 'FINALIZED',
         finalized_at = NOW(),
         finalized_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${CALCULATION_SELECT}`,
    [id, finalizedByUserId],
  );
  return result.rows[0] ?? null;
}

export const utilityCalculationRepository = {
  create,
  createBasis,
  findApplicableBasis,
  findBasisById,
  findById,
  findLiveByConsumption,
  listBasesByClient,
  listByConsumption,
  listByScope,
  markFinalized,
  markSuperseded,
};
