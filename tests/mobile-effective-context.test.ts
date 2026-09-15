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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25B — Mobile Effective Context (focused contract tests).
 *
 * Verifies the BE-25B mobile effective context contract on the single
 * authoritative `/auth/me` endpoint:
 *   - authenticated user, roles, permissions (unchanged),
 *   - Client / Property / Building hierarchy (unchanged),
 *   - mobile data scope (scope.buildingIds / scope.clientIds) derived from the
 *     same BE-02G source as data isolation,
 *   - linked workforce profile identity (context.workforce) with Client-scope
 *     isolation,
 *   - entitlements (unchanged),
 *   - Web effective-context behavior preserved (additive fields only).
 *
 * No assignment feed (BE-25C), no offline sync (BE-25G), no separate mobile
 * context engine.
 */

const DB_PORT = 55438;
const DATA_DIR = '/tmp/asentra-be25b-pg';
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
let plainToken = '';
let isolatedToken = '';

let clientA = '';
let buildingA = '';
let clientB = '';
let profileA = '';

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

async function createWorkforceProfile(
  clientId: string,
  userId: string,
  prefix: string,
): Promise<string> {
  const org = await insertRow('organizations', {
    client_id: clientId,
    code: `${prefix}_ORG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Org`,
    status: 'ACTIVE',
  });
  const dept = await insertRow('departments', {
    organization_id: org,
    code: `${prefix}_DEPT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Dept`,
    status: 'ACTIVE',
  });
  const pos = await insertRow('positions', {
    organization_id: org,
    code: `${prefix}_POS_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Position`,
    status: 'ACTIVE',
  });
  return insertRow('workforce_profiles', {
    organization_id: org,
    department_id: dept,
    position_id: pos,
    user_id: userId,
    employee_code: `${prefix}_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: `${prefix} Worker`,
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });
}

async function createUserWithLogin(email: string): Promise<{
  token: string;
  userId: string;
}> {
  const password = 'ContextPass123';
  const user = await userService.createUser({
    email,
    displayName: 'Context User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const login = await api().post('/api/v1/auth/login').send({
    email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function getMe(token: string): Promise<any> {
  const response = await api()
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200);
  return response.body.data;
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
      workforce_profiles
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await createClientHierarchy('CTX_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });

  // Client B exists but nobody is assigned to it (isolation control).
  const b = await createClientHierarchy('CTX_B');
  clientB = b.clientId;

  // Plain user: authenticated, no roles, no assignments, no profile.
  plainToken = await createPlainSession();

  // Isolation user: building access ONLY in Client A, but the linked
  // workforce profile belongs to Client B → the profile must be hidden.
  const isolated = await createUserWithLogin(
    `isolated-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
  );
  isolatedToken = isolated.token;
  await buildingAssignmentService.createAssignment(isolated.userId, {
    buildingId: buildingA,
  });
  await createWorkforceProfile(clientB, isolated.userId, 'ISO');

  // Admin's linked profile in the accessible Client A.
  profileA = await createWorkforceProfile(clientA, adminUserId, 'ACC');
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

describe('BE-25B mobile effective context — authoritative dimensions', () => {
  it('returns user, roles, permissions, hierarchy, scope, workforce and entitlements', async () => {
    const context = await getMe(adminToken);

    assert.equal(context.user.id, adminUserId);
    assert.equal(context.user.status, 'ACTIVE');

    assert.ok(Array.isArray(context.access.roles));
    assert.ok(context.access.roles.length >= 1);
    assert.ok(Array.isArray(context.access.permissions));
    assert.ok(context.access.permissions.includes('user.read'));

    // Client → Property → Building hierarchy preserved (BE-02H shape).
    assert.equal(context.context.clients.length, 1);
    assert.deepEqual(context.context.clients[0], {
      id: clientA,
      code: context.context.clients[0].code,
      name: context.context.clients[0].name,
      properties: [
        {
          id: context.context.clients[0].properties[0].id,
          code: context.context.clients[0].properties[0].code,
          name: context.context.clients[0].properties[0].name,
          buildings: [
            {
              id: buildingA,
              code: context.context.clients[0].properties[0].buildings[0].code,
              name: context.context.clients[0].properties[0].buildings[0].name,
            },
          ],
        },
      ],
    });

    // BE-25B mobile data scope (same BE-02G source).
    assert.deepEqual(context.scope, {
      buildingIds: [buildingA],
      clientIds: [clientA],
    });

    // Entitlements: no subscription → none.
    assert.deepEqual(context.entitlements, []);
  });

  it('exposes the linked workforce profile identity inside the accessible scope', async () => {
    const context = await getMe(adminToken);
    assert.equal(context.context.workforce.length, 1);
    const profile = context.context.workforce[0];
    assert.equal(profile.id, profileA);
    assert.equal(profile.clientId, clientA);
    assert.ok(profile.employeeCode.startsWith('ACC_EMP_'));
    assert.equal(profile.fullName, 'ACC Worker');
    assert.equal(profile.workforceType, 'INTERNAL');
    assert.equal(profile.status, 'ACTIVE');
    // Identity only — deferred dimensions are not expanded.
    assert.deepEqual(Object.keys(profile).sort(), [
      'clientId',
      'employeeCode',
      'fullName',
      'id',
      'status',
      'workforceType',
    ]);
  });

  it('never exposes a workforce profile whose Client is outside the accessible scope', async () => {
    const context = await getMe(isolatedToken);
    // The user's building access is Client A…
    assert.deepEqual(context.scope, {
      buildingIds: [buildingA],
      clientIds: [clientA],
    });
    // …but their linked profile belongs to Client B → hidden.
    assert.deepEqual(context.context.workforce, []);
  });

  it('returns empty scope, clients and workforce for a zero-scope authenticated user', async () => {
    const context = await getMe(plainToken);
    assert.deepEqual(context.access.roles, []);
    assert.deepEqual(context.access.permissions, []);
    assert.deepEqual(context.context.clients, []);
    assert.deepEqual(context.context.workforce, []);
    assert.deepEqual(context.scope, { buildingIds: [], clientIds: [] });
    assert.deepEqual(context.entitlements, []);
  });
});

describe('BE-25B mobile effective context — Web behavior preserved', () => {
  it('keeps the same top-level contract with additive keys only', async () => {
    const context = await getMe(adminToken);
    assert.deepEqual(Object.keys(context).sort(), [
      'access',
      'context',
      'entitlements',
      'scope',
      'user',
    ]);
    assert.deepEqual(Object.keys(context.context).sort(), ['clients', 'workforce']);
  });

  it('keeps context.clients entries in the exact BE-02H shape', async () => {
    const context = await getMe(adminToken);
    const client = context.context.clients[0];
    assert.deepEqual(Object.keys(client).sort(), ['code', 'id', 'name', 'properties']);
    const property = client.properties[0];
    assert.deepEqual(Object.keys(property).sort(), ['buildings', 'code', 'id', 'name']);
    const building = property.buildings[0];
    assert.deepEqual(Object.keys(building).sort(), ['code', 'id', 'name']);
  });

  it('does not invent available actions inside the context (actions stay on resource endpoints)', async () => {
    const context = await getMe(adminToken);
    assert.ok(!('availableActions' in context));
    assert.ok(!('availableActions' in context.context));
  });
});
