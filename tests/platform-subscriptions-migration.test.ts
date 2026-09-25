import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 03 — migration 0364 compatibility tests.
 *
 * Proves the `subscriptions` extension is additive and non-destructive:
 * legacy rows stay valid (statuses, ids, codes, plan codes), the version
 * backfill is safe, the widened status CHECK admits the frozen §11.2
 * vocabulary while preserving legacy values, and the new FK relationships
 * are enforced.
 */

const PORT = 55484;
const DIR = '/tmp/asentra-saas03-mig-pg';
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
    context.skip('CR-BE-SAAS-01 PART 03 test database unavailable');
    return false;
  }
  return true;
}

const uuid = () => randomUUID();

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

async function insertClient(code: string): Promise<string> {
  assert.ok(pool);
  const id = uuid();
  await pool.query(
    `INSERT INTO clients (id, code, name) VALUES ($1, $2, $3)`,
    [id, code, `Migration Client ${code}`],
  );
  return id;
}

describe('CR-BE-SAAS-01 PART 03 — migration 0364: subscriptions SaaS extension', () => {
  it('adds the frozen §11.1 columns additively (all nullable, version NOT NULL default 1)', async (t) => {
    if (!ready(t) || !pool) return;
    const result = await pool.query<{ column: string; type: string; nullable: string; default: string | null }>(
      `SELECT c.column_name AS column, c.data_type AS type,
              c.is_nullable AS nullable, c.column_default AS default
         FROM information_schema.columns c
        WHERE c.table_name = 'subscriptions'
        ORDER BY c.ordinal_position`,
    );
    const cols = new Map<string, { type: string; nullable: string }>();
    let versionDefault: string | null = null;
    for (const row of result.rows) {
      cols.set(row.column, { type: row.type, nullable: row.nullable });
      if (row.column === 'version') versionDefault = row.default;
    }

    for (const expected of [
      'product_id', 'package_id', 'pricebook_version_id', 'billing_cycle',
      'currency_code', 'trial_end_date', 'current_period_start',
      'current_period_end', 'renewal_date', 'grace_until', 'cancelled_at',
      'terminated_at', 'version',
    ]) {
      assert.ok(cols.has(expected), `${expected} must exist`);
    }
    for (const legacyColumn of ['id', 'client_id', 'code', 'plan_code', 'status', 'starts_at', 'ends_at']) {
      assert.ok(cols.has(legacyColumn), `legacy column ${legacyColumn} must remain`);
    }
    assert.equal(cols.get('version')?.type, 'integer');
    assert.equal(cols.get('version')?.nullable, 'NO');
    assert.ok(versionDefault?.includes('1'), 'version backfills to 1');
    assert.equal(cols.get('pricebook_version_id')?.nullable, 'YES', 'legacy rows keep NULL commercial references');
  });

  it('legacy rows stay valid: original statuses accepted, version backfilled, new columns NULL', async (t) => {
    if (!ready(t) || !pool) return;
    const clientId = await insertClient(`MIGC_${uuid().slice(0, 8).toUpperCase()}`);
    const id = uuid();
    const startsAt = new Date('2025-01-01T00:00:00.000Z');
    const endsAt = new Date('2025-12-31T23:59:59.000Z');

    // Insert in the EXACT pre-0364 shape (no SaaS columns at all).
    await pool.query(
      `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)`,
      [id, clientId, `ASENTRA-2025-${uuid().slice(0, 3).toUpperCase()}`, 'STANDARD', startsAt, endsAt],
    );

    const row = await pool.query<{
      id: string; code: string; plan_code: string; status: string;
      version: number; product_id: string | null; pricebook_version_id: string | null;
    }>(
      `SELECT id, code, plan_code, status, version, product_id, pricebook_version_id
         FROM subscriptions WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows.length, 1, 'legacy row readable');
    assert.equal(row.rows[0].status, 'PENDING', 'legacy status preserved');
    assert.equal(row.rows[0].version, 1, 'version backfilled to 1');
    assert.equal(row.rows[0].product_id, null, 'new columns NULL on legacy rows');
    assert.equal(row.rows[0].pricebook_version_id, null);
  });

  it('widened status CHECK admits the frozen §11.2 vocabulary and still rejects unknown values', async (t) => {
    if (!ready(t) || !pool) return;
    const clientId = await insertClient(`MIGC_${uuid().slice(0, 8).toUpperCase()}`);
    for (const status of ['DRAFT', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELLED', 'TERMINATED', 'EXPIRED']) {
      const id = uuid();
      await pool.query(
        `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [id, clientId, `CHK-${uuid().slice(0, 8).toUpperCase()}`, 'STANDARD', status],
      );
    }
    await assert.rejects(
      pool.query(
        `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at)
         VALUES ($1, $2, $3, $4, 'BOGUS', NOW())`,
        [uuid(), clientId, `CHK-${uuid().slice(0, 8).toUpperCase()}`, 'STANDARD'],
      ),
      (error: { code?: string }) => error.code === '23514',
    );
  });

  it('enforces the new FK relationships (product, package, pricebook version, currency)', async (t) => {
    if (!ready(t) || !pool) return;
    const clientId = await insertClient(`MIGC_${uuid().slice(0, 8).toUpperCase()}`);
    const code = () => `FK-${uuid().slice(0, 8).toUpperCase()}`;

    await assert.rejects(
      pool.query(
        `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at, product_id)
         VALUES ($1, $2, $3, 'STANDARD', 'DRAFT', NOW(), $4)`,
        [uuid(), clientId, code(), uuid()],
      ),
      (error: { code?: string }) => error.code === '23503',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at, package_id)
         VALUES ($1, $2, $3, 'STANDARD', 'DRAFT', NOW(), $4)`,
        [uuid(), clientId, code(), uuid()],
      ),
      (error: { code?: string }) => error.code === '23503',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at, pricebook_version_id)
         VALUES ($1, $2, $3, 'STANDARD', 'DRAFT', NOW(), $4)`,
        [uuid(), clientId, code(), uuid()],
      ),
      (error: { code?: string }) => error.code === '23503',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at, currency_code)
         VALUES ($1, $2, $3, 'STANDARD', 'DRAFT', NOW(), 'XXX')`,
        [uuid(), clientId, code()],
      ),
      (error: { code?: string }) => error.code === '23503',
    );
  });

  it('valid SaaS rows carry the full commercial binding', async (t) => {
    if (!ready(t) || !pool) return;
    const clientId = await insertClient(`MIGC_${uuid().slice(0, 8).toUpperCase()}`);

    // Seed the referenced commercial records (0362/0363 tables).
    const productId = uuid();
    await pool.query(
      `INSERT INTO saas_products (id, code, name, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [productId, `FIPRD_${uuid().slice(0, 8).toUpperCase()}`, 'FK Product'],
    );
    const packageId = uuid();
    await pool.query(
      `INSERT INTO saas_packages (id, product_id, code, name, status) VALUES ($1, $2, $3, $4, 'ACTIVE')`,
      [packageId, productId, `FIPKG_${uuid().slice(0, 8).toUpperCase()}`, 'FK Package'],
    );
    const pricebookId = uuid();
    await pool.query(
      `INSERT INTO saas_pricebooks (id, code, name, currency_code, status) VALUES ($1, $2, $3, 'IDR', 'ACTIVE')`,
      [pricebookId, `FIBK_${uuid().slice(0, 8).toUpperCase()}`, 'FK Pricebook'],
    );
    const versionId = uuid();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number, status, effective_from)
       VALUES ($1, $2, 1, 'PUBLISHED', NOW())`,
      [versionId, pricebookId],
    );

    const id = uuid();
    await pool.query(
      `INSERT INTO subscriptions
         (id, client_id, code, plan_code, product_id, package_id, pricebook_version_id,
          billing_cycle, currency_code, status, starts_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'MONTHLY', 'IDR', 'ACTIVE', NOW(), 1)`,
      [
        id, clientId, `FISUB_${uuid().slice(0, 8).toUpperCase()}`, 'FIPKG', productId, packageId, versionId,
      ],
    );

    const row = await pool.query<{ billing_cycle: string; currency_code: string; version: number }>(
      `SELECT billing_cycle, currency_code, version FROM subscriptions WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0].billing_cycle, 'MONTHLY');
    assert.equal(row.rows[0].currency_code, 'IDR');
    assert.equal(row.rows[0].version, 1);

    // billing_cycle CHECK: only NULL or the three frozen values.
    await assert.rejects(
      pool.query(
        `UPDATE subscriptions SET billing_cycle = 'WEEKLY' WHERE id = $1`,
        [id],
      ),
      (error: { code?: string }) => error.code === '23514',
    );
  });

  it('creates the new indexes for the platform list filters', async (t) => {
    if (!ready(t) || !pool) return;
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'subscriptions'
          AND indexname IN ('subscriptions_product_id_idx', 'subscriptions_package_id_idx', 'subscriptions_pricebook_version_id_idx')
        ORDER BY indexname`,
    );
    assert.deepEqual(
      result.rows.map((row) => row.indexname),
      ['subscriptions_package_id_idx', 'subscriptions_pricebook_version_id_idx', 'subscriptions_product_id_idx'],
    );
  });
});
