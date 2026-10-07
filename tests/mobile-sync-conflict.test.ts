import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25I — Conflict Handling (focused contract tests).
 *
 * Verifies mobile sync conflict safety:
 *   - detect stale client update (baseVersion < server updatedAt),
 *   - compare client/server version (equal or newer base → no conflict),
 *   - return conflict status (SYNC_CONFLICT) + current server state,
 *   - retry/reload guidance in the response contract,
 *   - never silently overwrite newer server data (write NOT executed),
 *   - no bypass of RBAC/data scope/workflow,
 *   - no automatic merge logic,
 *   - idempotency interplay (replay wins before conflict detection;
 *     conflicts are not stored).
 */

const DB_PORT = 55447;
const DATA_DIR = '/tmp/asentra-be25i-pg';
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

let clientA = '';
let buildingA = '';
let clientB = '';
let templateA = '';
let itemA = '';
let executionA = '';
let executionB = '';
let taskA = '';
let taskAssignmentId = '';
let taskB = ''; // for the fresh-base test
let taskC = ''; // dedicated OPEN task for replay tests
let profileId = '';

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

async function createClientHierarchy(prefix: string): Promise<{
  clientId: string;
  buildingId: string;
}> {
  const client = await clientService.createClient({
    code: `${prefix}_CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `${prefix}_PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `${prefix}_BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Building`,
  });
  return { clientId: client.id, buildingId: building.id };
}

async function createOrgChain(
  clientId: string,
  prefix: string,
): Promise<{ organizationId: string; departmentId: string; teamId: string; positionId: string }> {
  const organizationId = await insertRow('organizations', {
    client_id: clientId,
    code: `${prefix}_ORG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Org`,
    status: 'ACTIVE',
  });
  const departmentId = await insertRow('departments', {
    organization_id: organizationId,
    code: `${prefix}_DEPT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Dept`,
    status: 'ACTIVE',
  });
  const teamId = await insertRow('teams', {
    department_id: departmentId,
    code: `${prefix}_TEAM_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Team`,
    status: 'ACTIVE',
  });
  const positionId = await insertRow('positions', {
    organization_id: organizationId,
    code: `${prefix}_POS_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Position`,
    status: 'ACTIVE',
  });
  return { organizationId, departmentId, teamId, positionId };
}

async function createTask(
  clientId: string,
  buildingId: string | null,
  status: string,
  day: number,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_I_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Conflict Schedule',
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
    occurrence_at: `2026-08-0${day}T01:00:00Z`,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: scheduleId,
    building_id: buildingId,
    status,
  });
}

async function sync(token: string, operations: unknown[]): Promise<any> {
  return api()
    .post('/api/v1/mobile/sync')
    .set('Authorization', `Bearer ${token}`)
    .send({ operations });
}

function op(
  operationId: string,
  resourceType: string,
  resourceId: string,
  operation: string,
  data: Record<string, unknown> = {},
  clientTimestamp = '2026-08-09T00:00:00.000Z',
): Record<string, unknown> {
  return { operationId, resourceType, resourceId, operation, clientTimestamp, data };
}

/** Current updatedAt of a row. */
async function updatedAt(table: string, column: string, rowId: string): Promise<string> {
  const row = await q(`SELECT ${column} FROM ${table} WHERE id = $1`, [rowId]);
  return new Date(row.rows[0][column]).toISOString();
}

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
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, organizations, departments, teams, positions,
      workforce_profiles, schedule_definitions, generated_tasks,
      task_assignments, checklist_templates, checklist_items,
      checklist_executions, checklist_item_responses, evidence_requirements,
      evidence_submissions, mobile_sync_idempotency
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await createClientHierarchy('CONF_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });
  const b = await createClientHierarchy('CONF_B');
  clientB = b.clientId;

  const chain = await createOrgChain(clientA, 'CONF');
  profileId = await insertRow('workforce_profiles', {
    organization_id: chain.organizationId,
    department_id: chain.departmentId,
    team_id: chain.teamId,
    position_id: chain.positionId,
    user_id: adminUserId,
    employee_code: `CONF_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: 'Conflict Worker',
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  taskA = await createTask(clientA, buildingA, 'OPEN', 1);
  taskAssignmentId = await insertRow('task_assignments', {
    task_id: taskA,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
  taskB = await createTask(clientA, buildingA, 'OPEN', 2);
  await insertRow('task_assignments', {
    task_id: taskB,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
  taskC = await createTask(clientA, buildingA, 'OPEN', 4);
  await insertRow('task_assignments', {
    task_id: taskC,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });

  templateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_I_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Conflict Template',
    status: 'ACTIVE',
  });
  itemA = await insertRow('checklist_items', {
    checklist_template_id: templateA,
    code: 'CHK',
    label: 'Check',
    item_type: 'CHECK',
    required: true,
    display_order: 0,
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateA,
    status: 'DRAFT',
  });

  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_IB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Conflict Template B',
    status: 'ACTIVE',
  });
  executionB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: templateB,
    status: 'DRAFT',
  });
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

describe('BE-25I conflict handling — stale client update detection', () => {
  it('blocks a stale task update and returns SYNC_CONFLICT with current state + guidance', async () => {
    // Server side moves the task first (e.g. another device started it).
    const serverStart = await api()
      .post(`/api/v1/tasks/${taskA}/start`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(serverStart.status, 200);

    const staleBase = new Date(Date.now() - 60_000).toISOString();
    const response = await sync(adminToken, [
      op('conf-task-1', 'TASK_EXECUTION', taskA, 'START', {
        baseVersion: staleBase,
      }),
    ]);
    const result = response.body.data.results[0];

    assert.equal(result.success, false);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error.code, 'SYNC_CONFLICT');
    assert.ok(result.error.message);

    // Current server state/reference returned.
    assert.ok(result.error.conflict);
    assert.equal(result.error.conflict.current.id, taskA);
    assert.equal(result.error.conflict.current.status, 'IN_PROGRESS');
    assert.ok(result.error.conflict.current.updatedAt);

    // Retry/reload guidance.
    assert.equal(result.error.conflict.guidance.action, 'reload');
    assert.equal(result.error.conflict.guidance.reloadEndpoint, `/tasks/${taskA}`);
    assert.ok(result.error.conflict.guidance.message);

    // The write was NOT executed (still IN_PROGRESS from the server action,
    // not re-started/overwritten).
    const row = await q('SELECT status FROM generated_tasks WHERE id = $1', [taskA]);
    assert.equal(row.rows[0].status, 'IN_PROGRESS');
  });

  it('allows the update when baseVersion equals the current server version', async () => {
    const base = await updatedAt('generated_tasks', 'updated_at', taskB);
    const response = await sync(adminToken, [
      op('conf-task-fresh', 'TASK_EXECUTION', taskB, 'START', {
        baseVersion: base,
      }),
    ]);
    const result = response.body.data.results[0];
    assert.equal(result.success, true);
    assert.equal(result.result.status, 'IN_PROGRESS');
  });

  it('detects a stale checklist response save and returns the current execution state', async () => {
    // Server side saves a response first.
    const serverSave = await api()
      .put(`/api/v1/checklist-executions/${executionA}/responses`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([{ itemId: itemA, value: true }]);
    assert.equal(serverSave.status, 200);

    const staleBase = new Date(Date.now() - 60_000).toISOString();
    const response = await sync(adminToken, [
      op('conf-checklist-1', 'CHECKLIST_RESPONSES', executionA, 'SAVE', {
        responses: [{ itemId: itemA, value: false }],
        baseVersion: staleBase,
      }),
    ]);
    const result = response.body.data.results[0];
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SYNC_CONFLICT');
    assert.equal(result.error.conflict.current.id, executionA);
    assert.equal(result.error.conflict.current.status, 'DRAFT');
    assert.equal(
      result.error.conflict.guidance.reloadEndpoint,
      `/mobile/checklist-executions/${executionA}`,
    );

    // The stale value was NOT written.
    const saved = await q(
      'SELECT value FROM checklist_item_responses WHERE checklist_execution_id = $1',
      [executionA],
    );
    assert.equal(saved.rows[0].value, true, 'server value preserved');
  });

  it('blocks a stale assignment update and returns the current assignment state', async () => {
    const staleBase = new Date(Date.now() - 60_000).toISOString();
    const response = await sync(adminToken, [
      op('conf-assignment-1', 'TASK_ASSIGNMENT', taskA, 'UPDATE', {
        assignmentId: taskAssignmentId,
        status: 'INACTIVE',
        baseVersion: staleBase,
      }),
    ]);
    const result = response.body.data.results[0];
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SYNC_CONFLICT');
    assert.equal(result.error.conflict.current.assignmentId, taskAssignmentId);
    assert.ok(result.error.conflict.current.assignmentUpdatedAt);
    assert.equal(
      result.error.conflict.guidance.reloadEndpoint,
      `/tasks/${taskA}/assignments`,
    );

    const row = await q('SELECT status FROM task_assignments WHERE id = $1', [
      taskAssignmentId,
    ]);
    assert.equal(row.rows[0].status, 'ACTIVE', 'assignment not overwritten');
  });

  it('treats an invalid baseVersion as a conflict (reload instead of blind write)', async () => {
    const response = await sync(adminToken, [
      op('conf-invalid-base', 'TASK_EXECUTION', taskB, 'CANCEL', {
        baseVersion: 'not-a-date',
      }),
    ]);
    const result = response.body.data.results[0];
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'SYNC_CONFLICT');
    assert.ok(result.error.conflict.current);
    const row = await q('SELECT status FROM generated_tasks WHERE id = $1', [taskB]);
    assert.equal(row.rows[0].status, 'IN_PROGRESS', 'write not executed');
  });
});

describe('BE-25I conflict handling — authority and idempotency interplay', () => {
  it('does not bypass data scope: cross-Client baseVersion reads are denied, not conflicted', async () => {
    const base = await updatedAt('checklist_executions', 'updated_at', executionA);
    const response = await sync(adminToken, [
      op('conf-cross-client', 'CHECKLIST_RESPONSES', executionB, 'SAVE', {
        responses: [{ itemId: itemA, value: true }],
        baseVersion: base,
      }),
    ]);
    const result = response.body.data.results[0];
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('a replayed operationId returns the stored result before conflict detection', async () => {
    const base = await updatedAt('generated_tasks', 'updated_at', taskC);
    const replayOp = op('conf-replay-1', 'TASK_EXECUTION', taskC, 'START', {
      baseVersion: base,
    });

    const first = await sync(adminToken, [replayOp]);
    assert.equal(first.body.data.results[0].success, true);

    // Retry with a STALE baseVersion — the idempotency replay wins and the
    // original success is returned (conflict detection never runs).
    const stale = op('conf-replay-1', 'TASK_EXECUTION', taskC, 'START', {
      baseVersion: new Date(Date.now() - 60_000).toISOString(),
    });
    const replay = await sync(adminToken, [stale]);
    const result = replay.body.data.results[0];
    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assert.equal(result.result.status, 'IN_PROGRESS');
  });

  it('conflicts are not stored: a corrected retry with a fresh operationId executes', async () => {
    const freshBase = await updatedAt('generated_tasks', 'updated_at', taskB);

    // First attempt with a stale base → conflict.
    const stale = await sync(adminToken, [
      op('conf-correct-1', 'TASK_EXECUTION', taskB, 'CANCEL', {
        baseVersion: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    assert.equal(stale.body.data.results[0].error.code, 'SYNC_CONFLICT');

    // No idempotency row was stored for the conflict.
    const stored = await q(
      `SELECT count(*)::int AS n FROM mobile_sync_idempotency WHERE operation_id = 'conf-correct-1'`,
    );
    assert.equal(stored.rows[0].n, 0);

    // Corrected retry with the CURRENT base and a fresh operationId → executes.
    const corrected = await sync(adminToken, [
      op('conf-correct-2', 'TASK_EXECUTION', taskB, 'CANCEL', {
        baseVersion: freshBase,
      }),
    ]);
    assert.equal(corrected.body.data.results[0].success, true);
    assert.equal(corrected.body.data.results[0].result.status, 'CANCELLED');
  });

  it('no automatic merge: the conflict payload never contains a merged result', async () => {
    const stale = await sync(adminToken, [
      op('conf-no-merge', 'TASK_EXECUTION', taskA, 'COMPLETE', {
        baseVersion: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    const result = stale.body.data.results[0];
    assert.equal(result.error.code, 'SYNC_CONFLICT');
    assert.equal(result.result, null, 'no merged write result');
    assert.equal(result.error.conflict.guidance.action, 'reload');
  });
});
