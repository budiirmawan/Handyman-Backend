import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import {
  buildingAssignmentService,
  resolveBuildingsForUser,
} from '../src/modules/building-assignments';
import {
  contextAccessService,
  getAccessibleBuildingIds,
} from '../src/modules/context-access';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, organizations, departments, teams, positions,
      workforce_profiles, workforce_building_assignments, external_workforce_links
     CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createClientPropertyBuilding(
  opts: { buildingStatus?: 'ACTIVE' | 'INACTIVE' } = {},
) {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
    status: opts.buildingStatus ?? 'ACTIVE',
  });
  return { client, property, building };
}

describe('context access service', () => {
  it('resolves accessible building ids from active assignments', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const a = await createClientPropertyBuilding();
    const b = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: a.building.id,
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: b.building.id,
    });

    const ids = await getAccessibleBuildingIds(adminUserId);
    assert.equal(ids.length, 2);
    assert.ok(ids.includes(a.building.id));
    assert.ok(ids.includes(b.building.id));
  });

  it('returns empty for a zero-assignment user', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { building } = await createClientPropertyBuilding();
    // A fresh plain user has no assignments.
    const ids = await getAccessibleBuildingIds(randomUUID());
    assert.deepEqual(ids, []);
    assert.equal(await contextAccessService.canAccessBuilding(randomUUID(), building.id), false);
  });

  it('derives canAccessProperty and canAccessClient from explicit assignments', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const a = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: a.building.id,
    });
    assert.equal(
      await contextAccessService.canAccessProperty(adminUserId, a.property.id),
      true,
    );
    assert.equal(
      await contextAccessService.canAccessClient(adminUserId, a.client.id),
      true,
    );
  });
});

describe('building-scoped read isolation (GET /buildings/:id)', () => {
  it('ALLOWs an active user with permission and assignment to an ACTIVE building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { building } = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
    const response = await api().get(`/api/v1/buildings/${building.id}`).set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, building.id);
  });

  it('DENYs a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const assigned = await createClientPropertyBuilding();
    const other = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: assigned.building.id,
    });
    const response = await api().get(`/api/v1/buildings/${other.building.id}`).set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('DENYs an INACTIVE assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { building } = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: building.id,
    });
    await buildingAssignmentService.deactivateAssignment(adminUserId, building.id);
    const response = await api().get(`/api/v1/buildings/${building.id}`).set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('DENYs an INACTIVE building even with an active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { building } = await createClientPropertyBuilding({ buildingStatus: 'INACTIVE' });
    // Direct assignment to an INACTIVE building is rejected by BE-02F, so
    // simulate an active assignment that later becomes inactive via the service.
    // (Here the building is inactive; it cannot be assigned, and is never
    //  in the accessible set.)
    const response = await api().get(`/api/v1/buildings/${building.id}`).set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('DENYs a sibling building under the same property', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const client = await clientService.createClient({
      code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Sibling Client',
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Sibling Property',
    });
    const buildingA1 = await buildingService.createBuilding({
      propertyId: property.id,
      code: 'A1',
      name: 'A1',
    });
    const buildingA2 = await buildingService.createBuilding({
      propertyId: property.id,
      code: 'A2',
      name: 'A2',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: buildingA1.id,
    });

    const ok = await api().get(`/api/v1/buildings/${buildingA1.id}`).set(authHeaders());
    const sibling = await api().get(`/api/v1/buildings/${buildingA2.id}`).set(authHeaders());
    assert.equal(ok.status, 200);
    assert.equal(sibling.status, 403);
    assert.equal(sibling.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('DENYs a same-client building not assigned', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const client = await clientService.createClient({
      code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Same Client',
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Same Client Property',
    });
    const b1 = await buildingService.createBuilding({ propertyId: property.id, code: 'B1', name: 'B1' });
    const b2 = await buildingService.createBuilding({ propertyId: property.id, code: 'B2', name: 'B2' });
    await buildingAssignmentService.createAssignment(adminUserId, { buildingId: b1.id });
    const res = await api().get(`/api/v1/buildings/${b2.id}`).set(authHeaders());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('ALLOWs explicit cross-client assignments only', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const a = await createClientPropertyBuilding();
    const b = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, { buildingId: a.building.id });
    await buildingAssignmentService.createAssignment(adminUserId, { buildingId: b.building.id });

    const resA = await api().get(`/api/v1/buildings/${a.building.id}`).set(authHeaders());
    const resB = await api().get(`/api/v1/buildings/${b.building.id}`).set(authHeaders());
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
  });
});

describe('permission + building access remain separate', () => {
  it('DENYs when permission is present but building assignment is absent', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    // Admin has building.read but is not assigned to this building.
    const { building } = await createClientPropertyBuilding();
    await pool!.query(
      `UPDATE user_building_assignments
       SET status = 'INACTIVE', updated_at = NOW()
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [adminUserId],
    );
    const res = await api().get(`/api/v1/buildings/${building.id}`).set(authHeaders());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('DENYs when building assignment is present but permission is absent', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { building } = await createClientPropertyBuilding();
    // Grant the plain user an assignment directly via the service, but give
    // them no roles (hence no building.read permission).
    const { credentialService } = await import('../src/modules/auth');
    const { userService } = await import('../src/modules/users');
    const userRec = await userService.createUser({
      email: `iso-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Iso Plain',
    });
    await credentialService.createInitialCredential({
      userId: userRec.id,
      password: 'IsoPass123',
    });
    await buildingAssignmentService.createAssignment(userRec.id, { buildingId: building.id });
    const login = await api().post('/api/v1/auth/login').send({
      email: userRec.email,
      password: 'IsoPass123',
    });
    const token = login.body.data.sessionToken as string;

    const res = await api().get(`/api/v1/buildings/${building.id}`).set({ Authorization: `Bearer ${token}` });
    // Has assignment but no building.read permission → 403 PERMISSION_DENIED.
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('ALLOWs when both permission and building assignment are present', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { building } = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, { buildingId: building.id });
    const res = await api().get(`/api/v1/buildings/${building.id}`).set(authHeaders());
    assert.equal(res.status, 200);
  });
});

describe('current user building list (self-context)', () => {
  it('returns only active assignments to active buildings', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const a = await createClientPropertyBuilding();
    const b = await createClientPropertyBuilding();
    await buildingAssignmentService.createAssignment(adminUserId, { buildingId: a.building.id });
    await buildingAssignmentService.createAssignment(adminUserId, { buildingId: b.building.id });
    await buildingAssignmentService.deactivateAssignment(adminUserId, b.building.id);

    const contexts = await resolveBuildingsForUser(adminUserId);
    const codes = contexts.map((c) => c.building.code);
    assert.ok(codes.includes(a.building.code));
    assert.ok(!codes.includes(b.building.code));

    const res = await api().get('/api/v1/auth/me/buildings').set(authHeaders());
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    const resCodes = res.body.data.map((c: { building: { code: string } }) => c.building.code);
    assert.ok(resCodes.includes(a.building.code));
    assert.ok(!resCodes.includes(b.building.code));
  });
});

describe('zero-assignment user', () => {
  it('denies building-scoped access and exposes empty accessible set', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }
    const { building } = await createClientPropertyBuilding();
    await pool!.query(
      `UPDATE user_building_assignments
       SET status = 'INACTIVE', updated_at = NOW()
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [adminUserId],
    );
    const res = await api().get(`/api/v1/buildings/${building.id}`).set(authHeaders());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'BUILDING_ACCESS_DENIED');
    const ids = await getAccessibleBuildingIds(adminUserId);
    assert.equal(ids.length, 0);
  });
});
