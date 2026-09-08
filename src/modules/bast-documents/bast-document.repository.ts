import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  BastDocumentFilters,
  BastStatus,
  BastDocumentRecord,
} from './bast-document.types';

type Executor = Pick<PoolClient, 'query'>;

const SELECT = `
  bd.id,
  bd.document_id AS "documentId",
  bd.work_order_id AS "workOrderId",
  bd.vendor_work_id AS "vendorWorkId",
  bd.work_completion_document_id AS "workCompletionDocumentId",
  bd.vendor_id AS "vendorId",
  bd.completion_report_id AS "completionReportId",
  bd.service_report_id AS "serviceReportId",
  bd.acceptance_scope_type AS "acceptanceScopeType",
  wo.bast_requirement AS "bastRequirement",
  bd.client_id AS "clientId",
  bd.building_id AS "buildingId",
  bd.context_type AS "contextType",
  bd.bast_number AS "bastNumber",
  bd.bast_date AS "bastDate",
  bd.acceptance_status AS "acceptanceStatus",
  bd.notes,
  bd.file_reference AS "fileReference",
  bd.prepared_by_user_id AS "preparedByUserId",
  bd.submitted_by_user_id AS "submittedByUserId",
  bd.accepted_by_user_id AS "acceptedByUserId",
  bd.submitted_at AS "submittedAt",
  bd.accepted_at AS "acceptedAt",
  bd.created_at AS "createdAt",
  bd.updated_at AS "updatedAt"
`;

function toDateString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function mapRow(row: any): BastDocumentRecord {
  return {
    ...row,
    bastDate: toDateString(row.bastDate),
  };
}

export type BastSubmissionContextRecord = {
  documentVersionId: string;
  documentVersionNumber: number;
  documentClientId: string;
  documentBuildingId: string | null;
  documentType: string;
  documentStatus: string;
  workOrderClientId: string;
  workOrderBuildingId: string;
  workOrderStatus: string;
  vendorWorkOrderId: string | null;
  vendorWorkBuildingId: string | null;
  vendorWorkStatus: string | null;
  completionClientId: string | null;
  completionBuildingId: string | null;
  completionWorkOrderId: string | null;
  completionVendorWorkId: string | null;
  completionStatus: string | null;
  completionEvidenceReady: boolean | null;
  serviceClientId: string | null;
  serviceBuildingId: string | null;
  serviceWorkOrderId: string | null;
  serviceVendorWorkId: string | null;
  serviceCompletionReportId: string | null;
  serviceStatus: string | null;
  workCompletionClientId: string | null;
  workCompletionBuildingId: string | null;
  workCompletionWorkOrderId: string | null;
  workCompletionVendorWorkId: string | null;
};

export type BastSubmissionReviewRecord = {
  id: string;
  decision: string;
};

export type BastSubmissionEvidenceReadiness = {
  evidenceSubmissionIds: string[];
  requiredEvidenceReady: boolean;
};

export type BastResubmissionCorrectionRecord = {
  documentVersionNumber: number;
  findingId: string | null;
  findingStatus: string | null;
};

export type BastSubmissionAttemptRecord = {
  id: string;
  bastDocumentId: string;
  attemptNumber: number;
  documentVersionId: string;
  workCompletionDocumentId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  workOrderVerificationId: string | null;
  vendorWorkVerificationId: string | null;
  submittedByUserId: string;
  submittedAt: Date;
  readinessSnapshot: Record<string, unknown>;
  createdAt: Date;
};

const ATTEMPT_SELECT = `
  id,
  bast_document_id AS "bastDocumentId",
  attempt_number AS "attemptNumber",
  document_version_id AS "documentVersionId",
  work_completion_document_id AS "workCompletionDocumentId",
  completion_report_id AS "completionReportId",
  service_report_id AS "serviceReportId",
  work_order_verification_id AS "workOrderVerificationId",
  vendor_work_verification_id AS "vendorWorkVerificationId",
  submitted_by_user_id AS "submittedByUserId",
  submitted_at AS "submittedAt",
  readiness_snapshot AS "readinessSnapshot",
  created_at AS "createdAt"
`;

export async function create(input: {
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  workCompletionDocumentId: string | null;
  vendorId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  acceptanceScopeType: 'WORK_ORDER' | 'VENDOR_WORK';
  clientId: string;
  buildingId: string;
  contextType: string;
  bastNumber: string;
  bastDate: string;
  notes: string | null;
  fileReference: string | null;
  preparedByUserId: string;
}): Promise<BastDocumentRecord> {
  const result = await getPool().query(
    `INSERT INTO bast_documents
       (id, document_id, work_order_id, vendor_work_id, work_completion_document_id,
        vendor_id, completion_report_id, service_report_id, acceptance_scope_type,
        client_id, building_id, context_type, bast_number, bast_date, notes,
        file_reference, prepared_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      randomUUID(),
      input.documentId,
      input.workOrderId,
      input.vendorWorkId,
      input.workCompletionDocumentId,
      input.vendorId,
      input.completionReportId,
      input.serviceReportId,
      input.acceptanceScopeType,
      input.clientId,
      input.buildingId,
      input.contextType,
      input.bastNumber,
      input.bastDate,
      input.notes,
      input.fileReference,
      input.preparedByUserId,
    ],
  );
  const record = await findById(result.rows[0].id);
  if (!record) throw new Error('Created BAST document could not be reloaded.');
  return record;
}

export async function findById(
  id: string,
  executor: Executor = getPool(),
): Promise<BastDocumentRecord | null> {
  const result = await executor.query(
    `SELECT ${SELECT}
     FROM bast_documents bd
     JOIN work_orders wo ON wo.id = bd.work_order_id
     WHERE bd.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function findByIdForUpdate(
  id: string,
  executor: Executor,
): Promise<BastDocumentRecord | null> {
  const result = await executor.query(
    `SELECT ${SELECT}
     FROM bast_documents bd
     JOIN work_orders wo ON wo.id = bd.work_order_id
     WHERE bd.id = $1
     FOR UPDATE OF bd`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function findByDocumentId(documentId: string): Promise<BastDocumentRecord | null> {
  const result = await getPool().query(
    `SELECT ${SELECT}
     FROM bast_documents bd
     JOIN work_orders wo ON wo.id = bd.work_order_id
     WHERE bd.document_id = $1`,
    [documentId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function findByBastNumber(
  clientId: string,
  bastNumber: string,
): Promise<BastDocumentRecord | null> {
  const result = await getPool().query(
    `SELECT ${SELECT}
     FROM bast_documents bd
     JOIN work_orders wo ON wo.id = bd.work_order_id
     WHERE bd.client_id = $1 AND bd.bast_number = $2`,
    [clientId, bastNumber],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function findSubmissionContext(
  bastDocumentId: string,
  documentVersionId: string,
  executor: Executor,
): Promise<BastSubmissionContextRecord | null> {
  const result = await executor.query<BastSubmissionContextRecord>(
    `SELECT
       dv.id AS "documentVersionId",
       dv.version_number AS "documentVersionNumber",
       d.client_id AS "documentClientId",
       d.building_id AS "documentBuildingId",
       d.document_type AS "documentType",
       d.status AS "documentStatus",
       wo.client_id AS "workOrderClientId",
       wo.building_id AS "workOrderBuildingId",
       wo.status AS "workOrderStatus",
       vw.work_order_id AS "vendorWorkOrderId",
       vw.building_id AS "vendorWorkBuildingId",
       vw.status AS "vendorWorkStatus",
       vcr.client_id AS "completionClientId",
       vcr.building_id AS "completionBuildingId",
       vcr.work_order_id AS "completionWorkOrderId",
       vcr.vendor_work_id AS "completionVendorWorkId",
       vcr.completion_status AS "completionStatus",
       vcr.evidence_ready AS "completionEvidenceReady",
       vsr.client_id AS "serviceClientId",
       vsr.building_id AS "serviceBuildingId",
       vsr.work_order_id AS "serviceWorkOrderId",
       vsr.vendor_work_id AS "serviceVendorWorkId",
       vsr.completion_report_id AS "serviceCompletionReportId",
       vsr.status AS "serviceStatus",
       wcd.client_id AS "workCompletionClientId",
       wcd.building_id AS "workCompletionBuildingId",
       wcd.work_order_id AS "workCompletionWorkOrderId",
       wcd.vendor_work_id AS "workCompletionVendorWorkId"
     FROM bast_documents bd
     JOIN documents d ON d.id = bd.document_id
     JOIN document_versions dv
       ON dv.id = $2 AND dv.document_id = bd.document_id
     JOIN work_orders wo ON wo.id = bd.work_order_id
     LEFT JOIN vendor_works vw ON vw.id = bd.vendor_work_id
     LEFT JOIN vendor_completion_reports vcr ON vcr.id = bd.completion_report_id
     LEFT JOIN vendor_service_reports vsr ON vsr.id = bd.service_report_id
     LEFT JOIN work_completion_documents wcd
       ON wcd.id = bd.work_completion_document_id
     WHERE bd.id = $1`,
    [bastDocumentId, documentVersionId],
  );
  return result.rows[0] ?? null;
}

export async function findLatestCompletedReview(
  targetType: 'WORK_ORDER' | 'VENDOR_WORK',
  targetId: string,
  clientId: string,
  executor: Executor,
): Promise<BastSubmissionReviewRecord | null> {
  const result = await executor.query<BastSubmissionReviewRecord>(
    `SELECT id, decision
     FROM reviews
     WHERE target_type = $1
       AND target_id = $2
       AND client_id = $3
       AND status = 'COMPLETED'
     ORDER BY reviewed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [targetType, targetId, clientId],
  );
  return result.rows[0] ?? null;
}

export async function getSubmissionEvidenceReadiness(
  record: BastDocumentRecord,
  executor: Executor,
): Promise<BastSubmissionEvidenceReadiness> {
  const result = await executor.query<BastSubmissionEvidenceReadiness>(
    `SELECT
       ARRAY(
         SELECT es.id
         FROM evidence_submissions es
         WHERE es.client_id = $1
           AND es.status = 'ACTIVE'
           AND (
             (es.execution_type = 'WORK_ORDER' AND es.execution_id = $2)
             OR ($3::uuid IS NOT NULL
                 AND es.execution_type = 'VENDOR_WORK'
                 AND es.execution_id = $3)
           )
         ORDER BY es.created_at, es.id
       ) AS "evidenceSubmissionIds",
       NOT EXISTS (
         SELECT 1
         FROM evidence_requirements er
         WHERE er.client_id = $1
           AND er.status = 'ACTIVE'
           AND er.required = TRUE
           AND (
             (er.target_type = 'WORK_ORDER' AND er.target_id = $2)
             OR ($3::uuid IS NOT NULL
                 AND er.target_type = 'VENDOR_WORK'
                 AND er.target_id = $3)
           )
           AND (
             SELECT COUNT(*)
             FROM evidence_submissions es
             WHERE es.evidence_requirement_id = er.id
               AND es.client_id = $1
               AND es.status = 'ACTIVE'
               AND (
                 (er.target_type = 'WORK_ORDER'
                  AND es.execution_type = 'WORK_ORDER'
                  AND es.execution_id = $2)
                 OR
                 ($3::uuid IS NOT NULL
                  AND er.target_type = 'VENDOR_WORK'
                  AND es.execution_type = 'VENDOR_WORK'
                  AND es.execution_id = $3)
               )
           ) < er.minimum_count
       ) AS "requiredEvidenceReady"`,
    [record.clientId, record.workOrderId, record.vendorWorkId],
  );
  return result.rows[0];
}

export async function hasOpenVendorRework(
  vendorWorkId: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM vendor_rework_cycles
       WHERE vendor_work_id = $1 AND status = 'REQUESTED'
     ) AS "exists"`,
    [vendorWorkId],
  );
  return result.rows[0].exists;
}

export async function hasOpenReconciliationQuarantine(
  bastDocumentId: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM bast_reconciliation_quarantines
       WHERE bast_document_id = $1 AND status = 'OPEN'
     ) AS "exists"`,
    [bastDocumentId],
  );
  return result.rows[0].exists;
}

export async function hasOpenFinding(
  bastDocumentId: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM bast_finding_links bfl
       JOIN findings f ON f.id = bfl.finding_id
       WHERE bfl.bast_document_id = $1
         AND f.status NOT IN ('CLOSED', 'CANCELLED')
     ) AS "exists"`,
    [bastDocumentId],
  );
  return result.rows[0].exists;
}

export async function createSubmissionAttempt(
  input: {
    bast: BastDocumentRecord;
    documentVersionId: string;
    workOrderVerificationId: string | null;
    vendorWorkVerificationId: string | null;
    submittedByUserId: string;
    readinessSnapshot: Record<string, unknown>;
  },
  executor: Executor,
): Promise<BastSubmissionAttemptRecord> {
  const result = await executor.query<BastSubmissionAttemptRecord>(
    `INSERT INTO bast_submission_attempts
       (id, bast_document_id, attempt_number, document_version_id,
        work_completion_document_id, completion_report_id, service_report_id,
        work_order_verification_id, vendor_work_verification_id,
        readiness_snapshot, submitted_by_user_id)
     SELECT $1, $2, COALESCE(MAX(attempt_number), 0) + 1, $3,
            $4, $5, $6, $7, $8, $9, $10
     FROM bast_submission_attempts
     WHERE bast_document_id = $2
     RETURNING ${ATTEMPT_SELECT}`,
    [
      randomUUID(),
      input.bast.id,
      input.documentVersionId,
      input.bast.workCompletionDocumentId,
      input.bast.completionReportId,
      input.bast.serviceReportId,
      input.workOrderVerificationId,
      input.vendorWorkVerificationId,
      input.readinessSnapshot,
      input.submittedByUserId,
    ],
  );
  return result.rows[0];
}

export async function addSubmissionAttemptEvidence(
  attemptId: string,
  evidenceSubmissionIds: string[],
  executor: Executor,
): Promise<void> {
  for (const evidenceSubmissionId of evidenceSubmissionIds) {
    await executor.query(
      `INSERT INTO bast_submission_attempt_evidence
         (submission_attempt_id, evidence_submission_id)
       VALUES ($1, $2)`,
      [attemptId, evidenceSubmissionId],
    );
  }
}

export async function findCurrentSubmissionAttemptForUpdate(
  bastDocumentId: string,
  executor: Executor,
): Promise<BastSubmissionAttemptRecord | null> {
  const result = await executor.query<BastSubmissionAttemptRecord>(
    `SELECT ${ATTEMPT_SELECT}
     FROM bast_submission_attempts
     WHERE bast_document_id = $1
     ORDER BY attempt_number DESC
     LIMIT 1
     FOR UPDATE`,
    [bastDocumentId],
  );
  return result.rows[0] ?? null;
}

export async function findResubmissionCorrection(
  bastDocumentId: string,
  executor: Executor,
): Promise<BastResubmissionCorrectionRecord | null> {
  const result = await executor.query<BastResubmissionCorrectionRecord>(
    `SELECT
       dv.version_number AS "documentVersionNumber",
       f.id AS "findingId",
       f.status AS "findingStatus"
     FROM bast_submission_attempts bsa
     JOIN document_versions dv ON dv.id = bsa.document_version_id
     LEFT JOIN bast_finding_links bfl
       ON bfl.bast_submission_attempt_id = bsa.id
     LEFT JOIN findings f ON f.id = bfl.finding_id
     WHERE bsa.bast_document_id = $1
     ORDER BY bsa.attempt_number DESC, bfl.linked_at DESC NULLS LAST
     LIMIT 1`,
    [bastDocumentId],
  );
  return result.rows[0] ?? null;
}

export async function transitionAcceptanceStatus(
  id: string,
  from: BastStatus,
  to: BastStatus,
  actorUserId: string,
  executor: Executor,
): Promise<BastDocumentRecord | null> {
  const actorColumns =
    to === 'SUBMITTED'
      ? `submitted_by_user_id = $4, submitted_at = NOW(),
         accepted_by_user_id = NULL, accepted_at = NULL,`
      : 'accepted_by_user_id = $4, accepted_at = NOW(),';
  const result = await executor.query(
    `UPDATE bast_documents
     SET acceptance_status = $3,
         ${actorColumns}
         updated_at = NOW()
     WHERE id = $1 AND acceptance_status = $2
     RETURNING id`,
    [id, from, to, actorUserId],
  );
  if (!result.rows[0]) return null;
  return findById(id, executor);
}

export async function createFindingLink(
  input: {
    bastDocumentId: string;
    attemptId: string;
    acceptanceSignOffId: string;
    findingId: string;
    actorUserId: string;
    metadata: Record<string, unknown>;
  },
  executor: Executor,
): Promise<void> {
  await executor.query(
    `INSERT INTO bast_finding_links
       (id, bast_document_id, bast_submission_attempt_id,
        acceptance_sign_off_id, finding_id, linked_by_user_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      input.bastDocumentId,
      input.attemptId,
      input.acceptanceSignOffId,
      input.findingId,
      input.actorUserId,
      input.metadata,
    ],
  );
}

export async function list(
  filters: BastDocumentFilters,
  accessibleBuildingIds: string[],
  accessibleClientIds: string[],
): Promise<BastDocumentRecord[]> {
  if (accessibleBuildingIds.length === 0 && accessibleClientIds.length === 0) return [];
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(accessibleBuildingIds);
  const buildingListParam = `$${values.length}`;
  values.push(accessibleClientIds);
  const clientListParam = `$${values.length}`;
  clauses.push(`(
    (bd.building_id = ANY(${buildingListParam}::uuid[]))
    OR (bd.building_id IS NULL AND bd.client_id = ANY(${clientListParam}::uuid[]))
  )`);

  if (filters.clientId) { values.push(filters.clientId); clauses.push(`bd.client_id = $${values.length}`); }
  if (filters.buildingId) { values.push(filters.buildingId); clauses.push(`bd.building_id = $${values.length}`); }
  if (filters.workOrderId) { values.push(filters.workOrderId); clauses.push(`bd.work_order_id = $${values.length}`); }
  if (filters.vendorWorkId) { values.push(filters.vendorWorkId); clauses.push(`bd.vendor_work_id = $${values.length}`); }
  if (filters.workCompletionDocumentId) { values.push(filters.workCompletionDocumentId); clauses.push(`bd.work_completion_document_id = $${values.length}`); }
  if (filters.contextType) { values.push(filters.contextType); clauses.push(`bd.context_type = $${values.length}`); }
  if (filters.acceptanceStatus) { values.push(filters.acceptanceStatus); clauses.push(`bd.acceptance_status = $${values.length}`); }
  if (filters.bastNumber) { values.push(filters.bastNumber); clauses.push(`bd.bast_number = $${values.length}`); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getPool().query(
    `SELECT ${SELECT}
     FROM bast_documents bd
     JOIN work_orders wo ON wo.id = bd.work_order_id
     ${where}
     ORDER BY bd.created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export const bastDocumentRepository = {
  addSubmissionAttemptEvidence,
  create,
  createFindingLink,
  createSubmissionAttempt,
  findByBastNumber,
  findByDocumentId,
  findById,
  findByIdForUpdate,
  findCurrentSubmissionAttemptForUpdate,
  findLatestCompletedReview,
  findResubmissionCorrection,
  findSubmissionContext,
  getSubmissionEvidenceReadiness,
  hasOpenFinding,
  hasOpenReconciliationQuarantine,
  hasOpenVendorRework,
  list,
  transitionAcceptanceStatus,
};
