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
 * BE-13K — Delivery / Courier focused validation only.
 *
 * Covers Building-only receipt, optional Visitor/Visit reuse, recipient
 * validation, context mismatches, status transition, RBAC and scoped
 * Client / Building isolation. Front Desk Log is outside this test.
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
    name: 'Delivery client A',
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
    name: 'Delivery client B',
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
  label = 'Courier Visitor',
) {
  const visitorResponse = await api()
    .post(`/api/v1/clients/${fixture.clientA.id}/visitors`)
    .set(auth())
    .send({ fullName: `${label} ${suffix()}` });
  assert.equal(visitorResponse.status, 201, JSON.stringify(visitorResponse.body));

  const visitResponse = await api()
    .post('/api/v1/walk-in-visits')
    .set(auth())
    .send({
      buildingId: fixture.buildingA.id,
      visitorId: visitorResponse.body.data.id,
      hostUserId: managerUserId,
      purpose: 'Courier delivery',
    });
  assert.equal(visitResponse.status, 201, JSON.stringify(visitResponse.body));

  return { visitor: visitorResponse.body.data, visit: visitResponse.body.data };
}

async function createBuildingDelivery(
  fixture: Awaited<ReturnType<typeof seed>>,
  overrides: Record<string, unknown> = {},
  token = managerToken,
) {
  return api()
    .post('/api/v1/delivery-couriers')
    .set(auth(token))
    .send({
      buildingId: fixture.buildingA.id,
      deliveryType: 'DELIVERY',
      courierCompany: 'Nusantara Express',
      courierName: 'Courier Agent',
      recipientUserId: managerUserId,
      referenceNumber: `PKG-${suffix()}`,
      notes: 'Package received at security.',
      ...overrides,
    });
}

describe('BE-13K delivery / courier', () => {
  it('creates, gets, and searches a Building delivery with a valid recipient', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();

    const created = await createBuildingDelivery(fixture);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const data = created.body.data;
    assert.equal(data.clientId, fixture.clientA.id);
    assert.equal(data.buildingId, fixture.buildingA.id);
    assert.equal(data.visitorId, null);
    assert.equal(data.walkInVisitId, null);
    assert.equal(data.deliveryType, 'DELIVERY');
    assert.equal(data.courierCompany, 'Nusantara Express');
    assert.equal(data.recipientUserId, managerUserId);
    assert.equal(data.status, 'ARRIVED');
    assert.ok(data.arrivedAt);

    const read = await api()
      .get(`/api/v1/delivery-couriers/${data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.id, data.id);

    const list = await api()
      .get('/api/v1/delivery-couriers')
      .query({
        buildingId: fixture.buildingA.id,
        status: 'ARRIVED',
        search: 'Nusantara',
      })
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(
      list.body.data.map((row: { id: string }) => row.id),
      [data.id],
    );
  });

  it('reuses a valid Visitor/Visit binding and existing Check-In/Check-Out', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture);
    const visitorCount = await pool!.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM visitors',
    );

    const delivery = await createBuildingDelivery(fixture, {
      deliveryType: 'COURIER',
      visitorId: visitor.id,
      walkInVisitId: visit.id,
      courierCompany: 'Document Courier Co',
      referenceNumber: 'DOC-100',
    });
    assert.equal(delivery.status, 201, JSON.stringify(delivery.body));
    assert.equal(delivery.body.data.visitorId, visitor.id);
    assert.equal(delivery.body.data.walkInVisitId, visit.id);
    assert.equal(delivery.body.data.recipientUserId, managerUserId);

    const after = await pool!.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM visitors',
    );
    assert.equal(after.rows[0].count, visitorCount.rows[0].count);

    const checkIn = await api()
      .post('/api/v1/visit-check-ins')
      .set(auth())
      .send({ walkInVisitId: visit.id });
    assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));

    const checkOut = await api()
      .post(`/api/v1/visit-check-ins/${checkIn.body.data.id}/check-out`)
      .set(auth())
      .send({});
    assert.equal(checkOut.status, 200, JSON.stringify(checkOut.body));
    assert.equal(checkOut.body.data.status, 'CHECKED_OUT');
  });

  it('rejects invalid delivery, Visitor, Visit, and recipient contexts', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();

    const missingContext = await api()
      .post('/api/v1/delivery-couriers')
      .set(auth())
      .send({
        deliveryType: 'DELIVERY',
        courierCompany: 'No Context Co',
        recipientName: 'Lobby',
      });
    assert.equal(missingContext.status, 400);
    assert.equal(
      missingContext.body.error.code,
      'DELIVERY_COURIER_CONTEXT_REQUIRED',
    );

    const bothVisits = await createBuildingDelivery(fixture, {
      expectedVisitorId: randomUUID(),
      walkInVisitId: randomUUID(),
    });
    assert.equal(bothVisits.status, 400);
    assert.equal(
      bothVisits.body.error.code,
      'DELIVERY_COURIER_VISIT_REFERENCE_INVALID',
    );

    const unknownVisitor = await createBuildingDelivery(fixture, {
      visitorId: randomUUID(),
    });
    assert.equal(unknownVisitor.status, 404);
    assert.equal(unknownVisitor.body.error.code, 'VISITOR_NOT_FOUND');

    const missingCourier = await createBuildingDelivery(fixture, {
      courierCompany: null,
      courierName: null,
    });
    assert.equal(missingCourier.status, 400);
    assert.equal(
      missingCourier.body.error.code,
      'DELIVERY_COURIER_COURIER_REQUIRED',
    );

    const missingRecipient = await createBuildingDelivery(fixture, {
      recipientUserId: null,
      recipientName: null,
    });
    assert.equal(missingRecipient.status, 400);
    assert.equal(
      missingRecipient.body.error.code,
      'DELIVERY_COURIER_RECIPIENT_REQUIRED',
    );
  });

  it('rejects Building and recipient mismatch', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const { visitor, visit } = await visitorAndVisit(fixture, 'Mismatch Courier');

    const buildingMismatch = await createBuildingDelivery(fixture, {
      buildingId: fixture.buildingB.id,
      visitorId: visitor.id,
      walkInVisitId: visit.id,
    });
    assert.equal(
      buildingMismatch.status,
      400,
      JSON.stringify(buildingMismatch.body),
    );
    assert.equal(
      buildingMismatch.body.error.code,
      'DELIVERY_COURIER_CONTEXT_MISMATCH',
    );

    const recipientMismatch = await createBuildingDelivery(fixture, {
      recipientUserId: fixture.bAdmin.userId,
    });
    assert.equal(
      recipientMismatch.status,
      400,
      JSON.stringify(recipientMismatch.body),
    );
    assert.equal(
      recipientMismatch.body.error.code,
      'DELIVERY_COURIER_RECIPIENT_BUILDING_MISMATCH',
    );
  });

  it('updates ARRIVED status once and preserves status audit', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const delivery = await createBuildingDelivery(fixture, {
      referenceNumber: 'STATUS-100',
    });
    assert.equal(delivery.status, 201);

    const received = await api()
      .patch(`/api/v1/delivery-couriers/${delivery.body.data.id}/status`)
      .set(auth())
      .send({
        status: 'RECEIVED',
        notes: 'Handed to recipient.',
      });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.data.status, 'RECEIVED');
    assert.ok(received.body.data.statusUpdatedAt);
    assert.equal(received.body.data.statusUpdatedByUserId, managerUserId);
    assert.equal(received.body.data.notes, 'Handed to recipient.');

    const duplicate = await api()
      .patch(`/api/v1/delivery-couriers/${delivery.body.data.id}/status`)
      .set(auth())
      .send({ status: 'CANCELLED' });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'DELIVERY_COURIER_INVALID_TRANSITION',
    );
  });

  it('enforces RBAC', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const plainToken = await createPlainSession();

    const forbiddenCreate = await createBuildingDelivery(
      fixture,
      {},
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/delivery-couriers')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/delivery-couriers');
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const fixture = await seed();
    const delivery = await createBuildingDelivery(fixture);
    assert.equal(delivery.status, 201);
    const id = delivery.body.data.id;

    const deniedRead = await api()
      .get(`/api/v1/delivery-couriers/${id}`)
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedRead.status, 403, JSON.stringify(deniedRead.body));
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedUpdate = await api()
      .patch(`/api/v1/delivery-couriers/${id}/status`)
      .set(auth(fixture.bAdmin.token))
      .send({ status: 'RECEIVED' });
    assert.equal(deniedUpdate.status, 403);
    assert.equal(deniedUpdate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedCreate = await createBuildingDelivery(
      fixture,
      { referenceNumber: 'CROSS-CLIENT' },
      fixture.bAdmin.token,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const scopedList = await api()
      .get('/api/v1/delivery-couriers')
      .set(auth(fixture.bAdmin.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    assert.ok(
      !scopedList.body.data.some((row: { id: string }) => row.id === id),
    );

    const deniedBuildingList = await api()
      .get('/api/v1/delivery-couriers')
      .query({ buildingId: fixture.buildingA.id })
      .set(auth(fixture.bAdmin.token));
    assert.equal(deniedBuildingList.status, 403);
    assert.equal(
      deniedBuildingList.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );
  });
});
