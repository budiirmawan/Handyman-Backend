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

/**
 * CR-BE-PRO-02 PART 03 — Quotation + Immutable Revisions + Attachments.
 * Does not exercise comparison, recommendation, approval, award, PO, budget,
 * commitment, scheduler, or Vendor WhatsApp behavior.
 */

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
    TRUNCATE vendor_quotation_lines, vendor_quotation_revisions,
      vendor_quotations, supporting_documents, document_versions, documents,
      rfq_vendor_access_sessions, rfq_vendor_invitations, rfq_lines, rfqs,
      material_requests, service_requests, purchase_requests,
      vendor_building_relationships, vendors, users, roles, clients,
      properties, buildings CASCADE
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
function internalAuth(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
function externalAuth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();

async function createBuilding(userId = adminUserId) {
  const client = await clientService.createClient({ code: `CLI_${suffix()}`, name: 'Quotation Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `PROP_${suffix()}`, name: 'Quotation Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `BLDG_${suffix()}`, name: 'Quotation Building' });
  await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  return { client, property, building };
}

async function createOpenServiceRfq(clientId: string, buildingId: string, internalToken = adminToken) {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId, buildingId, requestNumber: `PRQ_${suffix()}`, requestType: 'SERVICE',
    title: 'Quotation service demand', requestedByUserId: adminUserId,
  });
  const sr = await serviceRequestService.createServiceRequest({
    purchaseRequestId: pr.id, serviceType: 'HVAC', title: 'HVAC maintenance', requestedByUserId: adminUserId,
  });
  const created = await api().post('/api/v1/rfqs').set(internalAuth(internalToken)).send({
    purchaseRequestId: pr.id, sourceMode: 'SERVICE', rfqNumber: `RFQ_${suffix()}`,
    title: 'HVAC quotation request', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z',
    idempotencyKey: `rfq-${randomUUID()}`,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const line = await api().post(`/api/v1/rfqs/${created.body.data.id}/lines`).set(internalAuth(internalToken)).send({
    sourceLineType: 'SERVICE_REQUEST', sourceLineId: sr.id,
  });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const opened = await api().post(`/api/v1/rfqs/${created.body.data.id}/open`).set(internalAuth(internalToken)).send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { pr, sr, rfq: created.body.data, rfqLine: line.body.data };
}

async function createVendor(clientId: string, buildingId: string, email?: string) {
  const vendor = await vendorService.createVendor({
    clientId, vendorCode: `VND_${suffix()}`, vendorName: `Quotation Vendor ${suffix()}`,
    ...(email === undefined ? {} : { email }),
  });
  await vendorBuildingService.assignBuildingToVendor({ vendorId: vendor.id, buildingId });
  return vendor;
}

async function inviteAndExchange(rfqId: string, vendorId: string) {
  const invitation = await api().post(`/api/v1/rfqs/${rfqId}/invitations`).set(internalAuth()).send({
    vendorId, idempotencyKey: `inv-${randomUUID()}`,
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const exchange = await api().post('/api/v1/vendor-rfq-access/exchange').send({
    token: invitation.body.data.invitationToken,
  });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  return { invitation: invitation.body.data, exchange: exchange.body.data };
}

function quotationBody(rfqLineId: string, key = `quote-${randomUUID()}`) {
  return {
    quotationNumber: `VQ-${suffix()}`,
    currency: 'IDR',
    validUntil: '2030-01-01',
    leadTimeDays: 14,
    serviceTerms: 'Service performed during approved operating hours.',
    notes: 'Vendor quotation draft.',
    idempotencyKey: key,
    lines: [{
      rfqLineId, unitPrice: 1250000, technicalCompliance: 'COMPLIANT',
      description: 'HVAC maintenance service',
    }],
  };
}

describe('CR-BE-PRO-02 PART 03 — quotation foundation', () => {
  it('creates an invited Vendor quotation draft with NUMERIC-derived total and no commitment', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await createBuilding();
    const { rfq, rfqLine } = await createOpenServiceRfq(client.id, building.id);
    const vendor = await createVendor(client.id, building.id, 'quotes@example.com');
    const access = await inviteAndExchange(rfq.id, vendor.id);

    const created = await api()
      .post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`)
      .set(externalAuth(access.exchange.sessionToken))
      .send(quotationBody(rfqLine.id));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'DRAFT');
    assert.equal(created.body.data.vendorId, vendor.id);
    assert.equal(created.body.data.currentRevision.status, 'DRAFT');
    assert.equal(created.body.data.currentRevision.currency, 'IDR');
    assert.equal(created.body.data.currentRevision.totalAmount, 1250000);
    assert.equal(created.body.data.currentRevision.lines[0].rfqLineId, rfqLine.id);

    const financial = await pool!.query<{ po: string; commitments: string }>(
      `SELECT (SELECT COUNT(*)::text FROM purchase_orders) AS po,
              (SELECT COUNT(*)::text FROM operational_commitments) AS commitments`,
    );
    assert.equal(financial.rows[0].po, '0');
    assert.equal(financial.rows[0].commitments, '0');
  });

  it('allows only the invited Vendor to update its current DRAFT revision and supports idempotent create', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await createBuilding();
    const { rfq, rfqLine } = await createOpenServiceRfq(client.id, building.id);
    const vendor = await createVendor(client.id, building.id);
    const access = await inviteAndExchange(rfq.id, vendor.id);
    const key = `quote-${randomUUID()}`;
    const body = quotationBody(rfqLine.id, key);

    const first = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`).set(externalAuth(access.exchange.sessionToken)).send(body);
    const replay = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`).set(externalAuth(access.exchange.sessionToken)).send(body);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, first.body.data.id);

    const revisionId = first.body.data.currentRevision.id;
    const updated = await api().patch(`/api/v1/vendor-rfq-access/quotation-revisions/${revisionId}`).set(externalAuth(access.exchange.sessionToken)).send({
      notes: 'Updated only while draft.', leadTimeDays: 21,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.leadTimeDays, 21);

    const lineId = updated.body.data.lines[0].id;
    const line = await api().patch(`/api/v1/vendor-rfq-access/quotation-lines/${lineId}`).set(externalAuth(access.exchange.sessionToken)).send({ unitPrice: 1500000 });
    assert.equal(line.status, 200, JSON.stringify(line.body));
    assert.equal(line.body.data.lineTotal, 1500000);

    const internal = await api().get(`/api/v1/vendor-quotations/${first.body.data.id}`).set(internalAuth());
    assert.equal(internal.status, 200);
    assert.equal(internal.body.data.currentRevision.lines[0].unitPrice, 1500000);
  });

  it('rejects currency mismatch, invalid terms, and incomplete technical compliance at submission', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await createBuilding();
    const { rfq, rfqLine } = await createOpenServiceRfq(client.id, building.id);
    const vendor = await createVendor(client.id, building.id);
    const access = await inviteAndExchange(rfq.id, vendor.id);

    const mismatch = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`).set(externalAuth(access.exchange.sessionToken)).send({
      ...quotationBody(rfqLine.id), currency: 'USD',
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'VENDOR_QUOTATION_CURRENCY_MISMATCH');

    const created = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`).set(externalAuth(access.exchange.sessionToken)).send({
      ...quotationBody(rfqLine.id),
      serviceTerms: undefined,
      technicalCompliance: undefined,
      lines: [{ rfqLineId: rfqLine.id, unitPrice: 10 }],
      idempotencyKey: `incomplete-${randomUUID()}`,
    });
    assert.equal(created.status, 201);
    const submit = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${created.body.data.currentRevision.id}/submit`).set(externalAuth(access.exchange.sessionToken)).send({});
    assert.equal(submit.status, 400);
    assert.equal(submit.body.error.code, 'VENDOR_QUOTATION_TECHNICAL_COMPLIANCE_INVALID');
  });

  it('freezes submitted revisions and requires a new revision for later commercial changes', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await createBuilding();
    const { rfq, rfqLine } = await createOpenServiceRfq(client.id, building.id);
    const vendor = await createVendor(client.id, building.id);
    const access = await inviteAndExchange(rfq.id, vendor.id);
    const created = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`).set(externalAuth(access.exchange.sessionToken)).send(quotationBody(rfqLine.id));
    const firstRevisionId = created.body.data.currentRevision.id;
    const submitted = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${firstRevisionId}/submit`).set(externalAuth(access.exchange.sessionToken)).send({});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.status, 'SUBMITTED');

    const frozenUpdate = await api().patch(`/api/v1/vendor-rfq-access/quotation-revisions/${firstRevisionId}`).set(externalAuth(access.exchange.sessionToken)).send({ notes: 'Must be rejected.' });
    assert.equal(frozenUpdate.status, 409);
    assert.equal(frozenUpdate.body.error.code, 'VENDOR_QUOTATION_REVISION_NOT_DRAFT');
    const frozenLine = await api().patch(`/api/v1/vendor-rfq-access/quotation-lines/${submitted.body.data.lines[0].id}`).set(externalAuth(access.exchange.sessionToken)).send({ unitPrice: 1 });
    assert.equal(frozenLine.status, 409);

    const quoteId = created.body.data.id;
    const next = await api().post(`/api/v1/vendor-rfq-access/quotations/${quoteId}/revisions`).set(externalAuth(access.exchange.sessionToken)).send({
      currency: 'IDR', validUntil: '2030-02-01', serviceTerms: 'Revised service terms.',
      idempotencyKey: `revision-${randomUUID()}`,
      lines: [{ rfqLineId: rfqLine.id, unitPrice: 1750000, technicalCompliance: 'COMPLIANT' }],
    });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal(next.body.data.revisionNumber, 2);
    assert.equal(next.body.data.status, 'DRAFT');
    const secondSubmitted = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${next.body.data.id}/submit`).set(externalAuth(access.exchange.sessionToken)).send({});
    assert.equal(secondSubmitted.status, 200, JSON.stringify(secondSubmitted.body));
    assert.equal(secondSubmitted.body.data.status, 'SUBMITTED');

    const revisions = await api().get(`/api/v1/vendor-rfq-access/quotations/${quoteId}/revisions`).set(externalAuth(access.exchange.sessionToken));
    assert.equal(revisions.status, 200);
    assert.deepEqual(revisions.body.data.map((item: { revisionNumber: number; status: string }) => [item.revisionNumber, item.status]), [[2, 'SUBMITTED'], [1, 'SUPERSEDED']]);
    const invitation = await api().get(`/api/v1/rfq-vendor-invitations/${access.invitation.id}`).set(internalAuth());
    assert.equal(invitation.body.data.status, 'QUOTATION_SUBMITTED');
  });

  it('uses shared Documents, Versions, and Supporting Documents for Vendor attachments', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await createBuilding();
    const { rfq, rfqLine } = await createOpenServiceRfq(client.id, building.id);
    const vendor = await createVendor(client.id, building.id);
    const access = await inviteAndExchange(rfq.id, vendor.id);
    const created = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`).set(externalAuth(access.exchange.sessionToken)).send(quotationBody(rfqLine.id));
    const revisionId = created.body.data.currentRevision.id;

    const attachment = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${revisionId}/attachments`).set(externalAuth(access.exchange.sessionToken)).send({
      documentNumber: `QDOC-${suffix()}`, documentType: 'VENDOR_QUOTATION_ATTACHMENT',
      title: 'Signed quotation PDF', fileReference: 'opaque-storage/quotation.pdf',
    });
    assert.equal(attachment.status, 201, JSON.stringify(attachment.body));
    assert.equal(attachment.body.data.parentType, 'QUOTATION_REVISION');
    assert.equal(attachment.body.data.parentId, revisionId);
    assert.equal(attachment.body.data.fileReference, 'opaque-storage/quotation.pdf');

    const vendorList = await api().get(`/api/v1/vendor-rfq-access/quotation-revisions/${revisionId}/attachments`).set(externalAuth(access.exchange.sessionToken));
    assert.equal(vendorList.status, 200);
    assert.equal(vendorList.body.data.length, 1);
    const internalList = await api().get(`/api/v1/quotation-revisions/${revisionId}/attachments`).set(internalAuth());
    assert.equal(internalList.status, 200);

    const counts = await pool!.query<{ docs: string; versions: string; links: string }>(
      `SELECT (SELECT COUNT(*)::text FROM documents WHERE source_type='VENDOR') AS docs,
              (SELECT COUNT(*)::text FROM document_versions) AS versions,
              (SELECT COUNT(*)::text FROM supporting_documents WHERE parent_type='QUOTATION_REVISION') AS links`,
    );
    assert.equal(counts.rows[0].docs, '1');
    assert.equal(counts.rows[0].versions, '1');
    assert.equal(counts.rows[0].links, '1');

    const submitted = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${revisionId}/submit`).set(externalAuth(access.exchange.sessionToken)).send({});
    assert.equal(submitted.status, 200);
    const afterSubmit = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${revisionId}/attachments`).set(externalAuth(access.exchange.sessionToken)).send({
      documentNumber: `QDOC-${suffix()}`, documentType: 'VENDOR_QUOTATION_ATTACHMENT', title: 'Late', fileReference: 'opaque/late.pdf',
    });
    assert.equal(afterSubmit.status, 409);
    assert.equal(afterSubmit.body.error.code, 'VENDOR_QUOTATION_ATTACHMENT_NOT_ALLOWED');
  });

  it('prevents peer Vendor visibility while internal RFQ users can read all quotations', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await createBuilding();
    const { rfq, rfqLine } = await createOpenServiceRfq(client.id, building.id);
    const vendorA = await createVendor(client.id, building.id);
    const vendorB = await createVendor(client.id, building.id);
    const accessA = await inviteAndExchange(rfq.id, vendorA.id);
    const accessB = await inviteAndExchange(rfq.id, vendorB.id);
    const quotation = await api().post(`/api/v1/vendor-rfq-access/invitations/${accessA.invitation.id}/quotations`).set(externalAuth(accessA.exchange.sessionToken)).send(quotationBody(rfqLine.id));
    assert.equal(quotation.status, 201);

    const peer = await api().get(`/api/v1/vendor-rfq-access/quotations/${quotation.body.data.id}`).set(externalAuth(accessB.exchange.sessionToken));
    assert.equal(peer.status, 404);
    assert.equal(peer.body.error.code, 'VENDOR_QUOTATION_SESSION_MISMATCH');
    const peerRevision = await api().get(`/api/v1/vendor-rfq-access/quotations/${quotation.body.data.id}/revisions`).set(externalAuth(accessB.exchange.sessionToken));
    assert.equal(peerRevision.status, 404);

    const internal = await api().get(`/api/v1/rfqs/${rfq.id}/quotations`).set(internalAuth());
    assert.equal(internal.status, 200);
    assert.equal(internal.body.data.length, 1);
    assert.equal(internal.body.data[0].vendorId, vendorA.id);
  });

  it('audits quotation/revision/attachment state changes without raw token leakage', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await createBuilding();
    const { rfq, rfqLine } = await createOpenServiceRfq(client.id, building.id);
    const vendor = await createVendor(client.id, building.id, 'audit-quote@example.com');
    const access = await inviteAndExchange(rfq.id, vendor.id);
    const rawInvitationToken = access.invitation.invitationToken;
    const rawSessionToken = access.exchange.sessionToken;
    const quote = await api().post(`/api/v1/vendor-rfq-access/invitations/${access.invitation.id}/quotations`).set(externalAuth(rawSessionToken)).send(quotationBody(rfqLine.id));
    const revisionId = quote.body.data.currentRevision.id;
    await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${revisionId}/attachments`).set(externalAuth(rawSessionToken)).send({
      documentNumber: `QDOC-${suffix()}`, documentType: 'VENDOR_QUOTATION_ATTACHMENT', title: 'Audit attachment', fileReference: 'opaque/audit.pdf',
    });
    await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${revisionId}/submit`).set(externalAuth(rawSessionToken)).send({});

    const events = await pool!.query<{ event_type: string; actor_user_id: string | null; metadata: unknown }>(
      `SELECT event_type, actor_user_id, metadata
         FROM operational_events
        WHERE entity_type IN ('VENDOR_QUOTATION', 'VENDOR_QUOTATION_REVISION', 'QUOTATION_REVISION')
        ORDER BY created_at`,
    );
    assert.ok(events.rows.some((event) => event.event_type === 'VENDOR_QUOTATION_SUBMITTED'));
    assert.ok(events.rows.some((event) => event.event_type === 'VENDOR_QUOTATION_ATTACHMENT_ADDED'));
    const external = events.rows.filter((event) => JSON.stringify(event.metadata).includes('VENDOR_RFQ_SESSION'));
    assert.ok(external.length >= 3);
    assert.ok(external.every((event) => event.actor_user_id === null));
    for (const event of events.rows) {
      const json = JSON.stringify(event.metadata);
      assert.equal(json.includes(rawInvitationToken), false);
      assert.equal(json.includes(rawSessionToken), false);
    }
    assert.equal(vendor.clientId, client.id);
  });
});
