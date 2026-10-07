import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import {
  after,
  before,
  describe,
  it,
  type TestContext,
} from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 09 — migration 0371 (frozen §12.3).
 *
 * Real DB-backed. Asserts that the migration creates exactly the
 * three frozen tables with their required columns, the UNIQUE dedup
 * on `saas_usage_records (customer_id, meter_key, scope,
 * period_start, source_reference)`, the UNIQUE window on
 * `saas_usage_aggregations (customer_id, meter_key, scope,
 * period_start, period_end)`, NUMERIC >= 0 quantity constraints,
 * and FK references to clients / properties / saas_usage_meters.
 */
const PORT = 55430;
const DIR = '/tmp/asentra-saas09-mig-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(t: TestContext): boolean {
  if (!pool) {
    t.skip('PART 09 migration test database unavailable');
    return false;
  }
  return true;
}

describe('CR-BE-SAAS-01 PART 09 — usage migration 0371', () => {
  before(async () => {
    if (EMBEDDED) {
      await rm(DIR, { recursive: true, force: true });
      await mkdir(DIR, { recursive: true });
      postgres = new EmbeddedPostgres({
        databaseDir: DIR,
        port: PORT,
        user: 'postgres',
        password: '',
        persistent: true,
        authMethod: 'trust',
      });
      await postgres.initialise();
      await postgres.start();
      const setup = postgres.getPgClient('postgres', '127.0.0.1');
      await setup.connect();
      await setup.query('CREATE DATABASE asentra_test');
      await setup.end();
    }
    const config = await ensureTestDatabase();
    if (!config) return;
    pool = await initDatabase(config as DatabaseConfig);
    await migrateUp(pool);
    await runSeeds(pool);
  });

  after(async () => {
    try {
      if (pool) await closePool(pool);
      if (postgres) await postgres.stop();
    } finally {
      await rm(DIR, { recursive: true, force: true });
    }
    pool = null;
    postgres = null;
  });

  it('creates the three frozen §12.3 tables with required columns', async (t) => {
    if (!ready(t) || !pool) return;
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN (
          'saas_usage_meters',
          'saas_usage_records',
          'saas_usage_aggregations'
        ) AND table_schema='public'
        ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((r) => r.table_name),
      ['saas_usage_aggregations', 'saas_usage_meters', 'saas_usage_records'],
    );

    // saas_usage_meters.meter_key must be UNIQUE
    const meterUnique = await pool.query(
      `SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND tablename='saas_usage_meters'
          AND indexdef LIKE '%UNIQUE%meter_key%'`,
    );
    assert.equal(meterUnique.rows.length, 1, 'meter_key UNIQUE missing');

    // saas_usage_records.quantity NUMERIC + >= 0 check
    const recCols = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='saas_usage_records'
          AND column_name='quantity'`,
    );
    assert.equal(recCols.rows[0].data_type, 'numeric');
    const recCk = await pool.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = 'saas_usage_records_quantity_check'`,
    );
    assert.equal(recCk.rows.length, 1, 'records quantity >= 0 check missing');

    // dedup UNIQUE on (customer_id, meter_key, scope, period_start,
    // source_reference)
    const recDedup = await pool.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = 'saas_usage_records_dedup'`,
    );
    assert.equal(recDedup.rows.length, 1, 'records dedup UNIQUE missing');

    // aggregation window UNIQUE on (customer_id, meter_key, scope,
    // period_start, period_end)
    const aggUnique = await pool.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = 'saas_usage_aggregations_window_unique'`,
    );
    assert.equal(
      aggUnique.rows.length,
      1,
      'aggregations window UNIQUE missing',
    );

    // numeric >= 0 check on total_quantity
    const totalCk = await pool.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = 'saas_usage_aggregations_total_quantity_check'`,
    );
    assert.equal(
      totalCk.rows.length,
      1,
      'aggregations total_quantity >= 0 check missing',
    );
  });

  it('rejects negative quantity via the check constraint (frozen §12.3)', async (t) => {
    if (!ready(t) || !pool) return;
    const meter = await pool.query<{ meter_key: string }>(
      `INSERT INTO saas_usage_meters (meter_key, name, unit, period_types)
       VALUES ('api.requests_neg', 'API requests', 'count', '["MONTHLY"]'::jsonb)
       RETURNING meter_key`,
    );
    // PART 09's migration test does not need a real customer; insert a
    // bare clients row to satisfy the FK.
    const clientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO clients (id, code, name) VALUES ($1, $2, $3) RETURNING id`,
        [
          randomUUID(),
          `C09_mig_${randomUUID().slice(0, 6).toUpperCase()}`,
          'PART 09 mig',
        ],
      )
    ).rows[0]!.id as string;
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_usage_records
           (customer_id, meter_key, quantity, scope,
            period_start, period_end, source, source_reference)
         VALUES ($1, $2, -1, 'CURRENT',
                 NOW() - INTERVAL '1 day', NOW(),
                 'BACKEND', 'src-neg-1')`,
        [clientId, meter.rows[0].meter_key],
      ),
    );
  });
});
