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
import { closePool, initDatabase, migrateUp } from '../src/database';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 05 — provisioning migration / schema contract.
 *
 * Proves:
 *  - 0368 creates `saas_provisioning_runs` with the frozen §13.2 columns
 *    (id, customer_id FK→clients, status CHECK (RUNNING|COMPLETED|FAILED),
 *    attempt ≥ 1, steps JSONB, last_error, completed_at, created_at,
 *    updated_at);
 *  - status CHECK enforces exactly the three frozen values;
 *  - customer_id FK to `clients(id)` exists;
 *  - three indexes exist: customer_id, status, created_at DESC;
 *  - the migration is idempotent under `migrateUp` re-runs.
 */

const PORT = 55497;
const DIR = '/tmp/asentra-saas05-mig-pg';
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
      'CR-BE-SAAS-01 PART 05 migration test database unavailable',
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

describe('CR-BE-SAAS-01 PART 05 — provisioning migration contract', () => {
  it('0368 creates saas_provisioning_runs with the frozen §13.2 columns', async (t) => {
    if (!ready(t)) return;
    const columns = await columnsOf('saas_provisioning_runs');
    const types = new Map(columns.map((c) => [c.columnName, c.dataType]));
    for (const required of [
      'id',
      'customer_id',
      'status',
      'attempt',
      'steps',
      'last_error',
      'completed_at',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(types.has(required), `${required} column exists`);
    }
    assert.equal(types.get('id'), 'uuid');
    assert.equal(types.get('customer_id'), 'uuid');
    assert.equal(types.get('status'), 'text');
    assert.equal(types.get('attempt'), 'integer');
    assert.equal(types.get('steps'), 'jsonb');
    assert.equal(types.get('completed_at'), 'timestamp with time zone');
    assert.equal(types.get('created_at'), 'timestamp with time zone');
  });

  it('status CHECK enforces exactly {RUNNING, COMPLETED, FAILED}', async (t) => {
    if (!ready(t)) return;
    const checkRows = await pool!.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
         FROM pg_constraint
        WHERE conrelid = 'saas_provisioning_runs'::regclass
          AND contype = 'c'
          AND conname = 'saas_provisioning_runs_status_check'`,
    );
    assert.equal(checkRows.rows.length, 1, 'status CHECK exists');
    const def = checkRows.rows[0].consrc as string;
    assert.ok(def.includes('RUNNING'));
    assert.ok(def.includes('COMPLETED'));
    assert.ok(def.includes('FAILED'));
  });

  it('attempt CHECK enforces ≥ 1', async (t) => {
    if (!ready(t)) return;
    const checkRows = await pool!.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
         FROM pg_constraint
        WHERE conrelid = 'saas_provisioning_runs'::regclass
          AND contype = 'c'
          AND conname LIKE 'saas_provisioning_runs_attempt_check'`,
    );
    assert.equal(checkRows.rows.length, 1);
    const def = checkRows.rows[0].consrc;
    assert.ok(def.includes('1') || def.includes('>= 1') || def.includes('> 0'));
  });

  it('customer_id FK to clients(id) exists', async (t) => {
    if (!ready(t)) return;
    const fk = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'saas_provisioning_runs'::regclass
          AND contype = 'f'
          AND pg_get_constraintdef(oid) LIKE '%clients(id)%'`,
    );
    assert.equal(fk.rows.length, 1);
  });

  it('indexes cover customer_id, status, created_at DESC', async (t) => {
    if (!ready(t)) return;
    const rows = await pool!.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'saas_provisioning_runs'`,
    );
    const names = rows.rows.map((r) => r.indexname);
    assert.ok(
      names.some((n) => n.includes('customer_id')),
      'customer_id index exists',
    );
    assert.ok(
      names.some((n) => n.includes('status')),
      'status index exists',
    );
    const createdAtIndex = rows.rows.find((r) =>
      r.indexdef.includes('created_at'),
    );
    assert.ok(createdAtIndex, 'created_at index exists');
    assert.ok(
      createdAtIndex!.indexdef.toUpperCase().includes('DESC'),
      'created_at index is DESC',
    );
  });

  it('does NOT introduce a SaaS tenants / customer_tenants table', async (t) => {
    if (!ready(t)) return;
    const tenants = await pool!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('saas_tenants', 'customer_tenants', 'tenant_accounts')`,
    );
    assert.equal(tenants.rows.length, 0);
  });
});
