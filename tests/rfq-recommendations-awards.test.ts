import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { serviceRequestService } from '../src/modules/service-requests';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { permissionService } from '../src/modules/permissions';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** CR-BE-PRO-02 PART 05 — manual recommendation, approval, and award only. */
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
    TRUNCATE rfq_awards, rfq_recommendations, procurement_approval_bindings,
      rfq_comparison_evaluations, rfq_comparison_evidence_attachments,
      rfq_comparison_lines, rfq_comparison_evidence, rfq_comparison_runs,
      vendor_quotation_lines, vendor_quotation_revisions, vendor_quotations,
      supporting_documents, document_versions, documents,
      rfq_vendor_access_sessions, rfq_vendor_invitations, rfq_lines, rfqs,
      service_requests, purchase_requests, vendor_building_relationships,
      vendors, users, roles, permissions, clients, properties, buildings CASCADE
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
  const client = await clientService.createClient({ code: `P5CLI_${suffix()}`, name: 'Award Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P5PROP_${suffix()}`, name: 'Award Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `P5BLDG_${suffix()}`, name: 'Award Building' });
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
  const pr = await purchaseRequestService.createPurchaseRequest({ clientId, buildingId, requestNumber: `P5PR_${suffix()}`, requestType: 'SERVICE', title: 'Award demand', requestedByUserId: ownerUserId });
  const service = await serviceRequestService.createServiceRequest({ purchaseRequestId: pr.id, serviceType: 'HVAC', title: 'Award service', requestedByUserId: ownerUserId });
  const rfq = await api().post('/api/v1/rfqs').set(auth(ownerToken)).send({ purchaseRequestId: pr.id, sourceMode: 'SERVICE', rfqNumber: `P5RFQ_${suffix()}`, title: 'Award RFQ', currency: 'IDR', responseDeadline: '2030-01-01T00:00:00.000Z', idempotencyKey: key('rfq') });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  const line = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/lines`).set(auth(ownerToken)).send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: service.id });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const opened = await api().post(`/api/v1/rfqs/${rfq.body.data.id}/open`).set(auth(ownerToken)).send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { rfq: rfq.body.data, line: line.body.data };
}

async function inviteAndSubmit(rfqId: string, vendorId: string, lineId: string, price: number) {
  const invitation = await api().post(`/api/v1/rfqs/${rfqId}/invitations`).set(auth(ownerToken)).send({ vendorId, idempotencyKey: key('inv') });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const exchange = await api().post('/api/v1/vendor-rfq-access/exchange').send({ token: invitation.body.data.invitationToken });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  const quote = await api().post(`/api/v1/vendor-rfq-access/invitations/${invitation.body.data.id}/quotations`).set(auth(exchange.body.data.sessionToken)).send({ currency: 'IDR', validUntil: '2030-01-01', serviceTerms: 'Award service terms', idempotencyKey: key('quote'), lines: [{ rfqLineId: lineId, unitPrice: price, technicalCompliance: 'COMPLIANT' }] });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const submitted = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${quote.body.data.currentRevision.id}/submit`).set(auth(exchange.body.data.sessionToken)).send({});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return { invitation: invitation.body.data, sessionToken: exchange.body.data.sessionToken, revision: submitted.body.data };
}

async function closeRfq(rfqId: string) {
  const closed = await api().post(`/api/v1/rfqs/${rfqId}/close`).set(auth(ownerToken)).send({});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
}

async function createRecommendation(rfqId: string, comparisonRunId: string, evidenceId: string) {
  return api().post(`/api/v1/rfqs/${rfqId}/recommendations`).set(auth(ownerToken)).send({ comparisonRunId, evidenceId, reason: 'Manual evaluation selected the Vendor based on documented evidence.', notes: 'Human decision; no automatic ranking.' });
}

async function approveRecommendation(f: Awaited<ReturnType<typeof fixture>>, rfqId: string, recommendationId: string) {
  const binding = await api().post('/api/v1/procurement-approvals').set(auth(ownerToken)).send({ requestType: 'RFQ', requestId: rfqId, recommendationId, approvalType: 'RFQ_AWARD', approverUserId: f.approver.userId });
  assert.equal(binding.status, 201, JSON.stringify(binding.body));
  const approved = await api().post(`/api/v1/procurement-approvals/${binding.body.data.id}/approve`).set(auth(f.approver.token)).send({ decisionNotes: 'Designated award approver approved.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return binding.body.data;
}

describe('CR-BE-PRO-02 PART 05 — recommendation, approval, and award', () => {
  it('creates a manual recommendation, extends approval with RFQ scope, and awards only after approval', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { rfq, line } = await createOpenRfq(f.client.id, f.building.id);
    const value = await vendorService.createVendor({ clientId: f.client.id, vendorCode: `P5VND_${suffix()}`, vendorName: 'Award Vendor' });
    await vendorBuildingService.assignBuildingToVendor({ vendorId: value.id, buildingId: f.building.id });
    const submitted = await inviteAndSubmit(rfq.id, value.id, line.id, 125);
    await closeRfq(rfq.id);
    const comparison = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth(ownerToken)).send({ idempotencyKey: key('cmp') });
    // The RFQ is closed, so this comparison is a current immutable run.
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const recommendation = await createRecommendation(rfq.id, comparison.body.data.id, comparison.body.data.evidence[0].evidenceId);
    assert.equal(recommendation.status, 201, JSON.stringify(recommendation.body));
    assert.equal(recommendation.body.data.status, 'PENDING_APPROVAL');
    assert.equal(recommendation.body.data.vendorId, value.id);
    assert.equal(recommendation.body.data.quotationRevisionId, submitted.revision.id);
    assert.equal(recommendation.body.data.reason.includes('Manual'), true);

    const beforeApproval = await api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(f.awarder.token)).send({});
    assert.equal(beforeApproval.status, 409);
    assert.equal(beforeApproval.body.error.code, 'RFQ_AWARD_NOT_APPROVED');
    const binding = await approveRecommendation(f, rfq.id, recommendation.body.data.id);
    assert.equal(binding.requestType, 'RFQ');
    assert.equal(binding.recommendationId, recommendation.body.data.id);
    const award = await api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(f.awarder.token)).send({ awardReason: 'Approved manual award.' });
    assert.equal(award.status, 201, JSON.stringify(award.body));
    assert.equal(award.body.data.outcome, 'VENDOR');
    assert.equal(award.body.data.vendorId, value.id);
    assert.equal(award.body.data.quotationRevisionId, submitted.revision.id);
    assert.equal(award.body.data.approvalId, binding.id);
    const events = await pool!.query<{ event_type: string; metadata: unknown }>(`SELECT event_type, metadata FROM operational_events WHERE entity_id IN ($1,$2,$3) ORDER BY created_at`, [recommendation.body.data.id, binding.id, award.body.data.id]);
    assert.ok(events.rows.some((event) => event.event_type === 'RFQ_RECOMMENDATION_CREATED'));
    assert.ok(events.rows.some((event) => event.event_type === 'RFQ_APPROVAL_SUBMITTED'));
    assert.ok(events.rows.some((event) => event.event_type === 'RFQ_APPROVAL_DECIDED'));
    const awardEvent = events.rows.find((event) => event.event_type === 'RFQ_AWARD_FINALIZED');
    assert.ok(awardEvent);
    assert.ok(JSON.stringify(awardEvent.metadata).includes(submitted.revision.id));
    const recommendationAfter = await api().get(`/api/v1/rfq-recommendations/${recommendation.body.data.id}`).set(auth(ownerToken));
    assert.equal(recommendationAfter.body.data.status, 'AWARDED');
    const second = await api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(f.awarder.token)).send({});
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'RFQ_AWARD_ALREADY_EXISTS');
    const financial = await pool!.query<{ po: string; commitments: string; entries: string }>(`SELECT (SELECT COUNT(*)::text FROM purchase_orders) po, (SELECT COUNT(*)::text FROM operational_commitments) commitments, (SELECT COUNT(*)::text FROM operational_commitment_entries) entries`);
    assert.deepEqual(financial.rows[0], { po: '0', commitments: '0', entries: '0' });
  });

  it('fails closed for an open RFQ, rejects default award permission, and prevents concurrent awards', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { rfq, line } = await createOpenRfq(f.client.id, f.building.id);
    const value = await vendorService.createVendor({ clientId: f.client.id, vendorCode: `P5VND_${suffix()}`, vendorName: 'Concurrent Award Vendor' });
    await vendorBuildingService.assignBuildingToVendor({ vendorId: value.id, buildingId: f.building.id });
    const submitted = await inviteAndSubmit(rfq.id, value.id, line.id, 50);
    await closeRfq(rfq.id);
    const comparison = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth(ownerToken)).send({ idempotencyKey: key('cmp') });
    const recommendation = await createRecommendation(rfq.id, comparison.body.data.id, comparison.body.data.evidence[0].evidenceId);
    assert.equal(recommendation.status, 201);
    await approveRecommendation(f, rfq.id, recommendation.body.data.id);
    const noAwardPermission = await permissionService.resolvePermissionsForUser(ownerUserId);
    assert.equal(noAwardPermission.includes('rfq.award'), false);
    const denied = await api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(ownerToken)).send({});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    const attempts = await Promise.all([
      api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(f.awarder.token)).send({}),
      api().post(`/api/v1/rfq-recommendations/${recommendation.body.data.id}/award`).set(auth(f.awarder.token)).send({}),
    ]);
    assert.deepEqual(attempts.map((response) => response.status).sort((a, b) => a - b), [201, 409]);
    assert.equal(submitted.revision.status, 'SUBMITTED');
  });

  it('rejects a stale comparison when the selected Vendor submits a later revision', async (t) => {
    if (!ready(t)) return;
    const f = await fixture();
    const { rfq, line } = await createOpenRfq(f.client.id, f.building.id);
    const value = await vendorService.createVendor({ clientId: f.client.id, vendorCode: `P5VND_${suffix()}`, vendorName: 'Stale Vendor' });
    await vendorBuildingService.assignBuildingToVendor({ vendorId: value.id, buildingId: f.building.id });
    const submitted = await inviteAndSubmit(rfq.id, value.id, line.id, 100);
    const comparison = await api().post(`/api/v1/rfqs/${rfq.id}/comparisons`).set(auth(ownerToken)).send({ idempotencyKey: key('cmp') });
    assert.equal(comparison.status, 201, JSON.stringify(comparison.body));
    const next = await api().post(`/api/v1/vendor-rfq-access/quotations/${submitted.revision.quotationId}/revisions`).set(auth(submitted.sessionToken)).send({ currency: 'IDR', validUntil: '2030-02-01', serviceTerms: 'Changed after comparison.', idempotencyKey: key('revision'), lines: [{ rfqLineId: line.id, unitPrice: 90, technicalCompliance: 'COMPLIANT' }] });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    const second = await api().post(`/api/v1/vendor-rfq-access/quotation-revisions/${next.body.data.id}/submit`).set(auth(submitted.sessionToken)).send({});
    assert.equal(second.status, 200, JSON.stringify(second.body));
    await closeRfq(rfq.id);
    const recommendation = await createRecommendation(rfq.id, comparison.body.data.id, comparison.body.data.evidence[0].evidenceId);
    assert.equal(recommendation.status, 409, JSON.stringify(recommendation.body));
    assert.equal(recommendation.body.error.code, 'RFQ_RECOMMENDATION_STALE_COMPARISON');
  });
});
