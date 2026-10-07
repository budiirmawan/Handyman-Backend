import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PublicUtilityMeterReadingEvidence,
  PublicUtilityMeterReadingEvidenceRequirement,
  SubmitUtilityMeterReadingEvidenceInput,
  UtilityMeterReadingEvidenceType,
} from './utility-meter-reading-evidence.types';

/**
 * BE-18F — Reading Evidence repository.
 *
 * Reads/writes the shared BE-07 `evidence_requirements` and
 * `evidence_submissions` tables (target_type / execution_type =
 * 'UTILITY_METER_READING'). No utility evidence engine, no new tables, no
 * binaries in PostgreSQL — only the BE-07 `file_reference` pointer.
 */

const TARGET = 'UTILITY_METER_READING';

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
): PublicUtilityMeterReadingEvidenceRequirement {
  return {
    id: row.id,
    clientId: row.client_id,
    meterReadingId: row.target_id,
    evidenceType: row.evidence_type as UtilityMeterReadingEvidenceType,
    required: row.required,
    minimumCount: row.minimum_count,
    maximumCount: row.maximum_count,
    description: row.description,
    status: row.status,
  };
}

function mapSubmission(row: SubmissionRow): PublicUtilityMeterReadingEvidence {
  return {
    id: row.id,
    clientId: row.client_id,
    meterReadingId: row.execution_id,
    evidenceRequirementId: row.evidence_requirement_id,
    evidenceType: row.evidence_type as UtilityMeterReadingEvidenceType,
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

async function listRequirementsForReading(
  meterReadingId: string,
): Promise<PublicUtilityMeterReadingEvidenceRequirement[]> {
  const result = await getPool().query<RequirementRow>(
    `SELECT * FROM evidence_requirements
     WHERE target_type = $1 AND target_id = $2 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [TARGET, meterReadingId],
  );
  return result.rows.map(mapRequirement);
}

async function findRequirementByIdForReading(
  meterReadingId: string,
  requirementId: string,
): Promise<PublicUtilityMeterReadingEvidenceRequirement | null> {
  const result = await getPool().query<RequirementRow>(
    `SELECT * FROM evidence_requirements
     WHERE id = $1 AND target_type = $2 AND target_id = $3
       AND status = 'ACTIVE'`,
    [requirementId, TARGET, meterReadingId],
  );
  const row = result.rows[0];
  return row ? mapRequirement(row) : null;
}

/** ACTIVE submissions of one reading — the current evidence set. */
async function listSubmissionsForReading(
  meterReadingId: string,
): Promise<PublicUtilityMeterReadingEvidence[]> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT * FROM evidence_submissions
     WHERE execution_type = $1 AND execution_id = $2 AND status = 'ACTIVE'
     ORDER BY created_at ASC`,
    [TARGET, meterReadingId],
  );
  return result.rows.map(mapSubmission);
}

/**
 * Every submission of one reading including REMOVED rows — the preserved
 * evidence history. BE-07 soft-removes, so nothing is ever lost.
 */
async function listSubmissionHistoryForReading(
  meterReadingId: string,
): Promise<PublicUtilityMeterReadingEvidence[]> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT * FROM evidence_submissions
     WHERE execution_type = $1 AND execution_id = $2
     ORDER BY created_at ASC`,
    [TARGET, meterReadingId],
  );
  return result.rows.map(mapSubmission);
}

/**
 * Lists ACTIVE submissions scoped to the caller's accessible Building set,
 * optionally narrowed by reading / Meter / Building. The Building comes from
 * the authoritative BE-18E reading row, never from the evidence itself, and
 * the scoping happens in SQL rather than after the fetch.
 */
async function listSubmissions(input: {
  meterReadingId?: string;
  meterId?: string;
  buildingId?: string;
  buildingIds: string[];
}): Promise<PublicUtilityMeterReadingEvidence[]> {
  const conditions: string[] = [
    `es.execution_type = '${TARGET}'`,
    `es.status = 'ACTIVE'`,
  ];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`r.building_id = ANY($${values.length}::uuid[])`);

  if (input.meterReadingId) {
    values.push(input.meterReadingId);
    conditions.push(`es.execution_id = $${values.length}`);
  }
  if (input.meterId) {
    values.push(input.meterId);
    conditions.push(`r.meter_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`r.building_id = $${values.length}`);
  }

  const result = await getPool().query<SubmissionRow>(
    `SELECT es.*
     FROM evidence_submissions es
     JOIN utility_meter_readings r ON r.id = es.execution_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY es.created_at ASC`,
    values,
  );
  return result.rows.map(mapSubmission);
}

async function findSubmissionById(
  evidenceId: string,
): Promise<PublicUtilityMeterReadingEvidence | null> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT * FROM evidence_submissions WHERE id = $1 AND execution_type = $2`,
    [evidenceId, TARGET],
  );
  const row = result.rows[0];
  return row ? mapSubmission(row) : null;
}

async function countActiveSubmissionsForRequirement(
  requirementId: string,
): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM evidence_submissions
     WHERE evidence_requirement_id = $1 AND status = 'ACTIVE'`,
    [requirementId],
  );
  return Number(result.rows[0].n);
}

async function createSubmission(
  input: SubmitUtilityMeterReadingEvidenceInput & { clientId: string },
): Promise<PublicUtilityMeterReadingEvidence> {
  const result = await getPool().query<SubmissionRow>(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type,
        file_size, captured_at, submitted_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.evidenceRequirementId ?? null,
      TARGET,
      input.meterReadingId,
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

/** BE-07 soft-remove: status → 'REMOVED'. The row itself is preserved. */
async function removeSubmission(
  evidenceId: string,
): Promise<PublicUtilityMeterReadingEvidence | null> {
  const result = await getPool().query<SubmissionRow>(
    `UPDATE evidence_submissions SET status = 'REMOVED', updated_at = NOW()
     WHERE id = $1 AND execution_type = $2
     RETURNING *`,
    [evidenceId, TARGET],
  );
  const row = result.rows[0];
  return row ? mapSubmission(row) : null;
}

export const utilityMeterReadingEvidenceRepository = {
  countActiveSubmissionsForRequirement,
  createSubmission,
  findRequirementByIdForReading,
  findSubmissionById,
  listRequirementsForReading,
  listSubmissionHistoryForReading,
  listSubmissions,
  listSubmissionsForReading,
  removeSubmission,
};
