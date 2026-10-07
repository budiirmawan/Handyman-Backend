import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, permissions CASCADE');
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

describe('foundation access seed', () => {
  it('seeds permissions and the PLATFORM_ADMIN role idempotently', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    await runSeeds(pool!);
    await runSeeds(pool!);

    const permissions = await pool!.query<{ code: string }>(
      `SELECT code FROM permissions WHERE code = ANY($1::text[])`,
      [FOUNDATION_PERMISSIONS.map((p) => p.code)],
    );
    assert.equal(permissions.rowCount, FOUNDATION_PERMISSIONS.length);

    const role = await pool!.query<{ code: string }>(
      `SELECT code FROM roles WHERE code = 'PLATFORM_ADMIN'`,
    );
    assert.equal(role.rowCount, 1);

    const assignments = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM role_permission_assignments rpa
       JOIN roles r ON r.id = rpa.role_id
       WHERE r.code = 'PLATFORM_ADMIN' AND rpa.status = 'ACTIVE'`,
    );
    // CR-BE-COMM-VAR-01 PART 02 — every catalogue code is granted to
    // PLATFORM_ADMIN except the explicitly unassigned financial-override
    // codes, which must be assigned as a deliberate administrative act.
    assert.equal(
      assignments.rows[0]?.count,
      String(
        FOUNDATION_PERMISSIONS.length -
          UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.size,
      ),
    );

    for (const code of UNASSIGNED_BY_DEFAULT_PERMISSION_CODES) {
      const granted = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM role_permission_assignments rpa
           JOIN roles r ON r.id = rpa.role_id
           JOIN permissions p ON p.id = rpa.permission_id
          WHERE p.code = $1 AND rpa.status = 'ACTIVE'`,
        [code],
      );
      assert.equal(
        granted.rows[0]?.count,
        '0',
        `${code} must not be granted to any role by the foundation seed`,
      );
    }

    const users = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users`,
    );
    assert.equal(users.rows[0]?.count, '0');
  });
});
