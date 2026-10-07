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
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import {
  createAdminUser,
  createSessionWithPermissions,
} from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PRICE-01 PART 03 — Vendor-Specific Price Governance Hardening.
 *
 * Closure/hardening over the PART 01 authority and the PART 02 resolver —
 * no migration, one recorded runtime delta: DRAFT tier edits now re-derive
 * `entry_kind` so VENDOR_CONTRACT discipline is validated behavior, never a
 * raw constraint crash. Proven here: Vendor eligibility at write time
 * (ACTIVE + governed Client; cross-Client/inactive/unknown denied), kind
 * discipline at create and DRAFT edit, the governance §2.1 posture that a
 * Vendor+Building price does NOT require a vendor_building_relationship,
 * the fixed precedence under all 15 tier mixes, cross-tier replacement
 * isolation with preserved vendor price history, cross-Vendor / cross-Client
 * commercial isolation (incl. structural exclusion from RFQ Vendor access
 * sessions), and vendor lifecycle audit metadata.
 *
 * Deliberately excluded: SERVICE prices, RFQ comparison snapshots, deviation
 * overrides, PO behavior, FX/UOM conversion, and any PART 04+ scope.
 */

const DB_PORT = 55497;
const DATA_DIR = '/tmp/asentra-price03-pg';
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
    TRUNCATE price_catalog_entries, operational_events,
      rfq_vendor_access_sessions, rfq_vendor_invitations, rfq_lines, rfqs,
      material_requests, service_requests, purchase_requests,
      vendor_building_relationships, inventory_items,
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

async function fixture(assignUserId: string | null = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Vendor Tier Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Vendor Tier Test Property',
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
  if (assignUserId) {
    for (const building of [buildingA, buildingB]) {
      await buildingAssignmentService.createAssignment(assignUserId, {
        buildingId: building.id,
      });
    }
  }
  return { client, property, buildingA, buildingB };
}

type Fx = Awaited<ReturnType<typeof fixture>>;
type Body = Record<string, unknown>;

async function makeItem(clientId: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `ITEM_${suffix()}`,
    name: 'Vendor-priced material',
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
    vendorName: 'Vendor Tier Test Vendor',
  });
}

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
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    ...overrides,
  };
}

async function createDraft(body: Body, token = adminToken) {
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

async function createActiveEntry(body: Body): Promise<Body> {
  const created = await createDraft(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activated = await activateEntry(created.body.data.id);
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

async function eventMetadata(
  eventType: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool!.query<{
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT metadata FROM operational_events
      WHERE event_type = $1 AND entity_id = $2
      ORDER BY occurred_at DESC LIMIT 1`,
    [eventType, entityId],
  );
  return result.rows[0]?.metadata ?? null;
}

describe('CR-BE-PRICE-01 PART 03 — VENDOR_CONTRACT eligibility + discipline', () => {
  it('requires an existing, ACTIVE Vendor of the governed Client at write', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const other = await fixture(null);
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);
    const otherVendor = await makeVendor(other.client.id);

    const unknown = await createDraft(
      entryBody(fx, item, uom, { vendorId: randomUUID() }),
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PRICE_CATALOG_VENDOR_NOT_FOUND');

    const crossClient = await createDraft(
      entryBody(fx, item, uom, { vendorId: otherVendor.id }),
    );
    assert.equal(crossClient.status, 400);
    assert.equal(crossClient.body.error.code, 'PRICE_CATALOG_VENDOR_INVALID');

    await pool!.query(`UPDATE vendors SET status = 'INACTIVE' WHERE id = $1`, [
      vendor.id,
    ]);
    const inactive = await createDraft(
      entryBody(fx, item, uom, { vendorId: vendor.id }),
    );
    assert.equal(inactive.status, 400);
    assert.equal(inactive.body.error.code, 'PRICE_CATALOG_VENDOR_INVALID');
  });

  it('derives VENDOR_CONTRACT on create and keeps it consistent on DRAFT edits', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const other = await fixture(null);
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);
    const otherClientVendor = await makeVendor(other.client.id);

    // Vendor at create → VENDOR_CONTRACT.
    const vendorEntry = await createDraft(
      entryBody(fx, item, uom, { vendorId: vendor.id }),
    );
    assert.equal(vendorEntry.status, 201, JSON.stringify(vendorEntry.body));

    // Direct DB guard: the kind/vendor correlation is structural, not
    // service-courtesy — a REFERENCE row with a Vendor can never exist.
    await assert.rejects(
      pool!.query(
        `INSERT INTO price_catalog_entries
           (id, client_id, vendor_id, source_mode, entry_kind, item_id, uom_id,
            currency, unit_price, effective_from, idempotency_key,
            idempotency_fingerprint, created_by_user_id)
         VALUES (gen_random_uuid(), $1, $2, 'MATERIAL', 'REFERENCE', $3, $4,
                 'IDR', 10, NOW(), 'KIND_GUARD_${suffix()}',
                 repeat('c', 64), $5)`,
        [fx.client.id, vendor.id, item.id, uom.id, adminUserId],
      ),
      /price_catalog_entries_kind_vendor_check/,
    );

    // Tier discipline through DRAFT edits (the PART 03 recorded delta:
    // entry_kind must trail the final Vendor key — before this fix the same
    // sequence crashed on the CHECK instead of producing governed rows).
    const general = await createDraft(entryBody(fx, item, uom));
    assert.equal(general.status, 201);
    assert.equal(general.body.data.entryKind, 'REFERENCE');
    const id = general.body.data.id as string;

    const notesOnly = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ notes: 'baseline general price' });
    assert.equal(notesOnly.status, 200, JSON.stringify(notesOnly.body));
    assert.equal(notesOnly.body.data.entryKind, 'REFERENCE');

    const intoVendor = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ vendorId: vendor.id });
    assert.equal(intoVendor.status, 200, JSON.stringify(intoVendor.body));
    assert.equal(intoVendor.body.data.entryKind, 'VENDOR_CONTRACT');
    assert.equal(intoVendor.body.data.vendorId, vendor.id);

    const stillVendor = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ notes: 'repriced under contract' });
    assert.equal(stillVendor.status, 200);
    assert.equal(stillVendor.body.data.entryKind, 'VENDOR_CONTRACT');

    const backToGeneral = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ vendorId: null });
    assert.equal(backToGeneral.status, 200);
    assert.equal(backToGeneral.body.data.entryKind, 'REFERENCE');
    assert.equal(backToGeneral.body.data.vendorId, null);

    const wrongVendor = await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ vendorId: otherClientVendor.id });
    assert.equal(wrongVendor.status, 400);
    assert.equal(wrongVendor.body.error.code, 'PRICE_CATALOG_VENDOR_INVALID');

    // The UPDATED event carries the derived kind for the audit trail.
    await api()
      .patch(`/api/v1/price-catalog/entries/${id}`)
      .set(auth())
      .send({ vendorId: vendor.id });
    const metadata = await eventMetadata('PRICE_CATALOG_ENTRY_UPDATED', id);
    assert.equal(metadata?.entryKind, 'VENDOR_CONTRACT');
    assert.equal(metadata?.vendorId, vendor.id);
  });

  it('does not require a vendor_building_relationship for the Vendor+Building tier (§2.1 posture)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);

    // Deliberately NO vendor_building_relationship row is created: the tier
    // keys (Vendor ACTIVE + same Client, Building ACTIVE + same Client) are
    // the only eligibility gates the governance freezes for this authority.
    const created = await createDraft(
      entryBody(fx, item, uom, {
        vendorId: vendor.id,
        buildingId: fx.buildingA.id,
      }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.entryKind, 'VENDOR_CONTRACT');
    assert.equal((await activateEntry(created.body.data.id)).status, 200);

    const resolved = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.buildingA.id,
      vendorId: vendor.id,
    });
    assert.equal(resolved.body.data.resolution, 'MATCHED');
    assert.equal(resolved.body.data.scopeTier, 'VENDOR_BUILDING');

    // A Building from another Client is still rejected with the assignment
    // present (domain-level 400, not an access denial).
    const other = await fixture(null);
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: other.buildingA.id,
    });
    const crossBuilding = await createDraft(
      entryBody(fx, item, uom, {
        vendorId: vendor.id,
        buildingId: other.buildingA.id,
      }),
    );
    assert.equal(crossBuilding.status, 400);
    assert.equal(crossBuilding.body.error.code, 'PRICE_CATALOG_BUILDING_INVALID');
  });
});

describe('CR-BE-PRICE-01 PART 03 — precedence under all tier mixes', () => {
  const TIERS = [
    { tier: 1, scopeTier: 'VENDOR_BUILDING', price: 1111 },
    { tier: 2, scopeTier: 'VENDOR', price: 2222 },
    { tier: 3, scopeTier: 'BUILDING', price: 3333 },
    { tier: 4, scopeTier: 'CLIENT_WIDE', price: 4444 },
  ] as const;

  it('resolves the highest present tier for all 15 non-empty mixes', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);

    for (let mask = 1; mask < 16; mask += 1) {
      const present = TIERS.filter((td) => mask & (1 << (td.tier - 1)));
      const item = await makeItem(fx.client.id);
      const createdByTier = new Map<number, string>();
      for (const td of present) {
        const entry = await createActiveEntry(
          entryBody(fx, item, uom, {
            unitPrice: td.price,
            ...(td.tier <= 2 ? { vendorId: vendor.id } : {}),
            ...(td.tier === 1 || td.tier === 3
              ? { buildingId: fx.buildingA.id }
              : {}),
          }),
        );
        createdByTier.set(td.tier, entry.id as string);
      }
      const winner = present.reduce((best, td) =>
        td.tier < best.tier ? td : best,
      );

      const result = await lookup({
        itemId: item.id,
        uomId: uom.id,
        buildingId: fx.buildingA.id,
        vendorId: vendor.id,
      });
      assert.equal(
        result.status,
        200,
        `mask ${mask}: ${JSON.stringify(result.body)}`,
      );
      assert.equal(result.body.data.resolution, 'MATCHED', `mask ${mask}`);
      assert.equal(result.body.data.scopeTier, winner.scopeTier, `mask ${mask}`);
      assert.equal(
        result.body.data.entry.id,
        createdByTier.get(winner.tier),
        `mask ${mask}`,
      );
      assert.equal(result.body.data.entry.unitPrice, winner.price, `mask ${mask}`);
    }
  });
});

describe('CR-BE-PRICE-01 PART 03 — cross-tier replacement + history', () => {
  it('replaces a Vendor-tier entry without disturbing sibling tiers', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);
    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };

    const vendorTier = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 2222, vendorId: vendor.id }),
    );
    const buildingTier = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 3333, buildingId: fx.buildingA.id }),
    );
    const clientWide = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 4444 }),
    );

    const replaced = await api()
      .post(`/api/v1/price-catalog/entries/${vendorTier.id}/replace`)
      .set(auth())
      .set('Idempotency-Key', `REPL_${suffix()}`)
      .send({
        unitPrice: 2999,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
        notes: 'Contract renewal uplift',
      });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    const successor = replaced.body.data;
    assert.equal(successor.entryKind, 'VENDOR_CONTRACT');
    assert.equal(successor.vendorId, vendorTier.vendorId);
    assert.equal(successor.buildingId, vendorTier.buildingId);
    assert.equal(successor.status, 'ACTIVE');

    // History preserved: predecessor keeps its price/window, terminally
    // closed and linked to its successor.
    const predecessor = await api()
      .get(`/api/v1/price-catalog/entries/${vendorTier.id}`)
      .set(auth());
    assert.equal(predecessor.body.data.status, 'INACTIVE');
    assert.equal(predecessor.body.data.unitPrice, 2222);
    assert.equal(predecessor.body.data.replacedByEntryId, successor.id);

    // Sibling tiers undisturbed: still ACTIVE with their original prices.
    for (const sibling of [buildingTier, clientWide]) {
      const row = await api()
        .get(`/api/v1/price-catalog/entries/${sibling.id}`)
        .set(auth());
      assert.equal(row.body.data.status, 'ACTIVE');
      assert.equal(row.body.data.unitPrice, sibling.unitPrice);
      assert.equal(row.body.data.replacedByEntryId, null);
    }

    // Selection after replacement: vendor tier resolves the successor; a
    // timestamp before the successor's window sees only the untouched
    // siblings (the INACTIVE predecessor is history, never selected).
    const after = await lookup({ ...base, vendorId: vendor.id, asOf: '2026-07-01T00:00:00.000Z' });
    assert.equal(after.body.data.resolution, 'MATCHED');
    assert.equal(after.body.data.scopeTier, 'VENDOR');
    assert.equal(after.body.data.entry.id, successor.id);
    assert.equal(after.body.data.entry.unitPrice, 2999);

    const before = await lookup({ ...base, vendorId: vendor.id, asOf: '2026-02-01T00:00:00.000Z' });
    assert.equal(before.body.data.resolution, 'MATCHED');
    assert.equal(before.body.data.scopeTier, 'BUILDING');
    assert.equal(before.body.data.entry.id, buildingTier.id);

    // Vendor price versions are preserved and enumerable as history.
    const versions = await api()
      .get(`/api/v1/price-catalog/entries?vendorId=${vendor.id}`)
      .set(auth());
    assert.equal(versions.status, 200);
    const mine = (versions.body.data as Body[]).filter(
      (row) => row.itemId === item.id,
    );
    assert.equal(mine.length, 2);
    assert.deepEqual(
      mine.map((row) => `${row.status}:${row.unitPrice}`).sort(),
      ['ACTIVE:2999', 'INACTIVE:2222'],
    );

    // Vendor lifecycle audit carries the tier identity.
    const replacedMeta = await eventMetadata(
      'PRICE_CATALOG_ENTRY_REPLACED',
      vendorTier.id as string,
    );
    assert.equal(replacedMeta?.vendorId, vendor.id);
    assert.equal(replacedMeta?.successorEntryId, successor.id);
    const createdMeta = await eventMetadata(
      'PRICE_CATALOG_ENTRY_CREATED',
      successor.id as string,
    );
    assert.equal(createdMeta?.vendorId, vendor.id);
    assert.equal(createdMeta?.predecessorEntryId, vendorTier.id);
  });

  it('replaces a general entry without disturbing Vendor-tier rows', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);
    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };

    const vendorTier = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 2222, vendorId: vendor.id }),
    );
    const clientWide = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 4444 }),
    );

    const replaced = await api()
      .post(`/api/v1/price-catalog/entries/${clientWide.id}/replace`)
      .set(auth())
      .set('Idempotency-Key', `REPL_${suffix()}`)
      .send({
        unitPrice: 4555,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
      });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    assert.equal(replaced.body.data.entryKind, 'REFERENCE');
    assert.equal(replaced.body.data.vendorId, null);

    const vendorRow = await api()
      .get(`/api/v1/price-catalog/entries/${vendorTier.id}`)
      .set(auth());
    assert.equal(vendorRow.body.data.status, 'ACTIVE');
    assert.equal(vendorRow.body.data.unitPrice, 2222);

    const withVendor = await lookup({ ...base, vendorId: vendor.id, asOf: '2026-07-01T00:00:00.000Z' });
    assert.equal(withVendor.body.data.scopeTier, 'VENDOR');
    assert.equal(withVendor.body.data.entry.unitPrice, 2222);

    const general = await lookup({ ...base, asOf: '2026-07-01T00:00:00.000Z' });
    assert.equal(general.body.data.scopeTier, 'CLIENT_WIDE');
    assert.equal(general.body.data.entry.unitPrice, 4555);
  });
});

describe('CR-BE-PRICE-01 PART 03 — commercial isolation', () => {
  it('never resolves one Vendor\u2019s price into another Vendor\u2019s context', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendorA = await makeVendor(fx.client.id);
    const vendorB = await makeVendor(fx.client.id);
    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };

    await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 1111,
        vendorId: vendorA.id,
        buildingId: fx.buildingA.id,
      }),
    );
    await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 1212, vendorId: vendorA.id }),
    );
    await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 2222, vendorId: vendorB.id }),
    );
    await createActiveEntry(entryBody(fx, item, uom, { unitPrice: 4444 }));

    for (const [label, vendorId, price, tier] of [
      ['vendor A context', vendorA.id, 1111, 'VENDOR_BUILDING'],
      ['vendor B context', vendorB.id, 2222, 'VENDOR'],
      ['no vendor context', undefined, 4444, 'CLIENT_WIDE'],
    ] as const) {
      const result = await lookup({ ...base, vendorId });
      assert.equal(result.body.data.resolution, 'MATCHED', label);
      assert.equal(result.body.data.scopeTier, tier, label);
      assert.equal(result.body.data.entry.unitPrice, price, label);
    }
  });

  it('keeps exclusive Vendor tiers invisible to other Vendor contexts — even as an outcome type', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendorA = await makeVendor(fx.client.id);
    const vendorB = await makeVendor(fx.client.id);
    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };

    await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 1111, vendorId: vendorA.id }),
    );

    for (const [label, vendorId] of [
      ['other-vendor context', vendorB.id],
      ['no vendor context', undefined],
    ] as const) {
      const result = await lookup({ ...base, vendorId });
      assert.equal(
        result.body.data.resolution,
        'NO_REFERENCE_PRICE',
        `${label}: the existence of vendor A\u2019s contract price must not surface`,
      );
      assert.equal(result.body.data.entry, null, label);
    }
  });

  it('keeps Vendor history out of reach across Client/Listing scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);
    const entry = await createActiveEntry(
      entryBody(fx, item, uom, { vendorId: vendor.id }),
    );

    // Authorized permissions without scope assignment: nothing is returned,
    // and single-row access to the contract price is denied.
    const outsider = await createSessionWithPermissions([
      { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
      { code: 'price_catalog.manage', name: 'Manage Price Catalog Entries' },
    ]);
    const list = await api()
      .get('/api/v1/price-catalog/entries')
      .set(auth(outsider));
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 0);

    const single = await api()
      .get(`/api/v1/price-catalog/entries/${entry.id}`)
      .set(auth(outsider));
    assert.equal(single.status, 403);

    // The authorized internal reader does see the contract tier (that is the
    // point of an internal authority — the boundary is Vendor sessions and
    // cross-Client scope, not internal stewardship).
    const own = await api()
      .get(`/api/v1/price-catalog/entries/${entry.id}`)
      .set(auth());
    assert.equal(own.status, 200);
    assert.equal(own.body.data.entryKind, 'VENDOR_CONTRACT');
  });

  it('exposes no price-catalog surface to an RFQ Vendor access session (structural)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);
    const entry = await createActiveEntry(
      entryBody(fx, item, uom, { vendorId: vendor.id }),
    );

    // Full PRO-02 vendor-session fixture: demand → RFQ → open → invitation →
    // exchange. The resulting token is a `rfq_vendor_access_sessions` token,
    // which carries no role/permission binding by design (governance §14).
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: fx.client.id,
      buildingId: fx.buildingA.id,
      requestNumber: `PRQ_${suffix()}`,
      requestType: 'SERVICE',
      title: 'Isolation probe demand',
      requestedByUserId: adminUserId,
    });
    const sr = await serviceRequestService.createServiceRequest({
      purchaseRequestId: pr.id,
      serviceType: 'HVAC',
      title: 'HVAC maintenance',
      requestedByUserId: adminUserId,
    });
    const rfq = await api()
      .post('/api/v1/rfqs')
      .set(auth())
      .send({
        purchaseRequestId: pr.id,
        sourceMode: 'SERVICE',
        rfqNumber: `RFQ_${suffix()}`,
        title: 'Isolation probe RFQ',
        currency: 'IDR',
        responseDeadline: '2030-01-01T00:00:00.000Z',
        idempotencyKey: `rfq-${randomUUID()}`,
      });
    assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
    const line = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: sr.id });
    assert.equal(line.status, 201, JSON.stringify(line.body));
    const opened = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
      .set(auth())
      .send({});
    assert.equal(opened.status, 200, JSON.stringify(opened.body));

    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: fx.buildingA.id,
    });
    const invitation = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/invitations`)
      .set(auth())
      .send({ vendorId: vendor.id, idempotencyKey: `inv-${randomUUID()}` });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const exchange = await api()
      .post('/api/v1/vendor-rfq-access/exchange')
      .send({ token: invitation.body.data.invitationToken });
    assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
    const vendorSession = exchange.body.data.sessionToken as string;
    assert.ok(vendorSession);

    // The vendor session token is not an internal user session: every
    // price-catalog route rejects it before any business logic runs.
    const lookupUrl =
      `/api/v1/price-catalog/lookup?itemId=${item.id}&uomId=${uom.id}` +
      `&buildingId=${fx.buildingA.id}&vendorId=${vendor.id}&currency=IDR` +
      `&asOf=${encodeURIComponent(T)}`;
    for (const [label, probe] of [
      ['lookup', api().get(lookupUrl).set(auth(vendorSession))],
      ['list', api().get('/api/v1/price-catalog/entries').set(auth(vendorSession))],
      [
        'single read',
        api().get(`/api/v1/price-catalog/entries/${entry.id}`).set(auth(vendorSession)),
      ],
      [
        'create command',
        api()
          .post('/api/v1/price-catalog/entries')
          .set(auth(vendorSession))
          .set('Idempotency-Key', `IDEM_${suffix()}`)
          .send(entryBody(fx, item, uom, { vendorId: vendor.id })),
      ],
    ] as const) {
      const response = await probe;
      assert.equal(
        response.status,
        401,
        `${label}: vendor sessions must never reach price authority (got ${response.status}: ${JSON.stringify(response.body)})`,
      );
    }
  });

  it('records the frozen posture: Vendor master status is a write-time gate, never a selection predicate (§8)', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const item = await makeItem(fx.client.id);
    const uom = await makeUom(fx.client.id);
    const vendor = await makeVendor(fx.client.id);
    const base = { itemId: item.id, uomId: uom.id, buildingId: fx.buildingA.id };

    const entry = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 2222, vendorId: vendor.id }),
    );

    await pool!.query(`UPDATE vendors SET status = 'INACTIVE' WHERE id = $1`, [
      vendor.id,
    ]);

    // Write-time gate: a new price for the now-inactive Vendor is denied…
    const denied = await createDraft(
      entryBody(fx, await makeItem(fx.client.id), uom, { vendorId: vendor.id }),
    );
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, 'PRICE_CATALOG_VENDOR_INVALID');

    // …while the already-governed ACTIVE authority row keeps resolving per
    // the §8 predicate, which deliberately contains no vendor-status clause.
    // Changing that would silently re-price history-derived contexts and is
    // a separate governance decision.
    const resolved = await lookup({ ...base, vendorId: vendor.id });
    assert.equal(resolved.body.data.resolution, 'MATCHED');
    assert.equal(resolved.body.data.scopeTier, 'VENDOR');
    assert.equal(resolved.body.data.entry.id, entry.id);
  });
});
