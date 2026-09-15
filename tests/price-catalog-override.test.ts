import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { materialRequestService } from '../src/modules/material-requests';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PRICE-01 PART 05 — Override / Corrective Command.
 *
 * Proves the governed retroactive-correction lane
 * (`POST /price-catalog/entries/{id}/correct`, `price_catalog.override`):
 * a correction creates a NEW governed authority state (successor) without
 * mutating historical rows in place; the reason is mandatory evidence; the
 * act emits `PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED`; effective-date
 * semantics, vendor/general precedence, currency/UOM controls and the
 * fail-closed overlap protection are preserved; RFQ comparison snapshots
 * already frozen stay byte-stable; and unauthorized / invalid-lifecycle /
 * missing-evidence commands are rejected.
 *
 * Deliberately excluded: PO advisory deviation read model (§13.3 — deferred
 * by the PART 05 instruction scope), award/winner logic, PO issuance,
 * commitments, FX, UOM conversion, scheduler/backfill, OpenAPI (PART 06).
 */

const DB_PORT = 55499;
const DATA_DIR = '/tmp/asentra-price05-pg';
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
      rfq_comparison_evaluations, rfq_comparison_evidence_attachments,
      rfq_comparison_lines, rfq_comparison_evidence, rfq_comparison_runs,
      vendor_quotation_lines, vendor_quotation_revisions, vendor_quotations,
      supporting_documents, document_versions, documents,
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
const PAST_FROM = '2025-01-01T00:00:00.000Z';
const AS_OF_NOW = '2026-08-20T00:00:00.000Z';

type Body = Record<string, unknown>;

async function fixture(assignUserId: string | null = adminUserId) {
  const client = await clientService.createClient({
    code: `OVRCLI_${suffix()}`,
    name: 'Override Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `OVRPROP_${suffix()}`,
    name: 'Override Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `OVRBLDG_${suffix()}`,
    name: 'Override Test Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function makeUom(clientId: string) {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, `U${suffix()}`.slice(0, 12), 'Each', 'ea', 'COUNT'],
  );
  return { id };
}

async function makeItem(clientId: string, uomId: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `OVRITEM_${suffix()}`,
    name: 'Override-priced cartridge',
    itemType: 'MATERIAL',
    uomId,
  });
}

async function makeVendor(
  fx: Awaited<ReturnType<typeof fixture>>,
  assignBuilding = false,
) {
  const vendor = await vendorService.createVendor({
    clientId: fx.client.id,
    vendorCode: `OVRVND_${suffix()}`,
    vendorName: `Override Vendor ${suffix()}`,
  });
  if (assignBuilding) {
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: fx.building.id,
    });
  }
  return vendor;
}

async function createScopedUser(
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const user = await userService.createUser({
    email: `ovr-scoped-${suffix().toLowerCase()}@example.com`,
    displayName: 'Override Test Scoped User',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ScopedPass123',
  });
  const role = await roleService.createRole({
    code: `OVRSCOPED_${suffix()}`,
    name: 'Override Scoped Role',
  });
  for (const code of codes) {
    const existing = await permissionRepository.findByCode(code.code);
    const permissionId =
      existing?.id ??
      (await permissionService.createPermission({ code: code.code, name: code.name })).id;
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'ScopedPass123',
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

function overrideUserFor(buildingId: string) {
  return (async () => {
    const user = await createScopedUser([
      { code: 'price_catalog.override', name: 'Override Price Catalog Windows' },
    ]);
    await buildingAssignmentService.createAssignment(user.userId, { buildingId });
    return user;
  })();
}

function entryBody(
  fixtureData: Awaited<ReturnType<typeof fixture>>,
  item: { id: string },
  uom: { id: string },
  overrides: Body = {},
): Body {
  return {
    clientId: fixtureData.client.id,
    buildingId: fixtureData.building.id,
    vendorId: null,
    itemId: item.id,
    uomId: uom.id,
    currency: 'IDR',
    unitPrice: 100,
    effectiveFrom: PAST_FROM,
    effectiveTo: null,
    ...overrides,
  };
}

/** Creates a DRAFT entry and activates it; returns the ACTIVE entry body. */
async function createActiveEntry(body: Body): Promise<Body> {
  const created = await api()
    .post('/api/v1/price-catalog/entries')
    .set(auth())
    .set('Idempotency-Key', `OVRIDEM_${suffix()}_${randomUUID()}`)
    .send(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activated = await api()
    .post(`/api/v1/price-catalog/entries/${created.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return activated.body.data as Body;
}

async function correctEntry(
  id: string,
  body: Body,
  token: string,
  key = `OVRCORR_${suffix()}_${randomUUID()}`,
) {
  return api()
    .post(`/api/v1/price-catalog/entries/${id}/correct`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);
}

async function replaceEntry(id: string, body: Body, token = adminToken) {
  return api()
    .post(`/api/v1/price-catalog/entries/${id}/replace`)
    .set(auth(token))
    .set('Idempotency-Key', `OVRREPL_${suffix()}_${randomUUID()}`)
    .send(body);
}

async function lookup(
  params: {
    itemId: string;
    uomId: string;
    buildingId: string;
    vendorId?: string;
    asOf?: string;
  },
  token = adminToken,
) {
  const search = new URLSearchParams();
  search.set('itemId', params.itemId);
  search.set('uomId', params.uomId);
  search.set('currency', 'IDR');
  search.set('buildingId', params.buildingId);
  if (params.vendorId !== undefined) search.set('vendorId', params.vendorId);
  search.set('asOf', params.asOf ?? AS_OF_NOW);
  return api()
    .get(`/api/v1/price-catalog/lookup?${search.toString()}`)
    .set(auth(token));
}

async function overrideEvents(entityId: string) {
  const result = await pool!.query<{
    actor_user_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT actor_user_id, metadata
       FROM operational_events
      WHERE event_type = 'PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED'
        AND entity_id = $1`,
    [entityId],
  );
  return result.rows;
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

async function entryRow(id: string) {
  const result = await pool!.query<{
    status: string;
    unitPrice: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    replacedByEntryId: string | null;
  }>(
    `SELECT status,
            unit_price::text AS "unitPrice",
            effective_from AS "effectiveFrom",
            effective_to AS "effectiveTo",
            replaced_by_entry_id AS "replacedByEntryId"
       FROM price_catalog_entries WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function entryCountForItem(itemId: string): Promise<number> {
  const result = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM price_catalog_entries WHERE item_id = $1`,
    [itemId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

// ---- RFQ comparison fixture (PART 04 chain, trimmed; untouched behavior) --

async function openMaterialRfq(
  fx: Awaited<ReturnType<typeof fixture>>,
  item: { id: string },
  quantity = 5,
) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: fx.client.id,
    buildingId: fx.building.id,
    requestNumber: `OVRMPR_${suffix()}`,
    requestType: 'MATERIAL',
    title: 'Override comparison material demand',
    requestedByUserId: adminUserId,
  });
  const material = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id,
    itemId: item.id,
    quantity,
    requestedByUserId: adminUserId,
  });
  await pool!.query(
    `UPDATE material_requests
        SET status='APPROVED', approved_quantity=$3,
            approved_at=NOW(), approved_by_user_id=$1
      WHERE id=$2`,
    [adminUserId, material.id, quantity],
  );
  const rfq = await api()
    .post('/api/v1/rfqs')
    .set(auth())
    .send({
      purchaseRequestId: pr.id,
      sourceMode: 'MATERIAL',
      rfqNumber: `OVRMRFQ_${suffix()}`,
      title: 'Override snapshot comparison',
      currency: 'IDR',
      responseDeadline: '2030-01-01T00:00:00.000Z',
      idempotencyKey: `ovr-rfq-${randomUUID()}`,
    });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const line = await api()
    .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
    .set(auth())
    .send({ sourceLineType: 'MATERIAL_REQUEST', sourceLineId: material.id });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const opened = await api()
    .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
    .set(auth())
    .send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { rfq: rfq.body.data as Body, lines: [line.body.data as Body] };
}

async function accessFor(rfqId: string, vendorId: string) {
  const invitation = await api()
    .post(`/api/v1/rfqs/${rfqId}/invitations`)
    .set(auth())
    .send({ vendorId, idempotencyKey: `ovr-inv-${randomUUID()}` });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const exchange = await api()
    .post('/api/v1/vendor-rfq-access/exchange')
    .send({ token: invitation.body.data.invitationToken });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  return {
    invitation: invitation.body.data as Body,
    sessionToken: exchange.body.data.sessionToken as string,
  };
}

async function submitQuotation(
  access: { invitation: { id: string }; sessionToken: string },
  lines: Body[],
  unitPrice: number,
) {
  const created = await api()
    .post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`)
    .set(auth(access.sessionToken))
    .send({
      quotationNumber: `OVRQ_${suffix()}`,
      currency: 'IDR',
      validUntil: '2030-01-01',
      deliveryTerms: 'Delivered to the RFQ building.',
      idempotencyKey: `ovr-quote-${randomUUID()}`,
      lines: lines.map((line) => ({
        rfqLineId: line.id,
        unitPrice,
        quotedQuantity: line.quantitySnapshot,
        technicalCompliance: 'COMPLIANT',
      })),
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submitted = await api()
    .post(
      `/api/v1/vendor-rfq-access/quotation-revisions/${created.body.data.currentRevision.id}/submit`,
    )
    .set(auth(access.sessionToken))
    .send({});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return created.body.data as Body;
}

describe('CR-BE-PRICE-01 PART 05 — governed correction lifecycle', () => {
  it('corrects an entered window retroactively without rewriting historical authority', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const predecessor = await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 1250.5,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
      }),
    );
    const overrideUser = await overrideUserFor(fx.building.id);

    const corrected = await correctEntry(
      predecessor.id as string,
      {
        unitPrice: 900,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        reason: 'Contract price backdated to the contract start per amendment A-17.',
      },
      overrideUser.token,
    );
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
    const successor = corrected.body.data as Body;

    // The correction is a NEW governed authority state…
    assert.notEqual(successor.id, predecessor.id);
    assert.equal(successor.status, 'ACTIVE');
    assert.equal(successor.unitPrice, 900);
    assert.equal(successor.effectiveFrom, '2026-01-01T00:00:00.000Z');
    assert.equal(successor.effectiveTo, null);
    // …inheriting subject/scope/UOM/currency — a correction never re-scopes.
    assert.equal(successor.clientId, fx.client.id);
    assert.equal(successor.buildingId, fx.building.id);
    assert.equal(successor.vendorId, null);
    assert.equal(successor.entryKind, 'REFERENCE');
    assert.equal(successor.itemId, item.id);
    assert.equal(successor.uomId, uom.id);
    assert.equal(successor.currency, 'IDR');
    assert.equal(successor.sourceType, 'MANUAL');
    assert.equal(successor.activatedByUserId, overrideUser.userId);
    assert.equal(successor.createdByUserId, overrideUser.userId);

    // Historical authority remains queryable, byte-intact facts, lifecycle
    // linkage only (governance §11: close, never rewrite).
    const stored = await entryRow(predecessor.id as string);
    assert.equal(stored?.status, 'INACTIVE');
    assert.equal(Number(stored?.unitPrice), 1250.5);
    assert.equal(stored?.effectiveFrom.toISOString(), '2026-06-01T00:00:00.000Z');
    assert.equal(stored?.effectiveTo, null);
    assert.equal(stored?.replacedByEntryId, successor.id);
    const fetched = await api()
      .get(`/api/v1/price-catalog/entries/${predecessor.id}`)
      .set(auth());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.status, 'INACTIVE');
    assert.equal(fetched.body.data.unitPrice, 1250.5);
    assert.equal(fetched.body.data.replacedByEntryId, successor.id);
    assert.equal(fetched.body.data.deactivatedByUserId, overrideUser.userId);
    assert.ok(fetched.body.data.deactivatedAt);
    assert.equal(await entryCountForItem(item.id), 2);

    // Audit evidence: one override event on the predecessor carrying the
    // reason, the permission code used and both windows; the successor gets
    // the ordinary CREATED + ACTIVATED trail. No REPLACED event — the
    // correction vocabulary is distinct (§17).
    const events = await overrideEvents(predecessor.id as string);
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.equal(events[0].actor_user_id, overrideUser.userId);
    assert.equal(
      events[0].metadata.reason,
      'Contract price backdated to the contract start per amendment A-17.',
    );
    assert.equal(events[0].metadata.permissionCode, 'price_catalog.override');
    assert.equal(events[0].metadata.successorEntryId, successor.id);
    assert.equal(events[0].metadata.effectiveFrom, '2026-06-01T00:00:00.000Z');
    assert.equal(events[0].metadata.unitPrice, 1250.5);
    assert.equal(events[0].metadata.correctedUnitPrice, 900);
    assert.equal(
      events[0].metadata.correctedEffectiveFrom,
      '2026-01-01T00:00:00.000Z',
    );
    assert.equal(await eventCount('PRICE_CATALOG_ENTRY_REPLACED', predecessor.id as string), 0);
    assert.equal(await eventCount('PRICE_CATALOG_ENTRY_CREATED', successor.id as string), 1);
    assert.equal(await eventCount('PRICE_CATALOG_ENTRY_ACTIVATED', successor.id as string), 1);

    // The corrected authority governs by its NEW effective lifecycle —
    // including the retroactive period the ordinary replace lane refuses.
    const retro = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
      asOf: '2026-03-01T00:00:00.000Z',
    });
    assert.equal(retro.status, 200, JSON.stringify(retro.body));
    assert.equal(retro.body.data.resolution, 'MATCHED');
    assert.equal(retro.body.data.scopeTier, 'BUILDING');
    assert.equal(retro.body.data.entry.id, successor.id);
    assert.equal(retro.body.data.entry.unitPrice, 900);

    const current = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
    });
    assert.equal(current.body.data.entry.id, successor.id);

    const beforeWindow = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
      asOf: '2025-12-01T00:00:00.000Z',
    });
    assert.equal(beforeWindow.body.data.resolution, 'NO_REFERENCE_PRICE');
    assert.equal(beforeWindow.body.data.entry, null);

    // The ordinary manage lane still refuses retroactive windows exactly as
    // PART 01 froze — override is the only path into the past.
    const retroReplace = await replaceEntry(successor.id as string, {
      unitPrice: 950,
      effectiveFrom: '2025-06-01T00:00:00.000Z',
    });
    assert.equal(retroReplace.status, 400);
    assert.equal(
      retroReplace.body.error.code,
      'PRICE_CATALOG_EFFECTIVE_WINDOW_INVALID',
    );
  });

  it('applies the corrective authority only from its own effective window', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const predecessor = await createActiveEntry(
      entryBody(fx, item, uom, { unitPrice: 100 }),
    );
    const overrideUser = await overrideUserFor(fx.building.id);

    const corrected = await correctEntry(
      predecessor.id as string,
      {
        unitPrice: 120,
        effectiveFrom: '2030-01-01T00:00:00.000Z',
        effectiveTo: null,
        reason: 'Future-dated corrective price agreed with the supplier.',
      },
      overrideUser.token,
    );
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));

    // Before the successor's window there is no tier authority (the
    // predecessor is closed, like PART 01 replacement close semantics); a
    // lookup never "pre-applies" the coming correction.
    const now = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
    });
    assert.equal(now.status, 200);
    assert.equal(now.body.data.resolution, 'NO_REFERENCE_PRICE');
    assert.equal(now.body.data.entry, null);

    const future = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
      asOf: '2030-06-01T00:00:00.000Z',
    });
    assert.equal(future.body.data.resolution, 'MATCHED');
    assert.equal(future.body.data.entry.id, corrected.body.data.id);
    assert.equal(future.body.data.entry.unitPrice, 120);
  });

  it('replays the correction idempotently and conflicts on changed evidence', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const predecessor = await createActiveEntry(entryBody(fx, item, uom));
    const overrideUser = await overrideUserFor(fx.building.id);

    const key = `OVRCORR_${suffix()}`;
    const body = {
      unitPrice: 88,
      effectiveFrom: '2024-06-01T00:00:00.000Z',
      effectiveTo: null,
      reason: 'Retroactive contract price repair.',
    };
    const first = await correctEntry(predecessor.id as string, body, overrideUser.token, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const replay = await correctEntry(predecessor.id as string, body, overrideUser.token, key);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, first.body.data.id);

    const differentPrice = await correctEntry(
      predecessor.id as string,
      { ...body, unitPrice: 89 },
      overrideUser.token,
      key,
    );
    assert.equal(differentPrice.status, 409);
    assert.equal(
      differentPrice.body.error.code,
      'PRICE_CATALOG_IDEMPOTENCY_CONFLICT',
    );

    // A replayed key with a different reason is evidence tampering — conflict.
    const differentReason = await correctEntry(
      predecessor.id as string,
      { ...body, reason: 'A different reason.' },
      overrideUser.token,
      key,
    );
    assert.equal(differentReason.status, 409);
    assert.equal(
      differentReason.body.error.code,
      'PRICE_CATALOG_IDEMPOTENCY_CONFLICT',
    );

    assert.equal(await entryCountForItem(item.id), 2);
    assert.equal((await overrideEvents(predecessor.id as string)).length, 1);
  });
});

describe('CR-BE-PRICE-01 PART 05 — authorization boundary (§14)', () => {
  it('rejects every caller without an explicitly assigned price_catalog.override', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const entry = await createActiveEntry(entryBody(fx, item, uom));
    const body = {
      unitPrice: 90,
      effectiveFrom: PAST_FROM,
      effectiveTo: null,
      reason: 'Authorization matrix probe.',
    };

    // A caller with no price permissions at all.
    const plain = await createPlainSession();
    const noPerms = await correctEntry(entry.id as string, body, plain);
    assert.equal(noPerms.status, 403);
    assert.equal(noPerms.body.error.code, 'PERMISSION_DENIED');

    // The broad test administrator holds price_catalog.read + .manage but
    // override is unassigned by default — stewards must never inherit it.
    const adminAttempt = await correctEntry(entry.id as string, body, adminToken);
    assert.equal(adminAttempt.status, 403);
    assert.equal(adminAttempt.body.error.code, 'PERMISSION_DENIED');

    // A designated price steward (manage) still lacks the exceptional lane:
    // .manage does not imply .override.
    const steward = await createScopedUser([
      { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
      { code: 'price_catalog.manage', name: 'Manage Price Catalog Entries' },
    ]);
    await buildingAssignmentService.createAssignment(steward.userId, {
      buildingId: fx.building.id,
    });
    const stewardAttempt = await correctEntry(entry.id as string, body, steward.token);
    assert.equal(stewardAttempt.status, 403);
    assert.equal(stewardAttempt.body.error.code, 'PERMISSION_DENIED');

    // …while the same steward keeps the ordinary manage lane.
    const stewardReplace = await replaceEntry(
      entry.id as string,
      { unitPrice: 110, effectiveFrom: '2026-06-01T00:00:00.000Z' },
      steward.token,
    );
    assert.equal(stewardReplace.status, 201, JSON.stringify(stewardReplace.body));

    // An override holder outside the entry's Building scope is denied by
    // the scope gate, not by permission.
    const successor = stewardReplace.body.data as Body;
    const outOfScope = await createScopedUser([
      { code: 'price_catalog.override', name: 'Override Price Catalog Windows' },
    ]);
    const scopeDenied = await correctEntry(successor.id as string, body, outOfScope.token);
    assert.equal(scopeDenied.status, 403);
    assert.equal(scopeDenied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The override code alone (no read/manage) authorizes the command in scope.
    const overrideUser = await overrideUserFor(fx.building.id);
    const allowed = await correctEntry(successor.id as string, body, overrideUser.token);
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.unitPrice, 90);

    // …and does NOT grant steward powers (codes stay distinct per §14).
    const notSteward = await replaceEntry(
      allowed.body.data.id as string,
      { unitPrice: 95, effectiveFrom: '2026-07-01T00:00:00.000Z' },
      overrideUser.token,
    );
    assert.equal(notSteward.status, 403);
    const notCreator = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth(overrideUser.token))
      .set('Idempotency-Key', `OVRIDEM_${suffix()}`)
      .send(entryBody(fx, item, uom));
    assert.equal(notCreator.status, 403);
  });
});

describe('CR-BE-PRICE-01 PART 05 — mandatory reason/evidence', () => {
  it('rejects every correction without a non-empty length-checked reason', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const entry = await createActiveEntry(entryBody(fx, item, uom));
    const overrideUser = await overrideUserFor(fx.building.id);
    const base = {
      unitPrice: 90,
      effectiveFrom: PAST_FROM,
      effectiveTo: null,
    };

    for (const missing of [
      base,
      { ...base, reason: null },
      { ...base, reason: '' },
      { ...base, reason: '   ' },
      { ...base, reason: 'x'.repeat(1001) },
      { ...base, reason: 42 },
    ]) {
      const attempt = await correctEntry(entry.id as string, missing, overrideUser.token);
      assert.equal(attempt.status, 400, JSON.stringify({ missing, body: attempt.body }));
      assert.equal(attempt.body.error.code, 'VALIDATION_ERROR');
    }

    // Well-formed reason but no idempotency key is still refused.
    const noKey = await api()
      .post(`/api/v1/price-catalog/entries/${entry.id}/correct`)
      .set(auth(overrideUser.token))
      .send({ ...base, reason: 'Valid reason, missing key.' });
    assert.equal(noKey.status, 400);
    assert.equal(
      noKey.body.error.code,
      'PRICE_CATALOG_IDEMPOTENCY_KEY_REQUIRED',
    );

    // Every refusal was side-effect free: no successor, no close, no event.
    const stored = await entryRow(entry.id as string);
    assert.equal(stored?.status, 'ACTIVE');
    assert.equal(stored?.replacedByEntryId, null);
    assert.equal(await entryCountForItem(item.id), 1);
    assert.equal((await overrideEvents(entry.id as string)).length, 0);
  });
});

describe('CR-BE-PRICE-01 PART 05 — lifecycle transition guards', () => {
  it('rejects corrections on non-ACTIVE entries and malformed windows', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const overrideUser = await overrideUserFor(fx.building.id);
    const reason = 'Lifecycle transition probe.';

    // DRAFT is freely editable under .manage — it is not an override case.
    const draftCreated = await api()
      .post('/api/v1/price-catalog/entries')
      .set(auth())
      .set('Idempotency-Key', `OVRIDEM_${suffix()}`)
      .send(entryBody(fx, item, uom));
    assert.equal(draftCreated.status, 201);
    const draft = await correctEntry(
      draftCreated.body.data.id,
      { unitPrice: 90, effectiveFrom: PAST_FROM, reason },
      overrideUser.token,
    );
    assert.equal(draft.status, 409);
    assert.equal(draft.body.error.code, 'PRICE_CATALOG_NOT_ACTIVE');

    // INACTIVE (deactivated) is terminal history.
    const deactivatedEntry = await createActiveEntry(entryBody(fx, item, uom, { unitPrice: 7 }));
    // Deactivation requires the tier window to be free afterwards, so
    // deactivate first, then attempt the correction on the closed row.
    const deactivated = await api()
      .post(`/api/v1/price-catalog/entries/${deactivatedEntry.id}/deactivate`)
      .set(auth())
      .send({});
    assert.equal(deactivated.status, 200);
    const onInactive = await correctEntry(
      deactivatedEntry.id as string,
      { unitPrice: 8, effectiveFrom: PAST_FROM, reason },
      overrideUser.token,
    );
    assert.equal(onInactive.status, 409);
    assert.equal(onInactive.body.error.code, 'PRICE_CATALOG_NOT_ACTIVE');

    // An already-replaced predecessor cannot be corrected again.
    const replacedEntry = await createActiveEntry(entryBody(fx, item, uom, { unitPrice: 11 }));
    const replaced = await replaceEntry(replacedEntry.id as string, {
      unitPrice: 12,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(replaced.status, 201);
    const onReplaced = await correctEntry(
      replacedEntry.id as string,
      { unitPrice: 13, effectiveFrom: PAST_FROM, reason },
      overrideUser.token,
    );
    assert.equal(onReplaced.status, 409);
    assert.equal(onReplaced.body.error.code, 'PRICE_CATALOG_NOT_ACTIVE');

    // A correction whose successor window is malformed is a validation fault.
    // (A distinct item keeps this target in its own exclusion key — the tier
    // above legitimately holds the replacement successor's ACTIVE window.)
    const item2 = await makeItem(fx.client.id, uom.id);
    const target = await createActiveEntry(entryBody(fx, item2, uom, { unitPrice: 15 }));
    const inverted = await correctEntry(
      target.id as string,
      {
        unitPrice: 16,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: '2026-06-01T00:00:00.000Z',
        reason,
      },
      overrideUser.token,
    );
    assert.equal(inverted.status, 400);
    assert.equal(inverted.body.error.code, 'PRICE_CATALOG_EFFECTIVE_WINDOW_INVALID');

    // Unknown entry.
    const missing = await correctEntry(
      randomUUID(),
      { unitPrice: 16, effectiveFrom: PAST_FROM, reason },
      overrideUser.token,
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'PRICE_CATALOG_ENTRY_NOT_FOUND');

    // All refused attempts left the catalog untouched.
    const finalRow = await entryRow(target.id as string);
    assert.equal(finalRow?.status, 'ACTIVE');
    assert.equal((await overrideEvents(target.id as string)).length, 0);
  });
});

describe('CR-BE-PRICE-01 PART 05 — precedence + fail-closed protections', () => {
  it('preserves vendor/general tier precedence through corrections', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const vendor = await makeVendor(fx);
    const overrideUser = await overrideUserFor(fx.building.id);

    const general = await createActiveEntry(
      entryBody(fx, item, uom, { buildingId: null, unitPrice: 100 }),
    );
    assert.equal(general.entryKind, 'REFERENCE');
    const vendorEntry = await createActiveEntry(
      entryBody(fx, item, uom, {
        buildingId: null,
        vendorId: vendor.id,
        unitPrice: 80,
      }),
    );
    assert.equal(vendorEntry.entryKind, 'VENDOR_CONTRACT');

    // Correct the general (Client-wide) tier retroactively…
    const correctedGeneral = await correctEntry(
      general.id as string,
      {
        unitPrice: 90,
        effectiveFrom: '2024-06-01T00:00:00.000Z',
        effectiveTo: null,
        reason: 'Retroactive repair of the general reference price.',
      },
      overrideUser.token,
    );
    assert.equal(correctedGeneral.status, 201, JSON.stringify(correctedGeneral.body));

    // …the vendor tier still wins for that vendor (governance §8 order)…
    const withVendor = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
      vendorId: vendor.id,
    });
    assert.equal(withVendor.body.data.resolution, 'MATCHED');
    assert.equal(withVendor.body.data.scopeTier, 'VENDOR');
    assert.equal(withVendor.body.data.entry.id, vendorEntry.id);
    assert.equal(withVendor.body.data.entry.unitPrice, 80);

    // …and non-vendor resolution sees the corrected general authority.
    const withoutVendor = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
    });
    assert.equal(withoutVendor.body.data.resolution, 'MATCHED');
    assert.equal(withoutVendor.body.data.scopeTier, 'CLIENT_WIDE');
    assert.equal(withoutVendor.body.data.entry.id, correctedGeneral.body.data.id);
    assert.equal(withoutVendor.body.data.entry.unitPrice, 90);

    // The vendor-tier row itself was never touched by the general correction.
    const vendorStored = await entryRow(vendorEntry.id as string);
    assert.equal(vendorStored?.status, 'ACTIVE');
    assert.equal(Number(vendorStored?.unitPrice), 80);

    // Correct the vendor tier — the general tier stays intact and untouched.
    const correctedVendor = await correctEntry(
      vendorEntry.id as string,
      {
        unitPrice: 70,
        effectiveFrom: PAST_FROM,
        effectiveTo: null,
        reason: 'Retroactive repair of the vendor contract tier price.',
      },
      overrideUser.token,
    );
    assert.equal(correctedVendor.status, 201, JSON.stringify(correctedVendor.body));

    const vendorAfter = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
      vendorId: vendor.id,
    });
    assert.equal(vendorAfter.body.data.scopeTier, 'VENDOR');
    assert.equal(vendorAfter.body.data.entry.id, correctedVendor.body.data.id);
    assert.equal(vendorAfter.body.data.entry.unitPrice, 70);

    const generalAfter = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
    });
    assert.equal(generalAfter.body.data.entry.id, correctedGeneral.body.data.id);
    assert.equal(generalAfter.body.data.entry.unitPrice, 90);
  });

  it('stays fail-closed: a corrective window may not overlap a same-tier ACTIVE window', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const overrideUser = await overrideUserFor(fx.building.id);

    // Two adjacent, non-overlapping ACTIVE windows in one tier.
    const early = await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 50,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-06-01T00:00:00.000Z',
      }),
    );
    const late = await createActiveEntry(
      entryBody(fx, item, uom, {
        unitPrice: 60,
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
      }),
    );

    // Retroactively correcting the later window back into the early window
    // would create exactly the ambiguity the exclusion constraint forbids.
    const overlap = await correctEntry(
      late.id as string,
      {
        unitPrice: 55,
        effectiveFrom: '2026-03-01T00:00:00.000Z',
        effectiveTo: null,
        reason: 'Attempted retroactive correction overlapping a live window.',
      },
      overrideUser.token,
    );
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error.code, 'PRICE_CATALOG_WINDOW_OVERLAP');

    // Rolled back completely: both windows ACTIVE as before, no successor,
    // no override evidence.
    const earlyStored = await entryRow(early.id as string);
    assert.equal(earlyStored?.status, 'ACTIVE');
    const lateStored = await entryRow(late.id as string);
    assert.equal(lateStored?.status, 'ACTIVE');
    assert.equal(lateStored?.replacedByEntryId, null);
    assert.equal(await entryCountForItem(item.id), 2);
    assert.equal((await overrideEvents(late.id as string)).length, 0);

    // Resolution is still deterministic against the untouched windows.
    const before = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
      asOf: '2026-03-01T00:00:00.000Z',
    });
    assert.equal(before.body.data.entry.id, early.id);
    const after = await lookup({
      itemId: item.id,
      uomId: uom.id,
      buildingId: fx.building.id,
    });
    assert.equal(after.body.data.entry.id, late.id);
  });
});

describe('CR-BE-PRICE-01 PART 05 — historical snapshot preservation', () => {
  it('leaves an existing RFQ comparison reference snapshot byte-stable after correction', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const entry = await createActiveEntry(
      entryBody(fx, item, uom, { buildingId: null, unitPrice: 100 }),
    );
    const { rfq, lines } = await openMaterialRfq(fx, item);
    const vendor = await makeVendor(fx, true);
    const access = await accessFor(rfq.id as string, vendor.id);
    await submitQuotation(access, lines, 120);

    const comparison = await api()
      .post(`/api/v1/rfqs/${rfq.id}/comparisons`)
      .set(auth())
      .send({ idempotencyKey: `ovr-cmp-${randomUUID()}` });
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const runId = comparison.body.data.id as string;
    assert.equal(
      comparison.body.data.lines[0].offers[0].reference.priceEntryId,
      entry.id,
    );
    assert.equal(
      comparison.body.data.lines[0].offers[0].reference.resolution,
      'MATCHED',
    );

    // Freeze the full read-model payload as the historical baseline.
    const before = await api().get(`/api/v1/rfq-comparisons/${runId}`).set(auth());
    assert.equal(before.status, 200);

    // The governed authority is retroactively corrected (100 → 95).
    const overrideUser = await overrideUserFor(fx.building.id);
    const corrected = await correctEntry(
      entry.id as string,
      {
        unitPrice: 95,
        effectiveFrom: '2024-06-01T00:00:00.000Z',
        effectiveTo: null,
        reason: 'Retroactive reference repair; historical runs remain evidence.',
      },
      overrideUser.token,
    );
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));

    // The frozen run is byte-stable through the read model.
    const afterRead = await api()
      .get(`/api/v1/rfq-comparisons/${runId}`)
      .set(auth());
    assert.equal(afterRead.status, 200);
    assert.deepEqual(
      afterRead.body.data,
      before.body.data,
      'a governed correction must never rewrite a frozen comparison run',
    );

    // …and at storage level: the snapshot still cites the original
    // (now-INACTIVE) authority row with its frozen facts.
    const stored = await pool!.query<{
      priceEntryId: string | null;
      unitPrice: string | null;
      resolution: string | null;
      position: string | null;
    }>(
      `SELECT reference_price_entry_id AS "priceEntryId",
              reference_unit_price::text AS "unitPrice",
              reference_resolution AS "resolution",
              position_vs_reference AS "position"
         FROM rfq_comparison_lines WHERE comparison_run_id = $1`,
      [runId],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].priceEntryId, entry.id);
    assert.equal(Number(stored.rows[0].unitPrice), 100);
    assert.equal(stored.rows[0].resolution, 'MATCHED');
    assert.equal(stored.rows[0].position, 'ABOVE');

    // Currency of truth moves forward independently: a NEW run resolves the
    // corrected authority — history and current truth coexist.
    const second = await api()
      .post(`/api/v1/rfqs/${rfq.id}/comparisons`)
      .set(auth())
      .send({ idempotencyKey: `ovr-cmp-${randomUUID()}` });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.data.id, runId);
    assert.equal(
      second.body.data.lines[0].offers[0].reference.priceEntryId,
      corrected.body.data.id,
    );
    assert.equal(
      second.body.data.lines[0].offers[0].reference.unitPrice,
      95,
    );
  });
});
