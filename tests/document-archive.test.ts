import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE document_versions, documents, operational_events,
    buildings, properties, users, roles, permissions, clients CASCADE`);
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function structure(assign = true) {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Archive Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  if (assign) await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
  return { client, building };
}

async function createDocument(buildingId: string, clientId: string, status = 'ACTIVE') {
  const response = await api().post('/api/v1/documents').set(auth()).send({
    clientId,
    buildingId,
    documentNumber: `DOC_${suffix()}`,
    documentType: 'REPORT',
    contextType: 'INTERNAL',
    title: 'Archive validation document',
    status,
  });
  assert.equal(response.status, 201);
  return response.body.data;
}

async function archiveOnlyUser(buildingId: string) {
  const tag = suffix().toLowerCase();
  const password = 'ArchivePass123';
  const user = await userService.createUser({ email: `archive-${tag}@example.com`, displayName: 'Archivist' });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({ code: `ARCHIVE_${tag.toUpperCase()}`, name: 'Archivist' });
  const permission = await permissionRepository.findByCode('document.archive')
    ?? await permissionService.createPermission({ code: 'document.archive', name: 'Archive and Restore Documents' });
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post('/api/v1/auth/login').send({ email: user.email, password });
  assert.equal(login.status, 200);
  return login.body.data.sessionToken as string;
}

describe('BE-22J — Document archive', () => {
  it('archives, protects, preserves history, and restores a Document', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const document = await createDocument(building.id, client.id);
    const versionsBefore = await pool!.query('SELECT id FROM document_versions WHERE document_id = $1', [document.id]);

    const archived = await api().post(`/api/v1/documents/${document.id}/archive`).set(auth()).send({ reason: 'Retention policy' });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.data.status, 'ARCHIVED');
    assert.equal(archived.body.data.statusBeforeArchive, 'ACTIVE');
    assert.equal(archived.body.data.archiveReason, 'Retention policy');
    assert.equal(archived.body.data.archivedByUserId, userId);
    assert.ok(archived.body.data.archivedAt);

    const update = await api().patch(`/api/v1/documents/${document.id}`).set(auth()).send({ title: 'Forbidden change' });
    assert.equal(update.status, 409);
    assert.equal(update.body.error.code, 'DOCUMENT_UPDATE_NOT_ALLOWED');
    const version = await api().post(`/api/v1/documents/${document.id}/versions`).set(auth()).send({ title: 'Forbidden version' });
    assert.equal(version.status, 409);
    const expiry = await api().put(`/api/v1/documents/${document.id}/expiry`).set(auth()).send({ expiryDate: '2030-01-01T00:00:00.000Z' });
    assert.equal(expiry.status, 409);

    const versionsAfter = await pool!.query('SELECT id FROM document_versions WHERE document_id = $1', [document.id]);
    assert.equal(versionsAfter.rowCount, versionsBefore.rowCount);

    const restored = await api().post(`/api/v1/documents/${document.id}/restore`).set(auth()).send({});
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.status, 'ACTIVE');
    assert.equal(restored.body.data.archivedAt, null);
    assert.equal(restored.body.data.archiveReason, null);
    const events = await pool!.query(
      `SELECT event_type FROM operational_events WHERE entity_type = 'DOCUMENT' AND entity_id = $1 ORDER BY created_at`,
      [document.id],
    );
    assert.ok(events.rows.some((row) => row.event_type === 'DOCUMENT_ARCHIVED'));
    assert.ok(events.rows.some((row) => row.event_type === 'DOCUMENT_RESTORED'));
  });

  it('enforces archive RBAC independently from document.manage', async (t) => {
    if (!ready(t)) return;
    const { client, building } = await structure();
    const document = await createDocument(building.id, client.id);
    const plain = await createPlainSession();
    assert.equal((await api().post(`/api/v1/documents/${document.id}/archive`).set(auth(plain)).send({})).status, 403);
    const archivist = await archiveOnlyUser(building.id);
    assert.equal((await api().post(`/api/v1/documents/${document.id}/archive`).set(auth(archivist)).send({})).status, 200);
  });

  it('enforces Client and Building isolation for archive and restore', async (t) => {
    if (!ready(t)) return;
    const inaccessible = await structure(false);
    const creator = await createAdminUser();
    await buildingAssignmentService.createAssignment(creator.userId, { buildingId: inaccessible.building.id });
    const created = await api().post('/api/v1/documents').set(auth(creator.token)).send({
      clientId: inaccessible.client.id,
      buildingId: inaccessible.building.id,
      documentNumber: `DOC_${suffix()}`,
      documentType: 'REPORT',
      contextType: 'INTERNAL',
      title: 'Isolated document',
    });
    assert.equal(created.status, 201);
    assert.equal((await api().post(`/api/v1/documents/${created.body.data.id}/archive`).set(auth()).send({})).status, 403);
    const archived = await api().post(`/api/v1/documents/${created.body.data.id}/archive`).set(auth(creator.token)).send({});
    assert.equal(archived.status, 200);
    assert.equal((await api().post(`/api/v1/documents/${created.body.data.id}/restore`).set(auth()).send({})).status, 403);
  });
});
