import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
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
 * MOB-C06 PART 01A — Verification evidence permission parity (focused tests).
 *
 * Aligns the FINDING_VERIFICATION evidence permission across the
 * generic/shared metadata endpoint (POST /evidence) and the offline
 * EVIDENCE_SUBMISSION sync kind with the dedicated Finding verification
 * evidence route and the MOB-C06 PART 01 mobile upload:
 *
 *   - FINDING_VERIFICATION → finding.review (alone is sufficient),
 *   - FINDING / FINDING_REWORK / FORM_INSTANCE / CHECKLIST_EXECUTION →
 *     evidence.manage (preserved),
 *   - no reviewer-identity rule, no lifecycle/state/scope change.
 *
 * Layer 1 — generic POST /evidence: per-type permission, unsupported
 * executionType fails closed, scope + terminal-state checks unchanged.
 * Layer 2 — offline POST /mobile/sync EVIDENCE_SUBMISSION: per-type derived
 * permission, replay/idempotency unchanged, parent scope/state still
 * enforced, metadata-only.
 */

const DB_PORT = 55442;
const DATA_DIR = '/tmp/asentra-mob-c01a-pg';
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
let buildingA1 = '';
let buildingA2 = '';

// Existing-kind parents (regression).
let formInstanceA = '';
let checklistExecutionA = '';

// Finding parents.
let findingA1 = '';
let findingA2 = '';

// Rework / verification parents.
let cycleRequested = ''; // REQUESTED rework cycle, finding in building A1
let reviewPendingGeneric = ''; // PENDING review in A1 (generic-layer tests)
let reviewPendingSync = ''; // PENDING review in A1 (offline-layer tests)
let reviewCompleted = ''; // COMPLETED review in A1
let reviewA2 = ''; // PENDING review in A2 (inaccessible to A1-only users)

// Scoped sessions.
let evidenceOnlyToken = ''; // evidence.manage, building A1 only
let evidenceOnlyUserId = '';
let reviewOnlyToken = ''; // finding.read + finding.review, building A1 only
let reviewOnlyUserId = '';
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
  const password = 'C01AScopedPass123';
  const user = await userService.createUser({
    email: `c01a-${suffix().toLowerCase()}@example.com`,
    displayName: 'C01A Scoped User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `C01A_${suffix()}`,
    name: 'C01A Scoped Role',
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

/** Generic metadata evidence body (POST /evidence contract). */
function evidenceBody(executionType: string, executionId: string) {
  return {
    evidenceType: 'PHOTO',
    executionType,
    executionId,
    fileReference: `evidence/${randomUUID()}`,
    originalFileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1024,
  };
}

function postEvidence(token: string, executionType: string, executionId: string) {
  return api()
    .post('/api/v1/evidence')
    .set('Authorization', `Bearer ${token}`)
    .send(evidenceBody(executionType, executionId));
}

/** One offline EVIDENCE_SUBMISSION sync operation (metadata only). */
function evidenceSyncOperation(
  operationId: string,
  executionType: string,
  executionId: string,
) {
  return {
    operationId,
    resourceType: 'EVIDENCE_SUBMISSION',
    resourceId: executionId,
    operation: 'SUBMIT',
    clientTimestamp: new Date().toISOString(),
    data: evidenceBody(executionType, executionId),
  };
}

function syncBatch(token: string, operations: unknown[]) {
  return api()
    .post('/api/v1/mobile/sync')
    .set('Authorization', `Bearer ${token}`)
    .send({ operations });
}

/**
 * Creates a Finding in the given client/building and drives it to
 * PENDING_REVIEW through the real workflow (workforce assignee + state
 * transitions), mirroring the BE-09F/BE-09G test setup.
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
    name: 'C01A Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'C01A Department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'C01A Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'C01A Responsible Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId,
  });

  const finding = await findingService.createFinding({
    clientId,
    buildingId,
    findingNumber: `FND_${suffix()}`,
    title: 'C01A parity finding',
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
    .send({ notes: 'C01A review opened' });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.equal(review.body.data.status, 'PENDING');
  return review.body.data.id as string;
}

async function requestRework(findingId: string, token = adminToken): Promise<string> {
  const rework = await api()
    .post(`/api/v1/findings/${findingId}/rework`)
    .set(auth(token))
    .send({ reason: 'C01A rework required' });
  assert.equal(rework.status, 201, JSON.stringify(rework.body));
  assert.equal(rework.body.data.rework.status, 'REQUESTED');
  return rework.body.data.rework.id as string;
}

async function completeReview(
  findingId: string,
  reviewId: string,
): Promise<void> {
  const verify = await api()
    .post(`/api/v1/findings/${findingId}/verification`)
    .set(auth())
    .send({ decision: 'REJECTED', notes: 'C01A completed review' });
  assert.equal(verify.status, 201, JSON.stringify(verify.body));
  assert.equal(verify.body.data.verification.id, reviewId);
  assert.equal(verify.body.data.verification.status, 'COMPLETED');
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

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, source_forms, form_templates,
      checklist_templates, checklist_executions, evidence_requirements,
      evidence_submissions, generated_tasks, schedule_definitions,
      organizations, departments, positions, workforce_profiles,
      workforce_building_assignments, findings, finding_assignments,
      finding_rework_cycles, reviews, operational_events,
      mobile_sync_idempotency
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  // --- Hierarchy: client A with buildings A1 + A2 --------------------------
  const a = await clientService.createClient({
    code: `CLI_C01A_${suffix()}`,
    name: 'C01A Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_C01A_${suffix()}`,
    name: 'C01A Property A',
  });
  const bldA1 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_C01A1_${suffix()}`,
    name: 'C01A Building A1',
  });
  const bldA2 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_C01A2_${suffix()}`,
    name: 'C01A Building A2',
  });
  clientA = a.id;
  buildingA1 = bldA1.id;
  buildingA2 = bldA2.id;

  // Admin can access A1 + A2 (setup actor).
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
  evidenceOnlyUserId = evidenceOnly.userId;
  await buildingAssignmentService.createAssignment(evidenceOnly.userId, {
    buildingId: buildingA1,
  });

  const reviewOnly = await scopedSession([
    { code: 'finding.read', name: 'Read Findings' },
    { code: 'finding.review', name: 'Review Findings' },
  ]);
  reviewOnlyToken = reviewOnly.token;
  reviewOnlyUserId = reviewOnly.userId;
  await buildingAssignmentService.createAssignment(reviewOnly.userId, {
    buildingId: buildingA1,
  });

  plainToken = await createPlainSession();

  // --- Existing-kind parents (regression) ----------------------------------
  const sourceForm = await insertRow('source_forms', {
    client_id: clientA,
    code: `SF_C01A_${suffix()}`,
    name: 'C01A Source Form',
    source_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  const formTemplate = await insertRow('form_templates', {
    source_form_id: sourceForm,
    client_id: clientA,
    code: `FT_C01A_${suffix()}`,
    name: 'C01A Form Template',
    status: 'ACTIVE',
  });
  const formVersion = await insertRow('form_template_versions', {
    form_template_id: formTemplate,
    version_number: 1,
    status: 'PUBLISHED',
    published_at: new Date(),
  });
  formInstanceA = await insertRow('form_instances', {
    client_id: clientA,
    form_template_version_id: formVersion,
    status: 'DRAFT',
  });

  const checklistTemplate = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_C01A_${suffix()}`,
    name: 'C01A Checklist Template',
    status: 'ACTIVE',
  });
  checklistExecutionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: checklistTemplate,
    status: 'DRAFT',
  });

  // --- Finding parents -----------------------------------------------------
  findingA1 = (
    await findingService.createFinding({
      clientId: clientA,
      buildingId: buildingA1,
      findingNumber: `FND_${suffix()}`,
      title: 'C01A finding (A1)',
      reportedByUserId: adminUserId,
    })
  ).id;
  findingA2 = (
    await findingService.createFinding({
      clientId: clientA,
      buildingId: buildingA2,
      findingNumber: `FND_${suffix()}`,
      title: 'C01A finding (A2)',
      reportedByUserId: adminUserId,
    })
  ).id;

  // --- Rework / verification parents ---------------------------------------
  const rfCycle = await reviewableFinding(clientA, buildingA1);
  await openReview(rfCycle.findingId);
  cycleRequested = await requestRework(rfCycle.findingId);

  const rfPendingGeneric = await reviewableFinding(clientA, buildingA1);
  reviewPendingGeneric = await openReview(rfPendingGeneric.findingId);

  const rfPendingSync = await reviewableFinding(clientA, buildingA1);
  reviewPendingSync = await openReview(rfPendingSync.findingId);

  const rfCompleted = await reviewableFinding(clientA, buildingA1);
  reviewCompleted = await openReview(rfCompleted.findingId);
  await completeReview(rfCompleted.findingId, reviewCompleted);

  const rfA2 = await reviewableFinding(clientA, buildingA2);
  reviewA2 = await openReview(rfA2.findingId);
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

async function evidenceCount(executionType: string, executionId: string) {
  const result = await q(
    'SELECT count(*)::int AS n FROM evidence_submissions WHERE execution_type = $1 AND execution_id = $2',
    [executionType, executionId],
  );
  return result.rows[0].n as number;
}

// ---------------------------------------------------------------------------
// Layer 1 — generic POST /evidence (shared metadata path)
// ---------------------------------------------------------------------------

describe('MOB-C06 PART 01A — generic evidence permission parity', () => {
  it('FINDING_VERIFICATION + finding.review succeeds (no evidence.manage needed)', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(
      reviewOnlyToken,
      'FINDING_VERIFICATION',
      reviewPendingGeneric,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.executionType, 'FINDING_VERIFICATION');
    assert.equal(response.body.data.executionId, reviewPendingGeneric);
    assert.equal(response.body.data.submittedByUserId, reviewOnlyUserId);
    assert.equal(await evidenceCount('FINDING_VERIFICATION', reviewPendingGeneric), 1);
  });

  it('FINDING_VERIFICATION + evidence.manage without finding.review is rejected', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(
      evidenceOnlyToken,
      'FINDING_VERIFICATION',
      reviewPendingGeneric,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.equal(await evidenceCount('FINDING_VERIFICATION', reviewPendingGeneric), 1);
  });

  it('FINDING + evidence.manage still succeeds', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(evidenceOnlyToken, 'FINDING', findingA1);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.clientId, clientA);
    assert.equal(await evidenceCount('FINDING', findingA1), 1);
  });

  it('FINDING_REWORK + evidence.manage still succeeds (REQUESTED cycle)', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(
      evidenceOnlyToken,
      'FINDING_REWORK',
      cycleRequested,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.executionType, 'FINDING_REWORK');
    assert.equal(await evidenceCount('FINDING_REWORK', cycleRequested), 1);
  });

  it('existing FORM_INSTANCE / CHECKLIST_EXECUTION behavior is preserved', async (t) => {
    if (!ready(t)) return;
    const form = await postEvidence(
      evidenceOnlyToken,
      'FORM_INSTANCE',
      formInstanceA,
    );
    assert.equal(form.status, 201, JSON.stringify(form.body));
    assert.equal(form.body.data.executionType, 'FORM_INSTANCE');

    const checklist = await postEvidence(
      evidenceOnlyToken,
      'CHECKLIST_EXECUTION',
      checklistExecutionA,
    );
    assert.equal(checklist.status, 201, JSON.stringify(checklist.body));
    assert.equal(checklist.body.data.executionType, 'CHECKLIST_EXECUTION');

    // A caller without evidence.manage is still rejected for existing kinds.
    const denied = await postEvidence(
      plainToken,
      'CHECKLIST_EXECUTION',
      checklistExecutionA,
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });

  it('unsupported executionType fails closed (no mutation)', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(adminToken, 'WORK_ORDER', findingA1);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    // Nothing was written under the unsupported kind.
    const written = await q(
      "SELECT count(*)::int AS n FROM evidence_submissions WHERE execution_type = 'WORK_ORDER'",
    );
    assert.equal(written.rows[0].n, 0);
  });

  it('inaccessible parent is still rejected by scope (permission aside)', async (t) => {
    if (!ready(t)) return;
    // reviewOnly passes the finding.review gate but has no access to A2.
    const verification = await postEvidence(
      reviewOnlyToken,
      'FINDING_VERIFICATION',
      reviewA2,
    );
    assert.equal(verification.status, 403);
    assert.equal(verification.body.error.code, 'BUILDING_ACCESS_DENIED');

    // evidenceOnly passes the evidence.manage gate but has no access to A2.
    const finding = await postEvidence(evidenceOnlyToken, 'FINDING', findingA2);
    assert.equal(finding.status, 403);
    assert.equal(finding.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('non-PENDING (COMPLETED) verification is still rejected', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(
      reviewOnlyToken,
      'FINDING_VERIFICATION',
      reviewCompleted,
    );
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.message,
      'Terminal execution cannot receive evidence.',
    );
    assert.equal(await evidenceCount('FINDING_VERIFICATION', reviewCompleted), 0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — offline POST /mobile/sync EVIDENCE_SUBMISSION
// ---------------------------------------------------------------------------

describe('MOB-C06 PART 01A — offline evidence sync permission parity', () => {
  it('EVIDENCE_SUBMISSION FINDING_VERIFICATION + finding.review succeeds', async (t) => {
    if (!ready(t)) return;
    const operationId = `c01a-sync-verif-${randomUUID()}`;
    const response = await syncBatch(reviewOnlyToken, [
      evidenceSyncOperation(operationId, 'FINDING_VERIFICATION', reviewPendingSync),
    ]);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const result = response.body.data.results[0];
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.operationId, operationId);
    assert.equal(result.result.executionType, 'FINDING_VERIFICATION');
    assert.equal(result.result.executionId, reviewPendingSync);
    assert.equal(result.result.submittedByUserId, reviewOnlyUserId);
    assert.equal(await evidenceCount('FINDING_VERIFICATION', reviewPendingSync), 1);

    // The operation is stored for replay (used by the idempotency test).
    const stored = await q(
      'SELECT count(*)::int AS n FROM mobile_sync_idempotency WHERE operation_id = $1',
      [operationId],
    );
    assert.equal(stored.rows[0].n, 1);
  });

  it('evidence.manage-only cannot sync FINDING_VERIFICATION evidence', async (t) => {
    if (!ready(t)) return;
    const response = await syncBatch(evidenceOnlyToken, [
      evidenceSyncOperation(
        `c01a-sync-denied-${randomUUID()}`,
        'FINDING_VERIFICATION',
        reviewPendingSync,
      ),
    ]);
    assert.equal(response.status, 200);
    const result = response.body.data.results[0];
    assert.equal(result.status, 'FAILED');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'PERMISSION_DENIED');
    // No second row was written for the parent.
    assert.equal(await evidenceCount('FINDING_VERIFICATION', reviewPendingSync), 1);
  });

  it('FINDING / FINDING_REWORK evidence.manage sync behavior is preserved', async (t) => {
    if (!ready(t)) return;
    const response = await syncBatch(evidenceOnlyToken, [
      evidenceSyncOperation(`c01a-sync-finding-${randomUUID()}`, 'FINDING', findingA1),
      evidenceSyncOperation(
        `c01a-sync-rework-${randomUUID()}`,
        'FINDING_REWORK',
        cycleRequested,
      ),
    ]);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.results[0].status, 'SUCCESS');
    assert.equal(response.body.data.results[1].status, 'SUCCESS');
    assert.equal(await evidenceCount('FINDING', findingA1), 2); // generic test 3 + this
    assert.equal(await evidenceCount('FINDING_REWORK', cycleRequested), 2);
  });

  it('replay/idempotency semantics are unchanged (same operationId replays, no duplicate write)', async (t) => {
    if (!ready(t)) return;
    const operationId = `c01a-sync-replay-${randomUUID()}`;
    const first = await syncBatch(reviewOnlyToken, [
      evidenceSyncOperation(operationId, 'FINDING_VERIFICATION', reviewPendingSync),
    ]);
    assert.equal(first.body.data.results[0].status, 'SUCCESS');
    const firstEvidenceId = first.body.data.results[0].result.id;
    assert.ok(firstEvidenceId);

    // Duplicate retry with the SAME operationId: the ORIGINAL stored result
    // is replayed without executing the write again.
    const second = await syncBatch(reviewOnlyToken, [
      evidenceSyncOperation(operationId, 'FINDING_VERIFICATION', reviewPendingSync),
    ]);
    assert.equal(second.status, 200);
    const replayed = second.body.data.results[0];
    assert.equal(replayed.status, 'SUCCESS');
    assert.equal(replayed.operationId, operationId);
    assert.equal(replayed.result.id, firstEvidenceId);

    // Still exactly one evidence row per parent from these operations.
    assert.equal(await evidenceCount('FINDING_VERIFICATION', reviewPendingSync), 2);
  });

  it('parent scope and state authority are still enforced offline', async (t) => {
    if (!ready(t)) return;
    const response = await syncBatch(evidenceOnlyToken, [
      // Cross-Building Finding: scope rejection (evidence.manage held).
      evidenceSyncOperation(
        `c01a-sync-scope-${randomUUID()}`,
        'FINDING',
        findingA2,
      ),
    ]);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.results[0].status, 'FAILED');
    assert.equal(response.body.data.results[0].error.code, 'BUILDING_ACCESS_DENIED');

    // COMPLETED verification review: terminal-state rejection
    // (finding.review held by the caller).
    const terminal = await syncBatch(reviewOnlyToken, [
      evidenceSyncOperation(
        `c01a-sync-state-${randomUUID()}`,
        'FINDING_VERIFICATION',
        reviewCompleted,
      ),
    ]);
    assert.equal(terminal.status, 200);
    assert.equal(terminal.body.data.results[0].status, 'FAILED');
    assert.equal(terminal.body.data.results[0].error.code, 'BAD_REQUEST');
    assert.equal(
      terminal.body.data.results[0].error.message,
      'Terminal execution cannot receive evidence.',
    );
    assert.equal(await evidenceCount('FINDING_VERIFICATION', reviewCompleted), 0);
  });
});
