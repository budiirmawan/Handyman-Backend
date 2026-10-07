import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { shiftService } from '../src/modules/shifts';
import { userService } from '../src/modules/users';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { assignShiftToWorkforce } from '../src/modules/workforce-shifts';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C06 PART 03 — cross-surface final validation of the complete mobile
 * Finding evidence lifecycle (focused integration tests; no new capability).
 *
 * Chains the real production surfaces end-to-end and proves the shared
 * MobileEvidence contract is identical whether it is produced by the upload
 * response or the read endpoint:
 *
 *   1. MOB-C05: POST /mobile/checklist-executions/:executionId/finding
 *      (assigned + on-shift field worker; authoritative Building/Client/
 *      source derived server-side) creates the Finding,
 *   2. MOB-C06 PART 01: POST /mobile/evidence attaches FINDING /
 *      FINDING_REWORK / FINDING_VERIFICATION evidence through the real
 *      workflow states (rework cycle REQUESTED, review PENDING),
 *   3. MOB-C06 PART 02: GET /mobile/evidence/:evidenceId returns the
 *      enriched finding/rework/verification references + the authoritative
 *      Building of the parent Finding.
 *
 * Parity assertion: POST 201 target/building == subsequent GET 200
 * target/building — including across DIFFERENT principals (a write-only
 * uploader without evidence.read, then an evidence.read-only reader), which
 * also re-proves that POST never requires evidence.read and GET never
 * requires the upload permission.
 */

const DB_PORT = 55514;
const DATA_DIR = '/tmp/asentra-mob-c06-p3-pg';
const STORAGE_DIR = resolve(process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence');
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

let adminToken = '';
let adminUserId = '';

let clientA = '';
let buildingA = '';
let buildingACode = '';
let buildingAName = '';

// Field worker: creates Findings via the MOB-C05 endpoint and uploads
// FINDING / FINDING_REWORK evidence (evidence.manage; NO evidence.read —
// the reader performs the GETs).
let fieldWorker: { userId: string; token: string; profileId: string };
let boundExecutionId = '';

// Responsible worker (admin): the workforce assignee that drives a Finding
// through the real state machine to PENDING_REVIEW.
let responsible: { token: string; profileId: string };

// Reviewer: finding.review ONLY (no evidence.manage, no evidence.read) —
// uploads FINDING_VERIFICATION evidence.
let reviewerToken = '';

// Reader: evidence.read ONLY — performs the enriched GETs.
let readerToken = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

/** Creates an authenticated user whose role carries exactly `codes`. */
async function scopedSession(
  prefix: string,
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const password = 'C06P3ScopedPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'C06 P3 Scoped User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `C06P3_${suffix()}`,
    name: 'C06 P3 Scoped Role',
  });
  for (const permission of codes) {
    let record = await permissionRepository.findByCode(permission.code);
    if (!record) {
      record = await permissionService.createPermission(permission);
    }
    await permissionService.assignPermissionToRole(role.id, record.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

/** Seconds-of-day in a given IANA timezone. */
function secondsInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const read = (type: string) =>
    Number((parts.find((p) => p.type === type) ?? { value: '0' }).value);
  return read('hour') * 3600 + read('minute') * 60 + read('second');
}

function toHHMMSS(totalSeconds: number): string {
  const s = ((totalSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

/** A shift on a building whose daily window always contains the current time. */
async function alwaysOnShift(
  buildingId: string,
  clientId: string,
  profileIds: string[],
): Promise<void> {
  const now = new Date();
  const s = secondsInZone(now, 'Asia/Jakarta');
  const shift = await shiftService.createShift({
    clientId,
    buildingId,
    code: `S_${suffix()}`,
    name: 'C06 P3 Always',
    startTime: toHHMMSS(s - 6 * 3600),
    endTime: toHHMMSS(s + 6 * 3600),
  });
  for (const profileId of profileIds) {
    await assignShiftToWorkforce({ workforceProfileId: profileId, shiftId: shift.id });
  }
}

/** MOB-C05 surfaces: checklist template + generated task + bound execution. */
async function bindTaskExecution(templateId: string, buildingId: string): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SD_${suffix()}`,
    name: 'C06 P3 schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateId,
    building_id: buildingId,
    start_at: new Date().toISOString(),
    timezone: 'Asia/Jakarta',
    status: 'ACTIVE',
  });
  const taskId = await insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: scheduleId,
    occurrence_at: new Date().toISOString(),
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateId,
    building_id: buildingId,
    status: 'OPEN',
  });
  await insertRow('task_assignments', {
    task_id: taskId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: fieldWorker.profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
  return insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateId,
    generated_task_id: taskId,
  });
}

/** MOB-C05: the field worker creates a Finding from the bound execution. */
async function createMobileFinding(
  title: string,
): Promise<{ findingId: string; findingNumber: string }> {
  const res = await api()
    .post(`/api/v1/mobile/checklist-executions/${boundExecutionId}/finding`)
    .set(auth(fieldWorker.token))
    .send({ title, description: 'MOB-C06 PART 03 cross-surface flow' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return {
    findingId: res.body.data.findingId as string,
    findingNumber: res.body.data.findingNumber as string,
  };
}

/** Drives a Finding through the real workflow to PENDING_REVIEW. */
async function driveToPendingReview(findingId: string): Promise<void> {
  const assignment = await api()
    .post(`/api/v1/findings/${findingId}/assignments`)
    .set(auth())
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: responsible.profileId });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
  for (const state of ['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW']) {
    const actorToken = state === 'ASSIGNED' ? adminToken : responsible.token;
    const response = await api()
      .patch(`/api/v1/findings/${findingId}/state`)
      .set(auth(actorToken))
      .send({ state });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
}

async function openReview(findingId: string): Promise<string> {
  const review = await api()
    .post(`/api/v1/findings/${findingId}/reviews`)
    .set(auth())
    .send({ notes: 'C06 P3 review opened' });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.equal(review.body.data.status, 'PENDING');
  return review.body.data.id as string;
}

async function requestRework(findingId: string): Promise<string> {
  const rework = await api()
    .post(`/api/v1/findings/${findingId}/rework`)
    .set(auth())
    .send({ reason: 'C06 P3 rework required' });
  assert.equal(rework.status, 201, JSON.stringify(rework.body));
  assert.equal(rework.body.data.rework.status, 'REQUESTED');
  return rework.body.data.rework.id as string;
}

function uploadEvidence(token: string, executionType: string, executionId: string) {
  return api()
    .post('/api/v1/mobile/evidence')
    .set('Authorization', `Bearer ${token}`)
    .field('evidenceType', 'PHOTO')
    .field('executionType', executionType)
    .field('executionId', executionId)
    .attach('file', Buffer.from('c06-p3-evidence-bytes'), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });
}

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
  database = db;

  rmSync(STORAGE_DIR, { recursive: true, force: true });

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, source_forms, form_templates,
      checklist_templates, checklist_items, checklist_executions,
      evidence_requirements, evidence_submissions, generated_tasks,
      schedule_definitions, task_assignments, shifts,
      workforce_shift_assignments, organizations, departments, positions,
      workforce_profiles, workforce_building_assignments, findings,
      finding_assignments, finding_rework_cycles, reviews,
      operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  // --- Hierarchy: client A with one building ------------------------------
  const a = await clientService.createClient({
    code: `CLI_C06P3_${suffix()}`,
    name: 'C06 P3 Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_C06P3_${suffix()}`,
    name: 'C06 P3 Property A',
  });
  const bldA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_C06P3_${suffix()}`,
    name: 'C06 P3 Building A',
    timezone: 'Asia/Jakarta',
  });
  clientA = a.id;
  buildingA = bldA.id;
  buildingACode = bldA.code;
  buildingAName = bldA.name;

  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });

  const organization = await organizationService.createOrganization({
    clientId: clientA,
    code: `O_${suffix()}`,
    name: 'C06 P3 Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'C06 P3 Department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'C06 P3 Position',
  });

  // --- Field worker: MOB-C05 creator + evidence uploader -------------------
  // evidence.manage for FINDING / FINDING_REWORK uploads; deliberately NO
  // evidence.read (the reader performs the GETs — write-only compatibility).
  const worker = await scopedSession('c06p3field', [
    { code: 'checklist.read', name: 'Read Checklists' },
    { code: 'checklist.manage', name: 'Manage Checklists' },
    { code: 'task.read', name: 'Read Tasks' },
    { code: 'evidence.manage', name: 'Manage Evidence' },
  ]);
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId: buildingA,
  });
  const workerProfile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'C06 P3 Field Worker',
  });
  fieldWorker = { ...worker, profileId: workerProfile.id };
  await alwaysOnShift(buildingA, clientA, [fieldWorker.profileId]);

  // --- Responsible worker (admin) driving the state machine ---------------
  const resp = await createAdminUser();
  await buildingAssignmentService.createAssignment(resp.userId, {
    buildingId: buildingA,
  });
  const respProfile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: resp.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'C06 P3 Responsible Worker',
  });
  responsible = { token: resp.token, profileId: respProfile.id };
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: responsible.profileId,
    buildingId: buildingA,
  });

  // --- Reviewer: finding.review ONLY (no evidence.manage / evidence.read) --
  const reviewer = await scopedSession('c06p3rev', [
    { code: 'finding.review', name: 'Review Findings' },
  ]);
  await buildingAssignmentService.createAssignment(reviewer.userId, {
    buildingId: buildingA,
  });
  reviewerToken = reviewer.token;

  // --- Reader: evidence.read ONLY ------------------------------------------
  const reader = await scopedSession('c06p3read', [
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);
  await buildingAssignmentService.createAssignment(reader.userId, {
    buildingId: buildingA,
  });
  readerToken = reader.token;

  // --- MOB-C05 bound checklist execution for the field worker -------------
  const templateId = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_${suffix()}`,
    name: 'C06 P3 Field Checklist',
    status: 'ACTIVE',
  });
  boundExecutionId = await bindTaskExecution(templateId, buildingA);
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
    rmSync(STORAGE_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

describe('MOB-C06 PART 03 — cross-surface Finding evidence flow', () => {
  it('FINDING: MOB-C05 Finding → mobile upload → enriched GET (contract parity)', async (t) => {
    if (!ready(t)) return;
    const created = await createMobileFinding('Cracked floor tile');

    const post = await uploadEvidence(fieldWorker.token, 'FINDING', created.findingId);
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const posted = post.body.data;

    assert.equal(posted.clientId, clientA);
    assert.equal(posted.status, 'ACTIVE');
    assert.equal(posted.target.executionType, 'FINDING');
    assert.equal(posted.target.executionId, created.findingId);
    assert.deepEqual(posted.target.finding, {
      id: created.findingId,
      findingNumber: created.findingNumber,
      title: 'Cracked floor tile',
      status: 'OPEN',
    });
    assert.equal(posted.target.checklist, null);
    assert.equal(posted.target.form, null);
    assert.equal(posted.target.task, null);
    assert.equal(posted.target.rework, null);
    assert.equal(posted.target.verification, null);
    assert.deepEqual(posted.building, {
      id: buildingA,
      code: buildingACode,
      name: buildingAName,
    });
    assert.equal(posted.file.uploadStatus, 'UPLOADED');
    assert.equal(posted.file.fileAvailable, true);
    assert.equal(posted.file.originalFileName, 'photo.jpg');
    assert.equal(posted.file.mimeType, 'image/jpeg');
    assert.equal(posted.file.fileSize, 'c06-p3-evidence-bytes'.length);

    // The evidence.read-only reader (a different principal than the
    // write-only uploader) sees the identical contract.
    const read = await api()
      .get(`/api/v1/mobile/evidence/${posted.id}`)
      .set(auth(readerToken));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const fetched = read.body.data;
    assert.deepEqual(fetched.target, posted.target);
    assert.deepEqual(fetched.building, posted.building);
    assert.deepEqual(fetched.file, posted.file);
  });

  it('FINDING_REWORK: rework cycle (REQUESTED) → mobile upload → enriched GET (contract parity)', async (t) => {
    if (!ready(t)) return;
    const created = await createMobileFinding('Rework flow finding');
    await driveToPendingReview(created.findingId);
    await openReview(created.findingId);
    const cycleId = await requestRework(created.findingId);

    const post = await uploadEvidence(fieldWorker.token, 'FINDING_REWORK', cycleId);
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const posted = post.body.data;

    assert.equal(posted.clientId, clientA);
    assert.equal(posted.target.executionType, 'FINDING_REWORK');
    assert.equal(posted.target.executionId, cycleId);
    assert.deepEqual(posted.target.finding, {
      id: created.findingId,
      findingNumber: created.findingNumber,
      title: 'Rework flow finding',
      status: 'REWORK_REQUIRED',
    });
    assert.deepEqual(posted.target.rework, { id: cycleId, status: 'REQUESTED' });
    assert.equal(posted.target.verification, null);
    assert.equal(posted.target.checklist, null);
    assert.equal(posted.target.form, null);
    assert.equal(posted.target.task, null);
    assert.deepEqual(posted.building, {
      id: buildingA,
      code: buildingACode,
      name: buildingAName,
    });

    const read = await api()
      .get(`/api/v1/mobile/evidence/${posted.id}`)
      .set(auth(readerToken));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const fetched = read.body.data;
    assert.deepEqual(fetched.target, posted.target);
    assert.deepEqual(fetched.building, posted.building);
  });

  it('FINDING_VERIFICATION: reviewer (finding.review only) uploads; evidence.read reader GETs (contract parity)', async (t) => {
    if (!ready(t)) return;
    const created = await createMobileFinding('Verification flow finding');
    await driveToPendingReview(created.findingId);
    const reviewId = await openReview(created.findingId);

    // The reviewer holds ONLY finding.review — no evidence.manage and no
    // evidence.read — and still receives the full enriched 201 response.
    const post = await uploadEvidence(reviewerToken, 'FINDING_VERIFICATION', reviewId);
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const posted = post.body.data;

    assert.equal(posted.clientId, clientA);
    assert.equal(posted.target.executionType, 'FINDING_VERIFICATION');
    assert.equal(posted.target.executionId, reviewId);
    assert.deepEqual(posted.target.finding, {
      id: created.findingId,
      findingNumber: created.findingNumber,
      title: 'Verification flow finding',
      status: 'PENDING_REVIEW',
    });
    assert.equal(posted.target.rework, null);
    assert.deepEqual(posted.target.verification, { id: reviewId, status: 'PENDING' });
    assert.equal(posted.target.checklist, null);
    assert.equal(posted.target.form, null);
    assert.equal(posted.target.task, null);
    assert.deepEqual(posted.building, {
      id: buildingA,
      code: buildingACode,
      name: buildingAName,
    });

    // The evidence.read-only reader (no finding.review) sees the identical
    // contract — GET authority is independent of the upload permission.
    const read = await api()
      .get(`/api/v1/mobile/evidence/${posted.id}`)
      .set(auth(readerToken));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const fetched = read.body.data;
    assert.deepEqual(fetched.target, posted.target);
    assert.deepEqual(fetched.building, posted.building);
  });
});
