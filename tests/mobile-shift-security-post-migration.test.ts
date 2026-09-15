import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateDown, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { createSecurityPost } from '../src/modules/security-posts';
import { shiftService } from '../src/modules/shifts';
import { assignShiftToWorkforce } from '../src/modules/workforce-shifts';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C03 PART 02 — Workforce Shift Assignment → Security Post persistence
 * foundation (real PostgreSQL, migration focused).
 *
 * This PART adds ONLY the nullable FK `security_post_id` on
 * `workforce_shift_assignments`. These assertions prove the persistence
 * foundation and deliberately do NOT exercise any API/DTO (that is MOB-C03
 * PART 03):
 *   - migration applies on a clean database;
 *   - the column is nullable: a roster assignment without a post is valid
 *     (backward compatible — no row rewrite / no synthetic post);
 *   - a valid security_post id can be stored;
 *   - an invalid (non-existent) security_post id is rejected by the FK;
 *   - deleting a still-referenced Security Post is blocked (NO ACTION — the
 *     platform convention for master/operational references; no cascade);
 *   - the migration down() removes the FK + column (rollback).
 *
 * Same-Building integrity (post must be in the Shift's Building) is NOT a
 * database constraint in this PART — it is deferred to service validation in
 * MOB-C03 PART 03 (see the migration doc). A cross-building value can be
 * persisted at the SQL layer; that is explicitly permitted at the schema
 * level and gated in the service layer.
 */

const DB_PORT = 55483;
const DATA_DIR = '/tmp/asentra-mob-c03-p02-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

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

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

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
    `TRUNCATE workforce_shift_assignments, shifts, security_posts,
       workforce_profiles, positions, departments, organizations,
       user_building_assignments, buildings, properties,
       users, roles, permissions, clients CASCADE`,
  );
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    if (EMBEDDED_DATABASE) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }
  }
  pg = null;
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const TZ = 'Asia/Jakarta';

async function fixtureBuilding(clientId: string, code: string, name: string) {
  const property = await propertyService.createProperty({
    clientId,
    code: `P_${suffix()}`,
    name: `${name} property`,
  });
  return buildingService.createBuilding({
    propertyId: property.id,
    code,
    name,
    timezone: TZ,
  });
}

async function seedRoster() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'C03P02 client',
  });
  const building = await fixtureBuilding(client.id, `B_${suffix()}`, 'Post building');
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Guard',
  });
  // The roster → post binding under test does not depend on a User link; a
  // profile may exist without one (BE-03C). Leaving userId unset also lets
  // each seedRoster() create an independent profile (one profile per user).
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Security Worker',
  });

  const shift = await shiftService.createShift({
    clientId: client.id,
    buildingId: building.id,
    code: `S_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });

  const assignment = await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shift.id,
  });

  const post = await createSecurityPost({
    buildingId: building.id,
    code: `POST_${suffix()}`,
    name: 'Main Gate',
    postType: 'GATE',
  });

  return { client, building, shift, assignment, profile, post };
}

describe('MOB-C03 PART 02 — workforce_shift_assignments.security_post_id foundation', () => {
  it('adds a nullable security_post_id column with an FK to security_posts', async (t) => {
    if (!ready(t)) return;
    const { rows } = await pool!.query(`
      SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
       WHERE table_name = 'workforce_shift_assignments'
         AND column_name = 'security_post_id'
    `);
    assert.equal(rows.length, 1, 'security_post_id column must exist');
    assert.equal(rows[0].is_nullable, 'YES', 'security_post_id must be nullable');
    assert.equal(rows[0].data_type, 'uuid');

    const fk = await pool!.query(`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'workforce_shift_assignments'::regclass
         AND contype = 'f'
         AND conname = 'workforce_shift_assignments_security_post_id_fkey'
    `);
    assert.equal(fk.rowCount, 1, 'FK constraint to security_posts must exist');

    const idx = await pool!.query(`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'workforce_shift_assignments'
         AND indexname = 'workforce_shift_assignments_security_post_id_idx'
    `);
    assert.equal(idx.rowCount, 1, 'lookup index must exist');
  });

  it('keeps existing roster assignments valid with a NULL post (backward compatible)', async (t) => {
    if (!ready(t)) return;
    const { assignment } = await seedRoster();
    const { rows } = await pool!.query(
      `SELECT security_post_id FROM workforce_shift_assignments WHERE id = $1`,
      [assignment.id],
    );
    assert.equal(rows[0].security_post_id, null, 'new assignment defaults to NULL post');
  });

  it('stores a valid security_post FK and reads it back', async (t) => {
    if (!ready(t)) return;
    const { assignment, post } = await seedRoster();
    await pool!.query(
      `UPDATE workforce_shift_assignments SET security_post_id = $1 WHERE id = $2`,
      [post.id, assignment.id],
    );
    const { rows } = await pool!.query(
      `SELECT security_post_id FROM workforce_shift_assignments WHERE id = $1`,
      [assignment.id],
    );
    assert.equal(rows[0].security_post_id, post.id);
  });

  it('rejects a non-existent security_post FK (referential integrity)', async (t) => {
    if (!ready(t)) return;
    const { assignment } = await seedRoster();
    await assert.rejects(
      () =>
        pool!.query(
          `UPDATE workforce_shift_assignments SET security_post_id = $1 WHERE id = $2`,
          [randomUUID(), assignment.id],
        ),
      /foreign key constraint/i,
    );
  });

  it('blocks deletion of a Security Post still referenced by a roster row (NO ACTION, no cascade)', async (t) => {
    if (!ready(t)) return;
    const { assignment, post } = await seedRoster();
    await pool!.query(
      `UPDATE workforce_shift_assignments SET security_post_id = $1 WHERE id = $2`,
      [post.id, assignment.id],
    );
    await assert.rejects(
      () => pool!.query(`DELETE FROM security_posts WHERE id = $1`, [post.id]),
      /foreign key constraint/i,
      'referenced security post must not be cascade-deleted',
    );
    // The roster row is untouched.
    const { rows } = await pool!.query(
      `SELECT security_post_id FROM workforce_shift_assignments WHERE id = $1`,
      [assignment.id],
    );
    assert.equal(rows[0].security_post_id, post.id);
  });

  it('rollback (migrateDown) removes the FK and column', async (t) => {
    if (!ready(t)) return;
    // Sanity: the column exists before rollback.
    const before = await pool!.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'workforce_shift_assignments' AND column_name = 'security_post_id'`,
    );
    assert.equal(before.rowCount, 1);

    const rolledBackId = await migrateDown(pool);
    assert.equal(rolledBackId, '0337_add_security_post_to_workforce_shift_assignments');

    const after = await pool!.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'workforce_shift_assignments' AND column_name = 'security_post_id'`,
    );
    assert.equal(after.rowCount, 0, 'column must be removed by down()');

    const fk = await pool!.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = 'workforce_shift_assignments_security_post_id_fkey'`,
    );
    assert.equal(fk.rowCount, 0, 'FK must be removed by down()');

    // Restore the migration so the after-all / suite state remains migrated.
    await migrateUp(pool);
  });
});
