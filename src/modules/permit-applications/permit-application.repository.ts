import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPermitApplication,
  PermitApplicationFilters,
  PermitApplicationRecord,
  UpdatePermitApplicationInput,
} from './permit-application.types';

const SELECT = `
  a.id,
  a.permit_id AS "permitId",
  p.permit_number AS "permitReference",
  p.status AS "permitStatus",
  p.client_id AS "clientId",
  p.building_id AS "buildingId",
  p.applicant_reference AS "applicantReference",
  p.contractor_context_type AS "contractorContextType",
  COALESCE(
    p.tenant_contractor_relationship_id,
    p.contractor_vendor_id
  ) AS "contractorContextId",
  p.contractor_vendor_id AS "contractorVendorId",
  p.tenant_contractor_relationship_id AS "tenantContractorRelationshipId",
  p.work_description AS "workDescription",
  a.requested_work_at AS "requestedWorkAt",
  a.status,
  a.submitted_at AS "submittedAt",
  a.submitted_by_user_id AS "submittedByUserId",
  a.notes,
  a.created_by_user_id AS "createdByUserId",
  a.cancelled_at AS "cancelledAt",
  a.cancelled_by_user_id AS "cancelledByUserId",
  a.created_at AS "createdAt",
  a.updated_at AS "updatedAt"
`;

async function create(
  input: NewPermitApplication,
): Promise<PermitApplicationRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO permit_applications
       (id, permit_id, requested_work_at, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      input.permitId,
      input.requestedWorkAt,
      input.notes,
      input.createdByUserId,
    ],
  );
  return (await findById(id)) as PermitApplicationRecord;
}

async function findById(id: string): Promise<PermitApplicationRecord | null> {
  const result = await getPool().query<PermitApplicationRecord>(
    `SELECT ${SELECT}
     FROM permit_applications a
     JOIN permits p ON p.id = a.permit_id
     WHERE a.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByPermitId(
  permitId: string,
): Promise<PermitApplicationRecord | null> {
  const result = await getPool().query<PermitApplicationRecord>(
    `SELECT ${SELECT}
     FROM permit_applications a
     JOIN permits p ON p.id = a.permit_id
     WHERE a.permit_id = $1`,
    [permitId],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: PermitApplicationFilters,
  accessibleBuildingIds: string[],
): Promise<PermitApplicationRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['p.building_id = ANY($1::uuid[])'];

  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.contractorVendorId) {
    values.push(filters.contractorVendorId);
    conditions.push(`p.contractor_vendor_id = $${values.length}`);
  }
  if (filters.contractorContextId) {
    values.push(filters.contractorContextId);
    conditions.push(`(
      p.contractor_vendor_id = $${values.length}
      OR p.tenant_contractor_relationship_id = $${values.length}
    )`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`a.status = $${values.length}`);
  }
  if (filters.requestedWorkFrom) {
    values.push(filters.requestedWorkFrom);
    conditions.push(`a.requested_work_at >= $${values.length}`);
  }
  if (filters.requestedWorkTo) {
    values.push(filters.requestedWorkTo);
    conditions.push(`a.requested_work_at <= $${values.length}`);
  }
  if (filters.requestedWorkDate) {
    values.push(filters.requestedWorkDate);
    conditions.push(`a.requested_work_at::date = $${values.length}::date`);
  }

  const result = await getPool().query<PermitApplicationRecord>(
    `SELECT ${SELECT}
     FROM permit_applications a
     JOIN permits p ON p.id = a.permit_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.requested_work_at, a.created_at`,
    values,
  );
  return result.rows;
}

async function updateDraft(
  id: string,
  input: UpdatePermitApplicationInput,
): Promise<PermitApplicationRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  if (input.requestedWorkAt !== undefined) {
    values.push(input.requestedWorkAt);
    sets.push(`requested_work_at = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_applications SET ${sets.join(', ')}
     WHERE id = $${values.length} AND status = 'DRAFT'
     RETURNING id`,
    values,
  );
  return result.rows[0] ? findById(result.rows[0].id) : null;
}

async function submitDraft(
  id: string,
  actorUserId: string,
): Promise<PermitApplicationRecord | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_applications
     SET status = 'SUBMITTED', submitted_at = NOW(),
         submitted_by_user_id = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING id`,
    [id, actorUserId],
  );
  return result.rows[0] ? findById(result.rows[0].id) : null;
}

async function cancel(
  id: string,
  actorUserId: string,
): Promise<PermitApplicationRecord | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE permit_applications
     SET status = 'CANCELLED', cancelled_at = NOW(),
         cancelled_by_user_id = $2, updated_at = NOW()
     WHERE id = $1 AND status IN ('DRAFT', 'SUBMITTED')
     RETURNING id`,
    [id, actorUserId],
  );
  return result.rows[0] ? findById(result.rows[0].id) : null;
}

async function hasSubmittedForPermit(permitId: string): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM permit_applications
       WHERE permit_id = $1 AND submitted_at IS NOT NULL
     ) AS exists`,
    [permitId],
  );
  return result.rows[0]?.exists ?? false;
}

export const permitApplicationRepository = {
  cancel,
  create,
  findById,
  findByPermitId,
  hasSubmittedForPermit,
  list,
  submitDraft,
  updateDraft,
};
