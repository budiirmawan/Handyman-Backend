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
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { credentialService } from '../src/modules/auth';
import { departmentService } from '../src/modules/departments';
import { findingService } from '../src/modules/findings';
import { organizationService } from '../src/modules/organizations';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C06 PART 02 — Mobile Finding Evidence Read Model (focused tests).
 *
 * GET /mobile/evidence/:evidenceId enriches the Finding-related kinds with
 * the authoritative parent context, derived ONLY from the stored evidence's
 * execution_type + execution_id (never from client input):
 *
 *   - FINDING              → finding reference + Building of the Finding,
 *   - FINDING_REWORK       → finding + rework references + Building of the
 *                            parent Finding (relationship resolved through
 *                            the authoritative rework cycle row),
 *   - FINDING_VERIFICATION → finding + verification references + Building of
 *                            the parent Finding (relationship resolved
 *                            through the authoritative review row,
 *                            target_type = 'FINDING').
 *
 * Read authority stays `evidence.read`; the parent Finding's Building must
 * be accessible before any enriched metadata is returned (403 otherwise);
 * broken/missing/non-FINDING parents fail closed (404). Existing
 * FORM_INSTANCE / CHECKLIST_EXECUTION projections are unchanged apart from
 * the additive nullable finding/rework/verification fields.
 */

const DB_PORT = 55442;
const DATA_DIR = '/tmp/asentra-mob-c06-p2-pg';
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
let clientB = '';
let buildingA1 = '';
let buildingA1Code = '';
let buildingA1Name = '';
let buildingA2 = '';

// Existing-kind parents (regression).
let formInstanceA = '';
let formTemplateA = '';
let checklistExecutionA = '';
let checklistTemplateA = '';

// Finding parents + their evidence ids.
let findingA1 = '';
let findingA1Number = '';
let findingA2 = '';
let findingB = '';
let evidenceFindingA1 = '';
let evidenceFindingA2 = '';
let evidenceForm = '';
let evidenceChecklist = '';

// Rework / verification parents + evidence ids.
let cycleRequested = '';
let findingOfCycle = '';
let findingOfCycleNumber = '';
let reviewPending = '';
let findingOfReview = '';
let findingOfReviewNumber = '';
let evidenceRework = '';
let evidenceVerification = '';

// Broken/redirect fixtures (evidence rows referencing unusable parents).
let evidenceBrokenFinding = '';
let evidenceBrokenRework = '';
let evidenceBrokenVerification = '';
let evidenceFindingToReworkId = '';
let evidenceReworkToReviewId = '';
let evidenceVerificationToNonFindingReview = '';

// Scoped sessions.
let readerA1Token = ''; // evidence.read only, building A1 only
let manageOnlyToken = ''; // evidence.manage (NO evidence.read), building A1

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
  codes: readonly { code: string; name: string }[],
): Promise<{ token: string; userId: string }> {
  const password = 'C06P2ScopedPass123';
  const user = await userService.createUser({
    email: `c06p2-${suffix().toLowerCase()}@example.com`,
    displayName: 'C06 P2 Scoped User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `C06P2_${suffix()}`,
    name: 'C06 P2 Scoped Role',
  });
  for (const permission of codes) {
    let record = await permissionRepository.findByCode(permission.code);
    if (!record) {
      record = await permissionService.createPermission({
        code: permission.code,
        name: permission.name,
      });
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

async function uploadEvidence(
  token: string,
  executionType: string,
  executionId: string,
): Promise<{ status: number; body: any }> {
  return api()
    .post('/api/v1/mobile/evidence')
    .set('Authorization', `Bearer ${token}`)
    .field('evidenceType', 'PHOTO')
    .field('executionType', executionType)
    .field('executionId', executionId)
    .attach('file', Buffer.from('c06-p2-evidence-bytes'), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    });
}

/**
 * A evidence_submissions row inserted directly (for parents that cannot be
 * referenced through the upload API: cross-Client, broken, or cross-kind
 * redirect fixtures). file_reference uses the storage-key shape so the read
 * model treats the row as storage-backed.
 */
async function insertEvidenceRow(
  clientId: string,
  executionType: string,
  executionId: string,
): Promise<string> {
  return insertRow('evidence_submissions', {
    client_id: clientId,
    execution_type: executionType,
    execution_id: executionId,
    evidence_type: 'PHOTO',
    file_reference: `evidence/${randomUUID()}`,
    original_file_name: 'photo.jpg',
    mime_type: 'image/jpeg',
    file_size: 1024,
    submitted_by_user_id: adminUserId,
  });
}

/**
 * Creates a Finding in the given client/building and drives it to
 * PENDING_REVIEW through the real workflow (workforce assignee + state
 * transitions).
 */
async function reviewableFinding(
  clientId: string,
  buildingId: string,
): Promise<string> {
  const worker = await createAdminUser();
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId,
  });

  const organization = await organizationService.createOrganization({
    clientId,
    code: `O_${suffix()}`,
    name: 'C06 P2 Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'C06 P2 Department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'C06 P2 Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'C06 P2 Responsible Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId,
  });

  const finding = await findingService.createFinding({
    clientId,
    buildingId,
    findingNumber: `FND_${suffix()}`,
    title: 'C06 P2 evidence finding',
    reportedByUserId: adminUserId,
  });

  const assignment = await api()
    .post(`/api/v1/findings/${finding.id}/assignments`)
    .set(auth())
    .send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.body));

  for (const state of ['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW']) {
    const actorToken = state === 'ASSIGNED' ? adminToken : worker.token;
    const response = await api()
      .patch(`/api/v1/findings/${finding.id}/state`)
      .set(auth(actorToken))
      .send({ state });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  return finding.id;
}

async function openReview(findingId: string): Promise<string> {
  const review = await api()
    .post(`/api/v1/findings/${findingId}/reviews`)
    .set(auth())
    .send({ notes: 'C06 P2 review opened' });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  return review.body.data.id as string;
}

async function requestRework(findingId: string): Promise<string> {
  const rework = await api()
    .post(`/api/v1/findings/${findingId}/rework`)
    .set(auth())
    .send({ reason: 'C06 P2 rework required' });
  assert.equal(rework.status, 201, JSON.stringify(rework.body));
  return rework.body.data.rework.id as string;
}

function getEvidence(token: string, evidenceId: string) {
  return api()
    .get(`/api/v1/mobile/evidence/${evidenceId}`)
    .set('Authorization', `Bearer ${token}`);
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
      checklist_templates, checklist_executions, evidence_requirements,
      evidence_submissions, generated_tasks, schedule_definitions,
      organizations, departments, positions, workforce_profiles,
      workforce_building_assignments, findings, finding_assignments,
      finding_rework_cycles, reviews, operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  // --- Hierarchy: client A (A1 + A2), client B (B1) -------------------------
  const a = await clientService.createClient({
    code: `CLI_C06P2A_${suffix()}`,
    name: 'C06 P2 Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_C06P2A_${suffix()}`,
    name: 'C06 P2 Property A',
  });
  const bldA1 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_C06P2A1_${suffix()}`,
    name: 'C06 P2 Building A1',
  });
  const bldA2 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_C06P2A2_${suffix()}`,
    name: 'C06 P2 Building A2',
  });
  clientA = a.id;
  buildingA1 = bldA1.id;
  buildingA1Code = bldA1.code;
  buildingA1Name = bldA1.name;
  buildingA2 = bldA2.id;

  const b = await clientService.createClient({
    code: `CLI_C06P2B_${suffix()}`,
    name: 'C06 P2 Client B',
  });
  const propB = await propertyService.createProperty({
    clientId: b.id,
    code: `PROP_C06P2B_${suffix()}`,
    name: 'C06 P2 Property B',
  });
  const bldB1 = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_C06P2B1_${suffix()}`,
    name: 'C06 P2 Building B1',
  });
  clientB = b.id;
  void bldB1;

  // Admin can access A1 + A2 (setup actor), not client B.
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA2,
  });

  // --- Scoped sessions -----------------------------------------------------
  const readerA1 = await scopedSession([
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);
  readerA1Token = readerA1.token;
  await buildingAssignmentService.createAssignment(readerA1.userId, {
    buildingId: buildingA1,
  });

  const manageOnly = await scopedSession([
    { code: 'evidence.manage', name: 'Manage Evidence' },
  ]);
  manageOnlyToken = manageOnly.token;
  await buildingAssignmentService.createAssignment(manageOnly.userId, {
    buildingId: buildingA1,
  });

  // --- Existing-kind parents + evidence ------------------------------------
  const sourceForm = await insertRow('source_forms', {
    client_id: clientA,
    code: `SF_C06P2_${suffix()}`,
    name: 'C06 P2 Source Form',
    source_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  formTemplateA = await insertRow('form_templates', {
    source_form_id: sourceForm,
    client_id: clientA,
    code: `FT_C06P2_${suffix()}`,
    name: 'C06 P2 Form Template',
    status: 'ACTIVE',
  });
  const formVersion = await insertRow('form_template_versions', {
    form_template_id: formTemplateA,
    version_number: 1,
    status: 'PUBLISHED',
    published_at: new Date(),
  });
  formInstanceA = await insertRow('form_instances', {
    client_id: clientA,
    form_template_version_id: formVersion,
    status: 'DRAFT',
  });

  checklistTemplateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_C06P2_${suffix()}`,
    name: 'C06 P2 Checklist Template',
    status: 'ACTIVE',
  });
  checklistExecutionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: checklistTemplateA,
    status: 'DRAFT',
  });

  const formUpload = await uploadEvidence(adminToken, 'FORM_INSTANCE', formInstanceA);
  assert.equal(formUpload.status, 201, JSON.stringify(formUpload.body));
  evidenceForm = formUpload.body.data.id;

  const checklistUpload = await uploadEvidence(
    adminToken,
    'CHECKLIST_EXECUTION',
    checklistExecutionA,
  );
  assert.equal(checklistUpload.status, 201, JSON.stringify(checklistUpload.body));
  evidenceChecklist = checklistUpload.body.data.id;

  // --- Finding parents + evidence -------------------------------------------
  const plainA1 = await findingService.createFinding({
    clientId: clientA,
    buildingId: buildingA1,
    findingNumber: `FND_${suffix()}`,
    title: 'C06 P2 plain finding (A1)',
    reportedByUserId: adminUserId,
  });
  findingA1 = plainA1.id;
  findingA1Number = plainA1.findingNumber;

  const plainA2 = await findingService.createFinding({
    clientId: clientA,
    buildingId: buildingA2,
    findingNumber: `FND_${suffix()}`,
    title: 'C06 P2 plain finding (A2)',
    reportedByUserId: adminUserId,
  });
  findingA2 = plainA2.id;

  // Cross-Client Finding (client B) — the evidence row is inserted directly
  // because the uploading admin has no access to client B.
  findingB = (
    await findingService.createFinding({
      clientId: clientB,
      buildingId: bldB1.id,
      findingNumber: `FND_${suffix()}`,
      title: 'C06 P2 plain finding (B1)',
      reportedByUserId: adminUserId,
    })
  ).id;

  const findingUpload = await uploadEvidence(adminToken, 'FINDING', findingA1);
  assert.equal(findingUpload.status, 201, JSON.stringify(findingUpload.body));
  evidenceFindingA1 = findingUpload.body.data.id;

  const findingA2Upload = await uploadEvidence(adminToken, 'FINDING', findingA2);
  assert.equal(findingA2Upload.status, 201, JSON.stringify(findingA2Upload.body));
  evidenceFindingA2 = findingA2Upload.body.data.id;

  // --- Rework / verification parents + evidence ------------------------------
  findingOfCycle = await reviewableFinding(clientA, buildingA1);
  findingOfCycleNumber = (
    await q('SELECT finding_number FROM findings WHERE id = $1', [findingOfCycle])
  ).rows[0].finding_number as string;
  await openReview(findingOfCycle);
  cycleRequested = await requestRework(findingOfCycle);

  findingOfReview = await reviewableFinding(clientA, buildingA1);
  findingOfReviewNumber = (
    await q('SELECT finding_number FROM findings WHERE id = $1', [findingOfReview])
  ).rows[0].finding_number as string;
  reviewPending = await openReview(findingOfReview);

  const reworkUpload = await uploadEvidence(
    adminToken,
    'FINDING_REWORK',
    cycleRequested,
  );
  assert.equal(reworkUpload.status, 201, JSON.stringify(reworkUpload.body));
  evidenceRework = reworkUpload.body.data.id;

  const verificationUpload = await uploadEvidence(
    adminToken,
    'FINDING_VERIFICATION',
    reviewPending,
  );
  assert.equal(verificationUpload.status, 201, JSON.stringify(verificationUpload.body));
  evidenceVerification = verificationUpload.body.data.id;

  // --- Broken / redirect fixtures (direct rows) -------------------------------
  evidenceBrokenFinding = await insertEvidenceRow(clientA, 'FINDING', randomUUID());
  evidenceBrokenRework = await insertEvidenceRow(
    clientA,
    'FINDING_REWORK',
    randomUUID(),
  );
  evidenceBrokenVerification = await insertEvidenceRow(
    clientA,
    'FINDING_VERIFICATION',
    randomUUID(),
  );

  // Cross-kind redirects: a rework cycle id used as a FINDING parent and a
  // review id used as a FINDING_REWORK parent must not resolve.
  evidenceFindingToReworkId = await insertEvidenceRow(
    clientA,
    'FINDING',
    cycleRequested,
  );
  evidenceReworkToReviewId = await insertEvidenceRow(
    clientA,
    'FINDING_REWORK',
    reviewPending,
  );

  // A review that targets a CHECKLIST_EXECUTION (not a Finding) must not be
  // usable as a FINDING_VERIFICATION parent.
  const nonFindingReview = await insertRow('reviews', {
    client_id: clientA,
    target_type: 'CHECKLIST_EXECUTION',
    target_id: checklistExecutionA,
    reviewer_user_id: adminUserId,
    status: 'PENDING',
  });
  evidenceVerificationToNonFindingReview = await insertEvidenceRow(
    clientA,
    'FINDING_VERIFICATION',
    nonFindingReview,
  );
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
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

describe('MOB-C06 PART 02 — FINDING evidence read model', () => {
  it('returns the finding reference for FINDING evidence', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceFindingA1);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.target.executionType, 'FINDING');
    assert.equal(data.target.executionId, findingA1);
    assert.deepEqual(data.target.finding, {
      id: findingA1,
      findingNumber: findingA1Number,
      title: 'C06 P2 plain finding (A1)',
      status: 'OPEN',
    });
    assert.equal(data.target.rework, null);
    assert.equal(data.target.verification, null);
    assert.equal(data.target.checklist, null);
    assert.equal(data.target.form, null);
    assert.equal(data.target.task, null);
  });

  it('returns the authoritative Building of the Finding', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceFindingA1);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.building, {
      id: buildingA1,
      code: buildingA1Code,
      name: buildingA1Name,
    });
  });

  it('also enriches the upload response (shared contract)', async (t) => {
    if (!ready(t)) return;
    const upload = await uploadEvidence(adminToken, 'FINDING', findingA1);
    assert.equal(upload.status, 201);
    assert.equal(upload.body.data.target.finding.id, findingA1);
    assert.equal(upload.body.data.building.id, buildingA1);
  });
});

describe('MOB-C06 PART 02 — FINDING_REWORK evidence read model', () => {
  it('returns finding + rework references', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceRework);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.target.executionType, 'FINDING_REWORK');
    assert.equal(data.target.executionId, cycleRequested);
    assert.deepEqual(data.target.finding, {
      id: findingOfCycle,
      findingNumber: findingOfCycleNumber,
      title: 'C06 P2 evidence finding',
      status: 'REWORK_REQUIRED',
    });
    assert.deepEqual(data.target.rework, {
      id: cycleRequested,
      status: 'REQUESTED',
    });
    assert.equal(data.target.verification, null);
    assert.equal(data.target.checklist, null);
    assert.equal(data.target.form, null);
    assert.equal(data.target.task, null);
  });

  it('derives the Building from the parent Finding', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceRework);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.building, {
      id: buildingA1,
      code: buildingA1Code,
      name: buildingA1Name,
    });
  });
});

describe('MOB-C06 PART 02 — FINDING_VERIFICATION evidence read model', () => {
  it('returns finding + verification references', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceVerification);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.target.executionType, 'FINDING_VERIFICATION');
    assert.equal(data.target.executionId, reviewPending);
    assert.deepEqual(data.target.finding, {
      id: findingOfReview,
      findingNumber: findingOfReviewNumber,
      title: 'C06 P2 evidence finding',
      status: 'PENDING_REVIEW',
    });
    assert.deepEqual(data.target.verification, {
      id: reviewPending,
      status: 'PENDING',
    });
    assert.equal(data.target.rework, null);
    assert.equal(data.target.checklist, null);
    assert.equal(data.target.form, null);
    assert.equal(data.target.task, null);
  });

  it('derives the Building from the parent Finding', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceVerification);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.building, {
      id: buildingA1,
      code: buildingA1Code,
      name: buildingA1Name,
    });
  });
});

describe('MOB-C06 PART 02 — existing kinds preserved', () => {
  it('FORM_INSTANCE shape is preserved with null Finding fields', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceForm);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.target.executionType, 'FORM_INSTANCE');
    assert.equal(data.target.executionId, formInstanceA);
    assert.deepEqual(data.target.form, {
      id: formTemplateA,
      code: data.target.form.code,
      name: 'C06 P2 Form Template',
    });
    assert.equal(data.target.checklist, null);
    assert.equal(data.target.task, null);
    assert.equal(data.target.finding, null);
    assert.equal(data.target.rework, null);
    assert.equal(data.target.verification, null);
    assert.equal(data.building, null);
  });

  it('CHECKLIST_EXECUTION shape is preserved with null Finding fields', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceChecklist);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.target.executionType, 'CHECKLIST_EXECUTION');
    assert.equal(data.target.executionId, checklistExecutionA);
    assert.deepEqual(data.target.checklist, {
      id: checklistTemplateA,
      code: data.target.checklist.code,
      name: 'C06 P2 Checklist Template',
    });
    assert.equal(data.target.form, null);
    assert.equal(data.target.finding, null);
    assert.equal(data.target.rework, null);
    assert.equal(data.target.verification, null);
  });
});

describe('MOB-C06 PART 02 — scope and authority', () => {
  it('rejects a same-Client Finding in an inaccessible Building (403)', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceFindingA2);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects a cross-Client evidence row (403)', async (t) => {
    if (!ready(t)) return;
    // The evidence row belongs to client B; readerA1 only reaches client A.
    const crossClientEvidence = await insertEvidenceRow(
      clientB,
      'FINDING',
      findingB,
    );
    const response = await getEvidence(readerA1Token, crossClientEvidence);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('fails closed on a missing Finding parent (404, no partial context)', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceBrokenFinding);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assert.equal(response.body.error.message, 'Evidence parent not found.');
  });

  it('fails closed on a missing rework parent (404)', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceBrokenRework);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  it('fails closed on a missing verification parent (404)', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(readerA1Token, evidenceBrokenVerification);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  it('rejects a review whose target is not a Finding (404)', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(
      readerA1Token,
      evidenceVerificationToNonFindingReview,
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });

  it('cannot redirect parent context across kinds (404)', async (t) => {
    if (!ready(t)) return;
    // A rework cycle id submitted as a FINDING parent does not resolve.
    const asFinding = await getEvidence(readerA1Token, evidenceFindingToReworkId);
    assert.equal(asFinding.status, 404);
    assert.equal(asFinding.body.error.code, 'NOT_FOUND');

    // A review id submitted as a FINDING_REWORK parent does not resolve.
    const asRework = await getEvidence(readerA1Token, evidenceReworkToReviewId);
    assert.equal(asRework.status, 404);
    assert.equal(asRework.body.error.code, 'NOT_FOUND');
  });

  it('evidence.read alone is sufficient for an accessible parent', async (t) => {
    if (!ready(t)) return;
    // readerA1 holds ONLY evidence.read (no evidence.manage / finding.*).
    const response = await getEvidence(readerA1Token, evidenceFindingA1);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.target.finding.id, findingA1);
  });

  it('evidence.manage without evidence.read does NOT bypass GET authority', async (t) => {
    if (!ready(t)) return;
    const response = await getEvidence(manageOnlyToken, evidenceFindingA1);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});
