import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUtilityAbnormalConsumption,
  NewUtilityAbnormalityRule,
  UtilityAbnormalConsumptionFilters,
  UtilityAbnormalConsumptionRecord,
  UtilityAbnormalConsumptionScope,
  UtilityAbnormalityRuleFilters,
  UtilityAbnormalityRuleRecord,
} from './utility-abnormal-consumption.types';

/**
 * BE-18J — Abnormal Consumption persistence.
 *
 * Writes only to this module's own two tables. No statement here touches
 * `utility_meter_readings`, `utility_meter_consumptions` or
 * `utility_calculations` — detection observes upstream data, it never alters
 * it. There is no update path for a detected value either: a flag records
 * what was seen, and only its status can move (OPEN → RESOLVED / DISMISSED).
 *
 * All queries are scoped at the database level (`meter_id`, `building_id`,
 * `tenant_company_id`, or `client_id` in the WHERE clause) rather than
 * filtered in memory after a global fetch, per docs/data-isolation.md.
 */

const RULE_SELECT = `
  id,
  client_id AS "clientId",
  utility_type AS "utilityType",
  abnormality_type AS "abnormalityType",
  name,
  description,
  threshold_value AS "thresholdValue",
  comparison_mode AS "comparisonMode",
  baseline_window AS "baselineWindow",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const ABNORMAL_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  meter_id AS "meterId",
  utility_type AS "utilityType",
  consumption_id AS "consumptionId",
  rule_id AS "ruleId",
  abnormality_type AS "abnormalityType",
  comparison_mode AS "comparisonMode",
  detected_value AS "detectedValue",
  reference_value AS "referenceValue",
  threshold_value AS "thresholdValue",
  uom_id AS "uomId",
  period_start AS "periodStart",
  period_end AS "periodEnd",
  detected_at AS "detectedAt",
  detected_by_user_id AS "detectedByUserId",
  status,
  resolved_at AS "resolvedAt",
  resolved_by_user_id AS "resolvedByUserId",
  resolution_notes AS "resolutionNotes",
  finding_id AS "findingId",
  tenant_assignment_id AS "tenantAssignmentId",
  tenant_company_id AS "tenantCompanyId",
  notes,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/* -------------------------------------------------------------------------
 * Detection rules
 * ---------------------------------------------------------------------- */

async function createRule(
  input: NewUtilityAbnormalityRule,
): Promise<UtilityAbnormalityRuleRecord> {
  const result = await getPool().query<UtilityAbnormalityRuleRecord>(
    `INSERT INTO utility_abnormality_rules
       (id, client_id, utility_type, abnormality_type, name, description,
        threshold_value, comparison_mode, baseline_window, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${RULE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.utilityType,
      input.abnormalityType,
      input.name,
      input.description,
      input.thresholdValue,
      input.comparisonMode,
      input.baselineWindow,
      input.status,
    ],
  );
  return result.rows[0];
}

async function findRuleById(
  id: string,
): Promise<UtilityAbnormalityRuleRecord | null> {
  const result = await getPool().query<UtilityAbnormalityRuleRecord>(
    `SELECT ${RULE_SELECT} FROM utility_abnormality_rules WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Every ACTIVE rule for a (Client, utility type) — the detection set. */
async function listActiveRules(
  clientId: string,
  utilityType: string,
): Promise<UtilityAbnormalityRuleRecord[]> {
  const result = await getPool().query<UtilityAbnormalityRuleRecord>(
    `SELECT ${RULE_SELECT} FROM utility_abnormality_rules
     WHERE client_id = $1 AND utility_type = $2 AND status = 'ACTIVE'
     ORDER BY abnormality_type ASC`,
    [clientId, utilityType],
  );
  return result.rows;
}

async function listRulesByClient(
  clientId: string,
  filters: UtilityAbnormalityRuleFilters = {},
): Promise<UtilityAbnormalityRuleRecord[]> {
  const conditions = ['client_id = $1'];
  const values: unknown[] = [clientId];
  let index = 2;

  if (filters.utilityType) {
    conditions.push(`utility_type = $${index++}`);
    values.push(filters.utilityType);
  }
  if (filters.abnormalityType) {
    conditions.push(`abnormality_type = $${index++}`);
    values.push(filters.abnormalityType);
  }
  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }

  const result = await getPool().query<UtilityAbnormalityRuleRecord>(
    `SELECT ${RULE_SELECT} FROM utility_abnormality_rules
     WHERE ${conditions.join(' AND ')}
     ORDER BY utility_type ASC, abnormality_type ASC`,
    values,
  );
  return result.rows;
}

/* -------------------------------------------------------------------------
 * Abnormal consumption records
 * ---------------------------------------------------------------------- */

async function create(
  input: NewUtilityAbnormalConsumption,
): Promise<UtilityAbnormalConsumptionRecord> {
  const result = await getPool().query<UtilityAbnormalConsumptionRecord>(
    `INSERT INTO utility_abnormal_consumptions
       (id, client_id, building_id, meter_id, utility_type, consumption_id,
        rule_id, abnormality_type, comparison_mode, detected_value,
        reference_value, threshold_value, uom_id, period_start, period_end,
        detected_by_user_id, tenant_assignment_id, tenant_company_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19)
     RETURNING ${ABNORMAL_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.meterId,
      input.utilityType,
      input.consumptionId,
      input.ruleId,
      input.abnormalityType,
      input.comparisonMode,
      input.detectedValue,
      input.referenceValue,
      input.thresholdValue,
      input.uomId,
      input.periodStart,
      input.periodEnd,
      input.detectedByUserId,
      input.tenantAssignmentId,
      input.tenantCompanyId,
      input.notes,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
): Promise<UtilityAbnormalConsumptionRecord | null> {
  const result = await getPool().query<UtilityAbnormalConsumptionRecord>(
    `SELECT ${ABNORMAL_SELECT} FROM utility_abnormal_consumptions
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Guards duplicate detection of the same abnormality on one consumption. */
async function findOpenByConsumptionAndType(
  consumptionId: string,
  abnormalityType: string,
): Promise<UtilityAbnormalConsumptionRecord | null> {
  const result = await getPool().query<UtilityAbnormalConsumptionRecord>(
    `SELECT ${ABNORMAL_SELECT} FROM utility_abnormal_consumptions
     WHERE consumption_id = $1 AND abnormality_type = $2 AND status = 'OPEN'`,
    [consumptionId, abnormalityType],
  );
  return result.rows[0] ?? null;
}

async function listByConsumption(
  consumptionId: string,
): Promise<UtilityAbnormalConsumptionRecord[]> {
  const result = await getPool().query<UtilityAbnormalConsumptionRecord>(
    `SELECT ${ABNORMAL_SELECT} FROM utility_abnormal_consumptions
     WHERE consumption_id = $1
     ORDER BY detected_at DESC`,
    [consumptionId],
  );
  return result.rows;
}

/**
 * Shared filter builder. `scope` anchors the query to one authoritative
 * column so a listing can never accidentally span clients or buildings.
 *
 * `buildingIds` further restricts the result to the caller's accessible
 * Buildings — applied in SQL, never after the fetch. `null` means
 * unrestricted; an empty array means no access at all.
 */
function buildQuery(
  scope: UtilityAbnormalConsumptionScope,
  filters: UtilityAbnormalConsumptionFilters,
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
  if (filters.abnormalityType) {
    conditions.push(`abnormality_type = $${index++}`);
    values.push(filters.abnormalityType);
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
    text: `SELECT ${ABNORMAL_SELECT} FROM utility_abnormal_consumptions
           WHERE ${conditions.join(' AND ')}
           ORDER BY period_end DESC, detected_at DESC
           LIMIT $${index}`,
    values,
  };
}

async function listByScope(
  scope: UtilityAbnormalConsumptionScope,
  filters: UtilityAbnormalConsumptionFilters = {},
  buildingIds: readonly string[] | null = null,
): Promise<UtilityAbnormalConsumptionRecord[]> {
  const query = buildQuery(scope, filters, buildingIds);
  if (!query) {
    return [];
  }
  const result = await getPool().query<UtilityAbnormalConsumptionRecord>(
    query.text,
    query.values,
  );
  return result.rows;
}

/**
 * Closes an OPEN flag. Guarded on the current status in SQL, so a concurrent
 * request cannot overwrite a resolution that already landed.
 */
async function markClosed(
  id: string,
  status: 'RESOLVED' | 'DISMISSED',
  resolvedByUserId: string | null,
  resolutionNotes: string | null,
): Promise<UtilityAbnormalConsumptionRecord | null> {
  const result = await getPool().query<UtilityAbnormalConsumptionRecord>(
    `UPDATE utility_abnormal_consumptions
     SET status = $2,
         resolved_at = NOW(),
         resolved_by_user_id = $3,
         resolution_notes = $4,
         updated_at = NOW()
     WHERE id = $1 AND status = 'OPEN'
     RETURNING ${ABNORMAL_SELECT}`,
    [id, status, resolvedByUserId, resolutionNotes],
  );
  return result.rows[0] ?? null;
}

/**
 * Attaches a BE-09 Finding. Guarded on `finding_id IS NULL` so an existing
 * link can never be silently replaced.
 */
async function attachFinding(
  id: string,
  findingId: string,
): Promise<UtilityAbnormalConsumptionRecord | null> {
  const result = await getPool().query<UtilityAbnormalConsumptionRecord>(
    `UPDATE utility_abnormal_consumptions
     SET finding_id = $2, updated_at = NOW()
     WHERE id = $1 AND finding_id IS NULL
     RETURNING ${ABNORMAL_SELECT}`,
    [id, findingId],
  );
  return result.rows[0] ?? null;
}

export const utilityAbnormalConsumptionRepository = {
  attachFinding,
  create,
  createRule,
  findById,
  findOpenByConsumptionAndType,
  findRuleById,
  listActiveRules,
  listByConsumption,
  listByScope,
  listRulesByClient,
  markClosed,
};
