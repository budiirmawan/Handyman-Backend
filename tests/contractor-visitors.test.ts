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
 * BE-13J — Contractor Visitor focused validation only.
 *
 * Covers specialized context creation over an existing Visitor/Visit,
 * binding and mismatch validation, get/list/search/update, compatibility
 * with Check-In / Visitor Pass / Check-Out, RBAC and scoped isolation.
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
       contractor_visitors, visitor_passes, visit_check_ins,
       host_confirmations, visitor_photos, walk_in_visits,
       expected_visitors, visitor_invitations, visitors,
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
    name: 'Contractor client A',
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
    name: 'Contractor client B',
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

async function visitorAndVisit(
  fixture: Awaited<ReturnType<typeof seed>>,
  label = 'Contractor Worker',
) {
  const visitorResponse = await api()
    .post(`/api/v1/clients/${fixture.clientA.id}/visitors`)
    .set(auth())
    .send({
      fullName: `${label} ${suffix()}`,
      organizationName: 'Existing Contractor Identity Ltd',
    });
  assert.equal(visitorResponse.status, 201, JSON.stringify(visitorResponse.body));

  const visitResponse = await api()
    .post('/api/v1/walk-in-visits')
    .set(auth())
    .send({
      buildingId: fixture.buildingA.id,
      visitorId: visitorResponse.body.data.id,
      hostUserId: managerUserId,
      purpose: 'Scheduled contractor work',
    });
  assert.equal(visitResponse.status, 201, JSON.stringify(visitResponse.body));

  return {
    visitor: visitorResponse.body.data,
    visit: visitResponse.body.data,
  };
}

async function createContractor(
  fixture: Awaited<ReturnType<typeof seed>>,
  visitorId: string,
  walkInVisitId: string,
  overrides: Record<string, unknown> = {},
  token = managerToken,
) {
  return api()
    .post('/api/v1/contractor-visitors')
    .set(auth(token))
    .send({
      buildingId: fixture.buildingA.id,
      visitorId,
      walkInVisitId,
      contractorCompany: 'Teknik Nusantara',
      contractorPurpose: 'Preventive maintenance',
      workLocation: 'Level 3 plant room',
      notes: 'Safety induction completed.',
      ...overrides,
    });
}

describe('BE-13J contractor visitor', () => {
  it('creates a context by reusing the existing Visitor and valid Visit binding', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture);
    const before = await pool!.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM visitors',
    );

    const created = await createContractor(
      fixture,
      visitor.id,
      visit.id,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const data = created.body.data;
    assert.equal(data.clientId, fixture.clientA.id);
    assert.equal(data.buildingId, fixture.buildingA.id);
    assert.equal(data.visitorId, visitor.id);
    assert.equal(data.walkInVisitId, visit.id);
    assert.equal(data.expectedVisitorId, null);
    assert.equal(data.contractorCompany, 'Teknik Nusantara');
    assert.equal(data.contractorPurpose, 'Preventive maintenance');
    assert.equal(data.responsibleHostUserId, managerUserId);
    assert.equal(data.workLocation, 'Level 3 plant room');
    assert.equal(data.status, 'REGISTERED');

    // The contractor layer must reuse, never duplicate, Visitor identity.
    const after = await pool!.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM visitors',
    );
    assert.equal(after.rows[0].count, before.rows[0].count);

    const read = await api()
      .get(`/api/v1/contractor-visitors/${data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.visitorId, visitor.id);

    const updated = await api()
      .patch(`/api/v1/contractor-visitors/${data.id}`)
      .set(auth())
      .send({
        contractorPurpose: 'Generator inspection and calibration',
        workLocation: 'Generator room',
        notes: 'Permit to work PTW-100.',
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(
      updated.body.data.contractorPurpose,
      'Generator inspection and calibration',
    );
    assert.equal(updated.body.data.workLocation, 'Generator room');

    const list = await api()
      .get('/api/v1/contractor-visitors')
      .query({
        buildingId: fixture.buildingA.id,
        status: 'REGISTERED',
        search: 'generator',
      })
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(
      list.body.data.map((row: { id: string }) => row.id),
      [data.id],
    );
  });

  it('rejects invalid Visitor and Visit bindings', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture, 'Binding Worker');

    const noVisit = await api()
      .post('/api/v1/contractor-visitors')
      .set(auth())
      .send({
        contractorCompany: 'No Visit Ltd',
        contractorPurpose: 'Invalid binding',
      });
    assert.equal(noVisit.status, 400);
    assert.equal(
      noVisit.body.error.code,
      'CONTRACTOR_VISITOR_VISIT_REFERENCE_REQUIRED',
    );

    const unknownVisit = await createContractor(
      fixture,
      visitor.id,
      randomUUID(),
      { contractorCompany: 'Unknown Visit Ltd' },
    );
    assert.equal(unknownVisit.status, 404, JSON.stringify(unknownVisit.body));
    assert.equal(unknownVisit.body.error.code, 'WALK_IN_VISIT_NOT_FOUND');

    const wrongVisitor = await createContractor(
      fixture,
      randomUUID(),
      visit.id,
      { contractorCompany: 'Wrong Visitor Ltd' },
    );
    assert.equal(wrongVisitor.status, 400, JSON.stringify(wrongVisitor.body));
    assert.equal(
      wrongVisitor.body.error.code,
      'CONTRACTOR_VISITOR_VISIT_MISMATCH',
    );

    await api()
      .post(`/api/v1/walk-in-visits/${visit.id}/cancel`)
      .set(auth());
    const cancelled = await createContractor(
      fixture,
      visitor.id,
      visit.id,
      { contractorCompany: 'Cancelled Visit Ltd' },
    );
    assert.equal(cancelled.status, 400, JSON.stringify(cancelled.body));
    assert.equal(
      cancelled.body.error.code,
      'CONTRACTOR_VISITOR_VISIT_CANCELLED',
    );

    // Contractor cancellation remains a specialization gate over the
    // same visit and does not create a second lifecycle.
    const cancellable = await visitorAndVisit(fixture, 'Cancelled Contractor');
    const contractor = await createContractor(
      fixture,
      cancellable.visitor.id,
      cancellable.visit.id,
    );
    assert.equal(contractor.status, 201);
    const cancelledContext = await api()
      .patch(`/api/v1/contractor-visitors/${contractor.body.data.id}`)
      .set(auth())
      .send({ status: 'CANCELLED' });
    assert.equal(cancelledContext.status, 200);
    assert.equal(cancelledContext.body.data.status, 'CANCELLED');

    const blockedCheckIn = await api()
      .post('/api/v1/visit-check-ins')
      .set(auth())
      .send({ walkInVisitId: cancellable.visit.id });
    assert.equal(blockedCheckIn.status, 409, JSON.stringify(blockedCheckIn.body));
    assert.equal(
      blockedCheckIn.body.error.code,
      'CONTRACTOR_VISITOR_CANCELLED_CHECK_IN',
    );
  });

  it('rejects Building and responsible host mismatch', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture, 'Mismatch Worker');

    const buildingMismatch = await createContractor(
      fixture,
      visitor.id,
      visit.id,
      { buildingId: fixture.buildingB.id },
    );
    assert.equal(
      buildingMismatch.status,
      400,
      JSON.stringify(buildingMismatch.body),
    );
    assert.equal(
      buildingMismatch.body.error.code,
      'CONTRACTOR_VISITOR_VISIT_MISMATCH',
    );

    const hostMismatch = await createContractor(
      fixture,
      visitor.id,
      visit.id,
      { responsibleHostUserId: fixture.bAdmin.userId },
    );
    assert.equal(hostMismatch.status, 400, JSON.stringify(hostMismatch.body));
    assert.equal(
      hostMismatch.body.error.code,
      'CONTRACTOR_VISITOR_HOST_BUILDING_MISMATCH',
    );
  });

  it('reuses Check-In, Visitor Pass and Check-Out without a second lifecycle', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture, 'Lifecycle Worker');
    const contractor = await createContractor(fixture, visitor.id, visit.id);
    assert.equal(contractor.status, 201, JSON.stringify(contractor.body));

    const checkIn = await api()
      .post('/api/v1/visit-check-ins')
      .set(auth())
      .send({ walkInVisitId: visit.id });
    assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
    assert.equal(checkIn.body.data.visitorId, visitor.id);

    const pass = await api()
      .post('/api/v1/visitor-passes')
      .set(auth())
      .send({
        buildingId: fixture.buildingA.id,
        visitCheckInId: checkIn.body.data.id,
        passCode: `CONTRACTOR-${suffix()}`,
      });
    assert.equal(pass.status, 201, JSON.stringify(pass.body));
    assert.equal(pass.body.data.status, 'ACTIVE');

    const returned = await api()
      .post(`/api/v1/visitor-passes/${pass.body.data.id}/return`)
      .set(auth())
      .send({});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));

    const checkOut = await api()
      .post(`/api/v1/visit-check-ins/${checkIn.body.data.id}/check-out`)
      .set(auth())
      .send({});
    assert.equal(checkOut.status, 200, JSON.stringify(checkOut.body));
    assert.equal(checkOut.body.data.status, 'CHECKED_OUT');

    const context = await api()
      .get(`/api/v1/contractor-visitors/${contractor.body.data.id}`)
      .set(auth());
    assert.equal(context.status, 200);
    assert.equal(context.body.data.walkInVisitId, visit.id);
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture, 'RBAC Worker');
    const plainToken = await createPlainSession();

    const forbiddenCreate = await createContractor(
      fixture,
      visitor.id,
      visit.id,
      {},
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/contractor-visitors')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/contractor-visitors');
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture, 'Isolated Worker');
    const contractor = await createContractor(fixture, visitor.id, visit.id);
    assert.equal(contractor.status, 201);
    const id = contractor.body.data.id;

    const deniedRead = await api()
      .get(`/api/v1/contractor-visitors/${id}`)
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedRead.status, 403, JSON.stringify(deniedRead.body));
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedUpdate = await api()
      .patch(`/api/v1/contractor-visitors/${id}`)
      .set(auth(fixture.bAdmin.token))
      .send({ notes: 'Cross-client write attempt' });
    assert.equal(deniedUpdate.status, 403);
    assert.equal(deniedUpdate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedCreate = await createContractor(
      fixture,
      visitor.id,
      visit.id,
      { contractorCompany: 'Cross Client Ltd' },
      fixture.bAdmin.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const scopedList = await api()
      .get('/api/v1/contractor-visitors')
      .set(auth(fixture.bAdmin.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    assert.ok(
      !scopedList.body.data.some((row: { id: string }) => row.id === id),
    );

    const deniedBuildingList = await api()
      .get('/api/v1/contractor-visitors')
      .query({ buildingId: fixture.buildingA.id })
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(
      deniedBuildingList.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );
  });
});
