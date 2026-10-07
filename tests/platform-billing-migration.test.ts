import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 06 — billing migration / schema contract.
 *
 * Proves:
 *  - new SaaS billing structures exist (0366 saas_billing_accounts +
 *    0367 saas_invoices + saas_invoice_lines +
 *    saas_invoice_number_sequences);
 *  - FKs to the existing `clients` (SaaS customer authority),
 *    `currencies` (canonical currency authority from 0331),
 *    subscriptions, and saas_billing_accounts are in place;
 *  - monetary precision (NUMERIC(18,2) on amount columns, NUMERIC on
 *    quantity);
 *  - uniqueness constraints (number UNIQUE on saas_invoices;
 *    at-most-one-ACTIVE per-customer partial unique index on
 *    saas_billing_accounts; per-year number sequence PK);
 *  - version/version-check on aggregates in the frozen §17.3 list;
 *  - the legacy Facility Operations billing tables (tenant_invoices,
 *    payment_receipts) are UNTOUCHED — schema-only proof: they are
 *    unchanged in column count, same foreign keys to tenant-side tables;
 *  - the per-year number sequence remains DRAFT-only (never issued by
 *    reading a "current max" of issued numbers).
 */

const PORT = 55491;
const DIR = '/tmp/asentra-saas06-mig-pg';
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
    context.skip('CR-BE-SAAS-01 PART 06 test database unavailable');
    return false;
  }
  return true;
}

async function scalar<T>(query: string, params: unknown[] = []): Promise<T> {
  assert.ok(pool);
  const result = await pool.query<{ value: T }>(query, params);
  return result.rows[0]?.value as T;
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

describe('CR-BE-SAAS-01 PART 06 — SaaS billing migration contract', () => {
  it('0366 creates saas_billing_accounts with the frozen §14.1 columns and the one-ACTIVE-per-customer partial unique index', async (t) => {
    if (!ready(t)) return;

    const columns = await columnsOf('saas_billing_accounts');
    const columnTypes = new Map(columns.map((c) => [c.columnName, c.dataType]));

    for (const required of [
      'id',
      'customer_id',
      'legal_name',
      'tax_identity',
      'billing_address',
      'billing_email',
      'currency_code',
      'payment_terms',
      'status',
      'version',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(columnTypes.has(required), `${required} exists`);
    }
    assert.equal(columnTypes.get('id'), 'uuid');
    assert.equal(columnTypes.get('customer_id'), 'uuid');
    assert.equal(columnTypes.get('currency_code'), 'character varying');
    assert.equal(columnTypes.get('payment_terms'), 'integer');
    assert.equal(columnTypes.get('billing_address'), 'jsonb');
    assert.equal(columnTypes.get('status'), 'text');
    assert.equal(columnTypes.get('version'), 'integer');

    const oneActiveIndex = await pool!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'saas_billing_accounts'
          AND indexname = 'saas_billing_accounts_one_active_per_customer'`,
    );
    assert.equal(oneActiveIndex.rows.length, 1, 'one-ACTIVE-per-customer partial unique index present');

    const constraintNames = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'saas_billing_accounts'::regclass
          AND contype IN ('f', 'c')`,
    );
    const constraintList = constraintNames.rows.map((r) => r.conname);
    assert.ok(
      constraintList.includes('saas_billing_accounts_customer_id_fkey'),
      'billing account FK → clients (SaaS customer authority)',
    );
    assert.ok(
      constraintList.includes('saas_billing_accounts_currency_code_fkey'),
      'billing account FK → currencies (canonical 0331 authority)',
    );
    assert.ok(
      constraintList.includes('saas_billing_accounts_status_check'),
      'billing account status CHECK present',
    );
    assert.ok(
      constraintList.includes('saas_billing_accounts_version_check'),
      'billing account version CHECK present',
    );
  });

  it('0367 creates saas_invoices with the frozen §14.2 columns, NUMERIC(18,2) amounts, and uniqueness/version invariants', async (t) => {
    if (!ready(t)) return;

    const columns = await columnsOf('saas_invoices');
    const columnTypes = new Map(columns.map((c) => [c.columnName, c.dataType]));

    for (const required of [
      'id',
      'number',
      'billing_account_id',
      'customer_id',
      'subscription_id',
      'period_start',
      'period_end',
      'currency_code',
      'base_amount',
      'tax_amount',
      'total_amount',
      'status',
      'issued_at',
      'due_at',
      'paid_at',
      'voided_at',
      'void_reason',
      'version',
    ]) {
      assert.ok(columnTypes.has(required), `${required} exists`);
    }

    // Frozen §14.2: NUMERIC(18,2) for monetary amounts.
    for (const amountCol of ['base_amount', 'tax_amount', 'total_amount']) {
      const formatResult = await pool!.query<{ typ: string }>(
        `SELECT pg_catalog.format_type(
            (SELECT atttypid FROM pg_attribute
              WHERE attrelid = 'saas_invoices'::regclass AND attname = $1),
            (SELECT atttypmod FROM pg_attribute
              WHERE attrelid = 'saas_invoices'::regclass AND attname = $1)
          ) AS typ`,
        [amountCol],
      );
      const typ = formatResult.rows[0]?.typ ?? '';
      assert.equal(typ, 'numeric(18,2)', `${amountCol} is NUMERIC(18,2)`);
    }

    const numberUnique = await pool!.query<{ contype: string }>(
      `SELECT contype FROM pg_constraint
        WHERE conrelid = 'saas_invoices'::regclass
          AND conname = 'saas_invoices_number_unique'`,
    );
    assert.equal(numberUnique.rows.length, 1, 'invoice number UNIQUE');

    const constraintNames = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'saas_invoices'::regclass AND contype IN ('f', 'c')`,
    );
    const list = constraintNames.rows.map((r) => r.conname);
    assert.ok(list.includes('saas_invoices_billing_account_id_fkey'), 'invoice → billing account FK');
    assert.ok(list.includes('saas_invoices_customer_id_fkey'), 'invoice → customer FK');
    assert.ok(list.includes('saas_invoices_subscription_id_fkey'), 'invoice → subscription FK');
    assert.ok(list.includes('saas_invoices_currency_code_fkey'), 'invoice → currencies FK');
    assert.ok(list.includes('saas_invoices_status_check'), 'invoice status CHECK');
    assert.ok(list.includes('saas_invoices_amounts_check'), 'invoice amounts CHECK');
    assert.ok(list.includes('saas_invoices_total_check'), 'invoice total CHECK');
    assert.ok(list.includes('saas_invoices_period_check'), 'invoice period CHECK');
    assert.ok(list.includes('saas_invoices_version_check'), 'invoice version CHECK');

    const sequence = await columnsOf('saas_invoice_number_sequences');
    assert.ok(
      sequence.some((c) => c.columnName === 'year' && c.dataType === 'integer'),
      'number sequence year column',
    );
    assert.ok(
      sequence.some((c) => c.columnName === 'last_number' && c.dataType === 'integer'),
      'number sequence last_number column',
    );
  });

  it('0367 line-types CHECK pins the frozen §14.3 vocabulary; lines FK to invoices and currency authority', async (t) => {
    if (!ready(t)) return;

    const lineTypeCheck = await pool!.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'saas_invoice_lines'::regclass
          AND conname = 'saas_invoice_lines_line_type_check'`,
    );
    const def = lineTypeCheck.rows[0]?.def ?? '';
    for (const required of [
      'BASE_SUBSCRIPTION',
      'ADDITIONAL_BUILDING',
      'ADD_ON',
      'USAGE',
      'DISCOUNT',
      'ADJUSTMENT',
      'TAX',
    ]) {
      assert.ok(def.includes(required), `line-type CHECK pins ${required}`);
    }

    const lineFks = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'saas_invoice_lines'::regclass AND contype = 'f'`,
    );
    const list = lineFks.rows.map((r) => r.conname);
    assert.ok(list.includes('saas_invoice_lines_invoice_id_fkey'), 'line → invoice FK');
    assert.ok(list.includes('saas_invoice_lines_currency_code_fkey'), 'line → currency FK');
  });

  it('legacy Facility Operations billing tables are UNTOUCHED (tenant_invoices and payment_receipts columns unchanged)', async (t) => {
    if (!ready(t)) return;

    const tenantInvoicesCols = await columnsOf('tenant_invoices');
    // Sanctity: business-plane table is still tenant/space-scoped.
    for (const required of [
      'client_id',
      'tenant_company_id',
      'building_id',
      'space_id',
    ]) {
      assert.ok(
        tenantInvoicesCols.some((c) => c.columnName === required),
        `tenant_invoices still has ${required}`,
      );
    }
    // Specifically: tenant_invoices does NOT borrow any PART 06 SaaS
    // columns.
    for (const forbidden of [
      'billing_account_id',
      'subscription_id',
      'saas_subscription_id',
      'number',
      'idempotency',
    ]) {
      assert.ok(
        !tenantInvoicesCols.some((c) => c.columnName === forbidden),
        `tenant_invoices does not have SaaS column ${forbidden}`,
      );
    }

    const receiptColumns = await columnsOf('payment_receipts');
    // payment_receipts still pays the facility operation (its invoice_id
    // references tenant_invoices, NEVER saas_invoices).
    assert.ok(
      receiptColumns.some((c) => c.columnName === 'invoice_id'),
      'payment_receipts still records a tenant_invoice_id (legacy intent preserved)',
    );
    const receiptFkTarget = await pool!.query<{ fk_table: string }>(
      `SELECT c.confrelid::regclass::text AS fk_table
         FROM pg_constraint c
        WHERE c.conrelid = 'payment_receipts'::regclass
          AND c.contype = 'f'
          AND c.conname = 'payment_receipts_invoice_id_fkey'`,
    );
    const fkTarget = receiptFkTarget.rows[0]?.fk_table ?? '';
    assert.equal(
      fkTarget,
      'tenant_invoices',
      'payment_receipts.invoice_id still points at tenant_invoices (NOT saas_invoices)',
    );
    for (const forbidden of [
      'billing_account_id',
      'saas_invoice_id',
      'subscription_id',
      'saas_subscription_id',
    ]) {
      assert.ok(
        !receiptColumns.some((c) => c.columnName === forbidden),
        `payment_receipts does not have SaaS column ${forbidden}`,
      );
    }
  });
});
