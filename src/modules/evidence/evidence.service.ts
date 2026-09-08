import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';

/**
 * BE-07 evidence submission logic extracted as the single shared service used
 * by BOTH the REST submission endpoint and the BE-25G offline sync batch —
 * the sync contract never re-implements business rules.
 */

const EVIDENCE_TYPES = ['PHOTO', 'DOCUMENT', 'SIGNATURE'] as const;
const EXECUTION_TYPES = [
  'FORM_INSTANCE',
  'CHECKLIST_EXECUTION',
  'FINDING',
  'FINDING_REWORK',
  'FINDING_VERIFICATION',
] as const;

export type EvidenceSubmissionRow = Record<string, unknown>;

export function toPublicEvidence(row: Record<string, unknown>) {
  return {
    id: row.id,
    clientId: row.client_id,
    evidenceRequirementId: row.evidence_requirement_id,
    executionType: row.execution_type,
    executionId: row.execution_id,
    evidenceType: row.evidence_type,
    fileReference: row.file_reference,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    capturedAt: row.captured_at,
    submittedByUserId: row.submitted_by_user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // CR-BE-DOC-CONTROL-01 PART 05 — additive integrity metadata (PART 01/02).
    contentSha256: row.content_sha256 ?? null,
    contentHashedAt: row.content_hashed_at ?? null,
    hashAlgorithm: row.hash_algorithm ?? null,
    lastIntegrityStatus: row.last_integrity_status ?? null,
    lastIntegrityCheckedAt: row.last_integrity_checked_at ?? null,
    // CR-BE-DOC-CONTROL-01 PART 05 — additive retention snapshot/state (PART 03/04).
    retentionPolicyId: row.retention_policy_id ?? null,
    retentionPolicyCode: row.retention_policy_code ?? null,
    retentionDaysSnapshot: row.retention_days_snapshot ?? null,
    retentionAppliedAt: row.retention_applied_at ?? null,
    retainedUntil: row.retained_until ?? null,
    retentionState: row.retention_state ?? 'ACTIVE',
    retentionHold: row.retention_hold ?? false,
    retentionHoldReason: row.retention_hold_reason ?? null,
    purgedAt: row.purged_at ?? null,
  };
}

/** Loads an execution and enforces the BE-02G accessible-Client scope. */
export async function loadEvidenceExecution(
  executionType: string,
  executionId: string,
  userId: string,
): Promise<{ client_id: string; status: string }> {
  let result;
  if (executionType === 'FORM_INSTANCE' || executionType === 'CHECKLIST_EXECUTION') {
    const table = executionType === 'FORM_INSTANCE' ? 'form_instances' : 'checklist_executions';
    result = await getPool().query<{ client_id: string; status: string; building_id?: string }>(
      `SELECT client_id, status, NULL::uuid AS building_id FROM ${table} WHERE id = $1`,
      [executionId],
    );
  } else if (executionType === 'FINDING') {
    result = await getPool().query<{ client_id: string; status: string; building_id: string }>(
      `SELECT client_id, status, building_id FROM findings WHERE id = $1`, [executionId]);
  } else if (executionType === 'FINDING_REWORK') {
    result = await getPool().query<{ client_id: string; status: string; building_id: string }>(
      `SELECT f.client_id, r.status, f.building_id
       FROM finding_rework_cycles r JOIN findings f ON f.id = r.finding_id WHERE r.id = $1`, [executionId]);
  } else {
    result = await getPool().query<{ client_id: string; status: string; building_id: string }>(
      `SELECT f.client_id, r.status, f.building_id
       FROM reviews r JOIN findings f ON f.id = r.target_id
       WHERE r.id = $1 AND r.target_type = 'FINDING'`, [executionId]);
  }
  const row = result.rows[0];
  if (!row) {
    throw AppError.badRequest('Execution does not exist.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) throw buildingAccessDeniedError();
  if (row.building_id) {
    const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
    if (!buildingIds.includes(row.building_id)) throw buildingAccessDeniedError();
  }
  return row;
}

export type SubmitEvidenceMetadataInput = Record<string, unknown>;

/**
 * Creates an evidence submission (metadata contract), with the exact
 * validation of the submission endpoint: body shape, execution existence +
 * scope, terminal execution, requirement type/client/count, and MIME
 * alignment with the evidence type.
 */
export async function submitEvidenceMetadata(
  body: SubmitEvidenceMetadataInput,
  userId: string,
): Promise<ReturnType<typeof toPublicEvidence>> {
  const evidenceType = body.evidenceType;
  const executionType = body.executionType;
  const executionId = body.executionId;

  if (
    typeof evidenceType !== 'string' ||
    !EVIDENCE_TYPES.includes(evidenceType as (typeof EVIDENCE_TYPES)[number]) ||
    typeof executionType !== 'string' ||
    !EXECUTION_TYPES.includes(executionType as (typeof EXECUTION_TYPES)[number]) ||
    typeof executionId !== 'string' ||
    !body.fileReference ||
    !body.originalFileName ||
    !body.mimeType ||
    !Number.isInteger(body.fileSize) ||
    (body.fileSize as number) < 0 ||
    (body.fileSize as number) > 52428800
  ) {
    throw AppError.validation();
  }

  const execution = await loadEvidenceExecution(
    executionType as string,
    executionId as string,
    userId,
  );
  if (execution.status === 'COMPLETED' || execution.status === 'CANCELLED') {
    throw AppError.badRequest('Terminal execution cannot receive evidence.');
  }

  let requirement: EvidenceSubmissionRow | null = null;
  if (body.evidenceRequirementId) {
    const requirementResult = await getPool().query<EvidenceSubmissionRow>(
      `SELECT * FROM evidence_requirements WHERE id = $1 AND status = 'ACTIVE'`,
      [body.evidenceRequirementId],
    );
    requirement = requirementResult.rows[0] ?? null;
    if (!requirement) {
      throw AppError.badRequest('Evidence requirement does not exist.');
    }
    if (requirement.evidence_type !== evidenceType) {
      throw AppError.badRequest('Evidence type does not match requirement.');
    }
    if (requirement.client_id !== execution.client_id) {
      throw AppError.badRequest('Evidence requirement client mismatch.');
    }
  }

  const allowed =
    evidenceType === 'PHOTO'
      ? ['image/jpeg', 'image/png', 'image/webp']
      : evidenceType === 'SIGNATURE'
        ? ['image/png', 'image/svg+xml']
        : ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowed.includes(body.mimeType as string)) {
    throw AppError.badRequest('Unsupported evidence MIME type.');
  }

  if (requirement && requirement.maximum_count !== null) {
    const count = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM evidence_submissions
        WHERE evidence_requirement_id = $1 AND status = 'ACTIVE'`,
      [requirement.id],
    );
    if (count.rows[0].n >= (requirement.maximum_count as number)) {
      throw AppError.badRequest('Evidence maximum count exceeded.');
    }
  }

  const inserted = await getPool().query<EvidenceSubmissionRow>(
    `INSERT INTO evidence_submissions (
       id, client_id, evidence_requirement_id, execution_type, execution_id,
       evidence_type, file_reference, original_file_name, mime_type,
       file_size, captured_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      randomUUID(),
      execution.client_id,
      requirement?.id ?? null,
      executionType,
      executionId,
      evidenceType,
      body.fileReference,
      body.originalFileName,
      body.mimeType,
      body.fileSize,
      body.capturedAt ?? null,
      userId,
    ],
  );
  // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance at creation.
  await applyRetentionToEvidence(inserted.rows[0].id as string, userId);
  return toPublicEvidence(inserted.rows[0]);
}

export const evidenceSubmissionService = {
  loadEvidenceExecution,
  submitEvidenceMetadata,
  toPublicEvidence,
};
