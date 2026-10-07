import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  createSaasPackage,
  createSaasProduct,
  getSaasPackageDetail,
  getSaasProductDetail,
  listSaasPackages,
  listSaasProducts,
  updateSaasPackage,
  updateSaasProduct,
} from '../src/modules/platform-products';
import {
  createSaasPricebook,
  createSaasPricebookVersion,
  getSaasPricebookDetail,
  listSaasPricebooks,
  publishSaasPricebookVersion,
} from '../src/modules/platform-pricebooks';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55482;
const DIR = '/tmp/asentra-saas02-dom-pg';
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

let ACTOR = '';
const AUTHORITY_PRODUCT = 'platform.product.manage';
const AUTHORITY_PRICEBOOK = 'platform.pricebook.manage';

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(context: TestContext): boolean {
  if (!pool) {
    context.skip('CR-BE-SAAS-01 PART 02 test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function createProduct(overrides: Record<string, unknown> = {}) {
  return createSaasProduct(ACTOR, AUTHORITY_PRODUCT, {
    code: `PRD_${suffix()}`,
    name: 'Domain Product',
    ...overrides,
  });
}

async function auditRows(entityType: string, entityId: string, eventTypes: string[] = []) {
  assert.ok(pool);
  const result = await pool.query<{
    event_type: string;
    client_id: string | null;
    actor_user_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT event_type, client_id, actor_user_id, metadata
       FROM operational_events
      WHERE entity_type = $1 AND entity_id = $2
        AND (cardinality($3::text[]) = 0 OR event_type = ANY($3::text[]))
      ORDER BY occurred_at ASC, id ASC`,
    [entityType, entityId, eventTypes],
  );
  return result.rows;
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
  const { userService } = await import('../src/modules/users');
  const actor = await userService.createUser({
    email: `saas-actor-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'SaaS Control-Plane Actor (PART 02)',
  });
  ACTOR = actor.id;
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

describe('CR-BE-SAAS-01 PART 02 — product domain', () => {
  it('creates with normalized code and audits SAAS_PRODUCT_CREATED (platform scope)', async (t) => {
    if (!ready(t) || !pool) return;
    const product = await createProduct({
      code: `  prd_${suffix().toLowerCase()}  `,
      description: '  spaced description  ',
    });

    assert.equal(product.code, product.code.toUpperCase());
    assert.equal(product.code.startsWith('PRD_'), true);
    assert.equal(product.status, 'ACTIVE');
    assert.equal(product.description, 'spaced description');

    const rows = await auditRows('SAAS_PRODUCT', product.id, ['SAAS_PRODUCT_CREATED']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].client_id, null, 'platform-scope events have NULL client_id');
    assert.equal(rows[0].actor_user_id, ACTOR);
    assert.equal(rows[0].metadata.authority, AUTHORITY_PRODUCT);
    assert.equal((rows[0].metadata.after as { code: string }).code, product.code);
  });

  it('rejects duplicate code with 409 and invalid codes with 400', async (t) => {
    if (!ready(t)) return;
    const code = `DUP_${suffix()}`;
    await createProduct({ code });
    await assert.rejects(
      createProduct({ code }),
      (error: { code?: string }) => error.code === 'SAAS_PRODUCT_CODE_ALREADY_EXISTS',
    );
    await assert.rejects(
      createProduct({ code: '9-leading-digit' }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('updates and audits SAAS_PRODUCT_UPDATED with before/after/changedFields', async (t) => {
    if (!ready(t)) return;
    const product = await createProduct({ name: 'Before Name' });
    const updated = await updateSaasProduct(
      ACTOR,
      AUTHORITY_PRODUCT,
      product.id,
      { name: 'After Name', status: 'INACTIVE' },
    );

    assert.equal(updated.name, 'After Name');
    assert.equal(updated.status, 'INACTIVE');

    const rows = await auditRows('SAAS_PRODUCT', product.id, ['SAAS_PRODUCT_UPDATED']);
    assert.equal(rows.length, 1);
    const metadata = rows[0].metadata;
    assert.deepEqual(metadata.changedFields, ['name', 'status']);
    assert.equal((metadata.before as { name: string }).name, 'Before Name');
    assert.equal((metadata.after as { name: string }).name, 'After Name');
  });

  it('returns 404 for unknown ids', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      updateSaasProduct(ACTOR, AUTHORITY_PRODUCT, randomUUID(), { name: 'Ghost' }),
      (error: { code?: string }) => error.code === 'SAAS_PRODUCT_NOT_FOUND',
    );
  });

  it('lists with status filter and opt-in pagination', async (t) => {
    if (!ready(t)) return;
    const marker = suffix().slice(0, 6);
    const active = await createProduct({ code: `F${marker}A` });
    await updateSaasProduct(ACTOR, AUTHORITY_PRODUCT, active.id, { status: 'INACTIVE' });
    await createProduct({ code: `F${marker}B` });

    const all = await listSaasProducts({
      filters: {},
      withTotal: true,
      page: 1,
      pageSize: 100,
    });
    assert.ok(all.total >= 2 + 1); // +1 for seeded ASENTRA

    const activeOnly = await listSaasProducts({
      filters: { status: 'ACTIVE' },
      withTotal: true,
      page: 1,
      pageSize: 100,
    });
    assert.ok(
      activeOnly.records.every((product) => product.status === 'ACTIVE'),
    );
    assert.ok(
      !activeOnly.records.some((product) => product.id === active.id),
    );

    const paged = await listSaasProducts({
      filters: {},
      withTotal: true,
      page: 1,
      pageSize: 1,
    });
    assert.equal(paged.records.length, 1);
    assert.ok(paged.total !== null && paged.total >= 3);
  });

  it('detail read embeds packages', async (t) => {
    if (!ready(t)) return;
    const product = await createProduct();
    const pkg = await createPackageFor(product);
    const detail = await getSaasProductDetail(product.id);
    assert.equal(detail.product.id, product.id);
    assert.equal(detail.packages.length, 1);
    assert.equal(detail.packages[0].id, pkg.id);
    assert.ok(Array.isArray(detail.packages[0].features));
  });
});

async function createPackageFor(
  product: { id: string },
  overrides: Record<string, unknown> = {},
) {
  return createSaasPackage(ACTOR, AUTHORITY_PRODUCT, {
    productId: product.id,
    code: `PKG_${suffix()}`,
    name: 'Domain Package',
    ...overrides,
  });
}

describe('CR-BE-SAAS-01 PART 02 — package domain', () => {
  it('creates with features (canonical modules) and limits, audited SAAS_PACKAGE_CHANGED', async (t) => {
    if (!ready(t) || !pool) return;
    // The canonical capability vocabulary is the existing modules catalogue.
    await pool.query(
      `INSERT INTO modules (id, code, name) VALUES ($1, 'WORK_ORDER', 'Work Order')
       ON CONFLICT (code) DO NOTHING`,
      [randomUUID()],
    );
    const product = await createProduct();
    const pkg2 = await createPackageFor(product, {
      features: [{ capabilityCode: 'WORK_ORDER' }],
      limits: [
        { limitKey: 'building.count', limitValue: 5, unit: 'BUILDING' },
        { limitKey: 'storage.bytes', limitValue: 1073741824, unit: 'BYTE' },
      ],
    });

    const rows = await auditRows('SAAS_PACKAGE', pkg2.id, ['SAAS_PACKAGE_CHANGED']);
    assert.ok(rows.length >= 1);
    const createdRow = rows[rows.length - 1];
    assert.equal(createdRow.metadata.action, 'CREATED');
    assert.equal(createdRow.metadata.before, null);
    assert.equal(createdRow.client_id, null);

    const detail = await getSaasPackageDetail(pkg2.id);
    assert.equal(detail.features.length, 1);
    assert.equal(detail.features[0].capabilityCode, 'WORK_ORDER');
    assert.equal(detail.features[0].enabled, true);
    assert.equal(detail.limits.length, 2);
    assert.deepEqual(
      detail.limits.map((limit) => limit.limitKey).sort(),
      ['building.count', 'storage.bytes'],
    );
    // building.count sorts before storage.bytes
    assert.equal(
      detail.limits.find((limit) => limit.limitKey === 'building.count')?.limitValue,
      5,
    );
  });

  it('rejects unknown capability codes (no second feature catalog)', async (t) => {
    if (!ready(t)) return;
    const product = await createProduct();
    await assert.rejects(
      createPackageFor(product, {
        features: [{ capabilityCode: 'NOT_A_REAL_MODULE' }],
      }),
      (error: { code?: string; details?: { message: string }[] }) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.ok(
          error.details?.some((d) => d.message.includes('modules catalogue')),
        );
        return true;
      },
    );
  });

  it('rejects limit keys outside the frozen vocabulary and bad values', async (t) => {
    if (!ready(t)) return;
    const product = await createProduct();
    await assert.rejects(
      createPackageFor(product, {
        limits: [{ limitKey: 'rogue.limit', limitValue: 1, unit: 'X' } as never],
      }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      createPackageFor(product, {
        limits: [{ limitKey: 'user.count', limitValue: -1, unit: 'USER' } as never],
      }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('rejects duplicate (product, code) with 409 and unknown product with 404', async (t) => {
    if (!ready(t)) return;
    const product = await createProduct();
    const code = `EDN_${suffix()}`;
    await createPackageFor(product, { code });
    await assert.rejects(
      createPackageFor(product, { code }),
      (error: { code?: string }) => error.code === 'SAAS_PACKAGE_CODE_ALREADY_EXISTS',
    );
    await assert.rejects(
      createSaasPackage(ACTOR, AUTHORITY_PRODUCT, {
        productId: randomUUID(),
        code: `NOPROD_${suffix()}`,
        name: 'No Product',
      }),
      (error: { code?: string }) => error.code === 'SAAS_PRODUCT_NOT_FOUND',
    );
  });

  it('replaces features/limits on update and records changedFields', async (t) => {
    if (!ready(t) || !pool) return;
    await pool.query(
      `INSERT INTO modules (id, code, name) VALUES ($1, 'CAMERA', 'Camera')
       ON CONFLICT (code) DO NOTHING`,
      [randomUUID()],
    );
    const product = await createProduct();
    const pkg = await createPackageFor(product, {
      features: [{ capabilityCode: 'WORK_ORDER' }],
      limits: [{ limitKey: 'user.count', limitValue: 10, unit: 'USER' }],
    });

    const updated = await updateSaasPackage(ACTOR, AUTHORITY_PRODUCT, pkg.id, {
      features: [{ capabilityCode: 'CAMERA' }],
      limits: [{ limitKey: 'building.count', limitValue: 3, unit: 'BUILDING' }],
    });

    assert.deepEqual(
      updated.features.map((feature) => feature.capabilityCode),
      ['CAMERA'],
    );
    assert.equal(updated.limits[0].limitKey, 'building.count');

    const rows = await auditRows('SAAS_PACKAGE', pkg.id, ['SAAS_PACKAGE_CHANGED']);
    const updatedRow = rows[rows.length - 1];
    assert.equal(updatedRow.metadata.action, 'UPDATED');
    assert.deepEqual(updatedRow.metadata.changedFields, ['features', 'limits']);
    const before = updatedRow.metadata.before as { features: { capabilityCode: string }[] };
    assert.deepEqual(
      before.features.map((feature) => feature.capabilityCode),
      ['WORK_ORDER'],
    );
  });

  it('patches scalars without touching composition', async (t) => {
    if (!ready(t)) return;
    const product = await createProduct();
    const pkg = await createPackageFor(product, {
      features: [{ capabilityCode: 'WORK_ORDER' }],
    });
    const updated = await updateSaasPackage(ACTOR, AUTHORITY_PRODUCT, pkg.id, {
      description: 'Renamed edition',
      status: 'INACTIVE',
    });
    assert.equal(updated.description, 'Renamed edition');
    assert.equal(updated.status, 'INACTIVE');
    assert.equal(updated.features.length, 1);

    const rows = await auditRows('SAAS_PACKAGE', pkg.id, ['SAAS_PACKAGE_CHANGED']);
    assert.deepEqual(rows[rows.length - 1].metadata.changedFields, [
      'description',
      'status',
    ]);
  });

  it('lists packages filtered by product and status', async (t) => {
    if (!ready(t)) return;
    const product = await createProduct();
    await createPackageFor(product);
    const other = await createProduct();
    await createPackageFor(other);

    const byProduct = await listSaasPackages({
      filters: { productId: product.id },
      withTotal: true,
      page: 1,
      pageSize: 50,
    });
    assert.equal(byProduct.total, 1);
    assert.equal(byProduct.records[0].productId, product.id);

    const byStatus = await listSaasPackages({
      filters: { status: 'INACTIVE' },
      withTotal: true,
      page: 1,
      pageSize: 50,
    });
    assert.ok(byStatus.records.every((packageRecord) => packageRecord.status === 'INACTIVE'));
  });
});

describe('CR-BE-SAAS-01 PART 02 — pricebook domain', () => {
  async function seedBookDomain() {
    const product = await createProduct();
    const pkg = await createPackageFor(product);
    const book = await createSaasPricebook(ACTOR, AUTHORITY_PRICEBOOK, {
      code: `BK_${suffix()}`,
      name: 'Domain Pricebook',
      currencyCode: 'idr',
    });
    return { product, pkg, book };
  }

  it('creates a pricebook with normalized currency and audits SAAS_PRICEBOOK_CREATED', async (t) => {
    if (!ready(t) || !pool) return;
    const book = await createSaasPricebook(ACTOR, AUTHORITY_PRICEBOOK, {
      code: `bk2_${suffix().toLowerCase()}`,
      name: 'Normalized Book',
      currencyCode: 'idr',
    });
    assert.equal(book.code, book.code.toUpperCase());
    assert.equal(book.currencyCode, 'IDR');
    assert.equal(book.status, 'ACTIVE');

    const rows = await auditRows('SAAS_PRICEBOOK', book.id, ['SAAS_PRICEBOOK_CREATED']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].client_id, null);
    assert.equal(rows[0].metadata.authority, AUTHORITY_PRICEBOOK);

    await assert.rejects(
      createSaasPricebook(ACTOR, AUTHORITY_PRICEBOOK, {
        code: book.code.toLowerCase(),
        name: 'Dup',
        currencyCode: 'IDR',
      }),
      (error: { code?: string }) => error.code === 'SAAS_PRICEBOOK_CODE_ALREADY_EXISTS',
    );
  });

  it('rejects unknown or inactive currencies', async (t) => {
    if (!ready(t)) return;
    await assert.rejects(
      createSaasPricebook(ACTOR, AUTHORITY_PRICEBOOK, {
        code: `CUR_${suffix()}`,
        name: 'Bad Currency',
        currencyCode: 'ZZZ',
      }),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('creates DRAFT versions with monotonic numbering and default currency', async (t) => {
    if (!ready(t) || !pool) return;
    const { product, pkg, book } = await seedBookDomain();

    const v1 = await createSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, book.id, {
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      items: [
        {
          productId: product.id,
          packageId: pkg.id,
          billingCycle: 'MONTHLY',
          basePrice: 100000,
          includedBuildingCount: 2,
          additionalBuildingPrice: 25000,
        },
        {
          productId: product.id,
          packageId: null,
          billingCycle: 'ANNUAL',
          basePrice: 1000000,
        },
      ],
    });
    assert.equal(v1.versionNumber, 1);
    assert.equal(v1.status, 'DRAFT');
    assert.equal(v1.items.length, 2);
    assert.equal(v1.items[0].currencyCode, 'IDR', 'item inherits the book default currency');
    assert.equal(v1.items[0].includedBuildingCount, 2);
    assert.equal(v1.items[1].includedBuildingCount, 0, 'defaults to 0');
    assert.equal(v1.items[1].additionalBuildingPrice, 0, 'defaults to 0');

    const v2 = await createSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, book.id, {
      effectiveFrom: '2027-01-01T00:00:00.000Z',
      items: [
        { productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 110000 },
      ],
    });
    assert.equal(v2.versionNumber, 2, 'monotonic version numbers');

    const rows = await auditRows('SAAS_PRICEBOOK', v2.id, ['SAAS_PRICE_CHANGED']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.action, 'DRAFT_VERSION_CREATED');
  });

  it('rejects items referencing a package of another product and duplicate keys', async (t) => {
    if (!ready(t)) return;
    const { product, pkg, book } = await seedBookDomain();
    const otherProduct = await createProduct();
    const otherPkg = await createPackageFor(otherProduct);

    await assert.rejects(
      createSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, book.id, {
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        items: [
          { productId: product.id, packageId: otherPkg.id, billingCycle: 'MONTHLY', basePrice: 1 },
        ],
      }),
      (error: { code?: string; details?: { message: string }[] }) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.ok(error.details?.some((d) => d.message.includes('does not belong')));
        return true;
      },
    );

    await assert.rejects(
      createSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, book.id, {
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        items: [
          { productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 1 },
          { productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 2 },
        ],
      }),
      (error: { code?: string; details?: { message: string }[] }) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.ok(error.details?.some((d) => d.message.includes('duplicate')));
        return true;
      },
    );
  });

  it('publishes: DRAFT → PUBLISHED + supersede, idempotent replay, frozen state rule', async (t) => {
    if (!ready(t) || !pool) return;
    const { product, pkg, book } = await seedBookDomain();

    const v1 = await createSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, book.id, {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      items: [{ productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 100 }],
    });
    const key1 = `pub-${suffix()}`;
    const p1 = await publishSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, v1.id, key1);
    assert.equal(p1.replayed, false);
    assert.equal(p1.data.status, 'PUBLISHED');
    assert.ok(p1.data.publishedAt);
    assert.equal(p1.data.publishedByUserId, ACTOR);

    // Faithful replay: stored success, no second publish.
    const replay = await publishSaasPricebookVersion(
      ACTOR,
      AUTHORITY_PRICEBOOK,
      v1.id,
      key1,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.id, v1.id);

    // Same key, different version id → 409 IDEMPOTENCY_CONFLICT.
    const v2 = await createSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, book.id, {
      effectiveFrom: '2027-01-01T00:00:00.000Z',
      items: [{ productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 200 }],
    });
    await assert.rejects(
      publishSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, v2.id, key1),
      (error: { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT',
    );

    // Publish v2 → v1 is superseded with effective_to = v2.effective_from.
    const p2 = await publishSaasPricebookVersion(
      ACTOR,
      AUTHORITY_PRICEBOOK,
      v2.id,
      `pub-${suffix()}`,
    );
    assert.equal(p2.data.status, 'PUBLISHED');

    const detail = await getSaasPricebookDetail(book.id);
    const version1 = detail.versions.find((version) => version.id === v1.id);
    const version2 = detail.versions.find((version) => version.id === v2.id);
    assert.equal(version1?.status, 'SUPERSEDED');
    assert.ok(version1?.effectiveTo instanceof Date);
    assert.equal(version1?.effectiveTo.toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(version2?.status, 'PUBLISHED');
    assert.equal(version2?.effectiveTo, null);
    // Single-publish invariant: exactly one PUBLISHED version.
    assert.equal(
      detail.versions.filter((version) => version.status === 'PUBLISHED').length,
      1,
    );

    // Publish audit: action PUBLISHED + supersede details.
    const rows = await auditRows('SAAS_PRICEBOOK', v2.id, ['SAAS_PRICE_CHANGED']);
    const publishedRow = rows[rows.length - 1];
    assert.equal(publishedRow.metadata.action, 'PUBLISHED');
    assert.equal(publishedRow.metadata.supersededVersionId, v1.id);
    assert.equal((publishedRow.metadata.after as { status: string }).status, 'PUBLISHED');

    // Frozen state rule: publishing a PUBLISHED version is rejected (409).
    await assert.rejects(
      publishSaasPricebookVersion(
        ACTOR,
        AUTHORITY_PRICEBOOK,
        v2.id,
        `pub-${suffix()}`,
      ),
      (error: { code?: string }) =>
        error.code === 'SAAS_PRICEBOOK_VERSION_NOT_PUBLISHABLE',
    );
    // And a SUPERSEDED version is rejected too.
    await assert.rejects(
      publishSaasPricebookVersion(
        ACTOR,
        AUTHORITY_PRICEBOOK,
        v1.id,
        `pub-${suffix()}`,
      ),
      (error: { code?: string }) =>
        error.code === 'SAAS_PRICEBOOK_VERSION_NOT_PUBLISHABLE',
    );
  });

  it('published versions are immutable at the database level (historical pricing preserved)', async (t) => {
    if (!ready(t) || !pool) return;
    const { product, pkg, book } = await seedBookDomain();
    const version = await createSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, book.id, {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      items: [{ productId: product.id, packageId: pkg.id, billingCycle: 'MONTHLY', basePrice: 100 }],
    });
    await publishSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, version.id, `pub-${suffix()}`);

    // Direct restatement of a published version is impossible.
    await assert.rejects(
      pool.query(
        `UPDATE saas_pricebook_versions SET effective_from = NOW() WHERE id = $1`,
        [version.id],
      ),
      /published pricebook versions are immutable/,
    );
    const item = (
      await pool.query<{ id: string }>(
        `SELECT id FROM saas_price_items WHERE pricebook_version_id = $1`,
        [version.id],
      )
    ).rows[0];
    await assert.rejects(
      pool.query(`UPDATE saas_price_items SET base_price = 1 WHERE id = $1`, [item.id]),
      /price items of published pricebook versions are immutable/,
    );
  });

  it('lists pricebooks with status filter and 404s on unknown ids', async (t) => {
    if (!ready(t)) return;
    const book = await createSaasPricebook(ACTOR, AUTHORITY_PRICEBOOK, {
      code: `LST_${suffix()}`,
      name: 'List Book',
      currencyCode: 'USD',
    });
    const list = await listSaasPricebooks({
      filters: { status: 'ACTIVE' },
      withTotal: true,
      page: 1,
      pageSize: 50,
    });
    assert.ok(list.records.some((record) => record.id === book.id));
    assert.ok(list.records.every((record) => record.status === 'ACTIVE'));

    await assert.rejects(
      getSaasPricebookDetail(randomUUID()),
      (error: { code?: string }) => error.code === 'SAAS_PRICEBOOK_NOT_FOUND',
    );
    await assert.rejects(
      publishSaasPricebookVersion(ACTOR, AUTHORITY_PRICEBOOK, randomUUID(), `pub-${suffix()}`),
      (error: { code?: string }) => error.code === 'SAAS_PRICEBOOK_VERSION_NOT_FOUND',
    );
  });
});
