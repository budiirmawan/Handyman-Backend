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
 * BE-13D — Walk-In / Guest Book focused validation.
 *
 * Covers:
 *  - walk-in with a NEW visitor registered inline through BE-13A
 *  - walk-in reusing an EXISTING visitor identity
 *  - unknown / cross-client / blocked / inactive visitor rejected
 *  - both / neither visitor references rejected
 *  - duplicate identity document from inline registration → 409 (reuse!)
 *  - one open guest-book entry per (building, visitor)
 *  - Building / host validation, arrival time validation
 *  - update / cancel lifecycle (CANCELLED terminal, re-registration OK)
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
       walk_in_visits, expected_visitors, visitor_invitations, visitors,
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
const pastArrival = () => new Date(Date.now() - 1 * HOUR).toISOString();

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Walk-in client A',
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
    name: 'Walk-in client B',
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
      .send({ fullName: 'Returning Guest' })
  ).body.data;

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
    buildingA2,
    buildingB,
    visitor,
    visitorB,
    hostWorker,
    hostWorkerB,
    bAdmin,
  };
}

async function createWalkIn(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api().post('/api/v1/walk-in-visits').set(auth(token)).send(body);
}

describe('BE-13D walk-in / guest book', () => {
  it('registers a walk-in with a NEW visitor through BE-13A', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const idNumber = `3172${suffix()}`;
    const response = await createWalkIn({
      buildingId: f.buildingA.id,
      newVisitor: {
        fullName: 'Unannounced Guest',
        identityType: 'NATIONAL_ID',
        identityNumber: idNumber,
        phone: '+62 812 000 1111',
        organizationName: 'PT Dadakan',
      },
      hostName: 'Mr Host — 5th floor',
      purpose: 'Deliver documents',
      frontDeskNotes: 'No appointment; host phoned down.',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.buildingId, f.buildingA.id);
    assert.ok(data.visitorId);
    assert.equal(data.hostName, 'Mr Host — 5th floor');
    assert.equal(data.purpose, 'Deliver documents');
    assert.equal(data.frontDeskNotes, 'No appointment; host phoned down.');
    assert.equal(data.status, 'REGISTERED');
    assert.ok(data.arrivedAt);
    assert.equal(data.createdByUserId, managerUserId);

    // The inline registration created a REAL BE-13A identity (single
    // shared master, not a private copy).
    const visitorRead = await api()
      .get(`/api/v1/visitors/${data.visitorId}`)
      .set(auth());
    assert.equal(visitorRead.status, 200);
    assert.equal(visitorRead.body.data.fullName, 'Unannounced Guest');
    assert.equal(visitorRead.body.data.identityNumber, idNumber);
    assert.equal(visitorRead.body.data.clientId, f.clientA.id);

    // Guest-book entry itself carries no PII fields.
    const allowedKeys = new Set([
      'id',
      'clientId',
      'buildingId',
      'visitorId',
      'hostUserId',
      'hostWorkforceId',
      'hostName',
      'purpose',
      'arrivedAt',
      'frontDeskNotes',
      'status',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ]);
    for (const key of Object.keys(data)) {
      assert.ok(allowedKeys.has(key), `unexpected public field: ${key}`);
    }
  });

  it('registers a walk-in reusing an EXISTING visitor identity', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const arrivedAt = pastArrival();
    const response = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostUserId: managerUserId,
      hostWorkforceId: f.hostWorker.id,
      purpose: 'Repeat visit',
      arrivedAt,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.visitorId, f.visitor.id);
    assert.equal(response.body.data.hostUserId, managerUserId);
    assert.equal(response.body.data.hostWorkforceId, f.hostWorker.id);
    assert.equal(response.body.data.arrivedAt, arrivedAt);

    // A walk-in also works with NO host context at all.
    const second = (
      await api()
        .post(`/api/v1/clients/${f.clientA.id}/visitors`)
        .set(auth())
        .send({ fullName: 'Hostless Guest' })
    ).body.data;
    const hostless = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: second.id,
      purpose: 'Looking for information',
    });
    assert.equal(hostless.status, 201, JSON.stringify(hostless.body));
    assert.equal(hostless.body.data.hostUserId, null);
    assert.equal(hostless.body.data.hostWorkforceId, null);
    assert.equal(hostless.body.data.hostName, null);
  });

  it('rejects invalid visitor references', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Neither reference.
    const neither = await createWalkIn({
      buildingId: f.buildingA.id,
      purpose: 'Meeting',
    });
    assert.equal(neither.status, 400);
    assert.equal(
      neither.body.error.code,
      'WALK_IN_VISIT_VISITOR_REFERENCE_REQUIRED',
    );

    // Both references.
    const both = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      newVisitor: { fullName: 'Duplicate Ref' },
      purpose: 'Meeting',
    });
    assert.equal(both.status, 400);
    assert.equal(
      both.body.error.code,
      'WALK_IN_VISIT_VISITOR_REFERENCE_REQUIRED',
    );

    // Unknown visitor.
    const unknown = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: randomUUID(),
      purpose: 'Meeting',
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'VISITOR_NOT_FOUND');

    // Cross-client visitor.
    const crossClient = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitorB.id,
      purpose: 'Meeting',
    });
    assert.equal(crossClient.status, 400);
    assert.equal(
      crossClient.body.error.code,
      'WALK_IN_VISIT_VISITOR_CLIENT_MISMATCH',
    );

    // BLOCKED visitor.
    const blocked = (
      await api()
        .post(`/api/v1/clients/${f.clientA.id}/visitors`)
        .set(auth())
        .send({ fullName: 'Banned Guest' })
    ).body.data;
    await api()
      .patch(`/api/v1/visitors/${blocked.id}`)
      .set(auth())
      .send({ status: 'BLOCKED' });
    const blockedRes = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: blocked.id,
      purpose: 'Meeting',
    });
    assert.equal(blockedRes.status, 400);
    assert.equal(blockedRes.body.error.code, 'WALK_IN_VISIT_VISITOR_BLOCKED');

    // INACTIVE visitor.
    const inactive = (
      await api()
        .post(`/api/v1/clients/${f.clientA.id}/visitors`)
        .set(auth())
        .send({ fullName: 'Dormant Guest' })
    ).body.data;
    await api()
      .patch(`/api/v1/visitors/${inactive.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    const inactiveRes = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: inactive.id,
      purpose: 'Meeting',
    });
    assert.equal(inactiveRes.status, 400);
    assert.equal(
      inactiveRes.body.error.code,
      'WALK_IN_VISIT_VISITOR_INACTIVE',
    );
  });

  it('routes duplicate identity documents through BE-13A (reuse, not copy)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const idNumber = `3173${suffix()}`;
    const first = await createWalkIn({
      buildingId: f.buildingA.id,
      newVisitor: {
        fullName: 'Original Holder',
        identityType: 'NATIONAL_ID',
        identityNumber: idNumber,
      },
      purpose: 'First visit',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // Registering the same document again is rejected by the shared
    // BE-13A duplicate rule — the front desk must reuse the match.
    const dup = await createWalkIn({
      buildingId: f.buildingA2.id,
      newVisitor: {
        fullName: 'Same Person Again',
        identityType: 'NATIONAL_ID',
        identityNumber: idNumber,
      },
      purpose: 'Second visit',
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(dup.body.error.code, 'VISITOR_IDENTITY_ALREADY_EXISTS');

    // The correct flow: search BE-13A by document, reuse the identity.
    const search = await api()
      .get(
        `/api/v1/clients/${f.clientA.id}/visitors?identityType=NATIONAL_ID&identityNumber=${idNumber}`,
      )
      .set(auth());
    assert.equal(search.status, 200);
    assert.equal(search.body.data.length, 1);
    const matched = search.body.data[0];

    const reused = await createWalkIn({
      buildingId: f.buildingA2.id,
      visitorId: matched.id,
      purpose: 'Second visit (reused identity)',
    });
    assert.equal(reused.status, 201, JSON.stringify(reused.body));
    assert.equal(reused.body.data.visitorId, first.body.data.visitorId);
  });

  it('allows only one open guest-book entry per building and visitor', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Open entry',
    });
    assert.equal(first.status, 201);

    // A second open entry in the SAME building is rejected.
    const dup = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Duplicate open entry',
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(dup.body.error.code, 'WALK_IN_VISIT_ALREADY_REGISTERED');

    // A DIFFERENT building is fine.
    const otherBuilding = await createWalkIn({
      buildingId: f.buildingA2.id,
      visitorId: f.visitor.id,
      purpose: 'Other building entry',
    });
    assert.equal(otherBuilding.status, 201);

    // After cancelling, re-registration in the same building works.
    await api()
      .post(`/api/v1/walk-in-visits/${first.body.data.id}/cancel`)
      .set(auth());
    const again = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Back again',
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
  });

  it('validates building, host and arrival time', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Unknown building.
    const unknownBuilding = await createWalkIn({
      buildingId: randomUUID(),
      visitorId: f.visitor.id,
      purpose: 'Meeting',
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');

    // Unknown host user.
    const unknownHost = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostUserId: randomUUID(),
      purpose: 'Meeting',
    });
    assert.equal(unknownHost.status, 404);
    assert.equal(unknownHost.body.error.code, 'USER_NOT_FOUND');

    // Cross-client host workforce.
    const crossHost = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostWorkforceId: f.hostWorkerB.id,
      purpose: 'Meeting',
    });
    assert.equal(crossHost.status, 400);
    assert.equal(
      crossHost.body.error.code,
      'WALK_IN_VISIT_HOST_WORKFORCE_MISMATCH',
    );

    // INACTIVE host workforce.
    await workforceService.updateWorkforceProfile(f.hostWorker.id, {
      status: 'INACTIVE',
    });
    const inactiveHost = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostWorkforceId: f.hostWorker.id,
      purpose: 'Meeting',
    });
    assert.equal(inactiveHost.status, 400);
    assert.equal(
      inactiveHost.body.error.code,
      'WALK_IN_VISIT_HOST_WORKFORCE_INACTIVE',
    );

    // Future arrival rejected.
    const future = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Meeting',
      arrivedAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    assert.equal(future.status, 400, JSON.stringify(future.body));
    assert.equal(future.body.error.code, 'WALK_IN_VISIT_ARRIVAL_IN_FUTURE');

    // Malformed arrival rejected.
    const malformed = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Meeting',
      arrivedAt: 'just now',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });

  it('gets, lists and filters guest-book entries', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      hostUserId: managerUserId,
      purpose: 'Guest book one',
      arrivedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
    });
    assert.equal(first.status, 201);
    const second = await createWalkIn({
      buildingId: f.buildingA2.id,
      visitorId: f.visitor.id,
      purpose: 'Guest book two',
    });
    assert.equal(second.status, 201);

    // Get by id.
    const read = await api()
      .get(`/api/v1/walk-in-visits/${first.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.purpose, 'Guest book one');

    const missing = await api()
      .get(`/api/v1/walk-in-visits/${randomUUID()}`)
      .set(auth());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'WALK_IN_VISIT_NOT_FOUND');

    // Unfiltered list spans accessible buildings.
    const listAll = await api().get('/api/v1/walk-in-visits').set(auth());
    assert.equal(listAll.status, 200);
    const ids = listAll.body.data.map((x: { id: string }) => x.id);
    assert.ok(ids.includes(first.body.data.id));
    assert.ok(ids.includes(second.body.data.id));

    // Building filter.
    const byBuilding = await api()
      .get(`/api/v1/walk-in-visits?buildingId=${f.buildingA.id}`)
      .set(auth());
    assert.equal(byBuilding.status, 200);
    assert.ok(
      byBuilding.body.data.every(
        (x: { buildingId: string }) => x.buildingId === f.buildingA.id,
      ),
    );

    // Visitor filter.
    const byVisitor = await api()
      .get(`/api/v1/walk-in-visits?visitorId=${f.visitor.id}`)
      .set(auth());
    assert.equal(byVisitor.status, 200);
    assert.ok(byVisitor.body.data.length >= 2);

    // Arrival window filter: only the recent entry.
    const windowed = await api()
      .get(
        `/api/v1/walk-in-visits?arrivedFrom=${encodeURIComponent(
          new Date(Date.now() - 2 * HOUR).toISOString(),
        )}`,
      )
      .set(auth());
    assert.equal(windowed.status, 200);
    const windowedIds = windowed.body.data.map((x: { id: string }) => x.id);
    assert.ok(windowedIds.includes(second.body.data.id));
    assert.ok(!windowedIds.includes(first.body.data.id));
  });

  it('updates and cancels a guest-book entry (CANCELLED is terminal)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Original purpose',
    });
    assert.equal(created.status, 201);
    const id = created.body.data.id;

    // Attach the host once identified + amend notes.
    const updated = await api()
      .patch(`/api/v1/walk-in-visits/${id}`)
      .set(auth())
      .send({
        hostUserId: managerUserId,
        hostName: 'Identified host',
        purpose: 'Confirmed purpose',
        frontDeskNotes: 'Host came down to receive the guest.',
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.hostUserId, managerUserId);
    assert.equal(updated.body.data.purpose, 'Confirmed purpose');
    assert.equal(updated.body.data.status, 'REGISTERED');

    // Cancel.
    const cancelled = await api()
      .post(`/api/v1/walk-in-visits/${id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');

    // Terminal.
    const cancelTwice = await api()
      .post(`/api/v1/walk-in-visits/${id}/cancel`)
      .set(auth());
    assert.equal(cancelTwice.status, 409);
    assert.equal(
      cancelTwice.body.error.code,
      'WALK_IN_VISIT_ALREADY_CANCELLED',
    );

    const afterCancel = await api()
      .patch(`/api/v1/walk-in-visits/${id}`)
      .set(auth())
      .send({ purpose: 'Should not apply' });
    assert.equal(afterCancel.status, 409);
    assert.equal(
      afterCancel.body.error.code,
      'WALK_IN_VISIT_ALREADY_CANCELLED',
    );

    // Status filter sees the cancelled entry.
    const cancelledList = await api()
      .get('/api/v1/walk-in-visits?status=CANCELLED')
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
    const noPurpose = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
    });
    assert.equal(noPurpose.status, 400);
    assert.equal(noPurpose.body.error.code, 'VALIDATION_ERROR');

    // Bad new-visitor payload (missing fullName).
    const badNew = await createWalkIn({
      buildingId: f.buildingA.id,
      newVisitor: { identityType: 'PASSPORT' },
      purpose: 'Meeting',
    });
    assert.equal(badNew.status, 400);
    assert.equal(badNew.body.error.code, 'VALIDATION_ERROR');

    // Bad new-visitor email.
    const badEmail = await createWalkIn({
      buildingId: f.buildingA.id,
      newVisitor: { fullName: 'Bad Email', email: 'nope' },
      purpose: 'Meeting',
    });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.error.code, 'VALIDATION_ERROR');

    // Empty update payload.
    const created = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Meeting',
    });
    assert.equal(created.status, 201);
    const emptyUpdate = await api()
      .patch(`/api/v1/walk-in-visits/${created.body.data.id}`)
      .set(auth())
      .send({});
    assert.equal(emptyUpdate.status, 400);
    assert.equal(emptyUpdate.body.error.code, 'VALIDATION_ERROR');

    // Invalid status filter.
    const badStatus = await api()
      .get('/api/v1/walk-in-visits?status=CHECKED_IN')
      .set(auth());
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const plainToken = await createPlainSession();

    const forbiddenCreate = await createWalkIn(
      {
        buildingId: f.buildingA.id,
        visitorId: f.visitor.id,
        purpose: 'Meeting',
      },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/walk-in-visits')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Meeting',
    });
    assert.equal(created.status, 201);

    const forbiddenRead = await api()
      .get(`/api/v1/walk-in-visits/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenPatch = await api()
      .patch(`/api/v1/walk-in-visits/${created.body.data.id}`)
      .set(auth(plainToken))
      .send({ purpose: 'Forbidden' });
    assert.equal(forbiddenPatch.status, 403);
    assert.equal(forbiddenPatch.body.error.code, 'PERMISSION_DENIED');

    const forbiddenCancel = await api()
      .post(`/api/v1/walk-in-visits/${created.body.data.id}/cancel`)
      .set(auth(plainToken));
    assert.equal(forbiddenCancel.status, 403);
    assert.equal(forbiddenCancel.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get('/api/v1/walk-in-visits');
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client / Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Creating for an inaccessible building is denied.
    const denied = await createWalkIn({
      buildingId: f.buildingB.id,
      visitorId: f.visitorB.id,
      purpose: 'Meeting',
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const created = await createWalkIn({
      buildingId: f.buildingA.id,
      visitorId: f.visitor.id,
      purpose: 'Isolated entry',
    });
    assert.equal(created.status, 201);

    const deniedRead = await api()
      .get(`/api/v1/walk-in-visits/${created.body.data.id}`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedPatch = await api()
      .patch(`/api/v1/walk-in-visits/${created.body.data.id}`)
      .set(auth(f.bAdmin.token))
      .send({ purpose: 'Should fail' });
    assert.equal(deniedPatch.status, 403);
    assert.equal(deniedPatch.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedCancel = await api()
      .post(`/api/v1/walk-in-visits/${created.body.data.id}/cancel`)
      .set(auth(f.bAdmin.token));
    assert.equal(deniedCancel.status, 403);
    assert.equal(deniedCancel.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get(`/api/v1/walk-in-visits?buildingId=${f.buildingB.id}`)
      .set(auth());
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Unfiltered list is scoped to accessible buildings.
    const scoped = await api()
      .get('/api/v1/walk-in-visits')
      .set(auth(f.bAdmin.token));
    assert.equal(scoped.status, 200);
    const ids = scoped.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(created.body.data.id));
  });
});
