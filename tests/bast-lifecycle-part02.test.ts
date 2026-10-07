import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { propertyService } from '../src/modules/properties';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55471;
const DIR = '/tmp/asentra-bast-part02-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE clients, users, roles CASCADE');
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function structure(assign: boolean) {
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Canonical Lifecycle Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Canonical Lifecycle Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Canonical Lifecycle Building',
  });
  if (assign) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building };
}

async function createInternalBast(clientId: string, buildingId: string) {
  const workOrder = await workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Canonical BAST lifecycle work',
    workType: 'REPAIR',
    createdByUserId: userId,
  });
  await pool!.query(
    `UPDATE work_orders
     SET status = 'COMPLETED', completed_at = NOW(), completed_by_user_id = $2
     WHERE id = $1`,
    [workOrder.id, userId],
  );

  const response = await api()
    .post('/api/v1/bast-documents')
    .set(auth())
    .send({
      clientId,
      buildingId,
      contextType: 'INTERNAL',
      documentNumber: `DOC_${suffix()}`,
      documentType: 'BAST',
      title: 'Canonical internal acceptance',
      workOrderId: workOrder.id,
      bastNumber: `BAST_${suffix()}`,
      bastDate: '2026-08-18',
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const bast = response.body.data as {
    id: string;
    documentId: string;
    bastNumber: string;
  };
  const version = await pool!.query<{ id: string }>(
    `SELECT id FROM document_versions
     WHERE document_id = $1 AND version_number = 1`,
    [bast.documentId],
  );
  assert.equal(version.rowCount, 1);
  return { bast, workOrder, documentVersionId: version.rows[0].id };
}

async function createDocumentManager(buildingId: string) {
  const id = suffix();
  const password = 'DocumentPass123';
  const user = await userService.createUser({
    email: `document-manager-${id.toLowerCase()}@example.com`,
    displayName: 'Document Manager Without BAST Decision Authority',
  });
  await credentialService.createInitialCredential({
    userId: user.id,
    password,
  });
  const role = await roleService.createRole({
    code: `DOCUMENT_MANAGER_${id}`,
    name: 'Document Manager',
  });
  const permission = await permissionRepository.findByCode('document.manage');
  assert.ok(permission);
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  await buildingAssignmentService.createAssignment(user.id, { buildingId });
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.data.sessionToken as string;
}

describe('CR-BE-BAST-01 PART 02 — canonical submit / accept / reject commands', () => {
  it('owns strict atomic lifecycle decisions, immutable pins, rejection Findings, RBAC and isolation', async (t) => {
    if (!ready(t)) return;

    const { client, building } = await structure(true);
    const acceptedFixture = await createInternalBast(client.id, building.id);
    const reviewId = randomUUID();
    const evidenceId = randomUUID();
    await pool!.query(
      `INSERT INTO reviews
         (id, client_id, target_type, target_id, reviewer_user_id,
          decision, status, reviewed_at)
       VALUES ($1,$2,'WORK_ORDER',$3,$4,'APPROVED','COMPLETED',NOW())`,
      [reviewId, client.id, acceptedFixture.workOrder.id, userId],
    );
    await pool!.query(
      `INSERT INTO evidence_submissions
         (id, client_id, execution_type, execution_id, evidence_type,
          file_reference, original_file_name, mime_type, file_size,
          submitted_by_user_id)
       VALUES ($1,$2,'WORK_ORDER',$3,'DOCUMENT',$4,'completion.pdf',
               'application/pdf',10,$5)`,
      [
        evidenceId,
        client.id,
        acceptedFixture.workOrder.id,
        'objects/completion.pdf',
        userId,
      ],
    );

    const linkedTypeMutation = await api()
      .patch(`/api/v1/documents/${acceptedFixture.bast.documentId}`)
      .set(auth())
      .send({ documentType: 'REPORT' });
    assert.equal(linkedTypeMutation.status, 409, JSON.stringify(linkedTypeMutation.body));
    assert.equal(linkedTypeMutation.body.error.code, 'DOCUMENT_UPDATE_NOT_ALLOWED');
    const linkedBuildingMutation = await api()
      .patch(`/api/v1/documents/${acceptedFixture.bast.documentId}`)
      .set(auth())
      .send({ buildingId: null });
    assert.equal(
      linkedBuildingMutation.status,
      409,
      JSON.stringify(linkedBuildingMutation.body),
    );
    const linkedArchive = await api()
      .post(`/api/v1/documents/${acceptedFixture.bast.documentId}/archive`)
      .set(auth())
      .send({ reason: 'Generic archive bypass.' });
    assert.equal(linkedArchive.status, 409, JSON.stringify(linkedArchive.body));

    const submitted = await api()
      .post(`/api/v1/bast-documents/${acceptedFixture.bast.id}/submit`)
      .set(auth())
      .send({ documentVersionId: acceptedFixture.documentVersionId });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.bastDocument.acceptanceStatus, 'SUBMITTED');
    assert.equal(submitted.body.data.bastDocument.submittedByUserId, userId);
    assert.ok(submitted.body.data.bastDocument.submittedAt);
    assert.equal(
      submitted.body.data.documentVersionId,
      acceptedFixture.documentVersionId,
    );

    const submittedAttemptId = submitted.body.data.submissionAttemptId as string;
    const attempt = await pool!.query(
      `SELECT document_version_id, work_order_verification_id,
              submitted_by_user_id, readiness_snapshot
       FROM bast_submission_attempts WHERE id = $1`,
      [submittedAttemptId],
    );
    assert.equal(attempt.rowCount, 1);
    assert.equal(attempt.rows[0].document_version_id, acceptedFixture.documentVersionId);
    assert.equal(
      attempt.rows[0].readiness_snapshot.workOrder.id,
      acceptedFixture.workOrder.id,
    );
    assert.equal(attempt.rows[0].work_order_verification_id, reviewId);
    assert.equal(attempt.rows[0].submitted_by_user_id, userId);
    assert.deepEqual(
      attempt.rows[0].readiness_snapshot.evidenceSubmissionIds,
      [evidenceId],
    );
    const attemptEvidence = await pool!.query(
      `SELECT evidence_submission_id
       FROM bast_submission_attempt_evidence
       WHERE submission_attempt_id = $1`,
      [submittedAttemptId],
    );
    assert.deepEqual(attemptEvidence.rows, [{ evidence_submission_id: evidenceId }]);
    const submittedEvent = await pool!.query(
      `SELECT actor_user_id, metadata FROM operational_events
       WHERE entity_type = 'BAST_DOCUMENT' AND entity_id = $1
         AND event_type = 'BAST_SUBMITTED'`,
      [acceptedFixture.bast.id],
    );
    assert.equal(submittedEvent.rowCount, 1);
    assert.equal(submittedEvent.rows[0].actor_user_id, userId);
    assert.equal(
      submittedEvent.rows[0].metadata.submissionAttemptId,
      submittedAttemptId,
    );

    await assert.rejects(
      pool!.query(
        `UPDATE bast_submission_attempts
         SET document_version_id = $2 WHERE id = $1`,
        [submittedAttemptId, randomUUID()],
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === '55000',
    );

    const versionTwoId = randomUUID();
    await pool!.query(
      `INSERT INTO document_versions
         (id, document_id, version_number, title, document_type, status,
          created_by_user_id)
       SELECT $1, id, 2, title, document_type, status, $3
       FROM documents WHERE id = $2`,
      [versionTwoId, acceptedFixture.bast.documentId, userId],
    );

    const accepted = await api()
      .post(`/api/v1/bast-documents/${acceptedFixture.bast.id}/decisions`)
      .set(auth())
      .send({ decision: 'ACCEPT', notes: 'Accepted against submitted version.' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.bastDocument.acceptanceStatus, 'ACCEPTED');
    assert.equal(accepted.body.data.bastDocument.acceptedByUserId, userId);
    assert.ok(accepted.body.data.bastDocument.acceptedAt);
    assert.equal(accepted.body.data.submissionAttemptId, submittedAttemptId);
    assert.equal(accepted.body.data.documentVersionId, acceptedFixture.documentVersionId);
    const acceptedSignOff = await pool!.query(
      `SELECT decision, bast_submission_attempt_id, document_version_id,
              signer_user_id
       FROM acceptance_sign_offs WHERE id = $1`,
      [accepted.body.data.acceptanceSignOffId],
    );
    assert.deepEqual(acceptedSignOff.rows, [
      {
        decision: 'ACCEPTED',
        bast_submission_attempt_id: submittedAttemptId,
        document_version_id: acceptedFixture.documentVersionId,
        signer_user_id: userId,
      },
    ]);

    const invalidTransition = await api()
      .post(`/api/v1/bast-documents/${acceptedFixture.bast.id}/decisions`)
      .set(auth())
      .send({ decision: 'REJECT', notes: 'Too late.' });
    assert.equal(invalidTransition.status, 409, JSON.stringify(invalidTransition.body));
    assert.equal(invalidTransition.body.error.code, 'BAST_INVALID_TRANSITION');
    const acceptedDecisionCount = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM acceptance_sign_offs
       WHERE bast_submission_attempt_id = $1`,
      [submittedAttemptId],
    );
    assert.equal(acceptedDecisionCount.rows[0].count, 1);

    const rejectedFixture = await createInternalBast(client.id, building.id);
    await pool!.query(
      `INSERT INTO reviews
         (id, client_id, target_type, target_id, reviewer_user_id,
          decision, status, reviewed_at)
       VALUES ($1,$2,'WORK_ORDER',$3,$4,'APPROVED','COMPLETED',NOW())`,
      [randomUUID(), client.id, rejectedFixture.workOrder.id, userId],
    );
    const rejectedSubmission = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/submit`)
      .set(auth())
      .send({ documentVersionId: rejectedFixture.documentVersionId });
    assert.equal(
      rejectedSubmission.status,
      200,
      JSON.stringify(rejectedSubmission.body),
    );

    const documentManagerToken = await createDocumentManager(building.id);
    const narrowAuthorityDenied = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/decisions`)
      .set(auth(documentManagerToken))
      .send({ decision: 'REJECT', notes: 'No decision authority.' });
    assert.equal(
      narrowAuthorityDenied.status,
      403,
      JSON.stringify(narrowAuthorityDenied.body),
    );

    const rejected = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/decisions`)
      .set(auth())
      .send({ decision: 'REJECT', notes: 'Repair evidence is insufficient.' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.bastDocument.acceptanceStatus, 'REJECTED');
    assert.equal(rejected.body.data.bastDocument.acceptedByUserId, userId);
    assert.ok(rejected.body.data.bastDocument.acceptedAt);
    assert.ok(rejected.body.data.findingId);

    const rejectionContext = await pool!.query(
      `SELECT
         f.status, f.source_type, f.source_id,
         l.bast_document_id, l.bast_submission_attempt_id,
         l.acceptance_sign_off_id, l.linked_by_user_id,
         s.decision, s.document_version_id
       FROM findings f
       JOIN bast_finding_links l ON l.finding_id = f.id
       JOIN acceptance_sign_offs s ON s.id = l.acceptance_sign_off_id
       WHERE f.id = $1`,
      [rejected.body.data.findingId],
    );
    assert.equal(rejectionContext.rowCount, 1);
    assert.equal(rejectionContext.rows[0].status, 'OPEN');
    assert.equal(rejectionContext.rows[0].source_type, 'WORK_ORDER');
    assert.equal(rejectionContext.rows[0].source_id, rejectedFixture.workOrder.id);
    assert.equal(rejectionContext.rows[0].bast_document_id, rejectedFixture.bast.id);
    assert.equal(
      rejectionContext.rows[0].bast_submission_attempt_id,
      rejectedSubmission.body.data.submissionAttemptId,
    );
    assert.equal(rejectionContext.rows[0].linked_by_user_id, userId);
    assert.equal(rejectionContext.rows[0].decision, 'REJECTED');
    assert.equal(
      rejectionContext.rows[0].document_version_id,
      rejectedFixture.documentVersionId,
    );
    const noDuplicateReworkEngine = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM finding_rework_cycles
       WHERE finding_id = $1`,
      [rejected.body.data.findingId],
    );
    assert.equal(noDuplicateReworkEngine.rows[0].count, 0);

    const genericBypass = await api()
      .post('/api/v1/acceptance-sign-offs')
      .set(auth())
      .send({
        bastDocumentId: rejectedFixture.bast.id,
        decision: 'ACCEPTED',
      });
    assert.equal(genericBypass.status, 400, JSON.stringify(genericBypass.body));
    const rejectionEvents = await pool!.query(
      `SELECT event_type FROM operational_events
       WHERE (entity_type = 'BAST_DOCUMENT' AND entity_id = $1
              AND event_type = 'BAST_REJECTED')
          OR (entity_type = 'FINDING' AND entity_id = $2
              AND event_type = 'FINDING_CREATED')
       ORDER BY event_type`,
      [rejectedFixture.bast.id, rejected.body.data.findingId],
    );
    assert.deepEqual(
      rejectionEvents.rows.map((row) => row.event_type),
      ['BAST_REJECTED', 'FINDING_CREATED'],
    );

    const correctionNotReady = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/resubmit`)
      .set(auth())
      .send({ documentVersionId: rejectedFixture.documentVersionId });
    assert.equal(correctionNotReady.status, 409, JSON.stringify(correctionNotReady.body));
    assert.equal(correctionNotReady.body.error.code, 'BAST_NOT_READY');

    await pool!.query(
      `UPDATE findings SET status = 'VERIFIED', state_changed_at = NOW()
       WHERE id = $1`,
      [rejected.body.data.findingId],
    );
    const staleVersion = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/resubmit`)
      .set(auth())
      .send({ documentVersionId: rejectedFixture.documentVersionId });
    assert.equal(staleVersion.status, 409, JSON.stringify(staleVersion.body));
    assert.equal(staleVersion.body.error.code, 'BAST_NOT_READY');

    const rejectedVersionTwoId = randomUUID();
    await pool!.query(
      `INSERT INTO document_versions
         (id, document_id, version_number, title, document_type, status,
          created_by_user_id)
       SELECT $1, id, 2, title, document_type, status, $3
       FROM documents WHERE id = $2`,
      [rejectedVersionTwoId, rejectedFixture.bast.documentId, userId],
    );
    const evidenceRequirementId = randomUUID();
    const correctionEvidenceOneId = randomUUID();
    await pool!.query(
      `INSERT INTO evidence_requirements
         (id, client_id, target_type, target_id, evidence_type, required,
          minimum_count, status)
       VALUES ($1,$2,'WORK_ORDER',$3,'DOCUMENT',TRUE,2,'ACTIVE')`,
      [evidenceRequirementId, client.id, rejectedFixture.workOrder.id],
    );
    await pool!.query(
      `INSERT INTO evidence_submissions
         (id, client_id, evidence_requirement_id, execution_type, execution_id,
          evidence_type, file_reference, original_file_name, mime_type,
          file_size, submitted_by_user_id)
       VALUES ($1,$2,$3,'WORK_ORDER',$4,'DOCUMENT',$5,'correction-1.pdf',
               'application/pdf',10,$6)`,
      [
        correctionEvidenceOneId,
        client.id,
        evidenceRequirementId,
        rejectedFixture.workOrder.id,
        'objects/correction-1.pdf',
        userId,
      ],
    );
    const evidenceNotReady = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/resubmit`)
      .set(auth())
      .send({ documentVersionId: rejectedVersionTwoId });
    assert.equal(evidenceNotReady.status, 409, JSON.stringify(evidenceNotReady.body));
    assert.equal(evidenceNotReady.body.error.code, 'BAST_NOT_READY');
    const unchangedRejected = await pool!.query(
      `SELECT acceptance_status,
              (SELECT COUNT(*)::int FROM bast_submission_attempts
               WHERE bast_document_id = $1) AS attempts
       FROM bast_documents WHERE id = $1`,
      [rejectedFixture.bast.id],
    );
    assert.deepEqual(unchangedRejected.rows, [
      { acceptance_status: 'REJECTED', attempts: 1 },
    ]);

    const correctionEvidenceTwoId = randomUUID();
    await pool!.query(
      `INSERT INTO evidence_submissions
         (id, client_id, evidence_requirement_id, execution_type, execution_id,
          evidence_type, file_reference, original_file_name, mime_type,
          file_size, submitted_by_user_id)
       VALUES ($1,$2,$3,'WORK_ORDER',$4,'DOCUMENT',$5,'correction-2.pdf',
               'application/pdf',10,$6)`,
      [
        correctionEvidenceTwoId,
        client.id,
        evidenceRequirementId,
        rejectedFixture.workOrder.id,
        'objects/correction-2.pdf',
        userId,
      ],
    );
    const resubmitted = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/resubmit`)
      .set(auth())
      .send({ documentVersionId: rejectedVersionTwoId });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    assert.equal(resubmitted.body.data.bastDocument.acceptanceStatus, 'SUBMITTED');
    assert.equal(resubmitted.body.data.bastDocument.acceptedByUserId, null);
    assert.equal(resubmitted.body.data.bastDocument.acceptedAt, null);
    assert.equal(resubmitted.body.data.documentVersionId, rejectedVersionTwoId);

    const resubmittedAttemptId = resubmitted.body.data.submissionAttemptId as string;
    const resubmittedEvidence = await pool!.query(
      `SELECT evidence_submission_id
       FROM bast_submission_attempt_evidence
       WHERE submission_attempt_id = $1
       ORDER BY evidence_submission_id`,
      [resubmittedAttemptId],
    );
    assert.deepEqual(
      resubmittedEvidence.rows.map((row) => row.evidence_submission_id).sort(),
      [correctionEvidenceOneId, correctionEvidenceTwoId].sort(),
    );
    const historicalAttempts = await pool!.query(
      `SELECT id, attempt_number, document_version_id
       FROM bast_submission_attempts
       WHERE bast_document_id = $1 ORDER BY attempt_number`,
      [rejectedFixture.bast.id],
    );
    assert.deepEqual(historicalAttempts.rows, [
      {
        id: rejectedSubmission.body.data.submissionAttemptId,
        attempt_number: 1,
        document_version_id: rejectedFixture.documentVersionId,
      },
      {
        id: resubmittedAttemptId,
        attempt_number: 2,
        document_version_id: rejectedVersionTwoId,
      },
    ]);
    const historicalRejection = await pool!.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM acceptance_sign_offs
       WHERE bast_submission_attempt_id = $1 AND decision = 'REJECTED'`,
      [rejectedSubmission.body.data.submissionAttemptId],
    );
    assert.equal(historicalRejection.rows[0].count, 1);
    const resubmissionEvent = await pool!.query(
      `SELECT actor_user_id, metadata FROM operational_events
       WHERE entity_type = 'BAST_DOCUMENT' AND entity_id = $1
         AND event_type = 'BAST_RESUBMITTED'`,
      [rejectedFixture.bast.id],
    );
    assert.equal(resubmissionEvent.rowCount, 1);
    assert.equal(resubmissionEvent.rows[0].actor_user_id, userId);
    assert.equal(
      resubmissionEvent.rows[0].metadata.submissionAttemptId,
      resubmittedAttemptId,
    );

    const acceptedCorrection = await api()
      .post(`/api/v1/bast-documents/${rejectedFixture.bast.id}/decisions`)
      .set(auth())
      .send({ decision: 'ACCEPT', notes: 'Correction accepted.' });
    assert.equal(acceptedCorrection.status, 200, JSON.stringify(acceptedCorrection.body));
    assert.equal(acceptedCorrection.body.data.bastDocument.acceptanceStatus, 'ACCEPTED');
    assert.equal(acceptedCorrection.body.data.submissionAttemptId, resubmittedAttemptId);
    assert.equal(acceptedCorrection.body.data.documentVersionId, rejectedVersionTwoId);

    const plainToken = await createPlainSession();
    const draftFixture = await createInternalBast(client.id, building.id);
    const submitRbacDenied = await api()
      .post(`/api/v1/bast-documents/${draftFixture.bast.id}/submit`)
      .set(auth(plainToken))
      .send({ documentVersionId: draftFixture.documentVersionId });
    assert.equal(submitRbacDenied.status, 403, JSON.stringify(submitRbacDenied.body));

    const hidden = await structure(false);
    const hiddenWorkOrderId = randomUUID();
    const hiddenDocumentId = randomUUID();
    const hiddenVersionId = randomUUID();
    const hiddenBastId = randomUUID();
    await pool!.query(
      `INSERT INTO work_orders
         (id, client_id, building_id, work_order_number, title, work_type,
          status, completed_at, completed_by_user_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,'Hidden work','REPAIR','COMPLETED',NOW(),$5,$5)`,
      [
        hiddenWorkOrderId,
        hidden.client.id,
        hidden.building.id,
        `WO_${suffix()}`,
        userId,
      ],
    );
    await pool!.query(
      `INSERT INTO documents
         (id, client_id, building_id, document_number, document_type,
          context_type, title, created_by_user_id)
       VALUES ($1,$2,$3,$4,'BAST','INTERNAL','Hidden BAST',$5)`,
      [
        hiddenDocumentId,
        hidden.client.id,
        hidden.building.id,
        `DOC_${suffix()}`,
        userId,
      ],
    );
    await pool!.query(
      `INSERT INTO document_versions
         (id, document_id, version_number, title, document_type, status,
          created_by_user_id)
       VALUES ($1,$2,1,'Hidden BAST','BAST','DRAFT',$3)`,
      [hiddenVersionId, hiddenDocumentId, userId],
    );
    await pool!.query(
      `INSERT INTO bast_documents
         (id, document_id, work_order_id, client_id, building_id,
          context_type, bast_number, bast_date, prepared_by_user_id,
          acceptance_scope_type)
       VALUES ($1,$2,$3,$4,$5,'INTERNAL',$6,'2026-08-18',$7,'WORK_ORDER')`,
      [
        hiddenBastId,
        hiddenDocumentId,
        hiddenWorkOrderId,
        hidden.client.id,
        hidden.building.id,
        `BAST_${suffix()}`,
        userId,
      ],
    );
    const isolationDenied = await api()
      .post(`/api/v1/bast-documents/${hiddenBastId}/submit`)
      .set(auth())
      .send({ documentVersionId: hiddenVersionId });
    assert.equal(isolationDenied.status, 403, JSON.stringify(isolationDenied.body));
    assert.equal(isolationDenied.body.error.code, 'BUILDING_ACCESS_DENIED');
    const hiddenState = await pool!.query(
      `SELECT acceptance_status,
              (SELECT COUNT(*)::int FROM bast_submission_attempts
               WHERE bast_document_id = $1) AS attempts
       FROM bast_documents WHERE id = $1`,
      [hiddenBastId],
    );
    assert.deepEqual(hiddenState.rows, [
      { acceptance_status: 'DRAFT', attempts: 0 },
    ]);

    const hiddenAttemptId = randomUUID();
    await pool!.query(
      `INSERT INTO bast_submission_attempts
         (id, bast_document_id, attempt_number, document_version_id,
          submitted_by_user_id, readiness_snapshot)
       VALUES ($1,$2,1,$3,$4,'{}'::jsonb)`,
      [hiddenAttemptId, hiddenBastId, hiddenVersionId, userId],
    );
    await pool!.query(
      `UPDATE bast_documents
       SET acceptance_status = 'SUBMITTED', submitted_by_user_id = $2,
           submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [hiddenBastId, userId],
    );
    const decisionIsolationDenied = await api()
      .post(`/api/v1/bast-documents/${hiddenBastId}/decisions`)
      .set(auth())
      .send({ decision: 'ACCEPT' });
    assert.equal(
      decisionIsolationDenied.status,
      403,
      JSON.stringify(decisionIsolationDenied.body),
    );
    assert.equal(
      decisionIsolationDenied.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );
    const hiddenDecisionState = await pool!.query(
      `SELECT b.acceptance_status,
              (SELECT COUNT(*)::int FROM acceptance_sign_offs
               WHERE bast_submission_attempt_id = $2) AS sign_offs
       FROM bast_documents b WHERE b.id = $1`,
      [hiddenBastId, hiddenAttemptId],
    );
    assert.deepEqual(hiddenDecisionState.rows, [
      { acceptance_status: 'SUBMITTED', sign_offs: 0 },
    ]);
  });
});
