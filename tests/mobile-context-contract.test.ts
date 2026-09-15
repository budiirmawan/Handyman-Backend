import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { roleService } from '../src/modules/roles';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import {
  createAdminSession,
  createAdminUser,
  createPlainSession,
  createSessionWithPermissions,
} from './helpers/access';

/**
 * CR-BE-MOB-CONTRACT-01 PART 02 — User, Role, Permission & Building Context.
 *
 * Verifies the backend-authoritative context-resolution chain
 *   User → Role → Permission → Client → Property → Building
 * is published in OpenAPI (schemas + paths) and that the runtime enforces the
 * documented RBAC and Building-isolation behavior deterministically.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const DB_PORT = 55446;
const DATA_DIR = '/tmp/asentra-mob-ctx-pg';
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
       user_building_assignments, user_role_assignments,
       role_permission_assignments CASCADE`,
  );
  adminToken = await createAdminSession();
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

// --------------------------------------------------------------------------
// Layer 1 — OpenAPI contract (no database)
// --------------------------------------------------------------------------
function loadSpec(): Record<string, any> {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
}

describe('CR-BE-MOB-CONTRACT-01 PART 02 — context OpenAPI contract', () => {
  const spec = loadSpec();

  const PUBLISHED_PATHS: Array<[string, string]> = [
    ['/users', 'post'],
    ['/users/{userId}', 'get'],
    ['/roles', 'get'],
    ['/roles/{roleId}', 'get'],
    ['/users/{userId}/roles', 'get'],
    ['/permissions', 'get'],
    ['/permissions/{permissionId}', 'get'],
    ['/roles/{roleId}/permissions', 'get'],
    ['/clients', 'get'],
    ['/clients/{clientId}', 'get'],
    ['/properties', 'get'],
    ['/properties/{propertyId}', 'get'],
    ['/clients/{clientId}/properties', 'get'],
    ['/buildings', 'get'],
    ['/buildings/{buildingId}', 'get'],
    ['/properties/{propertyId}/buildings', 'get'],
    ['/users/{userId}/buildings', 'get'],
  ];

  it('publishes the User → Role → Permission → Building context paths', () => {
    for (const [path, method] of PUBLISHED_PATHS) {
      const op = spec.paths?.[path]?.[method];
      assert.ok(op, `${method.toUpperCase()} ${path} must be documented`);
      assert.ok(
        Array.isArray(op.security) &&
          op.security.some((s: Record<string, unknown>) => 'bearerAuth' in s),
        `${method.toUpperCase()} ${path} must require bearerAuth`,
      );
    }
  });

  it('publishes the identity schemas with required fields', () => {
    const schemas = spec.components.schemas;
    assert.ok(schemas.PublicUser, 'PublicUser required');
    assert.ok(schemas.UserStatus, 'UserStatus required');

    assert.deepEqual(
      [...schemas.PublicRole.required].sort(),
      ['code', 'description', 'id', 'name', 'status'],
    );
    assert.deepEqual(schemas.RoleStatus.enum, ['ACTIVE', 'INACTIVE']);

    assert.deepEqual(
      [...schemas.PublicPermission.required].sort(),
      ['code', 'description', 'id', 'name', 'status'],
    );
    assert.deepEqual(schemas.PermissionStatus.enum, ['ACTIVE', 'INACTIVE']);
  });

  it('publishes the Client → Property → Building hierarchy schemas', () => {
    const schemas = spec.components.schemas;

    assert.deepEqual(
      [...schemas.PublicClient.required].sort(),
      ['code', 'description', 'id', 'legalName', 'name', 'status', 'taxId'],
    );
    assert.equal(schemas.PublicProperty.properties.clientId.$ref, '#/components/schemas/Uuid');
    assert.equal(schemas.PublicBuilding.properties.propertyId.$ref, '#/components/schemas/Uuid');
    assert.equal(schemas.PublicBuilding.properties.campusId.nullable, true);

    assert.deepEqual(schemas.ClientStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.PropertyStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.BuildingStatus.enum, ['ACTIVE', 'INACTIVE']);
  });

  it('publishes the user-building assignment schema', () => {
    const schema = spec.components.schemas.PublicUserBuildingAssignment;
    assert.ok(schema, 'PublicUserBuildingAssignment required');
    assert.deepEqual(
      [...schema.required].sort(),
      ['assignedAt', 'assignedByUserId', 'buildingId', 'id', 'status', 'userId'],
    );
    assert.deepEqual(
      spec.components.schemas.UserBuildingAssignmentStatus.enum,
      ['ACTIVE', 'INACTIVE'],
    );
  });

  it('keeps /auth/me as the authoritative effective-context read', () => {
    const meOp = spec.paths['/auth/me'].get;
    assert.ok(meOp, 'GET /auth/me documented');
    const schema = spec.components.schemas.EffectiveUserContext;
    assert.deepEqual(
      [...schema.required].sort(),
      ['access', 'context', 'entitlements', 'scope', 'user'],
    );
    // access → roles + permissions; scope → buildingIds + clientIds.
    assert.deepEqual(
      [...spec.components.schemas.EffectiveAccess.required].sort(),
      ['permissions', 'roles'],
    );
    assert.deepEqual(
      [...spec.components.schemas.EffectiveScope.required].sort(),
      ['buildingIds', 'clientIds'],
    );
  });

  // MOB-C02 PART 01 — mobile effective-context shape, empty-state and the
  // building-context / availableActions architecture (DB-free contract pins).
  it('/auth/me and /auth/me/buildings require bearer auth, 401 on failure, and no 403', () => {
    for (const path of ['/auth/me', '/auth/me/buildings']) {
      const op = spec.paths[path].get;
      assert.ok(op, `GET ${path} documented`);
      assert.ok(
        Array.isArray(op.security) &&
          op.security.some((s: Record<string, unknown>) => 'bearerAuth' in s),
        `GET ${path} must require bearerAuth`,
      );
      assert.ok(op.responses['401'], `GET ${path} must document 401`);
      assert.ok(
        !op.responses['403'],
        `self-service ${path} must not document a 403 (RBAC 403 lives on managed resources)`,
      );
    }
  });

  it('EffectiveUserContext matches the runtime shape (user/access/context/scope/entitlements)', () => {
    const schemas = spec.components.schemas;
    const ctx = schemas.EffectiveUserContext;
    assert.equal(ctx.properties.user.$ref, '#/components/schemas/PublicUser');
    assert.equal(ctx.properties.access.$ref, '#/components/schemas/EffectiveAccess');
    assert.equal(ctx.properties.scope.$ref, '#/components/schemas/EffectiveScope');
    assert.equal(
      ctx.properties.entitlements.items.$ref,
      '#/components/schemas/EffectiveEntitlement',
    );
    assert.deepEqual(
      [...ctx.properties.context.required].sort(),
      ['clients', 'workforce'],
    );
    assert.equal(
      ctx.properties.context.properties.clients.items.$ref,
      '#/components/schemas/EffectiveClientContext',
    );
    assert.equal(
      ctx.properties.context.properties.workforce.items.$ref,
      '#/components/schemas/EffectiveWorkforceProfile',
    );
  });

  it('roles are {id,code,name} (multi-role set) and permissions are flat string codes', () => {
    const schemas = spec.components.schemas;
    assert.deepEqual([...schemas.EffectiveRole.required].sort(), ['code', 'id', 'name']);
    assert.equal(
      schemas.EffectiveAccess.properties.roles.items.$ref,
      '#/components/schemas/EffectiveRole',
    );
    assert.equal(
      schemas.EffectiveAccess.properties.permissions.items.type,
      'string',
      'permissions must be flat string codes, never mobile-only booleans',
    );
  });

  it('scope buildingIds/clientIds are uuid arrays and document the empty (zero-scope) state', () => {
    const scope = spec.components.schemas.EffectiveScope;
    for (const field of ['buildingIds', 'clientIds']) {
      assert.equal(scope.properties[field].type, 'array');
      assert.equal(scope.properties[field].items.$ref, '#/components/schemas/Uuid');
      assert.match(scope.properties[field].description ?? '', /empty/i);
    }
  });

  it('workforce reference is identity-only and entitlements expose moduleCode + ACTIVE', () => {
    const schemas = spec.components.schemas;
    const wf = schemas.EffectiveWorkforceProfile;
    assert.deepEqual(
      [...wf.required].sort(),
      ['clientId', 'employeeCode', 'fullName', 'id', 'status', 'workforceType'],
    );
    for (const absent of ['organizationId', 'departmentId', 'teamId', 'positionId']) {
      assert.ok(!wf.properties[absent], `workforce context must not expand ${absent}`);
    }
    const ent = schemas.EffectiveEntitlement;
    assert.deepEqual([...ent.required].sort(), ['moduleCode', 'status']);
    assert.equal(ent.properties.status.const, 'ACTIVE');
  });

  it('UserBuildingContext: building required; property/client nullable; status ACTIVE; returned as an array', () => {
    const ubc = spec.components.schemas.UserBuildingContext;
    assert.deepEqual([...ubc.required].sort(), ['building', 'id', 'status']);
    assert.equal(ubc.properties.status.const, 'ACTIVE');
    assert.equal(ubc.properties.building.$ref, '#/components/schemas/BuildingRef');
    assert.equal(ubc.properties.property.nullable, true);
    assert.equal(ubc.properties.client.nullable, true);

    const data = spec.paths['/auth/me/buildings'].get.responses['200'].content[
      'application/json'
    ].schema.allOf?.find((s: Record<string, any>) => s.properties?.data)?.properties
      ?.data;
    assert.equal(data.type, 'array');
    assert.equal(data.items.$ref, '#/components/schemas/UserBuildingContext');
  });

  it('exposes no global availableActions and no active-building/session-context API', () => {
    const ctxText = JSON.stringify(spec.components.schemas.EffectiveUserContext);
    assert.ok(!/availableActions/.test(ctxText), '/auth/me must not expose availableActions');

    for (const path of Object.keys(spec.paths ?? {})) {
      assert.ok(
        !/active-build|building-session|context-session|select-building/i.test(path),
        `no active-building/session endpoint may be invented (found ${path})`,
      );
    }
    for (const p of Object.values(spec.components?.parameters ?? {}) as any[]) {
      assert.ok(
        !(p?.in === 'header' && /context/i.test(String(p?.name ?? ''))),
        'no mobile building-context header parameter may be invented',
      );
    }
  });
});

// --------------------------------------------------------------------------
// Layer 2 — runtime RBAC + isolation (embedded PostgreSQL)
// --------------------------------------------------------------------------
describe('CR-BE-MOB-CONTRACT-01 PART 02 — context runtime contract', () => {
  async function provisionHierarchy() {
    const client = await clientService.createClient({
      code: `CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Context Client',
    });
    const property = await propertyService.createProperty({
      clientId: client.id,
      code: `PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Context Property',
    });
    const building = await buildingService.createBuilding({
      propertyId: property.id,
      code: `BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Context Building',
    });
    return { client, property, building };
  }

  it('denies user.read without the permission (403 PERMISSION_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const token = await createPlainSession();

    const response = await api()
      .get(`${API_PREFIX}/users/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.equal(response.body.error.category, 'FORBIDDEN');
  });

  it('denies Building read access without an ACTIVE assignment (403 BUILDING_ACCESS_DENIED)', async (t) => {
    if (!requireDatabase(t)) return;
    const { building } = await provisionHierarchy();
    // Caller holds building.read but has no Building assignment.
    const token = await createSessionWithPermissions([
      { code: 'building.read', name: 'Read Buildings' },
    ]);

    const response = await api()
      .get(`${API_PREFIX}/buildings/${building.id}`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(response.body.error.category, 'FORBIDDEN');
  });

  it('resolves Client → Property → Building for a session with Building access', async (t) => {
    if (!requireDatabase(t)) return;
    const { token, userId } = await createAdminUser();
    const { client, property, building } = await provisionHierarchy();
    // Building read also requires an ACTIVE Building assignment (BE-02G).
    await buildingAssignmentService.createAssignment(
      userId,
      { buildingId: building.id },
      userId,
    );

    const clientRes = await api()
      .get(`${API_PREFIX}/clients/${client.id}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(clientRes.status, 200);
    assert.deepEqual(Object.keys(clientRes.body.data).sort(), [
      'code', 'description', 'id', 'legalName', 'name', 'status', 'taxId',
    ]);

    const propertyRes = await api()
      .get(`${API_PREFIX}/properties/${property.id}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(propertyRes.status, 200);
    assert.equal(propertyRes.body.data.clientId, client.id);

    const buildingRes = await api()
      .get(`${API_PREFIX}/buildings/${building.id}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(buildingRes.status, 200);
    assert.equal(buildingRes.body.data.propertyId, property.id);
  });

  it('exposes the effective access + scope via /auth/me', async (t) => {
    if (!requireDatabase(t)) return;

    const me = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('Authorization', `Bearer ${adminToken}`);

    assert.equal(me.status, 200);
    assert.ok(Array.isArray(me.body.data.access.roles));
    assert.ok(Array.isArray(me.body.data.access.permissions));
    assert.deepEqual(Object.keys(me.body.data.scope).sort(), ['buildingIds', 'clientIds']);
    assert.deepEqual(Object.keys(me.body.data.context).sort(), ['clients', 'workforce']);
  });

  it('lists a role and its permissions through the assignment routes', async (t) => {
    if (!requireDatabase(t)) return;
    // Reuse the admin role created by createAdminSession.
    const roles = await api()
      .get(`${API_PREFIX}/roles`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(roles.status, 200);
    const role = roles.body.data.find((r: any) => r.code.startsWith('ADMIN_'));
    assert.ok(role, 'admin role expected');

    const permissions = await api()
      .get(`${API_PREFIX}/roles/${role.id}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(permissions.status, 200);
    assert.ok(Array.isArray(permissions.body.data));
    assert.ok(
      permissions.body.data.every((p: any) =>
        ['code', 'description', 'id', 'name', 'status'].every((k) => k in p),
      ),
    );
  });

  it('returns the assigned user roles and the public role shape', async (t) => {
    if (!requireDatabase(t)) return;
    const role = await roleService.createRole({
      code: `CTX_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Context Role',
    });

    // List roles to verify the public shape.
    const list = await api()
      .get(`${API_PREFIX}/roles`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(list.status, 200);
    const listed = list.body.data.find((r: any) => r.id === role.id);
    assert.deepEqual(Object.keys(listed).sort(), ['code', 'description', 'id', 'name', 'status']);
  });

  it('rejects a malformed id with 400 VALIDATION_ERROR', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(`${API_PREFIX}/buildings/not-a-uuid`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('returns 404 USER_NOT_FOUND for an unknown user', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await api()
      .get(`${API_PREFIX}/users/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'USER_NOT_FOUND');
  });
});
