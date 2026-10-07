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
 * BE-13A — Visitor Identity / Registration focused validation.
 *
 * Covers:
 *  - create / get / update / list / search
 *  - duplicate identity document handling (per-Client uniqueness)
 *  - identity number requires a concrete identity type
 *  - invalid input rejection
 *  - RBAC (visitor.read / visitor.manage)
 *  - Client isolation (visitor identity is a Client-scoped master)
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
       visitors,
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
    name: 'Visitor client A',
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
    name: 'Visitor client B',
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

  return { clientA, buildingA, clientB, buildingB };
}

async function createVisitor(
  clientId: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/clients/${clientId}/visitors`)
    .set(auth(token))
    .send(body);
}

describe('BE-13A visitor identity / registration', () => {
  it('registers a visitor identity with full profile', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createVisitor(f.clientA.id, {
      fullName: 'Andi Wijaya',
      identityType: 'NATIONAL_ID',
      identityNumber: `3174${suffix()}`,
      phone: '+62 812-3456-7890',
      email: 'Andi.Wijaya@Example.com',
      organizationName: 'PT Sumber Makmur',
      notes: 'Regular meeting guest.',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.fullName, 'Andi Wijaya');
    assert.equal(data.identityType, 'NATIONAL_ID');
    assert.ok(data.identityNumber.startsWith('3174'));
    assert.equal(data.phone, '+62 812-3456-7890');
    // Emails are normalized to lowercase.
    assert.equal(data.email, 'andi.wijaya@example.com');
    assert.equal(data.organizationName, 'PT Sumber Makmur');
    assert.equal(data.notes, 'Regular meeting guest.');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.createdByUserId, managerUserId);
    assert.ok(data.createdAt);
    assert.ok(data.updatedAt);

    // The public shape only carries the documented minimal identity
    // fields — no sensitive extras.
    const allowedKeys = new Set([
      'id',
      'clientId',
      'fullName',
      'identityType',
      'identityNumber',
      'phone',
      'email',
      'organizationName',
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

  it('registers a minimal walk-in style visitor (name only)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createVisitor(f.clientA.id, {
      fullName: 'Siti Rahma',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.fullName, 'Siti Rahma');
    assert.equal(data.identityType, 'NONE');
    assert.equal(data.identityNumber, null);
    assert.equal(data.phone, null);
    assert.equal(data.email, null);
    assert.equal(data.status, 'ACTIVE');
  });

  it('gets a visitor by id', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createVisitor(f.clientA.id, {
      fullName: 'Budi Santoso',
      identityType: 'PASSPORT',
      identityNumber: `PA${suffix()}`,
    });
    assert.equal(created.status, 201);

    const read = await api()
      .get(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.id, created.body.data.id);
    assert.equal(read.body.data.fullName, 'Budi Santoso');

    const missing = await api()
      .get(`/api/v1/visitors/${randomUUID()}`)
      .set(auth());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'VISITOR_NOT_FOUND');
  });

  it('updates a visitor identity', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createVisitor(f.clientA.id, {
      fullName: 'Dewi Lestari',
    });
    assert.equal(created.status, 201);

    const updated = await api()
      .patch(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth())
      .send({
        fullName: 'Dewi Lestari Putri',
        identityType: 'DRIVER_LICENSE',
        identityNumber: `DL${suffix()}`,
        phone: '+62 811 1111 222',
        organizationName: 'CV Maju Jaya',
        status: 'INACTIVE',
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.fullName, 'Dewi Lestari Putri');
    assert.equal(updated.body.data.identityType, 'DRIVER_LICENSE');
    assert.ok(updated.body.data.identityNumber.startsWith('DL'));
    assert.equal(updated.body.data.status, 'INACTIVE');

    // Clearing an identity number back to null is allowed.
    const cleared = await api()
      .patch(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth())
      .send({ identityNumber: null, identityType: 'NONE' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.data.identityNumber, null);
    assert.equal(cleared.body.data.identityType, 'NONE');
  });

  it('supports BLOCKED status for banned visitors', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createVisitor(f.clientA.id, {
      fullName: 'Blocked Guest',
    });
    assert.equal(created.status, 201);

    const blocked = await api()
      .patch(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth())
      .send({ status: 'BLOCKED' });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal(blocked.body.data.status, 'BLOCKED');
  });

  it('lists and searches visitors within a client', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const idNumber = `3299${suffix()}`;
    await createVisitor(f.clientA.id, {
      fullName: 'Rizky Pratama',
      identityType: 'NATIONAL_ID',
      identityNumber: idNumber,
      phone: '+62 813 999 0001',
      email: `rizky-${suffix().toLowerCase()}@example.com`,
    });
    await createVisitor(f.clientA.id, {
      fullName: 'Maria Fernanda',
      organizationName: 'Courier Express',
    });

    const listAll = await api()
      .get(`/api/v1/clients/${f.clientA.id}/visitors`)
      .set(auth());
    assert.equal(listAll.status, 200, JSON.stringify(listAll.body));
    assert.ok(listAll.body.data.length >= 2);

    // Case-insensitive substring search on the full name.
    const search = await api()
      .get(`/api/v1/clients/${f.clientA.id}/visitors?search=rizky`)
      .set(auth());
    assert.equal(search.status, 200);
    assert.equal(search.body.data.length, 1);
    assert.equal(search.body.data[0].fullName, 'Rizky Pratama');

    // Exact identity number lookup (front-desk fast path).
    const byIdentity = await api()
      .get(
        `/api/v1/clients/${f.clientA.id}/visitors?identityType=NATIONAL_ID&identityNumber=${idNumber}`,
      )
      .set(auth());
    assert.equal(byIdentity.status, 200);
    assert.equal(byIdentity.body.data.length, 1);
    assert.equal(byIdentity.body.data[0].identityNumber, idNumber);

    // Phone lookup.
    const byPhone = await api()
      .get(
        `/api/v1/clients/${f.clientA.id}/visitors?phone=${encodeURIComponent('+62 813 999 0001')}`,
      )
      .set(auth());
    assert.equal(byPhone.status, 200);
    assert.equal(byPhone.body.data.length, 1);

    // Status filter.
    const active = await api()
      .get(`/api/v1/clients/${f.clientA.id}/visitors?status=ACTIVE`)
      .set(auth());
    assert.equal(active.status, 200);
    assert.ok(
      active.body.data.every((v: { status: string }) => v.status === 'ACTIVE'),
    );
  });

  it('rejects a duplicate identity document within the same client', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const idNumber = `3171${suffix()}`;
    const first = await createVisitor(f.clientA.id, {
      fullName: 'First Holder',
      identityType: 'NATIONAL_ID',
      identityNumber: idNumber,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await createVisitor(f.clientA.id, {
      fullName: 'Second Holder',
      identityType: 'NATIONAL_ID',
      identityNumber: idNumber,
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      duplicate.body.error.code,
      'VISITOR_IDENTITY_ALREADY_EXISTS',
    );

    // Same number under a DIFFERENT identity type is a different
    // document — allowed.
    const differentType = await createVisitor(f.clientA.id, {
      fullName: 'Passport Holder',
      identityType: 'PASSPORT',
      identityNumber: idNumber,
    });
    assert.equal(differentType.status, 201, JSON.stringify(differentType.body));

    // Updating another visitor onto an existing document is rejected.
    const other = await createVisitor(f.clientA.id, {
      fullName: 'Third Holder',
    });
    assert.equal(other.status, 201);
    const collide = await api()
      .patch(`/api/v1/visitors/${other.body.data.id}`)
      .set(auth())
      .send({ identityType: 'NATIONAL_ID', identityNumber: idNumber });
    assert.equal(collide.status, 409, JSON.stringify(collide.body));
    assert.equal(collide.body.error.code, 'VISITOR_IDENTITY_ALREADY_EXISTS');
  });

  it('rejects an identity number without a concrete identity type', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createVisitor(f.clientA.id, {
      fullName: 'No Type Guest',
      identityNumber: `X${suffix()}`,
    });
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(
      created.body.error.code,
      'VISITOR_IDENTITY_NUMBER_REQUIRES_TYPE',
    );

    const explicitNone = await createVisitor(f.clientA.id, {
      fullName: 'None Type Guest',
      identityType: 'NONE',
      identityNumber: `Y${suffix()}`,
    });
    assert.equal(explicitNone.status, 400);
    assert.equal(
      explicitNone.body.error.code,
      'VISITOR_IDENTITY_NUMBER_REQUIRES_TYPE',
    );
  });

  it('rejects invalid input', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Missing full name.
    const noName = await createVisitor(f.clientA.id, {});
    assert.equal(noName.status, 400);
    assert.equal(noName.body.error.code, 'VALIDATION_ERROR');

    // Invalid identity type.
    const badType = await createVisitor(f.clientA.id, {
      fullName: 'Bad Type',
      identityType: 'ALIEN_CARD',
    });
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'VALIDATION_ERROR');

    // Invalid email.
    const badEmail = await createVisitor(f.clientA.id, {
      fullName: 'Bad Email',
      email: 'not-an-email',
    });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.error.code, 'VALIDATION_ERROR');

    // Invalid phone.
    const badPhone = await createVisitor(f.clientA.id, {
      fullName: 'Bad Phone',
      phone: 'call-me-maybe',
    });
    assert.equal(badPhone.status, 400);
    assert.equal(badPhone.body.error.code, 'VALIDATION_ERROR');

    // Invalid status.
    const badStatus = await createVisitor(f.clientA.id, {
      fullName: 'Bad Status',
      status: 'BANNED',
    });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');

    // Malformed client id.
    const badClient = await api()
      .post('/api/v1/clients/not-a-uuid/visitors')
      .set(auth())
      .send({ fullName: 'Bad Client' });
    assert.equal(badClient.status, 400);
    assert.equal(badClient.body.error.code, 'VALIDATION_ERROR');

    // Empty update payload.
    const created = await createVisitor(f.clientA.id, {
      fullName: 'Update Target',
    });
    assert.equal(created.status, 201);
    const emptyUpdate = await api()
      .patch(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth())
      .send({});
    assert.equal(emptyUpdate.status, 400);
    assert.equal(emptyUpdate.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();
    const plainToken = await createPlainSession();

    const forbiddenCreate = await createVisitor(
      f.clientA.id,
      { fullName: 'Forbidden Guest' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get(`/api/v1/clients/${f.clientA.id}/visitors`)
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await createVisitor(f.clientA.id, {
      fullName: 'RBAC Guest',
    });
    assert.equal(created.status, 201);

    const forbiddenRead = await api()
      .get(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenPatch = await api()
      .patch(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth(plainToken))
      .send({ fullName: 'Forbidden Update' });
    assert.equal(forbiddenPatch.status, 403);
    assert.equal(forbiddenPatch.body.error.code, 'PERMISSION_DENIED');

    const unauthenticated = await api().get(
      `/api/v1/clients/${f.clientA.id}/visitors`,
    );
    assert.equal(unauthenticated.status, 401);
  });

  it('enforces Client isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // The manager has NO building assignment under client B.
    const deniedCreate = await createVisitor(f.clientB.id, {
      fullName: 'Cross Client Guest',
    });
    assert.equal(deniedCreate.status, 403, JSON.stringify(deniedCreate.body));
    assert.equal(deniedCreate.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedList = await api()
      .get(`/api/v1/clients/${f.clientB.id}/visitors`)
      .set(auth());
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'BUILDING_ACCESS_DENIED');

    // A user assigned only to client B cannot read or patch a
    // client-A visitor.
    const created = await createVisitor(f.clientA.id, {
      fullName: 'Isolated Guest',
    });
    assert.equal(created.status, 201);

    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedRead = await api()
      .get(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedPatch = await api()
      .patch(`/api/v1/visitors/${created.body.data.id}`)
      .set(auth(bOnly.token))
      .send({ fullName: 'Should Fail' });
    assert.equal(deniedPatch.status, 403);
    assert.equal(deniedPatch.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Unknown clients are denied identically (no existence leak).
    const unknownClient = await api()
      .get(`/api/v1/clients/${randomUUID()}/visitors`)
      .set(auth());
    assert.equal(unknownClient.status, 403);
    assert.equal(unknownClient.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The same identity document CAN exist under two different
    // clients — the uniqueness boundary is per Client.
    const sharedNumber = `3175${suffix()}`;
    const inA = await createVisitor(f.clientA.id, {
      fullName: 'Shared Document A',
      identityType: 'NATIONAL_ID',
      identityNumber: sharedNumber,
    });
    assert.equal(inA.status, 201, JSON.stringify(inA.body));

    const bAdmin = await createAdminUser();
    await buildingAssignmentService.createAssignment(bAdmin.userId, {
      buildingId: f.buildingB.id,
    });
    const inB = await createVisitor(
      f.clientB.id,
      {
        fullName: 'Shared Document B',
        identityType: 'NATIONAL_ID',
        identityNumber: sharedNumber,
      },
      bAdmin.token,
    );
    assert.equal(inB.status, 201, JSON.stringify(inB.body));
  });
});
