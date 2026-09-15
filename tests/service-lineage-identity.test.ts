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
import { permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { materialRequestService } from '../src/modules/material-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SVC-01 PART 04 — SERVICE Procurement Lineage Identity.
 *
 * Proves the governed Service Catalog identity propagates through the existing
 * SERVICE procurement lineage (Service Request → RFQ Line → Vendor Quotation
 * Line → Award/PO Line) as additive, identity-only snapshots, while preserving
 * PRO-02 / R2P-01 SERVICE shape constraints and MATERIAL behavior. Required
 * proofs: (1) SR→RFQ, (2) RFQ→quotation, (3) award→PO, (4) MATERIAL unchanged,
 * (5) SERVICE has no item/UOM/quantity, (6) historical NULL valid,
 * (7) cross-Client injection impossible, (8) no auto-backfill.
 */

const DB_PORT = 55504;
const DATA_DIR = '/tmp/asentra-svc04-pg';
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
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const key = (p: string) => `${p}-${randomUUID()}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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
    TRUNCATE rfq_award_po_line_provenance, rfq_award_po_conversions,
      rfq_awards, rfq_recommendations, procurement_approval_bindings,
      purchase_order_line_history, purchase_order_lines, purchase_order_history,
      purchase_orders, purchase_order_readiness, rfq_comparison_evaluations,
      rfq_comparison_lines, rfq_comparison_evidence, rfq_comparison_runs,
      vendor_quotation_lines, vendor_quotation_revisions, vendor_quotations,
      supporting_documents, document_versions, documents,
      rfq_vendor_access_sessions, rfq_vendor_invitations, rfq_lines, rfqs,
      service_requests, material_requests, purchase_requests, service_catalog,
      vendor_building_relationships, vendors, inventory_items, units_of_measure,
      users, roles, permissions, clients, properties, buildings CASCADE
  `);
  const owner = await createAdminUser();
  ownerToken = owner.token;
  ownerUserId = owner.userId;
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

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function fixture() {
  const client = await clientService.createClient({ code: `P4CLI_${suffix()}`, name: 'Lineage Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P4PROP_${suffix()}`, name: 'Lineage Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `P4BLDG_${suffix()}`, name: 'Lineage Building' });
  await buildingAssignmentService.createAssignment(ownerUserId, { buildingId: building.id });
  const approver = await createAdminUser();
  await buildingAssignmentService.createAssignment(approver.userId, { buildingId: building.id });
  const awarder = await createAdminUser();
  await buildingAssignmentService.createAssignment(awarder.userId, { buildingId: building.id });
  let perm = await pool!.query<{ id: string }>('SELECT id FROM permissions WHERE code=$1', ['rfq.award']);
  if (!perm.rows[0]) {
    const created = await permissionService.createPermission({ code: 'rfq.award', name: 'Finalize RFQ Awards' });
    perm = { rows: [{ id: created.id }] } as typeof perm;
  }
  const role = await pool!.query<{ role_id: string }>("SELECT role_id FROM user_role_assignments WHERE user_id=$1 AND status='ACTIVE' LIMIT 1", [awarder.userId]);
  await pool!.query(`INSERT INTO role_permission_assignments (id, role_id, permission_id, status) VALUES ($1,$2,$3,'ACTIVE')`, [randomUUID(), role.rows[0].role_id, perm.rows[0].id]);
  return { client, building, approver, awarder };
}

async function makeCatalog(clientId: string, code: string) {
  const res = await api().post('/api/v1/service-catalog/entries').set(auth(ownerToken)).send({ clientId, code, name: code, category: 'ENGINEERING' });
  assert.equal(res.status, 201, `catalog: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

async function createGovernedServiceChain(f: Awaited<ReturnType<typeof fixture>>, code: string, catalogId: string | null) {
  const pr = await purchaseRequestService.createPurchaseRequest({ clientId: f.client.id, buildingId: f.building.id, requestNumber: `P4PR_${suffix()}`, requestType: code, title: 'Lineage demand', requestedByUserId: ownerUserId });
  const service = await serviceRequestService.createServiceRequest({ purchaseRequestId: pr.id, serviceType: code, title: 'Lineage service', requestedByUserId: ownerUserId, ...(catalogId ? { serviceCatalogId: catalogId } : {}) });
  const rfq = await api().post('/api/v1/rfqs').set(auth(ownerToken)).send({ purchaseRequestId: pr.id, sourceMode: 'SERVICE', rfqNumber: `P4RFQ_${suffix()}`, title: 'Lineage RFQ', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z', idempotencyKey: key('rfq') });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const line = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/lines`).set(auth(ownerToken)).send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: service.id });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  return { pr, service, rfq: rfq.body.data, line: line.body.data };
}

async function rfqLineIdentity(rfqLineId: string) {
  return pool!.query<{ ss: string | null; item: string | null; uom: string | null; qty: string | null }>(
    `SELECT source_service_id AS "ss", source_item_id AS "item", source_uom_id AS "uom", quantity_snapshot AS "qty" FROM rfq_lines WHERE id=$1`,
    [rfqLineId],
  );
}

describe('CR-BE-SVC-01 PART 04 — SR → RFQ line propagation', () => {
  it('1. governed Service Request identity reaches the RFQ line (SERVICE shape preserved)', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'HVAC');
    const chain = await createGovernedServiceChain(f, 'HVAC', catalog);

    const row = (await rfqLineIdentity(chain.line.id)).rows[0];
    assert.equal(row?.ss, catalog, 'source_service_id must equal the governed catalog');
    // SERVICE shape preserved: no item, no UOM, no quantity.
    assert.equal(row?.item, null);
    assert.equal(row?.uom, null);
    assert.equal(row?.qty, null);

    // identity not caller-widenable: the line read exposes it as a snapshot.
    const read = await api().get(`/api/v1/rfqs/${chain.rfq.id}/lines`).set(auth(ownerToken));
    assert.equal(read.status, 200);
    const found = read.body.data.find((l: { id: string }) => l.id === chain.line.id);
    assert.equal(found.sourceServiceId, catalog);
    assert.equal(found.sourceItemId, null);
    assert.equal(found.sourceUomId, null);
  });

  it('6. historical un-governed SERVICE keeps NULL identity and still works', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    await makeCatalog(f.client.id, 'LEGACY_HVAC'); // a matching catalog exists…
    const chain = await createGovernedServiceChain(f, 'LEGACY_HVAC', null); // …but the request is un-governed

    const row = (await rfqLineIdentity(chain.line.id)).rows[0];
    assert.equal(row?.ss, null); // no auto-linking/backfill
    // The RFQ still opens normally with a NULL identity.
    const opened = await api().post(`/api/v1/rfqs/${chain.rfq.id}/open`).set(auth(ownerToken)).send({});
    assert.equal(opened.status, 200);
  });
});

describe('CR-BE-SVC-01 PART 04 — RFQ → quotation line propagation', () => {
  it('2. RFQ service identity reaches the quotation line/revision', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'CLEANING');
    const chain = await createGovernedServiceChain(f, 'CLEANING', catalog);
    await api().post(`/api/v1/rfqs/${chain.rfq.id}/open`).set(auth(ownerToken)).send({}).then((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));

    const vendor = await vendorService.createVendor({ clientId: f.client.id, vendorCode: `P4VND_${suffix()}`, vendorName: 'Quote Vendor' });
    await vendorBuildingService.assignBuildingToVendor({ vendorId: vendor.id, buildingId: f.building.id });
    const invitation = await api().post(`/api/v1/rfqs/${chain.rfq.id}/invitations`).set(auth(ownerToken)).send({ vendorId: vendor.id, idempotencyKey: key('inv') });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const exchange = await api().post('/api/v1/vendor-rfq-access/exchange').send({ token: invitation.body.data.invitationToken });
    assert.equal(exchange.status, 200);
    const quote = await api().post(`/api/v1/vendor-rfq-access/invitations/${invitation.body.data.id}/quotations`).set(auth(exchange.body.data.sessionToken)).send({ currency: 'IDR', validUntil: '2030-01-01', serviceTerms: 'ok', idempotencyKey: key('q'), lines: [{ rfqLineId: chain.line.id, unitPrice: 100, technicalCompliance: 'COMPLIANT' }] });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));

    const qline = await pool!.query<{ ss: string | null; rq: string | null; ru: string | null }>(
      `SELECT source_service_id AS "ss", required_quantity_snapshot AS "rq", required_uom_id AS "ru" FROM vendor_quotation_lines WHERE rfq_line_id=$1`,
      [chain.line.id],
    );
    assert.equal(qline.rows[0]?.ss, catalog, 'quotation line preserves RFQ service identity');
    assert.equal(qline.rows[0]?.rq, null); // SERVICE shape: no quantity
    assert.equal(qline.rows[0]?.ru, null); // SERVICE shape: no UOM
  });
});

describe('CR-BE-SVC-01 PART 04 — award → PO line propagation', () => {
  it('3. awarded SERVICE identity reaches the RFQ→PO provenance / PO line', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const catalog = await makeCatalog(f.client.id, 'SECURITY');
    const chain = await createGovernedServiceChain(f, 'SECURITY', catalog);
    await api().post(`/api/v1/rfqs/${chain.rfq.id}/open`).set(auth(ownerToken)).send({}).then((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));

    const vendor = await vendorService.createVendor({ clientId: f.client.id, vendorCode: `P4VND_${suffix()}`, vendorName: 'Award Vendor' });
    await vendorBuildingService.assignBuildingToVendor({ vendorId: vendor.id, buildingId: f.building.id });
    const invitation = await api().post(`/api/v1/rfqs/${chain.rfq.id}/invitations`).set(auth(ownerToken)).send({ vendorId: vendor.id, idempotencyKey: key('inv') });
    assert.equal(invitation.status, 201);
    const exchange = await api().post('/api/v1/vendor-rfq-access/exchange').send({ token: invitation.body.data.invitationToken });
    assert.equal(exchange.status, 200);
    const quote = await api().post(`/api/v1/vendor-rfq-access/invitations/${invitation.body.data.id}/quotations`).set(auth(exchange.body.data.sessionToken)).send({ currency: 'IDR', validUntil: '2030-01-01', serviceTerms: 'ok', idempotencyKey: key('q'), lines: [{ rfqLineId: chain.line.id, unitPrice: 333, technicalCompliance: 'COMPLIANT' }] });
    assert.equal(quote.status, 201);
    await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${quote.body.data.currentRevision.id}/submit`).set(auth(exchange.body.data.sessionToken)).send({}).then((r) => assert.equal(r.status, 200));
    const comparison = await api().post(`/api/v1/rfqs/${chain.rfq.id}/comparisons`).set(auth(ownerToken)).send({ idempotencyKey: key('cmp') });
    assert.equal(comparison.status, 201);
    await api().post(`/api/v1/rfqs/${chain.rfq.id}/close`).set(auth(ownerToken)).send({}).then((r) => assert.equal(r.status, 200));
    const recommendation = await api().post(`/api/v1/rfqs/${chain.rfq.id}/recommendations`).set(auth(ownerToken)).send({ comparisonRunId: comparison.body.data.id, evidenceId: comparison.body.data.evidence[0].evidenceId, reason: 'rec' });
    assert.equal(recommendation.status, 201);
    const approval = await api().post('/api/v1/procurement-approvals').set(auth(ownerToken)).send({ requestType: 'RFQ', requestId: chain.rfq.id, recommendationId: recommendation.body.data.id, approvalType: 'RFQ_AWARD', approverUserId: f.approver.userId });
    assert.equal(approval.status, 201);
    await api().post(`/api/v1/procurement-approvals/${approval.body.data.id}/approve`).set(auth(f.approver.token)).send({ decisionNotes: 'ok' }).then((r) => assert.equal(r.status, 200));
    const award = await api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(f.awarder.token)).send({ awardReason: 'award' });
    assert.equal(award.status, 201);

    const readiness = await pool!.query<{ id: string }>(
      `INSERT INTO purchase_order_readiness (id,client_id,building_id,request_type,purchase_request_id,service_request_id,vendor_id,material_context_ok,service_context_ok,approval_ok,vendor_ok,readiness,prepared_by_user_id) VALUES ($1,$2,$3,'PURCHASE_REQUEST',$4,NULL,$5,TRUE,TRUE,TRUE,TRUE,'READY',$6) RETURNING id`,
      [randomUUID(), f.client.id, f.building.id, chain.pr.id, vendor.id, ownerUserId],
    );
    const convert = await api().post(`/api/v1/rfq-awards/${award.body.data.id}/convert-to-po`).set(auth(f.awarder.token)).send({ poReadinessId: readiness.rows[0].id, poNumber: `P4PO_${suffix()}`, poDate: '2026-08-24', idempotencyKey: key('conv'), notes: 'converted' });
    assert.equal(convert.status, 201, JSON.stringify(convert.body));

    const poLine = await pool!.query<{ ss: string | null; item: string | null; uom: string | null; qty: string | null }>(
      `SELECT pol.source_service_id AS "ss", pol.item_id AS "item", pol.uom_id AS "uom", pol.quantity_snapshot AS "qty"
         FROM purchase_order_lines pol
         JOIN rfq_award_po_line_provenance prov ON prov.purchase_order_line_id = pol.id
        WHERE prov.rfq_line_id = $1`,
      [chain.line.id],
    );
    assert.equal(poLine.rows[0]?.ss, catalog, 'PO line preserves governed service identity through provenance');
    assert.equal(poLine.rows[0]?.item, null); // SERVICE shape preserved on PO line
    assert.equal(poLine.rows[0]?.uom, null);
    assert.equal(poLine.rows[0]?.qty, null);
  });
});

describe('CR-BE-SVC-01 PART 04 — MATERIAL compatibility + structural safety', () => {
  it('4. MATERIAL RFQ line keeps NULL service identity and full MATERIAL shape', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const uomId = randomUUID();
    await pool!.query(`INSERT INTO units_of_measure (id, client_id, code, name, symbol, category) VALUES ($1,$2,$3,$4,$5,$6)`, [uomId, f.client.id, `EA${suffix()}`.slice(0, 12), 'Each', 'ea', 'COUNT']);
    const item = await inventoryItemService.createInventoryItem({ clientId: f.client.id, code: `ITEM_${suffix()}`, name: 'Bolt', itemType: 'MATERIAL', uomId });
    const pr = await purchaseRequestService.createPurchaseRequest({ clientId: f.client.id, buildingId: f.building.id, requestNumber: `P4PR_${suffix()}`, requestType: 'MATERIAL', title: 'M demand', requestedByUserId: ownerUserId });
    const mr = await materialRequestService.createMaterialRequest({ purchaseRequestId: pr.id, itemId: item.id, quantity: 10, uomId, requestedByUserId: ownerUserId });
    const rfq = await api().post('/api/v1/rfqs').set(auth(ownerToken)).send({ purchaseRequestId: pr.id, sourceMode: 'MATERIAL', rfqNumber: `P4RFQ_${suffix()}`, title: 'M RFQ', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z', idempotencyKey: key('rfq') });
    assert.equal(rfq.status, 201);
    const line = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/lines`).set(auth(ownerToken)).send({ sourceLineType: 'MATERIAL_REQUEST', sourceLineId: mr.id });
    assert.equal(line.status, 201, JSON.stringify(line.body));

    const row = (await rfqLineIdentity(line.body.data.id)).rows[0];
    assert.equal(row?.ss, null, 'MATERIAL line has no service identity');
    assert.equal(row?.item, item.id); // MATERIAL shape intact
    assert.equal(row?.uom, uomId);
    assert.equal(row?.qty, '10');
  });

  it('7. cross-Client service identity injection is structurally impossible (composite FK)', async (t) => {
    if (!ready(t)) return;
    const fxA = await fixture();
    const fxB = await fixture();
    const catalogB = await makeCatalog(fxB.client.id, 'FOREIGN_SVC');
    const chain = await createGovernedServiceChain(fxA, 'SHARED', null); // SR under client A

    // A direct cross-Client injection into rfq_lines is rejected by the
    // composite scope FK (source_service_id, client_id).
    await assert.rejects(
      pool!.query(
        `UPDATE rfq_lines SET source_service_id=$1 WHERE id=$2`,
        [catalogB, chain.line.id],
      ),
      /rfq_lines_service_catalog_scope_fk|foreign key/i,
    );
    // The row remains NULL (un-governed), untouched by the failed injection.
    const row = (await rfqLineIdentity(chain.line.id)).rows[0];
    assert.equal(row?.ss, null);
  });

  it('5+8. SERVICE rows have no item/UOM/quantity and no auto-backfill occurs', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    // Catalog exists but the request is un-governed → no auto-linking.
    await makeCatalog(f.client.id, 'NOBACKFILL');
    const chain = await createGovernedServiceChain(f, 'NOBACKFILL', null);
    const row = (await rfqLineIdentity(chain.line.id)).rows[0];
    assert.equal(row?.ss, null); // no auto-backfill
    assert.equal(row?.item, null);
    assert.equal(row?.uom, null);
    assert.equal(row?.qty, null);
  });
});
