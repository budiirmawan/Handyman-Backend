import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import {
  after,
  before,
  describe,
  it,
  type TestContext,
} from 'node:test';
import request from 'supertest';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import {
  closePool,
  initDatabase,
  migrateUp,
  getPool,
} from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import { roleRepository } from '../src/modules/roles/role.repository';
import { permissionService } from '../src/modules/permissions';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { buildingService } from '../src/modules/buildings';
import { propertyService } from '../src/modules/properties';
import { createApp } from '../src/app';
import { ensureTestDatabase } from './helpers/postgres';
import { assertSupportContextEffectiveness } from '../src/modules/platform-support';

/**
 * CR-BE-SAAS-01 PART 11B — Support session HTTP tests (frozen §22).
 *
 * Coverage (exactly 15 proofs):
 *   1. POST success with explicit platform.support.access
 *   2. actorUserId from body CANNOT override the authenticated actor
 *   3. reason / duration validation surfaces correctly
 *   4. D2 invariant — PLATFORM_ADMIN without explicit support permission → 403
 *   5. unauthenticated → 401
 *   6. GET list with derived effective/expired/ended states
 *   7. listing an expired session does NOT mutate or audit it
 *   8. DELETE revokes
 *   9. second DELETE follows row-level idempotent revoke (no extra audit)
 *  10. support actor B cannot use actor A's session
 *  11. expired session denied by runtime guard (SAAS_SUPPORT_SESSION_EXPIRED)
 *  12. cross-customer denied
 *  13. cross-building denied
 *  14. customer-wide + same-customer building ALLOWED
 *  15. customer-wide + foreign-customer building DENIED
 *
 * Real embedded PostgreSQL, unique port/tmp dir.
 */
const PORT = 55465;
const DIR = '/tmp/asentra-saas11b-http-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;

function ready(c: TestContext): boolean {
  if (!pool) {
    c.skip('PART 11B test database unavailable');
    return false;
  }
  return true;
}

const app = () => request(createApp());

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seedCustomer(): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO clients (id, code, name, billing_email, status, version,
                          created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 1, NOW(), NOW())`,
    [id, `CUS11B_${randomUUID().slice(0, 6)}`, `Customer ${id.slice(0, 6)}`,
      `${id.slice(0, 6)}@example.com`],
  );
  return id;
}

async function seedPropertyAndBuilding(
  customerId: string,
): Promise<{ propertyId: string; buildingId: string }> {
  assert.ok(pool);
  const property = await propertyService.createProperty({
    clientId: customerId,
    code: `PROP_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Support Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Support Building',
  });
  return { propertyId: property.id, buildingId: building.id };
}

async function createSupportActor(): Promise<{
  token: string;
  userId: string;
}> {
  assert.ok(pool);
  const perm = await permissionRepository.findByCode('platform.support.access');
  if (!perm || perm.status !== 'ACTIVE') {
    throw new Error('platform.support.access must exist from foundation seed');
  }
  const s = randomUUID().slice(0, 8).toLowerCase();
  const password = 'SupportActor123';
  const user = await userService.createUser({
    email: `support-actor-${s}@example.test`,
    displayName: 'Support Actor',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleService.createRole({
    code: `SUPPORT_ROLE_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Support Role',
  });
  await permissionService.assignPermissionToRole(role.id, perm.id);
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await app()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function createSupportActorB(): Promise<{
  token: string;
  userId: string;
}> {
  assert.ok(pool);
  return createSupportActor(); // distinct user, same perms
}

async function createPlatformAdminWithoutSupportPermission(): Promise<{
  token: string;
  userId: string;
}> {
  assert.ok(pool);
  const platformAdmin = await roleRepository.findByCode('PLATFORM_ADMIN');
  assert.ok(platformAdmin, 'PLATFORM_ADMIN seeded by foundation seed');
  const s = randomUUID().slice(0, 8).toLowerCase();
  const password = 'PlatformAdmin123';
  const user = await userService.createUser({
    email: `platform-admin-${s}@example.test`,
    displayName: 'Platform Admin',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  await roleService.assignRoleToUser(user.id, platformAdmin.id);
  const login = await app()
    .post('/api/v1/auth/login')
    .send({ email: user.email, password });
  assert.equal(login.status, 200);
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: 'postgres',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }
  const config = await ensureTestDatabase();
  if (!config) return;
  pool = await initDatabase(config as DatabaseConfig);
  await migrateUp(pool);
  await foundationAccessSeed.run(pool as Pool);
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    if (postgres) {
      await rm(DIR, { recursive: true, force: true });
    }
  }
  pool = null;
  postgres = null;
});

describe('CR-BE-SAAS-01 PART 11B — Support Access HTTP (frozen §22)', () => {
  it('1. POST opens a session with explicit platform.support.access', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const actor = await createSupportActor();
    const res = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({
        customerId,
        reason: 'customer-reported incident',
        durationMinutes: 30,
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.customerId, customerId);
    assert.equal(res.body.data.effective, 'EFFECTIVE');
    assert.equal(res.body.data.status, 'ACTIVE');
    assert.equal(res.body.data.supportActorUserId, actor.userId);
  });

  it('2. actorUserId from body cannot override the authenticated actor', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const actor = await createSupportActor();
    const imposter = randomUUID();
    const res = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({
        customerId,
        actorUserId: imposter,
        supportActorUserId: imposter,
        reason: 'attempt override',
        durationMinutes: 30,
      });
    assert.equal(res.status, 400, 'forbidden body fields must surface validation');
    const created = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({
        customerId,
        reason: 'no-override',
        durationMinutes: 30,
      });
    assert.equal(created.status, 201);
    assert.equal(
      created.body.data.supportActorUserId,
      actor.userId,
      'authenticated actor must be used; never the body',
    );
  });

  it('3. validation errors surface as 400 (missing reason / bad duration / bad uuid)', async (c) => {
    if (!ready(c)) return;
    const actor = await createSupportActor();
    const res = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({
        customerId: 'not-a-uuid',
        reason: '',
        durationMinutes: -5,
      });
    assert.equal(res.status, 400);
    const fields = (res.body.error?.details ?? []).map(
      (e: { field: string }) => e.field,
    );
    assert.ok(fields.includes('customerId'));
    assert.ok(fields.includes('reason'));
    assert.ok(fields.includes('durationMinutes'));
  });

  it('4. PLATFORM_ADMIN without explicit support permission → 403 (D2)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const admin = await createPlatformAdminWithoutSupportPermission();
    const res = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(admin.token))
      .send({
        customerId,
        reason: 'should be denied',
        durationMinutes: 30,
      });
    assert.equal(res.status, 403);
  });

  it('5. unauthenticated → 401', async (c) => {
    if (!ready(c)) return;
    const res = await app()
      .post('/api/v1/platform/support-sessions')
      .send({
        customerId: randomUUID(),
        reason: 'no token',
        durationMinutes: 30,
      });
    assert.equal(res.status, 401);
  });

  it('6. GET lists sessions with derived effective/expired/ended states', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const actor = await createSupportActor();
    // Open session A (will be revoked).
    const a = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId, reason: 'a', durationMinutes: 30 });
    assert.equal(a.status, 201);
    // Revoke A so the same (actor, customer) slot is free for B.
    const revA = await app()
      .delete(`/api/v1/platform/support-sessions/${a.body.data.id}`)
      .set(auth(actor.token));
    assert.equal(revA.status, 200);
    // Open session B (will be expired-by-DB-update).
    const b = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId, reason: 'b', durationMinutes: 30 });
    assert.equal(b.status, 201);
    // Revoke B is left for the list to see its REVOKED state via B's
    // own DB-side expiry (derived), not via revoke.
    const rev = await app()
      .delete(`/api/v1/platform/support-sessions/${a.body.data.id}`)
      .set(auth(actor.token));
    assert.equal(rev.status, 200);
    // Manually expire B (push expires_at into the past).
    assert.ok(pool);
    await pool.query(
      `UPDATE platform_support_sessions
         SET expires_at = NOW() - INTERVAL '1 minute',
             started_at = NOW() - INTERVAL '31 minutes'
       WHERE id = $1`,
      [b.body.data.id],
    );
    // List (canonical envelope: `data` is the projected array directly).
    const list = await app()
      .get('/api/v1/platform/support-sessions')
      .query({ customerId })
      .set(auth(actor.token));
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.data), 'list body.data must be an array (no double envelope)');
    const data = list.body.data as Array<{
      id: string;
      effective: string;
      status: string;
    }>;
    const foundA = data.find((x) => x.id === a.body.data.id);
    const foundB = data.find((x) => x.id === b.body.data.id);
    assert.ok(foundA && foundB);
    assert.equal(foundA.effective, 'REVOKED');
    assert.equal(foundA.status, 'ENDED');
    assert.equal(foundB.effective, 'EXPIRED');
    assert.equal(foundB.status, 'ACTIVE', 'expired is derived, not persisted');
  });

  it('7. GET listing does NOT mutate or audit the expired row', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const actor = await createSupportActor();
    const s = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId, reason: 'audit-stability', durationMinutes: 30 });
    assert.equal(s.status, 201);
    assert.ok(pool);
    await pool.query(
      `UPDATE platform_support_sessions
         SET expires_at = NOW() - INTERVAL '1 minute',
             started_at = NOW() - INTERVAL '31 minutes'
       WHERE id = $1`,
      [s.body.data.id],
    );
    const auditBefore = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operational_events
        WHERE entity_type = 'SAAS_SUPPORT_SESSION'
          AND entity_id = $1`,
      [s.body.data.id],
    );
    // Two listings in succession.
    const list1 = await app()
      .get('/api/v1/platform/support-sessions')
      .query({ customerId })
      .set(auth(actor.token));
    assert.equal(list1.status, 200);
    assert.ok(Array.isArray(list1.body.data), 'list body.data is an array');
    const list2 = await app()
      .get('/api/v1/platform/support-sessions')
      .query({ customerId })
      .set(auth(actor.token));
    assert.equal(list2.status, 200);
    assert.ok(Array.isArray(list2.body.data), 'list body.data is an array');
    const auditAfter = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operational_events
        WHERE entity_type = 'SAAS_SUPPORT_SESSION'
          AND entity_id = $1`,
      [s.body.data.id],
    );
    assert.equal(
      auditBefore.rows[0].n,
      auditAfter.rows[0].n,
      'listing must not emit audit events',
    );
  });

  it('8. DELETE revokes an ACTIVE session (200 + ENDED audit)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const actor = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId, reason: 'to revoke', durationMinutes: 30 });
    assert.equal(opened.status, 201);
    const del = await app()
      .delete(`/api/v1/platform/support-sessions/${opened.body.data.id}`)
      .set(auth(actor.token));
    assert.equal(del.status, 200);
    assert.equal(del.body.data.revoked, true);
    assert.ok(pool);
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM operational_events
        WHERE entity_type = 'SAAS_SUPPORT_SESSION'
          AND entity_id = $1
        ORDER BY occurred_at ASC`,
      [opened.body.data.id],
    );
    assert.equal(events.rows.length, 2);
    assert.equal(events.rows[0].event_type, 'SAAS_SUPPORT_ACCESS_STARTED');
    assert.equal(events.rows[1].event_type, 'SAAS_SUPPORT_ACCESS_ENDED');
  });

  it('9. second DELETE follows row-level idempotent revoke (no extra audit)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const actor = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId, reason: 'twice', durationMinutes: 30 });
    assert.equal(opened.status, 201);
    const first = await app()
      .delete(`/api/v1/platform/support-sessions/${opened.body.data.id}`)
      .set(auth(actor.token));
    assert.equal(first.body.data.revoked, true);
    const second = await app()
      .delete(`/api/v1/platform/support-sessions/${opened.body.data.id}`)
      .set(auth(actor.token));
    assert.equal(second.body.data.revoked, false);
    assert.equal(second.body.data.session.effective, 'REVOKED');
    assert.ok(pool);
    const endEvents = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM operational_events
        WHERE entity_type = 'SAAS_SUPPORT_SESSION'
          AND entity_id = $1
          AND event_type = 'SAAS_SUPPORT_ACCESS_ENDED'`,
      [opened.body.data.id],
    );
    assert.equal(endEvents.rows[0].n, '1', 'END audit must occur once only');
  });

  it('10. support actor B cannot use actor A session (runtime guard isolates actor)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const a = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(a.token))
      .send({ customerId, reason: 'a only', durationMinutes: 30 });
    assert.equal(opened.status, 201);
    const sessionId = opened.body.data.id as string;
    // Authenticate a separate support actor B (also with
    // platform.support.access). B holds the permission and may open
    // their own sessions; B may NOT use A's session.
    const b = await createSupportActorB();
    // Sanity: B can list their own (empty) sessions.
    const bList = await app()
      .get('/api/v1/platform/support-sessions')
      .set(auth(b.token));
    assert.equal(bList.status, 200);
    assert.ok(Array.isArray(bList.body.data), 'list body.data must be array');
    assert.equal(
      (bList.body.data as unknown[]).length,
      0,
      'B has no sessions yet',
    );
    // B cannot even SEE A's session via list.
    const bListAll = await app()
      .get('/api/v1/platform/support-sessions')
      .set(auth(b.token));
    assert.ok(Array.isArray(bListAll.body.data), 'list body.data must be array');
    const data = bListAll.body.data as Array<{ id: string }>;
    assert.ok(!data.find((x) => x.id === sessionId));
    // Directly calling assertSupportContextEffectiveness as B must deny.
    await assert.rejects(
      () =>
        assertSupportContextEffectiveness({
          actorUserId: b.userId,
          sessionId,
          customerId,
        }),
      (err: { statusCode?: number; code?: string }) =>
        err?.code === 'SAAS_SUPPORT_SESSION_NOT_FOUND' &&
        err?.statusCode === 404,
    );
  });

  it('11. expired session → runtime guard denies (SAAS_SUPPORT_SESSION_EXPIRED)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const actor = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId, reason: 'will expire', durationMinutes: 30 });
    assert.equal(opened.status, 201);
    assert.ok(pool);
    await pool.query(
      `UPDATE platform_support_sessions
         SET expires_at = NOW() - INTERVAL '1 minute',
             started_at = NOW() - INTERVAL '31 minutes'
       WHERE id = $1`,
      [opened.body.data.id],
    );
    await assert.rejects(
      () =>
        assertSupportContextEffectiveness({
          actorUserId: actor.userId,
          sessionId: opened.body.data.id,
          customerId,
        }),
      (err: { code?: string; statusCode?: number }) =>
        err?.code === 'SAAS_SUPPORT_SESSION_EXPIRED' &&
        err?.statusCode === 403,
    );
  });

  it('12. cross-customer denied by runtime guard', async (c) => {
    if (!ready(c)) return;
    const customerA = await seedCustomer();
    const customerB = await seedCustomer();
    const actor = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId: customerA, reason: 'a', durationMinutes: 30 });
    assert.equal(opened.status, 201);
    await assert.rejects(
      () =>
        assertSupportContextEffectiveness({
          actorUserId: actor.userId,
          sessionId: opened.body.data.id,
          customerId: customerB,
        }),
      (err: { statusCode?: number; code?: string }) =>
        err?.code === 'SAAS_SUPPORT_SESSION_NOT_FOUND' &&
        err?.statusCode === 404,
    );
  });

  it('13. cross-building denied by runtime guard (building-scoped)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const { buildingId: a } = await seedPropertyAndBuilding(customerId);
    const { buildingId: b } = await seedPropertyAndBuilding(customerId);
    assert.notEqual(a, b);
    const actor = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({
        customerId,
        buildingId: a,
        reason: 'narrow',
        durationMinutes: 30,
      });
    assert.equal(opened.status, 201);
    await assert.rejects(
      () =>
        assertSupportContextEffectiveness({
          actorUserId: actor.userId,
          sessionId: opened.body.data.id,
          customerId,
          buildingId: b,
        }),
      (err: { statusCode?: number; code?: string }) =>
        err?.code === 'SAAS_SUPPORT_SESSION_NOT_FOUND' &&
        err?.statusCode === 404,
    );
  });

  it('14. customer-wide session allows same-customer building (runtime guard)', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedCustomer();
    const { buildingId } = await seedPropertyAndBuilding(customerId);
    const actor = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId, reason: 'customer-wide', durationMinutes: 30 });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.data.buildingId, null);
    const { assertSupportContextEffectiveness } = await import(
      '../src/modules/platform-support'
    );
    const ctx = await assertSupportContextEffectiveness({
      actorUserId: actor.userId,
      sessionId: opened.body.data.id,
      customerId,
      buildingId,
    });
    assert.equal(ctx.customerId, customerId);
    assert.equal(ctx.buildingId, null, 'session.buildingId remains null');
  });

  it('15. customer-wide session + foreign-customer building denied', async (c) => {
    if (!ready(c)) return;
    const customerA = await seedCustomer();
    const customerB = await seedCustomer();
    const { buildingId: buildingB } =
      await seedPropertyAndBuilding(customerB);
    const actor = await createSupportActor();
    const opened = await app()
      .post('/api/v1/platform/support-sessions')
      .set(auth(actor.token))
      .send({ customerId: customerA, reason: 'a-wide', durationMinutes: 30 });
    assert.equal(opened.status, 201);
    await assert.rejects(
      () =>
        assertSupportContextEffectiveness({
          actorUserId: actor.userId,
          sessionId: opened.body.data.id,
          customerId: customerA,
          buildingId: buildingB,
        }),
      (err: { statusCode?: number; code?: string }) =>
        err?.code === 'SAAS_SUPPORT_SESSION_NOT_FOUND' &&
        err?.statusCode === 404,
    );
  });
});
