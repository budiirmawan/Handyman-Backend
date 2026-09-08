import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-13B — Visitor Invitation focused validation.
 *
 * Covers:
 *  - create invitation referencing a BE-13A visitor identity
 *  - invalid / cross-Client / BLOCKED / INACTIVE visitor rejected
 *  - Building validation + host reference validation
 *  - update / cancel lifecycle (PENDING → CANCELLED terminal)
 *  - date/time window validation
 *  - RBAC and Client / Building isolation
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       visitor_invitations, visitors,
       workforce_building_assignments, workforce_profiles,
       teams, positions, departments, organizations,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

const HOUR = 60 * 60 * 1000;
const arrival = () => new Date(Date.now() + 24 * HOUR).toISOString();
const departure = () => new Date(Date.now() + 26 * HOUR).toISOString();

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Invitation client A',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingA2 = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A2',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA2.id,
  });

  const clientB = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Invitation client B',
  });
  const propertyB = await propertyService.createProperty({
    clientId: clientB.id,
    code: `P_${suffix()}`,
    name: 'Property B',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyB.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });

  // Shared BE-13A visitor identity under client A.
  const visitor = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/visitors`)
      .set(auth())
      .send({ fullName: 'Invited Guest', organizationName: 'PT Tamu' })
  ).body.data;

  // Visitor under client B (for cross-client checks).
  const bAdmin = await createAdminUser();
  await buildingAssignmentService.createAssignment(bAdmin.userId, {
    buildingId: buildingB.id,
  });
  const visitorB = (
    await api()
      .post(`/api/v1/clients/${clientB.id}/visitors`)
      .set(auth(bAdmin.token))
      .send({ fullName: 'Other Client Guest' })
  ).body.data;

  // Host workforce under client A.
  const organization = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Host org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Host dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `P_${suffix()}`,
    name: 'Host',
  });
  const hostWorker = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Host employee',
  });

  // Host workforce under client B (cross-client host checks).
  const organizationB = await organizationService.createOrganization({
    clientId: clientB.id,
    code: `O_${suffix()}`,
    name: 'Host org B',
  });
  const departmentB = await departmentService.createDepartment({
    organizationId: organizationB.id,
    code: `D_${suffix()}`,
    name: 'Host dept B',
  });
  const positionB = await positionService.createPosition({
    organizationId: organizationB.id,
    code: `P_${suffix()}`,
    name: 'Host B',
  });
  const hostWorkerB = await workforceService.createWorkforceProfile({
    organizationId: organizationB.id,
    departmentId: departmentB.id,
    positionId: positionB.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Host employee B',
  });

  return {
    clientA,
    clientB,
    buildingA,
    buildingA2,
    buildingB,
    visitor,
    visitorB,
    hostWorker,
    hostWorkerB,
    bAdmin,
  };
}

async function createInvitation(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post('/api/v1/visitor-invitations')
    .set(auth(token))
    .send(body);
}

describe('BE-13B visitor invitation', () => {
  it('creates an invitation referencing the shared visitor identity', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const expectedArrivalAt = arrival();
    const expectedDepartureAt = departure();
    const response = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostUserId: managerUserId,
      hostWorkforceId: f.hostWorker.id,
      hostName: 'Meeting Room 3 host',
      expectedArrivalAt,
      expectedDepartureAt,
      purpose: 'Quarterly business review',
      notes: 'Escort from lobby.',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.visitorId, f.visitor.id);
    assert.equal(data.hostUserId, managerUserId);
    assert.equal(data.hostWorkforceId, f.hostWorker.id);
    assert.equal(data.hostName, 'Meeting Room 3 host');
    assert.equal(data.expectedArrivalAt, expectedArrivalAt);
    assert.equal(data.expectedDepartureAt, expectedDepartureAt);
    assert.equal(data.purpose, 'Quarterly business review');
    assert.equal(data.notes, 'Escort from lobby.');
    assert.equal(data.status, 'PENDING');
    assert.equal(data.createdByUserId, managerUserId);

    // No visitor personal data is duplicated onto the invitation.
    const allowedKeys = new Set([
      'id',
      'clientId',
      'buildingId',
      'visitorId',
      'hostUserId',
      'hostWorkforceId',
      'hostName',
      'expectedArrivalAt',
      'expectedDepartureAt',
      'purpose',
      'notes',
      'status',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ]);
    for (const key of Object.keys(data)) {
      assert.ok(allowedKeys.has(key), `unexpected public field: ${key}`);
    }
  });

  it('accepts a free-form host name as the only host reference', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Tenant PIC — 12th floor',
      expectedArrivalAt: arrival(),
      purpose: 'Document drop-off',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.hostUserId, null);
    assert.equal(response.body.data.hostWorkforceId, null);
    assert.equal(response.body.data.hostName, 'Tenant PIC — 12th floor');
  });

  it('rejects invalid visitor references', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Unknown visitor.
    const unknown = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: randomUUID(),
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'VISITOR_NOT_FOUND');

    // Cross-client visitor.
    const crossClient = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitorB.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(crossClient.status, 400, JSON.stringify(crossClient.body));
    assert.equal(
      crossClient.body.error.code,
      'VISITOR_INVITATION_VISITOR_CLIENT_MISMATCH',
    );

    // BLOCKED visitor.
    const blocked = (
      await api()
        .post(`/api/v1/clients/${f.clientA.id}/visitors`)
        .set(auth())
        .send({ fullName: 'Blocked Guest' })
    ).body.data;
    await api()
      .patch(`/api/v1/visitors/${blocked.id}`)
      .set(auth())
      .send({ status: 'BLOCKED' });
    const blockedInvite = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: blocked.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(blockedInvite.status, 400);
    assert.equal(
      blockedInvite.body.error.code,
      'VISITOR_INVITATION_VISITOR_BLOCKED',
    );

    // INACTIVE visitor.
    const inactive = (
      await api()
        .post(`/api/v1/clients/${f.clientA.id}/visitors`)
        .set(auth())
        .send({ fullName: 'Inactive Guest' })
    ).body.data;
    await api()
      .patch(`/api/v1/visitors/${inactive.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    const inactiveInvite = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: inactive.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(inactiveInvite.status, 400);
    assert.equal(
      inactiveInvite.body.error.code,
      'VISITOR_INVITATION_VISITOR_INACTIVE',
    );
  });

  it('validates building and host context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Unknown building.
    const unknownBuilding = await createInvitation({
      buildingId: randomUUID(),
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');

    // Missing host reference entirely.
    const noHost = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(noHost.status, 400, JSON.stringify(noHost.body));
    assert.equal(noHost.body.error.code, 'VISITOR_INVITATION_HOST_REQUIRED');

    // Unknown host user.
    const unknownHostUser = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostUserId: randomUUID(),
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(unknownHostUser.status, 404);
    assert.equal(unknownHostUser.body.error.code, 'USER_NOT_FOUND');

    // Cross-client host workforce.
    const crossHost = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostWorkforceId: f.hostWorkerB.id,
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(crossHost.status, 400, JSON.stringify(crossHost.body));
    assert.equal(
      crossHost.body.error.code,
      'VISITOR_INVITATION_HOST_WORKFORCE_MISMATCH',
    );

    // INACTIVE host workforce.
    await workforceService.updateWorkforceProfile(f.hostWorker.id, {
      status: 'INACTIVE',
    });
    const inactiveHost = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostWorkforceId: f.hostWorker.id,
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(inactiveHost.status, 400, JSON.stringify(inactiveHost.body));
    assert.equal(
      inactiveHost.body.error.code,
      'VISITOR_INVITATION_HOST_WORKFORCE_INACTIVE',
    );
  });

  it('validates the expected date/time window', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Departure before arrival.
    const inverted = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: departure(),
      expectedDepartureAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(inverted.status, 400, JSON.stringify(inverted.body));
    assert.equal(
      inverted.body.error.code,
      'VISITOR_INVITATION_INVALID_TIME_WINDOW',
    );

    // Malformed arrival.
    const malformed = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: 'tomorrow-ish',
      purpose: 'Meeting',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    // Missing arrival.
    const missing = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      purpose: 'Meeting',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    // Update that inverts the stored window is rejected too.
    const created = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      expectedDepartureAt: departure(),
      purpose: 'Meeting',
    });
    assert.equal(created.status, 201);
    const badUpdate = await api()
      .patch(`/api/v1/visitor-invitations/${created.body.data.id}`)
      .set(auth())
      .send({
        expectedDepartureAt: new Date(Date.now() + 1 * HOUR).toISOString(),
      });
    assert.equal(badUpdate.status, 400, JSON.stringify(badUpdate.body));
    assert.equal(
      badUpdate.body.error.code,
      'VISITOR_INVITATION_INVALID_TIME_WINDOW',
    );
  });

  it('gets, lists and searches invitations', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const inviteA = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostUserId: managerUserId,
      expectedArrivalAt: arrival(),
      purpose: 'Audit visit',
    });
    assert.equal(inviteA.status, 201);
    const inviteA2 = await createInvitation({
      buildingId: f.buildingA2.id,
      visitorId: f.visitor.id,
      hostName: 'Other host',
      expectedArrivalAt: new Date(Date.now() + 72 * HOUR).toISOString(),
      purpose: 'Follow-up visit',
    });
    assert.equal(inviteA2.status, 201);

    // Get by id.
    const read = await api()
      .get(`/api/v1/visitor-invitations/${inviteA.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.purpose, 'Audit visit');

    const missing = await api()
      .get(`/api/v1/visitor-invitations/${randomUUID()}`)
      .set(auth());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'VISITOR_INVITATION_NOT_FOUND');

    // Unfiltered list covers both accessible buildings.
    const listAll = await api()
      .get('/api/v1/visitor-invitations')
      .set(auth());
    assert.equal(listAll.status, 200);
    const allIds = listAll.body.data.map((x: { id: string }) => x.id);
    assert.ok(allIds.includes(inviteA.body.data.id));
    assert.ok(allIds.includes(inviteA2.body.data.id));

    // Building filter.
    const byBuilding = await api()
      .get(`/api/v1/visitor-invitations?buildingId=${f.buildingA.id}`)
      .set(auth());
    assert.equal(byBuilding.status, 200);
    assert.ok(
      byBuilding.body.data.every(
        (x: { buildingId: string }) => x.buildingId === f.buildingA.id,
      ),
    );

    // Visitor filter.
    const byVisitor = await api()
      .get(`/api/v1/visitor-invitations?visitorId=${f.visitor.id}`)
      .set(auth());
    assert.equal(byVisitor.status, 200);
    assert.ok(byVisitor.body.data.length >= 2);

    // Host user filter.
    const byHost = await api()
      .get(`/api/v1/visitor-invitations?hostUserId=${managerUserId}`)
      .set(auth());
    assert.equal(byHost.status, 200);
    assert.ok(
      byHost.body.data.every(
        (x: { hostUserId: string | null }) => x.hostUserId === managerUserId,
      ),
    );

    // Expected-arrival window filter.
    const windowed = await api()
      .get(
        `/api/v1/visitor-invitations?expectedFrom=${encodeURIComponent(
          new Date(Date.now() + 48 * HOUR).toISOString(),
        )}`,
      )
      .set(auth());
    assert.equal(windowed.status, 200);
    const windowedIds = windowed.body.data.map((x: { id: string }) => x.id);
    assert.ok(windowedIds.includes(inviteA2.body.data.id));
    assert.ok(!windowedIds.includes(inviteA.body.data.id));
  });

  it('updates and cancels an invitation (CANCELLED is terminal)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Original host',
      expectedArrivalAt: arrival(),
      purpose: 'Original purpose',
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    // Reschedule + repurpose.
    const newArrival = new Date(Date.now() + 48 * HOUR).toISOString();
    const updated = await api()
      .patch(`/api/v1/visitor-invitations/${id}`)
      .set(auth())
      .send({
        expectedArrivalAt: newArrival,
        purpose: 'Rescheduled purpose',
        notes: 'Moved by host.',
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.expectedArrivalAt, newArrival);
    assert.equal(updated.body.data.purpose, 'Rescheduled purpose');
    assert.equal(updated.body.data.status, 'PENDING');

    // Removing every host reference is rejected.
    const hostless = await api()
      .patch(`/api/v1/visitor-invitations/${id}`)
      .set(auth())
      .send({ hostName: null });
    assert.equal(hostless.status, 400, JSON.stringify(hostless.body));
    assert.equal(
      hostless.body.error.code,
      'VISITOR_INVITATION_HOST_REQUIRED',
    );

    // Cancel.
    const cancelled = await api()
      .post(`/api/v1/visitor-invitations/${id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');

    // Cancel again → conflict.
    const cancelTwice = await api()
      .post(`/api/v1/visitor-invitations/${id}/cancel`)
      .set(auth());
    assert.equal(cancelTwice.status, 409);
    assert.equal(
      cancelTwice.body.error.code,
      'VISITOR_INVITATION_ALREADY_CANCELLED',
    );

    // Cancelled invitations are read-only.
    const afterCancel = await api()
      .patch(`/api/v1/visitor-invitations/${id}`)
      .set(auth())
      .send({ purpose: 'Should not apply' });
    assert.equal(afterCancel.status, 409);
    assert.equal(
      afterCancel.body.error.code,
      'VISITOR_INVITATION_ALREADY_CANCELLED',
    );

    // Status filter separates PENDING from CANCELLED.
    const cancelledList = await api()
      .get(`/api/v1/visitor-invitations?status=CANCELLED`)
      .set(auth());
    assert.equal(cancelledList.status, 200);
    assert.ok(
      cancelledList.body.data.some((x: { id: string }) => x.id === id),
    );
  });

  it('rejects invalid input', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Missing purpose.
    const noPurpose = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
    });
    assert.equal(noPurpose.status, 400);
    assert.equal(noPurpose.body.error.code, 'VALIDATION_ERROR');

    // Malformed UUIDs.
    const badUuid = await createInvitation({
      buildingId: 'not-a-uuid',
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(badUuid.status, 400);
    assert.equal(badUuid.body.error.code, 'VALIDATION_ERROR');

    // Empty update payload.
    const created = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(created.status, 201);
    const emptyUpdate = await api()
      .patch(`/api/v1/visitor-invitations/${created.body.data.id}`)
      .set(auth())
      .send({});
    assert.equal(emptyUpdate.status, 400);
    assert.equal(emptyUpdate.body.error.code, 'VALIDATION_ERROR');

    // Invalid status filter.
    const badStatus = await api()
      .get('/api/v1/visitor-invitations?status=EXPIRED')
      .set(auth());
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const plainToken = await createPlainSession();

    const forbiddenCreate = await createInvitation(
      {
        buildingId: f.buildingA.id,
        visitorId: f.visitor.id,
        hostName: 'Host',
        expectedArrivalAt: arrival(),
        purpose: 'Meeting',
      },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/visitor-invitations')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(created.status, 201);

    const forbiddenRead = await api()
      .get(`/api/v1/visitor-invitations/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenPatch = await api()
      .patch(`/api/v1/visitor-invitations/${created.body.data.id}`)
      .set(auth(plainToken))
      .send({ purpose: 'Forbidden' });
    assert.equal(forbiddenPatch.status, 403);
    assert.equal(forbiddenPatch.body.error.code, 'PERMISSION_DENIED');

    const forbiddenCancel = await api()
      .post(`/api/v1/visitor-invitations/${created.body.data.id}/cancel`)
      .set(auth(plainToken));
    assert.equal(forbiddenCancel.status, 403);
    assert.equal(forbiddenCancel.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/visitor-invitations');
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Creating for an inaccessible building is denied.
    const denied = await createInvitation({
      buildingId: f.buildingB.id,
      visitorId: f.visitorB.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Meeting',
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A user with access only to building B cannot read/patch/cancel a
    // building-A invitation.
    const created = await createInvitation({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Host',
      expectedArrivalAt: arrival(),
      purpose: 'Isolated visit',
    });
    assert.equal(created.status, 201);

    const deniedRead = await api()
      .get(`/api/v1/visitor-invitations/${created.body.data.id}`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedPatch = await api()
      .patch(`/api/v1/visitor-invitations/${created.body.data.id}`)
      .set(auth(f.bAdmin.token))
      .send({ purpose: 'Should fail' });
    assert.equal(deniedPatch.status, 403);
    assert.equal(deniedPatch.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedCancel = await api()
      .post(`/api/v1/visitor-invitations/${created.body.data.id}/cancel`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedCancel.status, 403);
    assert.equal(deniedCancel.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Listing with an inaccessible building filter is denied.
    const deniedList = await api()
      .get(`/api/v1/visitor-invitations?buildingId=${f.buildingB.id}`)
      .set(auth());
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Unfiltered list is scoped to accessible buildings only.
    const scoped = await api()
      .get('/api/v1/visitor-invitations')
      .set(auth(f.bAdmin.token));
    assert.equal(scoped.status, 200);
    const ids = scoped.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(created.body.data.id));
  });
});
