import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import type { Response } from 'supertest';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
import { sessionService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { CANONICAL_ROLE_DEFINITIONS } from '../src/modules/iam-bootstrap/iam-canonical-roles';
import { bootstrapOwner } from '../src/modules/iam-bootstrap/owner-bootstrap.service';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleRepository, roleService } from '../src/modules/roles';
import { ROLE_MUTATION_LOCK } from '../src/modules/roles/role.service';
import { AUTHORITY_DEFINING_PERMISSIONS } from '../src/modules/users/privileged-account.guard';
import { createSessionWithPermissions } from './helpers/access';
import { startEmbeddedTestDatabase, type EmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-BE-IAM-E2E-AUDIT-01 PART 02: real HTTP/auth/RBAC/service/repository,
 * including actual PostgreSQL locks and rollback. Always uses a disposable
 * loopback cluster; setup failures fail the suite rather than skip it.
 * Existing migrations only, never an external/development/production DB.
 */
let pool: Pool;
let embedded: EmbeddedTestDatabase | undefined;
let owner: { token: string; userId: string };
let delegate: { token: string; userId: string; roleId: string };
let defaultGrants: unknown[];
let ownerCredential: unknown[];
const PERMISSION_MUTATION_LOCK = 724196035;
const defaultRoleCodes = ['PLATFORM_ADMIN', ...CANONICAL_ROLE_DEFINITIONS.map((r) => r.code)];
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function permissionId(code: string): Promise<string> {
  const found = await permissionRepository.findByCode(code);
  return found?.id ?? (await permissionService.createPermission({ code, name: code })).id;
}

async function role(codes: readonly string[] = []) {
  const created = await roleService.createRole({ code: `GRANT_${suffix()}`, name: 'Grant test role' });
  // Trusted fixture setup is intentionally distinct from authenticated HTTP.
  for (const code of codes) {
    await permissionService.assignPermissionToRole(created.id, await permissionId(code));
  }
  return created;
}

async function actor(codes: readonly string[]) {
  const token = await createSessionWithPermissions(codes.map((code) => ({ code, name: code })));
  const context = await sessionService.resolveSessionContext(token);
  const roles = await roleService.listRolesForUser(context.userId);
  assert.equal(roles.length, 1);
  return { token, userId: context.userId, roleId: roles[0]!.id };
}

function grant(token: string, roleId: string, id: string, claims: object = {}) {
  return api().post(`/api/v1/roles/${roleId}/permissions`)
    .set(auth(token)).send({ ...claims, permissionId: id });
}

async function assignments(roleId: string | null = null) {
  return (await pool.query(
    `SELECT * FROM role_permission_assignments
      WHERE ($1::uuid IS NULL OR role_id = $1) ORDER BY id`, [roleId],
  )).rows;
}

async function grantEvents(roleId: string | null = null) {
  return (await pool.query(
    `SELECT * FROM authentication_audit_events WHERE event_type = 'PERMISSION_GRANTED'
      AND ($1::text IS NULL OR metadata->>'roleId' = $1) ORDER BY id`, [roleId],
  )).rows;
}

async function canonicalGrants() {
  return (await pool.query(
    `SELECT r.code AS role, p.code AS permission
       FROM roles r JOIN role_permission_assignments rpa ON rpa.role_id = r.id
       JOIN permissions p ON p.id = rpa.permission_id
      WHERE r.code = ANY($1::text[]) AND rpa.status = 'ACTIVE' AND p.status = 'ACTIVE'
      ORDER BY r.code, p.code`, [defaultRoleCodes],
  )).rows;
}

async function denied(request: () => PromiseLike<Response>, code: string, status = 403) {
  const before = await assignments();
  const events = await grantEvents();
  const response = await request();
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
  assert.deepEqual(await assignments(), before, 'denial must not change ANY grant/history row');
  assert.deepEqual(await grantEvents(), events, 'denial must not emit a successful grant audit');
}

/** Wait on an observed PostgreSQL lock, not an assumed request timing. */
async function waitForLockWaiter(lock: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
         AND classid = 0 AND objid = $1::oid AND NOT granted) AS waiting`, [lock],
    );
    if (result.rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`grant did not wait on advisory lock ${lock}`);
}

/** Commit a concurrent authority change after HTTP RBAC, before grant checks. */
async function grantAfterConcurrentChange(
  lock: number,
  request: () => PromiseLike<Response>,
  mutate: (client: PoolClient) => Promise<void>,
) {
  const blocker = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock($1)', [lock]);
    pending = Promise.resolve(request());
    await waitForLockWaiter(lock);
    await mutate(blocker);
    await blocker.query('COMMIT');
    return await pending;
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await pending?.catch(() => undefined);
  }
}

before(async () => {
  embedded = await startEmbeddedTestDatabase({
    dir: `/tmp/hm-iam-grant-${randomUUID()}`, port: 55581,
  });
  const db = await ensureTestDatabase();
  assert.ok(db, 'disposable grant-authority database must be available');
  pool = await initDatabase(db);
  await migrateUp(pool);
  // Exercise real bootstrap defaults, not a test-invented role matrix.
  const result = await bootstrapOwner({
    email: 'grant-owner@example.com', displayName: 'Grant Owner', password: 'GrantOwnerPass123',
  });
  const session = await sessionService.createSessionForUser(result.ownerUserId);
  owner = { token: session.sessionToken, userId: result.ownerUserId };
  defaultGrants = await canonicalGrants();
  ownerCredential = (await pool.query('SELECT * FROM user_credentials WHERE user_id = $1', [owner.userId])).rows;
  delegate = await actor(['permission.manage', 'building.read', 'client.read']);
});

after(async () => {
  try {
    if (pool) await closePool(pool);
  } finally {
    await embedded?.stop();
  }
});

describe('permission grant authority — PART 02', () => {
  it('retains the exact bootstrap defaults and Owner withholding', async () => {
    assert.equal(FOUNDATION_PERMISSIONS.length, 365);
    assert.equal(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.size, 32);
    const expectedOwner = FOUNDATION_PERMISSIONS.map((p) => p.code)
      .filter((code) => !UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(code)).sort();
    const ownerRole = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(ownerRole);
    const actualOwner = await roleRepository.listActivePermissionCodesForRole(ownerRole.id);
    assert.equal(actualOwner.length, 333);
    assert.deepEqual([...actualOwner].sort(), expectedOwner);
    const counts: Record<string, number> = {
      SYSTEM_ADMIN: 9, CUSTOMER_CARE: 8, MANAGER: 29, OPERATIONS: 38, MOBILE_STAFF: 18,
    };
    for (const definition of CANONICAL_ROLE_DEFINITIONS) {
      const record = await roleRepository.findByCode(definition.code);
      assert.ok(record);
      const actual = await roleRepository.listActivePermissionCodesForRole(record.id);
      assert.equal(actual.length, counts[definition.code]);
      assert.deepEqual([...actual].sort(), [...definition.permissions].sort());
    }
  });

  it('allows an Owner grant beyond their current effective permissions and preserves audit context', async () => {
    const target = await role();
    const code = `grant.read.x${suffix().toLowerCase()}`;
    const id = await permissionId(code);
    assert.equal((await permissionService.resolvePermissionsForUser(owner.userId)).includes(code), false);
    const response = await grant(owner.token, target.id, id).set('User-Agent', 'part02-grant-regression');
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.id, id);
    const events = await grantEvents(target.id);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.outcome, 'SUCCESS');
    assert.equal(event.actor_user_id, owner.userId);
    assert.equal(event.request_id, response.headers['x-request-id']);
    assert.equal(event.user_agent, 'part02-grant-regression');
    assert.ok(event.ip_address);
    assert.deepEqual(event.metadata, {
      roleId: target.id, roleCode: target.code, permissionId: id, permissionCode: code,
    });
  });

  it('retains authorized Owner administration of protected roles, including PLATFORM_ADMIN', async () => {
    const ownerRole = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(ownerRole);
    const protectedRole = await role(['user.manage']);
    for (const target of [ownerRole, protectedRole]) {
      const id = await permissionId(`grant.read.x${suffix().toLowerCase()}`);
      const response = await grant(owner.token, target.id, id);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const cleanup = await api().delete(`/api/v1/roles/${target.id}/permissions/${id}`).set(auth(owner.token));
      assert.equal(cleanup.status, 200);
    }
    const target = await role();
    assert.equal((await grant(owner.token, target.id, await permissionId('user.manage'))).status, 201);
  });

  it('allows bounded delegated grants without requiring PLATFORM_ADMIN', async () => {
    const target = await role();
    assert.equal((await roleService.listRolesForUser(delegate.userId)).some((r) => r.code === 'PLATFORM_ADMIN'), false);
    const response = await grant(delegate.token, target.id, await permissionId('building.read'));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(await roleRepository.listActivePermissionCodesForRole(target.id), ['building.read']);
    assert.equal((await grantEvents(target.id))[0]!.actor_user_id, delegate.userId);
  });

  it('uses the live additive multi-role union for legitimate delegation', async () => {
    const multi = await actor(['permission.manage']);
    const supplied = await role(['building.read']);
    await roleService.assignRoleToUser(multi.userId, supplied.id);
    const target = await role();
    const response = await grant(multi.token, target.id, await permissionId('building.read'));
    assert.equal(response.status, 201, JSON.stringify(response.body));
  });

  it('denies unauthenticated and under-privileged actors without mutation', async () => {
    const target = await role();
    const id = await permissionId('building.read');
    await denied(() => api().post(`/api/v1/roles/${target.id}/permissions`).send({ permissionId: id }), 'AUTHENTICATION_REQUIRED', 401);
    const plain = await actor(['building.read']);
    await denied(() => grant(plain.token, target.id, id), 'PERMISSION_DENIED');
  });

  it('denies delegated elevation through the administrative role the caller holds', async () => {
    const id = await permissionId(`grant.read.x${suffix().toLowerCase()}`);
    const before = await permissionService.resolvePermissionsForUser(delegate.userId);
    await denied(() => grant(delegate.token, delegate.roleId, id), 'PRIVILEGED_ROLE_ASSIGNMENT_DENIED');
    assert.deepEqual(await permissionService.resolvePermissionsForUser(delegate.userId), before);
  });

  it('denies held ordinary-role elevation and cross-role self-consolidation', async () => {
    const held = await role();
    await roleService.assignRoleToUser(delegate.userId, held.id);
    const before = await permissionService.resolvePermissionsForUser(delegate.userId);
    const heldId = await permissionId('building.read');
    await denied(() => grant(delegate.token, held.id, heldId), 'PERMISSION_DENIED');
    const id = await permissionId(`grant.read.x${suffix().toLowerCase()}`);
    await denied(() => grant(delegate.token, held.id, id), 'PERMISSION_DENIED');
    assert.deepEqual(await permissionService.resolvePermissionsForUser(delegate.userId), before);
  });

  it('denies beyond-authority grants to an unheld ordinary role and ignores forged identity/scope claims', async () => {
    const target = await role();
    const code = `grant.read.x${suffix().toLowerCase()}`;
    const id = await permissionId(code);
    await denied(() => grant(delegate.token, target.id, id, {
      actorUserId: owner.userId, userId: owner.userId, roleCodes: ['PLATFORM_ADMIN'],
      permissions: ['permission.manage', code], clientId: randomUUID(), buildingId: randomUUID(),
    }), 'PERMISSION_DENIED');
  });

  for (const code of AUTHORITY_DEFINING_PERMISSIONS) {
    it(`denies delegated grants of authority-defining ${code}`, async () => {
      const target = await role();
      const id = await permissionId(code);
      await denied(() => grant(delegate.token, target.id, id), 'PRIVILEGED_ROLE_ASSIGNMENT_DENIED');
    });
  }

  it('protects PLATFORM_ADMIN and any role already granting administrative authority', async () => {
    const ownerRole = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(ownerRole);
    const protectedRole = await role(['user.manage']);
    const id = await permissionId('building.read');
    for (const target of [ownerRole, protectedRole]) {
      await denied(() => grant(delegate.token, target.id, id), 'PRIVILEGED_ROLE_ASSIGNMENT_DENIED');
    }
  });

  it('rejects unknown or inactive actors at the service boundary using live backend state', async () => {
    const inactive = await actor(['permission.manage', 'building.read']);
    await pool.query("UPDATE users SET status = 'INACTIVE' WHERE id = $1", [inactive.userId]);
    const target = await role();
    const id = await permissionId('building.read');
    const before = await assignments();
    const events = await grantEvents();
    for (const userId of [randomUUID(), inactive.userId]) {
      await assert.rejects(permissionService.assignPermissionToRole(target.id, id, userId), {
        statusCode: 403, code: 'PERMISSION_DENIED',
      });
    }
    assert.deepEqual(await assignments(), before);
    assert.deepEqual(await grantEvents(), events);
  });

  for (const lostCode of ['permission.manage', 'building.read']) {
    it(`rechecks ${lostCode} after a concurrent revocation that passed HTTP RBAC`, async () => {
      const fresh = await actor(['permission.manage', 'building.read']);
      const target = await role();
      const id = await permissionId('building.read');
      const lostId = await permissionId(lostCode);
      const before = await assignments(target.id);
      const events = await grantEvents(target.id);
      const response = await grantAfterConcurrentChange(
        PERMISSION_MUTATION_LOCK,
        () => grant(fresh.token, target.id, id),
        async (client) => {
          assert.equal(await permissionRepository.revokeAssignment(fresh.roleId, lostId, client), true);
        },
      );
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'PERMISSION_DENIED');
      assert.deepEqual(await assignments(target.id), before);
      assert.deepEqual(await grantEvents(target.id), events);
    });
  }

  it('rechecks held-role membership after a concurrent role assignment', async () => {
    const target = await role();
    const before = await assignments();
    const events = await grantEvents();
    const id = await permissionId('building.read');
    const response = await grantAfterConcurrentChange(
      ROLE_MUTATION_LOCK,
      () => grant(delegate.token, target.id, id),
      async (client) => { await roleRepository.createAssignment(delegate.userId, target.id, client); },
    );
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(await assignments(), before);
    assert.deepEqual(await grantEvents(), events);
  });

  it('rechecks Owner membership after a concurrent role revocation', async () => {
    const formerOwner = await actor(['permission.manage', 'building.read']);
    const ownerRole = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(ownerRole);
    await roleService.assignRoleToUser(formerOwner.userId, ownerRole.id);
    const target = await role();
    const id = await permissionId(`grant.read.x${suffix().toLowerCase()}`);
    const before = await assignments();
    const events = await grantEvents();
    const response = await grantAfterConcurrentChange(
      ROLE_MUTATION_LOCK,
      () => grant(formerOwner.token, target.id, id),
      async (client) => { assert.equal(await roleRepository.revokeAssignment(formerOwner.userId, ownerRole.id, client), true); },
    );
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.deepEqual(await assignments(), before);
    assert.deepEqual(await grantEvents(), events);
  });

  it('serializes duplicate grants and emits exactly one successful audit', async () => {
    const target = await role();
    const id = await permissionId('building.read');
    const responses = await Promise.all([
      grant(delegate.token, target.id, id), grant(delegate.token, target.id, id),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(responses.find((r) => r.status === 409)!.body.error.code, 'PERMISSION_ALREADY_ASSIGNED');
    assert.equal((await assignments(target.id)).length, 1);
    assert.equal((await grantEvents(target.id)).length, 1);
  });

  it('rolls back an insert failure without leaving a grant or success audit', async (t) => {
    const target = await role();
    const id = await permissionId('building.read');
    const before = await assignments();
    const events = await grantEvents();
    const original = permissionRepository.createAssignment;
    const mocked = t.mock.method(permissionRepository, 'createAssignment', async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('intentional PART 02 rollback regression');
    });
    try {
      assert.equal((await grant(delegate.token, target.id, id)).status, 500);
    } finally {
      mocked.mock.restore();
    }
    assert.deepEqual(await assignments(), before);
    assert.deepEqual(await grantEvents(), events);
  });

  it('does not convert granted global capabilities into cross-Client or cross-Building data access', async () => {
    const ownClient = await clientService.createClient({ code: `C_${suffix()}`, name: 'Own Client' });
    const foreignClient = await clientService.createClient({ code: `C_${suffix()}`, name: 'Foreign Client' });
    const ownProperty = await propertyService.createProperty({ clientId: ownClient.id, code: `P_${suffix()}`, name: 'Own Property' });
    const foreignProperty = await propertyService.createProperty({ clientId: foreignClient.id, code: `P_${suffix()}`, name: 'Foreign Property' });
    const ownBuilding = await buildingService.createBuilding({ propertyId: ownProperty.id, code: `B_${suffix()}`, name: 'Assigned' });
    const sibling = await buildingService.createBuilding({ propertyId: ownProperty.id, code: `B_${suffix()}`, name: 'Unassigned sibling' });
    const foreignBuilding = await buildingService.createBuilding({ propertyId: foreignProperty.id, code: `B_${suffix()}`, name: 'Foreign' });
    const consumer = await actor([]);
    const target = await role();
    await roleService.assignRoleToUser(consumer.userId, target.id);
    await buildingAssignmentService.createAssignment(consumer.userId, { buildingId: ownBuilding.id });
    const scopeBefore = (await pool.query('SELECT * FROM user_building_assignments ORDER BY id')).rows;
    for (const code of ['building.read', 'client.read']) {
      const response = await grant(delegate.token, target.id, await permissionId(code), {
        clientId: foreignClient.id, buildingId: foreignBuilding.id, buildingIds: [foreignBuilding.id],
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
    }
    assert.deepEqual((await pool.query('SELECT * FROM user_building_assignments ORDER BY id')).rows, scopeBefore);
    assert.equal((await api().get(`/api/v1/buildings/${ownBuilding.id}`).set(auth(consumer.token))).status, 200);
    for (const id of [sibling.id, foreignBuilding.id]) {
      const response = await api().get(`/api/v1/buildings/${id}`).set(auth(consumer.token));
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }
    assert.equal((await api().get(`/api/v1/clients/${ownClient.id}`).set(auth(consumer.token))).status, 200);
    const forbiddenClient = await api().get(`/api/v1/clients/${foreignClient.id}`).set(auth(consumer.token));
    assert.equal(forbiddenClient.status, 403);
    assert.equal(forbiddenClient.body.error.code, 'CLIENT_ACCESS_DENIED');
  });

  it('preserves last-Owner protection, default grants, credentials and existing sessions', async () => {
    const ownerRole = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(ownerRole);
    const before = await assignments();
    const response = await api().delete(`/api/v1/users/${owner.userId}/roles/${ownerRole.id}`).set(auth(owner.token));
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'LAST_OWNER_ROLE_REQUIRED');
    assert.deepEqual(await assignments(), before);
    assert.deepEqual(await canonicalGrants(), defaultGrants);
    assert.deepEqual((await pool.query('SELECT * FROM user_credentials WHERE user_id = $1', [owner.userId])).rows, ownerCredential);
    assert.equal((await sessionService.resolveSessionContext(owner.token)).userId, owner.userId);
  });
});
