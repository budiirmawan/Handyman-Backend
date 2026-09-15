import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-13I — Visitor Pass focused validation only.
 *
 * Covers issue/get/list, unique code, active visit gate, one active pass
 * per visit, return/cancel, Check-Out consistency, Building mismatch,
 * RBAC, and Client / Building isolation.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       visitor_passes, visit_check_ins, host_confirmations, visitor_photos,
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

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Visitor pass client A',
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
    name: 'Visitor pass client B',
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

  return { clientA, buildingA, clientB, buildingB, bAdmin };
}

async function activeVisit(
  fixture: Awaited<ReturnType<typeof seed>>,
  label = 'Pass Guest',
) {
  const visitorResponse = await api()
    .post(`/api/v1/clients/${fixture.clientA.id}/visitors`)
    .set(auth())
    .send({ fullName: `${label} ${suffix()}` });
  assert.equal(visitorResponse.status, 201, JSON.stringify(visitorResponse.body));

  const walkInResponse = await api()
    .post('/api/v1/walk-in-visits')
    .set(auth())
    .send({
      buildingId: fixture.buildingA.id,
      visitorId: visitorResponse.body.data.id,
      hostName: 'Pass desk host',
      purpose: 'Visitor pass validation',
    });
  assert.equal(walkInResponse.status, 201, JSON.stringify(walkInResponse.body));

  const checkInResponse = await api()
    .post('/api/v1/visit-check-ins')
    .set(auth())
    .send({ walkInVisitId: walkInResponse.body.data.id });
  assert.equal(checkInResponse.status, 201, JSON.stringify(checkInResponse.body));

  return {
    visitor: visitorResponse.body.data,
    walkIn: walkInResponse.body.data,
    checkIn: checkInResponse.body.data,
  };
}

async function issuePass(
  buildingId: string,
  visitCheckInId: string,
  passCode = `PASS-${suffix()}`,
  token = managerToken,
) {
  return api()
    .post('/api/v1/visitor-passes')
    .set(auth(token))
    .send({ buildingId, visitCheckInId, passCode });
}

describe('BE-13I visitor pass', () => {
  it('issues, gets, and lists a pass by Building/status', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { checkIn } = await activeVisit(fixture);

    const issued = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      ' lobby-pass-001 ',
    );
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(issued.body.data.visitCheckInId, checkIn.id);
    assert.equal(issued.body.data.passCode, 'LOBBY-PASS-001');
    assert.equal(issued.body.data.status, 'ACTIVE');
    assert.equal(issued.body.data.issuedByUserId, managerUserId);
    assert.ok(issued.body.data.issuedAt);
    assert.equal(issued.body.data.returnedAt, null);

    const read = await api()
      .get(`/api/v1/visitor-passes/${issued.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, issued.body.data.id);

    const list = await api()
      .get(
        `/api/v1/visitor-passes?buildingId=${fixture.buildingA.id}&status=ACTIVE`,
      )
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(
      list.body.data.some(
        (pass: { id: string }) => pass.id === issued.body.data.id,
      ),
    );
    assert.ok(
      list.body.data.every(
        (pass: { buildingId: string; status: string }) =>
          pass.buildingId === fixture.buildingA.id &&
          pass.status === 'ACTIVE',
      ),
    );
  });

  it('rejects duplicate pass codes globally', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const firstVisit = await activeVisit(fixture, 'First Code Guest');
    const secondVisit = await activeVisit(fixture, 'Second Code Guest');

    const first = await issuePass(
      fixture.buildingA.id,
      firstVisit.checkIn.id,
      'UNIQUE-100',
    );
    assert.equal(first.status, 201);

    const duplicate = await issuePass(
      fixture.buildingA.id,
      secondVisit.checkIn.id,
      'unique-100',
    );
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'VISITOR_PASS_CODE_ALREADY_EXISTS',
    );
  });

  it('rejects unknown, cancelled, and completed visits', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();

    const unknown = await issuePass(
      fixture.buildingA.id,
      randomUUID(),
      'UNKNOWN-VISIT',
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'VISITOR_PASS_VISIT_NOT_FOUND');

    const cancelledVisit = await activeVisit(fixture, 'Cancelled Visit Guest');
    await api()
      .post(`/api/v1/visit-check-ins/${cancelledVisit.checkIn.id}/cancel`)
      .set(auth());
    const cancelled = await issuePass(
      fixture.buildingA.id,
      cancelledVisit.checkIn.id,
      'CANCELLED-VISIT',
    );
    assert.equal(cancelled.status, 409, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.error.code, 'VISITOR_PASS_VISIT_NOT_ACTIVE');

    const completedVisit = await activeVisit(fixture, 'Completed Visit Guest');
    await api()
      .post(`/api/v1/visit-check-ins/${completedVisit.checkIn.id}/check-out`)
      .set(auth())
      .send({});
    const completed = await issuePass(
      fixture.buildingA.id,
      completedVisit.checkIn.id,
      'COMPLETED-VISIT',
    );
    assert.equal(completed.status, 409, JSON.stringify(completed.body));
    assert.equal(completed.body.error.code, 'VISITOR_PASS_VISIT_NOT_ACTIVE');
  });

  it('rejects conflicting active passes and permits issue after cancellation', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { checkIn } = await activeVisit(fixture, 'Conflict Guest');

    const first = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'CONFLICT-ONE',
    );
    assert.equal(first.status, 201);

    const conflict = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'CONFLICT-TWO',
    );
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(
      conflict.body.error.code,
      'VISITOR_PASS_ACTIVE_ALREADY_EXISTS',
    );

    const cancelled = await api()
      .post(`/api/v1/visitor-passes/${first.body.data.id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.ok(cancelled.body.data.cancelledAt);
    assert.equal(cancelled.body.data.cancelledByUserId, managerUserId);

    const next = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'CONFLICT-TWO',
    );
    assert.equal(next.status, 201, JSON.stringify(next.body));
  });

  it('returns an active pass exactly once', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { checkIn } = await activeVisit(fixture, 'Return Guest');
    const issued = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'RETURN-100',
    );

    const returned = await api()
      .post(`/api/v1/visitor-passes/${issued.body.data.id}/return`)
      .set(auth())
      .send({});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.data.status, 'RETURNED');
    assert.ok(returned.body.data.returnedAt);
    assert.equal(returned.body.data.returnedByUserId, managerUserId);

    const again = await api()
      .post(`/api/v1/visitor-passes/${issued.body.data.id}/return`)
      .set(auth())
      .send({});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'VISITOR_PASS_NOT_ACTIVE');
  });

  it('requires active pass resolution before Check-Out', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { checkIn } = await activeVisit(fixture, 'Completion Guest');
    const issued = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'CHECKOUT-100',
    );
    assert.equal(issued.status, 201);

    const blocked = await api()
      .post(`/api/v1/visit-check-ins/${checkIn.id}/check-out`)
      .set(auth())
      .send({});
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(
      blocked.body.error.code,
      'VISITOR_PASS_ACTIVE_AT_VISIT_CLOSURE',
    );

    const stillActive = await api()
      .get(`/api/v1/visit-check-ins/${checkIn.id}`)
      .set(auth());
    assert.equal(stillActive.body.data.status, 'CHECKED_IN');

    await api()
      .post(`/api/v1/visitor-passes/${issued.body.data.id}/return`)
      .set(auth())
      .send({});
    const completed = await api()
      .post(`/api/v1/visit-check-ins/${checkIn.id}/check-out`)
      .set(auth())
      .send({});
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.status, 'CHECKED_OUT');

    const pass = await api()
      .get(`/api/v1/visitor-passes/${issued.body.data.id}`)
      .set(auth());
    assert.equal(pass.body.data.status, 'RETURNED');
  });

  it('rejects a Building that does not match the visit', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { checkIn } = await activeVisit(fixture, 'Mismatch Guest');

    const mismatch = await issuePass(
      fixture.buildingB.id,
      checkIn.id,
      'WRONG-BUILDING',
    );
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(
      mismatch.body.error.code,
      'VISITOR_PASS_BUILDING_MISMATCH',
    );
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { checkIn } = await activeVisit(fixture, 'RBAC Guest');
    const plainToken = await createPlainSession();

    const forbiddenIssue = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'RBAC-100',
      plainToken,
    );
    assert.equal(forbiddenIssue.status, 403);
    assert.equal(forbiddenIssue.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/visitor-passes')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/visitor-passes');
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { checkIn } = await activeVisit(fixture, 'Isolated Guest');
    const issued = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'ISOLATED-100',
    );
    assert.equal(issued.status, 201);

    const deniedRead = await api()
      .get(`/api/v1/visitor-passes/${issued.body.data.id}`)
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedRead.status, 403, JSON.stringify(deniedRead.body));
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedIssue = await issuePass(
      fixture.buildingA.id,
      checkIn.id,
      'ISOLATED-200',
      fixture.bAdmin.token,
    );
    assert.equal(deniedIssue.status, 403);
    assert.equal(deniedIssue.body.error.code, 'BUILDING_ACCESS_DENIED');

    const scopedList = await api()
      .get('/api/v1/visitor-passes')
      .set(auth(fixture.bAdmin.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    assert.ok(
      !scopedList.body.data.some(
        (pass: { id: string }) => pass.id === issued.body.data.id,
      ),
    );

    const deniedBuildingList = await api()
      .get(`/api/v1/visitor-passes?buildingId=${fixture.buildingA.id}`)
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(
      deniedBuildingList.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );
  });
});
