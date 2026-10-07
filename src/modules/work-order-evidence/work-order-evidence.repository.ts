import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicWorkOrderEvidence,
  PublicWorkOrderEvidenceRequirement,
  SubmitWorkOrderEvidenceInput,
  WorkOrderEvidenceType,
} from './work-order-evidence.types';

type RequirementRow = {
  id: string;
  client_id: string;
  target_type: string;
  target_id: string;
  evidence_type: string;
  required: boolean;
  minimum_count: number;
  maximum_count: number | null;
  description: string | null;
  status: string;
};

type SubmissionRow = {
  id: string;
  client_id: string;
  evidence_requirement_id: string | null;
  execution_type: string;
  execution_id: string;
  evidence_type: string;
  file_reference: string;
  original_file_name: string;
  mime_type: string;
  file_size: string;
  captured_at: Date | null;
  submitted_by_user_id: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

function mapRequirement(row: RequirementRow): PublicWorkOrderEvidenceRequirement {
  return {
    id: row.id,
    clientId: row.client_id,
    workOrderId: row.target_id,
    evidenceType: row.evidence_type as WorkOrderEvidenceType,
    required: row.required,
    minimumCount: row.minimum_count,
    maximumCount: row.maximum_count,
    description: row.description,
    status: row.status,
  };
}

function mapSubmission(row: SubmissionRow): PublicWorkOrderEvidence {
  return {
    id: row.id,
    clientId: row.client_id,
    workOrderId: row.execution_id,
    evidenceRequirementId: row.evidence_requirement_id,
    evidenceType: row.evidence_type as WorkOrderEvidenceType,
    fileReference: row.file_reference,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    capturedAt: row.captured_at ? row.captured_at.toISOString() : null,
    submittedByUserId: row.submitted_by_user_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function listRequirementsForWorkOrder(
  workOrderId: string,
): Promise<PublicWorkOrderEvidenceRequirement[]> {
  const result = await getPool().query<RequirementRow>(
    `SELECT * FROM evidence_requirements
     WHERE target_type = 'WORK_ORDER' AND target_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [workOrderId],
  );
  return result.rows.map(mapRequirement);
}

async function findRequirementByIdForWorkOrder(
  workOrderId: string,
  requirementId: string,
): Promise<PublicWorkOrderEvidenceRequirement | null> {
  const result = await getPool().query<RequirementRow>(
    `SELECT * FROM evidence_requirements
     WHERE id = $1 AND target_type = 'WORK_ORDER' AND target_id = $2
       AND status = 'ACTIVE'`,
    [requirementId, workOrderId],
  );
  const row = result.rows[0];
  return row ? mapRequirement(row) : null;
}

async function listSubmissionsForWorkOrder(
  workOrderId: string,
): Promise<PublicWorkOrderEvidence[]> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT * FROM evidence_submissions
     WHERE execution_type = 'WORK_ORDER' AND execution_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [workOrderId],
  );
  return result.rows.map(mapSubmission);
}

async function findSubmissionById(
  evidenceId: string,
): Promise<PublicWorkOrderEvidence | null> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT * FROM evidence_submissions WHERE id = $1`,
    [evidenceId],
  );
  const row = result.rows[0];
  return row ? mapSubmission(row) : null;
}

async function countActiveSubmissionsForRequirement(
  requirementId: string,
): Promise<number> {
  const result = await getPool().query<{ n: string }>(
    `SELECT count(*)::int AS n FROM evidence_submissions
     WHERE evidence_requirement_id = $1 AND status = 'ACTIVE'`,
    [requirementId],
  );
  return Number(result.rows[0].n);
}

async function createSubmission(
  input: SubmitWorkOrderEvidenceInput,
): Promise<PublicWorkOrderEvidence> {
  const result = await getPool().query<SubmissionRow>(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type,
        file_size, captured_at, submitted_by_user_id)
     VALUES ($1, $2, $3, 'WORK_ORDER', $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.evidenceRequirementId ?? null,
      input.workOrderId,
      input.evidenceType,
      input.fileReference,
      input.originalFileName,
      input.mimeType,
      input.fileSize,
      input.capturedAt ? new Date(input.capturedAt) : null,
      input.submittedByUserId,
    ],
  );
  return mapSubmission(result.rows[0]);
}

async function removeSubmission(
  evidenceId: string,
): Promise<PublicWorkOrderEvidence | null> {
  const result = await getPool().query<SubmissionRow>(
    `UPDATE evidence_submissions SET status = 'REMOVED', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [evidenceId],
  );
  const row = result.rows[0];
  return row ? mapSubmission(row) : null;
}

export const workOrderEvidenceRepository = {
  countActiveSubmissionsForRequirement,
  createSubmission,
  findRequirementByIdForWorkOrder,
  findSubmissionById,
  listRequirementsForWorkOrder,
  listSubmissionsForWorkOrder,
  removeSubmission,
};
