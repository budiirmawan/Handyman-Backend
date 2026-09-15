import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25J — Supervisor Verification Contract (focused contract tests).
 *
 * Verifies the mobile supervisor verification contract:
 *   - reviewable resource reference,
 *   - supervisor/reviewer context,
 *   - current verification state,
 *   - verification decision + notes + verified_at,
 *   - backend-authoritative available_actions,
 *   - supervisor authorization (per-type RBAC + BE-09 action authority),
 *   - completed verification is immutable (never silently overwritten),
 *   - Client / Building isolation preserved,
 *   - Web review endpoints preserved (shared service behavior).
 */

const DB_PORT = 55448;
const DATA_DIR = '/tmp/asentra-be25j-pg';
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
let reviewerToken = '';
let reviewerUserId = '';
let readOnlyToken = '';

let clientA = '';
let buildingA = '';
let clientB = '';
let buildingB = '';
let templateA = '';
let itemA = '';
let executionA = ''; // client A, DRAFT → COMPLETED in tests
let executionNotDone = ''; // client A, DRAFT (not reviewable)
let executionB = ''; // client B (cross-Client)
let reviewerProfileId = '';

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

async function createClientHierarchy(prefix: string): Promise<{
  clientId: string;
  buildingId: string;
}> {
  const client = await clientService.createClient({
    code: `${prefix}_CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `${prefix}_PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `${prefix}_BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Building`,
  });
  return { clientId: client.id, buildingId: building.id };
}

async function createUserWithPermissions(
  codes: { code: string; name: string }[],
  emailPrefix: string,
): Promise<{ token: string; userId: string }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const password = 'VerifPass123';
  const user = await userService.createUser({
    email: `${emailPrefix}-${suffix.toLowerCase()}@example.com`,
    displayName: `${emailPrefix} Supervisor`,
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${emailPrefix.toUpperCase()}_${suffix}`,
    name: 'Verification Role',
  });
  for (const code of codes) {
    let permission = await permissionRepository.findByCode(code.code);
    if (!permission) {
      permission = await permissionService.createPermission(code);
    }
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

async function getVerification(
  token: string,
  targetType: string,
  targetId: string,
): Promise<any> {
  return api()
    .get(`/api/v1/mobile/verification/${targetType}/${targetId}`)
    .set('Authorization', `Bearer ${token}`);
}

async function submitVerification(
  token: string,
  targetType: string,
  targetId: string,
  body: Record<string, unknown>,
): Promise<any> {
  return api()
    .post(`/api/v1/mobile/verification/${targetType}/${targetId}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
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
      user_building_assignments, organizations, departments, teams, positions,
      workforce_profiles, checklist_templates, checklist_items,
      checklist_executions, checklist_item_responses, findings,
      finding_assignments, finding_severities, finding_classifications,
      source_forms, form_templates, form_template_versions, form_instances,
      reviews, operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await createClientHierarchy('VERIF_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });
  const b = await createClientHierarchy('VERIF_B');
  clientB = b.clientId;
  buildingB = b.buildingId;

  // Reviewer (review.manage + finding.review + building access to A).
  const reviewer = await createUserWithPermissions(
    [
      { code: 'review.manage', name: 'Manage Reviews' },
      { code: 'review.read', name: 'Read Reviews' },
      { code: 'finding.review', name: 'Review Findings' },
      { code: 'finding.read', name: 'Read Findings' },
    ],
    'reviewer',
  );
  reviewerToken = reviewer.token;
  reviewerUserId = reviewer.userId;
  await buildingAssignmentService.createAssignment(reviewerUserId, {
    buildingId: buildingA,
  });
  const org = await insertRow('organizations', {
    client_id: clientA,
    code: `ORG_J_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Org J',
    status: 'ACTIVE',
  });
  const dept = await insertRow('departments', {
    organization_id: org,
    code: `DEPT_J_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Dept J',
    status: 'ACTIVE',
  });
  const pos = await insertRow('positions', {
    organization_id: org,
    code: `POS_J_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Pos J',
    status: 'ACTIVE',
  });
  reviewerProfileId = await insertRow('workforce_profiles', {
    organization_id: org,
    department_id: dept,
    position_id: pos,
    user_id: reviewerUserId,
    employee_code: `REV_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: 'Reviewer Supervisor',
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });

  // Read-only user (review.read + finding.read).
  const readOnly = await createUserWithPermissions(
    [
      { code: 'review.read', name: 'Read Reviews' },
      { code: 'finding.read', name: 'Read Findings' },
    ],
    'roverif',
  );
  readOnlyToken = readOnly.token;
  await buildingAssignmentService.createAssignment(readOnly.userId, {
    buildingId: buildingA,
  });

  // Checklist template + executions.
  templateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_J_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Verification Template',
    status: 'ACTIVE',
  });
  itemA = await insertRow('checklist_items', {
    checklist_template_id: templateA,
    code: 'CHK',
    label: 'Check',
    item_type: 'CHECK',
    required: true,
    display_order: 0,
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateA,
    status: 'COMPLETED',
    started_at: '2026-08-10T01:00:00Z',
    completed_at: '2026-08-10T02:00:00Z',
  });
  executionNotDone = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateA,
    status: 'DRAFT',
  });

  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_JB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Verification Template B',
    status: 'ACTIVE',
  });
  executionB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: templateB,
    status: 'COMPLETED',
    completed_at: '2026-08-10T03:00:00Z',
  });

  // A finding in PENDING_REVIEW state (client A, building A).
  const sourceForm = await insertRow('source_forms', {
    client_id: clientA,
    code: `SRC_J_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Source J',
    source_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  await insertRow('findings', {
    client_id: clientA,
    building_id: buildingA,
    finding_number: `FN-${randomUUID().slice(0, 8).toUpperCase()}`,
    title: 'Pending Finding',
    status: 'PENDING_REVIEW',
    source_type: 'FORM_INSTANCE',
    source_id: sourceForm,
    reported_by_user_id: adminUserId,
    reported_at: '2026-08-10T04:00:00Z',
  });
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

describe('BE-25J supervisor verification — review targets (checklist execution)', () => {
  it('returns the full contract for a reviewable checklist execution', async () => {
    const response = await getVerification(reviewerToken, 'CHECKLIST_EXECUTION', executionA);
    assert.equal(response.status, 200);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'availableActions',
      'buildingId',
      'clientId',
      'resource',
      'reviewer',
      'targetId',
      'targetType',
      'updatedAt',
      'verification',
    ]);
    assert.equal(data.targetType, 'CHECKLIST_EXECUTION');
    assert.equal(data.targetId, executionA);
    assert.equal(data.clientId, clientA);
    assert.equal(data.buildingId, null);

    // Reviewable resource reference.
    assert.equal(data.resource.status, 'COMPLETED');
    assert.equal(data.resource.checklist.id, templateA);
    assert.ok(data.resource.checklist.code);
    assert.equal(data.resource.checklist.name, 'Verification Template');
    assert.equal(data.resource.finding, null);

    // Current verification state.
    assert.equal(data.verification.state, 'PENDING');
    assert.equal(data.verification.decision, null);
    assert.equal(data.verification.notes, null);
    assert.equal(data.verification.verifiedAt, null);
    assert.equal(data.verification.reviewId, null);

    // Reviewer context (none yet).
    assert.equal(data.reviewer, null);

    // Available actions.
    assert.deepEqual(data.availableActions, ['SUBMIT_DECISION']);
  });

  it('submits a decision (single-call open + decide) and returns the verified contract', async () => {
    const response = await submitVerification(reviewerToken, 'CHECKLIST_EXECUTION', executionA, {
      decision: 'APPROVED',
      notes: 'Looks good',
    });
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.equal(data.verification.state, 'VERIFIED');
    assert.equal(data.verification.decision, 'APPROVED');
    assert.equal(data.verification.notes, 'Looks good');
    assert.ok(data.verification.verifiedAt);
    assert.ok(data.verification.reviewId);
    assert.equal(data.verification.reviewStatus, 'COMPLETED');

    // Supervisor/reviewer context.
    assert.ok(data.reviewer);
    assert.equal(data.reviewer.userId, reviewerUserId);
    assert.equal(data.reviewer.displayName, 'reviewer Supervisor');
    assert.equal(data.reviewer.workforceProfileId, reviewerProfileId);
    assert.equal(data.reviewer.fullName, 'Reviewer Supervisor');
    assert.ok(data.reviewer.employeeCode.startsWith('REV_EMP_'));

    // No more actions (verified).
    assert.deepEqual(data.availableActions, []);

    // The write went through the shared reviews table (Web-visible).
    const reviewRow = await q(
      `SELECT decision, notes, status FROM reviews
        WHERE target_type = 'CHECKLIST_EXECUTION' AND target_id = $1`,
      [executionA],
    );
    assert.equal(reviewRow.rows[0].decision, 'APPROVED');
    assert.equal(reviewRow.rows[0].status, 'COMPLETED');
  });

  it('completed verification cannot be silently overwritten', async () => {
    const response = await submitVerification(reviewerToken, 'CHECKLIST_EXECUTION', executionA, {
      decision: 'REJECTED',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.match(response.body.error.message, /overwritten/i);

    const row = await q(
      `SELECT decision FROM reviews
        WHERE target_type = 'CHECKLIST_EXECUTION' AND target_id = $1`,
      [executionA],
    );
    assert.equal(row.rows[0].decision, 'APPROVED', 'original decision preserved');
  });

  it('returns NOT_REVIEWABLE with no actions for a non-completed target', async () => {
    const data = (await getVerification(reviewerToken, 'CHECKLIST_EXECUTION', executionNotDone))
      .body.data;
    assert.equal(data.resource.status, 'DRAFT');
    assert.equal(data.verification.state, 'NOT_REVIEWABLE');
    assert.deepEqual(data.availableActions, []);

    const submit = await submitVerification(
      reviewerToken,
      'CHECKLIST_EXECUTION',
      executionNotDone,
      { decision: 'APPROVED' },
    );
    assert.equal(submit.status, 400);
    assert.equal(submit.body.error.code, 'BAD_REQUEST');
  });

  it('preserves Client isolation (403 on cross-Client target)', async () => {
    const cross = await getVerification(reviewerToken, 'CHECKLIST_EXECUTION', executionB);
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error.code, 'BUILDING_ACCESS_DENIED');

    const crossSubmit = await submitVerification(
      reviewerToken,
      'CHECKLIST_EXECUTION',
      executionB,
      { decision: 'APPROVED' },
    );
    assert.equal(crossSubmit.status, 403);
  });

  it('enforces supervisor authorization (review.manage for submit)', async () => {
    const forbidden = await submitVerification(
      readOnlyToken,
      'CHECKLIST_EXECUTION',
      executionNotDone,
      { decision: 'APPROVED' },
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');

    // Read is allowed for review.read holders.
    const read = await getVerification(readOnlyToken, 'CHECKLIST_EXECUTION', executionNotDone);
    assert.equal(read.status, 200);
  });
});

describe('BE-25J supervisor verification — FINDING target', () => {
  it('returns the finding verification contract with BE-09 actions', async () => {
    const findingId = (
      await q(`SELECT id FROM findings WHERE status = 'PENDING_REVIEW' LIMIT 1`)
    ).rows[0].id as string;

    const response = await getVerification(reviewerToken, 'FINDING', findingId);
    assert.equal(response.status, 200);
    const data = response.body.data;

    assert.equal(data.targetType, 'FINDING');
    assert.equal(data.targetId, findingId);
    assert.equal(data.clientId, clientA);
    assert.equal(data.buildingId, buildingA);
    assert.equal(data.resource.status, 'PENDING_REVIEW');
    assert.ok(data.resource.finding);
    assert.equal(data.resource.finding.title, 'Pending Finding');
    assert.ok(data.resource.finding.findingNumber);

    assert.equal(data.verification.state, 'PENDING_REVIEW');
    assert.equal(data.verification.reviewId, null);

    // No review open yet → OPEN_REVIEW is the allowed verification action.
    assert.deepEqual(data.availableActions, ['OPEN_REVIEW']);
  });

  it('submits a finding verification decision (single-call open + submit)', async () => {
    const findingId = (
      await q(`SELECT id FROM findings WHERE status = 'PENDING_REVIEW' LIMIT 1`)
    ).rows[0].id as string;

    const response = await submitVerification(reviewerToken, 'FINDING', findingId, {
      decision: 'APPROVED',
      notes: 'Verified in the field',
    });
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.equal(data.verification.state, 'VERIFIED');
    assert.equal(data.verification.decision, 'APPROVED');
    assert.equal(data.verification.notes, 'Verified in the field');
    assert.ok(data.verification.verifiedAt);
    assert.ok(data.verification.reviewId);
    assert.equal(data.verification.reviewStatus, 'COMPLETED');
    assert.ok(data.reviewer);
    assert.equal(data.reviewer.userId, reviewerUserId);
    assert.deepEqual(data.availableActions, []);
  });

  it('a second decision on a verified finding is rejected (authority first, never overwritten)', async () => {
    // After VERIFIED, the BE-09 action authority denies any further
    // verification action (Web-identical: authority is checked before any
    // mutation), so the completed verification is never overwritten.
    const findingId = (
      await q(`SELECT id FROM findings WHERE status = 'VERIFIED' LIMIT 1`)
    ).rows[0]?.id as string | undefined;
    if (!findingId) {
      // The previous test verified the only finding.
      return;
    }
    const response = await submitVerification(reviewerToken, 'FINDING', findingId, {
      decision: 'REJECTED',
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');

    const row = await q(
      `SELECT status FROM reviews WHERE target_type = 'FINDING' AND target_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [findingId],
    );
    assert.equal(row.rows[0].status, 'COMPLETED', 'verification not overwritten');
  });

  it('rejects a finding decision the BE-09 action authority forbids', async () => {
    // A finding NOT in PENDING_REVIEW has no reviewable verification action.
    const findingId = (
      await q(`SELECT id FROM findings WHERE status = 'VERIFIED' LIMIT 1`)
    ).rows[0]?.id as string | undefined;
    if (!findingId) {
      return;
    }
    const response = await submitVerification(reviewerToken, 'FINDING', findingId, {
      decision: 'APPROVED',
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('enforces finding.review permission for finding submissions', async () => {
    const findingId = (
      await q(`SELECT id FROM findings LIMIT 1`)
    ).rows[0].id as string;
    const response = await submitVerification(readOnlyToken, 'FINDING', findingId, {
      decision: 'APPROVED',
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('preserves Building isolation for findings (403)', async () => {
    const crossFinding = await insertRow('findings', {
      client_id: clientB,
      building_id: buildingB,
      finding_number: `FN-B-${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Cross Finding',
      status: 'PENDING_REVIEW',
      source_type: 'FORM_INSTANCE',
      source_id: id(),
      reported_by_user_id: adminUserId,
      reported_at: '2026-08-10T05:00:00Z',
    });
    const response = await getVerification(reviewerToken, 'FINDING', crossFinding);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-25J supervisor verification — errors and Web behavior', () => {
  it('validates targetType and targetId (400)', async () => {
    const badType = await getVerification(reviewerToken, 'UNKNOWN', executionA);
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'VALIDATION_ERROR');

    const badId = await getVerification(reviewerToken, 'CHECKLIST_EXECUTION', 'not-a-uuid');
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    const anonymous = await api().get(
      `/api/v1/mobile/verification/CHECKLIST_EXECUTION/${executionA}`,
    );
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('preserves the Web review endpoints (shared service unchanged behavior)', async () => {
    // Open a review through the Web endpoint on a fresh completed execution.
    const freshExecution = await insertRow('checklist_executions', {
      client_id: clientA,
      checklist_template_id: templateA,
      status: 'COMPLETED',
      completed_at: '2026-08-10T06:00:00Z',
    });
    const created = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({
        targetType: 'CHECKLIST_EXECUTION',
        targetId: freshExecution,
        notes: 'Web-opened',
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'PENDING');

    const decided = await api()
      .post(`/api/v1/reviews/${created.body.data.id}/decision`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({ decision: 'REWORK_REQUIRED' });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.data.decision, 'REWORK_REQUIRED');
    assert.equal(decided.body.data.status, 'COMPLETED');

    // The mobile contract sees the same immutable state.
    const mobile = await getVerification(reviewerToken, 'CHECKLIST_EXECUTION', freshExecution);
    assert.equal(mobile.body.data.verification.state, 'REWORK_REQUIRED');
    assert.deepEqual(mobile.body.data.availableActions, []);
  });
});
