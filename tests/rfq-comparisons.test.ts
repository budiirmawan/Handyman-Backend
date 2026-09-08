import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { inventoryItemService } from '../src/modules/inventory-items';
import { materialRequestService } from '../src/modules/material-requests';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-BE-PRO-02 PART 04 — comparison evidence and human evaluation only. */
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE rfq_comparison_evaluations, rfq_comparison_evidence_attachments,
      rfq_comparison_lines, rfq_comparison_evidence, rfq_comparison_runs,
      vendor_quotation_lines, vendor_quotation_revisions, vendor_quotations,
      supporting_documents, document_versions, documents,
      rfq_vendor_access_sessions, rfq_vendor_invitations, rfq_lines, rfqs,
      service_requests, purchase_requests, vendor_building_relationships,
      vendors, users, roles, clients, properties, buildings CASCADE
  `);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
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
function auth(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
function suffix(): string { return randomUUID().slice(0, 8).toUpperCase(); }

async function buildingFor(userId = adminUserId) {
  const client = await clientService.createClient({ code: `CMPCLI_${suffix()}`, name: 'Comparison Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `CMPPROP_${suffix()}`, name: 'Comparison Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `CMPBLDG_${suffix()}`, name: 'Comparison Building' });
  await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  return { client, building };
}

async function openServiceRfq(clientId: string, buildingId: string) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId, buildingId, requestNumber: `CMPPR_${suffix()}`, requestType: 'SERVICE',
    title: 'Comparison service demand', requestedByUserId: adminUserId,
  });
  const serviceLines = await Promise.all([
    serviceRequestService.createServiceRequest({ purchaseRequestId: pr.id, serviceType: 'HVAC', title: 'Inspect AHU', requestedByUserId: adminUserId }),
    serviceRequestService.createServiceRequest({ purchaseRequestId: pr.id, serviceType: 'ELECTRICAL', title: 'Inspect generator', requestedByUserId: adminUserId }),
  ]);
  const rfq = await api().post('/api/v1/rfqs').set(auth()).send({
    purchaseRequestId: pr.id, sourceMode: 'SERVICE', rfqNumber: `CMPRFQ_${suffix()}`,
    title: 'Multi-vendor comparison', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z',
    idempotencyKey: `cmp-rfq-${randomUUID()}`,
  });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const lines = [];
  for (const serviceLine of serviceLines) {
    const response = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/lines`).set(auth()).send({
      sourceLineType: 'SERVICE_REQUEST', sourceLineId: serviceLine.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    lines.push(response.body.data);
  }
  const opened = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/open`).set(auth()).send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { rfq: rfq.body.data, lines };
}

async function openMaterialRfq(clientId: string, buildingId: string) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId, buildingId, requestNumber: `CMPMPR_${suffix()}`, requestType: 'MATERIAL',
    title: 'Comparison material demand', requestedByUserId: adminUserId,
  });
  const item = await inventoryItemService.createInventoryItem({
    clientId, code: `CMPITEM_${suffix()}`, name: 'Filter cartridge', itemType: 'MATERIAL',
  });
  const material = await materialRequestService.createMaterialRequest({
    purchaseRequestId: pr.id, itemId: item.id, quantity: 5, requestedByUserId: adminUserId,
  });
  // Approval is an existing authority. This fixture only establishes its
  // already-approved source state; comparison never changes it.
  await pool!.query(`UPDATE material_requests SET status='APPROVED', approved_quantity=quantity, approved_at=NOW(), approved_by_user_id=$1 WHERE id=$2`, [adminUserId, material.id]);
  const rfq = await api().post('/api/v1/rfqs').set(auth()).send({
    purchaseRequestId: pr.id, sourceMode: 'MATERIAL', rfqNumber: `CMPMRFQ_${suffix()}`,
    title: 'Material comparison', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z',
    idempotencyKey: `cmp-rfq-${randomUUID()}`,
  });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const line = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/lines`).set(auth()).send({ sourceLineType: 'MATERIAL_REQUEST', sourceLineId: material.id });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const opened = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/open`).set(auth()).send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { rfq: rfq.body.data, lines: [line.body.data] };
}

async function vendor(clientId: string, buildingId: string) {
  const value = await vendorService.createVendor({ clientId, vendorCode: `CMPVND_${suffix()}`, vendorName: `Comparison Vendor ${suffix()}` });
  await vendorBuildingService.assignBuildingToVendor({ vendorId: value.id, buildingId });
  return value;
}

async function accessFor(rfqId: string, vendorId: string) {
  const invitation = await api().post(`/api/v1/rfqs/${rfqId}/invitations`).set(auth()).send({ vendorId, idempotencyKey: `cmp-inv-${randomUUID()}` });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const exchange = await api().post('/api/v1/vendor-rfq-access/exchange').send({ token: invitation.body.data.invitationToken });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  return { invitation: invitation.body.data, sessionToken: exchange.body.data.sessionToken, sessionId: exchange.body.data.session.id };
}

async function quotation(access: { invitation: { id: string }; sessionToken: string }, lines: Array<{ id: string; sourceMode?: string; quantity?: number | null; quantitySnapshot?: number | null }>, prices: number[], submit: boolean) {
  const created = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`)
    .set(auth(access.sessionToken)).send({
      quotationNumber: `CMPQ_${suffix()}`, currency: 'IDR', validUntil: '2030-01-01',
      ...(lines[0]?.sourceMode === 'MATERIAL'
        ? { deliveryTerms: 'Delivered to the RFQ building.' }
        : { serviceTerms: 'Service evidence for comparison.' }),
      idempotencyKey: `cmp-quote-${randomUUID()}`,
      lines: lines.map((line, index) => ({
        rfqLineId: line.id, unitPrice: prices[index], technicalCompliance: 'COMPLIANT',
        ...(line.sourceMode === 'MATERIAL' ? { quotedQuantity: line.quantitySnapshot ?? line.quantity } : {}),
      })),
    });
  assert.equal(created.status, 201, JSON.stringify({ body: created.body, lines }));
  if (!submit) return created.body.data;
  const response = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${created.body.data.currentRevision.id}/submit`)
    .set(auth(access.sessionToken)).send({});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

describe('CR-BE-PRO-02 PART 04 — quotation comparison and evaluation', () => {
  it('preserves material RFQ quantity and submitted attachment references in the comparison snapshot', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await buildingFor();
    const { rfq, lines } = await openMaterialRfq(client.id, building.id);
    const value = await vendor(client.id, building.id);
    const access = await accessFor(rfq.id, value.id);
    const draft = await quotation(access, lines, [12], false);
    const attachment = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${draft.currentRevision.id}/attachments`).set(auth(access.sessionToken)).send({
      documentNumber: `CMPDOC_${suffix()}`, documentType: 'VENDOR_QUOTATION_ATTACHMENT', title: 'Quote evidence', fileReference: 'opaque/comparison.pdf',
    });
    assert.equal(attachment.status, 201, JSON.stringify(attachment.body));
    const submitted = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${draft.currentRevision.id}/submit`).set(auth(access.sessionToken)).send({});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const comparison = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth()).send({ idempotencyKey: `cmp-${randomUUID()}` });
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const evidenceLine = comparison.body.data.evidence[0].lines[0];
    assert.equal(evidenceLine.requiredQuantity, 5);
    assert.equal(evidenceLine.quotedQuantity, 5);
    assert.equal(evidenceLine.lineTotal, 60);
    assert.equal(comparison.body.data.evidence[0].attachments.length, 1);
    assert.equal(comparison.body.data.evidence[0].attachments[0].documentId, attachment.body.data.documentId);
  });

  it('creates an immutable multi-vendor comparison, excludes drafts, and preserves service quantity semantics', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await buildingFor();
    const { rfq, lines } = await openServiceRfq(client.id, building.id);
    const vendorA = await vendor(client.id, building.id);
    const vendorB = await vendor(client.id, building.id);
    const vendorDraft = await vendor(client.id, building.id);
    const accessA = await accessFor(rfq.id, vendorA.id);
    const accessB = await accessFor(rfq.id, vendorB.id);
    const accessDraft = await accessFor(rfq.id, vendorDraft.id);
    const submittedA = await quotation(accessA, lines, [100, 200], true);
    const submittedB = await quotation(accessB, lines, [150, 150], true);
    await quotation(accessDraft, lines, [1, 1], false);

    const comparison = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth()).send({ idempotencyKey: `cmp-${randomUUID()}` });
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const data = comparison.body.data;
    assert.equal(data.evidence.length, 2, 'draft-only quotation must not be compared');
    assert.equal(data.lines.length, 2);
    assert.deepEqual(data.lines[0].offers.map((offer: { unitPrice: number }) => offer.unitPrice).sort((a: number, b: number) => a - b), [100, 150]);
    assert.equal(data.lines[0].lowestQuotedUnitPrice, 100);
    assert.equal(data.lines[0].highestQuotedUnitPrice, 150);
    assert.equal(data.lines[0].priceDelta, 50);
    assert.equal(data.lines[0].percentageDelta, 50);
    assert.equal(data.lines[0].requiredQuantity, null);
    assert.equal(data.lines[0].offers[0].quotedQuantity, null);
    assert.equal(data.commercial.lowestTotalAmount, 300);
    assert.equal(data.commercial.highestTotalAmount, 300);
    assert.equal(data.commercial.totalPriceSpread, 0);
    assert.equal(data.commercial.lowestTotalQuotations.length, 2);
    assert.equal('winner' in data, false);
    assert.equal('recommendedVendorId' in data, false);
    assert.ok(data.evidence.some((item: { quotationRevisionId: string }) => item.quotationRevisionId === submittedA.id));
    assert.ok(data.evidence.some((item: { quotationRevisionId: string }) => item.quotationRevisionId === submittedB.id));
  });

  it('keeps earlier evidence stable after a later submitted revision and records human evaluation only', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await buildingFor();
    const { rfq, lines } = await openServiceRfq(client.id, building.id);
    const value = await vendor(client.id, building.id);
    const access = await accessFor(rfq.id, value.id);
    const first = await quotation(access, lines, [900, 100], true);
    const firstRun = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth()).send({ idempotencyKey: `cmp-${randomUUID()}` });
    assert.equal(firstRun.status, 201, JSON.stringify(firstRun.body));
    const firstComparison = firstRun.body.data;
    const firstEvidenceId = firstComparison.evidence[0].evidenceId;

    const next = await api().post(`/api/v1/vendor-rfq-access/quotations/${first.quotationId}/revisions`)
      .set(auth(access.sessionToken)).send({ currency: 'IDR', validUntil: '2030-02-01', serviceTerms: 'Revised terms.', idempotencyKey: `cmp-rev-${randomUUID()}`, lines: lines.map((line: { id: string }, index: number) => ({ rfqLineId: line.id, unitPrice: [400, 50][index], technicalCompliance: 'NON_COMPLIANT', deviationNotes: 'Manual deviation retained.' })) });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    const second = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${next.body.data.id}/submit`).set(auth(access.sessionToken)).send({});
    assert.equal(second.status, 200, JSON.stringify(second.body));

    const oldRead = await api().get(`/api/v1/rfq-comparisons/${firstComparison.id}`).set(auth());
    assert.equal(oldRead.status, 200);
    assert.equal(oldRead.body.data.evidence[0].evidenceId, firstEvidenceId);
    assert.equal(oldRead.body.data.evidence[0].totalAmount, 1000);
    assert.equal(oldRead.body.data.evidence[0].lines[0].unitPrice, 900);

    const refreshed = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth()).send({ idempotencyKey: `cmp-refresh-${randomUUID()}` });
    assert.equal(refreshed.status, 201, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.data.evidence.length, 1);
    assert.equal(refreshed.body.data.evidence[0].quotationRevisionId, second.body.data.id);
    assert.equal(refreshed.body.data.evidence.some((item: { quotationRevisionId: string }) => item.quotationRevisionId === first.id), false);
    assert.equal(refreshed.body.data.evidence[0].lines[0].technicalCompliance, 'NON_COMPLIANT');
    assert.equal(refreshed.body.data.evidence[0].lines[0].deviationNotes, 'Manual deviation retained.');

    const evaluation = await api().post(`/api/v1/rfq-comparisons/${firstComparison.id}/evaluations`).set(auth()).send({
      evidenceId: firstEvidenceId, commercialObservation: 'Both totals are equal.',
      technicalObservation: 'Review technical evidence.', complianceObservation: 'Manual review required.',
      evaluatorNote: 'No automatic choice is made.',
    });
    assert.equal(evaluation.status, 201, JSON.stringify(evaluation.body));
    const updated = await api().patch(`/api/v1/rfq-comparison-evaluations/${evaluation.body.data.id}`).set(auth()).send({ evaluatorNote: 'Updated by evaluator.' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.evidenceId, firstEvidenceId);
    assert.equal(updated.body.data.evaluatorNote, 'Updated by evaluator.');
  });

  it('fails closed when more than one submitted revision is applicable', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await buildingFor();
    const { rfq, lines } = await openServiceRfq(client.id, building.id);
    const value = await vendor(client.id, building.id);
    const access = await accessFor(rfq.id, value.id);
    await quotation(access, lines, [10, 20], true);
    const quote = await api().get('/api/v1/vendor-rfq-access/quotations/current').set(auth(access.sessionToken));
    assert.equal(quote.status, 200);
    const next = await api().post(`/api/v1/vendor-rfq-access/quotations/${quote.body.data.id}/revisions`)
      .set(auth(access.sessionToken)).send({ currency: 'IDR', validUntil: '2030-02-01', serviceTerms: 'Second revision.', idempotencyKey: `cmp-ambiguous-${randomUUID()}`, lines: lines.map((line: { id: string }) => ({ rfqLineId: line.id, unitPrice: 30, technicalCompliance: 'COMPLIANT' })) });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    await pool!.query(`UPDATE vendor_quotation_revisions SET status='SUBMITTED', submitted_at=NOW(), submitted_by_session_id=$1 WHERE id=$2`, [access.sessionId, next.body.data.id]);
    const comparison = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth()).send({ idempotencyKey: `cmp-${randomUUID()}` });
    assert.equal(comparison.status, 409, JSON.stringify(comparison.body));
    assert.equal(comparison.body.error.code, 'RFQ_COMPARISON_REVISION_AMBIGUOUS');
  });

  it('enforces Building isolation, has no Vendor comparison route, and audits exact revision evidence without financial side effects', async (t) => {
    if (!ready(t)) return;
    const first = await buildingFor();
    const { rfq, lines } = await openServiceRfq(first.client.id, first.building.id);
    const value = await vendor(first.client.id, first.building.id);
    const access = await accessFor(rfq.id, value.id);
    const submitted = await quotation(access, lines, [10, 20], true);
    const comparison = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth()).send({ idempotencyKey: `cmp-${randomUUID()}` });
    assert.equal(comparison.status, 201);
    const peer = await api().get(`/api/v1/vendor-rfq-access/comparisons/${comparison.body.data.id}`).set(auth(access.sessionToken));
    assert.notEqual(peer.status, 200);

    const otherAdmin = await createAdminUser();
    const second = await buildingFor(otherAdmin.userId);
    const hidden = await api().get(`/api/v1/rfq-comparisons/${comparison.body.data.id}`).set(auth(otherAdmin.token));
    assert.equal(hidden.status, 403);
    assert.equal(submitted.status, 'SUBMITTED');

    const events = await pool!.query<{ event_type: string; metadata: unknown }>(`SELECT event_type, metadata FROM operational_events WHERE entity_type IN ('RFQ_COMPARISON_RUN','RFQ_COMPARISON_EVALUATION') ORDER BY created_at`);
    const comparisonEvent = events.rows.find((event) => event.event_type === 'RFQ_COMPARISON_CREATED'
      && JSON.stringify(event.metadata).includes(comparison.body.data.id));
    assert.ok(comparisonEvent);
    assert.ok(JSON.stringify(comparisonEvent.metadata).includes(submitted.id));
    const financial = await pool!.query<{ po: string; commitments: string; entries: string; invoices: string }>(`SELECT (SELECT COUNT(*)::text FROM purchase_orders) po, (SELECT COUNT(*)::text FROM operational_commitments) commitments, (SELECT COUNT(*)::text FROM operational_commitment_entries) entries, (SELECT COUNT(*)::text FROM vendor_invoices) invoices`);
    assert.deepEqual(financial.rows[0], { po: '0', commitments: '0', entries: '0', invoices: '0' });
    assert.equal(second.client.id !== first.client.id, true);
  });
});
