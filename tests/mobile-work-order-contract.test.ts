import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser, createPlainSession, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-CONTRACT-01 PART 03 — Task & Work Order Mobile Read Contract.
 *
 * Verifies the backend-authoritative Task/Work Order READ surface is
 * published in OpenAPI and that the runtime enforces the documented RBAC and
 * Building-isolation behavior deterministically. `availableActions` is NOT
 * exposed by the single-resource reads — it comes from GET /mobile/assignments.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const DB_PORT = 55444;
const DATA_DIR = '/tmp/asentra-mob-wo-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE work_orders, work_order_assignments, work_order_actions,
       schedule_definitions, generated_tasks, task_assignments,
       user_credentials, users, roles, permissions, clients, properties,
       buildings, user_building_assignments CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

async function createHierarchy(
  assignUserId: string | null,
): Promise<{ clientId: string; buildingId: string }> {
  const client = await clientService.createClient({
    code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'WO Contract Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'WO Contract Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'WO Contract Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(
      assignUserId,
      { buildingId: building.id },
      assignUserId,
    );
  }
  return { clientId: client.id, buildingId: building.id };
}

async function createWorkOrder(
  clientId: string,
  buildingId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return insertRow('work_orders', {
    client_id: clientId,
    building_id: buildingId,
    work_order_number: `WO-${randomUUID().slice(0, 8).toUpperCase()}`,
    title: 'Contract Work Order',
    work_type: 'CORRECTIVE',
    status: 'OPEN',
    created_by_user_id: adminUserId,
    ...extra,
  });
}

async function createTask(
  clientId: string,
  buildingId: string | null,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Contract Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: id(),
    building_id: buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientId,
    schedule_definition_id: scheduleId,
    occurrence_at: '2026-08-02T01:00:00Z',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: scheduleId,
    building_id: buildingId,
    status: 'OPEN',
  });
}

function loadSpec(): Record<string, any> {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
}

// --------------------------------------------------------------------------
// Layer 1 — OpenAPI contract (no database)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 03 — Task/Work Order OpenAPI contract', () => {
  const spec = loadSpec();

  const WO_READ_PATHS = [
    '/buildings/{buildingId}/work-orders',
    '/work-orders/{workOrderId}',
    '/work-orders/{workOrderId}/assignments',
    '/work-orders/{workOrderId}/assignments/current',
    '/work-orders/{workOrderId}/actions',
    '/work-orders/{workOrderId}/context',
    '/work-orders/{workOrderId}/completion',
    '/tasks/{taskId}/assignments',
  ];

  it('publishes the Work Order + Task read paths with bearer security', () => {
    for (const path of WO_READ_PATHS) {
      const op = spec.paths?.[path]?.get;
      assert.ok(op, `GET ${path} must be documented`);
      assert.ok(
        Array.isArray(op.security) &&
          op.security.some((s: Record<string, unknown>) => 'bearerAuth' in s),
        `GET ${path} must require bearerAuth`,
      );
    }
  });

  it('publishes the Work Order schema with authoritative status/priority', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.WorkOrder, 'WorkOrder schema required');
    assert.ok(schemas.WorkOrder.required.includes('status'));
    assert.ok(schemas.WorkOrder.required.includes('buildingId'));
    assert.ok(schemas.WorkOrder.required.includes('priority'));
    assert.ok(schemas.WorkOrder.required.includes('assetId'));
    assert.ok(schemas.WorkOrder.required.includes('functionalLocationId'));

    assert.deepEqual(schemas.WorkOrderStatus.enum, [
      'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'CLOSED',
    ]);
    assert.deepEqual(schemas.WorkOrderPriority.enum, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  });

  it('publishes assignment / action / context / completion schemas', () => {
    const schemas = spec.components.schemas;

    assert.ok(schemas.WorkOrderAssignment, 'WorkOrderAssignment required');
    assert.deepEqual(
      [...schemas.WorkOrderAssignment.required].sort(),
      ['assignedAt', 'assignedByUserId', 'assigneeType', 'id', 'status',
       'teamId', 'vendorId', 'workOrderId', 'workforceProfileId'],
    );
    assert.deepEqual(schemas.WorkOrderAssigneeType.enum, [
      'WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE',
    ]);

    assert.ok(schemas.WorkOrderAction, 'WorkOrderAction required');
    assert.ok(schemas.WorkOrderContext, 'WorkOrderContext required');
    assert.ok(schemas.WorkOrderCompletion, 'WorkOrderCompletion required');
    assert.ok(
      schemas.WorkOrderContext.properties.asset.nullable === true,
      'context.asset is nullable',
    );
  });

  it('documents /work-orders/:id/actions as history (not available-actions)', () => {
    const op = spec.paths['/work-orders/{workOrderId}/actions'].get;
    assert.match(op.description, /NOT an available-actions/);
    // The authoritative availableActions for Work Orders is the BE-25C feed.
    assert.ok(spec.paths['/mobile/assignments'], 'GET /mobile/assignments must remain documented');
  });
});

// --------------------------------------------------------------------------
// Layer 2 — runtime read + isolation (embedded PostgreSQL)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 03 — Task/Work Order runtime contract', () => {
  it('reads a Work Order and its location/asset context', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const wo = await createWorkOrder(clientId, buildingId);

    const detail = await api()
      .get(`${API_PREFIX}/work-orders/${wo}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.buildingId, buildingId);
    assert.equal(detail.body.data.status, 'OPEN');
    assert.ok('workOrderNumber' in detail.body.data);
    assert.ok('priority' in detail.body.data);

    const context = await api()
      .get(`${API_PREFIX}/work-orders/${wo}/context`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(context.status, 200);
    assert.equal(context.body.data.workOrderId, wo);
    assert.equal(context.body.data.buildingId, buildingId);
  });

  it('lists Work Orders for an accessible Building', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    await createWorkOrder(clientId, buildingId);
    await createWorkOrder(clientId, buildingId, { status: 'IN_PROGRESS' });

    const list = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/work-orders`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);

    const filtered = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/work-orders?status=IN_PROGRESS`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(filtered.body.data.length, 1);
  });

  it('reads assignments, current assignment, actions and completion', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const wo = await createWorkOrder(clientId, buildingId);

    const assignments = await api()
      .get(`${API_PREFIX}/work-orders/${wo}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(assignments.status, 200);
    assert.deepEqual(assignments.body.data, []);

    const current = await api()
      .get(`${API_PREFIX}/work-orders/${wo}/assignments/current`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(current.status, 200);
    assert.equal(current.body.data, null);

    const actions = await api()
      .get(`${API_PREFIX}/work-orders/${wo}/actions`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(actions.status, 200);
    assert.deepEqual(actions.body.data, []);

    const completion = await api()
      .get(`${API_PREFIX}/work-orders/${wo}/completion`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(completion.status, 200);
    assert.equal(completion.body.data.workOrderId, wo);
    assert.equal(completion.body.data.status, 'OPEN');
  });

  it('returns the assigned personnel for a task', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const taskId = await createTask(clientId, buildingId);

    // Org → Department → Team → Position → Workforce Profile (BE-03).
    const orgId = await insertRow('organizations', {
      client_id: clientId,
      code: `ORG_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Contract Org',
      status: 'ACTIVE',
    });
    const deptId = await insertRow('departments', {
      organization_id: orgId,
      code: `DEPT_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Contract Dept',
      status: 'ACTIVE',
    });
    const teamId = await insertRow('teams', {
      department_id: deptId,
      code: `TEAM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Contract Team',
      status: 'ACTIVE',
    });
    const posId = await insertRow('positions', {
      organization_id: orgId,
      code: `POS_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Contract Position',
      status: 'ACTIVE',
    });
    const profileId = await insertRow('workforce_profiles', {
      organization_id: orgId,
      department_id: deptId,
      team_id: teamId,
      position_id: posId,
      user_id: adminUserId,
      employee_code: `EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
      full_name: 'Contract Worker',
      workforce_type: 'INTERNAL',
      status: 'ACTIVE',
    });

    await insertRow('task_assignments', {
      task_id: taskId,
      assignee_type: 'WORKFORCE',
      workforce_profile_id: profileId,
      team_id: null,
      assigned_by_user_id: adminUserId,
      status: 'ACTIVE',
    });

    const assignments = await api()
      .get(`${API_PREFIX}/tasks/${taskId}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(assignments.status, 200);
    assert.equal(assignments.body.data.length, 1);
    assert.equal(assignments.body.data[0].taskId, taskId);
    assert.equal(assignments.body.data[0].assigneeType, 'WORKFORCE');
    assert.equal(assignments.body.data[0].workforceProfileId, profileId);
  });

  it('denies a Work Order read without work_order.read (403 PERMISSION_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const wo = await createWorkOrder(clientId, buildingId);
    const token = await createPlainSession();

    const response = await api()
      .get(`${API_PREFIX}/work-orders/${wo}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies cross-Building Work Order access (403 BUILDING_ACCESS_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { clientId, buildingId } = await createHierarchy(adminUserId);
    const wo = await createWorkOrder(clientId, buildingId);
    // Caller holds work_order.read but has NO assignment to the Building.
    const token = await createSessionWithPermissions([
      { code: 'work_order.read', name: 'Read Work Orders' },
    ]);

    const response = await api()
      .get(`${API_PREFIX}/work-orders/${wo}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies the cross-Building list route (403 BUILDING_ACCESS_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { buildingId } = await createHierarchy(adminUserId);
    const token = await createSessionWithPermissions([
      { code: 'work_order.read', name: 'Read Work Orders' },
    ]);

    const response = await api()
      .get(`${API_PREFIX}/buildings/${buildingId}/work-orders`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
