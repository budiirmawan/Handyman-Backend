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
import { poReadinessService } from '../src/modules/purchase-order-readiness';
import { roleService } from '../src/modules/roles';
import { serviceRequestService } from '../src/modules/service-requests';
import { userService } from '../src/modules/users';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorCapabilityService } from '../src/modules/vendor-capabilities';
import { vendorComplianceDocumentService } from '../src/modules/vendor-compliance-documents';
import { vendorLicenseService } from '../src/modules/vendor-licenses';
import { vendorSelectionService } from '../src/modules/vendor-selection-readiness';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PRICE-01 PART 06 — PO advisory reference-price deviation read model
 * (governance §13.3/§13.4, API §20).
 *
 * Proves: PO line → item/UOM/currency reference integrity through the frozen
 * §8 resolver (as-of = request time, PO Vendor as tier context); MATCHED
 * advisory math (PO − reference, 2dp) with ABOVE/BELOW/EQUAL; vendor-tier
 * precedence and general fallback preserved; explicit non-fabricated
 * NO_REFERENCE_PRICE / UOM_INCOMPATIBLE / CURRENCY_INCOMPATIBLE /
 * NOT_REQUESTED outcomes; AMBIGUOUS fail-closed as a typed outcome with the
 * incident audited; non-gating posture (issuance unchanged, PO facts never
 * rewritten by catalog replace/correct, nothing persisted); RFQ comparison
 * snapshots byte-stable under deviation reads; and the conjunctive
 * `purchase_order.read` + `price_catalog.read` boundary (§20) — callers
 * lacking either code are refused, and no PO payload grows reference keys.
 *
 * Deliberately excluded: settlement/accounting behavior, award/winner logic,
 * issuance gating (B-02), OpenAPI assertions (tests/price-catalog-openapi).
 */

const DB_PORT = 55500;
const DATA_DIR = '/tmp/asentra-price06-pg';
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
      purchase_order_line_history, purchase_order_lines,
      purchase_order_history, purchase_orders,
      purchase_order_readiness, vendor_selection_readiness,
      procurement_approval_bindings, service_requests, material_requests,
      purchase_requests, inventory_items, inventory_warehouses,
      units_of_measure, functional_locations,
      vendor_licenses_certifications, vendor_compliance_documents,
      vendor_capabilities, vendor_building_relationships, vendors,
      vendor_categories, users, roles, permissions,
      clients, properties, buildings CASCADE
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
const SERVICE_CODE = 'HVAC';

type Body = Record<string, unknown>;

async function fixture() {
  const client = await clientService.createClient({
    code: `PDVCLI_${suffix()}`,
    name: 'Deviation Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PDVPROP_${suffix()}`,
    name: 'Deviation Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `PDVBLDG_${suffix()}`,
    name: 'Deviation Test Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });
  const vendor = await vendorService.createVendor({
    clientId: client.id,
    vendorCode: `PDVVND_${suffix()}`,
    vendorName: 'Deviation Test Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: building.id,
  });
  await vendorCapabilityService.createVendorCapability({
    vendorId: vendor.id,
    code: SERVICE_CODE,
    name: SERVICE_CODE,
  });
  await vendorComplianceDocumentService.createVendorComplianceDocument({
    vendorId: vendor.id,
    documentType: 'BUSINESS_LICENSE',
    documentNumber: `BL_${suffix()}`,
    documentName: 'Business License',
  });
  await vendorLicenseService.createVendorLicense({
    vendorId: vendor.id,
    recordType: 'LICENSE',
    name: 'Business License',
    number: `LIC_${suffix()}`,
  });
  return { client, property, building, vendor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function makeUom(clientId: string) {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, clientId, `U${suffix()}`.slice(0, 12), 'Each', 'ea', 'COUNT'],
  );
  return { id };
}

async function makeItem(clientId: string, uomId?: string) {
  return inventoryItemService.createInventoryItem({
    clientId,
    code: `PDVITEM_${suffix()}`,
    name: 'Deviation-priced cartridge',
    itemType: 'MATERIAL',
    ...(uomId ? { uomId } : {}),
  });
}

/** Creates + activates a catalog entry (admin, manage lane). */
async function createActiveEntry(body: Body): Promise<Body> {
  const created = await api()
    .post('/api/v1/price-catalog/entries')
    .set(auth())
    .set('Idempotency-Key', `PDVIDEM_${suffix()}_${randomUUID()}`)
    .send({
      currency: 'IDR',
      effectiveFrom: PAST_FROM,
      effectiveTo: null,
      vendorId: null,
      buildingId: null,
      ...body,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activated = await api()
    .post(`/api/v1/price-catalog/entries/${created.body.data.id}/activate`)
    .set(auth())
    .send({});
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return activated.body.data as Body;
}

async function approve(prId: string) {
  const created = await api()
    .post('/api/v1/procurement-approvals')
    .set(auth())
    .send({
      requestType: 'PURCHASE_REQUEST',
      requestId: prId,
      approvalType: 'BUDGET_APPROVAL',
      approverUserId: adminUserId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const decided = await api()
    .post(`/api/v1/procurement-approvals/${created.body.data.id}/approve`)
    .set(auth())
    .send({ decisionNotes: 'approved' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
}

type LineSpec =
  | { kind: 'MATERIAL'; itemId: string; quantity: number; unitPrice: number }
  | { kind: 'SERVICE'; unitPrice: number };

/** Builds a DRAFT PO with the requested material/service lines committed. */
async function draftPoWithLines(f: Fixture, specs: LineSpec[]) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId: f.client.id,
    buildingId: f.building.id,
    requestNumber: `PDVPRQ_${suffix()}`,
    requestType: SERVICE_CODE,
    title: 'Deviation PO PR',
    requestedByUserId: adminUserId,
  });

  const mrs: string[] = [];
  let srId: string | null = null;
  for (const spec of specs) {
    if (spec.kind === 'MATERIAL') {
      const mr = await materialRequestService.createMaterialRequest({
        purchaseRequestId: pr.id,
        itemId: spec.itemId,
        quantity: spec.quantity,
        requestedByUserId: adminUserId,
      });
      mrs.push(mr.id);
    } else {
      const srq = await serviceRequestService.createServiceRequest({
        purchaseRequestId: pr.id,
        serviceType: SERVICE_CODE,
        title: 'Quarterly HVAC service',
        requestedByUserId: adminUserId,
      });
      srId = srq.id;
    }
  }

  await approve(pr.id);

  const selection = await vendorSelectionService.createVendorSelection(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    adminUserId,
  );
  assert.equal(selection.readiness, 'READY');
  const readinessRecord = await poReadinessService.createPOReadiness(
    { requestType: 'PURCHASE_REQUEST', requestId: pr.id, vendorId: f.vendor.id },
    adminUserId,
  );
  assert.equal(readinessRecord.readiness, 'READY');

  const po = await api()
    .post('/api/v1/purchase-orders')
    .set(auth())
    .send({
      poReadinessId: readinessRecord.id,
      poNumber: `PDVPO-${suffix()}`,
      poDate: '2026-08-20',
      currency: 'IDR',
    });
  assert.equal(po.status, 201, JSON.stringify(po.body));
  const poId = po.body.data.id as string;

  const lines: Body[] = [];
  let materialIndex = 0;
  for (const spec of specs) {
    const added = await api()
      .post(`/api/v1/purchase-orders/${poId}/lines`)
      .set(auth())
      .send(
        spec.kind === 'MATERIAL'
          ? {
              requestLineType: 'MATERIAL_REQUEST',
              requestLineId: mrs[materialIndex++],
              unitPrice: spec.unitPrice,
            }
          : {
              requestLineType: 'SERVICE_REQUEST',
              requestLineId: srId,
              unitPrice: spec.unitPrice,
            },
      );
    assert.equal(added.status, 201, JSON.stringify(added.body));
    lines.push(added.body.data as Body);
  }

  return { pr, po: po.body.data as Body, poId, lines };
}

async function getDeviation(poId: string, token = adminToken) {
  return api()
    .get(`/api/v1/purchase-orders/${poId}/price-deviation`)
    .set(auth(token));
}

async function createScopedUser(
  codes: readonly { code: string; name: string }[],
  buildingId?: string,
): Promise<{ token: string; userId: string }> {
  const user = await userService.createUser({
    email: `pdv-scoped-${suffix().toLowerCase()}@example.com`,
    displayName: 'Deviation Scoped User',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ScopedPass123',
  });
  const role = await roleService.createRole({
    code: `PDVSCOPED_${suffix()}`,
    name: 'Deviation Scoped Role',
  });
  for (const code of codes) {
    const existing = await permissionRepository.findByCode(code.code);
    const permissionId =
      existing?.id ??
      (await permissionService.createPermission({ code: code.code, name: code.name })).id;
    await permissionService.assignPermissionToRole(role.id, permissionId);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  if (buildingId) {
    await buildingAssignmentService.createAssignment(user.id, { buildingId });
  }
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password: 'ScopedPass123',
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function overrideUserFor(buildingId: string) {
  return createScopedUser(
    [{ code: 'price_catalog.override', name: 'Override Price Catalog Windows' }],
    buildingId,
  );
}

async function poRows(poId: string) {
  const header = await pool!.query(
    `SELECT * FROM purchase_orders WHERE id = $1`,
    [poId],
  );
  const lines = await pool!.query(
    `SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1
      ORDER BY line_number`,
    [poId],
  );
  return {
    header: header.rows,
    lines: lines.rows,
  };
}

describe('CR-BE-PRICE-01 PART 06 — MATCHED advisory math', () => {
  it('computes PO-minus-reference deviation with ABOVE/BELOW/EQUAL per line', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const itemA = await makeItem(fx.client.id, uom.id);
    const itemB = await makeItem(fx.client.id, uom.id);
    const itemC = await makeItem(fx.client.id, uom.id);
    const entryA = await createActiveEntry({
      clientId: fx.client.id, itemId: itemA.id, uomId: uom.id, unitPrice: 100,
    });
    const entryB = await createActiveEntry({
      clientId: fx.client.id, itemId: itemB.id, uomId: uom.id, unitPrice: 100,
    });
    await createActiveEntry({
      clientId: fx.client.id, itemId: itemC.id, uomId: uom.id, unitPrice: 100,
    });

    const { po, poId } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: itemA.id, quantity: 10, unitPrice: 120 },
      { kind: 'MATERIAL', itemId: itemB.id, quantity: 4, unitPrice: 80 },
      { kind: 'MATERIAL', itemId: itemC.id, quantity: 2, unitPrice: 100 },
    ]);

    const res = await getDeviation(poId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data as Body;
    assert.equal(data.purchaseOrderId, poId);
    assert.equal(data.poNumber, po.poNumber);
    assert.equal(data.purchaseOrderStatus, 'DRAFT');
    assert.equal(data.clientId, fx.client.id);
    assert.equal(data.buildingId, fx.building.id);
    assert.equal(data.vendorId, fx.vendor.id);
    assert.equal(data.currency, 'IDR');
    assert.equal(data.advisoryOnly, true);
    assert.match(data.asOf as string, /^\d{4}-\d{2}-\d{2}T/);

    const lines = data.lines as Body[];
    assert.equal(lines.length, 3);

    // ABOVE: 120 vs 100 → +20 (+20%), reference total 10 × 100 = 1000.
    const above = lines[0];
    assert.equal(above.lineNumber, 1);
    assert.equal(above.unitPrice, 120);
    assert.equal(above.lineAmount, 1200);
    assert.equal(above.quantitySnapshot, 10);
    assert.equal(above.itemId, itemA.id);
    assert.equal(above.uomId, uom.id);
    const refA = above.reference as Body;
    assert.equal(refA.resolution, 'MATCHED');
    assert.equal(refA.priceEntryId, entryA.id);
    assert.equal(refA.scopeTier, 'CLIENT_WIDE');
    assert.equal(refA.scopeVendor, false);
    assert.equal(refA.scopeBuilding, false);
    assert.equal(refA.unitPrice, 100);
    assert.equal(refA.currency, 'IDR');
    assert.equal(refA.uomId, uom.id);
    assert.equal(refA.effectiveFrom, PAST_FROM);
    assert.equal(refA.effectiveTo, null);
    assert.equal(refA.referenceTotal, 1000);
    assert.equal(refA.unitVariance, 20);
    assert.equal(refA.totalVariance, 200);
    assert.equal(refA.variancePercent, 20);
    assert.equal(refA.position, 'ABOVE');

    // BELOW: 80 vs 100 → −20 (−20%), 4 × 100 = 400.
    const refB = lines[1].reference as Body;
    assert.equal(refB.resolution, 'MATCHED');
    assert.equal(refB.priceEntryId, entryB.id);
    assert.equal(refB.referenceTotal, 400);
    assert.equal(refB.unitVariance, -20);
    assert.equal(refB.totalVariance, -80);
    assert.equal(refB.variancePercent, -20);
    assert.equal(refB.position, 'BELOW');

    // EQUAL: 100 vs 100 → 0 (0%).
    const refC = lines[2].reference as Body;
    assert.equal(refC.resolution, 'MATCHED');
    assert.equal(refC.unitVariance, 0);
    assert.equal(refC.totalVariance, 0);
    assert.equal(refC.variancePercent, 0);
    assert.equal(refC.position, 'EQUAL');
  });

  it('keeps vendor-specific precedence and general fallback intact', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);

    // Item A: VENDOR+BUILDING and VENDOR tiers both exist — V+B must win.
    const itemA = await makeItem(fx.client.id, uom.id);
    await createActiveEntry({
      clientId: fx.client.id, itemId: itemA.id, uomId: uom.id, unitPrice: 90,
      vendorId: fx.vendor.id,
    });
    const vbEntry = await createActiveEntry({
      clientId: fx.client.id, itemId: itemA.id, uomId: uom.id, unitPrice: 85,
      vendorId: fx.vendor.id, buildingId: fx.building.id,
    });
    // Item B: only general tiers — BUILDING beats CLIENT_WIDE.
    const itemB = await makeItem(fx.client.id, uom.id);
    await createActiveEntry({
      clientId: fx.client.id, itemId: itemB.id, uomId: uom.id, unitPrice: 100,
    });
    const bEntry = await createActiveEntry({
      clientId: fx.client.id, itemId: itemB.id, uomId: uom.id, unitPrice: 95,
      buildingId: fx.building.id,
    });
    // Item C: only CLIENT_WIDE — the general fallback.
    const itemC = await makeItem(fx.client.id, uom.id);
    const cwEntry = await createActiveEntry({
      clientId: fx.client.id, itemId: itemC.id, uomId: uom.id, unitPrice: 100,
    });

    const { poId } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: itemA.id, quantity: 2, unitPrice: 100 },
      { kind: 'MATERIAL', itemId: itemB.id, quantity: 2, unitPrice: 100 },
      { kind: 'MATERIAL', itemId: itemC.id, quantity: 2, unitPrice: 100 },
    ]);

    const res = await getDeviation(poId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const lines = res.body.data.lines as Body[];

    const refA = lines[0].reference as Body;
    assert.equal(refA.resolution, 'MATCHED');
    assert.equal(refA.scopeTier, 'VENDOR_BUILDING');
    assert.equal(refA.scopeVendor, true);
    assert.equal(refA.scopeBuilding, true);
    assert.equal(refA.priceEntryId, vbEntry.id);
    assert.equal(refA.unitPrice, 85);

    const refB = lines[1].reference as Body;
    assert.equal(refB.scopeTier, 'BUILDING');
    assert.equal(refB.scopeVendor, false);
    assert.equal(refB.scopeBuilding, true);
    assert.equal(refB.priceEntryId, bEntry.id);
    assert.equal(refB.unitPrice, 95);

    const refC = lines[2].reference as Body;
    assert.equal(refC.scopeTier, 'CLIENT_WIDE');
    assert.equal(refC.priceEntryId, cwEntry.id);
    assert.equal(refC.unitPrice, 100);
  });
});

describe('CR-BE-PRICE-01 PART 06 — explicit non-reference outcomes', () => {
  it('reports no-reference, UOM/currency incompatibility and NOT_REQUESTED without fabrication', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const otherUom = await makeUom(fx.client.id);

    const noRefItem = await makeItem(fx.client.id, uom.id);
    const uomItem = await makeItem(fx.client.id, uom.id);
    await createActiveEntry({
      clientId: fx.client.id, itemId: uomItem.id, uomId: otherUom.id,
      unitPrice: 100,
    });
    const currencyItem = await makeItem(fx.client.id, uom.id);
    await createActiveEntry({
      clientId: fx.client.id, itemId: currencyItem.id, uomId: uom.id,
      unitPrice: 100, currency: 'USD',
    });
    // Legacy UOM-less line shape: no item/line UOM snapshot at all.
    const legacyItem = await makeItem(fx.client.id);

    const { poId } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: noRefItem.id, quantity: 2, unitPrice: 50 },
      { kind: 'MATERIAL', itemId: uomItem.id, quantity: 2, unitPrice: 50 },
      { kind: 'MATERIAL', itemId: currencyItem.id, quantity: 2, unitPrice: 50 },
      { kind: 'MATERIAL', itemId: legacyItem.id, quantity: 2, unitPrice: 50 },
      { kind: 'SERVICE', unitPrice: 500 },
    ]);

    const res = await getDeviation(poId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const lines = res.body.data.lines as Body[];
    assert.equal(lines.length, 5);

    const expected = [
      'NO_REFERENCE_PRICE',
      'UOM_INCOMPATIBLE',
      'CURRENCY_INCOMPATIBLE',
      'UOM_INCOMPATIBLE',
      'NOT_REQUESTED',
    ];
    for (const [index, resolution] of expected.entries()) {
      const reference = lines[index].reference as Body;
      assert.equal(reference.resolution, resolution, `line ${index + 1}`);
      for (const key of [
        'priceEntryId', 'scopeTier', 'scopeVendor', 'scopeBuilding',
        'unitPrice', 'currency', 'uomId', 'effectiveFrom', 'effectiveTo',
        'referenceTotal', 'unitVariance', 'totalVariance', 'variancePercent',
        'position',
      ]) {
        assert.equal(
          reference[key],
          null,
          `${resolution} line ${index + 1} must carry null facts (${key})`,
        );
      }
    }

    // The service line carries its committed facts and an explicit
    // NOT_REQUESTED — the PO itself is never degraded by the outcome.
    const serviceLine = lines[4];
    assert.equal(serviceLine.requestLineType, 'SERVICE_REQUEST');
    assert.equal(serviceLine.unitPrice, 500);
  });

  it('fails closed on AMBIGUOUS as a typed outcome with the incident audited', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const { poId } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: item.id, quantity: 2, unitPrice: 100 },
    ]);

    // Constraint-simulated corruption (PART 02 technique): drop the
    // structural guard, stage two overlapping ACTIVE rows in one tier.
    await pool!.query(
      `ALTER TABLE price_catalog_entries
         DROP CONSTRAINT price_catalog_entries_material_window_exclusion`,
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
      await insertDuplicate(`PDVAMBIG_A_${suffix()}`, 'a'.repeat(64), 500);
      await insertDuplicate(`PDVAMBIG_B_${suffix()}`, 'b'.repeat(64), 600);

      const res = await getDeviation(poId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const reference = res.body.data.lines[0].reference as Body;
      assert.equal(reference.resolution, 'AMBIGUOUS');
      assert.equal(reference.priceEntryId, null);
      assert.equal(reference.unitPrice, null);
      assert.equal(reference.unitVariance, null);
      assert.equal(reference.position, null);

      // The resolver's auto-committed incident evidence fired exactly once
      // for this lookup — never silently degraded, never fabricated.
      const incidents = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM operational_events
          WHERE event_type = 'PRICE_CATALOG_AMBIGUITY_REJECTED'
            AND entity_id = $1`,
        [item.id],
      );
      assert.equal(Number(incidents.rows[0]?.count), 1);

      // Pure read: the PO facts are untouched by the trip.
      const rows = await poRows(poId);
      assert.equal(rows.header[0]?.status, 'DRAFT');
      assert.equal(rows.lines.length, 1);
    } finally {
      await pool!.query(
        `DELETE FROM price_catalog_entries
          WHERE idempotency_key LIKE 'PDVAMBIG_%'`,
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
  });
});

describe('CR-BE-PRICE-01 PART 06 — non-gating + historical immutability', () => {
  it('never rewrites PO facts when the catalog is replaced or override-corrected', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const entry = await createActiveEntry({
      clientId: fx.client.id, itemId: item.id, uomId: uom.id, unitPrice: 100,
    });
    const { poId } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: item.id, quantity: 2, unitPrice: 120 },
    ]);

    const baseline = await getDeviation(poId);
    assert.equal(baseline.status, 200);
    assert.equal(baseline.body.data.lines[0].reference.priceEntryId, entry.id);
    assert.equal(baseline.body.data.lines[0].reference.position, 'ABOVE');
    const rowsBefore = await poRows(poId);

    // Steward replacement 100 → 200: the projection now resolves the NEW
    // authority; the committed PO line stays byte-identical.
    const replaced = await api()
      .post(`/api/v1/price-catalog/entries/${entry.id}/replace`)
      .set(auth())
      .set('Idempotency-Key', `PDVREPL_${suffix()}`)
      .send({ unitPrice: 200, effectiveFrom: '2025-06-01T00:00:00.000Z' });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));

    const afterReplace = await getDeviation(poId);
    const replaceRef = afterReplace.body.data.lines[0].reference as Body;
    assert.equal(replaceRef.priceEntryId, replaced.body.data.id);
    assert.equal(replaceRef.unitPrice, 200);
    assert.equal(replaceRef.position, 'BELOW');
    assert.equal(replaceRef.unitVariance, -80);
    assert.deepEqual(
      await poRows(poId),
      rowsBefore,
      'a catalog replacement must never rewrite committed PO facts',
    );

    // Override retroactive correction 200 → 90: again, current authority is
    // resolved; history on the PO side does not move at all.
    const overrideUser = await overrideUserFor(fx.building.id);
    const corrected = await api()
      .post(`/api/v1/price-catalog/entries/${replaced.body.data.id}/correct`)
      .set(auth(overrideUser.token))
      .set('Idempotency-Key', `PDVCORR_${suffix()}`)
      .send({
        unitPrice: 90,
        effectiveFrom: '2024-06-01T00:00:00.000Z',
        effectiveTo: null,
        reason: 'Retroactive reference repair around a committed PO.',
      });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));

    const afterCorrect = await getDeviation(poId);
    const correctRef = afterCorrect.body.data.lines[0].reference as Body;
    assert.equal(correctRef.priceEntryId, corrected.body.data.id);
    assert.equal(correctRef.unitPrice, 90);
    assert.equal(correctRef.position, 'ABOVE');
    assert.equal(correctRef.unitVariance, 30);
    assert.deepEqual(
      await poRows(poId),
      rowsBefore,
      'an override correction must never rewrite committed PO facts',
    );

    // The read model is computed-only: neither deviation nor reference facts
    // are persisted anywhere on the PO tables (0321 deliberately unused).
    // (Price-catalog facts would carry the governed `reference_` prefix per
    // R-6/R-15; the pre-existing `vendor_reference` vendor-facing PO field is
    // unrelated legacy and stays untouched.)
    const introspection = await pool!.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_name IN ('purchase_orders', 'purchase_order_lines')
          AND (column_name LIKE '%deviation%'
            OR column_name LIKE 'reference\_%'
            OR column_name LIKE '%price_catalog%')`,
    );
    assert.equal(
      introspection.rows.length,
      0,
      `PO tables must carry no price-authority/deviation columns: ${JSON.stringify(introspection.rows)}`,
    );
  });

  it('never blocks issuance: an above-reference DRAFT PO issues normally', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    await createActiveEntry({
      clientId: fx.client.id, itemId: item.id, uomId: uom.id, unitPrice: 100,
    });
    const { poId } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: item.id, quantity: 2, unitPrice: 250 },
    ]);

    const before = await getDeviation(poId);
    assert.equal(before.body.data.lines[0].reference.position, 'ABOVE');
    assert.equal(before.body.data.lines[0].reference.variancePercent, 150);

    // §13.4: no price-based issuance gate — the ABOVE posture warns, it does
    // not stop issuance.
    const issued = await api()
      .post(`/api/v1/purchase-orders/${poId}/issue`)
      .set(auth())
      .send({});
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.data.status, 'ISSUED');

    // The advisory projection remains readable for the ISSUED record; it is
    // a report over current authority, never a gate or a settlement.
    const after = await getDeviation(poId);
    assert.equal(after.status, 200);
    assert.equal(after.body.data.purchaseOrderStatus, 'ISSUED');
    assert.equal(after.body.data.lines[0].reference.resolution, 'MATCHED');
    assert.equal(after.body.data.advisoryOnly, true);
  });

  it('leaves RFQ comparison snapshots byte-stable while deviation reads run', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    const entry = await createActiveEntry({
      clientId: fx.client.id, itemId: item.id, uomId: uom.id, unitPrice: 100,
    });

    // PART 04 chain on the same fixture: approved MR → open MATERIAL RFQ →
    // vendor quotation 120 → comparison run with a frozen MATCHED snapshot.
    const pr = await purchaseRequestService.createPurchaseRequest({
      clientId: fx.client.id,
      buildingId: fx.building.id,
      requestNumber: `PDVMPR_${suffix()}`,
      requestType: 'MATERIAL',
      title: 'Deviation snapshot comparison',
      requestedByUserId: adminUserId,
    });
    const material = await materialRequestService.createMaterialRequest({
      purchaseRequestId: pr.id,
      itemId: item.id,
      quantity: 5,
      requestedByUserId: adminUserId,
    });
    await pool!.query(
      `UPDATE material_requests
          SET status='APPROVED', approved_quantity=5,
              approved_at=NOW(), approved_by_user_id=$1
        WHERE id=$2`,
      [adminUserId, material.id],
    );
    const rfq = await api()
      .post('/api/v1/rfqs')
      .set(auth())
      .send({
        purchaseRequestId: pr.id,
        sourceMode: 'MATERIAL',
        rfqNumber: `PDVMRFQ_${suffix()}`,
        title: 'Deviation reference snapshot',
        currency: 'IDR',
        responseDeadline: '2030-01-01T00:00:00.000Z',
        idempotencyKey: `pdv-rfq-${randomUUID()}`,
      });
    assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
    const rfqLine = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/lines`)
      .set(auth())
      .send({ sourceLineType: 'MATERIAL_REQUEST', sourceLineId: material.id });
    assert.equal(rfqLine.status, 201, JSON.stringify(rfqLine.body));
    const opened = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/open`)
      .set(auth())
      .send({});
    assert.equal(opened.status, 200, JSON.stringify(opened.body));

    const invitation = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/invitations`)
      .set(auth())
      .send({ vendorId: fx.vendor.id, idempotencyKey: `pdv-inv-${randomUUID()}` });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const exchange = await api()
      .post('/api/v1/vendor-rfq-access/exchange')
      .send({ token: invitation.body.data.invitationToken });
    assert.equal(exchange.status, 200);
    const sessionToken = exchange.body.data.sessionToken as string;
    const created = await api()
      .post(`/api/v1/vendor-rfq-access/invitations/${invitation.body.data.id}/quotations`)
      .set(auth(sessionToken))
      .send({
        quotationNumber: `PDVQ_${suffix()}`,
        currency: 'IDR',
        validUntil: '2030-01-01',
        deliveryTerms: 'Delivered to the RFQ building.',
        idempotencyKey: `pdv-quote-${randomUUID()}`,
        lines: [{
          rfqLineId: rfqLine.body.data.id,
          unitPrice: 120,
          quotedQuantity: rfqLine.body.data.quantitySnapshot,
          technicalCompliance: 'COMPLIANT',
        }],
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const submitted = await api()
      .post(`/api/v1/vendor-rfq-access/quotation-revisions/${created.body.data.currentRevision.id}/submit`)
      .set(auth(sessionToken))
      .send({});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

    const comparison = await api()
      .post(`/api/v1/rfqs/${rfq.body.data.id}/comparisons`)
      .set(auth())
      .send({ idempotencyKey: `pdv-cmp-${randomUUID()}` });
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const runId = comparison.body.data.id as string;
    assert.equal(
      comparison.body.data.lines[0].offers[0].reference.priceEntryId,
      entry.id,
    );

    const snapComparison = async () => {
      const rows = await pool!.query(
        `SELECT 'lines' AS src, row_to_json(l) AS row
           FROM rfq_comparison_lines l WHERE comparison_run_id = $1
          UNION ALL
          SELECT 'evidence', row_to_json(e)
            FROM rfq_comparison_evidence e WHERE comparison_run_id = $1
          UNION ALL
          SELECT 'run', row_to_json(r)
            FROM rfq_comparison_runs r WHERE id = $1
          ORDER BY 1`,
        [runId],
      );
      return rows.rows;
    };
    const before = await snapComparison();
    const beforeRead = await api().get(`/api/v1/rfq-comparisons/${runId}`).set(auth());
    assert.equal(beforeRead.status, 200);

    // Repeated advisory reads against overlapping price authority, including
    // a PO on the same item, must not touch the frozen evidence in any row.
    const { poId } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: item.id, quantity: 5, unitPrice: 110 },
    ]);
    for (let i = 0; i < 3; i++) {
      const res = await getDeviation(poId);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.lines[0].reference.resolution, 'MATCHED');
    }

    assert.deepEqual(await snapComparison(), before);
    const afterRead = await api().get(`/api/v1/rfq-comparisons/${runId}`).set(auth());
    assert.deepEqual(afterRead.body.data, beforeRead.body.data);
  });
});

describe('CR-BE-PRICE-01 PART 06 — permission boundary (§20)', () => {
  it('requires purchase_order.read + price_catalog.read conjunctively, with Building scope', async (t) => {
    if (!requireDatabase(t)) return;
    const fx = await fixture();
    const uom = await makeUom(fx.client.id);
    const item = await makeItem(fx.client.id, uom.id);
    await createActiveEntry({
      clientId: fx.client.id, itemId: item.id, uomId: uom.id, unitPrice: 100,
    });
    const { poId, lines } = await draftPoWithLines(fx, [
      { kind: 'MATERIAL', itemId: item.id, quantity: 2, unitPrice: 120 },
    ]);

    // Unauthenticated.
    const anonymous = await api().get(`/api/v1/purchase-orders/${poId}/price-deviation`);
    assert.equal(anonymous.status, 401);

    // Neither permission.
    const plain = await createPlainSession();
    const deniedAll = await getDeviation(poId, plain);
    assert.equal(deniedAll.status, 403);
    assert.equal(deniedAll.body.error.code, 'PERMISSION_DENIED');

    // Only purchase_order.read — the price_catalog.read fence refuses first.
    const poOnly = await createScopedUser(
      [{ code: 'purchase_order.read', name: 'Read Purchase Orders' }],
      fx.building.id,
    );
    const deniedCatalog = await getDeviation(poId, poOnly.token);
    assert.equal(deniedCatalog.status, 403);
    assert.equal(deniedCatalog.body.error.code, 'PERMISSION_DENIED');

    // Only price_catalog.read — the purchase_order.read fence refuses first.
    const catalogOnly = await createScopedUser(
      [{ code: 'price_catalog.read', name: 'Read Price Catalog Entries' }],
      fx.building.id,
    );
    const deniedPo = await getDeviation(poId, catalogOnly.token);
    assert.equal(deniedPo.status, 403);
    assert.equal(deniedPo.body.error.code, 'PERMISSION_DENIED');

    // Both codes but no Building scope.
    const outOfScope = await createScopedUser([
      { code: 'purchase_order.read', name: 'Read Purchase Orders' },
      { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
    ]);
    const scopeDenied = await getDeviation(poId, outOfScope.token);
    assert.equal(scopeDenied.status, 403);
    assert.equal(scopeDenied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Both codes + scope — the governed reader.
    const reader = await createScopedUser(
      [
        { code: 'purchase_order.read', name: 'Read Purchase Orders' },
        { code: 'price_catalog.read', name: 'Read Price Catalog Entries' },
      ],
      fx.building.id,
    );
    const allowed = await getDeviation(poId, reader.token);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

    // Unknown PO / malformed id.
    const missing = await getDeviation(randomUUID(), reader.token);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'PURCHASE_ORDER_NOT_FOUND');
    const malformed = await api()
      .get('/api/v1/purchase-orders/not-a-uuid/price-deviation')
      .set(auth(reader.token));
    assert.equal(malformed.status, 400);

    // Backward compatibility: neither the PO nor its lines grow any
    // price-authority keys — masked-field surface is unchanged for
    // purchase_order.read callers.
    const poRead = await api().get(`/api/v1/purchase-orders/${poId}`).set(auth(poOnly.token));
    assert.equal(poRead.status, 200);
    assert.equal('reference' in poRead.body.data, false);
    assert.equal('priceDeviation' in poRead.body.data, false);
    assert.equal('deviation' in poRead.body.data, false);
    const linesRead = await api()
      .get(`/api/v1/purchase-orders/${poId}/lines`)
      .set(auth(poOnly.token));
    assert.equal(linesRead.status, 200);
    assert.equal(linesRead.body.data.length, lines.length);
    for (const line of linesRead.body.data as Body[]) {
      assert.equal('reference' in line, false);
      assert.equal('deviation' in line, false);
      assert.equal('variancePercent' in line, false);
    }
  });
});
