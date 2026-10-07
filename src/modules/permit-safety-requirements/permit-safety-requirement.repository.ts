import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPermitSafetyRequirement,
  PermitSafetyReadinessStatus,
  PermitSafetyRequirementFilters,
  PermitSafetyRequirementRecord,
  UpdatePermitSafetyReadinessInput,
} from './permit-safety-requirement.types';

const SELECT = `
  sr.id,
  sr.permit_application_id AS "permitApplicationId",
  pa.permit_id AS "permitId",
  p.permit_number AS "permitReference",
  p.client_id AS "clientId",
  p.building_id AS "buildingId",
  pa.status AS "applicationStatus",
  sr.work_type AS "workType",
  pwc.work_type AS "currentWorkType",
  sr.requirement_type AS "requirementType",
  sr.requirement_description AS "requirementDescription",
  sr.required,
  sr.readiness_status AS "readinessStatus",
  sr.notes,
  sr.reference,
  sr.checklist_template_id AS "checklistTemplateId",
  sr.checklist_execution_id AS "checklistExecutionId",
  sr.evidence_requirement_id AS "evidenceRequirementId",
  sr.created_by_user_id AS "createdByUserId",
  sr.updated_by_user_id AS "updatedByUserId",
  sr.created_at AS "createdAt",
  sr.updated_at AS "updatedAt"
`;

const JOINS = `
  FROM permit_safety_requirements sr
  JOIN permit_applications pa ON pa.id = sr.permit_application_id
  JOIN permits p ON p.id = pa.permit_id
  LEFT JOIN permit_work_contexts pwc
    ON pwc.permit_application_id = pa.id
`;

async function create(
  input: NewPermitSafetyRequirement,
): Promise<PermitSafetyRequirementRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO permit_safety_requirements
       (id, permit_application_id, work_type, requirement_type,
        requirement_description, required, readiness_status, notes, reference,
        checklist_template_id, checklist_execution_id,
        evidence_requirement_id, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
    [
      id,
      input.permitApplicationId,
      input.workType,
      input.requirementType,
      input.requirementDescription,
      input.required,
      input.readinessStatus,
      input.notes,
      input.reference,
      input.checklistTemplateId,
      input.checklistExecutionId,
      input.evidenceRequirementId,
      input.actorUserId,
    ],
  );
  return (await findById(id)) as PermitSafetyRequirementRecord;
}

async function findById(
  id: string,
): Promise<PermitSafetyRequirementRecord | null> {
  const result = await getPool().query<PermitSafetyRequirementRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE sr.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByApplicationAndType(
  permitApplicationId: string,
  requirementType: string,
): Promise<PermitSafetyRequirementRecord | null> {
  const result = await getPool().query<PermitSafetyRequirementRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE sr.permit_application_id = $1 AND sr.requirement_type = $2`,
    [permitApplicationId, requirementType],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: PermitSafetyRequirementFilters,
  accessibleBuildingIds: string[],
): Promise<PermitSafetyRequirementRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['p.building_id = ANY($1::uuid[])'];

  if (filters.permitId) {
    values.push(filters.permitId);
    conditions.push(`p.id = $${values.length}`);
  }
  if (filters.permitApplicationId) {
    values.push(filters.permitApplicationId);
    conditions.push(`pa.id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.workType) {
    values.push(filters.workType);
    conditions.push(`sr.work_type = $${values.length}`);
  }
  if (filters.readinessStatus) {
    values.push(filters.readinessStatus);
    conditions.push(`sr.readiness_status = $${values.length}`);
  }

  const result = await getPool().query<PermitSafetyRequirementRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE ${conditions.join(' AND ')}
     ORDER BY sr.requirement_type, sr.created_at`,
    values,
  );
  return result.rows;
}

async function updateReadiness(
  id: string,
  input: UpdatePermitSafetyReadinessInput,
  actorUserId: string,
): Promise<PermitSafetyRequirementRecord | null> {
  const fields: [keyof Omit<UpdatePermitSafetyReadinessInput, 'readinessStatus'>, string][] = [
    ['notes', 'notes'],
    ['reference', 'reference'],
    ['checklistTemplateId', 'checklist_template_id'],
    ['checklistExecutionId', 'checklist_execution_id'],
    ['evidenceRequirementId', 'evidence_requirement_id'],
  ];
  const values: unknown[] = [input.readinessStatus];
  const sets = ['readiness_status = $1'];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  values.push(actorUserId);
  sets.push(`updated_by_user_id = $${values.length}`);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_safety_requirements SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING id`,
    values,
  );
  return result.rows[0] ? findById(result.rows[0].id) : null;
}

export type SharedChecklistTemplate = {
  id: string;
  clientId: string;
  status: string;
};
export type SharedChecklistExecution = {
  id: string;
  clientId: string;
  checklistTemplateId: string;
  status: string;
};
export type SharedEvidenceRequirement = {
  id: string;
  clientId: string;
  targetType: string;
  targetId: string;
  required: boolean;
  minimumCount: number;
  status: string;
};

async function findChecklistTemplate(
  id: string,
): Promise<SharedChecklistTemplate | null> {
  const result = await getPool().query<SharedChecklistTemplate>(
    `SELECT id, client_id AS "clientId", status
     FROM checklist_templates WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findChecklistExecution(
  id: string,
): Promise<SharedChecklistExecution | null> {
  const result = await getPool().query<SharedChecklistExecution>(
    `SELECT id, client_id AS "clientId",
       checklist_template_id AS "checklistTemplateId", status
     FROM checklist_executions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findEvidenceRequirement(
  id: string,
): Promise<SharedEvidenceRequirement | null> {
  const result = await getPool().query<SharedEvidenceRequirement>(
    `SELECT id, client_id AS "clientId", target_type AS "targetType",
       target_id AS "targetId", required, minimum_count AS "minimumCount", status
     FROM evidence_requirements WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findChecklistItemTemplateId(
  checklistItemId: string,
): Promise<string | null> {
  const result = await getPool().query<{ checklistTemplateId: string }>(
    `SELECT checklist_template_id AS "checklistTemplateId"
     FROM checklist_items WHERE id = $1`,
    [checklistItemId],
  );
  return result.rows[0]?.checklistTemplateId ?? null;
}

async function countEvidence(
  evidenceRequirementId: string,
  checklistExecutionId: string,
): Promise<number> {
  const result = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM evidence_submissions
     WHERE evidence_requirement_id = $1
       AND execution_type = 'CHECKLIST_EXECUTION'
       AND execution_id = $2
       AND status = 'ACTIVE'`,
    [evidenceRequirementId, checklistExecutionId],
  );
  return result.rows[0]?.count ?? 0;
}

async function existsForApplication(
  permitApplicationId: string,
): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM permit_safety_requirements
       WHERE permit_application_id = $1
     ) AS exists`,
    [permitApplicationId],
  );
  return result.rows[0]?.exists ?? false;
}

export const permitSafetyRequirementRepository = {
  countEvidence,
  create,
  existsForApplication,
  findByApplicationAndType,
  findById,
  findChecklistExecution,
  findChecklistItemTemplateId,
  findChecklistTemplate,
  findEvidenceRequirement,
  list,
  updateReadiness,
};
