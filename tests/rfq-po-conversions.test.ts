import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-BE-PRO-02 PART 06 — conversion/provenance and existing PO boundaries. */
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let ownerToken = '';
let ownerUserId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE rfq_award_po_line_provenance, rfq_award_po_conversions,
      rfq_awards, rfq_recommendations, procurement_approval_bindings,
      purchase_order_line_history, purchase_order_lines, purchase_order_history,
      purchase_orders, purchase_order_readiness, rfq_comparison_evaluations,
      rfq_comparison_evidence_attachments, rfq_comparison_lines,
      rfq_comparison_evidence, rfq_comparison_runs, vendor_quotation_lines,
      vendor_quotation_revisions, vendor_quotations, supporting_documents,
      document_versions, documents, rfq_vendor_access_sessions,
      rfq_vendor_invitations, rfq_lines, rfqs, service_requests,
      purchase_requests, vendor_building_relationships, vendors, users, roles,
      permissions, clients, properties, buildings CASCADE
  `);
  const owner = await createAdminUser();
  ownerToken = owner.token;
  ownerUserId = owner.userId;
  database = db;
});
after(async () => {
  if (pool) await closePool(pool);
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
function key(prefix: string): string { return `${prefix}-${randomUUID()}`; }

async function fixture() {
  const client = await clientService.createClient({ code: `P6CLI_${suffix()}`, name: 'Conversion Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P6PROP_${suffix()}`, name: 'Conversion Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `P6BLDG_${suffix()}`, name: 'Conversion Building' });
  await buildingAssignmentService.createAssignment(ownerUserId, { buildingId: building.id });
  const approver = await createAdminUser();
  await buildingAssignmentService.createAssignment(approver.userId, { buildingId: building.id });
  const awarder = await createAdminUser();
  await buildingAssignmentService.createAssignment(awarder.userId, { buildingId: building.id });
  let permission = await pool!.query<{ id: string }>('SELECT id FROM permissions WHERE code=$1', ['rfq.award']);
  if (!permission.rows[0]) {
    const created = await permissionService.createPermission({ code: 'rfq.award', name: 'Finalize RFQ Awards' });
    permission = { rows: [{ id: created.id }] } as typeof permission;
  }
  const role = await pool!.query<{ role_id: string }>('SELECT role_id FROM user_role_assignments WHERE user_id=$1 AND status=\'ACTIVE\' LIMIT 1', [awarder.userId]);
  await pool!.query(`INSERT INTO role_permission_assignments (id, role_id, permission_id, status) VALUES ($1,$2,$3,'ACTIVE')`, [randomUUID(), role.rows[0].role_id, permission.rows[0].id]);
  return { client, building, approver, awarder };
}

async function createOpenRfq(clientId: string, buildingId: string) {
  const pr = await purchaseRequestService.createPurchaseRequest({ clientId, buildingId, requestNumber: `P6PR_${suffix()}`, requestType: 'SERVICE', title: 'Conversion demand', requestedByUserId: ownerUserId });
  const service = await serviceRequestService.createServiceRequest({ purchaseRequestId: pr.id, serviceType: 'HVAC', title: 'Conversion service', requestedByUserId: ownerUserId });
  const rfq = await api().post('/api/v1/rfqs').set(auth(ownerToken)).send({ purchaseRequestId: pr.id, sourceMode: 'SERVICE', rfqNumber: `P6RFQ_${suffix()}`, title: 'Conversion RFQ', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z', idempotencyKey: key('rfq') });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const line = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/lines`).set(auth(ownerToken)).send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: service.id });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const opened = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/open`).set(auth(ownerToken)).send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { rfq: rfq.body.data, line: line.body.data, pr, service };
}

async function awardFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await createOpenRfq(f.client.id, f.building.id);
  const vendor = await vendorService.createVendor({ clientId: f.client.id, vendorCode: `P6VND_${suffix()}`, vendorName: 'Conversion Vendor' });
  await vendorBuildingService.assignBuildingToVendor({ vendorId: vendor.id, buildingId: f.building.id });
  const invitation = await api().post(`/api/v1/rfqs/${source.rfq.id}/invitations`).set(auth(ownerToken)).send({ vendorId: vendor.id, idempotencyKey: key('inv') });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const exchange = await api().post('/api/v1/vendor-rfq-access/exchange').send({ token: invitation.body.data.invitationToken });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  const quote = await api().post(`/api/v1/vendor-rfq-access/invitations/${invitation.body.data.id}/quotations`).set(auth(exchange.body.data.sessionToken)).send({ currency: 'IDR', validUntil: '2030-01-01', serviceTerms: 'Conversion service terms', idempotencyKey: key('quote'), lines: [{ rfqLineId: source.line.id, unitPrice: 222, technicalCompliance: 'COMPLIANT' }] });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const submitted = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${quote.body.data.currentRevision.id}/submit`).set(auth(exchange.body.data.sessionToken)).send({});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const comparison = await api().post(`/api/v1/rfqs/${source.rfq.id}/comparisons`).set(auth(ownerToken)).send({ idempotencyKey: key('cmp') });
  assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
  const closed = await api().post(`/api/v1/rfqs/${source.rfq.id}/close`).set(auth(ownerToken)).send({});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const recommendation = await api().post(`/api/v1/rfqs/${source.rfq.id}/recommendations`).set(auth(ownerToken)).send({ comparisonRunId: comparison.body.data.id, evidenceId: comparison.body.data.evidence[0].evidenceId, reason: 'Human recommendation for conversion test.' });
  assert.equal(recommendation.status, 201, JSON.stringify(recommendation.body));
  const approval = await api().post('/api/v1/procurement-approvals').set(auth(ownerToken)).send({ requestType: 'RFQ', requestId: source.rfq.id, recommendationId: recommendation.body.data.id, approvalType: 'RFQ_AWARD', approverUserId: f.approver.userId });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  const approved = await api().post(`/api/v1/procurement-approvals/${approval.body.data.id}/approve`).set(auth(f.approver.token)).send({ decisionNotes: 'Approved for conversion.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const award = await api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(f.awarder.token)).send({ awardReason: 'Award finalized for conversion.' });
  assert.equal(award.status, 201, JSON.stringify(award.body));
  const readiness = await pool!.query<{ id: string }>(
    `INSERT INTO purchase_order_readiness
       (id,client_id,building_id,request_type,purchase_request_id,service_request_id,
        vendor_id,material_context_ok,service_context_ok,approval_ok,vendor_ok,readiness,prepared_by_user_id)
     VALUES ($1,$2,$3,'PURCHASE_REQUEST',$4,NULL,$5,TRUE,TRUE,TRUE,TRUE,'READY',$6)
     RETURNING id`,
    [randomUUID(), f.client.id, f.building.id, source.pr.id, vendor.id, ownerUserId],
  );
  return { ...f, ...source, vendor, invitation: invitation.body.data, submitted: submitted.body.data, award: award.body.data, readinessId: readiness.rows[0].id };
}

describe('CR-BE-PRO-02 PART 06 — PO conversion and provenance', () => {
  it('converts an approved award idempotently into an existing DRAFT PO with exact line provenance', async (t) => {
    if (!ready(t)) return;
    const f = await awardFixture(await fixture());
    const body = { poReadinessId: f.readinessId, poNumber: `P6PO_${suffix()}`, poDate: '2026-08-24', idempotencyKey: key('conversion'), notes: 'Converted from finalized award.' };
    const calls = await Promise.all([
      api().post(`/api/v1/rfq-awards/${f.award.id}/convert-to-po`).set(auth(f.awarder.token)).send(body),
      api().post(`/api/v1/rfq-awards/${f.award.id}/convert-to-po`).set(auth(f.awarder.token)).send(body),
    ]);
    assert.deepEqual(calls.map((response) => response.status).sort((a, b) => a - b), [201, 201]);
    assert.equal(calls[0].body.data.id, calls[1].body.data.id);
    const data = calls[0].body.data;
    assert.equal(data.purchaseOrder.status, 'DRAFT');
    assert.equal(data.purchaseOrder.vendorId, f.vendor.id);
    assert.equal(data.purchaseOrder.currency, 'IDR');
    assert.equal(data.purchaseOrderLines.length, 1);
    assert.equal(data.purchaseOrderLines[0].serviceRequestId, f.service.id);
    assert.equal(data.purchaseOrderLines[0].unitPrice, 222);
    assert.equal(data.purchaseOrderLines[0].lineAmount, 222);
    assert.equal(data.lineProvenance[0].rfqLineId, f.line.id);
    assert.equal(data.lineProvenance[0].quotationLineId, f.submitted.lines[0].id);
    const provenance = await api().get(`/api/v1/purchase-orders/${data.purchaseOrder.id}/rfq-provenance`).set(auth(f.awarder.token));
    assert.equal(provenance.status, 200);
    assert.equal(provenance.body.data.id, data.id);
    const stored = await pool!.query<{ conversions: string; lines: string; commitments: string; po: string }>(`SELECT (SELECT COUNT(*)::text FROM rfq_award_po_conversions) conversions, (SELECT COUNT(*)::text FROM rfq_award_po_line_provenance) lines, (SELECT COUNT(*)::text FROM operational_commitments) commitments, (SELECT COUNT(*)::text FROM purchase_orders) po`);
    assert.deepEqual(stored.rows[0], { conversions: '1', lines: '1', commitments: '0', po: '1' });
  });

  it('guards RFQ-derived DRAFT PO mutation while preserving explicit issuance and commitment boundary', async (t) => {
    if (!ready(t)) return;
    const f = await awardFixture(await fixture());
    const conversion = await api().post(`/api/v1/rfq-awards/${f.award.id}/convert-to-po`).set(auth(f.awarder.token)).send({ poReadinessId: f.readinessId, poNumber: `P6PO_${suffix()}`, poDate: '2026-08-24', idempotencyKey: key('conversion') });
    assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
    const poId = conversion.body.data.purchaseOrder.id;
    const lineId = conversion.body.data.purchaseOrderLines[0].id;
    for (const response of [
      await api().patch(`/api/v1/purchase-orders/${poId}`).set(auth(f.awarder.token)).send({ notes: 'Must not diverge.' }),
      await api().post(`/api/v1/purchase-orders/${poId}/cancel`).set(auth(f.awarder.token)).send({}),
      await api().patch(`/api/v1/purchase-order-lines/${lineId}`).set(auth(f.awarder.token)).send({ unitPrice: 1 }),
      await api().delete(`/api/v1/purchase-order-lines/${lineId}`).set(auth(f.awarder.token)),
      await api().post(`/api/v1/purchase-orders/${poId}/lines`).set(auth(f.awarder.token)).send({ requestLineType: 'SERVICE_REQUEST', requestLineId: f.service.id, unitPrice: 1 }),
    ]) {
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'PURCHASE_ORDER_RFQ_DERIVED_IMMUTABLE');
    }
    const issued = await api().post(`/api/v1/purchase-orders/${poId}/issue`).set(auth(f.awarder.token)).send({});
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.data.status, 'ISSUED');
    const financial = await pool!.query<{ commitments: string; entries: string }>(`SELECT (SELECT COUNT(*)::text FROM operational_commitments) commitments, (SELECT COUNT(*)::text FROM operational_commitment_entries) entries`);
    assert.deepEqual(financial.rows[0], { commitments: '0', entries: '0' });
  });
});
