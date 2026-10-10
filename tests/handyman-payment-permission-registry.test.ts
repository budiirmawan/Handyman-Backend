import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { foundationAccessSeed } from '../src/database/seeds/foundation-access.seed';
import { permissionService } from '../src/modules/permissions';
import { roleRepository, roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * W02 PART 02B — payment permission registry reconciliation (runtime).
 *
 * Proves, on a freshly migrated database and after the real foundation seed:
 *   - `handyman.payment.report` and `handyman.payment.verify` are registered
 *     exactly once, ACTIVE, with the migration-0432 names.
 *   - No role holds either code after the seed (no auto-grant, including
 *     PLATFORM_ADMIN), and a PLATFORM_ADMIN user does not resolve either code.
 *   - The Care Actor grant allowlist (0432 CHECK) still admits only REPORT;
 *     VERIFY is unrepresentable for a care actor.
 * It does not change runtime authorization. Route guards are verified by the
 * existing payment authorization tests.
 */

const PAYMENT_CODES = ['handyman.payment.report', 'handyman.payment.verify'] as const;
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const PORT = 55555;
const DIR = '/tmp/handyman-payment-permission-registry-pg';
let postgres: EmbeddedPostgres | null = null;
let pool: Pool;

before(async () => {
  if (EMBEDDED) {
    Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(PORT),
      DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({ databaseDir: DIR, port: PORT,
      user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }
  const config = await ensureTestDatabase();
  assert.ok(config, 'Payment registry tests require PostgreSQL (no silent skips)');
  pool = await initDatabase(config);
  await migrateUp(pool);
});

after(async () => {
  if (pool) await closePool(pool);
  if (postgres) { await postgres.stop(); await rm(DIR, { recursive: true, force: true }); }
});

async function grantsFor(codes: readonly string[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM role_permission_assignments rpa
       JOIN permissions p ON p.id = rpa.permission_id
      WHERE p.code = ANY($1::text[])`,
    [codes],
  );
  return rows[0].n;
}

describe('W02 PART 02B — payment permission registry', () => {
  it('registers each payment code exactly once, ACTIVE, with the migration-0432 name', async () => {
    const { rows } = await pool.query<{ code: string; name: string; status: string; n: number }>(
      `SELECT code, name, status, count(*) OVER (PARTITION BY code)::int AS n
         FROM permissions WHERE code = ANY($1::text[])`,
      [PAYMENT_CODES],
    );
    assert.equal(rows.length, 2, JSON.stringify(rows));
    for (const row of rows) {
      assert.equal(row.n, 1, `${row.code} must be registered exactly once`);
      assert.equal(row.status, 'ACTIVE');
    }
    assert.equal(rows.find((r) => r.code === 'handyman.payment.report')?.name, 'Report Handyman Customer Payments');
    assert.equal(rows.find((r) => r.code === 'handyman.payment.verify')?.name, 'Verify Handyman Customer Payments');
  });

  it('no role holds either payment code before the seed (migrations grant nothing)', async () => {
    assert.equal(await grantsFor(PAYMENT_CODES), 0);
  });

  it('the real foundation seed does not auto-grant either code to any role, including PLATFORM_ADMIN', async () => {
    await foundationAccessSeed.run(pool);
    assert.equal(await grantsFor(PAYMENT_CODES), 0, 'no role grant for report or verify after seed');

    // Sanity: the seed really ran and PLATFORM_ADMIN holds ordinary codes.
    const admin = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(admin, 'PLATFORM_ADMIN exists after seed');
    const ordinary = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM role_permission_assignments rpa
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE rpa.role_id = $1 AND p.code = 'tenant_company.read' AND rpa.status = 'ACTIVE'`,
      [admin.id],
    );
    assert.equal(ordinary.rows[0].n, 1, 'seed granted ordinary codes to PLATFORM_ADMIN');
  });

  it('a PLATFORM_ADMIN user resolves neither payment code at runtime', async () => {
    const suffix = randomUUID().slice(0, 8).toLowerCase();
    const user = await userService.createUser({ email: `payadmin-${suffix}@example.com`, displayName: 'Payment Admin' });
    const admin = await roleRepository.findByCode('PLATFORM_ADMIN');
    assert.ok(admin);
    await roleService.assignRoleToUser(user.id, admin.id);
    const resolved = await permissionService.resolvePermissionsForUser(user.id);
    assert.ok(resolved.includes('tenant_company.read'), 'role resolution works (sanity)');
    for (const code of PAYMENT_CODES) {
      assert.equal(resolved.includes(code), false, `${code} must not be inherited via PLATFORM_ADMIN`);
    }
  });

  it('the Care Actor grant allowlist still rejects verify (REPORT only)', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO handyman_care_actor_permission_grants
           (id, care_actor_id, permission_code, status, granted_by_user_id, granted_at)
         VALUES ($1, $2, 'handyman.payment.verify', 'ACTIVE', $3, NOW())`,
        [randomUUID(), randomUUID(), randomUUID()],
      ),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' && error.constraint === 'handyman_care_actor_perm_grants_code_check',
    );
  });
});
