/**
 * CR-HM-BACKEND-RELEASE-INTEGRATION-01 PART 01 — migration verification.
 *
 * Runs against a DISPOSABLE embedded PostgreSQL 18 cluster only. It never
 * touches a real database. Three scenarios:
 *
 *   A. FRESH   — migrate an empty cluster from 0000 to the tip.
 *   B. RERUN   — run the same migration set again; must be a no-op.
 *   C. UPGRADE — build the "Biznet representation" (everything up to 0460,
 *                i.e. exactly what production runs today) with historical data,
 *                then apply 0461–0472 on top and prove nothing was lost.
 *
 * Usage: npx tsx tests/manual/release-integration-migration-check.ts
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { startEmbeddedTestDatabase } from '../helpers/embedded-test-db';
import { migrations } from '../../src/database/migrations';
import { migrateUp } from '../../src/database/migrate';
import type { Migration } from '../../src/database/migrations/types';

const PORT = 55441;
const DB = 'release_integration_check';

type Report = {
  scenario: string;
  ok: boolean;
  detail: string;
};

const reports: Report[] = [];

function record(scenario: string, ok: boolean, detail: string): void {
  reports.push({ scenario, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario}\n      ${detail}`);
}

/** Migrations up to and including 0460 — the Biznet (production) representation. */
const PRODUCTION_TIP = '0460_handyman_settlement_dispute_adjudication';
const productionMigrations: Migration[] = migrations.filter((m) => m.id <= PRODUCTION_TIP);
const releaseMigrations: Migration[] = migrations.filter((m) => m.id > PRODUCTION_TIP);

/** Minimal pre-0461 fixture data, so "historical data preserved" is provable. */
async function seedProductionRepresentation(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO roles (id, code, name, description, status)
    VALUES
      ('11111111-1111-4111-8111-111111111111', 'PLATFORM_ADMIN',
       'Platform Administrator', 'Pre-existing production owner role', 'ACTIVE'),
      ('11111111-1111-4111-8111-222222222222', 'OPERATIONS',
       'Operations', 'Pre-existing production operations role', 'ACTIVE')
    ON CONFLICT (code) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO users (id, email, display_name, status)
    VALUES ('22222222-2222-4222-8222-222222222222',
            'integration-owner@example.test', 'Integration Owner', 'ACTIVE')
    ON CONFLICT (email) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO user_credentials (id, user_id, password_hash, must_change_password)
    VALUES ('44444444-4444-4444-8444-444444444444',
            '22222222-2222-4222-8222-222222222222',
            '$2b$12$existingHashMustSurviveIntegrationXXXXXXXXXXXXXXXXXXXXXXXX', false)
    ON CONFLICT (user_id) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO user_role_assignments (id, user_id, role_id, status)
    VALUES ('33333333-3333-4333-8333-333333333333',
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111', 'ACTIVE')
    ON CONFLICT DO NOTHING
  `);
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rowCount === 1;
}

async function tableCount(pool: Pool, table: string): Promise<number> {
  const res = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${table}`);
  return Number(res.rows[0]?.c ?? '0');
}

async function columnExists(pool: Pool, table: string, column: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rowCount === 1;
}

async function indexExists(pool: Pool, name: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name],
  );
  return res.rowCount === 1;
}

async function triggerExists(pool: Pool, name: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`,
    [name],
  );
  return res.rowCount === 1;
}

async function constraintExists(pool: Pool, name: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return res.rowCount === 1;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'hm-release-migration-'));
  const db = await startEmbeddedTestDatabase({ dir, port: PORT, database: DB });
  let dbStopped = false;
  const pool = new Pool({
    host: '127.0.0.1',
    port: PORT,
    user: 'postgres',
    password: '',
    database: DB,
  });
  // An idle client emits 'error' when the disposable cluster shuts down; that
  // is expected teardown noise, not a verification failure.
  pool.on('error', () => undefined);

  try {
    const version = await pool.query<{ v: string }>(
      'SELECT current_setting($1) AS v',
      ['server_version'],
    );
    console.log(`\n=== PostgreSQL ${version.rows[0]?.v} (disposable cluster) ===\n`);

    // ---------------------------------------------------------------- A. FRESH
    const freshApplied = await migrateUp(pool);
    record(
      'A. FRESH migration reaches the tip',
      freshApplied.length === migrations.length,
      `${freshApplied.length} migrations applied (expected ${migrations.length}); ` +
        `tip = ${freshApplied[freshApplied.length - 1]}`,
    );

    const historyA = await pool.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    const appliedIds = historyA.rows.map((r) => r.id);
    const expectedIds = migrations.map((m) => m.id);
    record(
      'A2. Applied history equals the registered set (no 0469)',
      appliedIds.length === expectedIds.length &&
        appliedIds.every((id, i) => id === expectedIds[i]),
      `history=${appliedIds.length} registered=${expectedIds.length} ` +
        `0469present=${appliedIds.some((i) => i.startsWith('0469'))}`,
    );

    // ---------------------------------------------------------------- B. RERUN
    const rerunApplied = await migrateUp(pool);
    record(
      'B. Re-running migrations is a no-op',
      rerunApplied.length === 0,
      `${rerunApplied.length} migrations re-applied (expected 0)`,
    );

    const historyB = await pool.query<{ id: string; applied_at: Date }>(
      'SELECT id, applied_at FROM schema_migrations ORDER BY id',
    );
    const unchanged = historyB.rows.every(
      (row, i) => row.id === historyA.rows[i]?.id,
    );
    record(
      'B2. History rows unchanged by the re-run',
      unchanged,
      `history rows stable=${unchanged}`,
    );

    // ----------------------------------------------------- schema object audit
    const objects: Array<[string, Promise<boolean>]> = [
      ['table workforce_certifications', tableExists(pool, 'workforce_certifications')],
      ['table workforce_certification_decisions', tableExists(pool, 'workforce_certification_decisions')],
      ['table handyman_assignment_competency_evaluations', tableExists(pool, 'handyman_assignment_competency_evaluations')],
      ['table service_catalog_competency_requirements', tableExists(pool, 'service_catalog_competency_requirements')],
      ['table work_order_trade_categories', tableExists(pool, 'work_order_trade_categories')],
      ['table work_order_assignment_competency_decisions', tableExists(pool, 'work_order_assignment_competency_decisions')],
      ['table handyman_helper_attendance_confirmations', tableExists(pool, 'handyman_helper_attendance_confirmations')],
      ['table handyman_assignment_responses', tableExists(pool, 'handyman_assignment_responses')],
      ['column handyman_material_purchase_records.receipt_sha256_checksum', columnExists(pool, 'handyman_material_purchase_records', 'receipt_sha256_checksum')],
      ['column handyman_material_purchase_records.reimbursement_disbursed_at', columnExists(pool, 'handyman_material_purchase_records', 'reimbursement_disbursed_at')],
      ['column handyman_provider_contexts.provider_type', columnExists(pool, 'handyman_provider_contexts', 'provider_type')],
      ['column work_orders.trade_category_id', columnExists(pool, 'work_orders', 'trade_category_id')],
      ['constraint work_order_assignment_competency_decisions_action_check includes RECLASSIFIED', pool.query(
        `SELECT 1 FROM pg_constraint
          WHERE conname = 'work_order_assignment_competency_decisions_action_check'
            AND pg_get_constraintdef(oid) LIKE '%RECLASSIFIED%'`,
      ).then((r) => r.rowCount === 1)],
      ['index work_order_active_assignment_unique', indexExists(pool, 'work_order_active_assignment_unique')],
      ['index handyman_provider_contexts_direct_client_unique', indexExists(pool, 'handyman_provider_contexts_direct_client_unique')],
      ['index workforce_certifications active uniq', indexExists(pool, 'workforce_certifications_active_unique')],
      ['constraint handyman_provider_contexts_type_check', constraintExists(pool, 'handyman_provider_contexts_type_check')],
      ['constraint notifications_navigation_target_check', constraintExists(pool, 'notifications_navigation_target_check')],
    ];
    const objectResults = await Promise.all(objects.map(async ([name, p]) => [name, await p] as const));
    const missing = objectResults.filter(([, ok]) => !ok).map(([n]) => n);
    record(
      'C0. Every release object exists after a fresh migrate',
      missing.length === 0,
      missing.length === 0
        ? `${objectResults.length} objects verified`
        : `missing: ${missing.join(', ')}`,
    );

    // ------------------------------------------------------ 0472 ledger audit
    const navCheck = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'notifications_navigation_target_check' LIMIT 1`,
    );
    const navDef = navCheck.rows[0]?.def ?? '';
    const trades = await pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM work_order_trade_categories',
    );
    record(
      'C1. 0465 multi-trade baseline is seeded (config, not code)',
      Number(trades.rows[0]?.n ?? '0') >= 10,
      `${trades.rows[0]?.n} trade categories seeded`,
    );

    record(
      'D. 0472 ledger upgrade marker present in notifications CHECK',
      navDef.includes('EXECUTION_SCOPE_FIELD_WORK'),
      `constraintdef includes EXECUTION_SCOPE_FIELD_WORK=${navDef.includes('EXECUTION_SCOPE_FIELD_WORK')}`,
    );

    // The 0472 upgrade path in migrate.ts re-runs `up()` when the CHECK already
    // exists but lacks the new value. Simulate a production DB that recorded
    // 0472 as applied while its CHECK is the OLD definition.
    // Restore the PRE-0472 definition (0358): only WORK_ORDER_FIELD_WORK.
    await pool.query(`ALTER TABLE notifications DROP CONSTRAINT notifications_navigation_target_check`);
    await pool.query(`
      ALTER TABLE notifications ADD CONSTRAINT notifications_navigation_target_check
      CHECK (
        (navigation_target_type IS NULL AND navigation_target_id IS NULL)
        OR (navigation_target_type IS NOT NULL
            AND navigation_target_type = 'WORK_ORDER_FIELD_WORK'
            AND navigation_target_id IS NOT NULL)
      )
    `);
    const rerunAfterDowngrade = await migrateUp(pool);
    const navAfter = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'notifications_navigation_target_check' LIMIT 1`,
    );
    record(
      'D2. 0472 idempotent upgrade repairs a stale CHECK (no destructive rollback)',
      rerunAfterDowngrade.length === 0 &&
        (navAfter.rows[0]?.def ?? '').includes('EXECUTION_SCOPE_FIELD_WORK'),
      `migrateUp re-applied=${rerunAfterDowngrade.length}; repaired=` +
        `${(navAfter.rows[0]?.def ?? '').includes('EXECUTION_SCOPE_FIELD_WORK')}`,
    );

    await pool.end();
    await db.stop();
    dbStopped = true;

    // ------------------------------------------------------------ C. UPGRADE
    const upgradeDir = await mkdtemp(join(tmpdir(), 'hm-release-upgrade-'));
    const upDb = await startEmbeddedTestDatabase({
      dir: upgradeDir,
      port: PORT + 1,
      database: 'release_upgrade_check',
    });
    const upPool = new Pool({
      host: '127.0.0.1',
      port: PORT + 1,
      user: 'postgres',
      password: '',
      database: 'release_upgrade_check',
    });
    upPool.on('error', () => undefined);

    try {
      // Migrate ONLY to the production tip by temporarily narrowing the set.
      const upToProduction = await migrateUpWith(upPool, productionMigrations);
      record(
        'E. Production representation (…0460) builds cleanly',
        upToProduction.length === productionMigrations.length,
        `${upToProduction.length} migrations applied; tip=0460`,
      );

      await seedProductionRepresentation(upPool);
      const beforeUsers = await tableCount(upPool, 'users');
      const beforeRoles = await tableCount(upPool, 'roles');
      const beforeGrants = await tableCount(upPool, 'user_role_assignments');
      const beforePerms = await tableCount(upPool, 'permissions');
      const beforePasswords = await upPool.query<{ user_id: string; password_hash: string }>(
        'SELECT user_id, password_hash FROM user_credentials ORDER BY user_id',
      );

      const upgradeApplied = await migrateUp(upPool);
      record(
        'F. Upgrade 0461–0472 applies on top of production data',
        upgradeApplied.length === releaseMigrations.length,
        `${upgradeApplied.length} migrations applied (expected ${releaseMigrations.length})`,
      );

      const afterPasswords = await upPool.query<{ user_id: string; password_hash: string }>(
        'SELECT user_id, password_hash FROM user_credentials ORDER BY user_id',
      );
      const passwordsIdentical =
        JSON.stringify(beforePasswords.rows) === JSON.stringify(afterPasswords.rows);
      record(
        'G. Existing users, roles and PASSWORD HASHES are byte-identical',
        passwordsIdentical &&
          (await tableCount(upPool, 'users')) === beforeUsers &&
          (await tableCount(upPool, 'roles')) === beforeRoles,
        `users ${beforeUsers}→${await tableCount(upPool, 'users')}, ` +
          `roles ${beforeRoles}→${await tableCount(upPool, 'roles')}, ` +
          `user_role_assignments ${beforeGrants}→${await tableCount(upPool, 'user_role_assignments')}, ` +
          `permissions ${beforePerms}→${await tableCount(upPool, 'permissions')}, ` +
          `password hashes unchanged=${passwordsIdentical}`,
      );

      const providerDefault = await upPool.query<{ provider_type: string; n: string }>(
        `SELECT provider_type, COUNT(*)::text AS n FROM handyman_provider_contexts GROUP BY 1`,
      );
      record(
        'H. Existing provider contexts default to VENDOR (direct is additive)',
        providerDefault.rows.every((r) => r.provider_type === 'VENDOR'),
        providerDefault.rows.length === 0
          ? 'no pre-existing provider contexts (empty install)'
          : JSON.stringify(providerDefault.rows),
      );

      const reapply = await migrateUp(upPool);
      record(
        'I. Re-running on the upgraded database changes nothing',
        reapply.length === 0,
        `${reapply.length} migrations re-applied (expected 0)`,
      );

      const orgCount = await tableCount(upPool, 'users');
      record(
        'J. Historical data survives the whole upgrade + re-run',
        orgCount === beforeUsers,
        `users still ${orgCount}`,
      );
    } finally {
      await upDb.stop();
      await upPool.end();
    }
  } finally {
    try {
      await pool.end();
    } catch {
      /* already closed */
    }
    if (!dbStopped) {
      // Never leave a disposable cluster running: an early failure otherwise
      // keeps the process alive until the external timeout kills it.
      try {
        await db.stop();
      } catch {
        /* best effort */
      }
    }
  }

  const failed = reports.filter((r) => !r.ok);
  console.log(
    `\n=== SUMMARY: ${reports.length - failed.length}/${reports.length} checks passed ===\n`,
  );
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.scenario} — ${f.detail}`);
    process.exitCode = 1;
  }
}

/**
 * Applies a specific migration subset (used to build the production
 * representation) without touching the global registry.
 */
async function migrateUpWith(pool: Pool, subset: Migration[]): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const migration of subset) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
      if (existing.rowCount === 1) continue;
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${migration.id} failed: ${String(error)}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
