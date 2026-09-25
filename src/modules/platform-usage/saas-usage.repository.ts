/**
 * CR-BE-SAAS-01 PART 09 — Usage & metering repository (frozen §12.3).
 *
 * Thin repository over the three frozen tables. Numeric quantities are
 * kept as NUMERIC strings on the wire (no JS float drift). All
 * aggregator upserts run inside the caller's transaction so the
 * append-only record and the aggregation commit or roll back atomically.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateSaasMeterInput,
  ListUsageRecordsParams,
  SaasMeterRecord,
  SaasMeterStatus,
  SaasUsageAggregationRow,
  SaasUsagePeriodType,
  SaasUsageRecordRow,
  SaasUsageScope,
} from './saas-usage.types';

type Executor = PoolClient | ReturnType<typeof getPool>;

function executor(q?: Executor): Executor {
  return q ?? getPool();
}

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

type MeterRow = {
  id: string;
  meter_key: string;
  name: string;
  unit: string;
  period_types: unknown;
  status: SaasMeterStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
};

function mapMeter(row: MeterRow): SaasMeterRecord {
  const pt = Array.isArray(row.period_types)
    ? (row.period_types as readonly string[])
    : typeof row.period_types === 'string'
      ? (JSON.parse(row.period_types) as readonly string[])
      : [];
  return {
    id: row.id,
    meterKey: row.meter_key,
    name: row.name,
    unit: row.unit,
    periodTypes: pt.filter(
      (v): v is SaasUsagePeriodType =>
        v === 'DAILY' || v === 'MONTHLY' || v === 'BILLING_PERIOD',
    ),
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createMeter(
  input: CreateSaasMeterInput,
  q?: Executor,
): Promise<SaasMeterRecord> {
  const result = await executor(q).query<MeterRow>(
    `INSERT INTO saas_usage_meters (meter_key, name, unit, period_types)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, meter_key, name, unit, period_types, status, version,
               created_at, updated_at`,
    [
      input.meterKey,
      input.name,
      input.unit,
      JSON.stringify(input.periodTypes),
    ],
  );
  return mapMeter(result.rows[0]!);
}

async function findMeterByKey(
  meterKey: string,
  q?: Executor,
): Promise<SaasMeterRecord | null> {
  const result = await executor(q).query<MeterRow>(
    `SELECT id, meter_key, name, unit, period_types, status, version,
            created_at, updated_at
       FROM saas_usage_meters
      WHERE meter_key = $1`,
    [meterKey],
  );
  return result.rows[0] ? mapMeter(result.rows[0]) : null;
}

async function listMeters(q?: Executor): Promise<readonly SaasMeterRecord[]> {
  const result = await executor(q).query<MeterRow>(
    `SELECT id, meter_key, name, unit, period_types, status, version,
            created_at, updated_at
       FROM saas_usage_meters
       ORDER BY meter_key ASC`,
  );
  return result.rows.map(mapMeter);
}

// ---------------------------------------------------------------------------
// Records (append-only)
// ---------------------------------------------------------------------------

type RecordRow = {
  id: string;
  customer_id: string;
  building_id: string | null;
  meter_key: string;
  quantity: string;
  scope: SaasUsageScope;
  period_start: Date;
  period_end: Date;
  source: 'BACKEND' | 'TRUSTED_INTEGRATION';
  source_reference: string;
  recorded_by_user_id: string | null;
  created_at: Date;
};

function mapRecord(row: RecordRow): SaasUsageRecordRow {
  return {
    id: row.id,
    customerId: row.customer_id,
    buildingId: row.building_id,
    meterKey: row.meter_key,
    quantity: row.quantity,
    scope: row.scope,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    source: row.source,
    sourceReference: row.source_reference,
    recordedByUserId: row.recorded_by_user_id,
    createdAt: row.created_at,
  };
}

async function createRecord(
  input: {
    customerId: string;
    buildingId: string | null;
    meterKey: string;
    quantity: string;
    scope: SaasUsageScope;
    periodStart: Date;
    periodEnd: Date;
    source: 'BACKEND' | 'TRUSTED_INTEGRATION';
    sourceReference: string;
    recordedByUserId: string | null;
  },
  q?: Executor,
): Promise<SaasUsageRecordRow> {
  const result = await executor(q).query<RecordRow>(
    `INSERT INTO saas_usage_records
       (customer_id, building_id, meter_key, quantity, scope,
        period_start, period_end, source, source_reference,
        recorded_by_user_id)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10)
     RETURNING id, customer_id, building_id, meter_key, quantity, scope,
               period_start, period_end, source, source_reference,
               recorded_by_user_id, created_at`,
    [
      input.customerId,
      input.buildingId,
      input.meterKey,
      input.quantity,
      input.scope,
      input.periodStart,
      input.periodEnd,
      input.source,
      input.sourceReference,
      input.recordedByUserId,
    ],
  );
  return mapRecord(result.rows[0]!);
}

async function findRecordByDedup(
  customerId: string,
  meterKey: string,
  scope: SaasUsageScope,
  periodStart: Date,
  sourceReference: string,
  q?: Executor,
): Promise<SaasUsageRecordRow | null> {
  const result = await executor(q).query<RecordRow>(
    `SELECT id, customer_id, building_id, meter_key, quantity, scope,
            period_start, period_end, source, source_reference,
            recorded_by_user_id, created_at
       FROM saas_usage_records
      WHERE customer_id = $1 AND meter_key = $2 AND scope = $3
        AND period_start = $4 AND source_reference = $5`,
    [customerId, meterKey, scope, periodStart, sourceReference],
  );
  return result.rows[0] ? mapRecord(result.rows[0]) : null;
}

async function listRecords(
  filters: ListUsageRecordsParams,
  q?: Executor,
): Promise<readonly SaasUsageRecordRow[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.customerId) {
    values.push(filters.customerId);
    clauses.push(`customer_id = $${values.length}`);
  }
  if (filters.meterKey) {
    values.push(filters.meterKey);
    clauses.push(`meter_key = $${values.length}`);
  }
  if (filters.scope) {
    values.push(filters.scope);
    clauses.push(`scope = $${values.length}`);
  }
  if (filters.periodStart) {
    values.push(new Date(filters.periodStart));
    clauses.push(`period_start = $${values.length}`);
  }
  if (filters.periodEnd) {
    values.push(new Date(filters.periodEnd));
    clauses.push(`period_end = $${values.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await executor(q).query<RecordRow>(
    `SELECT id, customer_id, building_id, meter_key, quantity, scope,
            period_start, period_end, source, source_reference,
            recorded_by_user_id, created_at
       FROM saas_usage_records
       ${where}
       ORDER BY created_at DESC, id ASC
       LIMIT 500`,
    values,
  );
  return result.rows.map(mapRecord);
}

// ---------------------------------------------------------------------------
// Aggregations (transactional upsert — concurrency safe via version-guard)
// ---------------------------------------------------------------------------

type AggregationRow = {
  id: string;
  customer_id: string;
  meter_key: string;
  scope: SaasUsageScope;
  period_start: Date;
  period_end: Date;
  total_quantity: string;
  record_count: number;
  version: number;
  updated_at: Date;
};

function mapAggregation(row: AggregationRow): SaasUsageAggregationRow {
  return {
    id: row.id,
    customerId: row.customer_id,
    meterKey: row.meter_key,
    scope: row.scope,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    totalQuantity: row.total_quantity,
    recordCount: row.record_count,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/**
 * Upserts the aggregation row for (customer, meter, scope, period). The
 * caller passes the SAME PoolClient as the record insert so both commit
 * or roll back atomically. Total = prior + quantity (concurrency-safe
 * via the version-guarded UPDATE that follows the UPSERT attempt).
 */
async function addToAggregation(
  customerId: string,
  meterKey: string,
  scope: SaasUsageScope,
  periodStart: Date,
  periodEnd: Date,
  quantity: string,
  q: Executor,
): Promise<SaasUsageAggregationRow> {
  // Try to insert a fresh aggregation row first.
  const inserted = await q.query<AggregationRow>(
    `INSERT INTO saas_usage_aggregations
       (customer_id, meter_key, scope, period_start, period_end,
        total_quantity, record_count)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, 1)
     ON CONFLICT ON CONSTRAINT saas_usage_aggregations_window_unique
     DO NOTHING
     RETURNING id, customer_id, meter_key, scope, period_start, period_end,
               total_quantity, record_count, version, updated_at`,
    [customerId, meterKey, scope, periodStart, periodEnd, quantity],
  );
  if (inserted.rows[0]) {
    return mapAggregation(inserted.rows[0]);
  }
  // Aggregate exists; bump via OCC-safe UPDATE. Params:
  //   $1 customerId, $2 meterKey, $3 scope, $4 periodStart,
  //   $5 periodEnd, $6 quantity (NUMERIC string).
  const updated = await q.query<AggregationRow>(
    `UPDATE saas_usage_aggregations
        SET total_quantity = total_quantity + $6::numeric,
            record_count = record_count + 1,
            version = version + 1,
            updated_at = NOW()
      WHERE customer_id = $1 AND meter_key = $2 AND scope = $3
        AND period_start = $4 AND period_end = $5
      RETURNING id, customer_id, meter_key, scope, period_start, period_end,
                total_quantity, record_count, version, updated_at`,
    [customerId, meterKey, scope, periodStart, periodEnd, quantity],
  );
  if (!updated.rows[0]) {
    throw new Error(
      `saas_usage_aggregations upsert failed for ${customerId}/${meterKey}/${scope}`,
    );
  }
  return mapAggregation(updated.rows[0]);
}

async function findAggregation(
  customerId: string,
  meterKey: string,
  scope: SaasUsageScope,
  periodStart: Date,
  periodEnd: Date,
  q?: Executor,
): Promise<SaasUsageAggregationRow | null> {
  const result = await executor(q).query<AggregationRow>(
    `SELECT id, customer_id, meter_key, scope, period_start, period_end,
            total_quantity, record_count, version, updated_at
       FROM saas_usage_aggregations
      WHERE customer_id = $1 AND meter_key = $2 AND scope = $3
        AND period_start = $4 AND period_end = $5`,
    [customerId, meterKey, scope, periodStart, periodEnd],
  );
  return result.rows[0] ? mapAggregation(result.rows[0]) : null;
}

async function listAggregationsForCustomer(
  customerId: string,
  scope: SaasUsageScope,
  q?: Executor,
): Promise<readonly SaasUsageAggregationRow[]> {
  const result = await executor(q).query<AggregationRow>(
    `SELECT id, customer_id, meter_key, scope, period_start, period_end,
            total_quantity, record_count, version, updated_at
       FROM saas_usage_aggregations
      WHERE customer_id = $1 AND scope = $2
      ORDER BY meter_key ASC`,
    [customerId, scope],
  );
  return result.rows.map(mapAggregation);
}

export const saasUsageRepository = {
  createMeter,
  findMeterByKey,
  listMeters,
  createRecord,
  findRecordByDedup,
  listRecords,
  addToAggregation,
  findAggregation,
  listAggregationsForCustomer,
};
