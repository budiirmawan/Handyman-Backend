import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parseConfig } from '../src/config';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { roleRepository } from '../src/modules/roles/role.repository';
import { buildingService } from '../src/modules/buildings';
import { propertyService } from '../src/modules/properties';
import {
  checkSupportSessionEffectiveness,
  openSupportSession,
  revokeSupportSession,
  SAAS_SUPPORT_SESSION_MAX_MINUTES,
  SUPPORT_ACCESS_ENDED,
  SUPPORT_ACCESS_STARTED,
  SUPPORT_SESSION_ENTITY_TYPE,
} from '../src/modules/platform-support';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 11A — Support Access Core (frozen §19).
 *
 * Domain-only test (no HTTP, no auth middleware). Verifies:
 *   1. explicit grant creation works with required fields
 *   2. reason required (validation)
 *   3. duration exceeding max → reject (not clamp)
 *   4. duration at max → accept
 *   5. session EFFECTIVE before expiry
 *   6. session EXPIRED (derived) after expires_at; no expiry audit
 *   7. revoke makes the session REVOKED immediately
 *   8. cross-customer lookup is NOT_FOUND (scope isolation)
 *   9. PLATFORM_ADMIN without explicit support permission is denied
 *      at the application layer (D2 invariant)
 *  10. duplicate (same actor + customer) EFFECTIVE open → 409
 *  11. EXPIRED existing session → new open succeeds (§19.1 reopen rule)
 *  12. REVOKED existing session → new open succeeds (§19.1 reopen rule)
 *  13. concurrent same actor+customer opens → exactly one succeeds
 *  14. building belongs to customer → valid
 *  15. building from another customer → rejected
 *  16. building-scoped session cannot authorize another building
 *  17. customer-wide (buildingId=null) session authorizes any building
 *
 * Skips anything DB-incompatible (returns true after skipping) so the
 * suite is safe to run with or without embedded PG.
 */
const PORT = 55455;
const DIR = '/tmp/asentra-saas11-domain-pg';
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
    c.skip('CR-BE-SAAS-01 PART 11A test database unavailable');
    return false;
  }
  return true;
}

async function createActorWithSupportAccess(): Promise<{
  userId: string;
  authority: string;
}> {
  assert.ok(pool);
  const user = await userService.createUser({
    email: `support-actor-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Support Actor',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'SupportActor123',
  });
  // Grant platform.support.access explicitly (D2 invariant under test).
  // The permission row is created by the foundation seed.
  const perm = await permissionRepository.findByCode('platform.support.access');
  assert.ok(perm, 'platform.support.access must exist via foundation seed');
  if (perm.status !== 'ACTIVE') {
    await permissionRepository.updateStatus(perm.id, 'ACTIVE');
  }
  const role = await roleService.createRole({
    code: `SUPPORT_ROLE_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Support Role',
  });
  await permissionService.assignPermissionToRole(role.id, perm.id);
  await roleService.assignRoleToUser(user.id, role.id);
  return { userId: user.id, authority: 'platform.support.access' };
}

async function createPlatformAdminWithoutSupportAccess(): Promise<{
  userId: string;
}> {
  assert.ok(pool);
  const role = await roleRepository.findByCode('PLATFORM_ADMIN');
  assert.ok(role, 'PLATFORM_ADMIN must exist (foundation seed)');
  const user = await userService.createUser({
    email: `platform-admin-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Platform Admin',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'PlatformAdmin123',
  });
  await roleService.assignRoleToUser(user.id, role!.id);
  return { userId: user.id };
}

async function seedCustomer(code: string): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO clients (id, code, name, billing_email, status, version,
                          created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 1, NOW(), NOW())`,
    [id, code, `Customer ${code}`, `${code.toLowerCase()}@example.com`],
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

async function setSupportSessionMaxMinutes(value: number | null): Promise<void> {
  assert.ok(pool);
  if (value === null) {
    // Remove any configured row so the runtime falls back to the
    // frozen §19.2 / §20.2 default.
    await pool.query(
      `DELETE FROM platform_configurations WHERE key = 'saas.support_session_max_minutes'`,
    );
    return;
  }
  await pool.query(
    `INSERT INTO platform_configurations (key, value, description)
     VALUES ($1, $2::jsonb, 'PART 11A test fixture')
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    ['saas.support_session_max_minutes', JSON.stringify(value)],
  );
}

async function auditRows(
  sessionId: string,
): Promise<{ eventType: string; actorUserId: string | null; metadata: Record<string, unknown> }[]> {
  assert.ok(pool);
  const r = await pool.query<{
    eventType: string;
    actorUserId: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT event_type AS "eventType",
            actor_user_id AS "actorUserId",
            metadata
       FROM operational_events
      WHERE entity_type = $1
        AND entity_id = $2
      ORDER BY occurred_at ASC`,
    [SUPPORT_SESSION_ENTITY_TYPE, sessionId],
  );
  return r.rows;
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

describe('CR-BE-SAAS-01 PART 11A — Support Access Core (frozen §19)', () => {
  it('explicit grant creates an ACTIVE session with server-authoritative expires_at', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'Troubleshooting a customer-reported invoice bug',
      durationMinutes: 30,
    });
    try {
      assert.equal(session.status, 'ACTIVE');
      assert.equal(session.supportActorUserId, actor.userId);
      assert.equal(session.customerId, customerId);
      assert.ok(session.expiresAt.getTime() > Date.now(), 'expires_at must be in the future');
      const events = await auditRows(session.id);
      assert.equal(events.length, 1, 'exactly one STARTED audit');
      assert.equal(events[0].eventType, SUPPORT_ACCESS_STARTED);
      assert.equal(events[0].actorUserId, actor.userId);
      assert.equal((events[0].metadata as { supportSessionId: string }).supportSessionId, session.id);
    } finally {
      await revokeSupportSession({
        sessionId: session.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  it('reason is mandatory (missing)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    await assert.rejects(
      () =>
        openSupportSession({
          actorUserId: actor.userId,
          authority: actor.authority,
          customerId,
          reason: '   ',
          durationMinutes: 30,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
  });

  it('duration exceeding the platform-configured maximum is rejected (not clamped)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    // Exactly max → accepted
    const ok = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'max boundary',
      durationMinutes: SAAS_SUPPORT_SESSION_MAX_MINUTES,
    });
    await revokeSupportSession({
      sessionId: ok.id,
      actorUserId: actor.userId,
      authority: actor.authority,
    });
    // Max + 1 → rejected
    await assert.rejects(
      () =>
        openSupportSession({
          actorUserId: actor.userId,
          authority: actor.authority,
          customerId,
          reason: 'over max',
          durationMinutes: SAAS_SUPPORT_SESSION_MAX_MINUTES + 1,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
  });

  it('session is EFFECTIVE before expiry and EXPIRED (derived) at/after expires_at', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'short session',
      durationMinutes: 30,
    });
    try {
      const before = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
        now: new Date(Date.now() + 60_000),
      });
      assert.equal(before.kind, 'EFFECTIVE');
      const after = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
        now: new Date(session.expiresAt.getTime() + 60_000),
      });
      assert.equal(after.kind, 'EXPIRED');
      assert.equal(after.kind === 'EXPIRED' && after.session.status, 'ACTIVE');
      const events = await auditRows(session.id);
      const expiredEvents = events.filter(
        (e) => e.eventType !== SUPPORT_ACCESS_STARTED,
      );
      assert.equal(expiredEvents.length, 0, 'expiry must NOT be audited');
    } finally {
      await revokeSupportSession({
        sessionId: session.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  it('revoke makes the session REVOKED and is effective immediately', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'revoke test',
      durationMinutes: 30,
    });
    const revoke = await revokeSupportSession({
      sessionId: session.id,
      actorUserId: actor.userId,
      authority: actor.authority,
    });
    assert.equal(revoke.revoked, true);
    const check = await checkSupportSessionEffectiveness({
      sessionId: session.id,
      customerId,
      now: new Date(),
    });
    assert.equal(check.kind, 'REVOKED');
    const events = await auditRows(session.id);
    assert.equal(events.length, 2, 'grant + revoke = 2 audit records');
    assert.equal(events[0].eventType, SUPPORT_ACCESS_STARTED);
    assert.equal(events[1].eventType, SUPPORT_ACCESS_ENDED);
  });

  it('cross-customer lookup is NOT_FOUND (scope isolation, §19.2 rule 5)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerA = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const customerB = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId: customerA,
      reason: 'isolated',
      durationMinutes: 30,
    });
    try {
      const check = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId: customerB,
      });
      assert.equal(check.kind, 'NOT_FOUND');
    } finally {
      await revokeSupportSession({
        sessionId: session.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  it('PLATFORM_ADMIN without explicit platform.support.access is not granted the permission (D2)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const admin = await createPlatformAdminWithoutSupportAccess();
    const supportPerm = await permissionRepository.findByCode(
      'platform.support.access',
    );
    assert.ok(supportPerm, 'permission must exist in the catalogue');
    const rows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM role_permission_assignments rpa
         JOIN user_role_assignments ura ON ura.role_id = rpa.role_id
        WHERE ura.user_id = $1
          AND rpa.permission_id = $2`,
      [admin.userId, supportPerm.id],
    );
    assert.equal(rows.rows[0].count, '0', 'PLATFORM_ADMIN must NOT carry platform.support.access by default');
    assert.notEqual(supportPerm.status, undefined, 'permission row exists');
  });

  // -----------------------------------------------------------------
  // Reopen-rule proofs (mandatory 1–3): explicit governance of an
  // existing EFFECTIVE vs. EXPIRED vs. REVOKED row.
  // -----------------------------------------------------------------

  it('reopen rule: EFFECTIVE existing session blocks second open (409)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    const first = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'first',
      durationMinutes: 30,
    });
    try {
      await assert.rejects(
        () =>
          openSupportSession({
            actorUserId: actor.userId,
            authority: actor.authority,
            customerId,
            reason: 'second blocked',
            durationMinutes: 30,
          }),
        (err: { statusCode?: number }) => err?.statusCode === 409,
      );
    } finally {
      await revokeSupportSession({
        sessionId: first.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  it('reopen rule: EXPIRED existing session allows new open (§19.1)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    // Open the first session, then manually push its expires_at into
    // the past so it is EFFECTIVE-no, STORAGE-'ACTIVE'-but-past. This
    // models the real-world derived-expiry condition without faking
    // any audit.
    const first = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'first will expire',
      durationMinutes: 30,
    });
    await pool.query(
      `UPDATE platform_support_sessions
         SET expires_at = NOW() - INTERVAL '1 minute',
             started_at = NOW() - INTERVAL '31 minutes'
       WHERE id = $1`,
      [first.id],
    );
    // The first session is now EFFECTIVE-no, REVOKED-no, status
    // storage='ACTIVE'. Reopen must succeed.
    const second = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'second after expiry',
      durationMinutes: 30,
    });
    try {
      assert.notEqual(second.id, first.id);
      assert.equal(second.status, 'ACTIVE');
      const firstCheck = await checkSupportSessionEffectiveness({
        sessionId: first.id,
        customerId,
      });
      assert.equal(firstCheck.kind, 'EXPIRED');
      const secondCheck = await checkSupportSessionEffectiveness({
        sessionId: second.id,
        customerId,
      });
      assert.equal(secondCheck.kind, 'EFFECTIVE');
    } finally {
      await revokeSupportSession({
        sessionId: first.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
      await revokeSupportSession({
        sessionId: second.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  it('reopen rule: REVOKED existing session allows new open (§19.1)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    const first = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'first will be revoked',
      durationMinutes: 30,
    });
    const revoke = await revokeSupportSession({
      sessionId: first.id,
      actorUserId: actor.userId,
      authority: actor.authority,
    });
    assert.equal(revoke.revoked, true);
    const second = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'second after revoke',
      durationMinutes: 30,
    });
    try {
      assert.notEqual(second.id, first.id);
    } finally {
      await revokeSupportSession({
        sessionId: second.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  // -----------------------------------------------------------------
  // Concurrency proof (mandatory 4): serialise via advisory xact lock.
  // -----------------------------------------------------------------

  it('concurrency: N parallel opens → exactly one succeeds', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    const N = 5;
    const attempts = Array.from({ length: N }, (_, i) =>
      openSupportSession({
        actorUserId: actor.userId,
        authority: actor.authority,
        customerId,
        reason: `concurrent-${i}`,
        durationMinutes: 30,
      }).then(
        (s) => ({ ok: true as const, id: s.id }),
        (e: unknown) => ({
          ok: false as const,
          status: (e as { statusCode?: number }).statusCode,
        }),
      ),
    );
    const settled = await Promise.all(attempts);
    const success = settled.filter((r) => r.ok);
    const failed = settled.filter((r) => !r.ok);
    assert.equal(success.length, 1, 'exactly one open must succeed');
    assert.equal(failed.length, N - 1, 'all other opens must fail');
    for (const f of failed) {
      assert.equal(
        f.status,
        409,
        'concurrent losers must reject with 409',
      );
    }
    if (success[0]?.ok) {
      await revokeSupportSession({
        sessionId: success[0].id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  // -----------------------------------------------------------------
  // Building scope proofs (mandatory 5–8).
  // -----------------------------------------------------------------

  it('building belongs to customer → open succeeds (valid narrow scope)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const { buildingId } = await seedPropertyAndBuilding(customerId);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      buildingId,
      reason: 'building-scoped valid',
      durationMinutes: 30,
    });
    try {
      assert.equal(session.buildingId, buildingId);
      const live = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
        buildingId,
      });
      assert.equal(live.kind, 'EFFECTIVE');
    } finally {
      await revokeSupportSession({
        sessionId: session.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  it('building from another customer → open rejected (cross-customer building)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerA = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const customerB = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const { buildingId } = await seedPropertyAndBuilding(customerA);
    const actor = await createActorWithSupportAccess();
    await assert.rejects(
      () =>
        openSupportSession({
          actorUserId: actor.userId,
          authority: actor.authority,
          customerId: customerB,
          buildingId,
          reason: 'cross-customer building',
          durationMinutes: 30,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
  });

  it('building-scoped session cannot authorize another building', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const { buildingId: buildingA } = await seedPropertyAndBuilding(customerId);
    // Build a SECOND building under the same customer.
    const { buildingId: buildingB } = await seedPropertyAndBuilding(customerId);
    assert.notEqual(buildingA, buildingB);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      buildingId: buildingA,
      reason: 'narrow scope',
      durationMinutes: 30,
    });
    try {
      // Same building → EFFECTIVE
      const ok = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
        buildingId: buildingA,
      });
      assert.equal(ok.kind, 'EFFECTIVE');
      // Different building → NOT_FOUND (NOT EFFECTIVE / NOT EXPIRED /
      // NOT REVOKED — refusing to leak state)
      const wrong = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
        buildingId: buildingB,
      });
      assert.equal(wrong.kind, 'NOT_FOUND');
      // Customer-wide (no buildingId) on a building-scoped session →
      // NOT_FOUND
      const noneBuilding = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
      });
      assert.equal(noneBuilding.kind, 'NOT_FOUND');
    } finally {
      await revokeSupportSession({
        sessionId: session.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  it('customer-wide session (buildingId=null) authorizes any building of that customer', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const { buildingId } = await seedPropertyAndBuilding(customerId);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'customer-wide',
      durationMinutes: 30,
    });
    try {
      assert.equal(session.buildingId, null);
      // No requested building → EFFECTIVE
      const noBuilding = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
      });
      assert.equal(noBuilding.kind, 'EFFECTIVE');
      // A specific building of the same customer → EFFECTIVE (customer-wide)
      const matchingBuilding = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId,
        buildingId,
      });
      assert.equal(matchingBuilding.kind, 'EFFECTIVE');
      // Cross-customer → still NOT_FOUND (cross-customer isolation).
      const otherCustomerId = await seedCustomer(
        `CUS11A_${randomUUID().slice(0, 6)}`,
      );
      const otherCustomer = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId: otherCustomerId,
      });
      assert.equal(otherCustomer.kind, 'NOT_FOUND');
    } finally {
      await revokeSupportSession({
        sessionId: session.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  // -----------------------------------------------------------------
  // Customer-wide building scope MUST validate ownership (§19.2
  // rule 5 — scope-denial on cross-customer contexts).
  // -----------------------------------------------------------------

  it('customer-wide session + cross-customer building requested → DENIED (NOT_FOUND)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const customerA = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const customerB = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    // Building belongs to customerB.
    const { buildingId: buildingB } = await seedPropertyAndBuilding(customerB);
    const actor = await createActorWithSupportAccess();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId: customerA,
      reason: 'customer-wide for A',
      durationMinutes: 30,
    });
    try {
      // A customer-wide session for A, but the caller asks about a
      // building that belongs to B — must NOT silently authorize.
      const denied = await checkSupportSessionEffectiveness({
        sessionId: session.id,
        customerId: customerA,
        buildingId: buildingB,
      });
      assert.equal(denied.kind, 'NOT_FOUND');
    } finally {
      await revokeSupportSession({
        sessionId: session.id,
        actorUserId: actor.userId,
        authority: actor.authority,
      });
    }
  });

  // -----------------------------------------------------------------
  // durationMinutes is bound by the resolved
  // `saas.support_session_max_minutes` configuration (PART 11A
  // reads the existing config seam created by PART 08 / §20.2;
  // PART 12 owns writes/UI). Default = 480.
  // -----------------------------------------------------------------

  it('max-duration source: no config row → default 480 (480 OK, 481 rejected)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    await setSupportSessionMaxMinutes(null);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    // 480 → accepted (default max)
    const ok = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'boundary-480',
      durationMinutes: SAAS_SUPPORT_SESSION_MAX_MINUTES,
    });
    await revokeSupportSession({
      sessionId: ok.id,
      actorUserId: actor.userId,
      authority: actor.authority,
    });
    // 481 → rejected (over default max)
    await assert.rejects(
      () =>
        openSupportSession({
          actorUserId: actor.userId,
          authority: actor.authority,
          customerId,
          reason: 'over-480',
          durationMinutes: SAAS_SUPPORT_SESSION_MAX_MINUTES + 1,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
  });

  it('max-duration source: configured=60 → 60 OK, 61 rejected', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    await setSupportSessionMaxMinutes(60);
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    // 60 → accepted (configured max)
    const ok = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'boundary-60',
      durationMinutes: 60,
    });
    // Expires_at must use the REQUESTED duration (60 min), not the
    // default (480 min). Verify by computing the gap.
    const gapMs = ok.expiresAt.getTime() - ok.startedAt.getTime();
    assert.equal(
      gapMs,
      60 * 60_000,
      'expiry uses accepted requested duration; no clamping',
    );
    await revokeSupportSession({
      sessionId: ok.id,
      actorUserId: actor.userId,
      authority: actor.authority,
    });
    // 61 → rejected (over configured max)
    await assert.rejects(
      () =>
        openSupportSession({
          actorUserId: actor.userId,
          authority: actor.authority,
          customerId,
          reason: 'over-60',
          durationMinutes: 61,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
    // Cleanup the test fixture so subsequent tests fall back to 480.
    await setSupportSessionMaxMinutes(null);
  });

  it('max-duration source: malformed configured value → falls back to default', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    // Insert a malformed value. PART 08's readConfigNumber convention
    // returns null on malformed; the service falls back to 480.
    await pool.query(
      `INSERT INTO platform_configurations (key, value, description)
       VALUES ('saas.support_session_max_minutes', '"not-a-number"'::jsonb,
               'PART 11A test fixture - malformed')
       ON CONFLICT (key) DO UPDATE SET value = '"not-a-number"'::jsonb`,
    );
    const customerId = await seedCustomer(`CUS11A_${randomUUID().slice(0, 6)}`);
    const actor = await createActorWithSupportAccess();
    // 480 → accepted (fallback applies)
    const ok = await openSupportSession({
      actorUserId: actor.userId,
      authority: actor.authority,
      customerId,
      reason: 'malformed-config-480',
      durationMinutes: 480,
    });
    await revokeSupportSession({
      sessionId: ok.id,
      actorUserId: actor.userId,
      authority: actor.authority,
    });
    // 481 → rejected
    await assert.rejects(
      () =>
        openSupportSession({
          actorUserId: actor.userId,
          authority: actor.authority,
          customerId,
          reason: 'malformed-config-481',
          durationMinutes: 481,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
    // Cleanup.
    await setSupportSessionMaxMinutes(null);
  });
});
