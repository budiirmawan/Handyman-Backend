import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreatePermitEvidenceRequirementInput,
  PermitEvidenceFilters,
  PermitEvidenceType,
  PublicPermitEvidence,
  PublicPermitEvidenceRequirement,
  SubmitPermitEvidenceInput,
} from './permit-evidence.types';

type RequirementRow = {
  id: string; client_id: string; target_id: string; evidence_type: string;
  required: boolean; minimum_count: number; maximum_count: number | null;
  description: string | null; status: string; created_at: Date; updated_at: Date;
  permit_number: string; building_id: string; contractor_context_type: string;
  contractor_vendor_id: string;
};
type SubmissionRow = {
  id: string; client_id: string; evidence_requirement_id: string | null;
  execution_id: string; evidence_type: string; file_reference: string;
  original_file_name: string; mime_type: string; file_size: string;
  captured_at: Date | null; submitted_by_user_id: string | null;
  status: 'ACTIVE' | 'REMOVED'; created_at: Date; updated_at: Date;
  permit_number: string; building_id: string; contractor_context_type: string;
  contractor_vendor_id: string;
};

function mapRequirement(row: RequirementRow): PublicPermitEvidenceRequirement {
  return {
    id: row.id,
    clientId: row.client_id,
    permitId: row.target_id,
    permitReference: row.permit_number,
    buildingId: row.building_id,
    contractorContextType: row.contractor_context_type as PublicPermitEvidenceRequirement['contractorContextType'],
    contractorVendorId: row.contractor_vendor_id,
    evidenceType: row.evidence_type as PermitEvidenceType,
    required: row.required,
    minimumCount: row.minimum_count,
    maximumCount: row.maximum_count,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
function mapSubmission(row: SubmissionRow): PublicPermitEvidence {
  return {
    id: row.id,
    clientId: row.client_id,
    permitId: row.execution_id,
    permitReference: row.permit_number,
    buildingId: row.building_id,
    contractorContextType: row.contractor_context_type as PublicPermitEvidence['contractorContextType'],
    contractorVendorId: row.contractor_vendor_id,
    evidenceRequirementId: row.evidence_requirement_id,
    evidenceType: row.evidence_type as PermitEvidenceType,
    fileReference: row.file_reference,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    capturedAt: row.captured_at?.toISOString() ?? null,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: row.created_at.toISOString(),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const REQUIREMENT_SELECT = `er.*, p.permit_number, p.building_id,
  p.contractor_context_type, p.contractor_vendor_id`;
const SUBMISSION_SELECT = `es.*, p.permit_number, p.building_id,
  p.contractor_context_type, p.contractor_vendor_id`;

async function createRequirement(
  permitId: string,
  clientId: string,
  input: CreatePermitEvidenceRequirementInput,
): Promise<PublicPermitEvidenceRequirement> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO evidence_requirements
       (id, client_id, target_type, target_id, evidence_type, required,
        minimum_count, maximum_count, description, status)
     VALUES ($1,$2,'PERMIT',$3,$4,$5,$6,$7,$8,'ACTIVE')`,
    [id, clientId, permitId, input.evidenceType, input.required,
      input.minimumCount, input.maximumCount, input.description ?? null],
  );
  return (await findRequirementForPermit(permitId, id))!;
}
async function findRequirementForPermit(
  permitId: string,
  requirementId: string,
): Promise<PublicPermitEvidenceRequirement | null> {
  const result = await getPool().query<RequirementRow>(
    `SELECT ${REQUIREMENT_SELECT}
     FROM evidence_requirements er JOIN permits p ON p.id=er.target_id
     WHERE er.id=$1 AND er.target_type='PERMIT' AND er.target_id=$2
       AND er.status='ACTIVE'`,
    [requirementId, permitId],
  );
  return result.rows[0] ? mapRequirement(result.rows[0]) : null;
}
async function listRequirements(permitId: string): Promise<PublicPermitEvidenceRequirement[]> {
  const result = await getPool().query<RequirementRow>(
    `SELECT ${REQUIREMENT_SELECT}
     FROM evidence_requirements er JOIN permits p ON p.id=er.target_id
     WHERE er.target_type='PERMIT' AND er.target_id=$1 AND er.status='ACTIVE'
     ORDER BY er.created_at,er.id`, [permitId],
  );
  return result.rows.map(mapRequirement);
}
async function countActive(requirementId: string): Promise<number> {
  const result = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM evidence_submissions
     WHERE evidence_requirement_id=$1 AND execution_type='PERMIT'
       AND status='ACTIVE'`, [requirementId],
  );
  return result.rows[0]?.count ?? 0;
}
async function createSubmission(
  permitId: string,
  clientId: string,
  input: SubmitPermitEvidenceInput,
  submittedByUserId: string,
): Promise<PublicPermitEvidence> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO evidence_submissions
       (id,client_id,evidence_requirement_id,execution_type,execution_id,
        evidence_type,file_reference,original_file_name,mime_type,file_size,
        captured_at,submitted_by_user_id,status)
     VALUES ($1,$2,$3,'PERMIT',$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE')`,
    [id, clientId, input.evidenceRequirementId, permitId, input.evidenceType,
      input.fileReference, input.originalFileName, input.mimeType,
      input.fileSize, input.capturedAt ?? null, submittedByUserId],
  );
  return (await findSubmissionById(id))!;
}
async function findSubmissionById(id: string): Promise<PublicPermitEvidence | null> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT ${SUBMISSION_SELECT}
     FROM evidence_submissions es JOIN permits p ON p.id=es.execution_id
     WHERE es.id=$1 AND es.execution_type='PERMIT'`, [id],
  );
  return result.rows[0] ? mapSubmission(result.rows[0]) : null;
}
async function listSubmissions(permitId: string, includeRemoved = false): Promise<PublicPermitEvidence[]> {
  const result = await getPool().query<SubmissionRow>(
    `SELECT ${SUBMISSION_SELECT}
     FROM evidence_submissions es JOIN permits p ON p.id=es.execution_id
     WHERE es.execution_type='PERMIT' AND es.execution_id=$1
       AND ($2::boolean OR es.status='ACTIVE')
     ORDER BY es.created_at,es.id`, [permitId, includeRemoved],
  );
  return result.rows.map(mapSubmission);
}
async function listByFilters(
  filters: PermitEvidenceFilters,
  buildingIds: string[],
): Promise<PublicPermitEvidence[]> {
  if (!buildingIds.length) return [];
  const values: unknown[] = [buildingIds];
  const conditions = ["es.execution_type='PERMIT'", 'p.building_id=ANY($1::uuid[])'];
  const fields: [keyof PermitEvidenceFilters, string][] = [
    ['permitId', 'p.id'], ['buildingId', 'p.building_id'],
    ['contractorVendorId', 'p.contractor_vendor_id'],
    ['evidenceType', 'es.evidence_type'], ['status', 'es.status'],
  ];
  for (const [key,column] of fields) if (filters[key] !== undefined) {
    values.push(filters[key]); conditions.push(`${column}=$${values.length}`);
  }
  const result = await getPool().query<SubmissionRow>(
    `SELECT ${SUBMISSION_SELECT}
     FROM evidence_submissions es JOIN permits p ON p.id=es.execution_id
     WHERE ${conditions.join(' AND ')} ORDER BY es.created_at,es.id`, values,
  );
  return result.rows.map(mapSubmission);
}
async function removeSubmission(id: string): Promise<PublicPermitEvidence | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE evidence_submissions SET status='REMOVED',updated_at=NOW()
     WHERE id=$1 AND execution_type='PERMIT' AND status='ACTIVE' RETURNING id`, [id],
  );
  return result.rows[0] ? findSubmissionById(id) : null;
}

export const permitEvidenceRepository = {
  countActive,
  createRequirement,
  createSubmission,
  findRequirementForPermit,
  findSubmissionById,
  listByFilters,
  listRequirements,
  listSubmissions,
  removeSubmission,
};
