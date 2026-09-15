import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { parse } from 'yaml';
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
 * BE-25A — Mobile API Contract Stabilization (focused contract tests).
 *
 * Verifies the stabilized shared contract consumed by asentra-mobile:
 *   - standard success/error envelope on the mobile execution lists,
 *   - opt-in pagination contract (?page=&pageSize= → meta), including
 *     validation errors and Web-compatible no-param behavior,
 *   - authentication/session contract consistency (login / me / logout),
 *   - OpenAPI mobile coverage (mobile paths + MobilePaginationMeta).
 *
 * Business logic is not re-tested here (task execution, checklist flows,
 * finding workflow, etc. are covered by their own suites).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');

const DB_PORT = 55437;
const DATA_DIR = '/tmp/asentra-be25a-pg';
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
let token = '';
let adminUserId = '';

let clientA = '';
let buildingA = '';

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
      user_building_assignments, organizations, departments, positions,
      workforce_profiles, schedule_definitions, generated_tasks,
      task_assignments, checklist_templates, checklist_executions,
      checklist_item_responses, evidence_requirements, evidence_submissions,
      reviews, operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  token = admin.token;
  adminUserId = admin.userId;

  const a = await clientService.createClient({
    code: `CLI_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Contract Client',
  });
  const prop = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Contract Property',
  });
  const bA = await buildingService.createBuilding({
    propertyId: prop.id,
    code: `BLD_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Contract Building',
  });
  clientA = a.id;
  buildingA = bA.id;

  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: bA.id,
  });

  // --- Checklist executions (3) ---
  const ct = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `CT_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Checklist',
    status: 'ACTIVE',
  });
  for (let i = 0; i < 3; i += 1) {
    await insertRow('checklist_executions', {
      client_id: clientA,
      checklist_template_id: ct,
      status: 'DRAFT',
    });
  }

  // --- Generated tasks (4) + assignments (2 via workforce) ---
  const sd = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SD_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: ct,
    building_id: buildingA,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  const taskIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const taskId = await insertRow('generated_tasks', {
      client_id: clientA,
      schedule_definition_id: sd,
      occurrence_at: `2026-08-0${i + 1}T01:00:00Z`,
      target_type: 'CHECKLIST_TEMPLATE',
      target_id: ct,
      building_id: buildingA,
      status: 'OPEN',
    });
    taskIds.push(taskId);
  }

  const org = await insertRow('organizations', {
    client_id: clientA,
    code: `ORG_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Org',
    status: 'ACTIVE',
  });
  const dept = await insertRow('departments', {
    organization_id: org,
    code: `DEPT_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Dept',
    status: 'ACTIVE',
  });
  const pos = await insertRow('positions', {
    organization_id: org,
    code: `POS_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Mobile Position',
    status: 'ACTIVE',
  });
  const wp = await insertRow('workforce_profiles', {
    organization_id: org,
    department_id: dept,
    position_id: pos,
    user_id: adminUserId,
    employee_code: `EMP_M_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: 'Mobile Worker',
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  for (let i = 0; i < 2; i += 1) {
    await insertRow('task_assignments', {
      task_id: taskIds[i],
      assignee_type: 'WORKFORCE',
      workforce_profile_id: wp,
      team_id: null,
      assigned_by_user_id: adminUserId,
      status: 'ACTIVE',
    });
  }

  // --- Evidence submissions (3) ---
  const execution = (
    await q('SELECT id FROM checklist_executions ORDER BY created_at LIMIT 1')
  ).rows[0] as { id: string };
  for (let i = 0; i < 3; i += 1) {
    await insertRow('evidence_submissions', {
      client_id: clientA,
      evidence_requirement_id: null,
      execution_type: 'CHECKLIST_EXECUTION',
      execution_id: execution.id,
      evidence_type: 'PHOTO',
      file_reference: `evidence/${randomUUID()}`,
      original_file_name: `photo-${i}.jpg`,
      mime_type: 'image/jpeg',
      file_size: 1024 + i,
      captured_at: '2026-08-01T02:00:00Z',
      submitted_by_user_id: adminUserId,
      status: 'ACTIVE',
    });
  }

  // --- Reviews (2) ---
  for (let i = 0; i < 2; i += 1) {
    await insertRow('reviews', {
      client_id: clientA,
      target_type: 'CHECKLIST_EXECUTION',
      target_id: execution.id,
      reviewer_user_id: adminUserId,
      status: 'PENDING',
    });
  }

  // --- Operational events (3) ---
  for (let i = 0; i < 3; i += 1) {
    await insertRow('operational_events', {
      client_id: clientA,
      event_type: 'TASK_STARTED',
      entity_type: 'TASK',
      entity_id: taskIds[i],
      actor_user_id: adminUserId,
      building_id: buildingA,
      summary: `Task event ${i}`,
      metadata: { i },
      occurred_at: `2026-08-0${i + 1}T03:00:00Z`,
    });
  }
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

describe('BE-25A mobile API contract — standard envelope', () => {
  it('returns the uniform {success, data, meta} envelope on mobile lists', async () => {
    const request = api();
    const paths = [
      '/api/v1/tasks',
      '/api/v1/checklist-executions',
      '/api/v1/evidence',
      '/api/v1/reviews',
      '/api/v1/operational-events',
      '/api/v1/workforce/00000000-0000-0000-0000-000000000000/tasks',
    ];
    for (const path of paths) {
      const response = await request
        .get(path)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(response.status, 200, `${path} must be reachable`);
      assert.equal(response.body.success, true, `${path} success flag`);
      assert.ok(Array.isArray(response.body.data), `${path} data array`);
      assert.ok(
        response.body.meta && typeof response.body.meta === 'object',
        `${path} meta object`,
      );
    }
  });

  it('keeps full-list behavior when no pagination parameters are sent (Web compatibility)', async () => {
    const response = await api()
      .get('/api/v1/tasks')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 4);
    assert.deepEqual(response.body.meta, {});
  });
});

describe('BE-25A mobile API contract — pagination', () => {
  it('returns the requested page plus pagination meta', async () => {
    const response = await api()
      .get('/api/v1/tasks?page=1&pageSize=2')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 2);
    assert.deepEqual(response.body.meta, {
      page: 1,
      pageSize: 2,
      total: 4,
      totalPages: 2,
    });
  });

  it('pages are stable and non-overlapping', async () => {
    const request = api();
    const page1 = await request
      .get('/api/v1/tasks?page=1&pageSize=2')
      .set('Authorization', `Bearer ${token}`);
    const page2 = await request
      .get('/api/v1/tasks?page=2&pageSize=2')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(page1.status, 200);
    assert.equal(page2.status, 200);
    assert.equal(page2.body.data.length, 2);
    const ids1 = page1.body.data.map((row: { id: string }) => row.id).sort();
    const ids2 = page2.body.data.map((row: { id: string }) => row.id).sort();
    assert.notDeepEqual(ids1, ids2, 'pages must not overlap');
    assert.deepEqual(page2.body.meta, {
      page: 2,
      pageSize: 2,
      total: 4,
      totalPages: 2,
    });
  });

  it('an out-of-range page returns an empty page with correct totals', async () => {
    const response = await api()
      .get('/api/v1/tasks?page=9&pageSize=2')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
    assert.deepEqual(response.body.meta, {
      page: 9,
      pageSize: 2,
      total: 4,
      totalPages: 2,
    });
  });

  it('rejects invalid pagination with 400 VALIDATION_ERROR + details', async () => {
    const request = api();
    const cases = [
      '/api/v1/tasks?page=0',
      '/api/v1/tasks?page=abc',
      '/api/v1/tasks?pageSize=0',
      '/api/v1/tasks?pageSize=201',
      '/api/v1/tasks?pageSize=abc',
      '/api/v1/checklist-executions?page=-1',
      '/api/v1/evidence?pageSize=0',
      '/api/v1/reviews?page=abc',
      '/api/v1/operational-events?pageSize=999',
      '/api/v1/workforce/00000000-0000-0000-0000-000000000000/tasks?page=0',
    ];
    for (const path of cases) {
      const response = await request
        .get(path)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(response.status, 400, `${path} must reject invalid paging`);
      assert.equal(response.body.success, false);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(
        Array.isArray(response.body.error.details),
        `${path} must include field details`,
      );
    }
  });

  it('applies the same pagination contract on every mobile list', async () => {
    const request = api();
    const cases: { path: string; pageSize: number; total: number }[] = [
      { path: '/api/v1/checklist-executions', pageSize: 2, total: 3 },
      { path: '/api/v1/evidence', pageSize: 2, total: 3 },
      { path: '/api/v1/reviews', pageSize: 1, total: 2 },
      { path: '/api/v1/operational-events', pageSize: 2, total: 3 },
      {
        path: '/api/v1/workforce/00000000-0000-0000-0000-000000000000/tasks',
        pageSize: 1,
        total: 0,
      },
    ];
    for (const { path, pageSize, total } of cases) {
      const response = await request
        .get(`${path}?page=1&pageSize=${pageSize}`)
        .set('Authorization', `Bearer ${token}`);
      assert.equal(response.status, 200, `${path} must paginate`);
      assert.ok(response.body.data.length <= pageSize, `${path} page bound`);
      assert.deepEqual(response.body.meta, {
        page: 1,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      });
    }
  });

  it('paginates the workforce task feed for a real workforce profile', async () => {
    const profile = (
      await q('SELECT id FROM workforce_profiles LIMIT 1')
    ).rows[0] as { id: string };
    const response = await api()
      .get(`/api/v1/workforce/${profile.id}/tasks?page=1&pageSize=1`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].assigneeType, 'WORKFORCE');
    assert.deepEqual(response.body.meta, {
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });
  });
});

describe('BE-25A mobile API contract — authentication/session consistency', () => {
  it('login returns sessionToken + expiresAt + user', async () => {
    const suffix = randomUUID().slice(0, 8).toLowerCase();
    const email = `contract-${suffix}@example.com`;
    const password = 'ContractPass123';
    const user = await userService.createUser({
      email,
      displayName: 'Contract User',
    });
    await credentialService.createInitialCredential({ userId: user.id, password });

    const login = await api().post('/api/v1/auth/login').send({
      email,
      password,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.success, true);
    assert.equal(typeof login.body.data.sessionToken, 'string');
    assert.ok(login.body.data.sessionToken.length >= 32);
    assert.ok(!Number.isNaN(Date.parse(login.body.data.expiresAt)));
    assert.equal(login.body.data.user.id, user.id);
  });

  it('GET /auth/me returns the authoritative effective context', async () => {
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.success, true);
    assert.ok(me.body.data.user.id);
    assert.ok(Array.isArray(me.body.data.access.roles));
    assert.ok(Array.isArray(me.body.data.access.permissions));
    assert.ok(me.body.data.context && typeof me.body.data.context === 'object');
    assert.ok(Array.isArray(me.body.data.entitlements));
  });

  it('logout revokes the session (subsequent /auth/me → 401)', async () => {
    const suffix = randomUUID().slice(0, 8).toLowerCase();
    const email = `logout-${suffix}@example.com`;
    const password = 'LogoutPass123';
    const user = await userService.createUser({
      email,
      displayName: 'Logout User',
    });
    await credentialService.createInitialCredential({ userId: user.id, password });

    const login = await api().post('/api/v1/auth/login').send({
      email,
      password,
    });
    const sessionToken = login.body.data.sessionToken as string;

    const logout = await api()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${sessionToken}`);
    assert.equal(logout.status, 200);
    assert.equal(logout.body.data.revoked, true);

    const after = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${sessionToken}`);
    assert.equal(after.status, 401);
    assert.equal(after.body.success, false);
    assert.equal(after.body.error.code, 'INVALID_SESSION');
  });
});

describe('BE-25A mobile API contract — OpenAPI coverage', () => {
  it('documents the mobile execution surface with valid refs', () => {
    const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<
      string,
      any
    >;
    const paths = spec.paths as Record<string, unknown>;
    const schemas = (spec.components as { schemas: Record<string, unknown> })
      .schemas;

    const mobilePaths = [
      '/tasks',
      '/tasks/{taskId}',
      '/tasks/{taskId}/start',
      '/tasks/{taskId}/complete',
      '/tasks/{taskId}/cancel',
      '/workforce/{workforceId}/tasks',
      '/teams/{teamId}/tasks',
      '/checklist-executions',
      '/checklist-executions/{executionId}',
      '/checklist-executions/{executionId}/start',
      '/checklist-executions/{executionId}/responses',
      '/checklist-executions/{executionId}/complete',
      '/checklist-executions/{executionId}/cancel',
      '/evidence',
      '/evidence/{evidenceId}',
      '/reviews',
      '/operational-events',
      '/findings/{findingId}/available-actions',
      '/findings/{findingId}/state',
      '/assets/resolve/{identifier}',
    ];
    for (const path of mobilePaths) {
      assert.ok(paths[path], `OpenAPI must document ${path}`);
    }

    const meta = schemas.MobilePaginationMeta as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    assert.ok(meta, 'MobilePaginationMeta schema required');
    assert.deepEqual(meta.required, ['page', 'pageSize', 'total', 'totalPages']);

    for (const name of [
      'Task',
      'TaskAssignment',
      'ChecklistExecution',
      'ChecklistItemResponse',
      'Review',
      'OperationalEvent',
      'FindingAvailableActions',
      'FindingState',
      'AssetResolution',
    ]) {
      assert.ok(schemas[name], `schema ${name} required`);
    }

    // No broken $refs anywhere in the document.
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === '$ref') {
            refs.push(value as string);
          } else {
            walk(value);
          }
        }
      }
    };
    walk(spec);
    for (const ref of refs) {
      const parts = ref.replace('#/', '').split('/');
      let node: unknown = spec;
      for (const part of parts) {
        node = (node as Record<string, unknown>)[part];
      }
      assert.ok(node, `broken $ref: ${ref}`);
    }
  });
});
