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
import {
  floorService,
  isValidFloorCode,
  normalizeFloorCode,
} from '../src/modules/floors';
import { createAdminUser, createPlainSession } from './helpers/access';
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
    'TRUNCATE users, roles, clients, properties, buildings, floors CASCADE',
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

/**
 * Provisions Client → Property → Building and (by default) grants the given
 * user an ACTIVE assignment to the Building, since every Floor route enforces
 * BE-02 Building isolation on top of RBAC.
 */
async function createBuildingFixture(options?: {
  buildingStatus?: 'ACTIVE' | 'INACTIVE';
  assignUserId?: string | null;
}) {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Property',
  });
  // Always created ACTIVE: user assignments require an ACTIVE Building
  // (BE-02F), so an INACTIVE fixture is assigned first, then deactivated.
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Test Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  if (options?.buildingStatus === 'INACTIVE') {
    await buildingService.updateBuildingStatus(building.id, {
      status: 'INACTIVE',
    });
  }

  return { client, property, building };
}

const PUBLIC_FLOOR_KEYS = [
  'buildingId',
  'code',
  'description',
  'id',
  'levelNumber',
  'name',
  'status',
];

describe('floor code normalization', () => {
  it('trims and uppercases floor codes', () => {
    assert.equal(normalizeFloorCode('  l01  '), 'L01');
    assert.equal(normalizeFloorCode('gf'), 'GF');
  });

  it('accepts valid floor codes', () => {
    assert.equal(isValidFloorCode('L01'), true);
    assert.equal(isValidFloorCode('B1'), true);
    assert.equal(isValidFloorCode('MEZZ-2'), true);
  });

  it('rejects invalid floor codes', () => {
    assert.equal(isValidFloorCode('1F'), false);
    assert.equal(isValidFloorCode(''), false);
    assert.equal(isValidFloorCode('L 1'), false);
  });
});

describe('POST /api/v1/buildings/:buildingId/floors', () => {
  it('creates a floor under an ACTIVE building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({
        code: 'l01',
        name: 'Level 1',
        levelNumber: 1,
        description: 'First floor',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.deepEqual(Object.keys(response.body.data).sort(), PUBLIC_FLOOR_KEYS);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.code, 'L01');
    assert.equal(response.body.data.name, 'Level 1');
    assert.equal(response.body.data.levelNumber, 1);
    assert.equal(response.body.data.description, 'First floor');
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('accepts a negative level number for basements', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'B1', name: 'Basement 1', levelNumber: -1 });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.levelNumber, -1);
  });

  it('rejects a duplicate floor code within the same building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const first = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L02', name: 'Level 2', levelNumber: 2 });
    assert.equal(first.status, 201);

    const duplicate = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'l02', name: 'Level 2 again', levelNumber: 2 });

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'FLOOR_CODE_ALREADY_EXISTS');
  });

  it('allows the same floor code in a different building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: buildingA } = await createBuildingFixture();
    const { building: buildingB } = await createBuildingFixture();

    const inA = await api()
      .post(`/api/v1/buildings/${buildingA.id}/floors`)
      .set(authHeaders())
      .send({ code: 'GF', name: 'Ground Floor', levelNumber: 0 });
    assert.equal(inA.status, 201);

    const inB = await api()
      .post(`/api/v1/buildings/${buildingB.id}/floors`)
      .set(authHeaders())
      .send({ code: 'GF', name: 'Ground Floor', levelNumber: 0 });
    assert.equal(inB.status, 201);
  });

  it('denies access for an unknown building (no existence leak)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/buildings/${randomUUID()}/floors`)
      .set(authHeaders())
      .send({ code: 'L01', name: 'Level 1', levelNumber: 1 });

    // requireBuildingAccess: a valid-but-inaccessible Building id yields 403
    // whether or not the Building exists.
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects creating a floor under an INACTIVE building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture({
      buildingStatus: 'INACTIVE',
    });

    // Through the API, an INACTIVE Building falls out of the caller's
    // accessible set entirely (BE-02), so the route denies before the
    // service-level guard is reached.
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L01', name: 'Level 1', levelNumber: 1 });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The service-level guard remains the business authority: it must refuse
    // INACTIVE hosts on its own (defense in depth, no reliance on middleware).
    await assert.rejects(
      floorService.createFloor({
        buildingId: building.id,
        code: 'L01',
        name: 'Level 1',
        levelNumber: 1,
      }),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(error.code, 'BUILDING_NOT_AVAILABLE');
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  });

  it('rejects an invalid body with field details', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: '9F', name: '', levelNumber: 'high' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    const fields = response.body.error.details.map(
      (detail: { field: string }) => detail.field,
    );
    assert.ok(fields.includes('code'));
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('levelNumber'));
  });
});

describe('GET /api/v1/buildings/:buildingId/floors', () => {
  it('lists floors of a building ordered by level number', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    for (const floor of [
      { code: 'L03', name: 'Level 3', levelNumber: 3 },
      { code: 'B1', name: 'Basement 1', levelNumber: -1 },
      { code: 'GF', name: 'Ground Floor', levelNumber: 0 },
    ]) {
      const created = await api()
        .post(`/api/v1/buildings/${building.id}/floors`)
        .set(authHeaders())
        .send(floor);
      assert.equal(created.status, 201);
    }

    const response = await api()
      .get(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 3);
    assert.deepEqual(
      response.body.data.map((floor: { code: string }) => floor.code),
      ['B1', 'GF', 'L03'],
    );
  });

  it('does not leak floors from another building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: buildingA } = await createBuildingFixture();
    const { building: buildingB } = await createBuildingFixture();

    await api()
      .post(`/api/v1/buildings/${buildingA.id}/floors`)
      .set(authHeaders())
      .send({ code: 'ONLY-A', name: 'Only in A', levelNumber: 1 });

    const response = await api()
      .get(`/api/v1/buildings/${buildingB.id}/floors`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });
});

describe('GET /api/v1/floors/:id', () => {
  it('returns a floor by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L05', name: 'Level 5', levelNumber: 5 });

    const response = await api()
      .get(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.buildingId, building.id);
  });

  it('returns 404 for an unknown floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/floors/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FLOOR_NOT_FOUND');
  });

  it('returns 400 for a malformed floor id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get('/api/v1/floors/not-a-uuid')
      .set(authHeaders());

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/floors/:id', () => {
  it('updates name, level number, and description', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L07', name: 'Level 7', levelNumber: 7 });

    const response = await api()
      .patch(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        name: 'Level 7 — Executive',
        levelNumber: 8,
        description: 'Renumbered after refit',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.name, 'Level 7 — Executive');
    assert.equal(response.body.data.levelNumber, 8);
    assert.equal(response.body.data.description, 'Renumbered after refit');
    // Immutable fields stay put.
    assert.equal(response.body.data.code, 'L07');
    assert.equal(response.body.data.buildingId, building.id);
  });

  it('deactivates and reactivates a floor (inactive lifecycle)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L09', name: 'Level 9', levelNumber: 9 });

    const deactivated = await api()
      .patch(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // Not a delete: the floor stays readable and its code stays reserved.
    const stillThere = await api()
      .get(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.data.status, 'INACTIVE');

    const duplicate = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L09', name: 'Level 9 clone', levelNumber: 9 });
    assert.equal(duplicate.status, 409);

    const reactivated = await api()
      .patch(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.data.status, 'ACTIVE');
  });

  it('rejects an invalid status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const created = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L10', name: 'Level 10', levelNumber: 10 });

    const response = await api()
      .patch(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'DEMOLISHED' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 when updating an unknown floor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .patch(`/api/v1/floors/${randomUUID()}`)
      .set(authHeaders())
      .send({ name: 'Ghost Floor' });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FLOOR_NOT_FOUND');
  });
});

describe('floor RBAC and building isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api().get(`/api/v1/floors/${randomUUID()}`);
    assert.equal(response.status, 401);
  });

  it('denies a user without floor permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createBuildingFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');

    const write = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders(plainToken))
      .send({ code: 'L01', name: 'Level 1', levelNumber: 1 });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies floor routes for a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Building exists, but the admin holds NO assignment to it: permission
    // alone must not be enough (BE-02 isolation preserved).
    const { building } = await createBuildingFixture({ assignUserId: null });

    const create = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'L01', name: 'Level 1', levelNumber: 1 });
    assert.equal(create.status, 403);
    assert.equal(create.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /floors/:id routes across the building isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // Floor created in an accessible building by an assigned admin…
    const { building } = await createBuildingFixture();
    const created = await api()
      .post(`/api/v1/buildings/${building.id}/floors`)
      .set(authHeaders())
      .send({ code: 'ISO', name: 'Isolated Floor', levelNumber: 1 });
    assert.equal(created.status, 201);

    // …must not be readable or writable by a second admin (full floor
    // permissions, different Client, no assignment to this Building).
    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/floors/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ name: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
