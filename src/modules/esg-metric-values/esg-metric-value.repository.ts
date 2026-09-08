import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  EsgCalculationMethod,
  EsgDataQuality,
  EsgMetricValueRecord,
  EsgPeriodType,
  EsgSourceType,
  EsgVerificationStatus,
  EsgMetricValueFilters,
  NewEsgMetricValue,
  UpdateEsgMetricValueInput,
} from './esg-metric-value.types';

type Row = {
  id: string;
  clientId: string;
  buildingId: string;
  metricDefinitionId: string;
  periodType: EsgPeriodType;
  periodStart: Date;
  periodEnd: Date;
  value: string | null;
  uomId: string;
  calculationMethod: EsgCalculationMethod;
  sourceType: EsgSourceType;
  sourceRefs: unknown;
  dataQuality: EsgDataQuality;
  verificationStatus: EsgVerificationStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  metric_definition_id AS "metricDefinitionId",
  period_type AS "periodType",
  period_start AS "periodStart",
  period_end AS "periodEnd",
  value::text AS "value",
  uom_id AS "uomId",
  calculation_method AS "calculationMethod",
  source_type AS "sourceType",
  source_refs AS "sourceRefs",
  data_quality AS "dataQuality",
  verification_status AS "verificationStatus",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function map(row: Row): EsgMetricValueRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    metricDefinitionId: row.metricDefinitionId,
    periodType: row.periodType,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    value: row.value,
    uomId: row.uomId,
    calculationMethod: row.calculationMethod,
    sourceType: row.sourceType,
    sourceRefs: row.sourceRefs,
    dataQuality: row.dataQuality,
    verificationStatus: row.verificationStatus,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function insert(
  executor: Pick<PoolClient, 'query'> = getPool(),
  rec: NewEsgMetricValue,
): Promise<EsgMetricValueRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO esg_metric_values
       (id, client_id, building_id, metric_definition_id, period_type, period_start, period_end, value, uom_id, calculation_method, source_type, source_refs, data_quality, verification_status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      rec.clientId,
      rec.buildingId,
      rec.metricDefinitionId,
      rec.periodType,
      rec.periodStart,
      rec.periodEnd,
      rec.value,
      rec.uomId,
      rec.calculationMethod,
      rec.sourceType,
      rec.sourceRefs ? JSON.stringify(rec.sourceRefs) : null,
      rec.dataQuality,
      rec.verificationStatus,
      rec.createdByUserId,
    ],
  );
  return map(result.rows[0]);
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<EsgMetricValueRecord | null> {
  const res = await executor.query<Row>(
    `SELECT ${SELECT} FROM esg_metric_values WHERE id = $1`,
    [id],
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

async function listScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  accessibleBuildingIds: string[],
  filters: EsgMetricValueFilters,
): Promise<EsgMetricValueRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  conditions.push(`building_id = ANY($${idx++})`);
  values.push(accessibleBuildingIds);

  if (filters.clientId) {
    conditions.push(`client_id = $${idx++}`);
    values.push(filters.clientId);
  }
  if (filters.buildingId) {
    conditions.push(`building_id = $${idx++}`);
    values.push(filters.buildingId);
  }
  if (filters.metricDefinitionId) {
    conditions.push(`metric_definition_id = $${idx++}`);
    values.push(filters.metricDefinitionId);
  }
  if (filters.periodType) {
    conditions.push(`period_type = $${idx++}`);
    values.push(filters.periodType);
  }
  if (filters.calculationMethod) {
    conditions.push(`calculation_method = $${idx++}`);
    values.push(filters.calculationMethod);
  }
  if (filters.sourceType) {
    conditions.push(`source_type = $${idx++}`);
    values.push(filters.sourceType);
  }
  if (filters.dataQuality) {
    conditions.push(`data_quality = $${idx++}`);
    values.push(filters.dataQuality);
  }
  if (filters.verificationStatus) {
    conditions.push(`verification_status = $${idx++}`);
    values.push(filters.verificationStatus);
  }
  if (filters.uomId) {
    conditions.push(`uom_id = $${idx++}`);
    values.push(filters.uomId);
  }
  if (filters.dateFrom) {
    conditions.push(`period_start >= $${idx++}::timestamptz`);
    values.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push(`period_end <= $${idx++}::timestamptz`);
    values.push(filters.dateTo);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const res = await executor.query<Row>(
    `SELECT ${SELECT} FROM esg_metric_values ${where} ORDER BY period_start DESC, created_at DESC`,
    values,
  );
  return res.rows.map(map);
}

async function update(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
  input: {
    value?: number | null;
    uomId?: string;
    calculationMethod?: EsgCalculationMethod;
    sourceType?: EsgSourceType;
    sourceRefs?: string[] | null;
    dataQuality?: EsgDataQuality;
    verificationStatus?: EsgVerificationStatus;
  },
): Promise<EsgMetricValueRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.value !== undefined) {
    sets.push(`value = $${idx++}`);
    values.push(input.value);
  }
  if (input.uomId !== undefined) {
    sets.push(`uom_id = $${idx++}`);
    values.push(input.uomId);
  }
  if (input.calculationMethod !== undefined) {
    sets.push(`calculation_method = $${idx++}`);
    values.push(input.calculationMethod);
  }
  if (input.sourceType !== undefined) {
    sets.push(`source_type = $${idx++}`);
    values.push(input.sourceType);
  }
  if (input.sourceRefs !== undefined) {
    sets.push(`source_refs = $${idx++}`);
    values.push(input.sourceRefs ? JSON.stringify(input.sourceRefs) : null);
  }
  if (input.dataQuality !== undefined) {
    sets.push(`data_quality = $${idx++}`);
    values.push(input.dataQuality);
  }
  if (input.verificationStatus !== undefined) {
    sets.push(`verification_status = $${idx++}`);
    values.push(input.verificationStatus);
  }

  if (sets.length === 0) {
    return findById(executor, id);
  }

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const res = await executor.query<Row>(
    `UPDATE esg_metric_values SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${SELECT}`,
    values,
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

export const esgMetricValueRepository = {
  insert,
  findById,
  listScoped,
  update,
};
