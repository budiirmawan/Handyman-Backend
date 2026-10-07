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
 * BE-25D — Checklist Mobile Contract (focused contract tests).
 *
 * Verifies the mobile checklist execution read model:
 *   - checklist/task reference,
 *   - checklist items with item status/value,
 *   - measurement/UOM where applicable,
 *   - evidence requirements (template + item level),
 *   - execution status,
 *   - backend-authoritative available_actions (consistent with the real
 *     execution endpoints),
 *   - strict accessible Client scope (BE-02G).
 *
 * Evidence byte upload is BE-25E and is NOT exercised here.
 */

const DB_PORT = 55441;
const DATA_DIR = '/tmp/asentra-be25d-pg';
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
let clientB = '';
let templateA = '';
let itemCheck = ''; // CHECK, required
let itemNumber = ''; // NUMBER + UOM + range
let itemText = ''; // TEXT, optional
let executionId = '';
let uomId = '';

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
      user_building_assignments, checklist_templates, checklist_items,
      checklist_executions, checklist_item_responses, units_of_measure,
      evidence_requirements, generated_tasks, schedule_definitions
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await clientService.createClient({
    code: `CLI_D_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_D_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_D_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist Building A',
  });
  clientA = a.id;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA.id,
  });

  const b = await clientService.createClient({
    code: `CLI_DB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist Client B',
  });
  const propB = await propertyService.createProperty({
    clientId: b.id,
    code: `PROP_DB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist Property B',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_DB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist Building B',
  });
  clientB = b.id;
  // Admin has NO assignment to building B.

  // Template A (client A) with 3 items.
  templateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_D_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Checklist Template',
    description: 'Template for mobile',
    status: 'ACTIVE',
  });
  itemCheck = await insertRow('checklist_items', {
    checklist_template_id: templateA,
    code: 'CHK',
    label: 'Check item',
    item_type: 'CHECK',
    required: true,
    display_order: 0,
    status: 'ACTIVE',
  });
  uomId = await insertRow('units_of_measure', {
    client_id: clientA,
    code: 'DEGC',
    name: 'Degree Celsius',
    symbol: '°C',
    category: 'TEMPERATURE',
    status: 'ACTIVE',
  });
  itemNumber = await insertRow('checklist_items', {
    checklist_template_id: templateA,
    code: 'TEMP',
    label: 'Temperature',
    item_type: 'NUMBER',
    required: true,
    display_order: 1,
    status: 'ACTIVE',
    uom_id: uomId,
    minimum_value: 10,
    maximum_value: 40,
    decimal_precision: 1,
  });
  itemText = await insertRow('checklist_items', {
    checklist_template_id: templateA,
    code: 'NOTE',
    label: 'Note',
    item_type: 'TEXT',
    required: false,
    display_order: 2,
    status: 'ACTIVE',
  });

  // Execution (DRAFT) in client A.
  executionId = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateA,
    status: 'DRAFT',
  });

  // Evidence requirements: template-level + item-level.
  await insertRow('evidence_requirements', {
    client_id: clientA,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
    maximum_count: 5,
    description: 'Template photo',
    status: 'ACTIVE',
  });
  await insertRow('evidence_requirements', {
    client_id: clientA,
    target_type: 'CHECKLIST_ITEM',
    target_id: itemCheck,
    evidence_type: 'SIGNATURE',
    required: false,
    minimum_count: 0,
    maximum_count: 1,
    description: 'Signature on check',
    status: 'ACTIVE',
  });

  // A cross-client execution (client B) for the 403 case.
  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_DB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Cross Template',
    status: 'ACTIVE',
  });
  await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: templateB,
    status: 'DRAFT',
  });

  // A task targeting template A (task reference case).
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SD_D_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Task Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    building_id: buildingA.id,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  await insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: scheduleId,
    occurrence_at: '2026-08-05T01:00:00Z',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    building_id: buildingA.id,
    status: 'OPEN',
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

async function getMobile(execution: string, token: string): Promise<any> {
  const response = await api()
    .get(`/api/v1/mobile/checklist-executions/${execution}`)
    .set('Authorization', `Bearer ${token}`);
  return response;
}

describe('BE-25D checklist mobile contract — contract shape', () => {
  it('returns the full mobile checklist execution contract', async () => {
    const response = await getMobile(executionId, adminToken);
    assert.equal(response.status, 200);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'availableActions',
      'checklist',
      'clientId',
      'completedAt',
      'createdAt',
      'evidenceRequirements',
      'id',
      'items',
      'startedAt',
      'status',
      'task',
      'updatedAt',
    ]);
    assert.equal(data.id, executionId);
    assert.equal(data.clientId, clientA);
    assert.equal(data.status, 'DRAFT');
    assert.equal(data.startedAt, null);
    assert.equal(data.completedAt, null);
  });

  it('returns the checklist/task reference', async () => {
    const data = (await getMobile(executionId, adminToken)).body.data;
    assert.deepEqual(Object.keys(data.checklist).sort(), [
      'clientId',
      'code',
      'description',
      'id',
      'name',
      'status',
    ]);
    assert.equal(data.checklist.id, templateA);
    assert.equal(data.checklist.status, 'ACTIVE');
    assert.equal(data.checklist.description, 'Template for mobile');

    assert.ok(data.task, 'task reference expected (task targets the template)');
    assert.deepEqual(Object.keys(data.task).sort(), [
      'buildingId',
      'occurrenceAt',
      'scheduleDefinitionId',
      'targetId',
      'taskId',
      'taskStatus',
    ]);
    assert.equal(data.task.targetId, templateA);
    assert.equal(data.task.taskStatus, 'OPEN');
    assert.equal(data.task.occurrenceAt, '2026-08-05T01:00:00.000Z');
    assert.ok(data.task.buildingId);
  });

  it('returns checklist items with item status/value', async () => {
    const data = (await getMobile(executionId, adminToken)).body.data;
    assert.equal(data.items.length, 3);
    assert.deepEqual(
      data.items.map((item: any) => item.code),
      ['CHK', 'TEMP', 'NOTE'],
      'items ordered by display_order',
    );

    const check = data.items[0];
    assert.equal(check.itemType, 'CHECK');
    assert.equal(check.required, true);
    assert.equal(check.itemStatus, 'PENDING');
    assert.equal(check.value, null);
    assert.equal(check.result, null);
    assert.equal(check.notes, null);
    assert.equal(check.measurement, null);
    assert.deepEqual(check.evidenceRequirements.map((r: any) => r.evidenceType), [
      'SIGNATURE',
    ]);
  });

  it('returns measurement/UOM for NUMBER items', async () => {
    const data = (await getMobile(executionId, adminToken)).body.data;
    const number = data.items[1];
    assert.equal(number.itemType, 'NUMBER');
    assert.equal(number.measurement.minimumValue, 10);
    assert.equal(number.measurement.maximumValue, 40);
    assert.equal(number.measurement.decimalPrecision, 1);
    assert.equal(number.measurement.uom.id, uomId);
    assert.equal(number.measurement.uom.code, 'DEGC');
    assert.equal(number.measurement.uom.symbol, '°C');
    assert.equal(number.measurement.uom.category, 'TEMPERATURE');
  });

  it('returns evidence requirements at template and item level', async () => {
    const data = (await getMobile(executionId, adminToken)).body.data;
    assert.equal(data.evidenceRequirements.length, 1);
    const templateReq = data.evidenceRequirements[0];
    assert.equal(templateReq.evidenceType, 'PHOTO');
    assert.equal(templateReq.required, true);
    assert.equal(templateReq.minimumCount, 1);
    assert.equal(templateReq.maximumCount, 5);
    assert.equal(templateReq.description, 'Template photo');
  });
});

describe('BE-25D checklist mobile contract — available_actions', () => {
  it('DRAFT → START, SAVE_RESPONSES, COMPLETE, CANCEL', async () => {
    const data = (await getMobile(executionId, adminToken)).body.data;
    assert.deepEqual(data.availableActions, [
      'START',
      'SAVE_RESPONSES',
      'COMPLETE',
      'CANCEL',
    ]);
  });

  it('IN_PROGRESS → SAVE_RESPONSES, COMPLETE, CANCEL (tracked via the real endpoint)', async () => {
    const started = await api()
      .post(`/api/v1/checklist-executions/${executionId}/start`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(started.status, 200);

    const data = (await getMobile(executionId, adminToken)).body.data;
    assert.equal(data.status, 'IN_PROGRESS');
    assert.ok(data.startedAt);
    assert.deepEqual(data.availableActions, [
      'SAVE_RESPONSES',
      'COMPLETE',
      'CANCEL',
    ]);
  });

  it('reflected saved response values with ANSWERED status (via the real endpoint)', async () => {
    const saved = await api()
      .put(`/api/v1/checklist-executions/${executionId}/responses`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send([{ itemId: itemCheck, value: true }, { itemId: itemNumber, value: 22.5 }]);
    assert.equal(saved.status, 200);

    const data = (await getMobile(executionId, adminToken)).body.data;
    const check = data.items.find((item: any) => item.id === itemCheck);
    const number = data.items.find((item: any) => item.id === itemNumber);
    const text = data.items.find((item: any) => item.id === itemText);

    assert.equal(check.itemStatus, 'ANSWERED');
    assert.equal(check.value, true);
    assert.equal(number.itemStatus, 'ANSWERED');
    assert.equal(number.value, 22.5);
    assert.equal(text.itemStatus, 'PENDING');
    assert.equal(text.value, null);
  });

  it('COMPLETED → no available actions', async () => {
    const completed = await api()
      .post(`/api/v1/checklist-executions/${executionId}/complete`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(completed.status, 200);

    const data = (await getMobile(executionId, adminToken)).body.data;
    assert.equal(data.status, 'COMPLETED');
    assert.ok(data.completedAt);
    assert.deepEqual(data.availableActions, []);
  });
});

describe('BE-25D checklist mobile contract — scope and errors', () => {
  it('returns 403 for a cross-Client execution (BE-02G)', async () => {
    const cross = (
      await q('SELECT id FROM checklist_executions WHERE client_id = $1', [
        clientB,
      ])
    ).rows[0] as { id: string };
    const response = await getMobile(cross.id, adminToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 404 for an unknown execution', async () => {
    const response = await getMobile(id(), adminToken);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  it('requires authentication and checklist.read', async () => {
    const anonymous = await api().get(
      `/api/v1/mobile/checklist-executions/${executionId}`,
    );
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('does not leak the execution when the user has no accessible scope', async () => {
    // A user WITH checklist.read but no building assignment cannot access
    // client A — scope is enforced beyond the permission gate.
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const password = 'ScopedPass123';
    const { userService } = await import('../src/modules/users');
    const { credentialService } = await import('../src/modules/auth');
    const { roleService } = await import('../src/modules/roles');
    const {
      permissionRepository,
      permissionService,
    } = await import('../src/modules/permissions');
    const user = await userService.createUser({
      email: `scoped-d-${suffix.toLowerCase()}@example.com`,
      displayName: 'Scoped D',
    });
    await credentialService.createInitialCredential({ userId: user.id, password });
    const role = await roleService.createRole({
      code: `SCOPED_D_${suffix}`,
      name: 'Scoped D Role',
    });
    let permission = await permissionRepository.findByCode('checklist.read');
    if (!permission) {
      permission = await permissionService.createPermission({
        code: 'checklist.read',
        name: 'Read Checklists',
      });
    }
    await permissionService.assignPermissionToRole(role.id, permission.id);
    await roleService.assignRoleToUser(user.id, role.id);
    const login = await api().post('/api/v1/auth/login').send({
      email: user.email,
      password,
    });
    const token = login.body.data.sessionToken as string;

    const response = await getMobile(executionId, token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
