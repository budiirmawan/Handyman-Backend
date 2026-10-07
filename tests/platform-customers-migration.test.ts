import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { recordOperationalEvent } from '../src/modules/operational-events';
import { clientService } from '../src/modules/clients';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55471;
const DIR = '/tmp/asentra-saas01-mig-pg';
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
    context.skip('CR-BE-SAAS-01 PART 01 test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

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

describe('CR-BE-SAAS-01 PART 01 — migration 0360: SaaS Customer registry schema', () => {
  it('adds the registry columns with correct types and version default', async (t) => {
    if (!ready(t) || !pool) return;
    const result = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'clients'
          AND column_name IN (
            'display_name','billing_email','billing_phone','address',
            'country','currency_code','timezone','version'
          )`,
    );
    const columns = new Map(result.rows.map((row) => [row.column_name, row]));
    for (const expected of [
      'display_name',
      'billing_email',
      'billing_phone',
      'address',
      'country',
      'currency_code',
      'timezone',
      'version',
    ]) {
      assert.ok(columns.has(expected), `clients.${expected} must exist`);
    }
    assert.equal(columns.get('country')?.data_type, 'character varying');
    assert.equal(columns.get('currency_code')?.data_type, 'character varying');
    assert.equal(columns.get('version')?.data_type, 'integer');

    const defaultCheck = await pool.query<{ version: number }>(
      `INSERT INTO clients (id, code, name, status)
       VALUES ($1, $2, 'Version Default', 'ACTIVE') RETURNING version`,
      [randomUUID(), `VD_${suffix()}`],
    );
    assert.equal(defaultCheck.rows[0].version, 1);
  });

  it('keeps the legacy status values valid and accepts the frozen lifecycle', async (t) => {
    if (!ready(t) || !pool) return;
    const statuses = [
      'PROSPECT',
      'TRIAL',
      'ACTIVE',
      'GRACE',
      'SUSPENDED',
      'TERMINATED',
      'INACTIVE',
    ] as const;

    for (const status of statuses) {
      await pool.query(
        `INSERT INTO clients (id, code, name, status)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), `ST_${suffix()}`, `Status ${status}`, status],
      );
    }

    await assert.rejects(
      pool.query(
        `INSERT INTO clients (id, code, name, status)
         VALUES ($1, $2, 'Bogus', 'NOT_A_STATUS')`,
        [randomUUID(), `ST_${suffix()}`],
      ),
      /clients_status_check/,
    );
  });

  it('keeps legacy rows valid without rewriting them', async (t) => {
    if (!ready(t) || !pool) return;
    // The business-plane service still creates legacy ACTIVE clients.
    const legacy = await clientService.createClient({
      code: `LEG_${suffix()}`,
      name: 'Legacy Client',
      legalName: 'Legacy Client Ltd.',
      taxId: 'TAX-1',
    });
    assert.equal(legacy.status, 'ACTIVE');

    const row = await pool.query(
      `SELECT status, display_name, billing_email, currency_code, version
         FROM clients WHERE id = $1`,
      [legacy.id],
    );
    assert.equal(row.rows[0].status, 'ACTIVE');
    assert.equal(row.rows[0].display_name, null);
    assert.equal(row.rows[0].billing_email, null);
    assert.equal(row.rows[0].currency_code, null);
    assert.equal(row.rows[0].version, 1);
  });

  it('enforces the partial unique billing_email index', async (t) => {
    if (!ready(t) || !pool) return;
    const email = `dup-${suffix().toLowerCase()}@example.com`;
    await pool.query(
      `INSERT INTO clients (id, code, name, status, billing_email)
       VALUES ($1, $2, 'Email A', 'PROSPECT', $3)`,
      [randomUUID(), `EM_${suffix()}`, email],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO clients (id, code, name, status, billing_email)
         VALUES ($1, $2, 'Email B', 'PROSPECT', $3)`,
        [randomUUID(), `EM_${suffix()}`, email],
      ),
      /clients_billing_email_unique/,
    );
    // A second customer may still hold NULL billing_email.
    await pool.query(
      `INSERT INTO clients (id, code, name, status, billing_email)
       VALUES ($1, $2, 'Email NULL', 'PROSPECT', NULL)`,
      [randomUUID(), `EM_${suffix()}`],
    );
  });

  it('references the global currency authority for currency_code', async (t) => {
    if (!ready(t) || !pool) return;
    await assert.rejects(
      pool.query(
        `INSERT INTO clients (id, code, name, status, currency_code)
         VALUES ($1, $2, 'Bad Currency', 'PROSPECT', 'XXX')`,
        [randomUUID(), `CU_${suffix()}`],
      ),
      /clients_currency_code_fkey/,
    );
    await pool.query(
      `INSERT INTO clients (id, code, name, status, currency_code)
       VALUES ($1, $2, 'Good Currency', 'PROSPECT', 'IDR')`,
      [randomUUID(), `CU_${suffix()}`],
    );
  });
});

describe('CR-BE-SAAS-01 PART 01 — migration 0361: platform-scope canonical audit', () => {
  it('allows NULL client_id on operational_events (D1) while keeping rows scoped', async (t) => {
    if (!ready(t) || !pool) return;
    // Platform-scope event (no customer) — the SaaS Control Plane case.
    await pool.query(
      `INSERT INTO operational_events
         (id, client_id, event_type, entity_type, entity_id, summary)
       VALUES ($1, NULL, 'SAAS_PLATFORM_CONFIG_CHANGED', 'PLATFORM_CONFIGURATION', $2, 'platform-scope event')`,
      [randomUUID(), randomUUID()],
    );

    // Customer-scoped event via the canonical seam still records client_id.
    const clientId = randomUUID();
    await pool.query(
      `INSERT INTO clients (id, code, name, status)
       VALUES ($1, $2, 'Audit Customer', 'PROSPECT')`,
      [clientId, `AU_${suffix()}`],
    );
    const record = await recordOperationalEvent({
      clientId,
      eventType: 'SAAS_CUSTOMER_CREATED',
      entityType: 'SAAS_CUSTOMER',
      entityId: clientId,
      summary: 'SaaS customer created: AUD',
      metadata: { authority: 'platform.customer.manage' },
    });
    assert.equal(record.client_id, clientId);

    const nullCount = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM operational_events WHERE client_id IS NULL`,
    );
    assert.equal(nullCount.rows[0].n, 1);
  });

  it('still rejects a non-UUID client_id reference (FK preserved)', async (t) => {
    if (!ready(t) || !pool) return;
    await assert.rejects(
      pool.query(
        `INSERT INTO operational_events
           (id, client_id, event_type, entity_type, entity_id, summary)
         VALUES ($1, $2, 'E', 'E', $3, 'bad fk')`,
        [randomUUID(), randomUUID(), randomUUID()],
      ),
      /operational_events_client_id_fkey/,
    );
  });
});
