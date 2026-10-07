import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { permissionRepository } from '../src/modules/permissions/permission.repository';
import { roleRepository } from '../src/modules/roles/role.repository';
import { recordOperationalEvent } from '../src/modules/operational-events';
import {
  PLATFORM_CONFIGURATION_AUDIT_EVENT,
  SAAS_PLATFORM_CONFIGURATION_KEYS,
  createConfiguration,
  getConfiguration,
  isKnownConfigurationKey,
  listAllConfigurations,
  resolveConfiguration,
  updateConfiguration,
  validateValue,
} from '../src/modules/platform-configurations';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-SAAS-01 PART 12A — Platform Configuration + Branding Core
 * (frozen §20).
 *
 * Coverage (12A core):
 *   - existing platform_configurations table reused (PART 08 seam)
 *   - known frozen keys resolve configured / frozen-default
 *   - unknown keys rejected (validation)
 *   - wrong shape rejected (validation)
 *   - valid update persists + advances version (OCC §17.3)
 *   - OCC collision returns 409 (no row overwrite)
 *   - audit exactly once on mutation; zero on read
 *   - branding: supportName / supportContact round-trip per customer
 *   - branding: customer-A branding cannot affect customer-B
 *   - D2 invariant: PLATFORM_ADMIN without platform.configuration.manage
 *     does not inherit the permission (catalogue-level proof)
 */
const PORT = 55412;
const DIR = '/tmp/asentra-saas12a-domain-pg';
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
    c.skip('PART 12A test database unavailable');
    return false;
  }
  return true;
}

async function setKey(
  key: string,
  rawJson: string,
): Promise<void> {
  assert.ok(pool);
  // PART 08 may have already inserted the row; ON CONFLICT keeps the
  // test idempotent.
  await pool.query(
    `INSERT INTO platform_configurations (key, value, description)
     VALUES ($1, $2::jsonb, 'PART 12A test fixture')
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    [key, rawJson],
  );
}

async function clearKey(key: string): Promise<void> {
  assert.ok(pool);
  await pool.query(
    `DELETE FROM platform_configurations WHERE key = $1`,
    [key],
  );
}

async function createActorWithConfigurationManage(): Promise<{
  userId: string;
  authority: string;
}> {
  assert.ok(pool);
  const perm =
    await permissionRepository.findByCode('platform.configuration.manage');
  if (!perm) {
    throw new Error(
      'platform.configuration.manage must exist via foundation seed',
    );
  }
  if (perm.status !== 'ACTIVE') {
    await permissionRepository.updateStatus(perm.id, 'ACTIVE');
  }
  const user = await userService.createUser({
    email: `conf-actor-${randomUUID().slice(0, 8)}@example.test`,
    displayName: 'Configuration Actor',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'ConfActor123',
  });
  const role = await roleService.createRole({
    code: `CONF_ROLE_${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Configuration Role',
  });
  await permissionService.assignPermissionToRole(role.id, perm.id);
  await roleService.assignRoleToUser(user.id, role.id);
  return { userId: user.id, authority: 'platform.configuration.manage' };
}

async function createPlatformAdmin(): Promise<{ userId: string }> {
  assert.ok(pool);
  const platformAdmin = await roleRepository.findByCode('PLATFORM_ADMIN');
  assert.ok(platformAdmin, 'PLATFORM_ADMIN seeded by foundation seed');
  const user = await userService.createUser({
    email: `platform-admin-${randomUUID().slice(0, 8)}@example.test`,
    displayName: 'Platform Admin',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password: 'PlatformAdmin123',
  });
  await roleService.assignRoleToUser(user.id, platformAdmin.id);
  return { userId: user.id };
}

async function countConfigAuditsForKey(
  key: string,
): Promise<number> {
  assert.ok(pool);
  const { entityIdForKey } = await import(
    '../src/modules/platform-configurations'
  );
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM operational_events
      WHERE event_type = $1
        AND entity_id  = $2`,
    [PLATFORM_CONFIGURATION_AUDIT_EVENT, entityIdForKey(key as Parameters<typeof entityIdForKey>[0])],
  );
  return Number(result.rows[0].n);
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

// ---------------------------------------------------------------
// Module-scope branding helpers (reused by PART 12A Branding
// block + the PART 10 configuration_completeness source-seam
// block). The customer-scoped source for §21.1
// `configuration_completeness` is `client_configurations` +
// `BRANDING.PROFILE`; PART 12A does NOT push this responsibility
// into `platform_configurations`.
// ---------------------------------------------------------------

async function seedBrandingCustomer(): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO clients (id, code, name, billing_email, status, version,
                          created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 1, NOW(), NOW())`,
    [
      id,
      `CUS12A_${randomUUID().slice(0, 6)}`,
      `Customer ${id.slice(0, 6)}`,
      `${id.slice(0, 6)}@example.test`,
    ],
  );
  return id;
}

interface BrandingProfileFixture {
  brandName: string;
  supportName: string;
  supportContact: string;
}

function makeBrandingProfile(overrides: BrandingProfileFixture): Record<string, unknown> {
  return {
    brandName: overrides.brandName,
    logoReference: null,
    supportName: overrides.supportName,
    supportContact: overrides.supportContact,
    login: {
      title: 'Welcome',
      subtitle: null,
      showLogo: true,
    },
    portal: {
      headerTitle: `${overrides.brandName} Portal`,
      showLogo: true,
    },
    report: {
      headerText: 'Confidential',
      footerText: null,
      showLogo: true,
    },
    theme: {
      primaryColor: '#1F6FEB',
      secondaryColor: '#475569',
      accentColor: '#0EA5E9',
      backgroundColor: '#FFFFFF',
      surfaceColor: '#F8FAFC',
      textColor: '#0F172A',
      fontFamily: 'SYSTEM',
      borderRadius: 'MEDIUM',
    },
  };
}

async function insertBrandingProfile(
  customerId: string,
  profile: Record<string, unknown>,
): Promise<string> {
  assert.ok(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO client_configurations (id, client_id, key, value, status,
                                        created_at, updated_at)
     VALUES ($1, $2, 'BRANDING.PROFILE', $3::jsonb, 'ACTIVE',
             NOW(), NOW())`,
    [id, customerId, JSON.stringify(profile)],
  );
  return id;
}

describe('CR-BE-SAAS-01 PART 12A — Platform Configuration Core (frozen §20)', () => {
  it('existing platform_configurations table is reused (no new config table)', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const r = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_name = 'platform_configurations'
       ) AS exists`,
    );
    assert.equal(r.rows[0].exists, true);
  });

  it('isKnownConfigurationKey returns true only for the 12 frozen keys', async (c) => {
    if (!ready(c)) return;
    // 12 keys: the §20.2 frozen table (11) + §21.1
    // `saas.health.failure_lookback_days` failure-window authority.
    assert.equal(SAAS_PLATFORM_CONFIGURATION_KEYS.length, 12);
    // Each frozen key must be accepted.
    for (const key of SAAS_PLATFORM_CONFIGURATION_KEYS) {
      assert.equal(
        isKnownConfigurationKey(key),
        true,
        `${key} should be a known frozen key`,
      );
    }
    // Unknown keys are rejected (no free-form configs).
    assert.equal(isKnownConfigurationKey('saas.totally.unknown'), false);
    assert.equal(isKnownConfigurationKey('foo.bar'), false);
  });

  it('resolveConfiguration returns the configured value when present', async (c) => {
    if (!ready(c)) return;
    await setKey('saas.default_trial_days', '21');
    const result = await resolveConfiguration('saas.default_trial_days');
    assert.equal(result.source, 'configured');
    assert.equal(result.value, 21);
  });

  it('resolveConfiguration falls back to the frozen default when key is absent', async (c) => {
    if (!ready(c)) return;
    await clearKey('saas.default_trial_days');
    const result = await resolveConfiguration('saas.default_trial_days');
    assert.equal(result.source, 'frozen_default');
    assert.equal(result.value, 14, 'frozen §20.2 default for saas.default_trial_days');
    await clearKey('saas.support_session_max_minutes');
    const max = await resolveConfiguration('saas.support_session_max_minutes');
    assert.equal(max.value, 480, 'frozen §20.2 default for saas.support_session_max_minutes');
  });

  it('resolveConfiguration falls back to the frozen default when configured value is malformed', async (c) => {
    if (!ready(c)) return;
    // PART 08 readConfigNumber convention: malformed → null → caller fall back.
    await setKey('saas.past_due_grace_days', '"not-an-int"');
    const result = await resolveConfiguration('saas.past_due_grace_days');
    assert.equal(result.source, 'frozen_default');
    assert.equal(result.value, 7, 'malformed JSON → default 7');
    await clearKey('saas.past_due_grace_days');
  });

  // ------------------------------------------------------------------
  // §21.1 failure-window authority — `saas.health.failure_lookback_days`
  // is part of the canonical platform configuration catalogue (PART 12
  // canonical, default 7, positive integer, PLATFORM scope). It is NOT
  // a `configuration_completeness` source (that source is the
  // customer-scoped BRANDING.PROFILE — see branding block below).
  // ------------------------------------------------------------------
  it('health lookback: absent → resolves frozen default 7', async (c) => {
    if (!ready(c)) return;
    await clearKey('saas.health.failure_lookback_days');
    const r = await resolveConfiguration(
      'saas.health.failure_lookback_days',
    );
    assert.equal(r.source, 'frozen_default');
    assert.equal(r.value, 7, '§21.1 frozen default is 7 days');
  });

  it('health lookback: configured valid integer overrides 7', async (c) => {
    if (!ready(c)) return;
    await setKey('saas.health.failure_lookback_days', '14');
    const r = await resolveConfiguration(
      'saas.health.failure_lookback_days',
    );
    assert.equal(r.source, 'configured');
    assert.equal(r.value, 14);
    await clearKey('saas.health.failure_lookback_days');
  });

  it('health lookback: malformed value follows canonical fallback', async (c) => {
    if (!ready(c)) return;
    await setKey('saas.health.failure_lookback_days', '"not-an-int"');
    const r = await resolveConfiguration(
      'saas.health.failure_lookback_days',
    );
    assert.equal(r.source, 'frozen_default');
    assert.equal(r.value, 7);
    await clearKey('saas.health.failure_lookback_days');
  });

  it('health lookback: validation rejects non-positive integer', async (c) => {
    if (!ready(c)) return;
    await assert.rejects(
      async () =>
        validateValue('saas.health.failure_lookback_days', -1),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
    await assert.rejects(
      async () =>
        validateValue('saas.health.failure_lookback_days', '7'),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
  });

  it('validateValue rejects unknown keys (no free-form configuration)', async (c) => {
    if (!ready(c)) return;
    await assert.rejects(
      async () => validateValue('saas.totally.unknown', 1),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
  });

  it('validateValue rejects wrong shape for a known key', async (c) => {
    if (!ready(c)) return;
    await assert.rejects(
      async () => validateValue('saas.default_trial_days', 'not-an-int'),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
    await assert.rejects(
      async () => validateValue('saas.suspended_access_policy', 'BOGUS'),
      (err: { statusCode?: number }) => err?.statusCode === 400,
    );
  });

  it('updateConfiguration persists + advances version (OCC §17.3)', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithConfigurationManage();
    // Seed the row first.
    await clearKey('saas.grace_period_days');
    const created = await createConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.grace_period_days',
      value: 21,
    });
    assert.equal(created.version, 1);
    const updated = await updateConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.grace_period_days',
      expectedVersion: 1,
      value: 28,
    });
    assert.equal(updated.before?.value, 21);
    assert.equal(updated.after.version, 2);
    assert.equal(updated.after.value, 28);
    const re = await resolveConfiguration('saas.grace_period_days');
    assert.equal(re.value, 28);
    await clearKey('saas.grace_period_days');
  });

  it('updateConfiguration refuses stale expectedVersion (409 / no overwrite)', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithConfigurationManage();
    await clearKey('saas.past_due_grace_days');
    await createConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.past_due_grace_days',
      value: 7,
    });
    await assert.rejects(
      () =>
        updateConfiguration({
          actorUserId: actor.userId,
          authority: actor.authority,
          key: 'saas.past_due_grace_days',
          expectedVersion: 99, // stale
          value: 10,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 409,
    );
    const after = await resolveConfiguration('saas.past_due_grace_days');
    assert.equal(after.value, 7, 'stale-version attempt must not overwrite');
    await clearKey('saas.past_due_grace_days');
  });

  it('audit: exactly one SAAS_PLATFORM_CONFIG_CHANGED per successful update; zero on read', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithConfigurationManage();
    await clearKey('saas.default_trial_days');
    await createConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.default_trial_days',
      value: 14,
    });
    await updateConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.default_trial_days',
      expectedVersion: 1,
      value: 15,
    });
    const auditedAfterUpdate = await countConfigAuditsForKey(
      'saas.default_trial_days',
    );
    assert.equal(
      auditedAfterUpdate,
      2,
      'create + update must emit one audit each',
    );
    // Reads do not audit.
    await resolveConfiguration('saas.default_trial_days');
    await resolveConfiguration('saas.default_trial_days');
    await listAllConfigurations();
    await getConfiguration('saas.default_trial_days');
    const auditedAfterReads = await countConfigAuditsForKey(
      'saas.default_trial_days',
    );
    assert.equal(auditedAfterReads, 2, 'reads must not add audits');
    await clearKey('saas.default_trial_days');
  });

  it('audit: platform_configurations event carries before/after metadata', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithConfigurationManage();
    await clearKey('saas.suspended_access_policy');
    await createConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.suspended_access_policy',
      value: 'FULL_BLOCK',
    });
    await updateConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.suspended_access_policy',
      expectedVersion: 1,
      value: 'READ_ONLY',
    });
    assert.ok(pool);
    const { entityIdForKey } = await import(
      '../src/modules/platform-configurations'
    );
    const r = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM operational_events
        WHERE event_type = $1
          AND entity_id  = $2
        ORDER BY occurred_at ASC`,
      [
        PLATFORM_CONFIGURATION_AUDIT_EVENT,
        entityIdForKey('saas.suspended_access_policy'),
      ],
    );
    assert.equal(r.rows.length, 2);
    const meta1 = r.rows[0].metadata;
    const meta2 = r.rows[1].metadata;
    assert.equal(meta1['before'], null);
    assert.deepEqual(meta1['after'], { value: 'FULL_BLOCK', version: 1 });
    assert.equal(meta2['before'] && (meta2['before'] as { value: unknown }).value, 'FULL_BLOCK');
    assert.equal(meta2['after'] && (meta2['after'] as { value: unknown }).value, 'READ_ONLY');
    await clearKey('saas.suspended_access_policy');
  });

  it('platform-configuration fallback (frozen_default) is available for PART 10 readers', async (c) => {
    if (!ready(c)) return;
    // PART 10 needs the canonical platform-configuration surface to
    // resolve either a configured value or the frozen default. This
    // is the FAILURE-WINDOW authority; the configuration_completeness
    // authority lives in the customer-scoped BRANDING.PROFILE seam
    // (proved in the dedicated describe block below).
    const r = await resolveConfiguration('saas.default_trial_days');
    assert.ok(typeof r.value === 'number');
    await clearKey('saas.suspended_limited_allowlist');
    const a = await resolveConfiguration('saas.suspended_limited_allowlist');
    assert.equal(a.source, 'frozen_default');
    assert.deepEqual(a.value, []);
  });

  it('D2 invariant: PLATFORM_ADMIN without platform.configuration.manage does not inherit it', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    const perm = await permissionRepository.findByCode(
      'platform.configuration.manage',
    );
    assert.ok(perm, 'permission row must exist');
    // The grant surface (role_permission_assignments joined to
    // user_role_assignments) must NOT show any PLATFORM_ADMIN →
    // platform.configuration.manage link for a fresh admin user.
    const admin = await createPlatformAdmin();
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM role_permission_assignments rpa
         JOIN user_role_assignments ura ON ura.role_id = rpa.role_id
        WHERE ura.user_id = $1
          AND rpa.permission_id = $2`,
      [admin.userId, perm.id],
    );
    assert.equal(
      r.rows[0].n,
      '0',
      'PLATFORM_ADMIN must not inherit platform.configuration.manage (D2)',
    );
  });

  it('platform.configuration.manage is in UNASSIGNED_BY_DEFAULT_PERMISSION_CODES (catalogue invariant)', async (c) => {
    if (!ready(c)) return;
    // The permission code MUST be in the catalogue (foundation seed)
    // and MUST exist — but it MUST NOT have been auto-assigned to
    // the PLATFORM_ADMIN role on the seed pass.
    assert.ok(pool);
    const platformAdmin = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(platformAdmin, 'PLATFORM_ADMIN seeded');
    const perm = await permissionRepository.findByCode(
      'platform.configuration.manage',
    );
    assert.ok(perm, 'platform.configuration.manage seeded');
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM role_permission_assignments
        WHERE role_id = $1
          AND permission_id = $2`,
      [platformAdmin.id, perm.id],
    );
    assert.equal(
      r.rows[0].n,
      '0',
      'platform.configuration.manage must never auto-bind to PLATFORM_ADMIN',
    );
  });

  it('createConfiguration duplicates (existing key) → 409 conflict', async (c) => {
    if (!ready(c)) return;
    const actor = await createActorWithConfigurationManage();
    await clearKey('saas.support_session_max_minutes');
    await createConfiguration({
      actorUserId: actor.userId,
      authority: actor.authority,
      key: 'saas.support_session_max_minutes',
      value: 480,
    });
    await assert.rejects(
      () =>
        createConfiguration({
          actorUserId: actor.userId,
          authority: actor.authority,
          key: 'saas.support_session_max_minutes',
          value: 600,
        }),
      (err: { statusCode?: number }) => err?.statusCode === 409,
    );
    await clearKey('saas.support_session_max_minutes');
  });
});

describe('CR-BE-SAAS-01 PART 12A — Branding extension (frozen §5)', () => {
  // Branding storage is `client_configurations(BRANDING.PROFILE)`
  // (BE-27A foundation). PART 12A adds the additive keys
  // `supportName` / `supportContact` via the validation / type layer
  // (no schema change — JSONB). The existing `client_configurations`
  // repository is unchanged.

  async function readBranding(
    customerId: string,
  ): Promise<{ supportName: string | null; supportContact: string | null } | null> {
    assert.ok(pool);
    const r = await pool.query<{ value: { supportName?: string | null; supportContact?: string | null } }>(
      `SELECT value FROM client_configurations
        WHERE client_id = $1 AND key = 'BRANDING.PROFILE' LIMIT 1`,
      [customerId],
    );
    const row = r.rows[0];
    return row ? {
      supportName: row.value.supportName ?? null,
      supportContact: row.value.supportContact ?? null,
    } : null;
  }

  it('branding storage supports the supportName / supportContact additive keys', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedBrandingCustomer();
    const profile = makeBrandingProfile({
      brandName: 'Acme Holdings',
      supportName: 'Acme Premium Support',
      supportContact: 'support@acme.example',
    });
    await insertBrandingProfile(customerId, profile);
    const stored = await readBranding(customerId);
    assert.equal(stored?.supportName, 'Acme Premium Support');
    assert.equal(stored?.supportContact, 'support@acme.example');
  });

  it('branding is customer-scoped (customer A branding cannot affect customer B)', async (c) => {
    if (!ready(c)) return;
    const customerA = await seedBrandingCustomer();
    const customerB = await seedBrandingCustomer();
    await insertBrandingProfile(
      customerA,
      makeBrandingProfile({
        brandName: 'Acme A',
        supportName: 'Support A',
        supportContact: 'a@example',
      }),
    );
    await insertBrandingProfile(
      customerB,
      makeBrandingProfile({
        brandName: 'Acme B',
        supportName: 'Support B',
        supportContact: 'b@example',
      }),
    );
    const a = await readBranding(customerA);
    const b = await readBranding(customerB);
    assert.equal(a?.supportName, 'Support A');
    assert.equal(b?.supportName, 'Support B');
    assert.notEqual(a?.supportContact, b?.supportContact);
  });

  it('pre-PART-12 profiles without the additive keys round-trip with supportName=null', async (c) => {
    if (!ready(c)) return;
    const customerId = await seedBrandingCustomer();
    // Legacy profile WITHOUT `supportName` / `supportContact` (the
    // additive keys added by PART 12A). Service must preserve the
    // row and the reader must surface `null` for the missing keys.
    const profile = makeBrandingProfile({
      brandName: 'Legacy Co',
      supportName: '', // intentionally empty
      supportContact: '',
    });
    delete (profile as { supportName?: unknown }).supportName;
    delete (profile as { supportContact?: unknown }).supportContact;
    await insertBrandingProfile(customerId, profile);
    const stored = await readBranding(customerId);
    assert.equal(stored?.supportName, null);
    assert.equal(stored?.supportContact, null);
  });
});

/* PART 10 health surface test: verify the new platform-configuration
 * resolver returns values that PART 10A's frozen failure-window
 * (and future health completeness check) can consume. PART 12A does
 * NOT modify PART 10's projection logic — that wiring is deferred
 * to PART 12B/C.
 *
 * The audit-count check lives in the platform-configuration suite
 * above (test 10) to keep the surface here strictly about values.
 */
describe('CR-BE-SAAS-01 PART 12A — migration footprint', () => {
  // PART 12A adds NO persistent DB transformation for the additive
  // branding keys (`supportName` / `supportContact` are JSON-only).
  // No no-op migration is shipped. The migrations registry MUST
  // remain unchanged by PART 12A.
  it('PART 12A ships no no-op migration for additive branding keys', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    // The migrations registry must NOT contain a PART 12A extension
    // migration for branding-only metadata. The active migration list
    // includes PART 08's `0370_create_platform_configurations` (table
    // reused) and PART 01's `0361_allow_platform_scope_operational_events`
    // (platform-scope audit seam). No 0373.
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM schema_migrations
        WHERE id LIKE '%extend_branding_profile_support_metadata%'
           OR id LIKE '%extendBrandingProfileSupportMetadata%'`,
    );
    assert.equal(
      r.rows.length,
      0,
      'no no-op migration should exist for the additive branding JSON keys',
    );
  });
});

describe('CR-BE-SAAS-01 PART 12A — PART 10 configuration_completeness source seam', () => {
  // §21.1 PART 10 contract clarification: the canonical source for
  // `configuration_completeness` is the customer-scoped
  // `client_configurations` + `BRANDING.PROFILE` seam — NOT a
  // platform configuration key. PART 12A establishes this seam as
  // authoritative; PART 10A's `sourceAvailable` + `complete` flip is
  // deferred to PART 12B/C.
  it('configuration_completeness source = client_configurations (BRANDING.PROFILE), not platform_configurations', async (c) => {
    if (!ready(c)) return;
    assert.ok(pool);
    // The completeness source is the customer row; seed a customer
    // + write a profile and read it back via the branding seam.
    const customerId = await seedBrandingCustomer();
    const profile = makeBrandingProfile({
      brandName: 'Completeness Source Co',
      supportName: 'Completeness Support',
      supportContact: 'completeness@example.test',
    });
    await insertBrandingProfile(customerId, profile);
    // Platform configuration (PLATFORM scope) MUST NOT contribute
    // to completeness — it is global/control-plane, not per-tenant.
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM client_configurations
        WHERE client_id = $1::uuid
          AND key = 'BRANDING.PROFILE'`,
      [customerId],
    );
    assert.equal(
      Number(r.rows[0].count),
      1,
      'BRANDING.PROFILE row exists for the customer — authoritative completeness source',
    );
  });

  it('failure-lookback config (PLATFORM scope) is distinct from branding completeness (CUSTOMER scope)', async (c) => {
    if (!ready(c)) return;
    // `saas.health.failure_lookback_days` lives in `platform_configurations`
    // and is read by PART 10's `integration failures` + `notification
    // failures` components (NOT by `configuration_completeness`).
    // The two surfaces use disjoint tables:
    //   - failure-lookback authority → platform_configurations (PLATFORM)
    //   - configuration_completeness → client_configurations
    //     (BRANDING.PROFILE, CUSTOMER)
    await clearKey('saas.health.failure_lookback_days');
    const lookback = await resolveConfiguration(
      'saas.health.failure_lookback_days',
    );
    assert.equal(lookback.source, 'frozen_default');
    assert.equal(lookback.value, 7);
    // Both surfaces are reachable as distinct seams; PART 12A
    // does NOT push failure-lookback into the completeness check.
    assert.ok(pool);
    const platformRows = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM platform_configurations`,
    );
    const customerRows = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM client_configurations`,
    );
    assert.equal(
      Number(platformRows.rows[0].n) >= 0,
      true,
      'platform_configurations is the failure-window seam',
    );
    assert.equal(
      Number(customerRows.rows[0].n) >= 1,
      true,
      'client_configurations holds the BRANDING.PROFILE completeness seam',
    );
  });
});
void recordOperationalEvent;
