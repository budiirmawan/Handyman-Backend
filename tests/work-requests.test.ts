import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { isValidRequestNumber, normalizeRequestNumber } from '../src/modules/work-requests';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-08A — Work Request Foundation focused tests.
 *
 * Covers only Work Request intake: create, unique request number, unknown
 * Building, Client / Building mismatch, get, list/filter, update OPEN request,
 * cancel, terminal-state protection, cross-Client / cross-Building isolation,
 * and RBAC. Work Order conversion, priority, asset binding, assignment,
 * execution, evidence, completion, verification, and history belong to BE-08B+
 * and are deliberately not exercised here.
 */

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
    `TRUNCATE work_requests, users, roles, clients, properties, buildings CASCADE`,
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

async function createBuildingFixture(options?: {
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

  return { client, property, building };
}

async function createWorkRequestVia(
  buildingId: string,
  clientId: string,
  overrides?: Record<string, unknown>,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/work-requests`)
    .set(authHeaders())
    .send({
      clientId,
      requestNumber: `WRQ_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Test Work Request',
      requestType: 'REPAIR',
      ...overrides,
    });
}

const PUBLIC_WORK_REQUEST_KEYS = [
  'buildingId',
  'clientId',
  'createdAt',
  'description',
  'id',
  'requestNumber',
  'requestType',
  'requestedAt',
  'requestedByUserId',
  'status',
  'title',
  'updatedAt',
];

describe('work request number validation', () => {
  it('normalizes request numbers to uppercase', () => {
    assert.equal(normalizeRequestNumber('  wrq-ahu-01  '), 'WRQ-AHU-01');
  });

  it('accepts valid numbers and rejects malformed ones', () => {
    assert.equal(isValidRequestNumber('WRQ-AHU-01'), true);
    assert.equal(isValidRequestNumber('WRQ_01'), true);
    assert.equal(isValidRequestNumber('1WRQ'), false);
    assert.equal(isValidRequestNumber('W'), false);
    assert.equal(isValidRequestNumber('WRQ 01'), false);
  });
});

describe('create work request', () => {
  it('registers a request with derived client and OPEN status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const response = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-AHU-01',
      title: 'Air Handling Unit fault',
      description: 'Abnormal noise from rooftop AHU.',
      requestType: 'REPAIR',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_WORK_REQUEST_KEYS,
    );
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.requestNumber, 'WRQ-AHU-01');
    assert.equal(response.body.data.title, 'Air Handling Unit fault');
    assert.equal(response.body.data.description, 'Abnormal noise from rooftop AHU.');
    assert.equal(response.body.data.requestType, 'REPAIR');
    assert.equal(response.body.data.requestedByUserId, adminUserId);
    assert.equal(response.body.data.status, 'OPEN');
  });

  it('normalizes the request number and request type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const response = await createWorkRequestVia(building.id, client.id, {
      requestNumber: '  wrq-pump-01  ',
      title: 'Chilled Water Pump',
      requestType: '  corrective  ',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.requestNumber, 'WRQ-PUMP-01');
    assert.equal(response.body.data.requestType, 'CORRECTIVE');
  });

  it('rejects an invalid body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/work-requests`)
      .set(authHeaders())
      .send({ title: 'Missing fields' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a duplicate request number within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const first = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-DUP-01',
      title: 'First request',
    });
    assert.equal(first.status, 201);

    const second = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-DUP-01',
      title: 'Duplicate request',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'WORK_REQUEST_NUMBER_ALREADY_EXISTS');
  });

  it('allows the same request number in a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: b1, client: c1 } = await createBuildingFixture();
    const first = await createWorkRequestVia(b1.id, c1.id, {
      requestNumber: 'WRQ-SHARED',
    });
    assert.equal(first.status, 201);

    const { building: b2, client: c2 } = await createBuildingFixture();
    const second = await createWorkRequestVia(b2.id, c2.id, {
      requestNumber: 'WRQ-SHARED',
    });
    assert.equal(second.status, 201);
  });

  it('returns 403 for an unknown building at the route level', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/buildings/${randomUUID()}/work-requests`)
      .set(authHeaders())
      .send({
        clientId: randomUUID(),
        requestNumber: 'WRQ-NO-BLDG',
        title: 'No building',
        requestType: 'REPAIR',
      });
    // requireBuildingAccess: a valid-but-inaccessible Building id yields 403
    // whether or not the Building exists (no existence leak).
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown building at the service layer', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { workRequestService } = await import('../src/modules/work-requests');
    const { client } = await createBuildingFixture();
    await assert.rejects(
      workRequestService.createWorkRequest({
        clientId: client.id,
        buildingId: randomUUID(),
        requestNumber: 'WRQ-NO-BLDG-SVC',
        title: 'No building',
        requestType: 'REPAIR',
        requestedByUserId: adminUserId,
      }),
      { code: 'BUILDING_NOT_FOUND' },
    );
  });

  it('returns 404 for an unknown client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/work-requests`)
      .set(authHeaders())
      .send({
        clientId: randomUUID(),
        requestNumber: 'WRQ-NO-CLIENT',
        title: 'No client',
        requestType: 'REPAIR',
      });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'CLIENT_NOT_FOUND');
  });

  it('rejects a building that does not belong to the client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const foreign = await clientService.createClient({
      code: `CLI_F_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Foreign Client',
    });
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/work-requests`)
      .set(authHeaders())
      .send({
        clientId: foreign.id,
        requestNumber: 'WRQ-MISMATCH',
        title: 'Mismatched client',
        requestType: 'REPAIR',
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_REQUEST_BUILDING_CLIENT_MISMATCH');
  });
});

describe('get work request', () => {
  it('returns the work request by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-GET-01',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/work-requests/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.requestNumber, 'WRQ-GET-01');
  });

  it('returns 404 for an unknown work request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/work-requests/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORK_REQUEST_NOT_FOUND');
  });
});

describe('list / filter work requests', () => {
  it('lists and filters by status and request type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-LIST-1',
      requestType: 'REPAIR',
    });
    await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-LIST-2',
      requestType: 'REPAIR',
    });
    await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-LIST-3',
      requestType: 'INSPECTION',
    });

    const all = await api()
      .get(`/api/v1/buildings/${building.id}/work-requests`)
      .set(authHeaders());
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 3);

    const repair = await api()
      .get(`/api/v1/buildings/${building.id}/work-requests?requestType=REPAIR`)
      .set(authHeaders());
    assert.equal(repair.status, 200);
    assert.equal(repair.body.data.length, 2);

    const open = await api()
      .get(`/api/v1/buildings/${building.id}/work-requests?status=OPEN`)
      .set(authHeaders());
    assert.equal(open.status, 200);
    assert.equal(open.body.data.length, 3);
  });

  it('returns 403 for an unknown building on list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/buildings/${randomUUID()}/work-requests`)
      .set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('update open work request', () => {
  it('updates title, description, and request type while OPEN', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-UPD-01',
      title: 'Original title',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/work-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        title: 'Updated title',
        description: 'Updated notes',
        requestType: 'CORRECTIVE',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.title, 'Updated title');
    assert.equal(response.body.data.description, 'Updated notes');
    assert.equal(response.body.data.requestType, 'CORRECTIVE');
  });

  it('rejects an invalid update body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-UPD-2',
    });
    const response = await api()
      .patch(`/api/v1/work-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ requestType: 'lower case!!' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('cancel work request', () => {
  it('cancels an open work request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-CAN-01',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .post(`/api/v1/work-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'CANCELLED');
  });
});

describe('terminal-state protection', () => {
  it('cannot update a cancelled request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-CAN-UPD',
    });
    await api()
      .post(`/api/v1/work-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const response = await api()
      .patch(`/api/v1/work-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ title: 'Should fail' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_REQUEST_NOT_OPEN');
  });

  it('cannot cancel an already-cancelled request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-CAN-CAN',
    });
    await api()
      .post(`/api/v1/work-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const second = await api()
      .post(`/api/v1/work-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'WORK_REQUEST_NOT_OPEN');
  });

  it('cannot update or cancel a converted (terminal) request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-CONV-01',
    });
    assert.equal(created.status, 201);

    // Conversion to a Work Order is owned by BE-08B. Here we drive the record
    // into the terminal state directly so intake terminal-state protection is
    // verifiable in isolation.
    await getPool().query(
      `UPDATE work_requests SET status = 'CONVERTED' WHERE id = $1`,
      [created.body.data.id],
    );

    const update = await api()
      .patch(`/api/v1/work-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ title: 'Should fail' });
    assert.equal(update.status, 400);
    assert.equal(update.body.error.code, 'WORK_REQUEST_NOT_OPEN');

    const cancel = await api()
      .post(`/api/v1/work-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(cancel.status, 400);
    assert.equal(cancel.body.error.code, 'WORK_REQUEST_TERMINAL_STATE');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api().get(
      `/api/v1/buildings/${building.id}/work-requests`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without work request permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createBuildingFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/work-requests`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture({ assignUserId: null });
    const list = await api()
      .get(`/api/v1/buildings/${building.id}/work-requests`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /work-requests/:id routes across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkRequestVia(building.id, client.id, {
      requestNumber: 'WRQ-ISO-01',
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/work-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/work-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ title: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies a request from a different building (no assignment)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // The first admin is assigned to Building A only. A second admin owns
    // Building B (different client) and creates a request there.
    const { building: buildingA } = await createBuildingFixture();

    const ownerB = await createAdminUser();
    const { building: buildingB, client: clientB } = await createBuildingFixture({
      assignUserId: ownerB.userId,
    });
    const createdB = await api()
      .post(`/api/v1/buildings/${buildingB.id}/work-requests`)
      .set(authHeaders(ownerB.token))
      .send({
        clientId: clientB.id,
        requestNumber: 'WRQ-B-01',
        title: 'In building B',
        requestType: 'REPAIR',
      });
    assert.equal(createdB.status, 201);

    // Admin (assigned only to Building A) must not read Building B's request.
    const read = await api()
      .get(`/api/v1/work-requests/${createdB.body.data.id}`)
      .set(authHeaders());
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
    void buildingA;
  });
});
