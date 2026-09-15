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
 * BE-13L — Front Desk Log focused validation only.
 *
 * Covers authoritative BE-13 activity projection, stable get identity,
 * chronological order, Building/date/Visitor/activity filters, RBAC and
 * cross-Client/Building isolation. No reporting/BI behavior is tested.
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
       delivery_couriers, contractor_visitors, visitor_passes,
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

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Front Desk client A',
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
    name: 'Front Desk client B',
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

async function createVisitor(
  fixture: Awaited<ReturnType<typeof seed>>,
  label: string,
) {
  const response = await api()
    .post(`/api/v1/clients/${fixture.clientA.id}/visitors`)
    .set(auth())
    .send({ fullName: `${label} ${suffix()}` });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function createWalkIn(
  fixture: Awaited<ReturnType<typeof seed>>,
  visitorId: string,
  arrivedAt?: string,
) {
  const response = await api()
    .post('/api/v1/walk-in-visits')
    .set(auth())
    .send({
      buildingId: fixture.buildingA.id,
      visitorId,
      hostUserId: managerUserId,
      purpose: 'Front Desk Log validation',
      ...(arrivedAt ? { arrivedAt } : {}),
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function createDelivery(
  fixture: Awaited<ReturnType<typeof seed>>,
  body: Record<string, unknown> = {},
  token = managerToken,
) {
  return api()
    .post('/api/v1/delivery-couriers')
    .set(auth(token))
    .send({
      buildingId: fixture.buildingA.id,
      deliveryType: 'DELIVERY',
      courierCompany: 'Front Desk Express',
      recipientUserId: managerUserId,
      referenceNumber: `FD-${suffix()}`,
      ...body,
    });
}

async function createWalkInActivityFlow(
  fixture: Awaited<ReturnType<typeof seed>>,
) {
  const visitor = await createVisitor(fixture, 'Activity Guest');
  const walkIn = await createWalkIn(
    fixture,
    visitor.id,
    new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  );

  const contractor = await api()
    .post('/api/v1/contractor-visitors')
    .set(auth())
    .send({
      buildingId: fixture.buildingA.id,
      visitorId: visitor.id,
      walkInVisitId: walkIn.id,
      contractorCompany: 'Activity Contractor',
      contractorPurpose: 'Front desk activity test',
    });
  assert.equal(contractor.status, 201, JSON.stringify(contractor.body));

  const delivery = await createDelivery(fixture, {
    deliveryType: 'COURIER',
    visitorId: visitor.id,
    walkInVisitId: walkIn.id,
  });
  assert.equal(delivery.status, 201, JSON.stringify(delivery.body));

  const checkIn = await api()
    .post('/api/v1/visit-check-ins')
    .set(auth())
    .send({ walkInVisitId: walkIn.id, entryNotes: 'Lobby entry.' });
  assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));

  const pass = await api()
    .post('/api/v1/visitor-passes')
    .set(auth())
    .send({
      buildingId: fixture.buildingA.id,
      visitCheckInId: checkIn.body.data.id,
      passCode: `FD-PASS-${suffix()}`,
    });
  assert.equal(pass.status, 201, JSON.stringify(pass.body));

  const returned = await api()
    .post(`/api/v1/visitor-passes/${pass.body.data.id}/return`)
    .set(auth())
    .send({});
  assert.equal(returned.status, 200, JSON.stringify(returned.body));

  const checkOut = await api()
    .post(`/api/v1/visit-check-ins/${checkIn.body.data.id}/check-out`)
    .set(auth())
    .send({ exitNotes: 'Lobby exit.' });
  assert.equal(checkOut.status, 200, JSON.stringify(checkOut.body));

  return { visitor, walkIn, contractor, delivery, checkIn, pass, checkOut };
}

describe('BE-13L Front Desk Log', () => {
  it('projects Invitation, Expected Visitor and Host Confirmation activities and gets one event', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const visitor = await createVisitor(fixture, 'Expected Guest');
    const expectedArrivalAt = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();

    const invitation = await api()
      .post('/api/v1/visitor-invitations')
      .set(auth())
      .send({
        buildingId: fixture.buildingA.id,
        visitorId: visitor.id,
        hostUserId: managerUserId,
        expectedArrivalAt,
        purpose: 'Planned front desk visit',
        notes: 'Invitation activity.',
      });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));

    const expected = await api()
      .post('/api/v1/expected-visitors')
      .set(auth())
      .send({ visitorInvitationId: invitation.body.data.id });
    assert.equal(expected.status, 201, JSON.stringify(expected.body));

    const requested = await api()
      .post('/api/v1/host-confirmations')
      .set(auth())
      .send({
        expectedVisitorId: expected.body.data.id,
        notes: 'Awaiting host.',
      });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));

    const confirmed = await api()
      .post(`/api/v1/host-confirmations/${requested.body.data.id}/confirm`)
      .set(auth())
      .send({ notes: 'Host confirmed.' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const response = await api()
      .get('/api/v1/front-desk-logs')
      .query({
        buildingId: fixture.buildingA.id,
        visitorId: visitor.id,
      })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const types = response.body.data.map(
      (row: { activityType: string }) => row.activityType,
    );
    assert.ok(types.includes('INVITATION_CREATED'));
    assert.ok(types.includes('EXPECTED_VISITOR_REGISTERED'));
    assert.ok(types.includes('HOST_CONFIRMATION_REQUESTED'));
    assert.ok(types.includes('HOST_CONFIRMATION_CONFIRMED'));

    const event = response.body.data.find(
      (row: { activityType: string }) =>
        row.activityType === 'HOST_CONFIRMATION_CONFIRMED',
    );
    assert.equal(event.actorUserId, managerUserId);
    assert.equal(event.visitorId, visitor.id);
    assert.equal(event.expectedVisitorId, expected.body.data.id);

    const read = await api()
      .get(`/api/v1/front-desk-logs/${encodeURIComponent(event.id)}`)
      .set(auth());
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.id, event.id);
    assert.equal(read.body.data.notes, 'Host confirmed.');
  });

  it('projects Walk-In, Contractor, Delivery, Check-In/Out and Pass in chronological order', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const flow = await createWalkInActivityFlow(fixture);

    const response = await api()
      .get('/api/v1/front-desk-logs')
      .query({
        buildingId: fixture.buildingA.id,
        visitorId: flow.visitor.id,
      })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const rows = response.body.data;
    const types = rows.map((row: { activityType: string }) => row.activityType);
    for (const expectedType of [
      'WALK_IN_REGISTERED',
      'CONTRACTOR_VISITOR_REGISTERED',
      'DELIVERY_COURIER_ARRIVED',
      'VISIT_CHECKED_IN',
      'VISITOR_PASS_ISSUED',
      'VISITOR_PASS_RETURNED',
      'VISIT_CHECKED_OUT',
    ]) {
      assert.ok(types.includes(expectedType), `missing ${expectedType}`);
    }

    const timestamps = rows.map((row: { occurredAt: string }) =>
      new Date(row.occurredAt).getTime(),
    );
    for (let index = 1; index < timestamps.length; index += 1) {
      assert.ok(
        timestamps[index - 1] <= timestamps[index],
        'Front Desk Log is not in chronological order',
      );
    }
    assert.ok(
      types.indexOf('WALK_IN_REGISTERED') < types.indexOf('VISIT_CHECKED_IN'),
    );
  });

  it('filters by Building and date window', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const oldDelivery = await createDelivery(fixture, {
      arrivedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      referenceNumber: 'OLD-DELIVERY',
    });
    assert.equal(oldDelivery.status, 201, JSON.stringify(oldDelivery.body));

    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const currentDelivery = await createDelivery(fixture, {
      referenceNumber: 'CURRENT-DELIVERY',
    });
    assert.equal(
      currentDelivery.status,
      201,
      JSON.stringify(currentDelivery.body),
    );
    const windowEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const response = await api()
      .get('/api/v1/front-desk-logs')
      .query({
        buildingId: fixture.buildingA.id,
        occurredFrom: windowStart,
        occurredTo: windowEnd,
        activityType: 'DELIVERY_COURIER_ARRIVED',
      })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const sourceIds = response.body.data.map(
      (row: { sourceId: string }) => row.sourceId,
    );
    assert.ok(sourceIds.includes(currentDelivery.body.data.id));
    assert.ok(!sourceIds.includes(oldDelivery.body.data.id));
    assert.ok(
      response.body.data.every(
        (row: { buildingId: string }) =>
          row.buildingId === fixture.buildingA.id,
      ),
    );
  });

  it('filters by Visitor and activity type', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const first = await createVisitor(fixture, 'First Filter Guest');
    const second = await createVisitor(fixture, 'Second Filter Guest');
    const firstVisit = await createWalkIn(fixture, first.id);
    await createWalkIn(fixture, second.id);

    const response = await api()
      .get('/api/v1/front-desk-logs')
      .query({
        buildingId: fixture.buildingA.id,
        visitorId: first.id,
        activityType: 'WALK_IN_REGISTERED',
      })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].sourceId, firstVisit.id);
    assert.equal(response.body.data[0].visitorId, first.id);
  });

  it('enforces cross-Client/Building isolation', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const delivery = await createDelivery(fixture);
    assert.equal(delivery.status, 201);

    const managerList = await api()
      .get('/api/v1/front-desk-logs')
      .query({ buildingId: fixture.buildingA.id })
      .set(auth());
    const event = managerList.body.data.find(
      (row: { sourceId: string; activityType: string }) =>
        row.sourceId === delivery.body.data.id &&
        row.activityType === 'DELIVERY_COURIER_ARRIVED',
    );
    assert.ok(event);

    const deniedRead = await api()
      .get(`/api/v1/front-desk-logs/${encodeURIComponent(event.id)}`)
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedRead.status, 403, JSON.stringify(deniedRead.body));
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const scoped = await api()
      .get('/api/v1/front-desk-logs')
      .set(auth(fixture.bAdmin.token));
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.ok(
      !scoped.body.data.some(
        (row: { id: string }) => row.id === event.id,
      ),
    );

    const deniedBuilding = await api()
      .get('/api/v1/front-desk-logs')
      .query({ buildingId: fixture.buildingA.id })
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedBuilding.status, 403);
    assert.equal(deniedBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const plainToken = await createPlainSession();

    const forbidden = await api()
      .get('/api/v1/front-desk-logs')
      .set(auth(plainToken));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/front-desk-logs');
    assert.equal(unauthenticated.status, 401);
  });
});
