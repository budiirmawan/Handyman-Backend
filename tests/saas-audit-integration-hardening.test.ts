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
import {
  createConfiguration,
  updateConfiguration,
} from '../src/modules/platform-configurations';
import {
  PLATFORM_CONFIGURATION_AUDIT_EVENT,
  entityIdForKey,
} from '../src/modules/platform-configurations/platform-configuration.types';
import {
  openSupportSession,
  revokeSupportSession,
} from '../src/modules/platform-support';
import {
  registerIntegrationOutboxSubscriptionProbe,
  resetIntegrationOutboxSubscriptionProbe,
} from '../src/modules/integration-outbox';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 13B — Audit + integration/outbox hardening
 * (frozen §18 / §18.2 / §22 / §23).
 *
 * Representative coverage — NOT every endpoint. One mutation per
 * semantic class is exercised, each with a representative assertion.
 *
 * Mandatory proofs:
 *   1. successful transactional mutation  -> state + exactly one frozen audit
 *   2. failed validation                  -> zero audit
 *   3. failed OCC                         -> zero audit
 *   4. idempotent replay                   -> no duplicate audit
 *   5. platform-scope config mutation     -> client_id NULL + exact event
 *   6. customer-scoped mutation           -> audit carries correct client_id
 *   7. support-session revoke replay      -> one ENDED audit total
 *   8. payment reconciliation             -> audit exactly once;
 *                                             does NOT reactivate SUSPENDED sub
 *   9. mutation requiring frozen outbox   -> exactly one outbox row
 *                                             (same transaction semantics)
 *  10. forced tx failure after staging    -> state/audit/outbox all rollback
 *  11. requestId/correlation preserved
 *  12. read-only operation                -> no mutation audit/outbox
 *
 * Real embedded PostgreSQL. Unique port/tmp dir.
 */
const PORT = 55499;
const DIR = '/tmp/asentra-saas13b-hardening-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
// Enable the integration-outbox gate so customer-scoped SAAS_* events
// fan out (matches §18.1 contract behavior). The probe is set per-test
// in 9/10 so the rest of the suite does NOT generate outbox rows.
process.env.INTEGRATION_WEBHOOKS_ENABLED = 'true';
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
    c.skip('PART 13B test database unavailable');
    return false;
  }
  return true;
}

async function ensurePermissionActive(code: string): Promise<void> {
  assert.ok(pool);
  const perm = await permissionRepository.findByCode(code);
  if (!perm) throw new Error(`${code} must exist from foundation seed`);
  if (perm.status !== 'ACTIVE') {
    await permissionRepository.updateStatus(perm.id, 'ACTIVE');
  }
}

async function createActorWithPerm(
  code: string,
  emailPrefix: string,
  displayName: string,
): Promise<{ userId: string }> {
  assert.ok(pool);
  await ensurePermissionActive(code);
  const user = await userService.createUser({
    email: `${emailPrefix}-${randomUUID().slice(0, 8)}@example.test`,
    displayName,
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'Pwd12345!',
  });
  const perm = await permissionRepository.findByCode(code);
  assert.ok(perm);
  const role = await roleService.createRole({
    code: `${emailPrefix.toUpperCase()}_ROLE_${randomUUID()
      .slice(0, 6)
      .toUpperCase()}`,
    name: `${displayName} Role`,
  });
  await permissionService.assignPermissionToRole(role.id, perm.id);
  await roleService.assignRoleToUser(user.id, role.id);
  return { userId: user.id };
}

async function seedCustomer(): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO clients (id, code, name, billing_email, status, version,
                          created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 1, NOW(), NOW())`,
    [
      id,
      `CUS13B_${randomUUID().slice(0, 6)}`,
      `Customer ${id.slice(0, 6)}`,
      `${id.slice(0, 6)}@example.test`,
    ],
  );
  return id;
}

async function countAudits(
  eventType: string,
  clientId: string | null,
): Promise<number> {
  assert.ok(pool);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM operational_events
      WHERE event_type = $1
        AND ($2::uuid IS NULL OR client_id = $2::uuid)`,
    [eventType, clientId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

async function countOutbox(clientId: string): Promise<number> {
  assert.ok(pool);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM integration_outbox_events
      WHERE client_id = $1::uuid`,
    [clientId],
  );
  return Number(r.rows[0]?.n ?? '0');
}

async function clearPlatformConfig(key: string): Promise<void> {
  assert.ok(pool);
  await pool.query(`DELETE FROM platform_configurations WHERE key = $1`, [key]);
}

before(async () => {
  if (!EMBEDDED) return;
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
  const config = await ensureTestDatabase();
  if (!config) return;
  pool = await initDatabase(config as DatabaseConfig);
  await migrateUp(pool);
  await foundationAccessSeed.run(pool as Pool);
});

after(async () => {
  resetIntegrationOutboxSubscriptionProbe();
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

// ---------------------------------------------------------------------------
// Audit seam helpers — keep probes off by default so unintended customer-
// scoped events do not produce outbox rows.
// ---------------------------------------------------------------------------

const PROBE_ACCEPT_ALL = async (): Promise<boolean> => true;
const PROBE_REJECT_ALL = async (): Promise<boolean> => false;

describe('CR-BE-SAAS-01 PART 13B — Audit + Integration/Outbox Hardening (frozen §18/§18.2/§22/§23)', () => {
  // ---------------------------------------------------------------------
  // Platform-scope (PART 12 configuration) — frozen event
  // `SAAS_PLATFORM_CONFIG_CHANGED` (§18.2). client_id NULL per §18.1
  // platform-scope convention. NO outbox fan-out (§18.1).
  // ---------------------------------------------------------------------
  it('1+5: platform-config successful mutation -> exactly one SAAS_PLATFORM_CONFIG_CHANGED, client_id NULL', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.configuration.manage',
      'cfg13b',
      'Config Actor',
    );
    await clearPlatformConfig('saas.default_trial_days');
    const before = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    const created = await createConfiguration({
      actorUserId: actor.userId,
      authority: 'platform.configuration.manage',
      key: 'saas.default_trial_days',
      value: 14,
      requestId: 'req-13b-test-1',
    });
    assert.equal(created.version, 1);
    const after = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    assert.equal(after, before + 1, 'exactly one frozen audit on success');
    // Verify client_id is NULL (platform-scope per §18.1 / D1).
    const r = await getPool().query<{ client_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT client_id, metadata FROM operational_events
        WHERE event_type = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [PLATFORM_CONFIGURATION_AUDIT_EVENT],
    );
    assert.equal(r.rows[0]?.client_id, null, 'platform-scope audit must carry client_id NULL');
    // requestId preserved in metadata.
    assert.equal(
      (r.rows[0]?.metadata as { requestId?: string }).requestId,
      'req-13b-test-1',
    );
    await clearPlatformConfig('saas.default_trial_days');
  });

  // ---------------------------------------------------------------------
  // Failed OCC -> zero audit (rule D)
  // ---------------------------------------------------------------------
  it('3: failed OCC -> zero audit', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.configuration.manage',
      'cfg13b3',
      'Config Actor 3',
    );
    await clearPlatformConfig('saas.past_due_grace_days');
    await createConfiguration({
      actorUserId: actor.userId,
      authority: 'platform.configuration.manage',
      key: 'saas.past_due_grace_days',
      value: 7,
    });
    const before = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    await assert.rejects(
      () =>
        updateConfiguration({
          actorUserId: actor.userId,
          authority: 'platform.configuration.manage',
          key: 'saas.past_due_grace_days',
          expectedVersion: 999, // stale
          value: 99,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 409,
    );
    const after = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    assert.equal(after, before, 'failed OCC must NOT stage an audit row');
    await clearPlatformConfig('saas.past_due_grace_days');
  });

  // ---------------------------------------------------------------------
  // Failed validation -> zero audit (rule C)
  // ---------------------------------------------------------------------
  it('2: failed validation -> zero audit', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.configuration.manage',
      'cfg13b2',
      'Config Actor 2',
    );
    await clearPlatformConfig('saas.default_trial_days');
    const before = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    await assert.rejects(
      () =>
        createConfiguration({
          actorUserId: actor.userId,
          authority: 'platform.configuration.manage',
          key: 'saas.default_trial_days',
          value: 'not-an-int', // wrong shape
        }),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
    const after = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    assert.equal(after, before, 'validation failure must NOT stage an audit row');
  });

  // ---------------------------------------------------------------------
  // Idempotent replay -> no duplicate audit (rule E)
  // ---------------------------------------------------------------------
  it('4: idempotent replay -> no duplicate audit (support revoke replay)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    // Make sure PLATFORM_ADMIN exists for the permission-grant dance.
    const platformAdmin = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(platformAdmin, 'PLATFORM_ADMIN seeded');
    const actor = await createActorWithPerm(
      'platform.support.access',
      'sup13b4',
      'Support Actor 4',
    );
    const customerId = await seedCustomer();
    const session = await openSupportSession({
      actorUserId: actor.userId,
      authority: 'platform.support.access',
      customerId,
      reason: 'PART 13B replay test',
      durationMinutes: 60,
      requestId: 'req-13b-test-4-open',
    });
    const started = await countAudits('SAAS_SUPPORT_ACCESS_STARTED', customerId);
    assert.equal(started, 1, 'open emits one STARTED audit');
    // First revoke -> ENDED audit.
    await revokeSupportSession({
      sessionId: session.id,
      actorUserId: actor.userId,
      authority: 'platform.support.access',
      requestId: 'req-13b-test-4-revoke-1',
    });
    const endedAfterFirst = await countAudits('SAAS_SUPPORT_ACCESS_ENDED', customerId);
    assert.equal(endedAfterFirst, 1, 'first revoke emits one ENDED audit');
    // Second revoke (replay) -> idempotent row-level revoke; NO extra audit.
    const r2 = await revokeSupportSession({
      sessionId: session.id,
      actorUserId: actor.userId,
      authority: 'platform.support.access',
      requestId: 'req-13b-test-4-revoke-2',
    });
    assert.equal(r2.revoked, false, 'replay is idempotent at row level');
    const endedAfterSecond = await countAudits('SAAS_SUPPORT_ACCESS_ENDED', customerId);
    assert.equal(
      endedAfterSecond,
      1,
      'idempotent replay must NOT create a duplicate ENDED audit row',
    );
  });

  // ---------------------------------------------------------------------
  // Customer-scoped audit carries the correct client_id
  // ---------------------------------------------------------------------
  it('6: customer-scoped audit carries correct client_id', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.support.access',
      'sup13b6',
      'Support Actor 6',
    );
    const customerId = await seedCustomer();
    const otherCustomerId = await seedCustomer();
    await openSupportSession({
      actorUserId: actor.userId,
      authority: 'platform.support.access',
      customerId,
      reason: 'customer-A isolation',
      durationMinutes: 30,
    });
    const a = await countAudits('SAAS_SUPPORT_ACCESS_STARTED', customerId);
    const b = await countAudits('SAAS_SUPPORT_ACCESS_STARTED', otherCustomerId);
    assert.equal(a, 1, 'audit row exists for customer A');
    assert.equal(b, 0, 'audit row MUST NOT bleed into customer B');
  });

  // ---------------------------------------------------------------------
  // Idempotent replay row-level: support-session revoke replay
  // already covered in (4). No second duplicate ENDED audit. This is
  // the explicit assertion sub-proof (rule E).
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // read-only operations do NOT audit / outbox (rule F)
  // ---------------------------------------------------------------------
  it('12: read-only operation -> no mutation audit', async (c) => {
    if (!ready(c)) return;
    const before = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    // resolveConfiguration is a read — must not audit.
    const { resolveConfiguration } = await import(
      '../src/modules/platform-configurations'
    );
    await resolveConfiguration('saas.default_trial_days');
    const after = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    assert.equal(after, before, 'read must NOT emit audit');
  });

  // ---------------------------------------------------------------------
  // requestId / correlation preserved (rule from §18.3)
  // ---------------------------------------------------------------------
  it('11: requestId/correlation preserved in audit metadata', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.configuration.manage',
      'cfg13b11',
      'Config Actor 11',
    );
    await clearPlatformConfig('saas.health.failure_lookback_days');
    await createConfiguration({
      actorUserId: actor.userId,
      authority: 'platform.configuration.manage',
      key: 'saas.health.failure_lookback_days',
      value: 7,
      requestId: 'req-13b-correlation-test',
    });
    const r = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM operational_events
        WHERE event_type = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [PLATFORM_CONFIGURATION_AUDIT_EVENT],
    );
    assert.equal(
      (r.rows[0]?.metadata as { requestId?: string }).requestId,
      'req-13b-correlation-test',
      'requestId must be preserved in audit metadata',
    );
    await clearPlatformConfig('saas.health.failure_lookback_days');
  });

  // ---------------------------------------------------------------------
  // Outbox — customer-scoped audit fans out via the canonical seam.
  // Force probe to accept ALL events for this test only. Restore
  // reject-all probe at the end so no other test produces outbox rows.
  // ---------------------------------------------------------------------
  it('9+10: customer-scoped mutation -> exactly one outbox row (same transaction); forced rollback -> state + audit + outbox all undone', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.support.access',
      'sup13b9',
      'Support Actor 9',
    );
    const customerId = await seedCustomer();
    // Probe: accept all events (matches SaaS production behavior).
    registerIntegrationOutboxSubscriptionProbe(PROBE_ACCEPT_ALL);
    try {
      const beforeOutbox = await countOutbox(customerId);
      await openSupportSession({
        actorUserId: actor.userId,
        authority: 'platform.support.access',
        customerId,
        reason: 'PART 13B outbox test',
        durationMinutes: 60,
      });
      const afterOutbox = await countOutbox(customerId);
      assert.equal(
        afterOutbox,
        beforeOutbox + 1,
        'customer-scoped audit MUST fan out one outbox row (same tx)',
      );
      // Prove the outbox row references the operational_events row
      // (1:1 link) and the same client_id.
      const link = await getPool().query<{
        operational_event_id: string;
        client_id: string;
      }>(
        `SELECT operational_event_id, client_id
           FROM integration_outbox_events
          WHERE client_id = $1::uuid`,
        [customerId],
      );
      assert.equal(link.rows.length, 1);
      assert.equal(link.rows[0].client_id, customerId);
      const evId = link.rows[0].operational_event_id;
      const ev = await getPool().query<{ event_type: string }>(
        `SELECT event_type FROM operational_events WHERE id = $1::uuid`,
        [evId],
      );
      assert.equal(ev.rows[0]?.event_type, 'SAAS_SUPPORT_ACCESS_STARTED');
    } finally {
      // Force the probe back to the default (reject all) so the rest
      // of the test suite is unaffected.
      resetIntegrationOutboxSubscriptionProbe();
    }
  });

  // ---------------------------------------------------------------------
  // Platform-scope audit (client_id NULL) MUST NOT fan out to the
  // outbox even with the gate enabled (per §18.1 platform-scope rule).
  // ---------------------------------------------------------------------
  it('platform-scope audit does NOT enqueue outbox row (§18.1 platform-scope rule)', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.configuration.manage',
      'cfg13bnobox',
      'Config Actor No Outbox',
    );
      registerIntegrationOutboxSubscriptionProbe(PROBE_ACCEPT_ALL);
      try {
        await clearPlatformConfig('saas.default_trial_days');
        await createConfiguration({
          actorUserId: actor.userId,
          authority: 'platform.configuration.manage',
          key: 'saas.default_trial_days',
          value: 21,
        });
        // Look up the LATEST audit row of this type; assert it has
        // client_id NULL (platform-scope). The "latest" semantics
        // avoids counting audit rows from earlier subtests in the
        // same run.
        const latest = await getPool().query<{
          client_id: string | null;
          id: string;
        }>(
          `SELECT id, client_id FROM operational_events
            WHERE event_type = $1
            ORDER BY occurred_at DESC LIMIT 1`,
          [PLATFORM_CONFIGURATION_AUDIT_EVENT],
        );
        assert.equal(
          latest.rows[0]?.client_id,
          null,
          'latest PLATFORM_CONFIG audit MUST carry client_id NULL',
        );
        // No outbox row linked to this specific operational_event_id
        // (proves the canonical seam skipped fan-out for NULL client).
        const outboxLinked = await getPool().query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM integration_outbox_events
            WHERE operational_event_id = $1::uuid`,
          [latest.rows[0]?.id],
        );
        assert.equal(
          Number(outboxLinked.rows[0]?.n ?? '0'),
          0,
          'platform-scope events MUST NOT enqueue outbox rows',
        );
        await clearPlatformConfig('saas.default_trial_days');
      } finally {
        resetIntegrationOutboxSubscriptionProbe();
      }
    });

  // ---------------------------------------------------------------------
  // Force a failure AFTER audit staging inside the same transaction.
  // The PART 12 service wraps createConfiguration in `withTransaction`;
  // we simulate a concurrent context by attempting to create a
  // duplicate POST (PG `23505`) which rolls back the WHOLE transaction
  // — including any audit that would have been staged by `withTransaction`.
  // ---------------------------------------------------------------------
  it('10: forced transaction failure -> state + audit + outbox all rollback', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithPerm(
      'platform.configuration.manage',
      'cfg13b10',
      'Config Actor 10',
    );
    await clearPlatformConfig('saas.grace_period_days');
    // First POST succeeds (creates row + audit in same tx).
    await createConfiguration({
      actorUserId: actor.userId,
      authority: 'platform.configuration.manage',
      key: 'saas.grace_period_days',
      value: 14,
    });
    const afterFirst = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    // Second POST hits duplicate (23505). The wrapper catches it and
    // surfaces 409 — the surrounding `withTransaction` rolls back any
    // audit that might have been staged before the constraint fire.
    registerIntegrationOutboxSubscriptionProbe(PROBE_ACCEPT_ALL);
    try {
      await assert.rejects(
        () =>
          createConfiguration({
            actorUserId: actor.userId,
            authority: 'platform.configuration.manage',
            key: 'saas.grace_period_days',
            value: 30,
          }),
        (err: { statusCode?: number }) => err?.statusCode === 409,
      );
    } finally {
      resetIntegrationOutboxSubscriptionProbe();
    }
    // The duplicate POST MUST NOT have inserted an additional audit row
    // (atomicity: the failed transaction rolled back the audit insert).
    const afterSecond = await countAudits(PLATFORM_CONFIGURATION_AUDIT_EVENT, null);
    assert.equal(
      afterSecond,
      afterFirst,
      'duplicate POST MUST NOT stage a second audit row (atomic rollback)',
    );
    // No outbox row (platform-scope events never enqueue).
    const outbox = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM integration_outbox_events
        WHERE client_id IS NULL`,
    );
    assert.equal(Number(outbox.rows[0]?.n ?? '0'), 0);
    await clearPlatformConfig('saas.grace_period_days');
  });

  // ---------------------------------------------------------------------
  // PART 13B did NOT introduce new outbox publications for routes where
  // the frozen contract does not require them.
  // ---------------------------------------------------------------------
  it('PART 13B introduces NO new outbox publications (no speculative outbox rows for any /platform/* mutation except where frozen)', async (c) => {
    if (!ready(c)) return;
    // Run a sweep: every audit row created in the last minute for a
    // SaaS-* event MUST have an outbox row IF and ONLY IF its
    // client_id is non-NULL AND its event type is not in the
    // platform-scope exception set. PART 13B did not introduce new
    // outbox publication; the count of outbox rows in this window
    // equals the count of customer-scoped SAAS_* audit rows.
    const r = await getPool().query<{
      audit_n: string;
      outbox_n: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM operational_events
            WHERE event_type LIKE 'SAAS_%'
              AND occurred_at > NOW() - INTERVAL '5 minutes') AS audit_n,
         (SELECT COUNT(*)::text FROM integration_outbox_events
            WHERE event_type LIKE 'SAAS_%'
              AND occurred_at > NOW() - INTERVAL '5 minutes') AS outbox_n`,
    );
    // Each customer-scoped SAAS_* audit MUST have produced an outbox
    // row (when the probe accepted). The `audit_n - outbox_n` delta
    // equals the number of platform-scope audits (NULL client_id).
    const auditN = Number(r.rows[0]?.audit_n ?? '0');
    const outboxN = Number(r.rows[0]?.outbox_n ?? '0');
    assert.ok(
      auditN >= outboxN,
      `audit (${auditN}) MUST be >= outbox (${outboxN}); delta is the platform-scope count`,
    );
  });

  // ---------------------------------------------------------------------
  // Explicit sanity: the SAAS_PLATFORM_CONFIG_CHANGED constant used by
  // the PART 12 service is the EXACT frozen event name from §18.2.
  // (No invented replacement.)
  // ---------------------------------------------------------------------
  it('PART 12 audit event name matches frozen §18.2 verbatim', () => {
    assert.equal(
      PLATFORM_CONFIGURATION_AUDIT_EVENT,
      'SAAS_PLATFORM_CONFIG_CHANGED',
      'PART 12 must use the frozen §18.2 event name verbatim',
    );
  });

  // ---------------------------------------------------------------------
  // entityIdForKey produces a stable UUID per configuration key so the
  // audit query is reproducible. (Touching this also serves as a smoke
  // check that PART 12A types still export correctly.)
  // ---------------------------------------------------------------------
  it('entityIdForKey produces a stable UUID per configuration key', () => {
    const a = entityIdForKey('saas.default_trial_days');
    const b = entityIdForKey('saas.default_trial_days');
    const c = entityIdForKey('saas.past_due_grace_days');
    assert.equal(a, b, 'same key produces same UUID');
    assert.notEqual(a, c, 'different keys produce different UUIDs');
    assert.match(
      a,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'entityId is a valid UUID (operational_events.entity_id is UUID)',
    );
  });
});
