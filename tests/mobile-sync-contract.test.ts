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
import { roleService } from '../src/modules/roles';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25G — Offline Sync Contract (focused contract tests).
 *
 * Verifies the mobile offline sync batch:
 *   - sync batch request (operationId / resourceType / resourceId /
 *     operation / clientTimestamp / data),
 *   - server result/status + server timestamp per item,
 *   - per-item success/failure (a failing item never blocks the batch),
 *   - task/execution updates, checklist responses, evidence metadata,
 *     assignment updates — executed through the SAME services as the REST
 *     endpoints (identical validation, RBAC, data scope, workflow),
 *   - envelope validation (400 before any write),
 *   - no idempotency yet (operation identifiers carried/echoed only).
 */

const DB_PORT = 55445;
const DATA_DIR = '/tmp/asentra-be25g-pg';
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
let readOnlyToken = '';

let clientA = '';
let buildingA = '';
let clientB = '';
let templateA = '';
let itemA = '';
let executionA = ''; // client A DRAFT
let executionB = ''; // client B DRAFT (cross-scope)
let taskA = '';
let taskAssignmentId = '';
let taskB = ''; // task assigned to another user (workflow denial)
let taskC = ''; // dedicated task for the assignment-update op
let taskCAssignmentId = '';
let executionDup = ''; // dedicated execution for the no-idempotency test
let reqPhoto = '';
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

async function createUserWithPermissions(
  codes: { code: string; name: string }[],
  emailPrefix: string,
): Promise<{ token: string; userId: string }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const password = 'SyncPass123';
  const user = await userService.createUser({
    email: `${emailPrefix}-${suffix.toLowerCase()}@example.com`,
    displayName: 'Sync User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${emailPrefix.toUpperCase()}_${suffix}`,
    name: 'Sync Role',
  });
  for (const code of codes) {
    let permission = await permissionRepository.findByCode(code.code);
    if (!permission) {
      permission = await permissionService.createPermission(code);
    }
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function createTask(
  clientId: string,
  buildingId: string | null,
  status: string,
  day: number,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_G_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Sync Schedule',
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
  clientTimestamp = '2026-08-07T00:00:00.000Z',
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
      evidence_submissions
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await createClientHierarchy('SYNC_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });
  const b = await createClientHierarchy('SYNC_B');
  clientB = b.clientId;

  // Admin profile + tasks.
  const chain = await createOrgChain(clientA, 'SYNC');
  profileId = await insertRow('workforce_profiles', {
    organization_id: chain.organizationId,
    department_id: chain.departmentId,
    team_id: chain.teamId,
    position_id: chain.positionId,
    user_id: adminUserId,
    employee_code: `SYNC_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: 'Sync Worker',
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
  taskC = await createTask(clientA, buildingA, 'OPEN', 3);
  taskCAssignmentId = await insertRow('task_assignments', {
    task_id: taskC,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });

  // Template + execution A (client A) with one item.
  templateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_G_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Sync Template',
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

  // Dedicated execution for the no-idempotency test (clean evidence count).
  executionDup = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateA,
    status: 'DRAFT',
  });

  // Cross-client execution B.
  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_GB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Sync Template B',
    status: 'ACTIVE',
  });
  executionB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: templateB,
    status: 'DRAFT',
  });

  // Evidence requirement in client A.
  reqPhoto = await insertRow('evidence_requirements', {
    client_id: clientA,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
    maximum_count: 2,
    description: 'Photo',
    status: 'ACTIVE',
  });

  // A task assigned to ANOTHER user (workflow denial for the read-only user).
  taskB = await createTask(clientA, buildingA, 'OPEN', 2);
  const otherUser = await userService.createUser({
    email: `other-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
    displayName: 'Other',
  });
  await credentialService.createInitialCredential({
    userId: otherUser.id,
    password: 'OtherPass123',
  });
  const otherChain = await createOrgChain(clientA, 'OTH');
  const otherProfile = await insertRow('workforce_profiles', {
    organization_id: otherChain.organizationId,
    department_id: otherChain.departmentId,
    team_id: otherChain.teamId,
    position_id: otherChain.positionId,
    user_id: otherUser.id,
    employee_code: `OTH_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: 'Other Worker',
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  await insertRow('task_assignments', {
    task_id: taskB,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: otherProfile,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });

  // Read-only user (all read permissions, no manage) with a profile in
  // client A and access to building A.
  const readOnly = await createUserWithPermissions(
    [
      { code: 'task.read', name: 'Read Tasks' },
      { code: 'checklist.read', name: 'Read Checklists' },
      { code: 'evidence.read', name: 'Read Evidence' },
    ],
    'syncro',
  );
  readOnlyToken = readOnly.token;
  await buildingAssignmentService.createAssignment(readOnly.userId, {
    buildingId: buildingA,
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

describe('BE-25G offline sync — batch contract', () => {
  it('executes a mixed batch with per-item results, server status and timestamps', async () => {
    const response = await sync(adminToken, [
      op('op-task-start', 'TASK_EXECUTION', taskA, 'START'),
      op('op-checklist-save', 'CHECKLIST_RESPONSES', executionA, 'SAVE', {
        responses: [{ itemId: itemA, value: true }],
      }),
      op('op-evidence', 'EVIDENCE_SUBMISSION', executionA, 'SUBMIT', {
        evidenceType: 'PHOTO',
        executionType: 'CHECKLIST_EXECUTION',
        executionId: executionA,
        evidenceRequirementId: reqPhoto,
        fileReference: 'offline-ref-1',
        originalFileName: 'offline.jpg',
        mimeType: 'image/jpeg',
        fileSize: 100,
        capturedAt: '2026-08-07T01:00:00Z',
      }),
      op('op-assignment', 'TASK_ASSIGNMENT', taskC, 'UPDATE', {
        assignmentId: taskCAssignmentId,
        status: 'INACTIVE',
      }),
    ]);
    assert.equal(response.status, 200);
    const batch = response.body.data;

    assert.ok(batch.batchId);
    assert.ok(!Number.isNaN(Date.parse(batch.receivedAt)));
    assert.equal(batch.results.length, 4);

    for (const result of batch.results) {
      assert.ok(result.operationId);
      assert.equal(result.clientTimestamp, '2026-08-07T00:00:00.000Z');
      assert.ok(!Number.isNaN(Date.parse(result.serverTimestamp)));
    }

    const taskResult = batch.results.find(
      (r: any) => r.operationId === 'op-task-start',
    );
    assert.equal(taskResult.success, true);
    assert.equal(taskResult.status, 'SUCCESS');
    assert.equal(taskResult.error, null);
    assert.equal(taskResult.result.status, 'IN_PROGRESS');
    assert.equal(taskResult.result.id, taskA);

    const checklistResult = batch.results.find(
      (r: any) => r.operationId === 'op-checklist-save',
    );
    assert.equal(checklistResult.success, true);
    assert.deepEqual(checklistResult.result, {});

    const evidenceResult = batch.results.find(
      (r: any) => r.operationId === 'op-evidence',
    );
    assert.equal(evidenceResult.success, true);
    assert.equal(evidenceResult.result.evidenceType, 'PHOTO');
    assert.equal(evidenceResult.result.executionId, executionA);
    assert.equal(evidenceResult.result.fileReference, 'offline-ref-1');

    const assignmentResult = batch.results.find(
      (r: any) => r.operationId === 'op-assignment',
    );
    assert.equal(assignmentResult.success, true);
    assert.equal(assignmentResult.result.status, 'INACTIVE');

    // The writes actually landed (via the shared services).
    const taskRow = await q('SELECT status FROM generated_tasks WHERE id = $1', [taskA]);
    assert.equal(taskRow.rows[0].status, 'IN_PROGRESS');
    const responseRow = await q(
      'SELECT value FROM checklist_item_responses WHERE checklist_execution_id = $1',
      [executionA],
    );
    assert.equal(responseRow.rows[0].value, true);
    const evidenceRow = await q(
      'SELECT count(*)::int AS n FROM evidence_submissions WHERE execution_id = $1',
      [executionA],
    );
    assert.equal(evidenceRow.rows[0].n, 1);
  });

  it('keeps executing the rest of the batch when an item fails (per-item failure)', async () => {
    // Invalid checklist save (item of another template) + valid task complete.
    const response = await sync(adminToken, [
      op('op-bad-save', 'CHECKLIST_RESPONSES', executionA, 'SAVE', {
        responses: [{ itemId: id(), value: true }],
      }),
      op('op-good-complete', 'TASK_EXECUTION', taskA, 'COMPLETE', {
        completionNotes: 'done offline',
      }),
    ]);
    assert.equal(response.status, 200);
    const results = response.body.data.results;
    assert.equal(results.length, 2);

    const failed = results.find((r: any) => r.operationId === 'op-bad-save');
    assert.equal(failed.success, false);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.result, null);
    assert.equal(failed.error.code, 'BAD_REQUEST');

    const succeeded = results.find(
      (r: any) => r.operationId === 'op-good-complete',
    );
    assert.equal(succeeded.success, true);
    assert.equal(succeeded.result.status, 'COMPLETED');
    assert.equal(succeeded.result.completionNotes, 'done offline');
  });

  it('rejects envelope violations with 400 VALIDATION_ERROR before any write', async () => {
    const cases: unknown[][] = [
      [],
      [{ operationId: 'ok', resourceType: 'TASK_EXECUTION', resourceId: taskA, operation: 'START' }], // missing clientTimestamp/data
      [op('bad op id!', 'TASK_EXECUTION', taskA, 'START')], // invalid operationId chars
      [op('op1', 'TASK_EXECUTION', 'not-a-uuid', 'START')],
      [op('op1', 'TASK_EXECUTION', taskA, 'SAVE')], // operation not valid for type
      [op('op1', 'UNKNOWN_TYPE', taskA, 'START')],
      [op('op1', 'EVIDENCE_SUBMISSION', executionA, 'SUBMIT', {
        executionId: id(), // mismatch with resourceId
      })],
      [op('op1', 'TASK_ASSIGNMENT', taskA, 'UPDATE', {})], // missing assignmentId
    ];
    for (const operations of cases) {
      const response = await sync(adminToken, operations);
      assert.equal(response.status, 400, JSON.stringify(operations));
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(response.body.error.details));
    }

    // Batch size cap.
    const tooMany = Array.from({ length: 101 }, (_, i) =>
      op(`op-${i}`, 'TASK_EXECUTION', taskA, 'START'),
    );
    const capped = await sync(adminToken, tooMany);
    assert.equal(capped.status, 400);
    assert.equal(capped.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-25G offline sync — RBAC, data scope, workflow (not bypassed)', () => {
  it('rejects operations the caller lacks permission for (per-item PERMISSION_DENIED)', async () => {
    const response = await sync(readOnlyToken, [
      op('ro-task', 'TASK_EXECUTION', taskA, 'START'),
      op('ro-checklist', 'CHECKLIST_RESPONSES', executionA, 'SAVE', {
        responses: [{ itemId: itemA, value: true }],
      }),
    ]);
    assert.equal(response.status, 200);
    for (const result of response.body.data.results) {
      assert.equal(result.success, false);
      assert.equal(result.error.code, 'PERMISSION_DENIED');
    }
  });

  it('rejects cross-Client writes (data scope preserved)', async () => {
    const response = await sync(adminToken, [
      op('x-client-checklist', 'CHECKLIST_RESPONSES', executionB, 'SAVE', {
        responses: [{ itemId: itemA, value: true }],
      }),
    ]);
    const result = response.body.data.results[0];
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects workflow-invalid operations (assignee + state rules preserved)', async () => {
    // Read-only user lacks permission; use a manage-capable user that is NOT
    // the assignee of taskB.
    const otherManager = await createUserWithPermissions(
      [{ code: 'task.manage', name: 'Manage Tasks' }],
      'othermgr',
    );
    await buildingAssignmentService.createAssignment(otherManager.userId, {
      buildingId: buildingA,
    });

    const notAssignee = await sync(otherManager.token, [
      op('not-assignee', 'TASK_EXECUTION', taskB, 'START'),
    ]);
    const denied = notAssignee.body.data.results[0];
    assert.equal(denied.success, false);
    assert.equal(denied.error.code, 'BAD_REQUEST');

    // Invalid state: START on an already terminal task.
    const terminal = await sync(adminToken, [
      op('bad-state', 'TASK_EXECUTION', taskA, 'START'), // taskA is COMPLETED now
    ]);
    const stateDenied = terminal.body.data.results[0];
    assert.equal(stateDenied.success, false);
    assert.equal(stateDenied.error.code, 'BAD_REQUEST');
  });

  it('requires authentication', async () => {
    const anonymous = await api().post('/api/v1/mobile/sync').send({ operations: [] });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-25G offline sync — operation identifiers (BE-25H idempotency)', () => {
  it('replays the stored result when the same operationId is retried (BE-25H)', async () => {
    const evidenceOp = (executionId: string) =>
      op(`dup-op-${executionId}`, 'EVIDENCE_SUBMISSION', executionId, 'SUBMIT', {
        evidenceType: 'PHOTO',
        executionType: 'CHECKLIST_EXECUTION',
        executionId,
        fileReference: `dup-${executionId}`,
        originalFileName: 'dup.jpg',
        mimeType: 'image/jpeg',
        fileSize: 5,
      });

    const first = await sync(adminToken, [evidenceOp(executionDup)]);
    assert.equal(first.body.data.results[0].success, true);

    // Retry the SAME operationId — must replay, not execute again.
    const second = await sync(adminToken, [evidenceOp(executionDup)]);
    assert.equal(second.body.data.results[0].success, true);
    assert.equal(
      second.body.data.results[0].result.id,
      first.body.data.results[0].result.id,
      'replay returns the ORIGINAL stored result',
    );

    const count = await q(
      'SELECT count(*)::int AS n FROM evidence_submissions WHERE execution_id = $1',
      [executionDup],
    );
    assert.equal(count.rows[0].n, 1, 'duplicate retry must not execute again');
  });
});
