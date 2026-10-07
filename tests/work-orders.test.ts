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
import { workRequestService } from '../src/modules/work-requests';
import { isValidWorkOrderNumber, normalizeWorkOrderNumber } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-08B — Work Order Domain focused tests.
 *
 * Covers only Work Order identity, core metadata, and Work Request →
 * Work Order conversion: direct creation, conversion, duplicate conversion,
 * cancelled/unknown request, unique number, get/list/filter, update allowed
 * metadata, Client / Building isolation, and RBAC. Priority, detailed
 * lifecycle, asset binding, assignment, execution, evidence, completion,
 * verification, and history belong to BE-08C+ and are deliberately not
 * exercised here.
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
    `TRUNCATE work_orders, work_requests, users, roles, clients, properties, buildings CASCADE`,
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

async function createWorkOrderVia(
  buildingId: string,
  clientId: string,
  overrides?: Record<string, unknown>,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/work-orders`)
    .set(authHeaders())
    .send({
      clientId,
      workOrderNumber: `WO_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Test Work Order',
      workType: 'REPAIR',
      ...overrides,
    });
}

async function createRequestVia(buildingId: string, clientId: string) {
  const response = await api()
    .post(`/api/v1/buildings/${buildingId}/work-requests`)
    .set(authHeaders())
    .send({
      clientId,
      requestNumber: `WRQ_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Source Work Request',
      requestType: 'REPAIR',
    });
  return response.body.data as { id: string };
}

const PUBLIC_WORK_ORDER_KEYS = [
  'assetId',
  'assignedAt',
  'bastRequirement',
  'buildingId',
  'cancelledAt',
  'clientId',
  'closedAt',
  'completedAt',
  'completedByUserId',
  'completionNotes',
  'completionSummary',
  'createdAt',
  'createdByUserId',
  'description',
  'functionalLocationId',
  'id',
  'priority',
  'startedAt',
  'status',
  'title',
  'updatedAt',
  'workOrderNumber',
  'workRequestId',
  'workType',
];

describe('work order number validation', () => {
  it('normalizes work order numbers to uppercase', () => {
    assert.equal(normalizeWorkOrderNumber('  wo-ahu-01  '), 'WO-AHU-01');
  });

  it('accepts valid numbers and rejects malformed ones', () => {
    assert.equal(isValidWorkOrderNumber('WO-AHU-01'), true);
    assert.equal(isValidWorkOrderNumber('WO_01'), true);
    assert.equal(isValidWorkOrderNumber('1WO'), false);
    assert.equal(isValidWorkOrderNumber('W'), false);
    assert.equal(isValidWorkOrderNumber('WO 01'), false);
  });
});

describe('create work order (direct)', () => {
  it('creates an OPEN work order with derived client and no source request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const response = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-AHU-01',
      title: 'Air Handling Unit overhaul',
      description: 'Full overhaul of rooftop AHU.',
      workType: 'REPAIR',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_WORK_ORDER_KEYS,
    );
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.workOrderNumber, 'WO-AHU-01');
    assert.equal(response.body.data.title, 'Air Handling Unit overhaul');
    assert.equal(response.body.data.description, 'Full overhaul of rooftop AHU.');
    assert.equal(response.body.data.workType, 'REPAIR');
    assert.equal(response.body.data.workRequestId, null);
    assert.equal(response.body.data.createdByUserId, adminUserId);
    assert.equal(response.body.data.status, 'OPEN');
  });

  it('normalizes the work order number and work type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const response = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: '  wo-pump-01  ',
      workType: '  corrective  ',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.workOrderNumber, 'WO-PUMP-01');
    assert.equal(response.body.data.workType, 'CORRECTIVE');
  });

  it('rejects an invalid body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/work-orders`)
      .set(authHeaders())
      .send({ title: 'Missing fields' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a duplicate work order number within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const first = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-DUP-01',
    });
    assert.equal(first.status, 201);

    const second = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-DUP-01',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'WORK_ORDER_NUMBER_ALREADY_EXISTS');
  });

  it('allows the same work order number in a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: b1, client: c1 } = await createBuildingFixture();
    const first = await createWorkOrderVia(b1.id, c1.id, {
      workOrderNumber: 'WO-SHARED',
    });
    assert.equal(first.status, 201);

    const { building: b2, client: c2 } = await createBuildingFixture();
    const second = await createWorkOrderVia(b2.id, c2.id, {
      workOrderNumber: 'WO-SHARED',
    });
    assert.equal(second.status, 201);
  });

  it('returns 403 for an unknown building at the route level', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/buildings/${randomUUID()}/work-orders`)
      .set(authHeaders())
      .send({
        clientId: randomUUID(),
        workOrderNumber: 'WO-NO-BLDG',
        title: 'No building',
        workType: 'REPAIR',
      });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown building at the service layer', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { workOrderService } = await import('../src/modules/work-orders');
    const { client } = await createBuildingFixture();
    await assert.rejects(
      workOrderService.createWorkOrder({
        clientId: client.id,
        buildingId: randomUUID(),
        workOrderNumber: 'WO-NO-BLDG-SVC',
        title: 'No building',
        workType: 'REPAIR',
        createdByUserId: adminUserId,
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
      .post(`/api/v1/buildings/${building.id}/work-orders`)
      .set(authHeaders())
      .send({
        clientId: randomUUID(),
        workOrderNumber: 'WO-NO-CLIENT',
        title: 'No client',
        workType: 'REPAIR',
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
      .post(`/api/v1/buildings/${building.id}/work-orders`)
      .set(authHeaders())
      .send({
        clientId: foreign.id,
        workOrderNumber: 'WO-MISMATCH',
        title: 'Mismatched client',
        workType: 'REPAIR',
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_BUILDING_CLIENT_MISMATCH');
  });
});

describe('work request to work order conversion', () => {
  it('converts an open work request into a work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const request = await createRequestVia(building.id, client.id);

    const response = await api()
      .post(`/api/v1/work-requests/${request.id}/work-order`)
      .set(authHeaders())
      .send({
        workOrderNumber: 'WO-CONV-01',
        title: 'Converted Work Order',
        workType: 'REPAIR',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.workRequestId, request.id);
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.workOrderNumber, 'WO-CONV-01');
    assert.equal(response.body.data.title, 'Converted Work Order');

    // The source request is marked CONVERTED (terminal).
    const req = await api()
      .get(`/api/v1/work-requests/${request.id}`)
      .set(authHeaders());
    assert.equal(req.status, 200);
    assert.equal(req.body.data.status, 'CONVERTED');
  });

  it('rejects duplicate conversion of the same request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const request = await createRequestVia(building.id, client.id);

    const first = await api()
      .post(`/api/v1/work-requests/${request.id}/work-order`)
      .set(authHeaders())
      .send({
        workOrderNumber: 'WO-CONV-DUP',
        title: 'First order',
        workType: 'REPAIR',
      });
    assert.equal(first.status, 201);

    const second = await api()
      .post(`/api/v1/work-requests/${request.id}/work-order`)
      .set(authHeaders())
      .send({
        workOrderNumber: 'WO-CONV-DUP-2',
        title: 'Second order',
        workType: 'REPAIR',
      });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'WORK_ORDER_FROM_REQUEST_ALREADY_EXISTS',
    );
  });

  it('rejects conversion of a cancelled work request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const request = await createRequestVia(building.id, client.id);
    await api()
      .post(`/api/v1/work-requests/${request.id}/cancel`)
      .set(authHeaders());

    const response = await api()
      .post(`/api/v1/work-requests/${request.id}/work-order`)
      .set(authHeaders())
      .send({
        workOrderNumber: 'WO-CONV-CAN',
        title: 'Cancelled source',
        workType: 'REPAIR',
      });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_REQUEST_NOT_OPEN');
  });

  it('returns 404 for an unknown work request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/work-requests/${randomUUID()}/work-order`)
      .set(authHeaders())
      .send({
        workOrderNumber: 'WO-NO-REQ',
        title: 'No request',
        workType: 'REPAIR',
      });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORK_REQUEST_NOT_FOUND');
  });
});

describe('get / list work orders', () => {
  it('returns the work order by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-GET-01',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/work-orders/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.workOrderNumber, 'WO-GET-01');
  });

  it('returns 404 for an unknown work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/work-orders/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORK_ORDER_NOT_FOUND');
  });

  it('lists and filters by status, work type, and work request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-LIST-1',
      workType: 'REPAIR',
    });
    await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-LIST-2',
      workType: 'REPAIR',
    });
    await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-LIST-3',
      workType: 'INSPECTION',
    });
    const request = await createRequestVia(building.id, client.id);
    const conv = await api()
      .post(`/api/v1/work-requests/${request.id}/work-order`)
      .set(authHeaders())
      .send({
        workOrderNumber: 'WO-LIST-4',
        title: 'Corrective order',
        workType: 'CORRECTIVE',
      });
    assert.equal(conv.status, 201, `conversion failed: ${JSON.stringify(conv.body)}`);

    const all = await api()
      .get(`/api/v1/buildings/${building.id}/work-orders`)
      .set(authHeaders());
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 4);

    const repair = await api()
      .get(`/api/v1/buildings/${building.id}/work-orders?workType=REPAIR`)
      .set(authHeaders());
    assert.equal(repair.status, 200);
    assert.equal(repair.body.data.length, 2);

    const open = await api()
      .get(`/api/v1/buildings/${building.id}/work-orders?status=OPEN`)
      .set(authHeaders());
    assert.equal(open.status, 200);
    assert.equal(open.body.data.length, 4);

    const fromRequest = await api()
      .get(
        `/api/v1/buildings/${building.id}/work-orders?workRequestId=${request.id}`,
      )
      .set(authHeaders());
    assert.equal(fromRequest.status, 200);
    assert.equal(fromRequest.body.data.length, 1);
    assert.equal(fromRequest.body.data[0].workRequestId, request.id);
  });

  it('returns 403 for an unknown building on list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/buildings/${randomUUID()}/work-orders`)
      .set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('update work order metadata', () => {
  it('updates title, description, and work type while OPEN', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-UPD-01',
      title: 'Original title',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/work-orders/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        title: 'Updated title',
        description: 'Updated notes',
        workType: 'CORRECTIVE',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.title, 'Updated title');
    assert.equal(response.body.data.description, 'Updated notes');
    assert.equal(response.body.data.workType, 'CORRECTIVE');
  });

  it('rejects an invalid update body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-UPD-2',
    });
    const response = await api()
      .patch(`/api/v1/work-orders/${created.body.data.id}`)
      .set(authHeaders())
      .send({ workType: 'lower case!!' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api().get(
      `/api/v1/buildings/${building.id}/work-orders`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createBuildingFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/work-orders`)
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
      .get(`/api/v1/buildings/${building.id}/work-orders`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /work-orders/:id routes across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createWorkOrderVia(building.id, client.id, {
      workOrderNumber: 'WO-ISO-01',
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/work-orders/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/work-orders/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ title: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies conversion when the caller cannot access the request building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    // The request lives in Building A (admin has access). An outsider admin
    // has no assignment to Building A and must not convert it.
    const { building, client } = await createBuildingFixture();
    const request = await createRequestVia(building.id, client.id);

    const outsider = await createAdminUser();
    const response = await api()
      .post(`/api/v1/work-requests/${request.id}/work-order`)
      .set(authHeaders(outsider.token))
      .send({
        workOrderNumber: 'WO-ISO-CONV',
        title: 'Hijack conversion',
        workType: 'REPAIR',
      });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('keeps a converted request intact across a failed duplicate conversion', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const request = await createRequestVia(building.id, client.id);

    const first = await api()
      .post(`/api/v1/work-requests/${request.id}/work-order`)
      .set(authHeaders())
      .send({
        workOrderNumber: 'WO-CONV-KEEP',
        title: 'First order',
        workType: 'REPAIR',
      });
    assert.equal(first.status, 201);

    const req = await api()
      .get(`/api/v1/work-requests/${request.id}`)
      .set(authHeaders());
    assert.equal(req.body.data.status, 'CONVERTED');
  });
});
