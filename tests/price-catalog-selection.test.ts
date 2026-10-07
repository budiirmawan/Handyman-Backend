import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { priceCatalogLookupService } from '../src/modules/price-catalog-entries';
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
 * CR-BE-PRICE-01 PART 02 — Material Price + UOM/Scope Selection.
 *
 * Covers the deterministic §8 resolver only: the full scope-precedence
 * matrix (Vendor+Building → Vendor → Building → Client-wide), half-open
 * [from, to) as-of boundaries, future-window invisibility, exact-UOM and
 * exact-currency matching with their typed incompatibility outcomes,
 * NO_REFERENCE_PRICE, the constraint-simulated AMBIGUOUS fail-closed path
 * (including PRICE_CATALOG_AMBIGUITY_REJECTED audit), request validation,
 * permission/scope posture (price_catalog.read covers lookup), Client/
 * Building isolation, and read determinism while activations race.
 *
 * Deliberately excluded: SERVICE prices, UOM conversion, FX, RFQ comparison
 * integration (PART 04), deviation overrides (PART 05), PO/commitment
 * behavior, and any PART 03+ scope.
 */

const DB_PORT = 55496;
const DATA_DIR = '/tmp/asentra-price02-pg';
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
const T = '2026-03-01T00:00:00.000Z';
const OPEN_WINDOW = { effectiveFrom: '2026-01-01T00:00:00.000Z' };

async function fixture() {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Selection Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Selection Test Property',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLA_${suffix()}`,
    name: 'Lookup Context Building',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLB_${suffix()}`,
    name: 'Other Building',
  });
  for (const building of [buildingA, buildingB]) {
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, buildingA, buildingB };
}

async function makeItem(clientId: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `ITEM_${suffix()}`,
    name: 'Resolvable material',
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
  return vendorService.createVendor({
    clientId,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Selection Test Vendor',
  });
}

type Fx = Awaited<ReturnType<typeof fixture>>;
type Body = Record<string, unknown>;

function entryBody(
  fx: Fx,
  item: { id: string },
  uom: { id: string },
  overrides: Body = {},
): Body {
  return {
    clientId: fx.client.id,
    itemId: item.id,
    uomId: uom.id,
    currency: 'IDR',
    unitPrice: 1000,
    ...OPEN_WINDOW,
    ...overrides,
  };
}

/** Creates + activates an entry so it is immediately resolvable. */
async function createActiveEntry(body: Body): Promise<Body> {
  const created = await api()
    .post('/api/v1/price-catalog/entries')
    .set(auth())
    .set('Idempotency-Key', `IDEM_${suffix()}_${randomUUID()}`)
    .send(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activated = await api()
    .post(`/api/v1/price-catalog/entries/${created.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return created.body.data as Body;
}

type LookupParams = {
  itemId: string;
  uomId: string;
  currency?: string;
  buildingId: string;
  vendorId?: string;
  asOf?: string;
};

async function lookup(params: LookupParams, token = adminToken) {
  const search = new URLSearchParams();
  search.set('itemId', params.itemId);
  search.set('uomId', params.uomId);
  search.set('currency', params.currency ?? 'IDR');
  search.set('buildingId', params.buildingId);
  if (params.vendorId !== undefined) search.set('vendorId', params.vendorId);
  search.set('asOf', params.asOf ?? T);
  return api()
    .get(`/api/v1/price-catalog/lookup?${search.toString()}`)
    .set(auth(token));
}

async function ambiguityEventCount(itemId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM operational_events
      WHERE event_type = 'PRICE_CATALOG_AMBIGUITY_REJECTED'
        AND entity_type = 'PRICE_CATALOG_LOOKUP'
        AND entity_id = $1`,
    [itemId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('CR-BE-PRICE-01 PART 02 — scope precedence matrix', () => {
  it('prefers the Vendor + Building tier over every other tier', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);

    const tierVB = await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 1111,
        vendorId: vendor.id,
        buildingId: fx.buildingA.id,
      }),
    );
    await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 2222, vendorId: vendor.id }),
    );
    await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 3333, buildingId: fx.buildingA.id }),
    );
    await createActiveEntry(entryBody(fx, item, uom, { unitPrice: 4444 }));

    const result = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      vendorId: vendor.id,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.resolution, 'MATCHED');
    assert.equal(result.body.data.scopeTier, 'VENDOR_BUILDING');

    // Full authority snapshot for PART 04 consumers.
    const entry = result.body.data.entry;
    assert.equal(entry.id, tierVB.id);
    assert.equal(entry.unitPrice, 1111);
    assert.equal(entry.currency, 'IDR');
    assert.equal(entry.uomId, uom.id);
    assert.equal(entry.itemId, item.id);
    assert.equal(entry.vendorId, vendor.id);
    assert.equal(entry.buildingId, fx.buildingA.id);
    assert.equal(entry.status, 'ACTIVE');
    assert.equal(entry.effectiveFrom, '2026-01-01T00:00:00.000Z');
    assert.equal(entry.effectiveTo, null);

    // Context echo: the Client is derived, never caller-supplied.
    assert.equal(result.body.data.clientId, fx.client.id);
    assert.equal(result.body.data.vendorId, vendor.id);
    assert.equal(result.body.data.asOf, T);
  });

  it('walks the fixed tier order as higher tiers go absent', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);

    // Tiers 2-4 present (no Vendor+Building): Vendor tier wins.
    const itemV = await makeItem(fx.client.id);
    await createActiveEntry(
      entryBody(fx, itemV, uom, { unitPrice: 2222, vendorId: vendor.id }),
    );
    await createActiveEntry(
      entryBody(fx, itemV, uom, {
        unitPrice: 3333,
        buildingId: fx.buildingA.id,
      }),
    );
    await createActiveEntry(entryBody(fx, itemV, uom, { unitPrice: 4444 }));

    // Tiers 3-4 present: Building tier wins.
    const itemB = await makeItem(fx.client.id);
    await createActiveEntry(
      entryBody(fx, itemB, uom, {
        unitPrice: 3333,
        buildingId: fx.buildingA.id,
      }),
    );
    await createActiveEntry(entryBody(fx, itemB, uom, { unitPrice: 4444 }));

    // Only tier 4 present: Client-wide wins.
    const itemCW = await makeItem(fx.client.id);
    await createActiveEntry(entryBody(fx, itemCW, uom, { unitPrice: 4444 }));

    const base = { uomId: uom.id, buildingId: fx.buildingA.id, vendorId: vendor.id };
    const tierV = await lookup({ ...base, itemId: itemV.id });
    assert.equal(tierV.body.data.resolution, 'MATCHED');
    assert.equal(tierV.body.data.scopeTier, 'VENDOR');
    assert.equal(tierV.body.data.entry.unitPrice, 2222);

    const tierB = await lookup({ ...base, itemId: itemB.id });
    assert.equal(tierB.body.data.resolution, 'MATCHED');
    assert.equal(tierB.body.data.scopeTier, 'BUILDING');
    assert.equal(tierB.body.data.entry.unitPrice, 3333);

    const tierCW = await lookup({ ...base, itemId: itemCW.id });
    assert.equal(tierCW.body.data.resolution, 'MATCHED');
    assert.equal(tierCW.body.data.scopeTier, 'CLIENT_WIDE');
    assert.equal(tierCW.body.data.entry.unitPrice, 4444);
  });

  it('excludes vendor tiers entirely when no vendor context is given', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);

    await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 1111,
        vendorId: vendor.id,
        buildingId: fx.buildingA.id,
      }),
    );
    const buildingTier = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 3333, buildingId: fx.buildingA.id }),
    );

    const result = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.resolution, 'MATCHED');
    assert.equal(result.body.data.scopeTier, 'BUILDING');
    assert.equal(result.body.data.entry.id, buildingTier.id);
    assert.equal(result.body.data.vendorId, null);
  });

  it('falls back across tiers when the context vendor does not match', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendorA = await makeVendor(fx.client.id);
    const vendorB = await makeVendor(fx.client.id);

    await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 1111,
        vendorId: vendorA.id,
        buildingId: fx.buildingA.id,
      }),
    );
    await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 2222, vendorId: vendorA.id }),
    );
    const clientWide = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 4444 }),
    );

    const result = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      vendorId: vendorB.id,
    });
    assert.equal(result.body.data.resolution, 'MATCHED');
    assert.equal(result.body.data.scopeTier, 'CLIENT_WIDE');
    assert.equal(result.body.data.entry.id, clientWide.id);
  });

  it('ignores ACTIVE future windows until T arrives, per tier', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);

    await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 1111,
        vendorId: vendor.id,
        buildingId: fx.buildingA.id,
        effectiveFrom: '2027-01-01T00:00:00.000Z',
      }),
    );
    await createActiveEntry(entryBody(fx, item, uom, { unitPrice: 4444 }));

    const before = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      vendorId: vendor.id,
      asOf: '2026-06-01T00:00:00.000Z',
    });
    assert.equal(before.body.data.resolution, 'MATCHED');
    assert.equal(
      before.body.data.scopeTier,
      'CLIENT_WIDE',
      'the future Vendor+Building window is invisible before its start',
    );

    const after = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      vendorId: vendor.id,
      asOf: '2027-06-01T00:00:00.000Z',
    });
    assert.equal(after.body.data.resolution, 'MATCHED');
    assert.equal(after.body.data.scopeTier, 'VENDOR_BUILDING');
    assert.equal(after.body.data.entry.unitPrice, 1111);
  });
});

describe('CR-BE-PRICE-01 PART 02 — half-open window boundaries', () => {
  it('applies [from, to) exactly: inclusive start, exclusive end', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    await createActiveEntry(
      entryBody(fx, item, uom, {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z',
      }),
    );
    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };

    for (const [asOf, expected] of [
      ['2025-12-31T23:59:59.000Z', 'NO_REFERENCE_PRICE'],
      ['2026-01-01T00:00:00.000Z', 'MATCHED'],
      ['2026-06-30T23:59:59.000Z', 'MATCHED'],
      ['2026-07-01T00:00:00.000Z', 'NO_REFERENCE_PRICE'],
      ['2026-09-15T00:00:00.000Z', 'NO_REFERENCE_PRICE'],
    ] as const) {
      const result = await lookup({ ...base, asOf });
      assert.equal(
        result.status,
        200,
        `${asOf}: ${JSON.stringify(result.body)}`,
      );
      assert.equal(result.body.data.resolution, expected, `asOf ${asOf}`);
      if (expected === 'NO_REFERENCE_PRICE') {
        assert.equal(result.body.data.entry, null);
        assert.equal(result.body.data.scopeTier, null);
      }
    }
  });

  it('selects exactly the row whose window contains T across adjacent windows', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const first = await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 10,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-07-01T00:00:00.000Z',
      }),
    );
    const second = await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 20,
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        effectiveTo: null,
      }),
    );
    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };

    const midFirst = await lookup({ ...base, asOf: '2026-06-15T00:00:00.000Z' });
    assert.equal(midFirst.body.data.entry.id, first.id);
    assert.equal(midFirst.body.data.entry.unitPrice, 10);

    const boundary = await lookup({ ...base, asOf: '2026-07-01T00:00:00.000Z' });
    assert.equal(boundary.body.data.entry.id, second.id);
    assert.equal(
      boundary.body.data.entry.unitPrice,
      20,
      'at the boundary instant the second half-open window owns T',
    );
  });
});

describe('CR-BE-PRICE-01 PART 02 — fail-closed outcomes', () => {
  it('returns NO_REFERENCE_PRICE for unpriced, DRAFT-only, and terminal items', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const base = { uomId: uom.id, buildingId: fx.buildingA.id };

    // Nothing exists for the item at all.
    const unpriced = await makeItem(fx.client.id);
    const nothing = await lookup({ ...base, itemId: unpriced.id });
    assert.equal(nothing.body.data.resolution, 'NO_REFERENCE_PRICE');
    assert.equal(nothing.body.data.entry, null);

    // A DRAFT is never an applicable authority.
    const draftItem = await makeItem(fx.client.id);
    const draft = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth())
      .set('Idempotency-Key', `IDEM_${suffix()}`)
      .send(entryBody(fx, draftItem, uom));
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const fromDraft = await lookup({ ...base, itemId: draftItem.id });
    assert.equal(fromDraft.body.data.resolution, 'NO_REFERENCE_PRICE');

    // A deactivated (terminal) row is history, even inside its old window.
    const closedItem = await makeItem(fx.client.id);
    const closed = await createActiveEntry(entryBody(fx, closedItem, uom));
    const deactivated = await api()
      .post(`/api/v1/price-catalog/entries/${closed.id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    const afterClose = await lookup({ ...base, itemId: closedItem.id });
    assert.equal(afterClose.body.data.resolution, 'NO_REFERENCE_PRICE');
  });

  it('returns UOM_INCOMPATIBLE when only other UOMs are priced', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const otherUom = await makeUom(fx.client.id, `BX${suffix()}`);
    const requiredUom = await makeUom(fx.client.id, `KG${suffix()}`);

    await createActiveEntry(entryBody(fx, item, otherUom, { unitPrice: 750 }));

    const result = await lookup({
      itemId: item.id,
      uomId: requiredUom.id,
      buildingId: fx.buildingA.id,
    });
    assert.equal(result.body.data.resolution, 'UOM_INCOMPATIBLE');
    assert.equal(result.body.data.entry, null);
    assert.equal(result.body.data.scopeTier, null);
  });

  it('returns CURRENCY_INCOMPATIBLE when only other currencies are priced', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 99, currency: 'USD' }),
    );

    const result = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      currency: 'IDR',
    });
    assert.equal(result.body.data.resolution, 'CURRENCY_INCOMPATIBLE');
    assert.equal(result.body.data.entry, null);
  });

  it('locks diagnosis order: a UOM match with a currency gap is CURRENCY_INCOMPATIBLE', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const requiredUom = await makeUom(fx.client.id);
    const otherUom = await makeUom(fx.client.id, `BX${suffix()}`);

    // Right UOM but wrong currency, plus wrong UOM in the right currency:
    // the exact-UOM-first rule classifies this as a currency gap.
    await createActiveEntry(
      entryBody(fx, item, requiredUom, { currency: 'USD' }),
    );
    await createActiveEntry(entryBody(fx, item, otherUom, { currency: 'IDR' }));

    const result = await lookup({
      itemId: item.id,
      uomId: requiredUom.id,
      buildingId: fx.buildingA.id,
      currency: 'IDR',
    });
    assert.equal(result.body.data.resolution, 'CURRENCY_INCOMPATIBLE');

    // Sanity within the same fixture: exact matches still win normally.
    const otherUomHit = await lookup({
      itemId: item.id,
      uomId: otherUom.id,
      buildingId: fx.buildingA.id,
      currency: 'IDR',
    });
    assert.equal(otherUomHit.body.data.resolution, 'MATCHED');
    const usdHit = await lookup({
      itemId: item.id,
      uomId: requiredUom.id,
      buildingId: fx.buildingA.id,
      currency: 'USD',
    });
    assert.equal(usdHit.body.data.resolution, 'MATCHED');
  });

  it('never reveals prices that belong to another Building or Vendor scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);

    // Entry scoped to the OTHER Building only.
    const foreignBuildingItem = await makeItem(fx.client.id);
    await createActiveEntry(
      entryBody(fx, foreignBuildingItem, uom, { buildingId: fx.buildingB.id }),
    );
    const crossBuilding = await lookup({
      itemId: foreignBuildingItem.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
    });
    assert.equal(
      crossBuilding.body.data.resolution,
      'NO_REFERENCE_PRICE',
      'a price scoped to another Building must not surface — not even as an incompatibility reason',
    );

    // Entry scoped to a specific Vendor only.
    const vendorItem = await makeItem(fx.client.id);
    await createActiveEntry(entryBody(fx, vendorItem, uom, { vendorId: vendor.id }));

    const noVendor = await lookup({
      itemId: vendorItem.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
    });
    assert.equal(noVendor.body.data.resolution, 'NO_REFERENCE_PRICE');

    const wrongVendor = await makeVendor(fx.client.id);
    const otherVendor = await lookup({
      itemId: vendorItem.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      vendorId: wrongVendor.id,
    });
    assert.equal(otherVendor.body.data.resolution, 'NO_REFERENCE_PRICE');

    const rightVendor = await lookup({
      itemId: vendorItem.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      vendorId: vendor.id,
    });
    assert.equal(rightVendor.body.data.resolution, 'MATCHED');
    assert.equal(rightVendor.body.data.scopeTier, 'VENDOR');
  });
});

describe('CR-BE-PRICE-01 PART 02 — validation + isolation posture', () => {
  it('rejects malformed lookup probes with request validation errors', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();

    const cases: Array<[string, string]> = [
      ['missing itemId', `uomId=${randomUUID()}&buildingId=${fx.buildingA.id}&currency=IDR&asOf=${encodeURIComponent(T)}`],
      ['non-UUID uomId', `itemId=${randomUUID()}&uomId=not-a-uuid&buildingId=${fx.buildingA.id}&currency=IDR&asOf=${encodeURIComponent(T)}`],
      ['unsupported currency', `itemId=${randomUUID()}&uomId=${randomUUID()}&buildingId=${fx.buildingA.id}&currency=THB&asOf=${encodeURIComponent(T)}`],
      ['garbage asOf', `itemId=${randomUUID()}&uomId=${randomUUID()}&buildingId=${fx.buildingA.id}&currency=IDR&asOf=yesterday`],
      ['missing asOf', `itemId=${randomUUID()}&uomId=${randomUUID()}&buildingId=${fx.buildingA.id}&currency=IDR`],
    ];

    for (const [label, query] of cases) {
      const response = await api()
        .get(`/api/v1/price-catalog/lookup?${query}`)
        .set(auth());
      assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
    }
  });

  it('denies unknown Buildings, non-readers, and out-of-scope readers', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const unknownBuilding = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: randomUUID(),
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'PRICE_CATALOG_BUILDING_NOT_FOUND');

    const unauthenticated = await api().get(
      `/api/v1/price-catalog/lookup?itemId=${item.id}&uomId=${uom.id}&buildingId=${fx.buildingA.id}&currency=IDR&asOf=${encodeURIComponent(T)}`,
    );
    assert.equal(unauthenticated.status, 401);

    const plain = await createPlainSession();
    const noPermission = await lookup(
      { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id },
      plain,
    );
    assert.equal(noPermission.status, 403);
    assert.equal(noPermission.body.error.code, 'PERMISSION_DENIED');

    // price_catalog.read alone satisfies the permission gate; the Building
    // scope gate still applies to a reader without any assignment.
    const readerOnly = await createSessionWithPermissions([
      { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
    ]);
    const outOfScope = await lookup(
      { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id },
      readerOnly,
    );
    assert.equal(outOfScope.status, 403);
    assert.equal(outOfScope.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('CR-BE-PRICE-01 PART 02 — read determinism under races', () => {
  it('resolves exactly the surviving winner when activations race', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const createDraft = async () => {
      const created = await api()
        .post('/api/v1/price-catalog/entries')
        .set(auth())
        .set('Idempotency-Key', `IDEM_${suffix()}_${randomUUID()}`)
        .send(
          entryBody(fx, item, uom, {
            effectiveFrom: '2026-03-01T00:00:00.000Z',
            effectiveTo: '2026-09-01T00:00:00.000Z',
          }),
        );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body.data.id as string;
    };
    const [a, b] = await Promise.all([createDraft(), createDraft()]);

    const activations = await Promise.allSettled([
      api().post(`/api/v1/price-catalog/entries/${a}/activate`).set(auth()).send({}),
      api().post(`/api/v1/price-catalog/entries/${b}/activate`).set(auth()).send({}),
    ]);
    const byId = new Map<string, number>();
    for (const [index, settled] of activations.entries()) {
      if (settled.status === 'fulfilled') {
        byId.set(index === 0 ? a : b, settled.value.status);
      }
    }
    assert.deepEqual([...byId.values()].sort(), [200, 409]);
    const winnerId = [...byId.entries()].find(([, status]) => status === 200)?.[0];
    assert.ok(winnerId);

    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };
    for (const asOf of ['2026-04-01T00:00:00.000Z', '2026-08-31T23:59:59.000Z']) {
      const result = await lookup({ ...base, asOf });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.resolution, 'MATCHED');
      assert.equal(
        result.body.data.entry.id,
        winnerId,
        'concurrent activation can never yield two applicable rows at read',
      );
    }
  });
});

describe('CR-BE-PRICE-01 PART 02 — AMBIGUOUS defensive fail-closed path', () => {
  it('fails closed + audits when structural uniqueness is compromised', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);

    const constraint = `price_catalog_entries_material_window_exclusion`;
    const definition = async () =>
      pool!.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint WHERE conname = $1`,
        [constraint],
      );
    assert.equal((await definition()).rows.length, 1, 'exclusion constraint must exist');

    // Constraint-simulated corruption: drop the structural guard, then stage
    // two overlapping ACTIVE rows in the exact same Client-wide tier — the
    // pair the constraint exists to forbid (governance §8 AMBIGUOUS).
    await pool!.query(
      `ALTER TABLE price_catalog_entries DROP CONSTRAINT ${constraint}`,
    );
    try {
      const insertDuplicate = (key: string, fingerprint: string, price: number) =>
        pool!.query(
          `INSERT INTO price_catalog_entries
             (id, client_id, source_mode, entry_kind, item_id, uom_id, currency,
              unit_price, effective_from, effective_to, status,
              activated_at, activated_by_user_id, source_type,
              idempotency_key, idempotency_fingerprint, created_by_user_id)
           VALUES (gen_random_uuid(), $1, 'MATERIAL', 'REFERENCE', $2, $3, 'IDR',
                   $4, '2026-01-01T00:00:00Z', NULL, 'ACTIVE',
                   NOW(), $5, 'MANUAL', $6, $7, $5)`,
          [fx.client.id, item.id, uom.id, price, adminUserId, key, fingerprint],
        );
      await insertDuplicate(`AMBIG_A_${suffix()}`, 'a'.repeat(64), 500);
      await insertDuplicate(`AMBIG_B_${suffix()}`, 'b'.repeat(64), 600);

      // The internal seam returns the typed defensive outcome…
      const typed = await priceCatalogLookupService.lookupPriceCatalogEntry(
        {
          sourceMode: 'MATERIAL',
          buildingId: fx.buildingA.id,
          itemId: item.id,
          uomId: uom.id,
          currency: 'IDR',
          asOf: T,
        },
        adminUserId,
      );
      assert.equal(typed.resolution, 'AMBIGUOUS');
      assert.equal(typed.entry, null);

      // …and the HTTP probe treats it as an error, never a 200 price.
      const probe = await lookup({
        itemId: item.id,
        uomId: uom.id,
        buildingId: fx.buildingA.id,
      });
      assert.equal(probe.status, 409);
      assert.equal(probe.body.error.code, 'PRICE_CATALOG_LOOKUP_AMBIGUOUS');

      // Each fail-closed trip is audited for incident investigation (§17).
      assert.equal(await ambiguityEventCount(item.id), 2);
      const event = await pool!.query<{
        metadata: Record<string, unknown>;
      }>(
        `SELECT metadata FROM operational_events
          WHERE event_type = 'PRICE_CATALOG_AMBIGUITY_REJECTED'
            AND entity_id = $1
          ORDER BY occurred_at DESC LIMIT 1`,
        [item.id],
      );
      const metadata = event.rows[0]?.metadata ?? {};
      assert.equal(metadata.candidateCount, 2);
      assert.equal((metadata.candidateEntryIds as unknown[]).length, 2);
      assert.equal(metadata.scopeTier, 'CLIENT_WIDE');
      assert.equal(metadata.uomId, uom.id);
      assert.equal(metadata.currency, 'IDR');
    } finally {
      // Restore the authority exactly: staged duplicates leave, the
      // constraint returns identical to migration 0319.
      await pool!.query(
        `DELETE FROM price_catalog_entries
          WHERE idempotency_key LIKE 'AMBIG_%'`,
      );
      await pool!.query(`
        ALTER TABLE price_catalog_entries
          ADD CONSTRAINT price_catalog_entries_material_window_exclusion
          EXCLUDE USING gist (
            client_id WITH =,
            item_id   WITH =,
            uom_id    WITH =,
            currency  WITH =,
            COALESCE(building_id,
              '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
            COALESCE(vendor_id,
              '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
            tstzrange(effective_from, effective_to, '[)') WITH &&
          )
          WHERE (status = 'ACTIVE' AND source_mode = 'MATERIAL')
      `);
    }
    assert.equal(
      (await definition()).rows.length,
      1,
      'exclusion constraint restored',
    );

    const clean = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
    });
    assert.equal(clean.status, 200);
    assert.equal(clean.body.data.resolution, 'NO_REFERENCE_PRICE');
  });
});
