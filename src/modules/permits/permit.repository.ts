import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPermit,
  PermitFilters,
  PermitRecord,
  UpdatePermitInput,
} from './permit.types';

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  permit_number AS "permitNumber",
  permit_type AS "permitType",
  title,
  work_description AS "workDescription",
  applicant_reference AS "applicantReference",
  contractor_context_type AS "contractorContextType",
  contractor_vendor_id AS "contractorVendorId",
  tenant_contractor_relationship_id AS "tenantContractorRelationshipId",
  status,
  requested_at AS "requestedAt",
  created_by_user_id AS "createdByUserId",
  cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(input: NewPermit): Promise<PermitRecord> {
  const result = await getPool().query<PermitRecord>(
    `INSERT INTO permits
       (id, client_id, building_id, permit_number, permit_type, title,
        work_description, applicant_reference, contractor_context_type,
        contractor_vendor_id, tenant_contractor_relationship_id,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.permitNumber,
      input.permitType,
      input.title,
      input.workDescription,
      input.applicantReference,
      input.contractorContextType,
      input.contractorVendorId,
      input.tenantContractorRelationshipId,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<PermitRecord | null> {
  const result = await getPool().query<PermitRecord>(
    `SELECT ${SELECT} FROM permits WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByClientAndNumber(
  clientId: string,
  permitNumber: string,
): Promise<PermitRecord | null> {
  const result = await getPool().query<PermitRecord>(
    `SELECT ${SELECT} FROM permits
     WHERE client_id = $1 AND permit_number = $2`,
    [clientId, permitNumber],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: PermitFilters,
  accessibleBuildingIds: string[],
): Promise<PermitRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];

  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['building_id = ANY($1::uuid[])'];

  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filters.contractorVendorId) {
    values.push(filters.contractorVendorId);
    conditions.push(`contractor_vendor_id = $${values.length}`);
  }
  if (filters.contractorContextId) {
    values.push(filters.contractorContextId);
    conditions.push(`(
      contractor_vendor_id = $${values.length}
      OR tenant_contractor_relationship_id = $${values.length}
    )`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.permitType) {
    values.push(filters.permitType);
    conditions.push(`permit_type = $${values.length}`);
  }
  if (filters.locationType || filters.locationId || filters.workType) {
    const workConditions = ['pa.permit_id = permits.id'];
    if (filters.locationType) {
      values.push(filters.locationType);
      workConditions.push(`pwc.location_type = $${values.length}`);
    }
    if (filters.locationId) {
      values.push(filters.locationId);
      workConditions.push(`$${values.length} IN (
        pwc.building_id, pwc.floor_id, pwc.area_id, pwc.room_id,
        pwc.functional_location_id
      )`);
    }
    if (filters.workType) {
      values.push(filters.workType);
      workConditions.push(`pwc.work_type = $${values.length}`);
    }
    conditions.push(`EXISTS (
      SELECT 1
      FROM permit_applications pa
      JOIN permit_work_contexts pwc ON pwc.permit_application_id = pa.id
      WHERE ${workConditions.join(' AND ')}
    )`);
  }
  if (filters.validityStatus || filters.validAt) {
    const validityConditions = [
      'vpa.permit_id = permits.id',
      `pv.id = (
        SELECT latest.id
        FROM permit_validities latest
        JOIN permit_applications latest_pa
          ON latest_pa.id = latest.permit_application_id
        WHERE latest_pa.permit_id = permits.id
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )`,
    ];
    if (filters.validityStatus) {
      values.push(filters.validityStatus);
      validityConditions.push(`CASE
        WHEN pv.status = 'REVOKED' THEN 'REVOKED'
        WHEN pv.valid_until <= NOW() THEN 'EXPIRED'
        WHEN pv.valid_from <= NOW() THEN 'VALID'
        ELSE 'PENDING'
      END = $${values.length}`);
    }
    if (filters.validAt) {
      values.push(filters.validAt);
      validityConditions.push(`pv.status <> 'REVOKED'
        AND pv.valid_from <= $${values.length}
        AND pv.valid_until > $${values.length}`);
    }
    conditions.push(`EXISTS (
      SELECT 1
      FROM permit_validities pv
      JOIN permit_applications vpa ON vpa.id = pv.permit_application_id
      WHERE ${validityConditions.join(' AND ')}
    )`);
  }

  const result = await getPool().query<PermitRecord>(
    `SELECT ${SELECT} FROM permits
     WHERE ${conditions.join(' AND ')}
     ORDER BY requested_at DESC, created_at DESC`,
    values,
  );
  return result.rows;
}

async function updateDraft(
  id: string,
  input: UpdatePermitInput,
): Promise<PermitRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdatePermitInput, string][] = [
    ['permitType', 'permit_type'],
    ['title', 'title'],
    ['workDescription', 'work_description'],
    ['applicantReference', 'applicant_reference'],
  ];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }

  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<PermitRecord>(
    `UPDATE permits SET ${sets.join(', ')}
     WHERE id = $${values.length} AND status = 'DRAFT'
     RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function cancelDraft(
  id: string,
  actorUserId: string,
): Promise<PermitRecord | null> {
  const result = await getPool().query<PermitRecord>(
    `UPDATE permits
     SET status = 'CANCELLED', cancelled_at = NOW(),
         cancelled_by_user_id = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ?? null;
}

export const permitRepository = {
  cancelDraft,
  create,
  findByClientAndNumber,
  findById,
  list,
  updateDraft,
};
