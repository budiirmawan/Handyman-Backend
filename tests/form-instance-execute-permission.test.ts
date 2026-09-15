import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, runSeeds } from '../src/database';
import {
  FOUNDATION_PERMISSIONS,
  UNASSIGNED_BY_DEFAULT_PERMISSION_CODES,
} from '../src/database/seeds/foundation-access.seed';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const DB_PORT = 55494;
const DATA_DIR = '/tmp/asentra-mob-c07-p01c-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const EXECUTE = 'form_instance.execute';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

/**
 * MOB-C07 PART 01C — form_instance.execute permission foundation.
 *
 * Catalogue only: the code exists, PLATFORM_ADMIN inherits it, it is not
 * withheld by UNASSIGNED_BY_DEFAULT, the test helper grants it, and it does
 * not authorize existing generic Form Instance mutations (those stay on
 * form_template.manage).
 */

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

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
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE user_sessions, user_credentials, role_permission_assignments,
              user_role_assignments, permissions, roles, users CASCADE`,
  );
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

const ok = (t: TestContext): boolean => {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
};

describe('MOB-C07 PART 01C form_instance.execute permission', () => {
  it('exists in the production catalogue and is not unassigned by default', () => {
    const entry = FOUNDATION_PERMISSIONS.find((item) => item.code === EXECUTE);
    assert.ok(entry, 'form_instance.execute must be in FOUNDATION_PERMISSIONS');
    assert.equal(entry.name, 'Execute Form Instances');
    assert.equal(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(EXECUTE), false);
  });

  it('is granted to PLATFORM_ADMIN by the foundation seed', async (t) => {
    if (!ok(t)) return;
    await runSeeds(pool!);
    const granted = await pool!.query<{ code: string }>(
      `SELECT p.code
         FROM role_permission_assignments rpa
         JOIN roles r ON r.id = rpa.role_id
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE r.code = 'PLATFORM_ADMIN'
          AND p.code = $1
          AND rpa.status = 'ACTIVE'`,
      [EXECUTE],
    );
    assert.equal(granted.rowCount, 1);

    const catalogue = await pool!.query<{ code: string }>(
      `SELECT code FROM permissions WHERE code = $1`,
      [EXECUTE],
    );
    assert.equal(catalogue.rowCount, 1);
  });

  it('is included in the test access helper catalogue', async (t) => {
    if (!ok(t)) return;
    const admin = await createAdminUser();
    const granted = await pool!.query<{ code: string }>(
      `SELECT p.code
         FROM user_role_assignments ura
         JOIN role_permission_assignments rpa ON rpa.role_id = ura.role_id
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE ura.user_id = $1
          AND p.code = $2
          AND ura.status = 'ACTIVE'
          AND rpa.status = 'ACTIVE'`,
      [admin.userId, EXECUTE],
    );
    assert.equal(granted.rowCount, 1);
  });

  it('does not authorize generic Form Instance mutations', async (t) => {
    if (!ok(t)) return;
    const token = await createSessionWithPermissions([
      { code: EXECUTE, name: 'Execute Form Instances' },
    ]);
    const denied = await api()
      .post(`/api/v1/form-template-versions/${randomUUID()}/instances`)
      .set({ Authorization: `Bearer ${token}` });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });
});
