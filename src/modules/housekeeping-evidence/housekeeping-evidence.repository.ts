import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  EvidenceType,
  PublicHousekeepingEvidenceRequirement,
  PublicHousekeepingEvidenceSubmission,
} from './housekeeping-evidence.types';

type EvidenceRequirementRow = {
  id: string;
  client_id: string;
  target_type: string;
  target_id: string;
  evidence_type: EvidenceType;
  required: boolean;
  minimum_count: number;
  maximum_count: number | null;
  description: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

type EvidenceSubmissionRow = {
  id: string;
  client_id: string;
  evidence_requirement_id: string | null;
  execution_type: string;
  execution_id: string;
  evidence_type: EvidenceType;
  file_reference: string;
  original_file_name: string;
  mime_type: string;
  file_size: string | number;
  captured_at: Date | null;
  submitted_by_user_id: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

function mapRequirementRow(
  row: EvidenceRequirementRow,
): PublicHousekeepingEvidenceRequirement {
  return {
    id: row.id,
    clientId: row.client_id,
    targetType: row.target_type,
    targetId: row.target_id,
    evidenceType: row.evidence_type,
    required: row.required,
    minimumCount: row.minimum_count,
    maximumCount: row.maximum_count,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapSubmissionRow(
  row: EvidenceSubmissionRow,
): PublicHousekeepingEvidenceSubmission {
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
    capturedAt: row.captured_at ? row.captured_at.toISOString() : null,
    submittedByUserId: row.submitted_by_user_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function findRequirements(
  targetType: string,
  targetId: string,
): Promise<PublicHousekeepingEvidenceRequirement[]> {
  const result = await getPool().query<EvidenceRequirementRow>(
    `SELECT * FROM evidence_requirements
     WHERE target_type = $1 AND target_id = $2 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [targetType, targetId],
  );
  return result.rows.map(mapRequirementRow);
}

export async function findRequirementById(
  id: string,
): Promise<EvidenceRequirementRow | null> {
  const result = await getPool().query<EvidenceRequirementRow>(
    `SELECT * FROM evidence_requirements WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function countActiveSubmissions(
  requirementId: string,
): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM evidence_submissions
     WHERE evidence_requirement_id = $1 AND status = 'ACTIVE'`,
    [requirementId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function createSubmission(input: {
  clientId: string;
  evidenceRequirementId: string | null;
  executionType: string;
  executionId: string;
  evidenceType: EvidenceType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt?: string | null;
  submittedByUserId: string;
}): Promise<PublicHousekeepingEvidenceSubmission> {
  const result = await getPool().query<EvidenceSubmissionRow>(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type,
        file_size, captured_at, submitted_by_user_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE')
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.evidenceRequirementId,
      input.executionType,
      input.executionId,
      input.evidenceType,
      input.fileReference,
      input.originalFileName,
      input.mimeType,
      input.fileSize,
      input.capturedAt ?? null,
      input.submittedByUserId,
    ],
  );
  return mapSubmissionRow(result.rows[0]);
}

export async function listSubmissions(
  executionType: string,
  executionId: string,
): Promise<PublicHousekeepingEvidenceSubmission[]> {
  const result = await getPool().query<EvidenceSubmissionRow>(
    `SELECT * FROM evidence_submissions
     WHERE execution_type = $1 AND execution_id = $2 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [executionType, executionId],
  );
  return result.rows.map(mapSubmissionRow);
}

export async function deactivateSubmission(id: string): Promise<void> {
  await getPool().query(
    `UPDATE evidence_submissions
     SET status = 'REMOVED', updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

export const housekeepingEvidenceRepository = {
  countActiveSubmissions,
  createSubmission,
  deactivateSubmission,
  findRequirementById,
  findRequirements,
  listSubmissions,
};
