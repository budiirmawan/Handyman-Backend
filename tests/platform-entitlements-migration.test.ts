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
 * CR-BE-SAAS-01 PART 04 — migration 0365 compatibility tests.
 *
 * Proves the `module_entitlements` extension (frozen §12.1 / §5 seam map:
 * "extend, never replaced") is additive and non-destructive: legacy rows
 * stay valid (source defaults to MANUAL — no rewrite), the frozen source
 * vocabulary CHECK admits exactly the five frozen values, `limit_value`
 * is a nullable BIGINT with 0 valid (frozen: 0 = unlimited), and the
 * one-active-per-(subscription, module) partial unique index from 0016 is
 * preserved across sources.
 */

const PORT = 55487;
const DIR = '/tmp/asentra-saas04-mig-pg';
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
    context.skip('CR-BE-SAAS-01 PART 04 test database unavailable');
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

async function insertModule(code: string): Promise<string> {
  assert.ok(pool);
  const id = uuid();
  await pool.query(
    `INSERT INTO modules (id, code, name, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [id, code, `Migration Module ${code}`],
  );
  return id;
}

async function insertSubscription(code: string): Promise<string> {
  assert.ok(pool);
  const clientId = uuid();
  await pool.query(
    `INSERT INTO clients (id, code, name) VALUES ($1, $2, $3)`,
    [clientId, code, `Migration Client ${code}`],
  );
  const id = uuid();
  await pool.query(
    `INSERT INTO subscriptions (id, client_id, code, plan_code, status, starts_at)
     VALUES ($1, $2, $3, 'STANDARD', 'ACTIVE', NOW())`,
    [id, clientId, code],
  );
  return id;
}

async function insertEntitlement(subId: string, moduleId: string): Promise<void> {
  assert.ok(pool);
  await pool.query(
    `INSERT INTO module_entitlements (id, subscription_id, module_id, status, starts_at)
     VALUES ($1, $2, $3, 'ACTIVE', NOW())`,
    [uuid(), subId, moduleId],
  );
}

describe('CR-BE-SAAS-01 PART 04 — migration 0365: module_entitlements SaaS extension', () => {
  it('adds source + limit_value additively; every legacy column remains', async (t) => {
    if (!ready(t) || !pool) return;
    const result = await pool.query<{
      column: string;
      type: string;
      nullable: string;
      default: string | null;
    }>(
      `SELECT c.column_name AS column, c.data_type AS type,
              c.is_nullable AS nullable, c.column_default AS default
         FROM information_schema.columns c
        WHERE c.table_name = 'module_entitlements'
        ORDER BY c.ordinal_position`,
    );
    const cols = new Map<string, { type: string; nullable: string; default: string | null }>();
    for (const row of result.rows) {
      cols.set(row.column, { type: row.type, nullable: row.nullable, default: row.default });
    }

    for (const legacyColumn of [
      'id', 'subscription_id', 'module_id', 'status', 'starts_at', 'ends_at',
      'created_at', 'updated_at',
    ]) {
      assert.ok(cols.has(legacyColumn), `legacy column ${legacyColumn} must remain`);
    }
    const source = cols.get('source');
    assert.ok(source, 'source must exist');
    assert.equal(source.type, 'text');
    assert.equal(source.nullable, 'NO');
    assert.ok(source.default?.includes('MANUAL'), 'source defaults to MANUAL');
    const limitValue = cols.get('limit_value');
    assert.ok(limitValue, 'limit_value must exist');
    assert.equal(limitValue.type, 'bigint');
    assert.equal(limitValue.nullable, 'YES', 'limit_value is nullable');
  });

  it('legacy rows stay valid: pre-extension shape inserts, source defaults to MANUAL, limit_value NULL', async (t) => {
    if (!ready(t) || !pool) return;
    const moduleId = await insertModule(`MIGM_${uuid().slice(0, 8).toUpperCase()}`);
    const subscriptionId = await insertSubscription(`MIGS_${uuid().slice(0, 8).toUpperCase()}`);

    // Insert in the EXACT pre-0365 shape (no source / limit_value at all).
    await insertEntitlement(subscriptionId, moduleId);

    const row = await pool.query<{ source: string; limit_value: string | null; status: string }>(
      `SELECT source, limit_value, status FROM module_entitlements
        WHERE subscription_id = $1`,
      [subscriptionId],
    );
    assert.equal(row.rows.length, 1, 'legacy row readable');
    assert.equal(row.rows[0].source, 'MANUAL', 'default provenance, no rewrite');
    assert.equal(row.rows[0].limit_value, null);
    assert.equal(row.rows[0].status, 'ACTIVE');
  });

  it('source CHECK admits exactly the five frozen §12.1 values and rejects anything else', async (t) => {
    if (!ready(t) || !pool) return;
    const moduleId = await insertModule(`MIGC_${uuid().slice(0, 8).toUpperCase()}`);
    const subscriptionId = await insertSubscription(`MIGD_${uuid().slice(0, 8).toUpperCase()}`);

    for (const source of ['PACKAGE', 'ADD_ON', 'OVERRIDE', 'PROMOTION', 'MANUAL']) {
      await pool.query(
        `INSERT INTO module_entitlements (id, subscription_id, module_id, status, starts_at, source)
         VALUES ($1, $2, $3, 'EXPIRED', NOW(), $4)`,
        [uuid(), subscriptionId, moduleId, source],
      );
    }
    await assert.rejects(
      pool.query(
        `INSERT INTO module_entitlements (id, subscription_id, module_id, status, starts_at, source)
         VALUES ($1, $2, $3, 'EXPIRED', NOW(), 'GIFT')`,
        [uuid(), subscriptionId, moduleId],
      ),
      (error: { code?: string }) => error.code === '23514',
    );
  });

  it('limit_value accepts NULL and 0 (frozen: 0 = unlimited) and rejects negatives', async (t) => {
    if (!ready(t) || !pool) return;
    const moduleId = await insertModule(`MIGL_${uuid().slice(0, 8).toUpperCase()}`);
    const subscriptionId = await insertSubscription(`MIGE_${uuid().slice(0, 8).toUpperCase()}`);

    const zero = uuid();
    await pool.query(
      `INSERT INTO module_entitlements (id, subscription_id, module_id, status, starts_at, limit_value)
       VALUES ($1, $2, $3, 'EXPIRED', NOW(), 0)`,
      [zero, subscriptionId, moduleId],
    );
    const row = await pool.query<{ limit_value: string }>(
      `SELECT limit_value FROM module_entitlements WHERE id = $1`,
      [zero],
    );
    assert.equal(row.rows[0].limit_value, '0', '0 (unlimited) is a valid explicit limit');

    await assert.rejects(
      pool.query(
        `INSERT INTO module_entitlements (id, subscription_id, module_id, status, starts_at, limit_value)
         VALUES ($1, $2, $3, 'EXPIRED', NOW(), -1)`,
        [uuid(), subscriptionId, moduleId],
      ),
      (error: { code?: string }) => error.code === '23514',
    );
  });

  it('the 0016 one-active-per-(subscription, module) unique index is preserved ACROSS sources', async (t) => {
    if (!ready(t) || !pool) return;
    const moduleId = await insertModule(`MIGU_${uuid().slice(0, 8).toUpperCase()}`);
    const subscriptionId = await insertSubscription(`MIGF_${uuid().slice(0, 8).toUpperCase()}`);

    await insertEntitlement(subscriptionId, moduleId);
    await assert.rejects(
      pool.query(
        `INSERT INTO module_entitlements (id, subscription_id, module_id, status, starts_at, source)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), 'PACKAGE')`,
        [uuid(), subscriptionId, moduleId],
      ),
      (error: { code?: string }) => error.code === '23505',
    );

    // A second ACTIVE for a DIFFERENT module is fine (same subscription).
    const otherModuleId = await insertModule(`MIGV_${uuid().slice(0, 8).toUpperCase()}`);
    await insertEntitlement(subscriptionId, otherModuleId);
  });

  it('creates the package-reconciliation index; both indexes exist', async (t) => {
    if (!ready(t) || !pool) return;
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'module_entitlements'
          AND indexname IN ('module_entitlements_one_active_per_sub_module',
                            'module_entitlements_subscription_package_idx')
        ORDER BY indexname`,
    );
    assert.deepEqual(
      result.rows.map((row) => row.indexname),
      ['module_entitlements_one_active_per_sub_module', 'module_entitlements_subscription_package_idx'],
    );
  });
});
