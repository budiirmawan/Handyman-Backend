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
  canTransitionWorkOrderStatus,
  isWorkOrderPriority,
  isWorkOrderStatus,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
} from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { closeWorkOrderVia } from './helpers/work-order-close';

/**
 * BE-08C — Work Order Priority / Status / Lifecycle focused tests.
 *
 * Covers priority and controlled lifecycle transitions only: set priority,
 * invalid priority rejected, valid transitions, invalid transitions rejected,
 * ON_HOLD → IN_PROGRESS, cancellation, terminal-state protection, lifecycle
 * timestamps, unknown Work Order, isolation, and RBAC. Asset/location binding,
 * assignment, execution, evidence, completion workflow, verification/rework/
 * closure logic, and audit/history belong to later BE-08 PARTs and are
 * deliberately absent here.
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
): Promise<{ id: string }> {
  const response = await api()
    .post(`/api/v1/buildings/${buildingId}/work-orders`)
    .set(authHeaders())
    .send({
      clientId,
      workOrderNumber: `WO_${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Test Work Order',
      workType: 'REPAIR',
    });
  assert.equal(response.status, 201);
  return response.body.data as { id: string };
}

async function setStatus(id: string, status: string, token = adminToken) {
  return api()
    .patch(`/api/v1/work-orders/${id}/status`)
    .set(authHeaders(token))
    .send({ status });
}

describe('priority and status value validation', () => {
  it('exposes the priority set in priority order', () => {
    assert.deepEqual(WORK_ORDER_PRIORITIES, [
      'LOW',
      'MEDIUM',
      'HIGH',
      'CRITICAL',
    ]);
    assert.equal(isWorkOrderPriority('HIGH'), true);
    assert.equal(isWorkOrderPriority('URGENT'), false);
  });

  it('exposes the lifecycle status set', () => {
    assert.deepEqual(WORK_ORDER_STATUSES, [
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'ON_HOLD',
      'COMPLETED',
      'CANCELLED',
      'CLOSED',
    ]);
    assert.equal(isWorkOrderStatus('ON_HOLD'), true);
    assert.equal(isWorkOrderStatus('DONE'), false);
  });

  it('defines the explicit allowed transitions', () => {
    assert.equal(canTransitionWorkOrderStatus('OPEN', 'ASSIGNED'), true);
    assert.equal(canTransitionWorkOrderStatus('ASSIGNED', 'IN_PROGRESS'), true);
    assert.equal(canTransitionWorkOrderStatus('IN_PROGRESS', 'COMPLETED'), true);
    // BE-08I: COMPLETED has no generic outgoing transition — rework and
    // closure are owned by the verification/close flow.
    assert.equal(canTransitionWorkOrderStatus('COMPLETED', 'CLOSED'), false);
    assert.equal(canTransitionWorkOrderStatus('COMPLETED', 'IN_PROGRESS'), false);
    assert.equal(canTransitionWorkOrderStatus('IN_PROGRESS', 'ON_HOLD'), true);
    assert.equal(canTransitionWorkOrderStatus('ON_HOLD', 'IN_PROGRESS'), true);
    // Reverse / forbidden transitions.
    assert.equal(canTransitionWorkOrderStatus('ASSIGNED', 'OPEN'), false);
    assert.equal(canTransitionWorkOrderStatus('CLOSED', 'OPEN'), false);
    assert.equal(canTransitionWorkOrderStatus('CANCELLED', 'OPEN'), false);
  });
});

describe('set priority', () => {
  it('sets priority on a work order and exposes it', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const defaultWo = await api()
      .get(`/api/v1/work-orders/${wo.id}`)
      .set(authHeaders());
    assert.equal(defaultWo.body.data.priority, 'MEDIUM');

    const response = await api()
      .patch(`/api/v1/work-orders/${wo.id}/priority`)
      .set(authHeaders())
      .send({ priority: 'HIGH' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.priority, 'HIGH');

    const updated = await api()
      .get(`/api/v1/work-orders/${wo.id}`)
      .set(authHeaders());
    assert.equal(updated.body.data.priority, 'HIGH');
  });

  it('rejects an invalid priority', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await api()
      .patch(`/api/v1/work-orders/${wo.id}/priority`)
      .set(authHeaders())
      .send({ priority: 'URGENT' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('valid lifecycle transitions', () => {
  it('walks OPEN → ASSIGNED → IN_PROGRESS → COMPLETED, then verify + close', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);

    const assigned = await setStatus(wo.id, 'ASSIGNED');
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.data.status, 'ASSIGNED');
    assert.ok(assigned.body.data.assignedAt);

    const started = await setStatus(wo.id, 'IN_PROGRESS');
    assert.equal(started.status, 200);
    assert.equal(started.body.data.status, 'IN_PROGRESS');
    assert.ok(started.body.data.startedAt);

    const completed = await setStatus(wo.id, 'COMPLETED');
    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.ok(completed.body.data.completedAt);

    // COMPLETED cannot close directly; it must be verified then closed.
    const directClose = await setStatus(wo.id, 'CLOSED');
    assert.equal(directClose.status, 400);
    assert.equal(directClose.body.error.code, 'WORK_ORDER_INVALID_TRANSITION');

    const closed = await closeWorkOrderVia(wo.id, adminToken);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.data.status, 'CLOSED');
  });

  it('supports ON_HOLD → IN_PROGRESS and preserves the original start time', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    await setStatus(wo.id, 'ASSIGNED');
    await setStatus(wo.id, 'IN_PROGRESS');
    const startedAt = (await api()
      .get(`/api/v1/work-orders/${wo.id}`)
      .set(authHeaders())).body.data.startedAt;

    const onHold = await setStatus(wo.id, 'ON_HOLD');
    assert.equal(onHold.status, 200);
    assert.equal(onHold.body.data.status, 'ON_HOLD');

    const resumed = await setStatus(wo.id, 'IN_PROGRESS');
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.data.status, 'IN_PROGRESS');
    // The original started_at is preserved across re-entry.
    assert.equal(resumed.body.data.startedAt, startedAt);
  });
});

describe('invalid transitions rejected', () => {
  it('rejects a reverse transition', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    await setStatus(wo.id, 'ASSIGNED');

    const response = await setStatus(wo.id, 'OPEN');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_INVALID_TRANSITION');
  });

  it('rejects a skip transition', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await setStatus(wo.id, 'COMPLETED');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_INVALID_TRANSITION');
  });

  it('rejects an invalid status value', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await setStatus(wo.id, 'DONE');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('cancellation behavior', () => {
  it('cancels from OPEN and is terminal', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);

    const cancelled = await setStatus(wo.id, 'CANCELLED');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.ok(cancelled.body.data.cancelledAt);

    // Terminal: no further transitions.
    const reopen = await setStatus(wo.id, 'OPEN');
    assert.equal(reopen.status, 400);
    assert.equal(reopen.body.error.code, 'WORK_ORDER_INVALID_TRANSITION');
  });

  it('cancels from IN_PROGRESS and from ON_HOLD', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo1 = await createWorkOrderVia(building.id, client.id);
    await setStatus(wo1.id, 'ASSIGNED');
    await setStatus(wo1.id, 'IN_PROGRESS');
    assert.equal((await setStatus(wo1.id, 'CANCELLED')).body.data.status, 'CANCELLED');

    const wo2 = await createWorkOrderVia(building.id, client.id);
    await setStatus(wo2.id, 'ASSIGNED');
    await setStatus(wo2.id, 'IN_PROGRESS');
    await setStatus(wo2.id, 'ON_HOLD');
    assert.equal((await setStatus(wo2.id, 'CANCELLED')).body.data.status, 'CANCELLED');
  });
});

describe('terminal-state protection', () => {
  it('COMPLETED can only close, never reopen or cancel', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    await setStatus(wo.id, 'ASSIGNED');
    await setStatus(wo.id, 'IN_PROGRESS');
    await setStatus(wo.id, 'COMPLETED');

    // COMPLETED cannot reopen or cancel via the generic status endpoint.
    assert.equal((await setStatus(wo.id, 'IN_PROGRESS')).status, 400);
    assert.equal((await setStatus(wo.id, 'CANCELLED')).status, 400);
    // Only an approved verification enables closure.
    assert.equal((await closeWorkOrderVia(wo.id, adminToken)).status, 200);
  });

  it('CLOSED rejects every transition', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    await setStatus(wo.id, 'ASSIGNED');
    await setStatus(wo.id, 'IN_PROGRESS');
    await setStatus(wo.id, 'COMPLETED');
    await closeWorkOrderVia(wo.id, adminToken);

    const response = await setStatus(wo.id, 'OPEN');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_INVALID_TRANSITION');
  });
});

describe('lifecycle timestamps', () => {
  it('exposes the relevant lifecycle timestamps', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);

    const fresh = await api()
      .get(`/api/v1/work-orders/${wo.id}`)
      .set(authHeaders());
    assert.equal(fresh.body.data.assignedAt, null);
    assert.equal(fresh.body.data.startedAt, null);
    assert.equal(fresh.body.data.completedAt, null);
    assert.equal(fresh.body.data.closedAt, null);
    assert.equal(fresh.body.data.cancelledAt, null);

    await setStatus(wo.id, 'ASSIGNED');
    await setStatus(wo.id, 'IN_PROGRESS');
    await setStatus(wo.id, 'COMPLETED');
    await closeWorkOrderVia(wo.id, adminToken);

    const done = await api()
      .get(`/api/v1/work-orders/${wo.id}`)
      .set(authHeaders());
    assert.ok(done.body.data.startedAt);
    assert.ok(done.body.data.completedAt);
    assert.ok(done.body.data.closedAt);
  });
});

describe('RBAC and isolation', () => {
  it('returns 404 for an unknown work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await setStatus(randomUUID(), 'ASSIGNED');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORK_ORDER_NOT_FOUND');
  });

  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await api()
      .patch(`/api/v1/work-orders/${wo.id}/status`)
      .send({ status: 'ASSIGNED' });
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);
    const response = await setStatus(wo.id, 'ASSIGNED', plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies priority/status changes across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building, client } = await createBuildingFixture();
    const wo = await createWorkOrderVia(building.id, client.id);

    const outsider = await createAdminUser();
    const statusResp = await setStatus(wo.id, 'ASSIGNED', outsider.token);
    assert.equal(statusResp.status, 403);
    assert.equal(statusResp.body.error.code, 'BUILDING_ACCESS_DENIED');

    const priorityResp = await api()
      .patch(`/api/v1/work-orders/${wo.id}/priority`)
      .set(authHeaders(outsider.token))
      .send({ priority: 'CRITICAL' });
    assert.equal(priorityResp.status, 403);
    assert.equal(priorityResp.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
