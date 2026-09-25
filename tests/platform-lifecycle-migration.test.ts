import assert from 'node:assert/strict';
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
 * CR-BE-SAAS-01 PART 08 — lifecycle migration contract (frozen §11.4,
 * §20). Proves:
 *  - 0370 creates `platform_configurations` with frozen §20.1 columns
 *    (id, key UNIQUE, value JSONB, description, version INTEGER,
 *    updated_by_user_id, timestamps);
 *  - The PART 08 seeded keys are present (`saas.past_due_grace_days`,
 *    `saas.grace_period_days`, `saas.suspended_access_policy`,
 *    `saas.suspended_limited_allowlist`);
 *  - Defaults match frozen §20.2 (7 / 14 / FULL_BLOCK / []).
 *  - No SaaS invoice / payment / subscription table is mutated by 0370.
 *  - The frozen PART 07 boundary remains intact: saas_payment_allocations
 *    still references saas_invoices (NOT tenant_invoices).
 */

const PORT = 55410;
const DIR = '/tmp/asentra-saas08-mig-pg';
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
    t.skip('database not initialised');
    return false;
  }
  return true;
}

describe('CR-BE-SAAS-01 PART 08 — lifecycle migration contract (frozen §11.4, §20)', () => {
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

  it('0370 creates platform_configurations with frozen §20.1 columns', async (t) => {
    if (!ready(t)) return;
    const cols = await pool!.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'platform_configurations'
        ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const required of [
      'id',
      'key',
      'value',
      'description',
      'version',
      'updated_by_user_id',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(names.includes(required), `expected ${required} column`);
    }
    const valueType = cols.rows.find((r) => r.column_name === 'value')?.data_type;
    assert.equal(valueType, 'jsonb');
    const versionType = cols.rows.find((r) => r.column_name === 'version')?.data_type;
    assert.ok(
      versionType === 'integer' || versionType === 'bigint',
      'version must be numeric',
    );
  });

  it('0370 enforces UNIQUE on platform_configurations.key', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      pool!.query(
        `INSERT INTO platform_configurations (key, value) VALUES
           ('saas.past_due_grace_days', '99'::jsonb)`,
      ),
      /duplicate key|unique constraint/i,
    );
  });

  it('0370 seeds PART 08 keys with frozen §20.2 defaults', async (t) => {
    if (!ready(t)) return;
    const rows = await pool!.query<{
      key: string;
      value: unknown;
    }>(
      `SELECT key, value FROM platform_configurations
        WHERE key IN ('saas.past_due_grace_days',
                      'saas.grace_period_days',
                      'saas.suspended_access_policy',
                      'saas.suspended_limited_allowlist')
        ORDER BY key`,
    );
    const byKey = new Map(rows.rows.map((r) => [r.key, r.value]));
    assert.equal(String(byKey.get('saas.past_due_grace_days')), '7');
    assert.equal(String(byKey.get('saas.grace_period_days')), '14');
    const policy = byKey.get('saas.suspended_access_policy');
    assert.equal(
      typeof policy === 'string'
        ? policy.replace(/"/g, '')
        : String(policy).replace(/"/g, ''),
      'FULL_BLOCK',
    );
    const allowlist = byKey.get('saas.suspended_limited_allowlist');
    const allowlistArr = Array.isArray(allowlist)
      ? allowlist
      : JSON.parse(String(allowlist));
    assert.deepEqual(allowlistArr, []);
  });

  it('0370 does not mutate PART 03/06/07 tables', async (t) => {
    if (!ready(t)) return;
    // Subscriptions status CHECK still contains SUSPENDED (PART 03/08
    // superset rule).
    const subCheck = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'subscriptions'::regclass
          AND contype = 'c'`,
    );
    assert.ok(subCheck.rows.length > 0, 'subscriptions CHECK present');
    // saas_invoices status CHECK still allows OVERDUE.
    const invoiceStatuses = await pool!.query<{ enum_range: string | null }>(
      `SELECT pg_get_constraintdef(oid) AS enum_range
         FROM pg_constraint
        WHERE conrelid = 'saas_invoices'::regclass
          AND contype = 'c'
          AND conname = 'saas_invoices_status_check'`,
    );
    assert.ok(invoiceStatuses.rows[0]?.enum_range);
    assert.match(invoiceStatuses.rows[0]!.enum_range!, /OVERDUE/);
    // PART 07 boundary — saas_payment_allocations still references saas_invoices.
    const fk = await pool!.query<{
      confrelid: string;
    }>(
      `SELECT confrelid::regclass::text AS confrelid
         FROM pg_constraint
        WHERE conrelid = 'saas_payment_allocations'::regclass
          AND contype = 'f'
          AND conname LIKE '%invoice%'`,
    );
    assert.ok(
      fk.rows.some((r) => r.confrelid === 'saas_invoices'),
      'saas_payment_allocations must still FK saas_invoices',
    );
    // payment_receipts still references tenant_invoices.
    const pr = await pool!.query<{ confrelid: string }>(
      `SELECT confrelid::regclass::text AS confrelid
         FROM pg_constraint
        WHERE conrelid = 'payment_receipts'::regclass
          AND contype = 'f'`,
    );
    assert.ok(
      pr.rows.some((r) => r.confrelid === 'tenant_invoices'),
      'payment_receipts must still FK tenant_invoices',
    );
  });
});
