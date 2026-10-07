import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicVendorWorkEvidence,
  PublicVendorWorkEvidenceRequirement,
  SubmitVendorWorkEvidenceInput,
  VendorWorkEvidenceType,
} from './vendor-work-evidence.types';

/**
 * BE-15E — Vendor Work Evidence Binding repository.
 *
 * Reads/writes the shared BE-07 `evidence_requirements` and
 * `evidence_submissions` tables (target_type / execution_type =
 * 'VENDOR_WORK'). No Vendor evidence engine, no new tables.
 */

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

function mapRequirement(
  row: RequirementRow,
): PublicVendorWorkEvidenceRequirement {
  return {
    id: row.id,
    clientId: row.client_id,
    vendorWorkId: row.target_id,
    evidenceType: row.evidence_type as VendorWorkEvidenceType,
    required: row.required,
    minimumCount: row.minimum_count,
    maximumCount: row.maximum_count,
    description: row.description,
    status: row.status,
  };
}

function mapSubmission(row: SubmissionRow): PublicVendorWorkEvidence {
  return {
    id: row.id,
    clientId: row.client_id,
    vendorWorkId: row.execution_id,
    evidenceRequirementId: row.evidence_requirement_id,
    evidenceType: row.evidence_type as VendorWorkEvidenceType,
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

async function listRequirementsForVendorWork(
  vendorWorkId: string,
): Promise<PublicVendorWorkEvidenceRequirement[]> {
  const result = await getPool().query<RequirementRow>(
    `SELECT * FROM evidence_requirements
     WHERE target_type = 'VENDOR_WORK' AND target_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [vendorWorkId],
  );
  return result.rows.map(mapRequirement);
}

async function findRequirementByIdForVendorWork(
  vendorWorkId: string,
  requirementId: string,
): Promise<PublicVendorWorkEvidenceRequirement | null> {
  const result = await getPool().query<RequirementRow>(
    `SELECT * FROM evidence_requirements
     WHERE id = $1 AND target_type = 'VENDOR_WORK' AND target_id = $2
       AND status = 'ACTIVE'`,
    [requirementId, vendorWorkId],
  );
  const row = result.rows[0];
  return row ? mapRequirement(row) : null;
}

async function listSubmissionsForVendorWork(
  vendorWorkId: string,
): Promise<PublicVendorWorkEvidence[]> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT * FROM evidence_submissions
     WHERE execution_type = 'VENDOR_WORK' AND execution_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [vendorWorkId],
  );
  return result.rows.map(mapSubmission);
}

/**
 * Lists ACTIVE submissions scoped to the caller's accessible Building set,
 * optionally narrowed by Vendor Work / Vendor (via `vendor_works`) /
 * Building. The accessible Building set is resolved by the service (BE-02G).
 */
async function listSubmissions(input: {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
  buildingIds: string[];
}): Promise<PublicVendorWorkEvidence[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  conditions.push(`es.execution_type = 'VENDOR_WORK'`);
  conditions.push(`es.status = 'ACTIVE'`);

  values.push(input.buildingIds);
  conditions.push(`vw.building_id = ANY($${values.length})`);

  if (input.vendorWorkId) {
    values.push(input.vendorWorkId);
    conditions.push(`es.execution_id = $${values.length}`);
  }
  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`vw.building_id = $${values.length}`);
  }

  const result = await getPool().query<SubmissionRow>(
    `SELECT es.*
     FROM evidence_submissions es
     JOIN vendor_works vw ON vw.id = es.execution_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY es.created_at ASC`,
    values,
  );
  return result.rows.map(mapSubmission);
}

async function findSubmissionById(
  evidenceId: string,
): Promise<PublicVendorWorkEvidence | null> {
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
  input: SubmitVendorWorkEvidenceInput,
): Promise<PublicVendorWorkEvidence> {
  const result = await getPool().query<SubmissionRow>(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type,
        file_size, captured_at, submitted_by_user_id)
     VALUES ($1, $2, $3, 'VENDOR_WORK', $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.evidenceRequirementId ?? null,
      input.vendorWorkId,
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
): Promise<PublicVendorWorkEvidence | null> {
  const result = await getPool().query<SubmissionRow>(
    `UPDATE evidence_submissions SET status = 'REMOVED', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [evidenceId],
  );
  const row = result.rows[0];
  return row ? mapSubmission(row) : null;
}

export const vendorWorkEvidenceRepository = {
  countActiveSubmissionsForRequirement,
  createSubmission,
  findRequirementByIdForVendorWork,
  findSubmissionById,
  listRequirementsForVendorWork,
  listSubmissions,
  listSubmissionsForVendorWork,
  removeSubmission,
};
