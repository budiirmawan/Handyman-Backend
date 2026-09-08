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
import { cleaningAreaService } from '../src/modules/cleaning-areas';
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
    `TRUNCATE users, roles, permissions, role_permission_assignments,
      user_role_assignments, clients, properties, buildings,
      user_building_assignments, floors, areas, rooms, spaces,
      functional_locations, cleaning_areas, consumable_requirements,
      consumable_readiness_checks CASCADE`,
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

async function createStructureFixture(options?: {
  assignUserId?: string | null;
}) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const client = await clientService.createClient({
    code: `CLI_${suffix}`,
    name: 'Consumable Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix}`,
    name: 'Consumable Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix}`,
    name: 'Consumable Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const cleaningArea = await cleaningAreaService.createCleaningArea({
    buildingId: building.id,
    code: `CA_RESTROOM_${suffix}`,
    name: 'Restroom Zone Consumable',
    cleaningAreaType: 'TOILET',
  });

  return { client, property, building, cleaningArea };
}

const PUBLIC_REQUIREMENT_KEYS = [
  'buildingId',
  'cleaningArea',
  'cleaningAreaId',
  'clientId',
  'code',
  'createdAt',
  'currentReadiness',
  'id',
  'name',
  'requiredQuantity',
  'status',
  'unit',
  'updatedAt',
];

const PUBLIC_READINESS_KEYS = [
  'availableQuantity',
  'buildingId',
  'checkedAt',
  'checkedByUserId',
  'cleaningArea',
  'clientId',
  'createdAt',
  'id',
  'notes',
  'operationalDate',
  'readinessStatus',
  'requirement',
  'requirementId',
  'updatedAt',
];

describe('BE-11J Consumable Readiness operations', () => {
  it('creates a Consumable Requirement and records READY status', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const createRes = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        code: 'CR_TOILET_PAPER',
        name: 'Jumbo Roll Toilet Tissue',
        requiredQuantity: 10,
        unit: 'ROLL',
      });

    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.success, true);
    assert.deepEqual(
      Object.keys(createRes.body.data).sort(),
      PUBLIC_REQUIREMENT_KEYS,
    );
    assert.equal(createRes.body.data.code, 'CR_TOILET_PAPER');
    assert.equal(createRes.body.data.requiredQuantity, 10);
    assert.equal(createRes.body.data.unit, 'ROLL');
    assert.equal(createRes.body.data.status, 'ACTIVE');
    assert.equal(
      createRes.body.data.cleaningArea.id,
      fixture.cleaningArea.id,
    );

    const requirementId = createRes.body.data.id;

    // Record READY
    const readyRes = await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${requirementId}/readiness`,
      )
      .set(authHeaders())
      .send({
        readinessStatus: 'READY',
        availableQuantity: 12,
        notes: 'Fully stocked',
      });

    assert.equal(readyRes.status, 201);
    assert.deepEqual(
      Object.keys(readyRes.body.data).sort(),
      PUBLIC_READINESS_KEYS,
    );
    assert.equal(readyRes.body.data.readinessStatus, 'READY');
    assert.equal(readyRes.body.data.availableQuantity, 12);
    assert.equal(readyRes.body.data.requirement.code, 'CR_TOILET_PAPER');

    // Get requirement with updated currentReadiness
    const getRes = await api()
      .get(
        `/api/v1/housekeeping/consumable-requirements/${requirementId}`,
      )
      .set(authHeaders());
    assert.equal(getRes.status, 200);
    assert.equal(
      getRes.body.data.currentReadiness.readinessStatus,
      'READY',
    );
    assert.equal(getRes.body.data.currentReadiness.availableQuantity, 12);
  });

  it('records LOW and NOT_READY status', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const reqRes = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        cleaningAreaId: fixture.cleaningArea.id,
        code: 'CR_HAND_SOAP',
        name: 'Foam Hand Soap Refill',
        requiredQuantity: 5,
        unit: 'BOTTLE',
      });
    const requirementId = reqRes.body.data.id;

    // Record LOW
    const lowRes = await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${requirementId}/readiness`,
      )
      .set(authHeaders())
      .send({
        readinessStatus: 'LOW',
        availableQuantity: 1,
        notes: 'Only 1 bottle remaining',
      });
    assert.equal(lowRes.status, 201);
    assert.equal(lowRes.body.data.readinessStatus, 'LOW');

    // Record NOT_READY
    const notReadyRes = await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${requirementId}/readiness`,
      )
      .set(authHeaders())
      .send({
        readinessStatus: 'NOT_READY',
        availableQuantity: 0,
        notes: 'Completely out of stock',
      });
    assert.equal(notReadyRes.status, 201);
    assert.equal(notReadyRes.body.data.readinessStatus, 'NOT_READY');
  });

  it('lists readiness with filters and finds not-ready items', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const req1 = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        code: 'CR_ITEM_1',
        name: 'Item 1',
        unit: 'PCS',
      });
    const req2 = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        code: 'CR_ITEM_2',
        name: 'Item 2',
        unit: 'PCS',
      });

    await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${req1.body.data.id}/readiness`,
      )
      .set(authHeaders())
      .send({ readinessStatus: 'NOT_READY', availableQuantity: 0 });

    await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${req2.body.data.id}/readiness`,
      )
      .set(authHeaders())
      .send({ readinessStatus: 'READY', availableQuantity: 5 });

    // List filtered by NOT_READY
    const notReadyList = await api()
      .get('/api/v1/housekeeping/consumable-readiness')
      .query({
        buildingId: fixture.building.id,
        readinessStatus: 'NOT_READY',
      })
      .set(authHeaders());

    assert.equal(notReadyList.status, 200);
    assert.ok(
      notReadyList.body.data.some(
        (r: { requirement: { code: string } }) =>
          r.requirement.code === 'CR_ITEM_1',
      ),
    );
    assert.ok(
      !notReadyList.body.data.some(
        (r: { requirement: { code: string } }) =>
          r.requirement.code === 'CR_ITEM_2',
      ),
    );
  });

  it('rejects invalid readiness status and negative quantities', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const reqRes = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        code: 'CR_VALIDATE',
        name: 'Validation Item',
        unit: 'PCS',
      });
    const id = reqRes.body.data.id;

    const badStatus = await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${id}/readiness`,
      )
      .set(authHeaders())
      .send({ readinessStatus: 'INVALID_STATUS' });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.error.code, 'VALIDATION_ERROR');

    const badQty = await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${id}/readiness`,
      )
      .set(authHeaders())
      .send({
        readinessStatus: 'READY',
        availableQuantity: -5,
      });
    assert.equal(badQty.status, 400);
    assert.equal(badQty.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects readiness checks on INACTIVE requirements', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    const reqRes = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders())
      .send({
        buildingId: fixture.building.id,
        code: 'CR_INACTIVE_TEST',
        name: 'Inactive Item',
        unit: 'PCS',
      });
    const id = reqRes.body.data.id;

    // Deactivate requirement
    await api()
      .patch(`/api/v1/housekeeping/consumable-requirements/${id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });

    const response = await api()
      .post(
        `/api/v1/housekeeping/consumable-requirements/${id}/readiness`,
      )
      .set(authHeaders())
      .send({ readinessStatus: 'READY' });

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'CONSUMABLE_REQUIREMENT_INACTIVE',
    );
  });

  it('enforces RBAC and Building isolation', async (t) => {
    if (!requireDatabase(t)) return;

    const fixture = await createStructureFixture();

    // Unauthenticated
    const unauth = await api().post(
      '/api/v1/housekeeping/consumable-requirements',
    );
    assert.equal(unauth.status, 401);

    // Plain user without consumable_readiness permissions
    const plainToken = await createPlainSession();
    const denied = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders(plainToken))
      .send({
        buildingId: fixture.building.id,
        code: 'CR_DENIED',
        name: 'Denied Item',
        unit: 'PCS',
      });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

    // Outsider across building isolation boundary
    const outsider = await createAdminUser();
    const crossRes = await api()
      .post('/api/v1/housekeeping/consumable-requirements')
      .set(authHeaders(outsider.token))
      .send({
        buildingId: fixture.building.id,
        code: 'CR_CROSS',
        name: 'Cross Item',
        unit: 'PCS',
      });
    assert.equal(crossRes.status, 403);
    assert.equal(crossRes.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
