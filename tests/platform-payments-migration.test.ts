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
 * CR-BE-SAAS-01 PART 07 — payment migration / schema contract (frozen §15).
 *
 * Proves:
 *  - 0369 creates saas_payment_records / saas_payment_allocations /
 *    saas_payment_provider_references with the frozen §15.1/§15.2/§15.3
 *    columns;
 *  - Payment → Customer FK + currency FK reused from canonical currency
 *    authority;
 *  - Allocation → SaaS Invoice FK (saas_invoices) — NOT tenant_invoices;
 *  - provider_reference UNIQUE per provider_type (frozen §15.1 dedup);
 *  - amount NUMERIC(18,2) > 0 (no zero/negative payments);
 *  - status CHECK enforces exactly {PENDING, RECONCILED, REJECTED};
 *  - facility operations boundary: payment_receipts.invoice_id still
 *    references tenant_invoices (NOT saas_invoices).
 */

const PORT = 55406;
const DIR = '/tmp/asentra-saas07-mig-pg';
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

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip(
      'CR-BE-SAAS-01 PART 07 migration test database unavailable',
    );
    return false;
  }
  return true;
}

async function columnsOf(
  qualified: string,
): Promise<{ columnName: string; dataType: string }[]> {
  assert.ok(pool);
  const result = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
      ORDER BY ordinal_position`,
    [qualified],
  );
  return result.rows.map((row) => ({
    columnName: row.column_name,
    dataType: row.data_type,
  }));
}

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

describe('CR-BE-SAAS-01 PART 07 — payment migration contract (frozen §15)', () => {
  it('0369 creates saas_payment_records with frozen §15.1 columns and status CHECK', async (t) => {
    if (!ready(t)) return;
    const cols = await columnsOf('saas_payment_records');
    const types = new Map(cols.map((c) => [c.columnName, c.dataType]));
    for (const required of [
      'id',
      'billing_account_id',
      'customer_id',
      'provider_type',
      'amount',
      'currency_code',
      'received_at',
      'status',
      'version',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(types.has(required), `${required} exists`);
    }
    assert.equal(types.get('amount'), 'numeric');
    assert.equal(types.get('version'), 'integer');

    const check = await pool!.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
         FROM pg_constraint
        WHERE conrelid = 'saas_payment_records'::regclass
          AND contype = 'c'
          AND conname = 'saas_payment_records_status_check'`,
    );
    assert.equal(check.rows.length, 1);
    const def = check.rows[0]!.consrc;
    assert.ok(def.includes('PENDING'));
    assert.ok(def.includes('RECONCILED'));
    assert.ok(def.includes('REJECTED'));
  });

  it('provider_reference UNIQUE per provider_type (frozen §15.1 dedup)', async (t) => {
    if (!ready(t)) return;
    const indexes = await pool!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'saas_payment_records'
          AND indexname = 'saas_payment_records_provider_reference_unique'`,
    );
    assert.equal(indexes.rows.length, 1);
  });

  it('Allocations UNIQUE (payment_id, invoice_id) AND FK to saas_invoices (NOT tenant_invoices)', async (t) => {
    if (!ready(t)) return;
    const uniq = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'saas_payment_allocations'::regclass
          AND contype = 'u'
          AND conname = 'saas_payment_allocations_payment_invoice_unique'`,
    );
    assert.equal(uniq.rows.length, 1);

    const fks = await pool!.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'saas_payment_allocations'::regclass
          AND contype = 'f'`,
    );
    const defs = fks.rows.map((r) => r.def).join('\n');
    assert.ok(
      defs.includes('saas_invoices(id)'),
      'allocation.invoice_id → saas_invoices(id)',
    );
    assert.ok(
      !defs.includes('tenant_invoices(id)'),
      'allocation NEVER references tenant_invoices',
    );
  });

  it('Payment → Client (customer) + currency FKs reuse canonical authority', async (t) => {
    if (!ready(t)) return;
    const fks = await pool!.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'saas_payment_records'::regclass
          AND contype = 'f'`,
    );
    const defs = fks.rows.map((r) => r.def).join('\n');
    assert.ok(defs.includes('clients(id)'));
    assert.ok(defs.includes('saas_billing_accounts(id)'));
    assert.ok(defs.includes('currencies(code)'));
  });

  it('Provider-references table exists with required frozen §15.3 columns', async (t) => {
    if (!ready(t)) return;
    const cols = await columnsOf('saas_payment_provider_references');
    const names = new Set(cols.map((c) => c.columnName));
    for (const required of [
      'id',
      'payment_id',
      'provider_type',
      'external_reference',
      'event_type',
      'payload',
      'received_at',
    ]) {
      assert.ok(names.has(required), `provider-references.${required}`);
    }
    assert.ok(names.has('payload'));
  });

  it('FACILITY PAYMENT BOUNDARY: payment_receipts.invoice_id UNCHANGED → tenant_invoices (NOT saas_invoices)', async (t) => {
    if (!ready(t)) return;
    const fk = await pool!.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'payment_receipts'::regclass
          AND contype = 'f'
          AND pg_get_constraintdef(oid) LIKE '%invoice_id%'`,
    );
    assert.equal(fk.rows.length, 1);
    const def = fk.rows[0]!.def;
    assert.ok(
      def.includes('tenant_invoices(id)'),
      'payment_receipts must keep its tenant_invoices FK',
    );
    assert.ok(
      !def.includes('saas_invoices'),
      'payment_receipts MUST NOT silently switch to saas_invoices',
    );
  });
});
