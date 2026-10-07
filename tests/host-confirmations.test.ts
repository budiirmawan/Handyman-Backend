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
 * BE-13F — Host / Tenant Confirmation focused validation.
 *
 * Covers:
 *  - request + confirm over an Expected Visitor visit
 *  - request + reject over a Walk-In visit (reason required)
 *  - invalid / cancelled visit rejected; both/neither references
 *  - invalid host context rejected (unknown user, cross-client /
 *    inactive workforce)
 *  - duplicate confirmation per visit rejected
 *  - decided (CONFIRMED / REJECTED) confirmations are immutable —
 *    REJECTED can never become CONFIRMED
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
       host_confirmations, visitor_photos, walk_in_visits,
       expected_visitors, visitor_invitations, visitors,
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

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Confirmation client A',
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
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });

  const clientB = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Confirmation client B',
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

  const visitor = (
    await api()
      .post(`/api/v1/clients/${clientA.id}/visitors`)
      .set(auth())
      .send({ fullName: 'Confirmable Guest' })
  ).body.data;

  const bAdmin = await createAdminUser();
  await buildingAssignmentService.createAssignment(bAdmin.userId, {
    buildingId: buildingB.id,
  });

  // Host workforce (client A) + cross-client workforce (client B).
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
    buildingB,
    visitor,
    hostWorker,
    hostWorkerB,
    bAdmin,
  };
}

async function createExpectedVisit(f: Awaited<ReturnType<typeof seed>>) {
  const response = await api()
    .post('/api/v1/expected-visitors')
    .set(auth())
    .send({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostUserId: managerUserId,
      hostName: 'Expected host',
      expectedArrivalAt: arrival(),
      purpose: 'Confirmation test visit',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function createWalkIn(f: Awaited<ReturnType<typeof seed>>) {
  const response = await api()
    .post('/api/v1/walk-in-visits')
    .set(auth())
    .send({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostName: 'Walk-in host',
      purpose: 'Walk-in confirmation test',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function requestConfirmation(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api().post('/api/v1/host-confirmations').set(auth(token)).send(body);
}

describe('BE-13F host / tenant confirmation', () => {
  it('requests and confirms a valid expected visit', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const expected = await createExpectedVisit(f);

    // Request: host context defaults from the visit.
    const requested = await requestConfirmation({
      expectedVisitorId: expected.id,
      notes: 'Awaiting host reply.',
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    const data = requested.body.data;
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.expectedVisitorId, expected.id);
    assert.equal(data.walkInVisitId, null);
    assert.equal(data.hostUserId, managerUserId);
    assert.equal(data.hostName, 'Expected host');
    assert.equal(data.status, 'PENDING');
    assert.equal(data.confirmedByUserId, null);
    assert.equal(data.confirmedAt, null);
    assert.equal(data.rejectionReason, null);

    // Confirm.
    const confirmed = await api()
      .post(`/api/v1/host-confirmations/${data.id}/confirm`)
      .set(auth())
      .send({ notes: 'Host confirmed by phone.' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.status, 'CONFIRMED');
    assert.equal(confirmed.body.data.confirmedByUserId, managerUserId);
    assert.ok(confirmed.body.data.confirmedAt);
    assert.equal(confirmed.body.data.rejectionReason, null);
    assert.equal(confirmed.body.data.notes, 'Host confirmed by phone.');

    // Get reflects the authoritative status.
    const read = await api()
      .get(`/api/v1/host-confirmations/${data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, 'CONFIRMED');
  });

  it('requests and rejects a walk-in visit (reason required)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const walkIn = await createWalkIn(f);

    const requested = await requestConfirmation({
      walkInVisitId: walkIn.id,
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    assert.equal(requested.body.data.walkInVisitId, walkIn.id);
    assert.equal(requested.body.data.expectedVisitorId, null);
    assert.equal(requested.body.data.hostName, 'Walk-in host');
    const id = requested.body.data.id;

    // Reject without a reason is a validation error.
    const noReason = await api()
      .post(`/api/v1/host-confirmations/${id}/reject`)
      .set(auth())
      .send({});
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.code, 'VALIDATION_ERROR');

    // Reject with a reason.
    const rejected = await api()
      .post(`/api/v1/host-confirmations/${id}/reject`)
      .set(auth())
      .send({ rejectionReason: 'Host does not know this visitor.' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.status, 'REJECTED');
    assert.equal(rejected.body.data.confirmedByUserId, managerUserId);
    assert.ok(rejected.body.data.confirmedAt);
    assert.equal(
      rejected.body.data.rejectionReason,
      'Host does not know this visitor.',
    );
  });

  it('rejects invalid visit references', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const expected = await createExpectedVisit(f);
    const walkIn = await createWalkIn(f);

    // Neither reference.
    const neither = await requestConfirmation({});
    assert.equal(neither.status, 400);
    assert.equal(
      neither.body.error.code,
      'HOST_CONFIRMATION_VISIT_REFERENCE_REQUIRED',
    );

    // Both references.
    const both = await requestConfirmation({
      expectedVisitorId: expected.id,
      walkInVisitId: walkIn.id,
    });
    assert.equal(both.status, 400);
    assert.equal(
      both.body.error.code,
      'HOST_CONFIRMATION_VISIT_REFERENCE_REQUIRED',
    );

    // Unknown visits.
    const unknownExpected = await requestConfirmation({
      expectedVisitorId: randomUUID(),
    });
    assert.equal(unknownExpected.status, 404);
    assert.equal(unknownExpected.body.error.code, 'EXPECTED_VISITOR_NOT_FOUND');

    const unknownWalkIn = await requestConfirmation({
      walkInVisitId: randomUUID(),
    });
    assert.equal(unknownWalkIn.status, 404);
    assert.equal(unknownWalkIn.body.error.code, 'WALK_IN_VISIT_NOT_FOUND');

    // Cancelled visit.
    await api()
      .post(`/api/v1/expected-visitors/${expected.id}/cancel`)
      .set(auth());
    const cancelled = await requestConfirmation({
      expectedVisitorId: expected.id,
    });
    assert.equal(cancelled.status, 400, JSON.stringify(cancelled.body));
    assert.equal(
      cancelled.body.error.code,
      'HOST_CONFIRMATION_VISIT_CANCELLED',
    );
  });

  it('rejects invalid host / tenant context', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const walkIn = await createWalkIn(f);

    // Unknown host user override.
    const unknownHost = await requestConfirmation({
      walkInVisitId: walkIn.id,
      hostUserId: randomUUID(),
    });
    assert.equal(unknownHost.status, 404);
    assert.equal(unknownHost.body.error.code, 'USER_NOT_FOUND');

    // Cross-client host workforce override.
    const crossHost = await requestConfirmation({
      walkInVisitId: walkIn.id,
      hostWorkforceId: f.hostWorkerB.id,
    });
    assert.equal(crossHost.status, 400);
    assert.equal(
      crossHost.body.error.code,
      'HOST_CONFIRMATION_HOST_WORKFORCE_MISMATCH',
    );

    // INACTIVE host workforce override.
    await workforceService.updateWorkforceProfile(f.hostWorker.id, {
      status: 'INACTIVE',
    });
    const inactiveHost = await requestConfirmation({
      walkInVisitId: walkIn.id,
      hostWorkforceId: f.hostWorker.id,
    });
    assert.equal(inactiveHost.status, 400);
    assert.equal(
      inactiveHost.body.error.code,
      'HOST_CONFIRMATION_HOST_WORKFORCE_INACTIVE',
    );

    // Clearing every host reference (visit host overridden to null).
    const hostless = await requestConfirmation({
      walkInVisitId: walkIn.id,
      hostUserId: null,
      hostWorkforceId: null,
      hostName: null,
    });
    assert.equal(hostless.status, 400, JSON.stringify(hostless.body));
    assert.equal(
      hostless.body.error.code,
      'HOST_CONFIRMATION_HOST_REQUIRED',
    );
  });

  it('handles duplicate confirmations per visit', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const expected = await createExpectedVisit(f);

    const first = await requestConfirmation({
      expectedVisitorId: expected.id,
    });
    assert.equal(first.status, 201);

    const dup = await requestConfirmation({
      expectedVisitorId: expected.id,
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(dup.body.error.code, 'HOST_CONFIRMATION_ALREADY_EXISTS');
  });

  it('protects decided confirmations (REJECTED can never become CONFIRMED)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Rejected stays rejected.
    const walkIn = await createWalkIn(f);
    const rejectedReq = await requestConfirmation({ walkInVisitId: walkIn.id });
    const rejectedId = rejectedReq.body.data.id;
    await api()
      .post(`/api/v1/host-confirmations/${rejectedId}/reject`)
      .set(auth())
      .send({ rejectionReason: 'Unknown visitor.' });

    const confirmAfterReject = await api()
      .post(`/api/v1/host-confirmations/${rejectedId}/confirm`)
      .set(auth())
      .send({});
    assert.equal(confirmAfterReject.status, 409);
    assert.equal(
      confirmAfterReject.body.error.code,
      'HOST_CONFIRMATION_ALREADY_DECIDED',
    );

    const rejectTwice = await api()
      .post(`/api/v1/host-confirmations/${rejectedId}/reject`)
      .set(auth())
      .send({ rejectionReason: 'Again.' });
    assert.equal(rejectTwice.status, 409);
    assert.equal(
      rejectTwice.body.error.code,
      'HOST_CONFIRMATION_ALREADY_DECIDED',
    );

    const stillRejected = await api()
      .get(`/api/v1/host-confirmations/${rejectedId}`)
      .set(auth());
    assert.equal(stillRejected.body.data.status, 'REJECTED');

    // Confirmed stays confirmed.
    const expected = await createExpectedVisit(f);
    const confirmedReq = await requestConfirmation({
      expectedVisitorId: expected.id,
    });
    const confirmedId = confirmedReq.body.data.id;
    await api()
      .post(`/api/v1/host-confirmations/${confirmedId}/confirm`)
      .set(auth())
      .send({});

    const confirmTwice = await api()
      .post(`/api/v1/host-confirmations/${confirmedId}/confirm`)
      .set(auth())
      .send({});
    assert.equal(confirmTwice.status, 409);
    assert.equal(
      confirmTwice.body.error.code,
      'HOST_CONFIRMATION_ALREADY_DECIDED',
    );

    const rejectAfterConfirm = await api()
      .post(`/api/v1/host-confirmations/${confirmedId}/reject`)
      .set(auth())
      .send({ rejectionReason: 'Too late.' });
    assert.equal(rejectAfterConfirm.status, 409);
    assert.equal(
      rejectAfterConfirm.body.error.code,
      'HOST_CONFIRMATION_ALREADY_DECIDED',
    );
  });

  it('lists and filters confirmations', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const expected = await createExpectedVisit(f);
    const walkIn = await createWalkIn(f);
    const c1 = (
      await requestConfirmation({ expectedVisitorId: expected.id })
    ).body.data;
    const c2 = (
      await requestConfirmation({ walkInVisitId: walkIn.id })
    ).body.data;
    await api()
      .post(`/api/v1/host-confirmations/${c2.id}/confirm`)
      .set(auth())
      .send({});

    const listAll = await api().get('/api/v1/host-confirmations').set(auth());
    assert.equal(listAll.status, 200);
    const ids = listAll.body.data.map((x: { id: string }) => x.id);
    assert.ok(ids.includes(c1.id));
    assert.ok(ids.includes(c2.id));

    const pending = await api()
      .get('/api/v1/host-confirmations?status=PENDING')
      .set(auth());
    assert.equal(pending.status, 200);
    assert.ok(pending.body.data.some((x: { id: string }) => x.id === c1.id));
    assert.ok(!pending.body.data.some((x: { id: string }) => x.id === c2.id));

    const byVisit = await api()
      .get(`/api/v1/host-confirmations?walkInVisitId=${walkIn.id}`)
      .set(auth());
    assert.equal(byVisit.status, 200);
    assert.equal(byVisit.body.data.length, 1);
    assert.equal(byVisit.body.data[0].id, c2.id);

    const byHost = await api()
      .get(`/api/v1/host-confirmations?hostUserId=${managerUserId}`)
      .set(auth());
    assert.equal(byHost.status, 200);
    assert.ok(byHost.body.data.some((x: { id: string }) => x.id === c1.id));
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const expected = await createExpectedVisit(f);
    const plainToken = await createPlainSession();

    const forbiddenCreate = await requestConfirmation(
      { expectedVisitorId: expected.id },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/host-confirmations')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await requestConfirmation({
      expectedVisitorId: expected.id,
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    const forbiddenRead = await api()
      .get(`/api/v1/host-confirmations/${id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenConfirm = await api()
      .post(`/api/v1/host-confirmations/${id}/confirm`)
      .set(auth(plainToken))
      .send({});
    assert.equal(forbiddenConfirm.status, 403);
    assert.equal(forbiddenConfirm.body.error.code, 'PERMISSION_DENIED');

    const forbiddenReject = await api()
      .post(`/api/v1/host-confirmations/${id}/reject`)
      .set(auth(plainToken))
      .send({ rejectionReason: 'Forbidden.' });
    assert.equal(forbiddenReject.status, 403);
    assert.equal(forbiddenReject.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/host-confirmations');
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const expected = await createExpectedVisit(f);

    const created = await requestConfirmation({
      expectedVisitorId: expected.id,
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    // A user with access only to building B cannot touch a building-A
    // confirmation — request, read, confirm or reject.
    const deniedRequest = await requestConfirmation(
      { expectedVisitorId: expected.id },
      f.bAdmin.token,
    );
    assert.equal(deniedRequest.status, 403);
    assert.equal(deniedRequest.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedRead = await api()
      .get(`/api/v1/host-confirmations/${id}`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedConfirm = await api()
      .post(`/api/v1/host-confirmations/${id}/confirm`)
      .set(auth(f.bAdmin.token))
      .send({});
    assert.equal(deniedConfirm.status, 403);
    assert.equal(deniedConfirm.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedReject = await api()
      .post(`/api/v1/host-confirmations/${id}/reject`)
      .set(auth(f.bAdmin.token))
      .send({ rejectionReason: 'Denied.' });
    assert.equal(deniedReject.status, 403);
    assert.equal(deniedReject.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get(`/api/v1/host-confirmations?buildingId=${f.buildingB.id}`)
      .set(auth());
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Unfiltered list is scoped to accessible buildings.
    const scoped = await api()
      .get('/api/v1/host-confirmations')
      .set(auth(f.bAdmin.token));
    assert.equal(scoped.status, 200);
    const ids = scoped.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(id));
  });
});
