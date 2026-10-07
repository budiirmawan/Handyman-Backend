import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { securityPostService } from '../src/modules/security-posts';
import { shiftService } from '../src/modules/shifts';
import { workforceService } from '../src/modules/workforce';
import {
  assignSecurityPostToWorkforceShift,
  assignShiftToWorkforce,
} from '../src/modules/workforce-shifts';
import {
  resolveCurrentShifts,
  resolveUpcomingShifts,
} from '../src/modules/mobile-current-shift';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C03 PART 03B — Security Post read projection on mobile current/upcoming shifts.
 *
 * Proves the authoritative read contract for exposing the backend-assigned
 * Security Post on mobile shift read models. The projection is nullable and
 * follows fail-safe rules: only ACTIVE posts in the same Building as the Shift
 * are exposed; all other cases (no assignment, INACTIVE post, cross-building
 * legacy/corrupt relation) return null. The read path must NOT repair or modify
 * data.
 */

const DB_PORT = 55485;
const DATA_DIR = '/tmp/asentra-mob-c03-p03b-pg';
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
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       workforce_shift_assignments, shifts, security_posts,
       workforce_profiles, positions, departments, organizations,
       user_building_assignments, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
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

async function fixture() {
  // Fresh identity per invocation: a user may hold only ONE workforce-profile
  // link, so every test must link (and read shifts as) its own user.
  const manager = await createAdminUser();
  const managerUserId = manager.userId;

  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'PART 03B client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BA_${suffix()}`,
    name: 'Building A',
    timezone: TZ,
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BB_${suffix()}`,
    name: 'Building B',
    timezone: TZ,
  });

  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
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
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: managerUserId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Security Worker',
  });

  const shiftA = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `SA_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });

  const assignment = await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftA.id,
  });

  const postA = await securityPostService.createSecurityPost({
    buildingId: buildingA.id,
    code: `POSTA_${suffix()}`,
    name: 'Gate A',
    postType: 'GATE',
  });

  const postB = await securityPostService.createSecurityPost({
    buildingId: buildingB.id,
    code: `POSTB_${suffix()}`,
    name: 'Gate B',
    postType: 'GATE',
  });

  return {
    managerUserId,
    client,
    buildingA,
    buildingB,
    profile,
    shiftA,
    assignment,
    postA,
    postB,
  };
}

describe('MOB-C03 PART 03B — Security Post read projection on mobile shifts', () => {
  it('current shift without assigned post returns securityPost = null', async (t) => {
    if (!ready(t)) return;
    const { managerUserId, shiftA } = await fixture();

    // 2026-08-20T02:00:00Z == 09:00 Asia/Jakarta — inside 07:00–15:00.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    const shift = context.shifts[0];
    assert.equal(shift.shiftId, shiftA.id);
    assert.equal(shift.securityPost, null);
  });

  it('current shift with ACTIVE same-building assigned post returns securityPost summary', async (t) => {
    if (!ready(t)) return;
    const { managerUserId, assignment, postA } = await fixture();

    await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: postA.id,
    });

    // 2026-08-20T02:00:00Z == 09:00 Asia/Jakarta — inside 07:00–15:00.
    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    const shift = context.shifts[0];
    assert.notEqual(shift.securityPost, null);
    assert.equal(shift.securityPost!.id, postA.id);
    assert.equal(shift.securityPost!.code, postA.code);
    assert.equal(shift.securityPost!.name, postA.name);
  });

  it('upcoming shift exposes the same assigned-post projection', async (t) => {
    if (!ready(t)) return;
    const { managerUserId, assignment, postA } = await fixture();

    await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: postA.id,
    });

    const context = await resolveUpcomingShifts(managerUserId, {}, new Date('2026-08-20T02:00:00Z'));
    assert.equal(context.shifts.length, 1);
    const shift = context.shifts[0];
    assert.notEqual(shift.securityPost, null);
    assert.equal(shift.securityPost!.id, postA.id);
    assert.equal(shift.securityPost!.code, postA.code);
    assert.equal(shift.securityPost!.name, postA.name);
  });

  it('existing mobile shift fields remain unchanged', async (t) => {
    if (!ready(t)) return;
    const { managerUserId, assignment, postA } = await fixture();

    await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: postA.id,
    });

    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    const shift = context.shifts[0];

    // All existing fields must still be present and correct.
    assert.ok(shift.assignmentId);
    assert.ok(shift.shiftId);
    assert.ok(shift.workforceProfileId);
    assert.ok(shift.employeeCode);
    assert.ok(shift.clientId);
    assert.ok(shift.buildingId);
    assert.ok(shift.buildingCode);
    assert.ok(shift.buildingName);
    assert.ok(shift.code);
    assert.ok(shift.name);
    assert.ok(shift.startTime);
    assert.ok(shift.endTime);
    assert.ok(shift.status);
    assert.ok(shift.effectiveFrom !== undefined);
    assert.ok(shift.effectiveUntil !== undefined);
    // And the new field
    assert.ok(shift.securityPost !== undefined);
  });

  it('INACTIVE assigned post returns securityPost = null', async (t) => {
    if (!ready(t)) return;
    const { managerUserId, assignment, postA } = await fixture();

    await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: postA.id,
    });

    // Deactivate the post
    await securityPostService.updateSecurityPost(postA.id, {
      status: 'INACTIVE',
    });

    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    const shift = context.shifts[0];
    assert.equal(shift.securityPost, null);
  });

  it('legacy/corrupted cross-building relationship returns securityPost = null', async (t) => {
    if (!ready(t)) return;
    // Manually create a cross-building assignment by directly updating the database
    // This simulates legacy/corrupted data
    const { managerUserId, assignment, postB } = await fixture();

    // Direct DB update to create cross-building relationship
    await pool!.query(
      `UPDATE workforce_shift_assignments SET security_post_id = $1 WHERE id = $2`,
      [postB.id, assignment.id],
    );

    const context = await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );
    assert.equal(context.shifts.length, 1);
    const shift = context.shifts[0];
    // Cross-building relationship should be filtered out by the LEFT JOIN condition
    assert.equal(shift.securityPost, null);

    // Verify the data was NOT repaired
    const row = await pool!.query(
      `SELECT security_post_id FROM workforce_shift_assignments WHERE id = $1`,
      [assignment.id],
    );
    assert.equal(row.rows[0].security_post_id, postB.id);
  });

  it('read path does not update/repair the roster/post data', async (t) => {
    if (!ready(t)) return;
    const { managerUserId, assignment, postA } = await fixture();

    // Create a corrupted state: assignment points to postA, but we'll deactivate postA
    await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: postA.id,
    });

    await securityPostService.updateSecurityPost(postA.id, {
      status: 'INACTIVE',
    });

    // Call the read path
    await resolveCurrentShifts(
      managerUserId,
      new Date('2026-08-20T02:00:00Z'),
    );

    // Verify the assignment still points to the INACTIVE post (not repaired)
    const assignmentRow = await pool!.query(
      `SELECT security_post_id FROM workforce_shift_assignments WHERE id = $1`,
      [assignment.id],
    );
    assert.equal(assignmentRow.rows[0].security_post_id, postA.id);

    // Verify the post is still INACTIVE (not repaired)
    const postRow = await pool!.query(
      `SELECT status FROM security_posts WHERE id = $1`,
      [postA.id],
    );
    assert.equal(postRow.rows[0].status, 'INACTIVE');
  });
});
