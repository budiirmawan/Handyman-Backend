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
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-13G — Check-In focused validation.
 *
 * Covers:
 *  - valid check-in over Expected Visitor and Walk-In visits
 *  - duplicate active check-in rejected; cancel frees the visit
 *  - invalid / cancelled visit rejected
 *  - blocked / inactive visitor identity rejected
 *  - confirmation gate: PENDING and REJECTED confirmations block
 *    check-in; CONFIRMED and no-record pass
 *  - Building context derives from the visit (cross-building denied)
 *  - current checked-in visitor listing per Building
 *  - future check-in time rejected
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
       visit_check_ins, host_confirmations, visitor_photos,
       walk_in_visits, expected_visitors, visitor_invitations, visitors,
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
    name: 'Check-in client A',
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
    name: 'Check-in client B',
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

  const bAdmin = await createAdminUser();
  await buildingAssignmentService.createAssignment(bAdmin.userId, {
    buildingId: buildingB.id,
  });

  return { clientA, clientB, buildingA, buildingA2, buildingB, bAdmin };
}

async function newVisitor(clientId: string, fullName = 'Check Guest') {
  const response = await api()
    .post(`/api/v1/clients/${clientId}/visitors`)
    .set(auth())
    .send({ fullName: `${fullName} ${suffix()}` });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function newExpectedVisit(
  buildingId: string,
  visitorId: string,
) {
  const response = await api()
    .post('/api/v1/expected-visitors')
    .set(auth())
    .send({
      buildingId,
      visitorId,
      hostName: 'Check-in host',
      expectedArrivalAt: arrival(),
      purpose: 'Check-in test',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function newWalkIn(buildingId: string, visitorId: string) {
  const response = await api()
    .post('/api/v1/walk-in-visits')
    .set(auth())
    .send({
      buildingId,
      visitorId,
      hostName: 'Walk-in host',
      purpose: 'Walk-in check-in test',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function checkIn(body: Record<string, unknown>, token = managerToken) {
  return api().post('/api/v1/visit-check-ins').set(auth(token)).send(body);
}

describe('BE-13G visit check-in', () => {
  it('checks in an expected visitor and a walk-in visit', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const visitor = await newVisitor(f.clientA.id);
    const expected = await newExpectedVisit(f.buildingA.id, visitor.id);

    const response = await checkIn({
      expectedVisitorId: expected.id,
      entryNotes: 'Badge 42 issued at lobby.',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.visitorId, visitor.id);
    assert.equal(data.expectedVisitorId, expected.id);
    assert.equal(data.walkInVisitId, null);
    assert.equal(data.status, 'CHECKED_IN');
    assert.equal(data.checkedInByUserId, managerUserId);
    assert.ok(data.checkedInAt);
    assert.equal(data.entryNotes, 'Badge 42 issued at lobby.');

    // Walk-in path with an explicit past timestamp.
    const visitor2 = await newVisitor(f.clientA.id, 'Walkin Guest');
    const walkIn = await newWalkIn(f.buildingA.id, visitor2.id);
    const checkedInAt = new Date(Date.now() - 1 * HOUR).toISOString();
    const walkInResponse = await checkIn({
      walkInVisitId: walkIn.id,
      checkedInAt,
    });
    assert.equal(walkInResponse.status, 201, JSON.stringify(walkInResponse.body));
    assert.equal(walkInResponse.body.data.walkInVisitId, walkIn.id);
    assert.equal(walkInResponse.body.data.checkedInAt, checkedInAt);

    // Get by id.
    const read = await api()
      .get(`/api/v1/visit-check-ins/${data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, 'CHECKED_IN');
  });

  it('rejects duplicate active check-in; cancel frees the visit', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const visitor = await newVisitor(f.clientA.id);
    const expected = await newExpectedVisit(f.buildingA.id, visitor.id);

    const first = await checkIn({ expectedVisitorId: expected.id });
    assert.equal(first.status, 201);

    const dup = await checkIn({ expectedVisitorId: expected.id });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(dup.body.error.code, 'VISIT_CHECK_IN_ALREADY_CHECKED_IN');

    // Cancel (mistake reversal).
    const cancelled = await api()
      .post(`/api/v1/visit-check-ins/${first.body.data.id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');

    // Cancel is single-shot.
    const cancelTwice = await api()
      .post(`/api/v1/visit-check-ins/${first.body.data.id}/cancel`)
      .set(auth());
    assert.equal(cancelTwice.status, 409);
    assert.equal(
      cancelTwice.body.error.code,
      'VISIT_CHECK_IN_ALREADY_CANCELLED',
    );

    // The visit is free for a fresh check-in.
    const again = await checkIn({ expectedVisitorId: expected.id });
    assert.equal(again.status, 201, JSON.stringify(again.body));
  });

  it('rejects invalid or cancelled visits and non-active visitors', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const visitor = await newVisitor(f.clientA.id);
    const expected = await newExpectedVisit(f.buildingA.id, visitor.id);
    const walkIn = await newWalkIn(f.buildingA.id, visitor.id);

    // Neither / both references.
    const neither = await checkIn({});
    assert.equal(neither.status, 400);
    assert.equal(
      neither.body.error.code,
      'VISIT_CHECK_IN_VISIT_REFERENCE_REQUIRED',
    );
    const both = await checkIn({
      expectedVisitorId: expected.id,
      walkInVisitId: walkIn.id,
    });
    assert.equal(both.status, 400);
    assert.equal(
      both.body.error.code,
      'VISIT_CHECK_IN_VISIT_REFERENCE_REQUIRED',
    );

    // Unknown visits.
    const unknownExpected = await checkIn({ expectedVisitorId: randomUUID() });
    assert.equal(unknownExpected.status, 404);
    assert.equal(unknownExpected.body.error.code, 'EXPECTED_VISITOR_NOT_FOUND');
    const unknownWalkIn = await checkIn({ walkInVisitId: randomUUID() });
    assert.equal(unknownWalkIn.status, 404);
    assert.equal(unknownWalkIn.body.error.code, 'WALK_IN_VISIT_NOT_FOUND');

    // Cancelled visit.
    await api()
      .post(`/api/v1/expected-visitors/${expected.id}/cancel`)
      .set(auth());
    const cancelledVisit = await checkIn({ expectedVisitorId: expected.id });
    assert.equal(cancelledVisit.status, 400);
    assert.equal(
      cancelledVisit.body.error.code,
      'VISIT_CHECK_IN_VISIT_CANCELLED',
    );

    // Visitor blocked after registration.
    const visitor2 = await newVisitor(f.clientA.id, 'Soon Blocked');
    const walkIn2 = await newWalkIn(f.buildingA.id, visitor2.id);
    await api()
      .patch(`/api/v1/visitors/${visitor2.id}`)
      .set(auth())
      .send({ status: 'BLOCKED' });
    const blocked = await checkIn({ walkInVisitId: walkIn2.id });
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
    assert.equal(
      blocked.body.error.code,
      'VISIT_CHECK_IN_VISITOR_NOT_ACTIVE',
    );

    // Future timestamp.
    const visitor3 = await newVisitor(f.clientA.id, 'Future Guest');
    const walkIn3 = await newWalkIn(f.buildingA.id, visitor3.id);
    const future = await checkIn({
      walkInVisitId: walkIn3.id,
      checkedInAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    assert.equal(future.status, 400);
    assert.equal(future.body.error.code, 'VISIT_CHECK_IN_TIME_IN_FUTURE');
  });

  it('gates check-in on the host confirmation state', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // PENDING confirmation blocks check-in.
    const visitor1 = await newVisitor(f.clientA.id, 'Pending Guest');
    const visit1 = await newExpectedVisit(f.buildingA.id, visitor1.id);
    await api()
      .post('/api/v1/host-confirmations')
      .set(auth())
      .send({ expectedVisitorId: visit1.id });
    const pendingBlocked = await checkIn({ expectedVisitorId: visit1.id });
    assert.equal(pendingBlocked.status, 409, JSON.stringify(pendingBlocked.body));
    assert.equal(
      pendingBlocked.body.error.code,
      'VISIT_CHECK_IN_CONFIRMATION_PENDING',
    );

    // REJECTED confirmation blocks check-in permanently.
    const visitor2 = await newVisitor(f.clientA.id, 'Rejected Guest');
    const visit2 = await newWalkIn(f.buildingA.id, visitor2.id);
    const conf2 = (
      await api()
        .post('/api/v1/host-confirmations')
        .set(auth())
        .send({ walkInVisitId: visit2.id })
    ).body.data;
    await api()
      .post(`/api/v1/host-confirmations/${conf2.id}/reject`)
      .set(auth())
      .send({ rejectionReason: 'Host refused the visit.' });
    const rejectedBlocked = await checkIn({ walkInVisitId: visit2.id });
    assert.equal(rejectedBlocked.status, 409);
    assert.equal(
      rejectedBlocked.body.error.code,
      'VISIT_CHECK_IN_CONFIRMATION_REJECTED',
    );

    // CONFIRMED confirmation passes.
    const conf1 = (
      await api()
        .get(`/api/v1/host-confirmations?expectedVisitorId=${visit1.id}`)
        .set(auth())
    ).body.data[0];
    await api()
      .post(`/api/v1/host-confirmations/${conf1.id}/confirm`)
      .set(auth())
      .send({});
    const confirmedPass = await checkIn({ expectedVisitorId: visit1.id });
    assert.equal(confirmedPass.status, 201, JSON.stringify(confirmedPass.body));

    // No confirmation record at all also passes (verified implicitly by
    // the other tests, asserted explicitly here).
    const visitor3 = await newVisitor(f.clientA.id, 'Unconfirmed Guest');
    const visit3 = await newWalkIn(f.buildingA.id, visitor3.id);
    const noRecordPass = await checkIn({ walkInVisitId: visit3.id });
    assert.equal(noRecordPass.status, 201);
  });

  it('lists currently checked-in visitors by building', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const visitorA = await newVisitor(f.clientA.id, 'Lobby A Guest');
    const visitA = await newWalkIn(f.buildingA.id, visitorA.id);
    const checkInA = (await checkIn({ walkInVisitId: visitA.id })).body.data;

    const visitorA2 = await newVisitor(f.clientA.id, 'Lobby A2 Guest');
    const visitA2 = await newWalkIn(f.buildingA2.id, visitorA2.id);
    const checkInA2 = (await checkIn({ walkInVisitId: visitA2.id })).body.data;

    // A cancelled check-in must NOT appear as currently checked in.
    const visitorGone = await newVisitor(f.clientA.id, 'Gone Guest');
    const visitGone = await newWalkIn(f.buildingA.id, visitorGone.id);
    const checkInGone = (await checkIn({ walkInVisitId: visitGone.id })).body
      .data;
    await api()
      .post(`/api/v1/visit-check-ins/${checkInGone.id}/cancel`)
      .set(auth());

    // Current checked-in list for building A.
    const current = await api()
      .get(
        `/api/v1/visit-check-ins?buildingId=${f.buildingA.id}&status=CHECKED_IN`,
      )
      .set(auth());
    assert.equal(current.status, 200);
    const currentIds = current.body.data.map((x: { id: string }) => x.id);
    assert.ok(currentIds.includes(checkInA.id));
    assert.ok(!currentIds.includes(checkInA2.id));
    assert.ok(!currentIds.includes(checkInGone.id));
    assert.ok(
      current.body.data.every(
        (x: { buildingId: string; status: string }) =>
          x.buildingId === f.buildingA.id && x.status === 'CHECKED_IN',
      ),
    );

    // Visitor filter.
    const byVisitor = await api()
      .get(`/api/v1/visit-check-ins?visitorId=${visitorA.id}`)
      .set(auth());
    assert.equal(byVisitor.status, 200);
    assert.equal(byVisitor.body.data.length, 1);

    // Unknown id → 404.
    const missing = await api()
      .get(`/api/v1/visit-check-ins/${randomUUID()}`)
      .set(auth());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'VISIT_CHECK_IN_NOT_FOUND');
  });

  it('rejects invalid input', async (t) => {
    if (!ready(t)) return;
    await seed();

    const badUuid = await checkIn({ expectedVisitorId: 'not-a-uuid' });
    assert.equal(badUuid.status, 400);
    assert.equal(badUuid.body.error.code, 'VALIDATION_ERROR');

    const badDate = await checkIn({
      expectedVisitorId: randomUUID(),
      checkedInAt: 'noonish',
    });
    assert.equal(badDate.status, 400);
    assert.equal(badDate.body.error.code, 'VALIDATION_ERROR');

    const badStatus = await api()
      .get('/api/v1/visit-check-ins?status=DEPARTED')
      .set(auth());
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const visitor = await newVisitor(f.clientA.id);
    const walkIn = await newWalkIn(f.buildingA.id, visitor.id);
    const plainToken = await createPlainSession();

    const forbiddenCreate = await checkIn(
      { walkInVisitId: walkIn.id },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/visit-check-ins')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await checkIn({ walkInVisitId: walkIn.id });
    assert.equal(created.status, 201);

    const forbiddenRead = await api()
      .get(`/api/v1/visit-check-ins/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenCancel = await api()
      .post(`/api/v1/visit-check-ins/${created.body.data.id}/cancel`)
      .set(auth(plainToken));
    assert.equal(forbiddenCancel.status, 403);
    assert.equal(forbiddenCancel.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/visit-check-ins');
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const visitor = await newVisitor(f.clientA.id);
    const walkIn = await newWalkIn(f.buildingA.id, visitor.id);

    // A user without building-A access cannot check in a building-A
    // visit — the Building context always derives from the visit.
    const deniedCreate = await checkIn(
      { walkInVisitId: walkIn.id },
      f.bAdmin.token,
    );
    assert.equal(deniedCreate.status, 403, JSON.stringify(deniedCreate.body));
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const created = await checkIn({ walkInVisitId: walkIn.id });
    assert.equal(created.status, 201);

    const deniedRead = await api()
      .get(`/api/v1/visit-check-ins/${created.body.data.id}`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedCancel = await api()
      .post(`/api/v1/visit-check-ins/${created.body.data.id}/cancel`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedCancel.status, 403);
    assert.equal(deniedCancel.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get(`/api/v1/visit-check-ins?buildingId=${f.buildingA.id}`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Unfiltered list is scoped to accessible buildings.
    const scoped = await api()
      .get('/api/v1/visit-check-ins')
      .set(auth(f.bAdmin.token));
    assert.equal(scoped.status, 200);
    const ids = scoped.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(created.body.data.id));
  });
});
