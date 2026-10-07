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
import {
  isValidRequestNumber,
  normalizeRequestNumber,
} from '../src/modules/purchase-requests';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17A — Purchase Request Foundation focused tests.
 *
 * Covers only Purchase Request intake: create, unique request number, unknown
 * Building, Client / Building mismatch, get, list/filter, update OPEN request,
 * cancel, terminal-state protection, cross-Client / cross-Building isolation,
 * and RBAC. Approval, vendor selection, purchase order, receiving, and
 * payment/accounting belong to later BE-17 PARTs and are deliberately not
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
    `TRUNCATE purchase_requests, users, roles, clients, properties, buildings CASCADE`,
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

async function createPurchaseRequestVia(
  buildingId: string,
  clientId: string,
  overrides?: Record<string, unknown>,
) {
  return api()
    .post(`/api/v1/buildings/${buildingId}/purchase-requests`)
    .set(authHeaders())
    .send({
      clientId,
      requestNumber: `PRQ_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Test Purchase Request',
      requestType: 'MATERIAL',
      ...overrides,
    });
}

const PUBLIC_PURCHASE_REQUEST_KEYS = [
  'buildingId',
  'clientId',
  'createdAt',
  'description',
  'id',
  'priority',
  'requestNumber',
  'requestType',
  'requestedAt',
  'requestedByUserId',
  'requesterReference',
  'requiredDate',
  'status',
  'title',
  'updatedAt',
];

describe('purchase request number validation', () => {
  it('normalizes request numbers to uppercase', () => {
    assert.equal(normalizeRequestNumber('  prq-ahu-01  '), 'PRQ-AHU-01');
  });

  it('accepts valid numbers and rejects malformed ones', () => {
    assert.equal(isValidRequestNumber('PRQ-AHU-01'), true);
    assert.equal(isValidRequestNumber('PRQ_01'), true);
    assert.equal(isValidRequestNumber('1PRQ'), false);
    assert.equal(isValidRequestNumber('P'), false);
    assert.equal(isValidRequestNumber('PRQ 01'), false);
  });
});

describe('create purchase request', () => {
  it('registers a request with derived client, default priority, and OPEN status', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const response = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-AHU-01',
      title: 'Spare air filter',
      description: 'Replacement AHU filter bank.',
      requestType: 'MATERIAL',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      PUBLIC_PURCHASE_REQUEST_KEYS,
    );
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.requestNumber, 'PRQ-AHU-01');
    assert.equal(response.body.data.title, 'Spare air filter');
    assert.equal(response.body.data.description, 'Replacement AHU filter bank.');
    assert.equal(response.body.data.requestType, 'MATERIAL');
    assert.equal(response.body.data.requestedByUserId, adminUserId);
    assert.equal(response.body.data.status, 'OPEN');
    assert.equal(response.body.data.priority, 'MEDIUM');
    assert.equal(response.body.data.requesterReference, null);
    assert.equal(response.body.data.requiredDate, null);
  });

  it('captures requester reference, required date, and priority', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const requiredDate = '2026-09-15T00:00:00.000Z';
    const response = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-REF-01',
      title: 'Lift service',
      requestType: 'SERVICE',
      requesterReference: 'ENG-OPS-101',
      requiredDate,
      priority: 'HIGH',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.requesterReference, 'ENG-OPS-101');
    assert.equal(response.body.data.requiredDate, requiredDate);
    assert.equal(response.body.data.priority, 'HIGH');
  });

  it('normalizes the request number and request type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const response = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: '  prq-pump-01  ',
      title: 'Chilled Water Pump',
      requestType: '  service  ',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.requestNumber, 'PRQ-PUMP-01');
    assert.equal(response.body.data.requestType, 'SERVICE');
  });

  it('rejects an invalid body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .post(`/api/v1/buildings/${building.id}/purchase-requests`)
      .set(authHeaders())
      .send({ title: 'Missing fields' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid priority value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const response = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-BADPRI',
      title: 'Bad priority',
      priority: 'URGENT',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid required date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const response = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-BADDATE',
      title: 'Bad date',
      requiredDate: 'not-a-date',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a duplicate request number within the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const first = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-DUP-01',
      title: 'First request',
    });
    assert.equal(first.status, 201);

    const second = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-DUP-01',
      title: 'Duplicate request',
    });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'PURCHASE_REQUEST_NUMBER_ALREADY_EXISTS',
    );
  });

  it('allows the same request number in a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: b1, client: c1 } = await createBuildingFixture();
    const first = await createPurchaseRequestVia(b1.id, c1.id, {
      requestNumber: 'PRQ-SHARED',
    });
    assert.equal(first.status, 201);

    const { building: b2, client: c2 } = await createBuildingFixture();
    const second = await createPurchaseRequestVia(b2.id, c2.id, {
      requestNumber: 'PRQ-SHARED',
    });
    assert.equal(second.status, 201);
  });

  it('returns 403 for an unknown building at the route level', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .post(`/api/v1/buildings/${randomUUID()}/purchase-requests`)
      .set(authHeaders())
      .send({
        clientId: randomUUID(),
        requestNumber: 'PRQ-NO-BLDG',
        title: 'No building',
        requestType: 'MATERIAL',
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

    const { purchaseRequestService } = await import(
      '../src/modules/purchase-requests'
    );
    const { client } = await createBuildingFixture();
    await assert.rejects(
      purchaseRequestService.createPurchaseRequest({
        clientId: client.id,
        buildingId: randomUUID(),
        requestNumber: 'PRQ-NO-BLDG-SVC',
        title: 'No building',
        requestType: 'MATERIAL',
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
      .post(`/api/v1/buildings/${building.id}/purchase-requests`)
      .set(authHeaders())
      .send({
        clientId: randomUUID(),
        requestNumber: 'PRQ-NO-CLIENT',
        title: 'No client',
        requestType: 'MATERIAL',
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
      .post(`/api/v1/buildings/${building.id}/purchase-requests`)
      .set(authHeaders())
      .send({
        clientId: foreign.id,
        requestNumber: 'PRQ-MISMATCH',
        title: 'Mismatch',
        requestType: 'MATERIAL',
      });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'PURCHASE_REQUEST_BUILDING_CLIENT_MISMATCH',
    );
  });
});

describe('get purchase request', () => {
  it('returns a purchase request by id', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-GET-01',
      title: 'Get me',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/purchase-requests/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.requestNumber, 'PRQ-GET-01');
  });

  it('returns 404 for an unknown purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/purchase-requests/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PURCHASE_REQUEST_NOT_FOUND');
  });
});

describe('list / filter purchase requests', () => {
  it('lists and filters by status, request type, requester, and priority', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-LIST-1',
      requestType: 'MATERIAL',
    });
    await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-LIST-2',
      requestType: 'MATERIAL',
      priority: 'HIGH',
    });
    await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-LIST-3',
      requestType: 'SERVICE',
    });

    const all = await api()
      .get(`/api/v1/buildings/${building.id}/purchase-requests`)
      .set(authHeaders());
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 3);

    const material = await api()
      .get(`/api/v1/buildings/${building.id}/purchase-requests?requestType=MATERIAL`)
      .set(authHeaders());
    assert.equal(material.status, 200);
    assert.equal(material.body.data.length, 2);

    const open = await api()
      .get(`/api/v1/buildings/${building.id}/purchase-requests?status=OPEN`)
      .set(authHeaders());
    assert.equal(open.status, 200);
    assert.equal(open.body.data.length, 3);

    const high = await api()
      .get(`/api/v1/buildings/${building.id}/purchase-requests?priority=HIGH`)
      .set(authHeaders());
    assert.equal(high.status, 200);
    assert.equal(high.body.data.length, 1);

    const requester = await api()
      .get(`/api/v1/buildings/${building.id}/purchase-requests?requesterUserId=${adminUserId}`)
      .set(authHeaders());
    assert.equal(requester.status, 200);
    assert.equal(requester.body.data.length, 3);
  });

  it('rejects an invalid status filter', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api()
      .get(`/api/v1/buildings/${building.id}/purchase-requests?status=INVALID`)
      .set(authHeaders());
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 403 for an unknown building on list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/buildings/${randomUUID()}/purchase-requests`)
      .set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('update open purchase request', () => {
  it('updates intake fields while OPEN', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-UPD-01',
      title: 'Original title',
    });
    assert.equal(created.status, 201);

    const requiredDate = '2026-10-01T00:00:00.000Z';
    const response = await api()
      .patch(`/api/v1/purchase-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        title: 'Updated title',
        description: 'Updated notes',
        requestType: 'SERVICE',
        requesterReference: 'OPS-REF-9',
        requiredDate,
        priority: 'CRITICAL',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.title, 'Updated title');
    assert.equal(response.body.data.description, 'Updated notes');
    assert.equal(response.body.data.requestType, 'SERVICE');
    assert.equal(response.body.data.requesterReference, 'OPS-REF-9');
    assert.equal(response.body.data.requiredDate, requiredDate);
    assert.equal(response.body.data.priority, 'CRITICAL');
  });

  it('clears optional fields with explicit null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-UPD-2',
      title: 'Clear me',
      requesterReference: 'REF-X',
      description: 'Some note',
      requiredDate: '2026-10-01T00:00:00.000Z',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/purchase-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ requesterReference: null, description: null, requiredDate: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.requesterReference, null);
    assert.equal(response.body.data.description, null);
    assert.equal(response.body.data.requiredDate, null);
  });

  it('rejects an invalid update body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-UPD-3',
    });
    const response = await api()
      .patch(`/api/v1/purchase-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ requestType: 'lower case!!' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('cancel purchase request', () => {
  it('cancels an open purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-CAN-01',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .post(`/api/v1/purchase-requests/${created.body.data.id}/cancel`)
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
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-CAN-UPD',
    });
    await api()
      .post(`/api/v1/purchase-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const response = await api()
      .patch(`/api/v1/purchase-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ title: 'Should fail' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'PURCHASE_REQUEST_NOT_OPEN');
  });

  it('cannot cancel an already-cancelled request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-CAN-CAN',
    });
    await api()
      .post(`/api/v1/purchase-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const second = await api()
      .post(`/api/v1/purchase-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'PURCHASE_REQUEST_NOT_OPEN');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api().get(
      `/api/v1/buildings/${building.id}/purchase-requests`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without purchase request permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createBuildingFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/purchase-requests`)
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
      .get(`/api/v1/buildings/${building.id}/purchase-requests`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies /purchase-requests/:id routes across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const created = await createPurchaseRequestVia(building.id, client.id, {
      requestNumber: 'PRQ-ISO-01',
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/purchase-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/purchase-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ title: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies a request from a different building (no assignment)', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: buildingA } = await createBuildingFixture();

    const ownerB = await createAdminUser();
    const { building: buildingB, client: clientB } = await createBuildingFixture({
      assignUserId: ownerB.userId,
    });
    const createdB = await api()
      .post(`/api/v1/buildings/${buildingB.id}/purchase-requests`)
      .set(authHeaders(ownerB.token))
      .send({
        clientId: clientB.id,
        requestNumber: 'PRQ-B-01',
        title: 'In building B',
        requestType: 'MATERIAL',
      });
    assert.equal(createdB.status, 201);

    // Admin (assigned only to Building A) must not read Building B's request.
    const read = await api()
      .get(`/api/v1/purchase-requests/${createdB.body.data.id}`)
      .set(authHeaders());
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
    void buildingA;
  });
});
