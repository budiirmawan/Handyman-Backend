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

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE findings, finding_classifications, finding_severities, users, roles, clients CASCADE');
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; });
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('test database unavailable'); return false; }
  return true;
}
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

async function fixture(assignTo: string | null = userId) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({ code: `C_${suffix}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix}`, name: 'Building' });
  if (assignTo) await buildingAssignmentService.createAssignment(assignTo, { buildingId: building.id });
  return { client, building };
}
async function classification(clientId: string, code = `CLS_${randomUUID().slice(0, 6)}`, value = token) {
  return api().post(`/api/v1/clients/${clientId}/finding-classifications`).set(auth(value)).send({ code, name: `${code} name`, description: 'Generic classification' });
}
async function severity(clientId: string, code = `SEV_${randomUUID().slice(0, 6)}`, rank = 1, value = token) {
  return api().post(`/api/v1/clients/${clientId}/finding-severities`).set(auth(value)).send({ code, name: `${code} name`, rank, description: 'Generic severity' });
}
async function finding(buildingId: string, clientId: string, value = token) {
  return api().post(`/api/v1/buildings/${buildingId}/findings`).set(auth(value)).send({ clientId, findingNumber: `FND_${randomUUID().slice(0, 8)}`, title: 'Finding' });
}

describe('BE-09B finding classification and severity', () => {
  it('creates, gets, lists, and updates a classification', async (t) => {
    if (!ready(t)) return;
    const { client } = await fixture();
    const created = await classification(client.id, 'SAFETY');
    assert.equal(created.status, 201);
    assert.equal(created.body.data.code, 'SAFETY');
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.ok(created.body.data.createdAt);

    const got = await api().get(`/api/v1/finding-classifications/${created.body.data.id}`).set(auth());
    assert.equal(got.status, 200);
    const listed = await api().get(`/api/v1/clients/${client.id}/finding-classifications`).set(auth());
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.length, 1);
    const updated = await api().patch(`/api/v1/finding-classifications/${created.body.data.id}`).set(auth()).send({ name: 'Safety issue', status: 'INACTIVE' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'Safety issue');
    assert.equal(updated.body.data.status, 'INACTIVE');
  });

  it('rejects a duplicate classification code within a client', async (t) => {
    if (!ready(t)) return;
    const { client } = await fixture();
    assert.equal((await classification(client.id, 'DUPLICATE')).status, 201);
    const duplicate = await classification(client.id, 'DUPLICATE');
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'FINDING_CLASSIFICATION_CODE_ALREADY_EXISTS');
  });

  it('creates, gets, lists, and updates a severity', async (t) => {
    if (!ready(t)) return;
    const { client } = await fixture();
    const created = await severity(client.id, 'HIGH', 30);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.rank, 30);
    const got = await api().get(`/api/v1/finding-severities/${created.body.data.id}`).set(auth());
    assert.equal(got.status, 200);
    const listed = await api().get(`/api/v1/clients/${client.id}/finding-severities`).set(auth());
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.length, 1);
    const updated = await api().patch(`/api/v1/finding-severities/${created.body.data.id}`).set(auth()).send({ rank: 40, status: 'INACTIVE' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.rank, 40);
    assert.equal(updated.body.data.status, 'INACTIVE');
  });

  it('rejects duplicate severity codes and invalid ranks', async (t) => {
    if (!ready(t)) return;
    const { client } = await fixture();
    assert.equal((await severity(client.id, 'CRITICAL', 4)).status, 201);
    const duplicate = await severity(client.id, 'CRITICAL', 5);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'FINDING_SEVERITY_CODE_ALREADY_EXISTS');
    for (const rank of [0, -1, 1.5, '1']) {
      const invalid = await severity(client.id, `BAD_${String(rank).replace('.', '_')}`, rank as number);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
    }
  });

  it('assigns and clears active classification and severity through Finding update', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const cls = await classification(client.id, 'CONDITION');
    const sev = await severity(client.id, 'MEDIUM', 2);
    const item = await finding(building.id, client.id);
    const assigned = await api().patch(`/api/v1/findings/${item.body.data.id}`).set(auth()).send({ classificationId: cls.body.data.id, severityId: sev.body.data.id });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.data.classificationId, cls.body.data.id);
    assert.equal(assigned.body.data.severityId, sev.body.data.id);
    const cleared = await api().patch(`/api/v1/findings/${item.body.data.id}`).set(auth()).send({ classificationId: null, severityId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.classificationId, null);
    assert.equal(cleared.body.data.severityId, null);
  });

  it('rejects inactive classification and severity assignment', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await fixture();
    const cls = await classification(client.id, 'INACTIVE_CLASS');
    const sev = await severity(client.id, 'INACTIVE_SEV', 3);
    await api().patch(`/api/v1/finding-classifications/${cls.body.data.id}`).set(auth()).send({ status: 'INACTIVE' });
    await api().patch(`/api/v1/finding-severities/${sev.body.data.id}`).set(auth()).send({ status: 'INACTIVE' });
    const item = await finding(building.id, client.id);
    const badClass = await api().patch(`/api/v1/findings/${item.body.data.id}`).set(auth()).send({ classificationId: cls.body.data.id });
    assert.equal(badClass.status, 400);
    assert.equal(badClass.body.error.code, 'FINDING_CLASSIFICATION_INACTIVE');
    const badSeverity = await api().patch(`/api/v1/findings/${item.body.data.id}`).set(auth()).send({ severityId: sev.body.data.id });
    assert.equal(badSeverity.status, 400);
    assert.equal(badSeverity.body.error.code, 'FINDING_SEVERITY_INACTIVE');
  });

  it('rejects cross-client classification and severity assignment', async (t) => {
    if (!ready(t)) return;
    const a = await fixture(), b = await fixture();
    const cls = await classification(b.client.id, 'FOREIGN_CLASS');
    const sev = await severity(b.client.id, 'FOREIGN_SEV', 2);
    const item = await finding(a.building.id, a.client.id);
    const badClass = await api().patch(`/api/v1/findings/${item.body.data.id}`).set(auth()).send({ classificationId: cls.body.data.id });
    assert.equal(badClass.status, 400);
    assert.equal(badClass.body.error.code, 'FINDING_CLASSIFICATION_CLIENT_MISMATCH');
    const badSeverity = await api().patch(`/api/v1/findings/${item.body.data.id}`).set(auth()).send({ severityId: sev.body.data.id });
    assert.equal(badSeverity.status, 400);
    assert.equal(badSeverity.body.error.code, 'FINDING_SEVERITY_CLIENT_MISMATCH');
  });

  it('preserves client/building isolation and RBAC', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser();
    const target = await fixture(owner.userId);
    const cls = await classification(target.client.id, 'PRIVATE_CLASS', owner.token);
    assert.equal(cls.status, 201);

    const crossClientList = await api().get(`/api/v1/clients/${target.client.id}/finding-classifications`).set(auth());
    assert.equal(crossClientList.status, 403);
    assert.equal(crossClientList.body.error.code, 'BUILDING_ACCESS_DENIED');
    const crossClientGet = await api().get(`/api/v1/finding-classifications/${cls.body.data.id}`).set(auth());
    assert.equal(crossClientGet.status, 403);

    const plain = await createPlainSession();
    const denied = await api().get(`/api/v1/clients/${target.client.id}/finding-classifications`).set(auth(plain));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    const item = await finding(target.building.id, target.client.id, owner.token);
    const crossBuilding = await api().patch(`/api/v1/findings/${item.body.data.id}`).set(auth()).send({ classificationId: cls.body.data.id });
    assert.equal(crossBuilding.status, 403);
    assert.equal(crossBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
