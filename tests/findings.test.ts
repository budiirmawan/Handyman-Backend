import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { findingService } from '../src/modules/findings';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE findings, users, roles, clients, properties, buildings CASCADE');
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

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function auth(token = adminToken) {
  return { Authorization: `Bearer ${token}` };
}

async function fixture(assignUserId: string | null = adminUserId) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({ code: `C_${suffix}`, name: 'Client' });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix}`,
    name: 'Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, { buildingId: building.id });
  }
  return { client, building };
}

async function createVia(
  buildingId: string,
  clientId: string,
  values: Record<string, unknown> = {},
  token = adminToken,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/findings`)
    .set(auth(token))
    .send({
      clientId,
      findingNumber: `FND_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Operational finding',
      description: 'Observed during operation.',
      ...values,
    });
}

describe('BE-09A finding foundation', () => {
  it('creates a generic OPEN finding with the authenticated reporter', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const response = await createVia(building.id, client.id, {
      findingNumber: ' fnd-create-01 ',
      title: '  Water leak  ',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.findingNumber, 'FND-CREATE-01');
    assert.equal(response.body.data.title, 'Water leak');
    assert.equal(response.body.data.status, 'OPEN');
    assert.equal(response.body.data.reportedByUserId, adminUserId);
    assert.ok(response.body.data.reportedAt);
  });

  it('rejects missing required fields and duplicate numbers in a client', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const invalid = await api()
      .post(`/api/v1/buildings/${building.id}/findings`)
      .set(auth())
      .send({ clientId: client.id });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

    assert.equal((await createVia(building.id, client.id, { findingNumber: 'FND-DUP-01' })).status, 201);
    const duplicate = await createVia(building.id, client.id, { findingNumber: 'FND-DUP-01' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'FINDING_NUMBER_ALREADY_EXISTS');
  });

  it('allows the same finding number in another client', async (t) => {
    if (!ready(t)) return;
    const a = await fixture();
    const b = await fixture();
    assert.equal((await createVia(a.building.id, a.client.id, { findingNumber: 'FND-SHARED' })).status, 201);
    assert.equal((await createVia(b.building.id, b.client.id, { findingNumber: 'FND-SHARED' })).status, 201);
  });

  it('validates unknown building, client/building mismatch, and reporter', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    await assert.rejects(
      findingService.createFinding({
        clientId: client.id,
        buildingId: randomUUID(),
        findingNumber: 'FND-NO-BUILDING',
        title: 'Unknown building',
        reportedByUserId: adminUserId,
      }),
      { code: 'BUILDING_NOT_FOUND' },
    );

    const foreign = await clientService.createClient({
      code: `FOREIGN_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Foreign',
    });
    await assert.rejects(
      findingService.createFinding({
        clientId: foreign.id,
        buildingId: building.id,
        findingNumber: 'FND-MISMATCH',
        title: 'Mismatch',
        reportedByUserId: adminUserId,
      }),
      { code: 'FINDING_BUILDING_CLIENT_MISMATCH' },
    );
    await assert.rejects(
      findingService.createFinding({
        clientId: client.id,
        buildingId: building.id,
        findingNumber: 'FND-NO-REPORTER',
        title: 'No reporter',
        reportedByUserId: randomUUID(),
      }),
      { code: 'USER_NOT_FOUND' },
    );
  });

  it('gets a finding and lists/filter findings by building and status', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const open = await createVia(building.id, client.id, { findingNumber: 'FND-LIST-OPEN' });
    const cancelled = await createVia(building.id, client.id, { findingNumber: 'FND-LIST-CANCEL' });
    await api().post(`/api/v1/findings/${cancelled.body.data.id}/cancel`).set(auth());

    const get = await api().get(`/api/v1/findings/${open.body.data.id}`).set(auth());
    assert.equal(get.status, 200);
    assert.equal(get.body.data.findingNumber, 'FND-LIST-OPEN');

    const all = await api().get(`/api/v1/buildings/${building.id}/findings`).set(auth());
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);
    const filtered = await api()
      .get(`/api/v1/buildings/${building.id}/findings?status=CANCELLED`)
      .set(auth());
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].status, 'CANCELLED');
  });

  it('updates basic metadata only while OPEN', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const created = await createVia(building.id, client.id);
    const response = await api()
      .patch(`/api/v1/findings/${created.body.data.id}`)
      .set(auth())
      .send({ title: 'Updated finding', description: null });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.title, 'Updated finding');
    assert.equal(response.body.data.description, null);
    assert.equal(response.body.data.findingNumber, created.body.data.findingNumber);
  });

  it('cancels and protects a cancelled finding from update or repeat cancellation', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const created = await createVia(building.id, client.id);
    const cancelled = await api()
      .post(`/api/v1/findings/${created.body.data.id}/cancel`)
      .set(auth());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');

    const update = await api()
      .patch(`/api/v1/findings/${created.body.data.id}`)
      .set(auth())
      .send({ title: 'Forbidden change' });
    assert.equal(update.status, 400);
    assert.equal(update.body.error.code, 'FINDING_NOT_OPEN');
    const repeated = await api()
      .post(`/api/v1/findings/${created.body.data.id}/cancel`)
      .set(auth());
    assert.equal(repeated.status, 403);
    assert.equal(repeated.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('enforces authentication and finding RBAC', async (t) => {
    if (!ready(t)) return;
    const { building } = await fixture();
    assert.equal((await api().get(`/api/v1/buildings/${building.id}/findings`)).status, 401);
    const plain = await createPlainSession();
    const denied = await api()
      .get(`/api/v1/buildings/${building.id}/findings`)
      .set(auth(plain));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });

  it('rejects cross-client and cross-building record access', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser();
    const target = await fixture(owner.userId);
    const created = await createVia(
      target.building.id,
      target.client.id,
      { findingNumber: 'FND-ISOLATED' },
      owner.token,
    );
    assert.equal(created.status, 201);

    const crossClient = await api()
      .get(`/api/v1/findings/${created.body.data.id}`)
      .set(auth());
    assert.equal(crossClient.status, 403);
    assert.equal(crossClient.body.error.code, 'BUILDING_ACCESS_DENIED');

    const sameClientProperty = await propertyService.createProperty({
      clientId: target.client.id,
      code: `P_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Second property',
    });
    const secondBuilding = await buildingService.createBuilding({
      propertyId: sameClientProperty.id,
      code: `B_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Second building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: secondBuilding.id,
    });
    const crossBuilding = await api()
      .patch(`/api/v1/findings/${created.body.data.id}`)
      .set(auth())
      .send({ title: 'Not allowed' });
    assert.equal(crossBuilding.status, 403);
    assert.equal(crossBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
