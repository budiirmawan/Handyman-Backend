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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PRO-02 PART 02 — Vendor Invitation + Invitation-Scoped External RFQ
 * Session. Quotation, comparison, recommendation, approval, award, PO,
 * finance, and Vendor WhatsApp are deliberately not tested here.
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
    TRUNCATE rfq_vendor_access_sessions, rfq_vendor_invitations,
      rfq_lines, rfqs, service_requests, purchase_requests,
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

function requireDatabase(t: TestContext): boolean {
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

async function createBuilding(assignUserId = adminUserId) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'RFQ Vendor Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'RFQ Vendor Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'RFQ Vendor Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

async function createOpenRfq(
  buildingId: string,
  clientId: string,
  token = adminToken,
) {
  const purchaseRequest = await purchaseRequestService.createPurchaseRequest({
    clientId,
    buildingId,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'SERVICE',
    title: 'Vendor RFQ service demand',
    requestedByUserId: adminUserId,
  });
  const service = await serviceRequestService.createServiceRequest({
    purchaseRequestId: purchaseRequest.id,
    serviceType: 'HVAC',
    title: 'HVAC maintenance',
    requestedByUserId: adminUserId,
  });
  const created = await api()
    .post('/api/v1/rfqs')
    .set(internalAuth(token))
    .send({
      purchaseRequestId: purchaseRequest.id,
      sourceMode: 'SERVICE',
      rfqNumber: `RFQ_${suffix()}`,
      title: 'Vendor RFQ',
      currency: 'IDR',
      responseDeadline: '2030-01-01T00:00:00.000Z',
      idempotencyKey: `rfq-${randomUUID()}`,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const line = await api()
    .post(`/api/v1/rfqs/${created.body.data.id}/lines`)
    .set(internalAuth(token))
    .send({ sourceLineType: 'SERVICE_REQUEST', sourceLineId: service.id });
  assert.equal(line.status, 201, JSON.stringify(line.body));
  const opened = await api()
    .post(`/api/v1/rfqs/${created.body.data.id}/open`)
    .set(internalAuth(token))
    .send({});
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { purchaseRequest, service, rfq: created.body.data };
}

async function createVendor(
  clientId: string,
  buildingId: string,
  email?: string,
) {
  const vendor = await vendorService.createVendor({
    clientId,
    vendorCode: `VND_${suffix()}`,
    vendorName: `Vendor ${suffix()}`,
    ...(email === undefined ? {} : { email }),
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId,
  });
  return vendor;
}

async function invite(rfqId: string, vendorId: string, token = adminToken, key = `invite-${randomUUID()}`) {
  return api()
    .post(`/api/v1/rfqs/${rfqId}/invitations`)
    .set(internalAuth(token))
    .send({ vendorId, idempotencyKey: key });
}

async function exchange(token: string) {
  return api()
    .post('/api/v1/vendor-rfq-access/exchange')
    .send({ token });
}

describe('CR-BE-PRO-02 PART 02 — invitation authority', () => {
  it('creates a scoped invitation with a Vendor email snapshot and no internal User', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const { rfq } = await createOpenRfq(building.id, client.id);
    const vendor = await createVendor(client.id, building.id, 'rfq@example.com');
    const usersBefore = await pool!.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');

    const created = await invite(rfq.id, vendor.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'INVITED');
    assert.equal(created.body.data.rfqId, rfq.id);
    assert.equal(created.body.data.vendorId, vendor.id);
    assert.equal(created.body.data.clientId, client.id);
    assert.equal(created.body.data.buildingId, building.id);
    assert.equal(created.body.data.recipientEmailSnapshot, 'rfq@example.com');
    assert.equal(typeof created.body.data.invitationToken, 'string');
    assert.ok(created.body.data.invitationToken.length > 20);

    const usersAfter = await pool!.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    assert.equal(usersAfter.rows[0].count, usersBefore.rows[0].count);

    const stored = await pool!.query<{ token_hash: string; id: string }>(
      'SELECT token_hash, id FROM rfq_vendor_invitations WHERE id = $1',
      [created.body.data.id],
    );
    assert.notEqual(stored.rows[0].token_hash, created.body.data.invitationToken);
    assert.equal(stored.rows[0].token_hash.length, 64);
  });

  it('is idempotent and does not return the raw token on replay', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const { rfq } = await createOpenRfq(building.id, client.id);
    const vendor = await createVendor(client.id, building.id);
    const key = `same-${randomUUID()}`;

    const first = await invite(rfq.id, vendor.id, adminToken, key);
    const replay = await invite(rfq.id, vendor.id, adminToken, key);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(replay.body.data.invitationToken, null);

    const conflict = await invite(rfq.id, vendor.id, adminToken, key.replace('same-', 'other-'));
    // A different idempotency key is a live duplicate invitation, not a replay.
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'RFQ_VENDOR_INVITATION_ALREADY_ACTIVE');
  });

  it('rejects an invitation for an inactive, cross-client, or out-of-building Vendor', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await createBuilding();
    const { rfq } = await createOpenRfq(first.building.id, first.client.id);
    const other = await createBuilding();
    const foreignVendor = await vendorService.createVendor({
      clientId: other.client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Foreign Vendor',
    });
    const crossClient = await invite(rfq.id, foreignVendor.id);
    assert.equal(crossClient.status, 400);
    assert.equal(crossClient.body.error.code, 'RFQ_VENDOR_INVITATION_CONTEXT_MISMATCH');

    const inactive = await vendorService.createVendor({
      clientId: first.client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Inactive Vendor',
      status: 'INACTIVE',
    });
    const inactiveResponse = await invite(rfq.id, inactive.id);
    assert.equal(inactiveResponse.status, 400);
    assert.equal(inactiveResponse.body.error.code, 'RFQ_VENDOR_INVITATION_VENDOR_INVALID');
  });

  it('requires internal RFQ permissions for management but does not require them externally', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const { rfq } = await createOpenRfq(building.id, client.id);
    const vendor = await createVendor(client.id, building.id);
    const plainToken = await createPlainSession();

    const forbidden = await invite(rfq.id, vendor.id, plainToken);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    const created = await invite(rfq.id, vendor.id);
    const exchanged = await exchange(created.body.data.invitationToken);
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    assert.equal(typeof exchanged.body.data.sessionToken, 'string');
  });
});

describe('CR-BE-PRO-02 PART 02 — external session and safe RFQ access', () => {
  it('exchanges the invitation token once and returns only Vendor-safe RFQ data', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const { rfq } = await createOpenRfq(building.id, client.id);
    const vendor = await createVendor(client.id, building.id, 'vendor@example.com');
    const invitation = await invite(rfq.id, vendor.id);
    const rawInvitationToken = invitation.body.data.invitationToken;

    const exchanged = await exchange(rawInvitationToken);
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    assert.equal(exchanged.body.data.access.rfqId, rfq.id);
    assert.equal(exchanged.body.data.access.vendorId, vendor.id);
    assert.equal(typeof exchanged.body.data.sessionToken, 'string');

    const replay = await exchange(rawInvitationToken);
    assert.equal(replay.status, 403);
    assert.equal(replay.body.error.code, 'RFQ_VENDOR_INVITATION_TOKEN_REPLAYED');

    const safe = await api()
      .get(`/api/v1/vendor-rfq-access/rfqs/${rfq.id}`)
      .set(externalAuth(exchanged.body.data.sessionToken));
    assert.equal(safe.status, 200, JSON.stringify(safe.body));
    assert.equal(safe.body.data.rfq.rfqNumber, rfq.rfqNumber);
    assert.equal(safe.body.data.rfq.lines.length, 1);
    assert.equal(safe.body.data.invitation.vendorId, vendor.id);
    assert.equal(safe.body.data.rfq.purchaseRequestId, undefined);
    assert.equal(safe.body.data.rfq.clientId, undefined);
    assert.equal(safe.body.data.rfq.lines[0].serviceRequestId, undefined);

    const me = await api()
      .get('/api/v1/vendor-rfq-access/me')
      .set(externalAuth(exchanged.body.data.sessionToken));
    assert.equal(me.status, 200);
    assert.equal(me.body.data.vendorId, vendor.id);
  });

  it('accepts, declines, and records no-bid using only the scoped session', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const first = await createOpenRfq(building.id, client.id);
    const vendorA = await createVendor(client.id, building.id);
    const vendorB = await createVendor(client.id, building.id);
    const vendorC = await createVendor(client.id, building.id);

    const accepted = await invite(first.rfq.id, vendorA.id);
    const acceptedSession = await exchange(accepted.body.data.invitationToken);
    const acceptedResponse = await api()
      .post(`/api/v1/vendor-rfq-access/invitations/${accepted.body.data.id}/accept`)
      .set(externalAuth(acceptedSession.body.data.sessionToken))
      .send({});
    assert.equal(acceptedResponse.status, 200);
    assert.equal(acceptedResponse.body.data.status, 'ACCEPTED');

    const declined = await invite(first.rfq.id, vendorB.id);
    const declinedSession = await exchange(declined.body.data.invitationToken);
    const declinedResponse = await api()
      .post(`/api/v1/vendor-rfq-access/invitations/${declined.body.data.id}/decline`)
      .set(externalAuth(declinedSession.body.data.sessionToken))
      .send({ reason: 'Capacity unavailable' });
    assert.equal(declinedResponse.status, 200);
    assert.equal(declinedResponse.body.data.status, 'DECLINED');
    assert.equal(declinedResponse.body.data.responseReason, 'Capacity unavailable');

    const noBid = await invite(first.rfq.id, vendorC.id);
    const noBidSession = await exchange(noBid.body.data.invitationToken);
    const noBidResponse = await api()
      .post(`/api/v1/vendor-rfq-access/invitations/${noBid.body.data.id}/no-bid`)
      .set(externalAuth(noBidSession.body.data.sessionToken))
      .send({ reason: 'No bid for this scope' });
    assert.equal(noBidResponse.status, 200);
    assert.equal(noBidResponse.body.data.status, 'NO_BID');
  });

  it('prevents cross-invitation, cross-Vendor, cross-RFQ, and cross-Building access', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await createBuilding();
    const firstRfq = await createOpenRfq(first.building.id, first.client.id);
    const vendorA = await createVendor(first.client.id, first.building.id);
    const invitationA = await invite(firstRfq.rfq.id, vendorA.id);
    const sessionA = await exchange(invitationA.body.data.invitationToken);

    const secondRfq = await createOpenRfq(first.building.id, first.client.id);
    const invitationB = await invite(secondRfq.rfq.id, vendorA.id);
    const sessionB = await exchange(invitationB.body.data.invitationToken);
    const peerInvitation = await api()
      .get(`/api/v1/vendor-rfq-access/invitations/${invitationB.body.data.id}`)
      .set(externalAuth(sessionA.body.data.sessionToken));
    assert.equal(peerInvitation.status, 404);
    assert.equal(peerInvitation.body.error.code, 'RFQ_VENDOR_SESSION_INVITATION_MISMATCH');

    const crossRfq = await api()
      .get(`/api/v1/vendor-rfq-access/rfqs/${secondRfq.rfq.id}`)
      .set(externalAuth(sessionA.body.data.sessionToken));
    assert.equal(crossRfq.status, 404);
    assert.equal(crossRfq.body.error.code, 'RFQ_VENDOR_SESSION_RFQ_MISMATCH');

    const otherAdmin = await createAdminUser();
    const other = await createBuilding(otherAdmin.userId);
    const otherRfq = await createOpenRfq(other.building.id, other.client.id, otherAdmin.token);
    const crossBuilding = await api()
      .get(`/api/v1/vendor-rfq-access/rfqs/${otherRfq.rfq.id}`)
      .set(externalAuth(sessionA.body.data.sessionToken));
    assert.equal(crossBuilding.status, 404);
    assert.equal(crossBuilding.body.error.code, 'RFQ_VENDOR_SESSION_RFQ_MISMATCH');
    assert.equal(sessionB.body.data.access.vendorId, vendorA.id);
  });
});

describe('CR-BE-PRO-02 PART 02 — revocation, expiry, resend, and audit', () => {
  it('revokes an invitation and its sessions, and resend invalidates the previous token/session', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const { rfq } = await createOpenRfq(building.id, client.id);
    const vendor = await createVendor(client.id, building.id);
    const first = await invite(rfq.id, vendor.id);
    const session = await exchange(first.body.data.invitationToken);

    const revoked = await api()
      .post(`/api/v1/rfq-vendor-invitations/${first.body.data.id}/revoke`)
      .set(internalAuth())
      .send({});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.status, 'REVOKED');

    const oldSession = await api()
      .get(`/api/v1/vendor-rfq-access/rfqs/${rfq.id}`)
      .set(externalAuth(session.body.data.sessionToken));
    assert.equal(oldSession.status, 401);
    assert.equal(oldSession.body.error.code, 'RFQ_VENDOR_SESSION_REVOKED');

    const oldToken = await exchange(first.body.data.invitationToken);
    assert.equal(oldToken.status, 404);
    assert.equal(oldToken.body.error.code, 'RFQ_VENDOR_INVITATION_TOKEN_INVALID');

    const second = await invite(rfq.id, vendor.id);
    assert.equal(second.status, 201);
    const resend = await api()
      .post(`/api/v1/rfq-vendor-invitations/${second.body.data.id}/resend`)
      .set(internalAuth())
      .send({ idempotencyKey: `resend-${randomUUID()}` });
    assert.equal(resend.status, 200, JSON.stringify(resend.body));
    assert.notEqual(resend.body.data.id, second.body.data.id);
    assert.equal(resend.body.data.attemptNumber, second.body.data.attemptNumber + 1);
    assert.equal(typeof resend.body.data.invitationToken, 'string');

    const oldResendToken = await exchange(second.body.data.invitationToken);
    assert.equal(oldResendToken.status, 404);
    const newSession = await exchange(resend.body.data.invitationToken);
    assert.equal(newSession.status, 200, JSON.stringify(newSession.body));
  });

  it('expires invitation and session tokens at command time without a scheduler', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const { rfq } = await createOpenRfq(building.id, client.id);
    const vendor = await createVendor(client.id, building.id);
    const invitation = await invite(rfq.id, vendor.id);
    await pool!.query(
      `UPDATE rfq_vendor_invitations
          SET token_expires_at = created_at + INTERVAL '1 millisecond'
        WHERE id = $1`,
      [invitation.body.data.id],
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expired = await exchange(invitation.body.data.invitationToken);
    assert.equal(expired.status, 403);
    assert.equal(expired.body.error.code, 'RFQ_VENDOR_INVITATION_TOKEN_EXPIRED');

    const activeInvitation = await invite(rfq.id, vendor.id);
    assert.equal(activeInvitation.status, 201, JSON.stringify(activeInvitation.body));
    const session = await exchange(activeInvitation.body.data.invitationToken);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    await pool!.query(
      `UPDATE rfq_vendor_access_sessions
          SET issued_at = NOW() - INTERVAL '2 days',
              expires_at = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [session.body.data.session.id],
    );
    const expiredSession = await api()
      .get(`/api/v1/vendor-rfq-access/rfqs/${rfq.id}`)
      .set(externalAuth(session.body.data.sessionToken));
    assert.equal(expiredSession.status, 401);
    assert.equal(expiredSession.body.error.code, 'RFQ_VENDOR_SESSION_EXPIRED');
  });

  it('never persists invitation/session raw tokens and audits external actors without raw secrets', async (t) => {
    if (!requireDatabase(t)) return;
    const { client, building } = await createBuilding();
    const { rfq } = await createOpenRfq(building.id, client.id);
    const vendor = await createVendor(client.id, building.id, 'audit@example.com');
    const invitation = await invite(rfq.id, vendor.id);
    const rawInvitationToken = invitation.body.data.invitationToken as string;
    const exchanged = await exchange(rawInvitationToken);
    const rawSessionToken = exchanged.body.data.sessionToken as string;

    const stored = await pool!.query<{ token_hash: string; session_token_hash: string }>(
      `SELECT i.token_hash, s.session_token_hash
         FROM rfq_vendor_invitations i
         JOIN rfq_vendor_access_sessions s ON s.invitation_id = i.id
        WHERE i.id = $1`,
      [invitation.body.data.id],
    );
    assert.notEqual(stored.rows[0].token_hash, rawInvitationToken);
    assert.notEqual(stored.rows[0].session_token_hash, rawSessionToken);

    const events = await pool!.query<{ metadata: unknown; event_type: string }>(
      `SELECT metadata, event_type
         FROM operational_events
        WHERE entity_id IN ($1::uuid, $2::uuid)
           OR metadata->>'invitationId' = $1::text`,
      [invitation.body.data.id, exchanged.body.data.session.id],
    );
    assert.ok(events.rows.length >= 2);
    for (const event of events.rows) {
      assert.equal(JSON.stringify(event.metadata).includes(rawInvitationToken), false);
      assert.equal(JSON.stringify(event.metadata).includes(rawSessionToken), false);
    }
    const vendorEvents = events.rows.filter((event) =>
      JSON.stringify(event.metadata).includes('VENDOR_RFQ_SESSION'),
    );
    assert.ok(vendorEvents.length >= 1);
    assert.ok(vendorEvents.every((event) => event.event_type.startsWith('RFQ_VENDOR_')));
    assert.equal(client.id, invitation.body.data.clientId);
    assert.equal(building.id, invitation.body.data.buildingId);
  });
});
