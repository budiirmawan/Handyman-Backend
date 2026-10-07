import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { propertyService } from '../src/modules/properties';
import { vendorService } from '../src/modules/vendors';
import {
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PRICE-01 PART 01 — Price Authority Foundation.
 *
 * Deliberately excludes resolution/lookup (PART 02), vendor-tier precedence
 * proof (PART 03), RFQ comparison integration (PART 04), deviation/override
 * execution (PART 05), OpenAPI (PART 06), SERVICE source mode, UOM
 * conversion, FX, PO/commitment behavior, schedulers, and backfill.
 *
 * Covered here: migration/model shape, lifecycle, overlap + concurrency,
 * currency/UOM/Client/Building/Vendor validation, permissions/seed wiring,
 * Client/Building isolation, and operational-event audit.
 */

const DB_PORT = 55494;
const DATA_DIR = '/tmp/asentra-price01-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE price_catalog_entries, operational_events, inventory_items,
      vendors, units_of_measure, buildings, properties, clients, users, roles,
      permissions CASCADE
  `);

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EMBEDDED_DATABASE) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  pg = null;
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function auth(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();

async function fixture(assignUserId: string | null = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Price Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Price Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Price Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function makeItem(clientId: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `ITEM_${suffix()}`,
    name: 'Reference-priced material',
    itemType: 'MATERIAL',
  });
}

async function makeUom(clientId: string, code = `EA${suffix()}`) {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, code.slice(0, 12), 'Each', 'ea', 'COUNT'],
  );
  return { id, clientId, code };
}

async function makeVendor(clientId: string) {
  const vendor = await vendorService.createVendor({
    clientId,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Price Test Vendor',
  });
  return vendor;
}

type Body = Record<string, unknown>;

function entryBody(
  fixtureData: Awaited<ReturnType<typeof fixture>>,
  item: { id: string },
  uom: { id: string },
  overrides: Body = {},
): Body {
  return {
    clientId: fixtureData.client.id,
    itemId: item.id,
    uomId: uom.id,
    currency: 'IDR',
    unitPrice: 1250.5,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function createEntry(body: Body, token = adminToken) {
  return api()
    .post('/api/v1/price-catalog/entries')
    .set(auth(token))
    .set('Idempotency-Key', `IDEM_${suffix()}_${randomUUID()}`)
    .send(body);
}

async function activateEntry(id: string, token = adminToken) {
  return api()
    .post(`/api/v1/price-catalog/entries/${id}/activate`)
    .set(auth(token))
    .send({});
}

async function replaceEntry(id: string, body: Body, token = adminToken) {
  return api()
    .post(`/api/v1/price-catalog/entries/${id}/replace`)
    .set(auth(token))
    .set('Idempotency-Key', `REPL_${suffix()}_${randomUUID()}`)
    .send(body);
}

async function eventCount(eventType: string, entityId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM operational_events
      WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('CR-BE-PRICE-01 PART 01 — create + lifecycle', () => {
  it('creates a DRAFT entry and replays idempotency safely', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const body = entryBody(fx, item, uom, { vendorId: null, buildingId: null });

    const key = `IDEM_${suffix()}`;
    const created = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth())
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'DRAFT');
    assert.equal(created.body.data.sourceMode, 'MATERIAL');
    assert.equal(created.body.data.entryKind, 'REFERENCE');
    assert.equal(created.body.data.unitPrice, 1250.5);
    assert.equal(created.body.data.activatedAt, null);
    assert.equal(await eventCount('PRICE_CATALOG_ENTRY_CREATED', created.body.data.id), 1);

    const replay = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth())
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, created.body.data.id);

    const conflict = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth())
      .set('Idempotency-Key', key)
      .send({ ...body, unitPrice: 999 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'PRICE_CATALOG_IDEMPOTENCY_CONFLICT');

    const missingKey = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth())
      .send(body);
    assert.equal(missingKey.status, 400);
    assert.equal(missingKey.body.error.code, 'PRICE_CATALOG_IDEMPOTENCY_KEY_REQUIRED');
  });

  it('runs DRAFT → ACTIVE → INACTIVE with actor correlation', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const created = await createEntry(entryBody(fx, item, uom));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const draftDeactivate = await api()
      .post(`/api/v1/price-catalog/entries/${id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(draftDeactivate.status, 409);
    assert.equal(draftDeactivate.body.error.code, 'PRICE_CATALOG_NOT_ACTIVE');

    const activated = await activateEntry(id);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.data.status, 'ACTIVE');
    assert.equal(activated.body.data.activatedByUserId, adminUserId);
    assert.notEqual(activated.body.data.activatedAt, null);

    const secondActivate = await activateEntry(id);
    assert.equal(secondActivate.status, 409);
    assert.equal(secondActivate.body.error.code, 'PRICE_CATALOG_NOT_DRAFT');

    const deactivated = await api()
      .post(`/api/v1/price-catalog/entries/${id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
    assert.equal(deactivated.body.data.deactivatedByUserId, adminUserId);

    for (const type of [
      'PRICE_CATALOG_ENTRY_CREATED',
      'PRICE_CATALOG_ENTRY_ACTIVATED',
      'PRICE_CATALOG_ENTRY_DEACTIVATED',
    ]) {
      assert.equal(await eventCount(type, id), 1, type);
    }
  });

  it('edits only DRAFT rows and revalidates the effective window', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const created = await createEntry(entryBody(fx, item, uom));
    const id = created.body.data.id as string;

    const patched = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ unitPrice: 1400, notes: 'Aligned with 2026 budget plan.' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.unitPrice, 1400);
    assert.equal(patched.body.data.status, 'DRAFT');

    const inverted = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: '2026-01-01T00:00:00.000Z',
      });
    assert.equal(inverted.status, 400);
    assert.equal(inverted.body.error.code, 'PRICE_CATALOG_EFFECTIVE_WINDOW_INVALID');

    const activated = await activateEntry(id);
    assert.equal(activated.status, 200);

    const patchActive = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ unitPrice: 1 });
    assert.equal(patchActive.status, 409);
    assert.equal(patchActive.body.error.code, 'PRICE_CATALOG_NOT_DRAFT');
  });
});

describe('CR-BE-PRICE-01 PART 01 — overlap + window semantics', () => {
  it('rejects overlapping ACTIVE windows in the same exact tier', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const first = await createEntry(
      entryBody(fx, item, uom, {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z',
      }),
    );
    assert.equal(first.status, 201);
    assert.equal((await activateEntry(first.body.data.id)).status, 200);

    const overlapping = await createEntry(
      entryBody(fx, item, uom, {
        effectiveFrom: '2026-05-01T00:00:00.000Z',
        effectiveTo: '2026-12-01T00:00:00.000Z',
      }),
    );
    assert.equal(overlapping.status, 201);
    const overlap = await activateEntry(overlapping.body.data.id);
    assert.equal(overlap.status, 409, JSON.stringify(overlap.body));
    assert.equal(overlap.body.error.code, 'PRICE_CATALOG_WINDOW_OVERLAP');
  });

  it('accepts adjacent half-open windows and open-ended successors', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const jan = await createEntry(
      entryBody(fx, item, uom, {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z',
      }),
    );
    const onwards = await createEntry(
      entryBody(fx, item, uom, {
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        effectiveTo: null,
      }),
    );
    assert.equal((await activateEntry(jan.body.data.id)).status, 200);
    const second = await activateEntry(onwards.body.data.id);
    assert.equal(second.status, 200, JSON.stringify(second.body));
  });

  it('lets distinct tiers coexist while overlap still binds each tier', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const otherUom = await makeUom(fx.client.id, `BX${suffix()}`);
    const vendor = await makeVendor(fx.client.id);
    const window = {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2026-12-31T00:00:00.000Z',
    };

    // Same item, four distinct tier keys — all may activate in parallel.
    const clientWide = await createEntry(entryBody(fx, item, uom, window));
    const buildingTier = await createEntry(
      entryBody(fx, item, uom, { ...window, buildingId: fx.building.id }),
    );
    const vendorTier = await createEntry(
      entryBody(fx, item, uom, { ...window, vendorId: vendor.id }),
    );
    const vendorBuilding = await createEntry(
      entryBody(fx, item, uom, {
        ...window,
        vendorId: vendor.id,
        buildingId: fx.building.id,
      }),
    );
    const otherCurrency = await createEntry(
      entryBody(fx, item, uom, { ...window, currency: 'USD' }),
    );
    const otherUomEntry = await createEntry(
      entryBody(fx, item, otherUom, window),
    );

    for (const entry of [
      clientWide,
      buildingTier,
      vendorTier,
      vendorBuilding,
      otherCurrency,
      otherUomEntry,
    ]) {
      assert.equal(entry.status, 201, JSON.stringify(entry.body));
      const activated = await activateEntry(entry.body.data.id);
      assert.equal(activated.status, 200, JSON.stringify(activated.body));
      if ((entry.body as Body).vendorId) {
        assert.equal(activated.body.data.entryKind, 'VENDOR_CONTRACT');
      }
    }

    // But a second Client-wide activation with an overlapping window fails.
    const duplicate = await createEntry(entryBody(fx, item, uom, window));
    assert.equal(duplicate.status, 201);
    const overlap = await activateEntry(duplicate.body.data.id);
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error.code, 'PRICE_CATALOG_WINDOW_OVERLAP');
  });

  it('serializes concurrent activations of equal tier keys', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const window = {
      effectiveFrom: '2026-03-01T00:00:00.000Z',
      effectiveTo: '2026-09-01T00:00:00.000Z',
    };

    const a = await createEntry(entryBody(fx, item, uom, window));
    const b = await createEntry(entryBody(fx, item, uom, window));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const results = await Promise.allSettled([
      activateEntry(a.body.data.id),
      activateEntry(b.body.data.id),
    ]);
    const statuses = results.map((result) =>
      result.status === 'fulfilled' ? result.value.status : 0,
    );
    assert.deepEqual(statuses.filter((status) => status === 200).length, 1);
    assert.deepEqual(statuses.filter((status) => status === 409).length, 1);
  });
});

describe('CR-BE-PRICE-01 PART 01 — replacement history', () => {
  it('replaces atomically, preserves history, and forbids forked lineage', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const created = await createEntry(
      entryBody(fx, item, uom, {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
      }),
    );
    const predId = created.body.data.id as string;
    assert.equal((await activateEntry(predId)).status, 200);

    const key = `REPL_${suffix()}`;
    const replaced = await api()
      .post(`/api/v1/price-catalog/entries/${predId}/replace`)
      .set(auth())
      .set('Idempotency-Key', key)
      .send({
        unitPrice: 1499.99,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
        notes: 'June supplier renegotiation',
      });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    const successorId = replaced.body.data.id as string;
    assert.equal(replaced.body.data.status, 'ACTIVE');
    assert.equal(replaced.body.data.unitPrice, 1499.99);
    assert.equal(replaced.body.data.itemId, created.body.data.itemId);
    assert.equal(replaced.body.data.uomId, created.body.data.uomId);
    assert.equal(replaced.body.data.currency, 'IDR');

    const historical = await api()
      .get(`/api/v1/price-catalog/entries/${predId}`)
      .set(auth());
    assert.equal(historical.status, 200);
    assert.equal(historical.body.data.status, 'INACTIVE');
    assert.equal(historical.body.data.unitPrice, 1250.5);
    assert.equal(historical.body.data.replacedByEntryId, successorId);
    assert.equal(
      historical.body.data.effectiveFrom,
      '2026-01-01T00:00:00.000Z',
      'the predecessor window is history, never rewritten',
    );

    assert.equal(await eventCount('PRICE_CATALOG_ENTRY_REPLACED', predId), 1);
    assert.equal(await eventCount('PRICE_CATALOG_ENTRY_CREATED', successorId), 1);
    assert.equal(await eventCount('PRICE_CATALOG_ENTRY_ACTIVATED', successorId), 1);

    // Idempotent replay returns the same successor.
    const replay = await api()
      .post(`/api/v1/price-catalog/entries/${predId}/replace`)
      .set(auth())
      .set('Idempotency-Key', key)
      .send({
        unitPrice: 1499.99,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
        notes: 'June supplier renegotiation',
      });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, successorId);

    // A genuinely different second replace has no ACTIVE predecessor left.
    const second = await replaceEntry(predId, {
      unitPrice: 1690,
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'PRICE_CATALOG_NOT_ACTIVE');
  });

  it('refuses a replacement window that rewrites the past', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const created = await createEntry(
      entryBody(fx, item, uom, { effectiveFrom: '2026-04-01T00:00:00.000Z' }),
    );
    assert.equal((await activateEntry(created.body.data.id)).status, 200);

    const retro = await replaceEntry(created.body.data.id, {
      unitPrice: 100,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(retro.status, 400);
    assert.equal(retro.body.error.code, 'PRICE_CATALOG_EFFECTIVE_WINDOW_INVALID');
  });
});

describe('CR-BE-PRICE-01 PART 01 — reference validation', () => {
  it('validates currency and unit price under existing conventions', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const badCurrency = await createEntry(entryBody(fx, item, uom, { currency: 'THB' }));
    assert.equal(badCurrency.status, 400);
    assert.equal(badCurrency.body.error.code, 'VALIDATION_ERROR');

    const zero = await createEntry(entryBody(fx, item, uom, { unitPrice: 0 }));
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, 'VALIDATION_ERROR');

    const negative = await createEntry(entryBody(fx, item, uom, { unitPrice: -5 }));
    assert.equal(negative.status, 400);

    const threeDp = await createEntry(entryBody(fx, item, uom, { unitPrice: 12.345 }));
    assert.equal(threeDp.status, 400);
    assert.equal(threeDp.body.error.code, 'VALIDATION_ERROR');

    // DB-level safety net: a non-positive price can never exist even if the
    // API validation rules ever change.
    await assert.rejects(
      pool!.query(
        `INSERT INTO price_catalog_entries
           (id, client_id, source_mode, entry_kind, item_id, uom_id, currency,
            unit_price, effective_from, idempotency_key,
            idempotency_fingerprint, created_by_user_id)
         VALUES (gen_random_uuid(), $1, 'MATERIAL', 'REFERENCE', $2, $3, 'IDR',
                 0, NOW(), 'MANUAL_DB_GUARD',
                 repeat('a', 64), $4)`,
        [fx.client.id, item.id, uom.id, adminUserId],
      ),
      /price_catalog_entries_unit_price_check/,
    );

    // CR-BE-SVC-01 PART 05 — SERVICE is now an admitted source mode, but its
    // subject shape is structurally enforced: a SERVICE row must NOT carry an
    // item/UOM (it requires a service_id). This insert (SERVICE + item + UOM,
    // no service_id) is rejected by the discriminated-union subject shape.
    await assert.rejects(
      pool!.query(
        `INSERT INTO price_catalog_entries
           (id, client_id, source_mode, entry_kind, item_id, uom_id, currency,
            unit_price, effective_from, idempotency_key,
            idempotency_fingerprint, created_by_user_id)
         VALUES (gen_random_uuid(), $1, 'SERVICE', 'REFERENCE', $2, $3, 'IDR',
                 10, NOW(), 'SERVICE_DB_GUARD',
                 repeat('b', 64), $4)`,
        [fx.client.id, item.id, uom.id, adminUserId],
      ),
      /price_catalog_entries_subject_shape_check/,
    );
  });

  it('rejects cross-Client items, UOMs, vendors, and buildings', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const other = await fixture(null);
    const item = await makeItem(fx.client.id);
    const otherItem = await makeItem(other.client.id);
    const uom = await makeUom(fx.client.id);
    const otherUom = await makeUom(other.client.id);
    const otherVendor = await makeVendor(other.client.id);

    const wrongItem = await createEntry(entryBody(fx, otherItem, uom));
    assert.equal(wrongItem.status, 400);
    assert.equal(wrongItem.body.error.code, 'PRICE_CATALOG_ITEM_INVALID');

    const wrongUom = await createEntry(entryBody(fx, item, otherUom));
    assert.equal(wrongUom.status, 400);
    assert.equal(wrongUom.body.error.code, 'PRICE_CATALOG_UOM_INVALID');

    const wrongVendor = await createEntry(
      entryBody(fx, item, uom, { vendorId: otherVendor.id }),
    );
    assert.equal(wrongVendor.status, 400);
    assert.equal(wrongVendor.body.error.code, 'PRICE_CATALOG_VENDOR_INVALID');

    const wrongBuilding = await createEntry(
      entryBody(fx, item, uom, { buildingId: other.building.id }),
    );
    assert.equal(wrongBuilding.status, 403, JSON.stringify(wrongBuilding.body));

    // With the assignment present, the Client mismatch surfaces as a
    // domain-level 400 instead of an access denial.
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: other.building.id,
    });
    const wrongClientBuilding = await createEntry(
      entryBody(fx, item, uom, { buildingId: other.building.id }),
    );
    assert.equal(wrongClientBuilding.status, 400);
    assert.equal(
      wrongClientBuilding.body.error.code,
      'PRICE_CATALOG_BUILDING_INVALID',
    );

    const unknownItem = await createEntry(
      entryBody(fx, { id: randomUUID() }, uom),
    );
    assert.equal(unknownItem.status, 404);
    assert.equal(unknownItem.body.error.code, 'PRICE_CATALOG_ITEM_NOT_FOUND');
  });

  it('rejects inactive reference masters', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    await pool!.query(`UPDATE units_of_measure SET status = 'INACTIVE' WHERE id = $1`, [uom.id]);
    const inactiveUom = await createEntry(entryBody(fx, item, uom));
    assert.equal(inactiveUom.status, 400);
    assert.equal(inactiveUom.body.error.code, 'PRICE_CATALOG_UOM_INVALID');

    const otherUom = await makeUom(fx.client.id, `KG${suffix()}`);
    await pool!.query(`UPDATE inventory_items SET status = 'INACTIVE' WHERE id = $1`, [item.id]);
    const inactiveItem = await createEntry(entryBody(fx, item, otherUom));
    assert.equal(inactiveItem.status, 400);
    assert.equal(inactiveItem.body.error.code, 'PRICE_CATALOG_ITEM_INVALID');
  });

  it('requires an existing active approver when approval is attributed', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const ghost = await createEntry(
      entryBody(fx, item, uom, { approvedByUserId: randomUUID() }),
    );
    assert.equal(ghost.status, 400);
    assert.equal(ghost.body.error.code, 'PRICE_CATALOG_APPROVER_INVALID');

    const approved = await createEntry(
      entryBody(fx, item, uom, { approvedByUserId: adminUserId }),
    );
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.data.approvedByUserId, adminUserId);
    assert.notEqual(approved.body.data.approvedAt, null);
  });
});

describe('CR-BE-PRICE-01 PART 01 — permissions + isolation', () => {
  it('enforces price_catalog.read / .manage on every route', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const created = await createEntry(entryBody(fx, item, uom));
    const id = created.body.data.id as string;

    const plain = await createPlainSession();
    const noPermCreate = await createEntry(entryBody(fx, item, uom), plain);
    assert.equal(noPermCreate.status, 403);
    const noPermList = await api()
      .get('/api/v1/price-catalog/entries')
      .set(auth(plain));
    assert.equal(noPermList.status, 403);
    const noPermGet = await api()
      .get(`/api/v1/price-catalog/entries/${id}`)
      .set(auth(plain));
    assert.equal(noPermGet.status, 403);

    const reader = await createSessionWithPermissions([
      { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
      { code: 'building.read', name: 'Read Buildings' },
    ]);
    const readerCanNotCreate = await createEntry(entryBody(fx, item, uom), reader);
    assert.equal(readerCanNotCreate.status, 403);
    const readerCanNotActivate = await activateEntry(id, reader);
    assert.equal(readerCanNotActivate.status, 403);

    const unauthenticated = await api().get('/api/v1/price-catalog/entries');
    assert.equal(unauthenticated.status, 401);
  });

  it('never leaks entries across Client or Building scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const buildingEntry = await createEntry(
      entryBody(fx, item, uom, { buildingId: fx.building.id }),
    );
    const clientWideEntry = await createEntry(entryBody(fx, item, uom));
    assert.equal(buildingEntry.status, 201);
    assert.equal(clientWideEntry.status, 201);

    // An authorized reader with permissions but no assignments sees nothing.
    const outsider = await createSessionWithPermissions([
      { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
      { code: 'price_catalog.manage', name: 'Manage Price Catalog Entries' },
    ]);
    const list = await api()
      .get('/api/v1/price-catalog/entries')
      .set(auth(outsider));
    assert.equal(list.status, 200);
    assert.equal(Array.isArray(list.body.data), true);
    assert.equal(list.body.data.length, 0);

    const getBuilding = await api()
      .get(`/api/v1/price-catalog/entries/${buildingEntry.body.data.id}`)
      .set(auth(outsider));
    assert.equal(getBuilding.status, 403);

    const getClientWide = await api()
      .get(`/api/v1/price-catalog/entries/${clientWideEntry.body.data.id}`)
      .set(auth(outsider));
    assert.equal(getClientWide.status, 403);

    const createDenied = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth(outsider))
      .set('Idempotency-Key', `IDEM_${suffix()}`)
      .send(entryBody(fx, item, uom));
    assert.equal(createDenied.status, 403);

    // The assigned admin sees both rows, and can filter deterministically.
    const own = await api()
      .get(`/api/v1/price-catalog/entries?clientId=${fx.client.id}`)
      .set(auth());
    assert.equal(own.status, 200);
    assert.equal(own.body.data.length, 2);

    const buildingOnly = await api()
      .get(`/api/v1/price-catalog/entries?buildingId=${fx.building.id}`)
      .set(auth());
    assert.equal(buildingOnly.status, 200);
    assert.equal(buildingOnly.body.data.length, 1);
    assert.equal(buildingOnly.body.data[0].id, buildingEntry.body.data.id);
  });

  it('registers price_catalog codes and keeps override unassigned by default', async (t) => {
    if (!requireDatabase(t)) return;

    await runSeeds(pool!);
    await runSeeds(pool!);

    const codes = await pool!.query<{ code: string }>(
      `SELECT code FROM permissions
        WHERE code IN ('price_catalog.read', 'price_catalog.manage', 'price_catalog.override')`,
    );
    assert.equal(codes.rowCount, 3);

    const granted = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM role_permission_assignments rpa
         JOIN roles r ON r.id = rpa.role_id
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE p.code = 'price_catalog.override' AND rpa.status = 'ACTIVE'`,
    );
    assert.equal(
      granted.rows[0]?.count,
      '0',
      'price_catalog.override must be granted to no role by any default seed',
    );

    const platformAdmin = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM role_permission_assignments rpa
         JOIN roles r ON r.id = rpa.role_id
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE r.code = 'PLATFORM_ADMIN'
          AND p.code IN ('price_catalog.read', 'price_catalog.manage')
          AND rpa.status = 'ACTIVE'`,
    );
    assert.equal(platformAdmin.rows[0]?.count, '2');
  });
});
