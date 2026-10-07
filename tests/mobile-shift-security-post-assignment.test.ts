import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import {
  createSecurityPost,
  securityPostRepository,
  updateSecurityPostStatus,
} from '../src/modules/security-posts';
import { shiftService } from '../src/modules/shifts';
import {
  assignSecurityPostToWorkforceShift,
  assignShiftToWorkforce,
  workforceShiftRepository,
} from '../src/modules/workforce-shifts';
import { workforceService } from '../src/modules/workforce';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C03 PART 03A — Security Post assignment write validation (domain/service
 * layer, real PostgreSQL).
 *
 * The binding lives on `workforce_shift_assignments.security_post_id`
 * (migration 0337). This tests the authoritative write capability
 * (assign / clear) and the mandatory same-Building rule; it does NOT exercise
 * any HTTP/mobile read surface (that is MOB-C03 PART 03B).
 *
 *   - a post in the Shift's Building can be assigned and is persisted;
 *   - a post in a different Building is rejected (SECURITY_POST_BUILDING_MISMATCH);
 *   - null clears an existing binding without touching other data;
 *   - an unknown post id is rejected safely (SECURITY_POST_NOT_FOUND);
 *   - an INACTIVE post is rejected (SECURITY_POST_INACTIVE);
 *   - an unknown roster assignment is rejected (WORKFORCE_SHIFT_ASSIGNMENT_NOT_FOUND);
 *   - roster rows without a post remain valid and unrelated fields never change.
 */

const DB_PORT = 55484;
const DATA_DIR = '/tmp/asentra-mob-c03-p03a-pg';
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
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE workforce_shift_assignments, shifts, security_posts,
       workforce_profiles, positions, departments, organizations,
       buildings, properties, clients, users, roles, permissions CASCADE`,
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

async function fixture() {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'C03P03A client',
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
    timezone: 'Asia/Jakarta',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BB_${suffix()}`,
    name: 'Building B',
    timezone: 'Asia/Jakarta',
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
    employeeCode: `WF_${suffix()}`,
    fullName: 'Security Worker',
  });

  const shiftA = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA.id,
    code: `SA_${suffix()}`,
    name: 'Shift A',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });

  const assignment = await assignShiftToWorkforce({
    workforceProfileId: profile.id,
    shiftId: shiftA.id,
  });

  const postA = await createSecurityPost({
    buildingId: buildingA.id,
    code: `POSTA_${suffix()}`,
    name: 'Gate A',
    postType: 'GATE',
  });
  const postB = await createSecurityPost({
    buildingId: buildingB.id,
    code: `POSTB_${suffix()}`,
    name: 'Gate B',
    postType: 'GATE',
  });

  return { client, buildingA, buildingB, shiftA, profile, assignment, postA, postB };
}

async function errorCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
}

describe('MOB-C03 PART 03A — assign/clear security post on a workforce shift', () => {
  it('roster rows without a post are valid (securityPostId defaults to null)', async (t) => {
    if (!ready(t)) return;
    const { assignment } = await fixture();
    const row = await workforceShiftRepository.findById(assignment.id);
    assert.ok(row);
    assert.equal(row.securityPostId, null);
    assert.equal(assignment.securityPostId, null);
  });

  it('assigns a same-building post and persists it', async (t) => {
    if (!ready(t)) return;
    const { assignment, postA } = await fixture();

    const result = await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: postA.id,
    });
    assert.equal(result.securityPostId, postA.id);

    const row = await workforceShiftRepository.findById(assignment.id);
    assert.equal(row?.securityPostId, postA.id);
  });

  it('rejects a cross-building post (SECURITY_POST_BUILDING_MISMATCH)', async (t) => {
    if (!ready(t)) return;
    const { assignment, postB } = await fixture();

    const code = await errorCodeOf(() =>
      assignSecurityPostToWorkforceShift({
        workforceShiftAssignmentId: assignment.id,
        securityPostId: postB.id,
      }),
    );
    assert.equal(code, 'SECURITY_POST_BUILDING_MISMATCH');

    // Nothing was persisted.
    const row = await workforceShiftRepository.findById(assignment.id);
    assert.equal(row?.securityPostId, null);
  });

  it('rejects an unknown post id safely (SECURITY_POST_NOT_FOUND)', async (t) => {
    if (!ready(t)) return;
    const { assignment } = await fixture();
    const code = await errorCodeOf(() =>
      assignSecurityPostToWorkforceShift({
        workforceShiftAssignmentId: assignment.id,
        securityPostId: randomUUID(),
      }),
    );
    assert.equal(code, 'SECURITY_POST_NOT_FOUND');
  });

  it('rejects an INACTIVE post (SECURITY_POST_INACTIVE)', async (t) => {
    if (!ready(t)) return;
    const { assignment, postA } = await fixture();
    await updateSecurityPostStatus(postA.id, 'INACTIVE');

    const code = await errorCodeOf(() =>
      assignSecurityPostToWorkforceShift({
        workforceShiftAssignmentId: assignment.id,
        securityPostId: postA.id,
      }),
    );
    assert.equal(code, 'SECURITY_POST_INACTIVE');

    const row = await workforceShiftRepository.findById(assignment.id);
    assert.equal(row?.securityPostId, null);
  });

  it('rejects an unknown roster assignment (WORKFORCE_SHIFT_ASSIGNMENT_NOT_FOUND)', async (t) => {
    if (!ready(t)) return;
    const { postA } = await fixture();
    const code = await errorCodeOf(() =>
      assignSecurityPostToWorkforceShift({
        workforceShiftAssignmentId: randomUUID(),
        securityPostId: postA.id,
      }),
    );
    assert.equal(code, 'WORKFORCE_SHIFT_ASSIGNMENT_NOT_FOUND');
  });

  it('null clears an existing post binding without changing unrelated roster fields', async (t) => {
    if (!ready(t)) return;
    const { assignment, postA } = await fixture();

    await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: postA.id,
    });
    const before = await workforceShiftRepository.findById(assignment.id);
    assert.equal(before?.securityPostId, postA.id);

    const cleared = await assignSecurityPostToWorkforceShift({
      workforceShiftAssignmentId: assignment.id,
      securityPostId: null,
    });
    assert.equal(cleared.securityPostId, null);

    const after = await workforceShiftRepository.findById(assignment.id);
    assert.equal(after?.securityPostId, null);
    // Unrelated roster fields are untouched.
    assert.equal(after?.shiftId, before?.shiftId);
    assert.equal(after?.workforceProfileId, before?.workforceProfileId);
    assert.equal(after?.status, before?.status);
    assert.equal(String(after?.effectiveFrom), String(before?.effectiveFrom));
    assert.equal(String(after?.effectiveUntil), String(before?.effectiveUntil));

    // The Security Post itself still exists (clearing must not delete it).
    const postStillExists = await securityPostRepository.findById(postA.id);
    assert.ok(postStillExists, 'clearing the binding must not delete the post');
  });
});
