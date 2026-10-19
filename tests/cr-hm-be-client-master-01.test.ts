import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { seedFoundationAccess } from '../src/database/seeds/foundation-access.seed';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clientService } from '../src/modules/clients';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { createOwnerUser } from './helpers/access';
import { api } from './helpers/http';

/**
 * CR-HM-BE-CLIENT-MASTER-01 — focused verification on disposable
 * PostgreSQL 18 (embedded, never Railway Production).
 *
 * Mandated matrix:
 *   1. Owner with zero Client scope creates the first Client;
 *   2. the created Client id is a Backend-issued UUID;
 *   3. the Owner can create a Property under that Client (and a Building);
 *   4. unauthorized Client creation is denied;
 *   5. cross-tenant Client access is denied;
 *   6. invalid and duplicate requests are handled;
 *   7. Client listing respects authorization (filters/pagination included);
 *   8. existing Property/Building functionality remains valid.
 *
 * The suite boots a throw-away PostgreSQL, applies the canonical migration
 * history (including 0454), and seeds the canonical access catalogue exactly
 * like production. It performs NO write against any non-embedded database.
 */

const V1 = '/api/v1';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The canonical SYSTEM_ADMIN persona (CR-HM-IAM-BOOTSTRAP-01). It administers
 * accounts and Building scopes but deliberately holds NO `client.*` code, so
 * it must never inherit Client-wide visibility.
 */
const SYSTEM_ADMIN_PERMISSIONS: readonly string[] = [
  'user.read',
  'user.manage',
  'role.read',
  'permission.read',
  'auth.audit.read',
  'building.read',
  'building.manage',
  'organization.read',
  'workforce.read',
];

let pg: EmbeddedPostgres;
let dir: string;
let pool: Pool;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-client-master-'));
  const port = 55500 + Math.floor(Math.random() * 300);
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password: 'password',
    persistent: false,
  });
  await pg.initialise();
  await pg.start();

  pool = await initDatabase({
    host: '127.0.0.1',
    port,
    name: 'postgres',
    user: 'postgres',
    password: 'password',
    ssl: false,
  });
  await migrateUp(pool);

  const client = await pool.connect();
  try {
    await seedFoundationAccess(client);
  } finally {
    client.release();
  }
}, { timeout: 180000 });

after(async () => {
  await closePool(getPool()).catch(() => undefined);
  if (pg) {
    await pg.stop();
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function ensurePermission(code: string): Promise<string> {
  const existing = await permissionRepository.findByCode(code);
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await permissionRepository.updateStatus(existing.id, 'ACTIVE');
    }
    return existing.id;
  }

  const created = await permissionService.createPermission({
    code,
    name: `Test ${code}`,
  });
  return created.id;
}

type Actor = { userId: string; email: string; token: string };

/** An authenticated user whose role carries exactly the given codes. */
async function createActor(permissionCodes: readonly string[]): Promise<Actor> {
  const tag = suffix();
  const email = `client-${tag.toLowerCase()}@example.com`;
  const password = `Pass${randomUUID().slice(0, 8)}!1`;

  const user = await userService.createUser({
    email,
    displayName: 'Client Master Actor',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });

  if (permissionCodes.length > 0) {
    const role = await roleService.createRole({
      code: `CLIENT_MASTER_${tag}`,
      name: 'Client Master test role',
    });
    for (const code of permissionCodes) {
      await permissionService.assignPermissionToRole(
        role.id,
        await ensurePermission(code),
      );
    }
    await roleService.assignRoleToUser(user.id, role.id);
  }

  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));

  return { userId: user.id, email, token: login.body.data.sessionToken };
}

async function createClientViaApi(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; code: string; name: string }> {
  const code = `CL_${suffix()}`;
  const response = await api()
    .post(`${V1}/clients`)
    .set(auth(token))
    .send({ code, name: `Client ${code}`, ...overrides });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

describe('CR-HM-BE-CLIENT-MASTER-01 — first-Client bootstrap', () => {
  it('1. Owner with zero Client scope creates the first Client', async () => {
    const owner = await createOwnerUser();

    // Production starting point: zero Clients, no Building assignment.
    const before = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clients',
    );
    assert.equal(before.rows[0].count, 0);

    const me = await api().get(`${V1}/auth/me`).set(auth(owner.token));
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data.scope.clientIds, []);
    assert.deepEqual(me.body.data.scope.buildingIds, []);
    assert.ok(me.body.data.access.permissions.includes('client.manage'));
    assert.ok(me.body.data.access.permissions.includes('client.read'));

    const created = await api()
      .post(`${V1}/clients`)
      .set(auth(owner.token))
      .send({
        code: '  first_client  ',
        name: '  First Client  ',
        legalName: 'PT First Client',
        taxId: 'ID-0001',
        description: 'First tenant boundary',
      });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.code, 'FIRST_CLIENT');
    assert.equal(created.body.data.name, 'First Client');
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.match(String(created.body.data.id), UUID_V4);

    // The registry is readable by the Owner even with zero Building scope.
    const list = await api().get(`${V1}/clients`).set(auth(owner.token));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.meta, {});
    assert.ok(
      list.body.data.some(
        (client: { id: string }) => client.id === created.body.data.id,
      ),
    );

    const detail = await api()
      .get(`${V1}/clients/${created.body.data.id}`)
      .set(auth(owner.token));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, created.body.data.id);

    // /auth/me scope stays Building-derived by contract: it is NOT widened by
    // creating a Client. The first Client id is authoritative in the 201 body.
    const meAfter = await api().get(`${V1}/auth/me`).set(auth(owner.token));
    assert.deepEqual(meAfter.body.data.scope.clientIds, []);

    // Security audit integration.
    const audit = await pool.query<{
      event_type: string;
      outcome: string;
      actor_user_id: string;
      metadata: { clientId: string; code: string; status: string };
    }>(
      `SELECT event_type, outcome, actor_user_id, metadata
         FROM authentication_audit_events
        WHERE event_type = 'CLIENT_CREATED'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].outcome, 'SUCCESS');
    assert.equal(audit.rows[0].actor_user_id, owner.userId);
    assert.equal(audit.rows[0].metadata.clientId, created.body.data.id);
    assert.equal(audit.rows[0].metadata.code, 'FIRST_CLIENT');
    assert.equal(audit.rows[0].metadata.status, 'ACTIVE');
  });

  it('2. the Client id is Backend-issued even when the body supplies one', async () => {
    const owner = await createOwnerUser();
    const supplied = randomUUID();

    const created = await api()
      .post(`${V1}/clients`)
      .set(auth(owner.token))
      .send({
        id: supplied,
        code: `SERVER_${suffix()}`,
        name: 'Server Generated Id',
      });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.notEqual(created.body.data.id, supplied);
    assert.match(String(created.body.data.id), UUID_V4);

    const stored = await pool.query<{ id: string }>(
      'SELECT id FROM clients WHERE id = $1',
      [created.body.data.id],
    );
    assert.equal(stored.rowCount, 1);
  });

  it('3. Owner can create Property and Building under the new Client', async () => {
    const owner = await createOwnerUser();
    const client = await createClientViaApi(owner.token, {
      name: 'Property Realm Client',
    });

    const property = await api()
      .post(`${V1}/properties`)
      .set(auth(owner.token))
      .send({
        clientId: client.id,
        code: `PROP_${suffix()}`,
        name: 'First Property',
        city: 'Jakarta',
      });
    assert.equal(property.status, 201, JSON.stringify(property.body));
    assert.equal(property.body.data.clientId, client.id);

    const building = await api()
      .post(`${V1}/buildings`)
      .set(auth(owner.token))
      .send({
        propertyId: property.body.data.id,
        code: `BLD_${suffix()}`,
        name: 'First Building',
        timezone: 'Asia/Jakarta',
      });
    assert.equal(building.status, 201, JSON.stringify(building.body));
    assert.equal(building.body.data.propertyId, property.body.data.id);

    // The Owner may administer the assignment, then operational scope exists.
    const assignment = await api()
      .post(`${V1}/users/${owner.userId}/buildings`)
      .set(auth(owner.token))
      .send({ buildingId: building.body.data.id });
    assert.equal(assignment.status, 201, JSON.stringify(assignment.body));

    const me = await api().get(`${V1}/auth/me`).set(auth(owner.token));
    assert.deepEqual(me.body.data.scope.clientIds, [client.id]);
    assert.deepEqual(me.body.data.scope.buildingIds, [building.body.data.id]);
    assert.equal(me.body.data.context.clients[0].id, client.id);
    assert.equal(
      me.body.data.context.clients[0].properties[0].id,
      property.body.data.id,
    );

    const myBuildings = await api()
      .get(`${V1}/auth/me/buildings`)
      .set(auth(owner.token));
    assert.equal(myBuildings.status, 200);
    assert.equal(myBuildings.body.data.length, 1);
    assert.equal(myBuildings.body.data[0].building.id, building.body.data.id);
  });

  it('4. unauthorized Client creation is denied', async () => {
    // No session.
    const anonymous = await api().post(`${V1}/clients`).send({
      code: `ANON_${suffix()}`,
      name: 'Anonymous',
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    // Authenticated but no role/permission.
    const plain = await createActor([]);
    const plainCreate = await api()
      .post(`${V1}/clients`)
      .set(auth(plain.token))
      .send({ code: `PLAIN_${suffix()}`, name: 'Plain' });
    assert.equal(plainCreate.status, 403);
    assert.equal(plainCreate.body.error.code, 'PERMISSION_DENIED');

    // Canonical SYSTEM_ADMIN: account/building administration only.
    const systemAdmin = await createActor(SYSTEM_ADMIN_PERMISSIONS);
    const sysCreate = await api()
      .post(`${V1}/clients`)
      .set(auth(systemAdmin.token))
      .send({ code: `SYS_${suffix()}`, name: 'System Admin' });
    assert.equal(sysCreate.status, 403);
    assert.equal(sysCreate.body.error.code, 'PERMISSION_DENIED');

    const sysList = await api().get(`${V1}/clients`).set(auth(systemAdmin.token));
    assert.equal(sysList.status, 403);
    assert.equal(sysList.body.error.code, 'PERMISSION_DENIED');

    // SYSTEM_ADMIN does hold building.manage; it still cannot read the Client
    // registry, so no Client-wide reach is inherited from any role label.
    const sysDetail = await api()
      .get(`${V1}/clients/${randomUUID()}`)
      .set(auth(systemAdmin.token));
    assert.equal(sysDetail.status, 403);
  });

  it('5. cross-tenant Client access is denied', async () => {
    const owner = await createOwnerUser();

    const clientA = await createClientViaApi(owner.token, { name: 'Tenant A' });
    const propertyA = await api()
      .post(`${V1}/properties`)
      .set(auth(owner.token))
      .send({ clientId: clientA.id, code: `PA_${suffix()}`, name: 'P A' });
    const buildingA = await api()
      .post(`${V1}/buildings`)
      .set(auth(owner.token))
      .send({
        propertyId: propertyA.body.data.id,
        code: `BA_${suffix()}`,
        name: 'B A',
      });

    const clientB = await createClientViaApi(owner.token, { name: 'Tenant B' });
    const propertyB = await api()
      .post(`${V1}/properties`)
      .set(auth(owner.token))
      .send({ clientId: clientB.id, code: `PB_${suffix()}`, name: 'P B' });
    await api()
      .post(`${V1}/buildings`)
      .set(auth(owner.token))
      .send({
        propertyId: propertyB.body.data.id,
        code: `BB_${suffix()}`,
        name: 'B B',
      });

    const operatorA = await createActor(['client.read', 'client.manage']);
    await buildingAssignmentService.createAssignment(operatorA.userId, {
      buildingId: buildingA.body.data.id,
    });

    const list = await api().get(`${V1}/clients`).set(auth(operatorA.token));
    assert.equal(list.status, 200);
    const ids = list.body.data.map((client: { id: string }) => client.id);
    assert.ok(ids.includes(clientA.id));
    assert.equal(ids.includes(clientB.id), false);

    const detailA = await api()
      .get(`${V1}/clients/${clientA.id}`)
      .set(auth(operatorA.token));
    assert.equal(detailA.status, 200);

    const detailB = await api()
      .get(`${V1}/clients/${clientB.id}`)
      .set(auth(operatorA.token));
    assert.equal(detailB.status, 403);
    assert.equal(detailB.body.error.code, 'CLIENT_ACCESS_DENIED');

    const patchB = await api()
      .patch(`${V1}/clients/${clientB.id}`)
      .set(auth(operatorA.token))
      .send({ name: 'Hijacked Tenant B' });
    assert.equal(patchB.status, 403);
    assert.equal(patchB.body.error.code, 'CLIENT_ACCESS_DENIED');

    const unchanged = await pool.query<{ name: string }>(
      'SELECT name FROM clients WHERE id = $1',
      [clientB.id],
    );
    assert.equal(unchanged.rows[0].name, 'Tenant B');

    const searchB = await api()
      .get(
        `${V1}/clients?search=${encodeURIComponent('Tenant B')}`,
      )
      .set(auth(operatorA.token));
    assert.equal(searchB.status, 200);
    assert.deepEqual(searchB.body.data, []);

    // The Owner remains installation-wide.
    const ownerList = await api().get(`${V1}/clients`).set(auth(owner.token));
    const ownerIds = ownerList.body.data.map(
      (client: { id: string }) => client.id,
    );
    assert.ok(ownerIds.includes(clientA.id));
    assert.ok(ownerIds.includes(clientB.id));
  });

  it('6. invalid and duplicate requests are handled as documented', async () => {
    const owner = await createOwnerUser();
    const code = `DUP_${suffix()}`;

    const first = await api()
      .post(`${V1}/clients`)
      .set(auth(owner.token))
      .send({ code, name: 'Duplicate Target' });
    assert.equal(first.status, 201);

    const duplicate = await api()
      .post(`${V1}/clients`)
      .set(auth(owner.token))
      .send({ code: code.toLowerCase(), name: 'Duplicate Target 2' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'CLIENT_CODE_ALREADY_EXISTS');

    // Concurrent create: the DB constraint (not the pre-check) is authoritative
    // and must surface as the documented 409, never a 500.
    const racing = `RACE_${suffix()}`;
    const results = await Promise.allSettled([
      clientService.createClient({ code: racing, name: 'Race A' }),
      clientService.createClient({ code: racing, name: 'Race B' }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const conflict = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string;
      statusCode?: number;
    };
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.code, 'CLIENT_CODE_ALREADY_EXISTS');
    const stored = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM clients WHERE code = $1',
      [racing],
    );
    assert.equal(stored.rows[0].count, 1);

    const invalidCode = await api()
      .post(`${V1}/clients`)
      .set(auth(owner.token))
      .send({ code: '1_BAD', name: 'Bad Code' });
    assert.equal(invalidCode.status, 400);
    assert.equal(invalidCode.body.error.code, 'VALIDATION_ERROR');

    const missingName = await api()
      .post(`${V1}/clients`)
      .set(auth(owner.token))
      .send({ code: `NO_NAME_${suffix()}` });
    assert.equal(missingName.status, 400);
    assert.equal(missingName.body.error.code, 'VALIDATION_ERROR');

    const badStatus = await api()
      .post(`${V1}/clients`)
      .set(auth(owner.token))
      .send({ code: `BAD_STATUS_${suffix()}`, name: 'Bad Status', status: 'FROZEN' });
    assert.equal(badStatus.status, 400);

    const malformedId = await api()
      .get(`${V1}/clients/not-a-uuid`)
      .set(auth(owner.token));
    assert.equal(malformedId.status, 400);
    assert.equal(malformedId.body.error.code, 'VALIDATION_ERROR');

    const unknown = await api()
      .get(`${V1}/clients/${randomUUID()}`)
      .set(auth(owner.token));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'CLIENT_NOT_FOUND');

    const badQueryStatus = await api()
      .get(`${V1}/clients?status=FROZEN`)
      .set(auth(owner.token));
    assert.equal(badQueryStatus.status, 400);
    assert.equal(badQueryStatus.body.error.code, 'VALIDATION_ERROR');

    const badPage = await api()
      .get(`${V1}/clients?page=0`)
      .set(auth(owner.token));
    assert.equal(badPage.status, 400);
    assert.equal(badPage.body.error.code, 'VALIDATION_ERROR');

    const longSearch = await api()
      .get(`${V1}/clients?search=${'a'.repeat(121)}`)
      .set(auth(owner.token));
    assert.equal(longSearch.status, 400);
  });

  it('7. Client listing respects authorization, filters and pagination', async () => {
    const owner = await createOwnerUser();

    const unique = suffix();
    const alpha = await createClientViaApi(owner.token, {
      code: `ALPHA_${unique}`,
      name: `Alpha ${unique}`,
    });
    const beta = await createClientViaApi(owner.token, {
      code: `BETA_${unique}`,
      name: `Beta ${unique}`,
    });
    await createClientViaApi(owner.token, {
      code: `INACTIVE_${unique}`,
      name: `Inactive ${unique}`,
      status: 'INACTIVE',
    });

    // Exact filter.
    const byStatus = await api()
      .get(`${V1}/clients?status=ACTIVE&search=${unique}`)
      .set(auth(owner.token));
    assert.equal(byStatus.status, 200);
    assert.equal(byStatus.body.data.length, 2);
    assert.deepEqual(
      byStatus.body.data.map((client: { code: string }) => client.code).sort(),
      [alpha.code, beta.code].sort(),
    );

    const inactive = await api()
      .get(`${V1}/clients?status=INACTIVE&search=${unique}`)
      .set(auth(owner.token));
    assert.equal(inactive.body.data.length, 1);
    assert.equal(inactive.body.data[0].status, 'INACTIVE');

    // `search` is a LITERAL substring, not a LIKE pattern.
    const wildcard = await api()
      .get(`${V1}/clients?search=${encodeURIComponent('%')}`)
      .set(auth(owner.token));
    assert.equal(wildcard.status, 200);
    assert.deepEqual(wildcard.body.data, []);

    // Opt-in pagination with page/pageSize meta.
    const firstPage = await api()
      .get(`${V1}/clients?search=${unique}&page=1&pageSize=1`)
      .set(auth(owner.token));
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.data.length, 1);
    assert.equal(firstPage.body.meta.page, 1);
    assert.equal(firstPage.body.meta.pageSize, 1);
    assert.equal(firstPage.body.meta.total, 3);
    assert.equal(firstPage.body.meta.totalPages, 3);

    const secondPage = await api()
      .get(`${V1}/clients?search=${unique}&page=2&pageSize=1`)
      .set(auth(owner.token));
    assert.equal(secondPage.body.data.length, 1);
    assert.notEqual(
      secondPage.body.data[0].id,
      firstPage.body.data[0].id,
    );
    assert.equal(secondPage.body.meta.total, 3);

    const beyond = await api()
      .get(`${V1}/clients?search=${unique}&page=99&pageSize=10`)
      .set(auth(owner.token));
    assert.deepEqual(beyond.body.data, []);
    assert.equal(beyond.body.meta.total, 3);

    // Unpaginated requests keep the historical array + empty meta contract.
    const unpaginated = await api()
      .get(`${V1}/clients?search=${unique}`)
      .set(auth(owner.token));
    assert.deepEqual(unpaginated.body.meta, {});
    assert.equal(unpaginated.body.data.length, 3);
  });

  it('8a. a non-owner creator gains no automatic Client reach', async () => {
    // Explicit `client.manage` grant, no Building assignment.
    const creator = await createActor(['client.manage', 'client.read']);

    const created = await api()
      .post(`${V1}/clients`)
      .set(auth(creator.token))
      .send({ code: `NOREACH_${suffix()}`, name: 'No Reach Client' });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // Creation is a canonical RBAC act; visibility is data-scoped. A grant
    // must be paired with an explicit governed Building assignment before the
    // Client becomes reachable — never an implicit Client-wide bypass.
    const list = await api().get(`${V1}/clients`).set(auth(creator.token));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data, []);

    const detail = await api()
      .get(`${V1}/clients/${created.body.data.id}`)
      .set(auth(creator.token));
    assert.equal(detail.status, 403);
    assert.equal(detail.body.error.code, 'CLIENT_ACCESS_DENIED');
  });

  it('8b. platform-plane Client statuses are not exposed by the business registry', async () => {
    const owner = await createOwnerUser();

    // The `clients` table is shared with the SaaS customer registry
    // (migration 0360), whose PROSPECT/TRIAL/... states are platform-plane
    // lifecycle states — never business Client statuses.
    const prospectId = randomUUID();
    const code = `PROSPECT_${suffix()}`;
    await pool.query(
      `INSERT INTO clients (id, code, name, status)
       VALUES ($1, $2, $3, 'PROSPECT')`,
      [prospectId, code, 'Prospect Customer'],
    );

    const list = await api()
      .get(`${V1}/clients?search=${code}`)
      .set(auth(owner.token));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data, []);

    const detail = await api()
      .get(`${V1}/clients/${prospectId}`)
      .set(auth(owner.token));
    assert.equal(detail.status, 404);
    assert.equal(detail.body.error.code, 'CLIENT_NOT_FOUND');

    const patch = await api()
      .patch(`${V1}/clients/${prospectId}`)
      .set(auth(owner.token))
      .send({ name: 'Not A Business Client' });
    assert.equal(patch.status, 404);
  });

  it('8c. existing Property and Building functionality remains valid', async () => {
    const owner = await createOwnerUser();
    const client = await createClientViaApi(owner.token);

    const property = await api()
      .post(`${V1}/properties`)
      .set(auth(owner.token))
      .send({
        clientId: client.id,
        code: `VALID_P_${suffix()}`,
        name: 'Valid Property',
      });
    assert.equal(property.status, 201);

    const propertyList = await api()
      .get(`${V1}/properties?clientId=${client.id}`)
      .set(auth(owner.token));
    assert.equal(propertyList.status, 200);
    assert.equal(propertyList.body.data.length, 1);
    assert.equal(propertyList.body.data[0].id, property.body.data.id);

    const propertyClientList = await api()
      .get(`${V1}/clients/${client.id}/properties`)
      .set(auth(owner.token));
    assert.equal(propertyClientList.status, 200);
    assert.equal(propertyClientList.body.data[0].id, property.body.data.id);

    const building = await api()
      .post(`${V1}/buildings`)
      .set(auth(owner.token))
      .send({
        propertyId: property.body.data.id,
        code: `VALID_B_${suffix()}`,
        name: 'Valid Building',
      });
    assert.equal(building.status, 201);

    // Building isolation is unchanged: no assignment -> denied.
    const outsider = await createActor(['building.read']);
    const denied = await api()
      .get(`${V1}/buildings/${building.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: building.body.data.id,
    });
    const allowed = await api()
      .get(`${V1}/buildings/${building.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data.id, building.body.data.id);

    // Property status lifecycle remains unaffected.
    const status = await api()
      .patch(`${V1}/properties/${property.body.data.id}/status`)
      .set(auth(owner.token))
      .send({ status: 'INACTIVE' });
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status, 'INACTIVE');

    // A new Building under an INACTIVE Property is still rejected.
    const rejected = await api()
      .post(`${V1}/buildings`)
      .set(auth(owner.token))
      .send({
        propertyId: property.body.data.id,
        code: `VALID_B2_${suffix()}`,
        name: 'Rejected Building',
      });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'PROPERTY_INACTIVE');
  });
});
