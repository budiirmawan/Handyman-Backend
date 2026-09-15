import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C06 PART 01 — Mobile Finding evidence upload (focused security tests).
 *
 * Extends `POST /mobile/evidence` with the Finding evidence parents
 * (FINDING / FINDING_REWORK / FINDING_VERIFICATION) while preserving the
 * existing FORM_INSTANCE / CHECKLIST_EXECUTION behavior:
 *
 *   - per-kind EXACT upload permission (evidence.manage vs finding.review),
 *   - parent resolution ONLY from executionType + executionId through the
 *     shared evidence execution loader (Building/Client scope derived from
 *     the parent Finding, never from the request),
 *   - generic parent-state gates (rework cycle REQUESTED-only, verification
 *     review PENDING-only, terminal parents rejected),
 *   - generic-route parity for FINDING_VERIFICATION evidence,
 *   - storage/integrity pipeline unchanged, existing upload contract
 *     backward compatible.
 */

const DB_PORT = 55442;
const DATA_DIR = '/tmp/asentra-mob-c06-p1-pg';
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

// Hierarchy: client A (buildings A1 + A2), client B (building B1).
let clientA = '';
let clientB = '';
let buildingA1 = '';
let buildingA2 = '';
let buildingB1 = '';

// Existing-kind parents (regression).
let formInstanceA = '';
let formTemplateA = '';
let checklistExecutionA = '';
let checklistTemplateA = '';

// Finding parents.
let findingA = ''; // client A, building A1, OPEN
let findingA2 = ''; // client A, building A2 (cross-Building, same Client)
let findingB = ''; // client B, building B1 (cross-Client)
let findingCancelled = ''; // client A, building A1, CANCELLED
let requirementClientB = ''; // PHOTO requirement owned by client B

// Rework / verification parents.
let cycleRequested = ''; // REQUESTED rework cycle, finding in building A1
let cycleResubmitted = ''; // RESUBMITTED rework cycle, finding in building A1
let cycleA2 = ''; // REQUESTED rework cycle, finding in building A2
let reviewPending = ''; // PENDING review (opened by admin), finding in A1
let reviewScoped = ''; // PENDING review (opened by the finding.review user)
let reviewCompleted = ''; // COMPLETED review, finding in building A1
let reviewA2 = ''; // PENDING review, finding in building A2

/** review id → owning finding id (test-support lookup for generic parity). */
const reviewFindingById = new Map<string, string>();

// Scoped sessions.
let evidenceOnlyToken = ''; // evidence.manage, building A1 only
let reviewOnlyToken = ''; // finding.review (+ finding.read), building A1 only
let plainToken = ''; // no permissions

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
  const password = 'C06ScopedPass123';
  const user = await userService.createUser({
    email: `c06-${suffix().toLowerCase()}@example.com`,
    displayName: 'C06 Scoped User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `C06_${suffix()}`,
    name: 'C06 Scoped Role',
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

function uploadEvidence(
  token: string,
  executionType: string,
  executionId: string,
  options: {
    evidenceType?: string;
    mimeType?: string;
    requirementId?: string;
    extraFields?: Record<string, string>;
    withFile?: boolean;
  } = {},
) {
  let request = api()
    .post('/api/v1/mobile/evidence')
    .set('Authorization', `Bearer ${token}`)
    .field('evidenceType', options.evidenceType ?? 'PHOTO')
    .field('executionType', executionType)
    .field('executionId', executionId);
  if (options.requirementId) {
    request = request.field('evidenceRequirementId', options.requirementId);
  }
  for (const [name, value] of Object.entries(options.extraFields ?? {})) {
    request = request.field(name, value);
  }
  if (options.withFile !== false) {
    request = request.attach(
      'file',
      Buffer.from('c06-finding-evidence-bytes'),
      { filename: 'photo.jpg', contentType: options.mimeType ?? 'image/jpeg' },
    );
  }
  return request;
}

/**
 * Creates a Finding in the given client/building and drives it to
 * PENDING_REVIEW through the real workflow (workforce assignee + state
 * transitions), mirroring the BE-09G/BE-09F test setup.
 */
async function reviewableFinding(
  clientId: string,
  buildingId: string,
): Promise<{ findingId: string; workerToken: string }> {
  const worker = await createAdminUser();
  await buildingAssignmentService.createAssignment(worker.userId, {
    buildingId,
  });

  const organization = await organizationService.createOrganization({
    clientId,
    code: `O_${suffix()}`,
    name: 'C06 Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'C06 Department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'C06 Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'C06 Responsible Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId,
  });

  const finding = await findingService.createFinding({
    clientId,
    buildingId,
    findingNumber: `FND_${suffix()}`,
    title: 'C06 evidence finding',
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
  return { findingId: finding.id, workerToken: worker.token };
}

async function openReview(findingId: string, token = adminToken): Promise<string> {
  const review = await api()
    .post(`/api/v1/findings/${findingId}/reviews`)
    .set(auth(token))
    .send({ notes: 'C06 review opened' });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.equal(review.body.data.status, 'PENDING');
  const reviewId = review.body.data.id as string;
  reviewFindingById.set(reviewId, findingId);
  return reviewId;
}

async function requestRework(findingId: string, token = adminToken): Promise<string> {
  const rework = await api()
    .post(`/api/v1/findings/${findingId}/rework`)
    .set(auth(token))
    .send({ reason: 'C06 rework required' });
  assert.equal(rework.status, 201, JSON.stringify(rework.body));
  assert.equal(rework.body.data.rework.status, 'REQUESTED');
  return rework.body.data.rework.id as string;
}

async function cancelFinding(findingId: string): Promise<void> {
  const response = await api()
    .patch(`/api/v1/findings/${findingId}/state`)
    .set(auth())
    .send({ state: 'CANCELLED' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
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

  // --- Hierarchy -----------------------------------------------------------
  const a = await clientService.createClient({
    code: `CLI_C06A_${suffix()}`,
    name: 'C06 Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_C06A_${suffix()}`,
    name: 'C06 Property A',
  });
  const bldA1 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_C06A1_${suffix()}`,
    name: 'C06 Building A1',
  });
  const bldA2 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_C06A2_${suffix()}`,
    name: 'C06 Building A2',
  });
  clientA = a.id;
  buildingA1 = bldA1.id;
  buildingA2 = bldA2.id;

  const b = await clientService.createClient({
    code: `CLI_C06B_${suffix()}`,
    name: 'C06 Client B',
  });
  const propB = await propertyService.createProperty({
    clientId: b.id,
    code: `PROP_C06B_${suffix()}`,
    name: 'C06 Property B',
  });
  const bldB1 = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_C06B1_${suffix()}`,
    name: 'C06 Building B1',
  });
  clientB = b.id;
  buildingB1 = bldB1.id;

  // Admin can access A1 + A2 (setup actor), but NOT building B1.
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1,
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA2,
  });

  // --- Scoped sessions -----------------------------------------------------
  const evidenceOnly = await scopedSession([
    { code: 'evidence.manage', name: 'Manage Evidence' },
  ]);
  evidenceOnlyToken = evidenceOnly.token;
  await buildingAssignmentService.createAssignment(evidenceOnly.userId, {
    buildingId: buildingA1,
  });

  const reviewOnly = await scopedSession([
    { code: 'finding.read', name: 'Read Findings' },
    { code: 'finding.review', name: 'Review Findings' },
  ]);
  reviewOnlyToken = reviewOnly.token;
  await buildingAssignmentService.createAssignment(reviewOnly.userId, {
    buildingId: buildingA1,
  });

  plainToken = await createPlainSession();

  // --- Existing-kind parents (regression) ----------------------------------
  const sourceForm = await insertRow('source_forms', {
    client_id: clientA,
    code: `SF_C06_${suffix()}`,
    name: 'C06 Source Form',
    source_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  formTemplateA = await insertRow('form_templates', {
    source_form_id: sourceForm,
    client_id: clientA,
    code: `FT_C06_${suffix()}`,
    name: 'C06 Form Template',
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
    code: `TPL_C06_${suffix()}`,
    name: 'C06 Checklist Template',
    status: 'ACTIVE',
  });
  checklistExecutionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: checklistTemplateA,
    status: 'DRAFT',
  });

  // --- Finding parents -----------------------------------------------------
  findingA = (
    await findingService.createFinding({
      clientId: clientA,
      buildingId: buildingA1,
      findingNumber: `FND_${suffix()}`,
      title: 'C06 plain finding (A1)',
      reportedByUserId: adminUserId,
    })
  ).id;
  findingA2 = (
    await findingService.createFinding({
      clientId: clientA,
      buildingId: buildingA2,
      findingNumber: `FND_${suffix()}`,
      title: 'C06 plain finding (A2)',
      reportedByUserId: adminUserId,
    })
  ).id;
  findingB = (
    await findingService.createFinding({
      clientId: clientB,
      buildingId: buildingB1,
      findingNumber: `FND_${suffix()}`,
      title: 'C06 plain finding (B1)',
      reportedByUserId: adminUserId,
    })
  ).id;
  const toCancel = await findingService.createFinding({
    clientId: clientA,
    buildingId: buildingA1,
    findingNumber: `FND_${suffix()}`,
    title: 'C06 cancelled finding',
    reportedByUserId: adminUserId,
  });
  await cancelFinding(toCancel.id);
  findingCancelled = toCancel.id;

  // A PHOTO requirement owned by client B (cross-client requirement check).
  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_C06B_${suffix()}`,
    name: 'C06 Checklist Template B',
    status: 'ACTIVE',
  });
  requirementClientB = await insertRow('evidence_requirements', {
    client_id: clientB,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateB,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
    maximum_count: 2,
    description: 'C06 client B photo',
    status: 'ACTIVE',
  });

  // --- Rework / verification parents ---------------------------------------
  // REQUESTED rework cycle in building A1.
  const rfCycle = await reviewableFinding(clientA, buildingA1);
  await openReview(rfCycle.findingId);
  cycleRequested = await requestRework(rfCycle.findingId);

  // RESUBMITTED rework cycle in building A1.
  const rfResubmitted = await reviewableFinding(clientA, buildingA1);
  await openReview(rfResubmitted.findingId);
  const cycleId = await requestRework(rfResubmitted.findingId);
  const resubmit = await api()
    .post(`/api/v1/findings/${rfResubmitted.findingId}/resubmit`)
    .set(auth(rfResubmitted.workerToken))
    .send({ notes: 'C06 rework done' });
  assert.equal(resubmit.status, 200, JSON.stringify(resubmit.body));
  assert.equal(resubmit.body.data.rework.status, 'RESUBMITTED');
  cycleResubmitted = cycleId;

  // REQUESTED rework cycle in building A2 (inaccessible to the A1-only users).
  const rfA2 = await reviewableFinding(clientA, buildingA2);
  await openReview(rfA2.findingId);
  cycleA2 = await requestRework(rfA2.findingId);

  // PENDING review in building A1 (opened by admin).
  const rfPending = await reviewableFinding(clientA, buildingA1);
  reviewPending = await openReview(rfPending.findingId);

  // PENDING review in building A1 opened by the finding.review-only user.
  const rfScoped = await reviewableFinding(clientA, buildingA1);
  reviewScoped = await openReview(rfScoped.findingId, reviewOnlyToken);

  // COMPLETED review in building A1.
  const rfCompleted = await reviewableFinding(clientA, buildingA1);
  await openReview(rfCompleted.findingId);
  const verify = await api()
    .post(`/api/v1/findings/${rfCompleted.findingId}/verification`)
    .set(auth())
    .send({ decision: 'REJECTED', notes: 'C06 completed review' });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
  reviewCompleted = verify.body.data.verification.id as string;

  // PENDING review in building A2 (inaccessible to the A1-only users).
  const rfReviewA2 = await reviewableFinding(clientA, buildingA2);
  reviewA2 = await openReview(rfReviewA2.findingId);
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

async function loadEvidenceRow(evidenceId: string) {
  const result = await q('SELECT * FROM evidence_submissions WHERE id = $1', [
    evidenceId,
  ]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

describe('MOB-C06 PART 01 — existing kinds preserved', () => {
  it('still uploads FORM_INSTANCE evidence with the existing contract', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      adminToken,
      'FORM_INSTANCE',
      formInstanceA,
    );
    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.deepEqual(Object.keys(data).sort(), [
      'building',
      'clientId',
      'createdAt',
      'evidenceRequirement',
      'evidenceType',
      'file',
      'id',
      'status',
      'submittedByUserId',
      'target',
      'updatedAt',
    ]);
    assert.equal(data.clientId, clientA);
    assert.equal(data.target.executionType, 'FORM_INSTANCE');
    assert.equal(data.target.executionId, formInstanceA);
    assert.equal(data.target.form.id, formTemplateA);
    assert.equal(data.target.checklist, null);
    assert.equal(data.file.uploadStatus, 'UPLOADED');
    assert.equal(data.file.fileAvailable, true);
  });

  it('still uploads CHECKLIST_EXECUTION evidence with the existing contract', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      adminToken,
      'CHECKLIST_EXECUTION',
      checklistExecutionA,
    );
    assert.equal(response.status, 201);
    const data = response.body.data;
    assert.equal(data.clientId, clientA);
    assert.equal(data.target.executionType, 'CHECKLIST_EXECUTION');
    assert.equal(data.target.executionId, checklistExecutionA);
    assert.equal(data.target.checklist.id, checklistTemplateA);
    assert.equal(data.evidenceType, 'PHOTO');
    assert.equal(data.status, 'ACTIVE');

    // The existing read model keeps working for existing kinds.
    const read = await api()
      .get(`/api/v1/mobile/evidence/${data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.target.executionType, 'CHECKLIST_EXECUTION');
  });

  it('still requires evidence.manage for the existing kinds (dynamic gate)', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      plainToken,
      'CHECKLIST_EXECUTION',
      checklistExecutionA,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('MOB-C06 PART 01 — FINDING evidence', () => {
  it('uploads evidence for an accessible Finding with evidence.manage', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(adminToken, 'FINDING', findingA);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    // The submission binds to the authoritative Finding's Client.
    assert.equal(data.clientId, clientA);
    assert.equal(data.evidenceType, 'PHOTO');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.submittedByUserId, adminUserId);

    // PART 01 target contract: execution reference, null context projections.
    assert.equal(data.target.executionType, 'FINDING');
    assert.equal(data.target.executionId, findingA);
    assert.equal(data.target.checklist, null);
    assert.equal(data.target.form, null);
    assert.equal(data.target.task, null);

    // Storage + integrity pipeline still produced (test 19).
    assert.equal(data.file.uploadStatus, 'UPLOADED');
    assert.equal(data.file.fileAvailable, true);
    const row = await loadEvidenceRow(data.id);
    assert.equal(row.execution_type, 'FINDING');
    assert.equal(row.execution_id, findingA);
    assert.equal(row.client_id, clientA);
    assert.ok(row.content_sha256, 'content_sha256 must be produced');
    assert.equal(row.hash_algorithm, 'SHA-256');
    assert.ok(
      existsSync(join(STORAGE_DIR, 'evidence', data.id)),
      'file bytes must be stored through the storage abstraction',
    );
  });

  it('rejects a caller without evidence.manage (403 PERMISSION_DENIED)', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(plainToken, 'FINDING', findingA);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('rejects a cross-Building Finding (same Client, no Building access)', async (t) => {
    if (!ready(t)) return;
    // evidenceOnly is assigned to building A1 only; the Finding is in A2.
    const response = await uploadEvidence(
      evidenceOnlyToken,
      'FINDING',
      findingA2,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('rejects a cross-Client Finding and cannot be redirected by request fields', async (t) => {
    if (!ready(t)) return;
    // Client B Finding: not in the caller's accessible Client set at all.
    const denied = await uploadEvidence(
      evidenceOnlyToken,
      'FINDING',
      findingB,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // Hostile extra multipart fields (buildingId/clientId/findingId) are
    // never authoritative: the submission binds to the resolved parent.
    const response = await uploadEvidence(adminToken, 'FINDING', findingA, {
      extraFields: {
        buildingId: buildingB1,
        clientId: clientB,
        findingId: findingB,
        building: 'ignored',
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.clientId, clientA);
    const row = await loadEvidenceRow(data.id);
    assert.equal(row.client_id, clientA);
    assert.equal(row.execution_id, findingA);
  });

  it('rejects an unknown parent and a terminal (CANCELLED) Finding', async (t) => {
    if (!ready(t)) return;
    const unknown = await uploadEvidence(
      adminToken,
      'FINDING',
      randomUUID(),
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'BAD_REQUEST');
    assert.equal(
      unknown.body.error.message,
      'Execution does not exist.',
    );

    const cancelled = await uploadEvidence(
      adminToken,
      'FINDING',
      findingCancelled,
    );
    assert.equal(cancelled.status, 400);
    assert.equal(cancelled.body.error.message, 'Terminal execution cannot receive evidence.');
  });

  it('still validates evidenceRequirementId against the parent Client', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(adminToken, 'FINDING', findingA, {
      requirementId: requirementClientB,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.message, 'Evidence requirement client mismatch.');
  });
});

describe('MOB-C06 PART 01 — FINDING_REWORK evidence', () => {
  it('uploads evidence for a REQUESTED rework cycle with evidence.manage', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      adminToken,
      'FINDING_REWORK',
      cycleRequested,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    // The Client derives through the cycle's own Finding (client A).
    assert.equal(data.clientId, clientA);
    assert.equal(data.target.executionType, 'FINDING_REWORK');
    assert.equal(data.target.executionId, cycleRequested);
    const row = await loadEvidenceRow(data.id);
    assert.equal(row.execution_type, 'FINDING_REWORK');
    assert.equal(row.execution_id, cycleRequested);
    assert.equal(row.client_id, clientA);
  });

  it('rejects a non-REQUESTED (RESUBMITTED) rework cycle', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      adminToken,
      'FINDING_REWORK',
      cycleResubmitted,
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.message,
      'Rework cycle cannot receive evidence in its current state.',
    );
  });

  it('rejects a rework cycle whose Finding is in an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      evidenceOnlyToken,
      'FINDING_REWORK',
      cycleA2,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('cannot redirect the Finding/rework relationship', async (t) => {
    if (!ready(t)) return;
    // A verification review id does not resolve as a rework cycle parent.
    const mismatch = await uploadEvidence(
      adminToken,
      'FINDING_REWORK',
      reviewPending,
    );
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.message, 'Execution does not exist.');

    // Hostile findingId fields never redirect the binding.
    const response = await uploadEvidence(
      adminToken,
      'FINDING_REWORK',
      cycleRequested,
      { extraFields: { findingId: findingB } },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const row = await loadEvidenceRow(response.body.data.id);
    assert.equal(row.execution_id, cycleRequested);
    assert.equal(row.client_id, clientA);
  });
});

describe('MOB-C06 PART 01 — FINDING_VERIFICATION evidence', () => {
  it('uploads evidence for a PENDING review with finding.review', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      adminToken,
      'FINDING_VERIFICATION',
      reviewPending,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.clientId, clientA);
    assert.equal(data.target.executionType, 'FINDING_VERIFICATION');
    assert.equal(data.target.executionId, reviewPending);
    const row = await loadEvidenceRow(data.id);
    assert.equal(row.execution_type, 'FINDING_VERIFICATION');
    assert.equal(row.execution_id, reviewPending);
  });

  it('does NOT grant verification upload through evidence.manage alone', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      evidenceOnlyToken,
      'FINDING_VERIFICATION',
      reviewScoped,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('succeeds with finding.review and WITHOUT evidence.manage (generic parity)', async (t) => {
    if (!ready(t)) return;
    // The generic verification-evidence endpoint accepts this reviewer.
    const generic = await api()
      .post(`/api/v1/findings/${findingOfReview(reviewScoped)}/verification/${reviewScoped}/evidence`)
      .set(auth(reviewOnlyToken))
      .send({
        evidenceType: 'PHOTO',
        fileReference: `evidence/${randomUUID()}`,
        originalFileName: 'generic.jpg',
        mimeType: 'image/jpeg',
        fileSize: 12,
      });
    assert.equal(generic.status, 201, JSON.stringify(generic.body));

    // The mobile single-call upload accepts the SAME reviewer (no
    // evidence.manage requirement beyond the generic authority).
    const mobile = await uploadEvidence(
      reviewOnlyToken,
      'FINDING_VERIFICATION',
      reviewScoped,
    );
    assert.equal(mobile.status, 201, JSON.stringify(mobile.body));
    assert.ok(mobile.body.data.submittedByUserId);
  });

  it('rejects a non-PENDING (COMPLETED) verification review', async (t) => {
    if (!ready(t)) return;
    const response = await uploadEvidence(
      adminToken,
      'FINDING_VERIFICATION',
      reviewCompleted,
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.message,
      'Verification cannot receive evidence in its current state.',
    );
  });

  it('rejects a review whose Finding is in an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    // reviewOnly holds finding.review (so the exact permission gate passes)
    // but is assigned to building A1 only; the review's Finding is in A2 —
    // the scope rejection comes from the parent resolution, not permissions.
    const response = await uploadEvidence(
      reviewOnlyToken,
      'FINDING_VERIFICATION',
      reviewA2,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('keeps the generic route authority consistent (finding.review required)', async (t) => {
    if (!ready(t)) return;
    // The generic endpoint rejects the evidence.manage-only caller.
    const generic = await api()
      .post(`/api/v1/findings/${findingOfReview(reviewPending)}/verification/${reviewPending}/evidence`)
      .set(auth(evidenceOnlyToken))
      .send({
        evidenceType: 'PHOTO',
        fileReference: `evidence/${randomUUID()}`,
        originalFileName: 'generic.jpg',
        mimeType: 'image/jpeg',
        fileSize: 12,
      });
    assert.equal(generic.status, 403);
    assert.equal(generic.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('MOB-C06 PART 01 — general contract', () => {
  it('rejects an unsupported executionType', async (t) => {
    if (!ready(t)) return;
    for (const executionType of ['WORK_ORDER', 'PATROL_EXECUTION', 'finding']) {
      const response = await uploadEvidence(
        adminToken,
        executionType,
        findingA,
      );
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(
        response.body.error.details.some(
          (detail: { field: string }) => detail.field === 'executionType',
        ),
      );
    }
  });

  it('keeps the mobile read model working for Finding evidence (PART 01 shape)', async (t) => {
    if (!ready(t)) return;
    const upload = await uploadEvidence(adminToken, 'FINDING', findingA);
    assert.equal(upload.status, 201);
    const read = await api()
      .get(`/api/v1/mobile/evidence/${upload.body.data.id}`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.target.executionType, 'FINDING');
    assert.equal(read.body.data.target.executionId, findingA);
    assert.equal(read.body.data.file.fileAvailable, true);
  });
});

/** Resolves the Finding a review belongs to (test-support lookup). */
function findingOfReview(reviewId: string): string {
  const findingId = reviewFindingById.get(reviewId);
  assert.ok(findingId, 'review→finding mapping must exist for the parity test');
  return findingId;
}
