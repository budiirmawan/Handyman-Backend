import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { credentialService } from '../src/modules/auth';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { suspendUser, userService } from '../src/modules/users';
import {
  HANDYMAN_CARE_BUILDING_PERMISSION,
  GENERIC_TENANT_COMPANY_MANAGE_PERMISSION,
} from '../src/modules/handyman-care-authority';
import { api } from './helpers/http';

/**
 * CR-HM-BM-CARE-AUTH-01 — focused tests for the Building Customer Care
 * authority resolver (Authority A), on disposable embedded PostgreSQL.
 *
 * Business baseline: TENANT/PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN.
 *
 * Mandated matrix:
 *   1.  valid Building Care actor;
 *   2.  missing Care permission;
 *   3.  wrong Building (same Client, no assignment);
 *   4.  wrong Client/Company (asserted clientId mismatch);
 *   5.  inactive / revoked Building assignment;
 *   6.  generic `tenant_company.manage` without Care authority;
 *   7.  unauthenticated actor;
 *   8.  spoofed recording identity (SD-19);
 *   9.  cross-tenant access;
 *   10. no unintended quotation / variation / BAST mutations;
 *   plus: no Care impersonation of Tenant/PIC, permission registration and
 *   default-unassigned governance, and the still-disabled Authority B
 *   transport.
 *
 * Authority A establishes WHO the Care actor is and WHICH Building they may
 * reach. These tests deliberately assert nothing about Tenant approval of a
 * Quotation, Variation or BAST — that is Authority B and it remains blocked.
 */

const V1 = '/api/v1';
const AUTHORITY = (buildingId: string) =>
  `${V1}/handyman/care/buildings/${buildingId}/authority`;

let pg: EmbeddedPostgres;
let dir: string;
let pool: Pool;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-care-auth-'));
  const port = 55000 + Math.floor(Math.random() * 1000);
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
    poolMin: 1,
    poolMax: 16,
  });
  await migrateUp(pool);
});

after(async () => {
  await closePool(getPool()).catch(() => undefined);
  if (pg) await pg.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const uid = () => randomUUID();

type Realm = Awaited<ReturnType<typeof realm>>;

async function realm(label = 'Realm') {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: `${label} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  return { client, property, building };
}

/** A second Building under the SAME Client — never assigned to the actor. */
async function siblingBuilding(r: Realm) {
  return buildingService.createBuilding({
    propertyId: r.property.id,
    code: `B_${suffix()}`,
    name: 'Sibling Building',
  });
}

async function ensurePermission(code: string) {
  const existing = await permissionRepository.findByCode(code);
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      await permissionRepository.updateStatus(existing.id, 'ACTIVE');
    }
    return existing;
  }
  return permissionService.createPermission({
    code,
    name: `Test ${code}`,
  });
}

type Actor = { userId: string; email: string; token: string };

/**
 * Creates an authenticated Backend user whose role carries exactly the given
 * permission codes (empty = no role at all, hence no permissions).
 */
async function createActor(permissionCodes: readonly string[]): Promise<Actor> {
  const tag = suffix();
  const email = `care-${tag.toLowerCase()}@example.com`;
  const password = `Pass${randomUUID().slice(0, 8)}!1`;

  const user = await userService.createUser({
    email,
    displayName: 'Care Actor',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });

  if (permissionCodes.length > 0) {
    const role = await roleService.createRole({
      code: `CARE_${tag}`,
      name: 'Scoped Care test role',
    });
    for (const code of permissionCodes) {
      const permission = await ensurePermission(code);
      await permissionService.assignPermissionToRole(role.id, permission.id);
    }
    await roleService.assignRoleToUser(user.id, role.id);
  }

  const login = await api()
    .post(`${V1}/auth/login`)
    .send({ email, password });
  assert.equal(
    login.status,
    200,
    `login failed for ${email}: ${JSON.stringify(login.body)}`,
  );

  return { userId: user.id, email, token: login.body.data.sessionToken };
}

/** The happy-path Care actor: dedicated permission + ACTIVE assignment. */
async function careActorFor(r: Realm, buildingId = r.building.id) {
  const actor = await createActor([HANDYMAN_CARE_BUILDING_PERMISSION]);
  await buildingAssignmentService.createAssignment(actor.userId, {
    buildingId,
  });
  return actor;
}

const COMMERCIAL_TABLES = [
  'handyman_quotations',
  'handyman_scope_variations',
  'handyman_bast_documents',
] as const;

async function commercialSnapshot(r: Realm) {
  const counts: Record<string, number> = {};
  for (const table of COMMERCIAL_TABLES) {
    const result = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ${table}`,
    );
    counts[table] = Number(result.rows[0]?.n ?? '0');
  }
  return counts;
}

describe('CR-HM-BM-CARE-AUTH-01 — Building Customer Care authority (Authority A)', () => {
  it('1. resolves Authority A for a valid Building Care actor', async () => {
    const r = await realm('Care');
    const actor = await careActorFor(r);

    const res = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;

    // Identity — session-derived only.
    assert.equal(data.role, 'BUILDING_CUSTOMER_CARE');
    assert.equal(data.actor.userId, actor.userId);
    assert.equal(data.identitySource, 'BACKEND_SESSION');
    assert.equal(data.grantedByPermission, HANDYMAN_CARE_BUILDING_PERMISSION);

    // Exact Building + server-derived Client scope.
    assert.equal(data.scope.buildingId, r.building.id);
    assert.equal(data.scope.clientId, r.client.id);
    assert.equal(data.scope.propertyId, r.property.id);
    assert.ok(data.scope.assignmentId, 'assignment id is server-derived');

    // Authority A granted; every Authority B capability is explicitly false.
    assert.equal(data.capabilities.mayMediateBuildingCare, true);
    assert.equal(data.capabilities.mayRecordCareDecision, false);
    assert.equal(data.capabilities.mayApproveQuotation, false);
    assert.equal(data.capabilities.mayApproveVariation, false);
    assert.equal(data.capabilities.mayAcceptBast, false);
    assert.equal(data.capabilities.mayActAsTenantPic, false);

    // The BM Care boundary is not connected — stated, not assumed.
    assert.equal(data.bmCareActorBinding, null);
    assert.equal(data.decisionAuthority.status, 'BLOCKED');
  });

  it('2. denies an actor without the dedicated Care permission', async () => {
    const r = await realm('NoPerm');
    const actor = await createActor([]);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: r.building.id,
    });

    const res = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('3. denies a Building the actor is not assigned to (same Client)', async () => {
    const r = await realm('Sibling');
    const sibling = await siblingBuilding(r);
    const actor = await careActorFor(r);

    const res = await api()
      .get(AUTHORITY(sibling.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');
  });

  it('4. denies a wrong asserted Client/Company', async () => {
    const r = await realm('WrongClient');
    const other = await realm('OtherClient');
    const actor = await careActorFor(r);

    const res = await api()
      .get(`${AUTHORITY(r.building.id)}?clientId=${other.client.id}`)
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');
  });

  it('4b. accepts the correctly asserted Client/Company', async () => {
    const r = await realm('RightClient');
    const actor = await careActorFor(r);

    const res = await api()
      .get(`${AUTHORITY(r.building.id)}?clientId=${r.client.id}`)
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.scope.clientId, r.client.id);
  });

  it('5. denies an INACTIVE (revoked) Building assignment', async () => {
    const r = await realm('Revoked');
    const actor = await careActorFor(r);

    const before = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(before.status, 200);

    await buildingAssignmentService.deactivateAssignment(
      actor.userId,
      r.building.id,
    );

    const after = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(after.status, 403, JSON.stringify(after.body));
    assert.equal(after.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');
  });

  it('6. refuses generic tenant_company.manage as a Care substitute', async () => {
    const r = await realm('Generic');
    const actor = await createActor([GENERIC_TENANT_COMPANY_MANAGE_PERMISSION]);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: r.building.id,
    });

    const res = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  });

  it('6b. refuses every non-Care capability as a substitute', async () => {
    const r = await realm('Substitutes');
    const substitutes = [
      GENERIC_TENANT_COMPANY_MANAGE_PERMISSION,
      'building.read',
      'building.manage',
      'handyman.bast.manage',
      'handyman.finance.manage',
    ];
    const actor = await createActor(substitutes);
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: r.building.id,
    });

    const res = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('7. denies an unauthenticated actor', async () => {
    const r = await realm('Anon');

    const noHeader = await api().get(AUTHORITY(r.building.id));
    assert.equal(noHeader.status, 401, JSON.stringify(noHeader.body));
    assert.equal(noHeader.body.error.code, 'AUTHENTICATION_REQUIRED');

    const badToken = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${uid()}`);
    assert.equal(badToken.status, 401, JSON.stringify(badToken.body));
  });

  it('7b. denies an authenticated but non-ACTIVE (SUSPENDED) account', async () => {
    const r = await realm('Suspended');
    const actor = await careActorFor(r);

    await suspendUser(actor.userId);

    const res = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 401, JSON.stringify(res.body));
  });

  it('8. rejects a spoofed recording identity (SD-19)', async () => {
    const r = await realm('Spoof');
    const actor = await careActorFor(r);

    for (const field of [
      'recordedByUserId',
      'actorUserId',
      'tenantPicId',
      'careActorId',
    ]) {
      const res = await api()
        .get(`${AUTHORITY(r.building.id)}?${field}=${uid()}`)
        .set('Authorization', `Bearer ${actor.token}`);
      assert.equal(
        res.status,
        400,
        `${field} should be rejected: ${JSON.stringify(res.body)}`,
      );
      assert.equal(
        res.body.error.code,
        'HANDYMAN_CARE_IDENTITY_NOT_ACCEPTED',
        `unexpected code for ${field}`,
      );
    }

    // A body-supplied identity is rejected too.
    const viaBody = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ recordedByUserId: uid() });
    assert.equal(viaBody.status, 400, JSON.stringify(viaBody.body));
    assert.equal(viaBody.body.error.code, 'HANDYMAN_CARE_IDENTITY_NOT_ACCEPTED');
  });

  it('9. denies cross-tenant (other Client) Building access', async () => {
    const mine = await realm('Mine');
    const theirs = await realm('Theirs');
    const actor = await careActorFor(mine);

    const res = await api()
      .get(AUTHORITY(theirs.building.id))
      .set('Authorization', `Bearer ${actor.token}`);

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'HANDYMAN_CARE_AUTHORITY_DENIED');

    // The client advertised in the error-free path is never the other tenant.
    const ok = await api()
      .get(AUTHORITY(mine.building.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.scope.clientId, mine.client.id);
    assert.notEqual(ok.body.data.scope.clientId, theirs.client.id);
  });

  it('10. performs no quotation / variation / BAST mutation', async () => {
    const r = await realm('NoMutation');
    const actor = await careActorFor(r);
    const before = await commercialSnapshot(r);

    const ok = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(ok.status, 200);

    // Every denial path is also mutation-free.
    const sibling = await siblingBuilding(r);
    await api()
      .get(AUTHORITY(sibling.id))
      .set('Authorization', `Bearer ${actor.token}`);
    await api()
      .get(`${AUTHORITY(r.building.id)}?recordedByUserId=${uid()}`)
      .set('Authorization', `Bearer ${actor.token}`);

    const after = await commercialSnapshot(r);
    assert.deepEqual(after, before, 'commercial tables must be untouched');

    // The transport registers no mutating method for the authority surface.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (api() as never as Record<
        string,
        (url: string) => { set: (k: string, v: string) => Promise<{ status: number }> }
      >)[method](AUTHORITY(r.building.id)).set(
        'Authorization',
        `Bearer ${actor.token}`,
      );
      assert.equal(res.status, 404, `${method} must not be registered`);
    }
  });

  it('11. never returns a Tenant/PIC identity (no Care impersonation)', async () => {
    const r = await realm('NoImpersonation');
    const actor = await careActorFor(r);

    const res = await api()
      .get(AUTHORITY(r.building.id))
      .set('Authorization', `Bearer ${actor.token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const serialized = JSON.stringify(res.body.data);
    for (const forbidden of [
      'tenantPicId',
      'tenantPic',
      'tenantId',
      'recordedByUserId',
    ]) {
      assert.ok(
        !serialized.includes(forbidden),
        `response must not carry ${forbidden}`,
      );
    }
    assert.equal(res.body.data.capabilities.mayActAsTenantPic, false);
  });

  it('12. registers the dedicated permission, unassigned by default', async () => {
    const permission = await permissionRepository.findByCode(
      HANDYMAN_CARE_BUILDING_PERMISSION,
    );
    assert.ok(
      permission,
      `${HANDYMAN_CARE_BUILDING_PERMISSION} must be registered by migration 0450`,
    );
    assert.equal(permission.status, 'ACTIVE');
    assert.ok(
      UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(
        HANDYMAN_CARE_BUILDING_PERMISSION,
      ),
      'the Care capability must be granted to NO role by default',
    );

    // Migration 0449 (Care Decisions schema) is deliberately NOT applied.
    const applied = await pool.query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id LIKE '0449%'`,
    );
    assert.equal(applied.rows.length, 0, '0449 must remain unclaimed');
  });

  it('13. keeps the Care Decisions transport (Authority B) disabled', async () => {
    const r = await realm('Decisions');
    const actor = await careActorFor(r);

    const post = await api()
      .post(`${V1}/handyman/care-decisions`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({
        buildingId: r.building.id,
        decision: 'CONFIRM',
        targetType: 'QUOTATION',
        targetId: uid(),
      });

    assert.equal(post.status, 404, JSON.stringify(post.body));

    const table = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name = 'handyman_care_decisions') AS exists`,
    );
    assert.equal(
      table.rows[0]?.exists,
      false,
      'the Care Decisions table must not exist',
    );
  });
});
