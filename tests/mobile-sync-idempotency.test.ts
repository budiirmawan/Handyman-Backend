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
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25H — Idempotency (focused contract tests).
 *
 * Verifies mobile retry/sync safety against duplicate execution:
 *   - idempotency key / client operation ID,
 *   - request/resource binding (stored key is bound to user + resource),
 *   - stored processing result/reference,
 *   - duplicate replay detection,
 *   - safe replay response (original result returned),
 *   - same operation id never executes the same write twice,
 *   - idempotency does NOT bypass validation, RBAC, data scope, or
 *     workflow rules,
 *   - no conflict handling yet (BE-25I).
 */

const DB_PORT = 55446;
const DATA_DIR = '/tmp/asentra-be25h-pg';
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
let otherToken = '';

let clientA = '';
let buildingA = '';
let clientB = '';
let templateA = '';
let itemA = '';
let executionA = '';
let executionB = '';
let taskA = '';
let taskCAssignmentId = '';
let taskC = '';
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
    code: `SD_H_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Idem Schedule',
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
  clientTimestamp = '2026-08-08T00:00:00.000Z',
): Record<string, unknown> {
  return { operationId, resourceType, resourceId, operation, clientTimestamp, data };
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

  const a = await createClientHierarchy('IDEM_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });
  const b = await createClientHierarchy('IDEM_B');
  clientB = b.clientId;

  // Admin profile + tasks.
  const chain = await createOrgChain(clientA, 'IDEM');
  profileId = await insertRow('workforce_profiles', {
    organization_id: chain.organizationId,
    department_id: chain.departmentId,
    team_id: chain.teamId,
    position_id: chain.positionId,
    user_id: adminUserId,
    employee_code: `IDEM_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: 'Idem Worker',
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  taskA = await createTask(clientA, buildingA, 'OPEN', 1);
  await insertRow('task_assignments', {
    task_id: taskA,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
  taskC = await createTask(clientA, buildingA, 'OPEN', 3);
  taskCAssignmentId = await insertRow('task_assignments', {
    task_id: taskC,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });

  // Checklist template/execution (client A).
  templateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_H_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Idem Template',
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

  // Cross-client execution B.
  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_HB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Idem Template B',
    status: 'ACTIVE',
  });
  executionB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: templateB,
    status: 'DRAFT',
  });

  // Second user (with task.manage + access to client A) for cross-user
  // operationId isolation.
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const password = 'OtherPass123';
  const other = await userService.createUser({
    email: `other-h-${suffix.toLowerCase()}@example.com`,
    displayName: 'Other H',
  });
  await credentialService.createInitialCredential({ userId: other.id, password });
  const { roleService } = await import('../src/modules/roles');
  const {
    permissionRepository,
    permissionService,
  } = await import('../src/modules/permissions');
  const role = await roleService.createRole({
    code: `OTH_H_${suffix}`,
    name: 'Other H Role',
  });
  let permission = await permissionRepository.findByCode('task.manage');
  if (!permission) {
    permission = await permissionService.createPermission({
      code: 'task.manage',
      name: 'Manage Tasks',
    });
  }
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(other.id, role.id);
  await buildingAssignmentService.createAssignment(other.id, {
    buildingId: buildingA,
  });
  const login = await api().post('/api/v1/auth/login').send({
    email: other.email,
    password,
  });
  otherToken = login.body.data.sessionToken as string;
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

describe('BE-25H idempotency — duplicate replay detection', () => {
  it('a retried operationId replays the original result without executing again', async () => {
    const evidenceOp = op(
      'idem-evidence-1',
      'EVIDENCE_SUBMISSION',
      executionA,
      'SUBMIT',
      {
        evidenceType: 'PHOTO',
        executionType: 'CHECKLIST_EXECUTION',
        executionId: executionA,
        fileReference: 'idem-1.jpg',
        originalFileName: 'idem-1.jpg',
        mimeType: 'image/jpeg',
        fileSize: 100,
      },
    );

    const first = await sync(adminToken, [evidenceOp]);
    const firstResult = first.body.data.results[0];
    assert.equal(firstResult.success, true);
    assert.equal(firstResult.status, 'SUCCESS');
    assert.ok(firstResult.result.id);

    // Retry in a NEW batch — same operationId.
    const replay = await sync(adminToken, [evidenceOp]);
    const replayResult = replay.body.data.results[0];
    assert.equal(replayResult.success, true);
    assert.equal(replayResult.status, 'SUCCESS');
    assert.equal(replayResult.result.id, firstResult.result.id, 'original result replayed');
    assert.ok(!Number.isNaN(Date.parse(replayResult.serverTimestamp)));

    // Only ONE submission row was created.
    const count = await q(
      'SELECT count(*)::int AS n FROM evidence_submissions WHERE execution_id = $1',
      [executionA],
    );
    assert.equal(count.rows[0].n, 1, 'same operation id must not write twice');
  });

  it('replays FAILED outcomes too (a retry does not re-run a failed write)', async () => {
    const badOp = op(
      'idem-bad-save',
      'CHECKLIST_RESPONSES',
      executionA,
      'SAVE',
      { responses: [{ itemId: id(), value: true }] }, // item of another template
    );

    const first = await sync(adminToken, [badOp]);
    assert.equal(first.body.data.results[0].success, false);
    assert.equal(first.body.data.results[0].error.code, 'BAD_REQUEST');

    const replay = await sync(adminToken, [badOp]);
    const replayResult = replay.body.data.results[0];
    assert.equal(replayResult.success, false);
    assert.equal(replayResult.status, 'FAILED');
    assert.equal(replayResult.error.code, 'BAD_REQUEST', 'original failure replayed');
  });

  it('replays the original task result after the resource moved on (safe replay)', async () => {
    const startOp = op('idem-task-start', 'TASK_EXECUTION', taskA, 'START');

    const first = await sync(adminToken, [startOp]);
    assert.equal(first.body.data.results[0].result.status, 'IN_PROGRESS');

    // Complete the task through the live endpoint (resource moved on).
    const completed = await api()
      .post(`/api/v1/tasks/${taskA}/complete`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ completionNotes: 'live' });
    assert.equal(completed.status, 200);

    // Retry the original start operationId — replay the ORIGINAL result
    // (IN_PROGRESS), never re-execute (which would fail anyway).
    const replay = await sync(adminToken, [startOp]);
    const replayResult = replay.body.data.results[0];
    assert.equal(replayResult.success, true);
    assert.equal(replayResult.result.status, 'IN_PROGRESS', 'original result replayed');
    const row = await q('SELECT status FROM generated_tasks WHERE id = $1', [taskA]);
    assert.equal(row.rows[0].status, 'COMPLETED', 'resource unchanged by replay');
  });

  it('stores the processing result/reference (bindings persisted)', async () => {
    const stored = (
      await q(
        `SELECT user_id, operation_id, resource_type, resource_id, operation,
                status, result, error_code
           FROM mobile_sync_idempotency
          WHERE operation_id = 'idem-task-start'`,
      )
    ).rows[0] as Record<string, unknown>;
    assert.equal(stored.user_id, adminUserId);
    assert.equal(stored.resource_type, 'TASK_EXECUTION');
    assert.equal(stored.resource_id, taskA);
    assert.equal(stored.operation, 'START');
    assert.equal(stored.status, 'SUCCESS');
    assert.ok(stored.result);
    assert.equal(stored.error_code, null);
  });
});

describe('BE-25H idempotency — key binding and authority (no bypass)', () => {
  it('operation ids are isolated per user (same id, different user → executes)', async () => {
    const opItem = op('shared-op-id', 'TASK_EXECUTION', taskC, 'START');

    const adminFirst = await sync(adminToken, [opItem]);
    assert.equal(adminFirst.body.data.results[0].success, true);

    // The other user uses the SAME operationId on THEIR OWN task... but they
    // are not the assignee, so the write must fail via workflow rules — and
    // it must EXECUTE (not replay admin's result), because the key is
    // bound per user.
    const otherResult = await sync(otherToken, [opItem]);
    assert.equal(otherResult.body.data.results[0].success, false);
    assert.equal(otherResult.body.data.results[0].error.code, 'BAD_REQUEST');
    const row = await q('SELECT status FROM generated_tasks WHERE id = $1', [taskC]);
    assert.equal(row.rows[0].status, 'IN_PROGRESS', 'admin write happened once');
  });

  it('a replay returns the ORIGINAL result even when the retried body differs', async () => {
    const taskD = await createTask(clientA, buildingA, 'OPEN', 4);
    await insertRow('task_assignments', {
      task_id: taskD,
      assignee_type: 'WORKFORCE',
      workforce_profile_id: profileId,
      team_id: null,
      assigned_by_user_id: adminUserId,
      status: 'ACTIVE',
    });

    // Execute on taskD with a fresh operationId.
    const first = await sync(adminToken, [
      op('idem-task-d', 'TASK_EXECUTION', taskD, 'START'),
    ]);
    assert.equal(first.body.data.results[0].result.id, taskD);

    // Retry the SAME operationId but with a different body/resource — the
    // key (user, operationId) wins: the original stored result is replayed
    // and taskD is not touched again.
    const replay = await sync(adminToken, [
      op('idem-task-d', 'TASK_EXECUTION', taskA, 'CANCEL'),
    ]);
    const replayResult = replay.body.data.results[0];
    assert.equal(replayResult.success, true);
    assert.equal(replayResult.result.id, taskD, 'original stored result replayed');
    const row = await q('SELECT status FROM generated_tasks WHERE id = $1', [taskD]);
    assert.equal(row.rows[0].status, 'IN_PROGRESS');
  });

  it('idempotency does not bypass data scope (cross-Client first execution fails and stores)', async () => {
    const crossOp = op(
      'idem-cross-client',
      'CHECKLIST_RESPONSES',
      executionB,
      'SAVE',
      { responses: [{ itemId: itemA, value: true }] },
    );
    const first = await sync(adminToken, [crossOp]);
    assert.equal(first.body.data.results[0].success, false);
    assert.equal(first.body.data.results[0].error.code, 'BUILDING_ACCESS_DENIED');

    const replay = await sync(adminToken, [crossOp]);
    assert.equal(replay.body.data.results[0].success, false);
    assert.equal(replay.body.data.results[0].error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('envelope violations are still rejected before any idempotency processing', async () => {
    const response = await sync(adminToken, [
      op('idem-invalid', 'TASK_EXECUTION', 'not-a-uuid', 'START'),
    ]);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});
