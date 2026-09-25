import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55481;
const DIR = '/tmp/asentra-saas02-mig-pg';
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
    context.skip('CR-BE-SAAS-01 PART 02 test database unavailable');
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

describe('CR-BE-SAAS-01 PART 02 — migration 0362: SaaS product catalog schema', () => {
  it('creates the catalog tables with the frozen shapes', async (t) => {
    if (!ready(t) || !pool) return;
    const result = await pool.query<{ table: string; column: string; type: string; nullable: string }>(
      `SELECT t.table_name AS table, c.column_name AS column,
              c.data_type AS type, c.is_nullable AS nullable
         FROM information_schema.columns c
         JOIN (VALUES ('saas_products'), ('saas_packages'),
                      ('package_features'), ('package_limits')) AS t(table_name)
           ON t.table_name = c.table_name
        ORDER BY t.table_name, c.ordinal_position`,
    );
    const cols = new Map<string, { type: string; nullable: string }>();
    for (const row of result.rows) cols.set(`${row.table}.${row.column}`, { type: row.type, nullable: row.nullable });

    for (const expected of [
      'saas_products.id', 'saas_products.code', 'saas_products.name', 'saas_products.status',
      'saas_packages.id', 'saas_packages.product_id', 'saas_packages.code', 'saas_packages.status',
      'package_features.id', 'package_features.package_id', 'package_features.capability_code', 'package_features.enabled',
      'package_limits.id', 'package_limits.package_id', 'package_limits.limit_key', 'package_limits.limit_value', 'package_limits.unit',
    ]) {
      assert.ok(cols.has(expected), `${expected} must exist`);
    }
    assert.equal(cols.get('package_limits.limit_value')?.type, 'bigint');
    assert.equal(cols.get('package_features.enabled')?.type, 'boolean');
  });

  it('seeds the ASENTRA product and the four frozen edition codes', async (t) => {
    if (!ready(t) || !pool) return;
    const product = await pool.query<{ code: string; status: string }>(
      `SELECT code, status FROM saas_products WHERE code = 'ASENTRA'`,
    );
    assert.equal(product.rows.length, 1);
    assert.equal(product.rows[0].status, 'ACTIVE');

    const packages = await pool.query<{ code: string; status: string }>(
      `SELECT code, status FROM saas_packages
        WHERE product_id = (SELECT id FROM saas_products WHERE code = 'ASENTRA')
        ORDER BY code`,
    );
    assert.deepEqual(
      packages.rows.map((row) => row.code),
      ['ENTERPRISE', 'PROFESSIONAL', 'STANDARD', 'STARTER'],
    );
    assert.ok(packages.rows.every((row) => row.status === 'ACTIVE'));
  });

  it('enforces code uniqueness on products and per-product on packages', async (t) => {
    if (!ready(t) || !pool) return;
    const productId = uuid();
    await pool.query(
      `INSERT INTO saas_products (id, code, name) VALUES ($1, 'TESTPROD', 'Test Product')`,
      [productId],
    );
    await assert.rejects(
      pool.query(`INSERT INTO saas_products (id, code, name) VALUES ($1, 'TESTPROD', 'Dup')`, [uuid()]),
      /saas_products_code_unique/,
    );

    await pool.query(
      `INSERT INTO saas_packages (id, product_id, code, name) VALUES ($1, $2, 'STARTER', 'Dup Starter')`,
      [uuid(), productId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_packages (id, product_id, code, name) VALUES ($1, $2, 'STARTER', 'Dup 2')`,
        [uuid(), productId],
      ),
      /saas_packages_product_code_unique/,
    );
    // Same code on a DIFFERENT product is allowed.
    const otherProductId = uuid();
    await pool.query(
      `INSERT INTO saas_products (id, code, name) VALUES ($1, 'OTHERPROD', 'Other')`,
      [otherProductId],
    );
    await pool.query(
      `INSERT INTO saas_packages (id, product_id, code, name) VALUES ($1, $2, 'STARTER', 'Other Starter')`,
      [uuid(), otherProductId],
    );
  });

  it('references the canonical modules catalogue for capability_code', async (t) => {
    if (!ready(t) || !pool) return;
    const packageId = uuid();
    const productId = uuid();
    await pool.query(`INSERT INTO saas_products (id, code, name) VALUES ($1, 'MODPROD', 'Mod')`, [productId]);
    await pool.query(
      `INSERT INTO saas_packages (id, product_id, code, name) VALUES ($1, $2, 'BASE', 'Base')`,
      [packageId, productId],
    );
    await pool.query(
      `INSERT INTO modules (id, code, name) VALUES ($1, 'SECURITY', 'Security')`,
      [uuid()],
    );
    await pool.query(
      `INSERT INTO package_features (id, package_id, capability_code) VALUES ($1, $2, 'SECURITY')`,
      [uuid(), packageId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO package_features (id, package_id, capability_code) VALUES ($1, $2, 'NOT_A_MODULE')`,
        [uuid(), packageId],
      ),
      /package_features_capability_code_fkey/,
    );
  });

  it('freezes the package limit vocabulary and domain rules', async (t) => {
    if (!ready(t) || !pool) return;
    const packageId = uuid();
    const productId = uuid();
    await pool.query(`INSERT INTO saas_products (id, code, name) VALUES ($1, 'LIMPROD', 'Lim')`, [productId]);
    await pool.query(
      `INSERT INTO saas_packages (id, product_id, code, name) VALUES ($1, $2, 'BASE', 'Base')`,
      [packageId, productId],
    );

    for (const key of [
      'building.count',
      'user.count',
      'active.asset.count',
      'monthly.wo.count',
      'storage.bytes',
      'api.requests',
      'integration.count',
      'ai.usage',
    ]) {
      await pool.query(
        `INSERT INTO package_limits (id, package_id, limit_key, limit_value, unit)
         VALUES ($1, $2, $3, 10, 'COUNT')`,
        [uuid(), packageId, key],
      );
    }

    await assert.rejects(
      pool.query(
        `INSERT INTO package_limits (id, package_id, limit_key, limit_value, unit)
         VALUES ($1, $2, 'rogue.limit', 10, 'COUNT')`,
        [uuid(), packageId],
      ),
      /package_limits_key_check/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO package_limits (id, package_id, limit_key, limit_value, unit)
         VALUES ($1, $2, 'user.count', 10, 'COUNT')`,
        [uuid(), packageId],
      ),
      /package_limits_package_key_unique/,
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO package_limits (id, package_id, limit_key, limit_value, unit)
         VALUES ($1, $2, 'storage.bytes', -1, 'BYTE')`,
        [uuid(), packageId],
      ),
      /package_limits_value_check/,
    );
  });

  it('keeps the business-plane registry valid (no destructive change)', async (t) => {
    if (!ready(t) || !pool) return;
    // Legacy client row still valid (PART 01/legacy statuses preserved).
    await pool.query(
      `INSERT INTO clients (id, code, name, status) VALUES ($1, $2, 'Legacy', 'ACTIVE')`,
      [uuid(), `LEGACY_${randomUUID().slice(0, 6).toUpperCase()}`],
    );
    // Existing module_entitlements structure untouched.
    const ent = await pool.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns
        WHERE table_name = 'module_entitlements' ORDER BY ordinal_position`,
    );
    const columns = ent.rows.map((row) => row.column);
    for (const expected of ['subscription_id', 'module_id', 'status', 'starts_at', 'ends_at']) {
      assert.ok(columns.includes(expected), `module_entitlements.${expected} preserved`);
    }
  });
});

describe('CR-BE-SAAS-01 PART 02 — migration 0363: versioned pricebook schema', () => {
  async function seedBook(): Promise<{ bookId: string; productId: string; packageId: string }> {
    assert.ok(pool);
    const s = randomUUID().slice(0, 6).toUpperCase();
    const bookId = uuid();
    const productId = uuid();
    const packageId = uuid();
    await pool.query(`INSERT INTO saas_pricebooks (id, code, name, currency_code) VALUES ($1, $2, 'Book', 'IDR')`, [bookId, `BK_${s}`]);
    await pool.query(`INSERT INTO saas_products (id, code, name) VALUES ($1, $2, 'Product')`, [productId, `PKB_${s}`]);
    await pool.query(
      `INSERT INTO saas_packages (id, product_id, code, name) VALUES ($1, $2, 'STD', 'Standard')`,
      [packageId, productId],
    );
    return { bookId, productId, packageId };
  }

  it('creates the pricebook tables with the frozen shapes', async (t) => {
    if (!ready(t) || !pool) return;
    const result = await pool.query<{ column: string; type: string }>(
      `SELECT column_name AS column, data_type AS type
         FROM information_schema.columns WHERE table_name = 'saas_price_items'
        ORDER BY ordinal_position`,
    );
    const cols = new Map(result.rows.map((row) => [row.column, row.type]));
    assert.equal(cols.get('base_price'), 'numeric');
    assert.equal(cols.get('included_building_count'), 'integer');
    assert.equal(cols.get('additional_building_price'), 'numeric');

    const numericMeta = await pool.query<{ precision: number; scale: number }>(
      `SELECT numeric_precision AS precision, numeric_scale AS scale
         FROM information_schema.columns
        WHERE table_name = 'saas_price_items' AND column_name = 'base_price'`,
    );
    assert.equal(numericMeta.rows[0].precision, 18);
    assert.equal(numericMeta.rows[0].scale, 2);
  });

  it('uses the canonical currency authority (no second currency list)', async (t) => {
    if (!ready(t) || !pool) return;
    const { bookId } = await seedBook();
    await assert.rejects(
      pool.query(
        `UPDATE saas_pricebooks SET currency_code = 'XXX' WHERE id = $1`,
        [bookId],
      ),
      /saas_pricebooks_currency_code_fkey/,
    );
    const items = await pool.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns
        WHERE table_name = 'saas_price_items' AND column_name = 'currency_code'`,
    );
    assert.equal(items.rows.length, 1);
  });

  it('rejects invalid billing cycles and negative prices', async (t) => {
    if (!ready(t) || !pool) return;
    const { bookId, productId } = await seedBook();
    const versionId = uuid();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number) VALUES ($1, $2, 1)`,
      [versionId, bookId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, currency_code, billing_cycle, base_price)
         VALUES ($1, $2, $3, 'IDR', 'WEEKLY', 10)`,
        [uuid(), versionId, productId],
      ),
      /saas_price_items_cycle_check/,
    );
    for (const cycle of ['MONTHLY', 'ANNUAL', 'CUSTOM']) {
      await pool.query(
        `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, currency_code, billing_cycle, base_price)
         VALUES ($1, $2, $3, 'IDR', $4, 10)`,
        [uuid(), versionId, productId, cycle],
      );
    }
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, currency_code, billing_cycle, base_price)
         VALUES ($1, $2, $3, 'IDR', 'MONTHLY', -1)`,
        [uuid(), versionId, productId],
      ),
      /saas_price_items_base_price_check/,
    );
  });

  it('uniquely keys items per (version, product, package, cycle) incl. NULL package', async (t) => {
    if (!ready(t) || !pool) return;
    const { bookId, productId, packageId } = await seedBook();
    const versionId = uuid();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number) VALUES ($1, $2, 1)`,
      [versionId, bookId],
    );
    await pool.query(
      `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, package_id, currency_code, billing_cycle, base_price)
       VALUES ($1, $2, $3, $4, 'IDR', 'MONTHLY', 10)`,
      [uuid(), versionId, productId, packageId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, package_id, currency_code, billing_cycle, base_price)
         VALUES ($1, $2, $3, $4, 'IDR', 'MONTHLY', 20)`,
        [uuid(), versionId, productId, packageId],
      ),
      /saas_price_items_version_product_package_cycle_unique/,
    );
    // Two platform-wide (NULL package) items for the same product+cycle: rejected.
    await pool.query(
      `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, currency_code, billing_cycle, base_price)
       VALUES ($1, $2, $3, 'IDR', 'MONTHLY', 5)`,
      [uuid(), versionId, productId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, currency_code, billing_cycle, base_price)
         VALUES ($1, $2, $3, 'IDR', 'MONTHLY', 6)`,
        [uuid(), versionId, productId],
      ),
      /saas_price_items_version_product_package_cycle_unique/,
    );
  });

  it('enforces the single-publish invariant (one PUBLISHED version per pricebook)', async (t) => {
    if (!ready(t) || !pool) return;
    const { bookId } = await seedBook();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number, status)
       VALUES ($1, $2, 1, 'PUBLISHED')`,
      [uuid(), bookId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number, status)
         VALUES ($1, $2, 2, 'PUBLISHED')`,
        [uuid(), bookId],
      ),
      /saas_pricebook_versions_single_published/,
    );
  });

  it('keeps PUBLISHED versions immutable (only the frozen supersede shape is allowed)', async (t) => {
    if (!ready(t) || !pool) return;
    const { bookId } = await seedBook();
    const v1 = uuid();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number, status, effective_from, published_at, published_by_user_id)
       VALUES ($1, $2, 1, 'PUBLISHED', NOW() - INTERVAL '1 month', NOW(), NULL)`,
      [v1, bookId],
    );

    // Any non-supersede update of a PUBLISHED row is rejected.
    await assert.rejects(
      pool.query(`UPDATE saas_pricebook_versions SET effective_from = NOW() WHERE id = $1`, [v1]),
      /published pricebook versions are immutable/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM saas_pricebook_versions WHERE id = $1`, [v1]),
      /published pricebook versions are immutable/,
    );

    // The frozen supersede shape (status → SUPERSEDED + effective_to) is allowed.
    await pool.query(
      `UPDATE saas_pricebook_versions SET status = 'SUPERSEDED', effective_to = NOW() WHERE id = $1`,
      [v1],
    );

    // SUPERSEDED is terminal.
    await assert.rejects(
      pool.query(`UPDATE saas_pricebook_versions SET status = 'DRAFT' WHERE id = $1`, [v1]),
      /superseded pricebook versions are immutable/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM saas_pricebook_versions WHERE id = $1`, [v1]),
      /superseded pricebook versions are immutable/,
    );

    // DRAFT versions stay editable until published.
    const draft = uuid();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number, effective_from)
       VALUES ($1, $2, 2, NOW())`,
      [draft, bookId],
    );
    await pool.query(`UPDATE saas_pricebook_versions SET effective_from = NOW() - INTERVAL '1 day' WHERE id = $1`, [draft]);
  });

  it('keeps price items immutable with their PUBLISHED version', async (t) => {
    if (!ready(t) || !pool) return;
    const { bookId, productId } = await seedBook();
    const versionId = uuid();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number, status)
       VALUES ($1, $2, 1, 'PUBLISHED')`,
      [versionId, bookId],
    );
    const itemId = uuid();
    await pool.query(
      `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, currency_code, billing_cycle, base_price)
       VALUES ($1, $2, $3, 'IDR', 'MONTHLY', 10)`,
      [itemId, versionId, productId],
    );
    await assert.rejects(
      pool.query(`UPDATE saas_price_items SET base_price = 99 WHERE id = $1`, [itemId]),
      /price items of published pricebook versions are immutable/,
    );
    await assert.rejects(
      pool.query(`DELETE FROM saas_price_items WHERE id = $1`, [itemId]),
      /price items of published pricebook versions are immutable/,
    );

    // DRAFT version items remain editable.
    const draftId = uuid();
    const draftItemId = uuid();
    await pool.query(
      `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number) VALUES ($1, $2, 2)`,
      [draftId, bookId],
    );
    await pool.query(
      `INSERT INTO saas_price_items (id, pricebook_version_id, product_id, currency_code, billing_cycle, base_price)
       VALUES ($1, $2, $3, 'IDR', 'MONTHLY', 10)`,
      [draftItemId, draftId, productId],
    );
    await pool.query(`UPDATE saas_price_items SET base_price = 20 WHERE id = $1`, [draftItemId]);
  });

  it('validates the effective period (effective_to after effective_from)', async (t) => {
    if (!ready(t) || !pool) return;
    const { bookId } = await seedBook();
    await assert.rejects(
      pool.query(
        `INSERT INTO saas_pricebook_versions (id, pricebook_id, version_number, effective_from, effective_to)
         VALUES ($1, $2, 1, NOW(), NOW() - INTERVAL '1 day')`,
        [uuid(), bookId],
      ),
      /saas_pricebook_versions_period_check/,
    );
  });
});
