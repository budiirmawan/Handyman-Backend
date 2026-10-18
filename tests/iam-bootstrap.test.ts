import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  BootstrapError,
  CANONICAL_ROLE_DEFINITIONS,
  bootstrapOwner,
  getOwnerBootstrapStatus,
  parseBootstrapOwnerArgs,
} from '../src/modules/iam-bootstrap';
import { credentialService } from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-IAM-BOOTSTRAP-01 — focused delivery tests.
 *
 * Covers the one-time first-owner CLI service (success, refusal, rollback,
 * password verification) and the authenticated user/role/credential
 * management contract (scoped RBAC + escalation denial + session revocation).
 */

const DB_PORT = 55461;
const DATA_DIR = '/tmp/asentra-iam-bootstrap-pg';
const DB_NAME = 'asentra_iam_bootstrap_test';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const API_PREFIX = '/api/v1';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = DB_NAME;

if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = '';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let ownerUserId = '';
let ownerToken = '';
let ownerPassword = '';
let careUserId = '';
let careEmail = '';
let careToken = '';
let systemAdminToken = '';
let systemAdminUserId = '';
let systemAdminEmail = '';

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
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, permissions CASCADE');
}, { timeout: 180000 });

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
    t.skip('embedded PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function login(email: string, password: string) {
  return api().post(`${API_PREFIX}/auth/login`).send({ email, password });
}

async function roleId(code: string): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    'SELECT id FROM roles WHERE code = $1',
    [code],
  );
  const id = result.rows[0]?.id;
  assert.ok(id, `role ${code} must exist`);
  return id;
}

async function onboardUser(
  adminToken: string,
  email: string,
  password: string,
  roleCode: string,
): Promise<{ userId: string; token: string }> {
  const invitation = await api()
    .post(`${API_PREFIX}/invitations`)
    .set(auth(adminToken))
    .send({ email });
  assert.equal(invitation.status, 201);

  const accepted = await api().post(`${API_PREFIX}/invitations/accept`).send({
    token: invitation.body.data.invitationToken,
    displayName: `${roleCode} Persona`,
    password,
  });
  assert.equal(accepted.status, 200);

  const userId = accepted.body.data.user.id as string;
  const assigned = await api()
    .post(`${API_PREFIX}/users/${userId}/roles`)
    .set(auth(adminToken))
    .send({ roleId: await roleId(roleCode) });
  assert.equal(assigned.status, 201);

  const session = await login(email, password);
  assert.equal(session.status, 200);

  return { userId, token: session.body.data.sessionToken as string };
}

describe('CR-HM-IAM-BOOTSTRAP-01 — operator CLI argument safety', () => {
  it('rejects a password supplied as an argument', () => {
    assert.throws(
      () =>
        parseBootstrapOwnerArgs([
          '--email',
          'owner@example.com',
          '--display-name',
          'Owner',
          '--password',
          'ShouldNeverBeHere123',
        ]),
      /never be supplied as command-line arguments/,
    );
  });

  it('rejects missing identity fields and unknown arguments', () => {
    assert.throws(() => parseBootstrapOwnerArgs([]), /required/);
    assert.throws(
      () => parseBootstrapOwnerArgs(['--token', 'abc']),
      /Unknown argument/,
    );
  });

  it('accepts only the non-secret identity flags', () => {
    assert.deepEqual(
      parseBootstrapOwnerArgs([
        '--email=owner@example.com',
        '--display-name',
        'First Owner',
      ]),
      { email: 'owner@example.com', displayName: 'First Owner' },
    );
  });
});

describe('CR-HM-IAM-BOOTSTRAP-01 — first-owner bootstrap', () => {
  it('reports a fresh, migration-ready, empty database', async (t) => {
    if (!requireDatabase(t)) return;

    const status = await getOwnerBootstrapStatus();
    assert.equal(status.schemaReady, true);
    assert.equal(status.completed, false);
    assert.equal(status.userCount, 0);
    assert.equal(status.ownerUserId, null);
  });

  it('rejects a password below the existing policy without touching the database', async (t) => {
    if (!requireDatabase(t)) return;

    await assert.rejects(
      () =>
        bootstrapOwner({
          email: 'owner@example.com',
          displayName: 'First Owner',
          password: 'short',
        }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'PASSWORD_POLICY_VIOLATION',
    );

    const users = await pool!.query('SELECT count(*)::int AS count FROM users');
    assert.equal(users.rows[0].count, 0);
  });

  it('refuses to bootstrap when the users table is not empty', async (t) => {
    if (!requireDatabase(t)) return;

    await userService.createUser({
      email: 'existing@example.com',
      displayName: 'Existing User',
    });

    await assert.rejects(
      () =>
        bootstrapOwner({
          email: 'owner@example.com',
          displayName: 'First Owner',
          password: 'FirstOwnerPass123',
        }),
      (error: unknown) =>
        error instanceof BootstrapError &&
        error.code === 'IAM_BOOTSTRAP_USERS_EXIST',
    );

    const roles = await pool!.query('SELECT count(*)::int AS count FROM roles');
    assert.equal(roles.rows[0].count, 0, 'no canonical role may be created');

    await pool!.query('TRUNCATE users CASCADE');
  });

  it('rolls the entire bootstrap back when the final step fails', async (t) => {
    if (!requireDatabase(t)) return;

    await pool!.query(`
      CREATE OR REPLACE FUNCTION iam_bootstrap_failure_probe()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected bootstrap failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool!.query(`
      CREATE TRIGGER iam_bootstrap_failure_probe_trigger
      BEFORE INSERT ON iam_bootstrap_state
      FOR EACH ROW EXECUTE FUNCTION iam_bootstrap_failure_probe()
    `);

    try {
      await assert.rejects(
        () =>
          bootstrapOwner({
            email: 'rollback-owner@example.com',
            displayName: 'Rollback Owner',
            password: 'RollbackPass123',
          }),
        /injected bootstrap failure/,
      );
    } finally {
      await pool!.query(
        'DROP TRIGGER IF EXISTS iam_bootstrap_failure_probe_trigger ON iam_bootstrap_state',
      );
      await pool!.query(
        'DROP FUNCTION IF EXISTS iam_bootstrap_failure_probe()',
      );
    }

    for (const table of [
      'users',
      'user_credentials',
      'roles',
      'permissions',
      'user_role_assignments',
      'role_permission_assignments',
      'authentication_audit_events',
      'iam_bootstrap_state',
    ]) {
      const result = await pool!.query(
        `SELECT count(*)::int AS count FROM ${table}`,
      );
      assert.equal(result.rows[0].count, 0, `${table} must be rolled back`);
    }

    const status = await getOwnerBootstrapStatus();
    assert.equal(status.completed, false);
  });

  it('creates exactly one Owner and the canonical persona roles', async (t) => {
    if (!requireDatabase(t)) return;

    ownerPassword = 'FirstOwnerPass123';
    const result = await bootstrapOwner({
      email: 'OWNER@Example.com ',
      displayName: ' First Owner ',
      password: ownerPassword,
    });

    ownerUserId = result.ownerUserId;
    assert.equal(result.email, 'owner@example.com');
    assert.equal(result.displayName, 'First Owner');
    assert.deepEqual(result.roleCodes, ['PLATFORM_ADMIN']);
    assert.ok(result.effectivePermissionCount > 0);
    assert.deepEqual(
      [...result.canonicalRoleCodes].sort(),
      CANONICAL_ROLE_DEFINITIONS.map((role) => role.code).sort(),
    );

    // Secret material is never part of the result.
    assert.equal(JSON.stringify(result).includes(ownerPassword), false);

    const users = await pool!.query('SELECT count(*)::int AS count FROM users');
    assert.equal(users.rows[0].count, 1);

    const credential = await pool!.query<{ password_hash: string }>(
      'SELECT password_hash FROM user_credentials WHERE user_id = $1',
      [ownerUserId],
    );
    assert.match(credential.rows[0].password_hash, /^\$2[aby]\$12\$/);
    assert.equal(credential.rows[0].password_hash.includes(ownerPassword), false);
    assert.equal(
      await credentialService.verifyPasswordForUser(ownerUserId, ownerPassword),
      true,
    );

    const ownerRole = await pool!.query<{ id: string; code: string }>(
      `SELECT r.id, r.code
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
        WHERE ura.user_id = $1 AND ura.status = 'ACTIVE' AND r.status = 'ACTIVE'`,
      [ownerUserId],
    );
    assert.deepEqual(ownerRole.rows.map((row) => row.code), ['PLATFORM_ADMIN']);
    ownerToken = (await login(result.email, ownerPassword)).body.data
      .sessionToken as string;

    for (const definition of CANONICAL_ROLE_DEFINITIONS) {
      const roles = await pool!.query(
        'SELECT count(*)::int AS count FROM roles WHERE code = $1 AND status = $2',
        [definition.code, 'ACTIVE'],
      );
      assert.equal(roles.rows[0].count, 1, `${definition.code} must exist`);
    }

    const assignments = await pool!.query(
      'SELECT count(*)::int AS count FROM user_building_assignments',
    );
    assert.equal(
      assignments.rows[0].count,
      0,
      'bootstrap must not create Building assignments',
    );

    const audit = await pool!.query<{ metadata: string }>(
      `SELECT metadata::text AS metadata
         FROM authentication_audit_events
        WHERE event_type = 'OWNER_BOOTSTRAPPED'`,
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].metadata.includes(ownerPassword), false);
  });

  it('refuses a second bootstrap on the same database', async (t) => {
    if (!requireDatabase(t)) return;

    await assert.rejects(
      () =>
        bootstrapOwner({
          email: 'second-owner@example.com',
          displayName: 'Second Owner',
          password: 'SecondOwnerPass123',
        }),
      (error: unknown) =>
        error instanceof BootstrapError &&
        error.code === 'IAM_BOOTSTRAP_ALREADY_COMPLETED',
    );

    const users = await pool!.query('SELECT count(*)::int AS count FROM users');
    assert.equal(users.rows[0].count, 1);
  });

  it('authenticates the Owner with the expected withheld-permission posture', async (t) => {
    if (!requireDatabase(t)) return;

    const me = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set(auth(ownerToken));
    assert.equal(me.status, 200);
    assert.deepEqual(
      me.body.data.access.roles.map((role: { code: string }) => role.code),
      ['PLATFORM_ADMIN'],
    );

    const permissions = me.body.data.access.permissions as string[];
    for (const required of [
      'user.read',
      'user.manage',
      'role.read',
      'role.manage',
      'permission.read',
      'permission.manage',
      'auth.audit.read',
      'tenant_company.read',
      'management_read_model.read',
    ]) {
      assert.ok(permissions.includes(required), `${required} expected`);
    }

    for (const withheld of [
      'handyman.care.building',
      'handyman.finance.manage',
      'handyman.settlement.manage',
      'handyman.bast.manage',
      'operational_budget.override',
      'fx_rate.approve',
      'rfq.award',
      'price_catalog.override',
      'platform.customer.read',
    ]) {
      assert.equal(
        permissions.includes(withheld),
        false,
        `${withheld} must stay a deliberate post-bootstrap grant`,
      );
    }
  });

  it('lists accounts through the bounded user-management surface', async (t) => {
    if (!requireDatabase(t)) return;

    const listed = await api()
      .get(`${API_PREFIX}/users?page=1&pageSize=10`)
      .set(auth(ownerToken));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.meta.total, 1);
    assert.equal(listed.body.meta.page, 1);
    assert.equal(listed.body.data[0].email, 'owner@example.com');
    assert.equal('passwordHash' in listed.body.data[0], false);

    const byEmail = await api()
      .get(`${API_PREFIX}/users?email=owner@example.com`)
      .set(auth(ownerToken));
    assert.equal(byEmail.status, 200);
    assert.equal(byEmail.body.data.length, 1);
  });

  it('grants each canonical role exactly its documented permission set', async (t) => {
    if (!requireDatabase(t)) return;

    for (const definition of CANONICAL_ROLE_DEFINITIONS) {
      const permissions = await api()
        .get(`${API_PREFIX}/roles/${await roleId(definition.code)}/permissions`)
        .set(auth(ownerToken));
      assert.equal(permissions.status, 200);
      assert.deepEqual(
        permissions.body.data
          .map((permission: { code: string }) => permission.code)
          .sort(),
        [...definition.permissions].sort(),
        `${definition.code} grants`,
      );
    }

    const systemAdmin = await api()
      .get(`${API_PREFIX}/roles/${await roleId('SYSTEM_ADMIN')}/permissions`)
      .set(auth(ownerToken));
    const systemAdminCodes = systemAdmin.body.data.map(
      (permission: { code: string }) => permission.code,
    );
    assert.equal(systemAdminCodes.includes('role.manage'), false);
    assert.equal(systemAdminCodes.includes('permission.manage'), false);

    const mobile = await api()
      .get(`${API_PREFIX}/roles/${await roleId('MOBILE_STAFF')}/permissions`)
      .set(auth(ownerToken));
    const mobileCodes = mobile.body.data.map(
      (permission: { code: string }) => permission.code,
    );
    assert.equal(mobileCodes.includes('tenant_company.manage'), false);
    assert.equal(mobileCodes.includes('user.manage'), false);
  });

  it('onboards a Customer Care user and denies privileged escalation', async (t) => {
    if (!requireDatabase(t)) return;

    careEmail = `care-${randomUUID().slice(0, 8)}@example.com`;
    const carePassword = 'CarePassword123';
    const care = await onboardUser(
      ownerToken,
      careEmail,
      carePassword,
      'CUSTOMER_CARE',
    );
    careUserId = care.userId;
    careToken = care.token;

    const me = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set(auth(careToken));
    assert.equal(me.status, 200);
    assert.deepEqual(
      me.body.data.access.roles.map((role: { code: string }) => role.code),
      ['CUSTOMER_CARE'],
    );
    const carePermissions = me.body.data.access.permissions as string[];
    assert.ok(carePermissions.includes('handyman.care.building'));
    assert.ok(carePermissions.includes('tenant_company.read'));
    for (const forbidden of [
      'user.manage',
      'role.manage',
      'permission.manage',
      'handyman.finance.manage',
      'platform.customer.read',
    ]) {
      assert.equal(carePermissions.includes(forbidden), false);
    }

    const userList = await api()
      .get(`${API_PREFIX}/users`)
      .set(auth(careToken));
    assert.equal(userList.status, 403);

    const createUser = await api()
      .post(`${API_PREFIX}/users`)
      .set(auth(careToken))
      .send({ email: 'escalation@example.com', displayName: 'Escalation' });
    assert.equal(createUser.status, 403);

    const grantPermission = await api()
      .post(`${API_PREFIX}/roles/${await roleId('CUSTOMER_CARE')}/permissions`)
      .set(auth(careToken))
      .send({ permissionId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(grantPermission.status, 403);

    const resetOwner = await api()
      .post(`${API_PREFIX}/users/${ownerUserId}/password-reset`)
      .set(auth(careToken))
      .send({ newPassword: 'TakeoverPass123' });
    assert.equal(resetOwner.status, 403);
  });

  it('resets a password, invalidates sessions and forces a self-service change', async (t) => {
    if (!requireDatabase(t)) return;

    const reset = await api()
      .post(`${API_PREFIX}/users/${careUserId}/password-reset`)
      .set(auth(ownerToken))
      .send({ newPassword: 'CareResetPass456' });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body.data, {
      reset: true,
      mustChangePassword: true,
    });
    assert.equal(JSON.stringify(reset.body).includes('CareResetPass456'), false);

    const revoked = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set(auth(careToken));
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error.code, 'INVALID_SESSION');

    const flag = await pool!.query<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM user_credentials WHERE user_id = $1',
      [careUserId],
    );
    assert.equal(flag.rows[0].must_change_password, true);

    assert.equal((await login(careEmail, 'CarePassword123')).status, 401);
    const tempSession = await login(careEmail, 'CareResetPass456');
    assert.equal(tempSession.status, 200);
    const secondSession = await login(careEmail, 'CareResetPass456');
    assert.equal(secondSession.status, 200);

    const changed = await api()
      .post(`${API_PREFIX}/auth/password`)
      .set(auth(tempSession.body.data.sessionToken as string))
      .send({
        currentPassword: 'CareResetPass456',
        newPassword: 'CareFinalPass789',
      });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.data, { changed: true });

    // The session that changed the password stays valid; other sessions die.
    assert.equal(
      (
        await api()
          .get(`${API_PREFIX}/auth/me`)
          .set(auth(tempSession.body.data.sessionToken as string))
      ).status,
      200,
    );
    assert.equal(
      (
        await api()
          .get(`${API_PREFIX}/auth/me`)
          .set(auth(secondSession.body.data.sessionToken as string))
      ).status,
      401,
    );

    careToken = tempSession.body.data.sessionToken as string;

    const cleared = await pool!.query<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM user_credentials WHERE user_id = $1',
      [careUserId],
    );
    assert.equal(cleared.rows[0].must_change_password, false);

    assert.equal((await login(careEmail, 'CareResetPass456')).status, 401);
    assert.equal((await login(careEmail, 'CareFinalPass789')).status, 200);
  });

  it('revokes role assignments and protects the last Owner', async (t) => {
    if (!requireDatabase(t)) return;

    const careRoleId = await roleId('CUSTOMER_CARE');
    const revoked = await api()
      .delete(`${API_PREFIX}/users/${careUserId}/roles/${careRoleId}`)
      .set(auth(ownerToken));
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.code, 'CUSTOMER_CARE');

    const repeated = await api()
      .delete(`${API_PREFIX}/users/${careUserId}/roles/${careRoleId}`)
      .set(auth(ownerToken));
    assert.equal(repeated.status, 404);
    assert.equal(repeated.body.error.code, 'ROLE_ASSIGNMENT_NOT_FOUND');

    const me = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set(auth(careToken));
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data.access.roles, []);
    assert.equal(
      (me.body.data.access.permissions as string[]).includes(
        'handyman.care.building',
      ),
      false,
    );

    const ownerRoleId = await roleId('PLATFORM_ADMIN');
    const lastOwner = await api()
      .delete(`${API_PREFIX}/users/${ownerUserId}/roles/${ownerRoleId}`)
      .set(auth(ownerToken));
    assert.equal(lastOwner.status, 409);
    assert.equal(lastOwner.body.error.code, 'LAST_OWNER_ROLE_REQUIRED');
  });

  it('prevents a System Admin from taking over the Owner account', async (t) => {
    if (!requireDatabase(t)) return;

    const email = `sysadmin-${randomUUID().slice(0, 8)}@example.com`;
    const systemAdmin = await onboardUser(
      ownerToken,
      email,
      'SystemAdminPass123',
      'SYSTEM_ADMIN',
    );
    systemAdminToken = systemAdmin.token;
    systemAdminUserId = systemAdmin.userId;
    systemAdminEmail = email;

    const resetOwner = await api()
      .post(`${API_PREFIX}/users/${ownerUserId}/password-reset`)
      .set(auth(systemAdminToken))
      .send({ newPassword: 'TakeoverPass123' });
    assert.equal(resetOwner.status, 403);
    assert.equal(
      resetOwner.body.error.code,
      'PRIVILEGED_ACCOUNT_RESET_DENIED',
    );

    const assignRole = await api()
      .post(`${API_PREFIX}/users/${systemAdmin.userId}/roles`)
      .set(auth(systemAdminToken))
      .send({ roleId: await roleId('PLATFORM_ADMIN') });
    assert.equal(assignRole.status, 403);

    const createRole = await api()
      .post(`${API_PREFIX}/roles`)
      .set(auth(systemAdminToken))
      .send({ code: 'SHADOW_ADMIN', name: 'Shadow Admin' });
    assert.equal(createRole.status, 403);

    const listUsers = await api()
      .get(`${API_PREFIX}/users`)
      .set(auth(systemAdminToken));
    assert.equal(listUsers.status, 200);
  });

  it('prevents a System Admin from suspending or hijacking the Owner account', async (t) => {
    if (!requireDatabase(t)) return;

    const suspendOwner = await api()
      .post(`${API_PREFIX}/users/${ownerUserId}/suspend`)
      .set(auth(systemAdminToken))
      .send({});
    assert.equal(suspendOwner.status, 403);
    assert.equal(suspendOwner.body.error.code, 'PRIVILEGED_ACCOUNT_PROTECTED');

    const deactivateOwner = await api()
      .post(`${API_PREFIX}/users/${ownerUserId}/deactivate`)
      .set(auth(systemAdminToken))
      .send({});
    assert.equal(deactivateOwner.status, 403);
    assert.equal(deactivateOwner.body.error.code, 'PRIVILEGED_ACCOUNT_PROTECTED');

    const hijackContact = await api()
      .patch(`${API_PREFIX}/users/${ownerUserId}/whatsapp-contact`)
      .set(auth(systemAdminToken))
      .send({ whatsappPhone: '+628123456789', consent: 'OPT_IN' });
    assert.equal(hijackContact.status, 403);
    assert.equal(hijackContact.body.error.code, 'PRIVILEGED_ACCOUNT_PROTECTED');

    const ownerStillActive = await api()
      .get(`${API_PREFIX}/users/${ownerUserId}`)
      .set(auth(systemAdminToken));
    assert.equal(ownerStillActive.status, 200);
    assert.equal(ownerStillActive.body.data.status, 'ACTIVE');

    // The same administrator can still manage an ordinary account, so the
    // guard is targeted rather than a blanket denial.
    const ordinary = await api()
      .post(`${API_PREFIX}/users`)
      .set(auth(ownerToken))
      .send({
        email: `ordinary-${randomUUID().slice(0, 8)}@example.com`,
        displayName: 'Ordinary Lifecycle',
      });
    assert.equal(ordinary.status, 201);
    const ordinaryId = ordinary.body.data.id as string;

    assert.equal(
      (
        await api()
          .post(`${API_PREFIX}/users/${ordinaryId}/deactivate`)
          .set(auth(systemAdminToken))
          .send({})
      ).status,
      200,
    );
    assert.equal(
      (
        await api()
          .post(`${API_PREFIX}/users/${ordinaryId}/reactivate`)
          .set(auth(systemAdminToken))
          .send({})
      ).status,
      200,
    );
  });

  it('refuses an owner-initiated self-suspension', async (t) => {
    if (!requireDatabase(t)) return;

    const selfSuspend = await api()
      .post(`${API_PREFIX}/users/${ownerUserId}/suspend`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(selfSuspend.status, 403);
    assert.equal(selfSuspend.body.error.code, 'SELF_ACCOUNT_ACTION_DENIED');

    const selfDeactivate = await api()
      .post(`${API_PREFIX}/users/${ownerUserId}/deactivate`)
      .set(auth(ownerToken))
      .send({});
    assert.equal(selfDeactivate.status, 403);
    assert.equal(selfDeactivate.body.error.code, 'SELF_ACCOUNT_ACTION_DENIED');

    const me = await api().get(`${API_PREFIX}/auth/me`).set(auth(ownerToken));
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.status, 'ACTIVE');
  });

  it('denies privilege escalation through a delegated role.manage grant', async (t) => {
    if (!requireDatabase(t)) return;

    const created = await api()
      .post(`${API_PREFIX}/roles`)
      .set(auth(ownerToken))
      .send({ code: 'DELEGATED_ADMIN', name: 'Delegated Administrator' });
    assert.equal(created.status, 201);
    const delegatedRoleId = created.body.data.id as string;

    const ownerPermissions = await api()
      .get(`${API_PREFIX}/roles/${await roleId('PLATFORM_ADMIN')}/permissions`)
      .set(auth(ownerToken));
    const roleManage = (ownerPermissions.body.data as { id: string; code: string }[])
      .find((permission) => permission.code === 'role.manage');
    assert.ok(roleManage, 'the owner role must carry role.manage');

    const granted = await api()
      .post(`${API_PREFIX}/roles/${delegatedRoleId}/permissions`)
      .set(auth(ownerToken))
      .send({ permissionId: roleManage.id });
    assert.ok(granted.status < 300, 'owner may delegate role.manage');

    const assigned = await api()
      .post(`${API_PREFIX}/users/${systemAdminUserId}/roles`)
      .set(auth(ownerToken))
      .send({ roleId: delegatedRoleId });
    assert.equal(assigned.status, 201);

    // The delegated administrator now holds role.manage but still cannot
    // assign PLATFORM_ADMIN (defense in depth beyond the route permission).
    const escalate = await api()
      .post(`${API_PREFIX}/users/${systemAdminUserId}/roles`)
      .set(auth(systemAdminToken))
      .send({ roleId: await roleId('PLATFORM_ADMIN') });
    assert.equal(escalate.status, 403);
    assert.equal(
      escalate.body.error.code,
      'PRIVILEGED_ROLE_ASSIGNMENT_DENIED',
    );

    const stillOwner = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set(auth(ownerToken));
    assert.equal(stillOwner.status, 200);
    assert.deepEqual(
      stillOwner.body.data.access.roles.map((role: { code: string }) => role.code),
      ['PLATFORM_ADMIN'],
    );
  });

  it('enforces the mandatory password change on every other operation', async (t) => {
    if (!requireDatabase(t)) return;

    const reset = await api()
      .post(`${API_PREFIX}/users/${systemAdminUserId}/password-reset`)
      .set(auth(ownerToken))
      .send({ newPassword: 'TempSystemPass456' });
    assert.equal(reset.status, 200);

    const tempSession = await login(systemAdminEmail, 'TempSystemPass456');
    assert.equal(tempSession.status, 200);
    const tempToken = tempSession.body.data.sessionToken as string;

    const status = await api()
      .get(`${API_PREFIX}/auth/password/status`)
      .set(auth(tempToken));
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.data, { mustChangePassword: true });

    // Reading the own effective context is allowed while the change is pending.
    assert.equal(
      (await api().get(`${API_PREFIX}/auth/me`).set(auth(tempToken))).status,
      200,
    );

    // Every other authenticated operation is refused server-side.
    const blocked = await api()
      .get(`${API_PREFIX}/users`)
      .set(auth(tempToken));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

    const blockedMutation = await api()
      .post(`${API_PREFIX}/users/${systemAdminUserId}/suspend`)
      .set(auth(tempToken))
      .send({});
    assert.equal(blockedMutation.status, 403);
    assert.equal(
      blockedMutation.body.error.code,
      'PASSWORD_CHANGE_REQUIRED',
    );

    // Logout stays reachable with a second session (the first is kept for the
    // change flow below).
    const logoutSession = await login(systemAdminEmail, 'TempSystemPass456');
    assert.equal(logoutSession.status, 200);
    assert.equal(
      (
        await api()
          .post(`${API_PREFIX}/auth/logout`)
          .set(auth(logoutSession.body.data.sessionToken as string))
          .send({})
      ).status,
      200,
    );

    const wrongCurrent = await api()
      .post(`${API_PREFIX}/auth/password`)
      .set(auth(tempToken))
      .send({
        currentPassword: 'DefinitelyWrong123',
        newPassword: 'FinalSystemPass789',
      });
    assert.equal(wrongCurrent.status, 401);

    const changed = await api()
      .post(`${API_PREFIX}/auth/password`)
      .set(auth(tempToken))
      .send({
        currentPassword: 'TempSystemPass456',
        newPassword: 'FinalSystemPass789',
      });
    assert.equal(changed.status, 200);

    const cleared = await api()
      .get(`${API_PREFIX}/auth/password/status`)
      .set(auth(tempToken));
    assert.deepEqual(cleared.body.data, { mustChangePassword: false });
    assert.equal(
      (await api().get(`${API_PREFIX}/users`).set(auth(tempToken))).status,
      200,
    );
    assert.equal((await login(systemAdminEmail, 'TempSystemPass456')).status, 401);
    assert.equal((await login(systemAdminEmail, 'FinalSystemPass789')).status, 200);
  });

  it('denies Customer Care dispatch, BAST and payment mutations', async (t) => {
    if (!requireDatabase(t)) return;

    const email = `care2-${randomUUID().slice(0, 8)}@example.com`;
    const care = await onboardUser(
      ownerToken,
      email,
      'CareSecondPass123',
      'CUSTOMER_CARE',
    );

    const me = await api().get(`${API_PREFIX}/auth/me`).set(auth(care.token));
    assert.equal(me.status, 200);
    const permissions = me.body.data.access.permissions as string[];
    assert.ok(permissions.includes('handyman.care.building'));
    assert.ok(permissions.includes('tenant_company.read'));
    assert.ok(permissions.includes('service_request.manage'));
    assert.equal(permissions.includes('tenant_company.manage'), false);

    const scopeId = randomUUID();
    for (const [path, body] of [
      [`${API_PREFIX}/handyman/execution-scopes/${scopeId}/dispatch/release`, {}],
      [`${API_PREFIX}/handyman/execution-scopes/${scopeId}/dispatch/cancel`, {}],
      [`${API_PREFIX}/handyman/bast/${randomUUID()}/accept`, {}],
      [`${API_PREFIX}/handyman/bast/${randomUUID()}/sign-off`, {}],
      [`${API_PREFIX}/handyman/execution-scopes/${scopeId}/customer-payments`, {
        amount: 1000,
        idempotencyKey: randomUUID(),
      }],
      [`${API_PREFIX}/handyman/execution-scopes/${scopeId}/customer-payments/${randomUUID()}/confirm`, {}],
      [`${API_PREFIX}/handyman/requests/${randomUUID()}/triage`, {}],
    ] as [string, Record<string, unknown>][]) {
      const response = await api()
        .post(path)
        .set(auth(care.token))
        .send(body);
      assert.equal(response.status, 403, `${path} must be denied`);
      assert.equal(response.body.error.code, 'PERMISSION_DENIED', path);
    }
  });

  it('reports the completed bootstrap and the one-owner state', async (t) => {
    if (!requireDatabase(t)) return;

    const status = await getOwnerBootstrapStatus();
    assert.equal(status.completed, true);
    assert.equal(status.ownerUserId, ownerUserId);
    assert.ok(status.roleCodes.includes('PLATFORM_ADMIN'));

    const owners = await pool!.query(
      `SELECT count(*)::int AS count
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
        WHERE r.code = 'PLATFORM_ADMIN' AND ura.status = 'ACTIVE'`,
    );
    assert.equal(owners.rows[0].count, 1);
  });
});
