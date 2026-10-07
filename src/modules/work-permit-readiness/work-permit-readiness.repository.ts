import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWorkPermitReadiness,
  PermitReadinessStatus,
  PermitStatus,
  WorkPermitReadinessRecord,
} from './work-permit-readiness.types';

/**
 * BE-15D — Work Permit Readiness repository.
 *
 * Holds readiness rows for a BE-15B Vendor Work. Readiness status is derived
 * by the service; the repository persists the derived value and the permit
 * fields. Change history is preserved through the shared BE-07
 * operational-events timeline (recorded by the service), not by extra rows
 * here.
 */

type WorkPermitReadinessRow = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  buildingId: string;
  workOrderId: string;
  permitRequirementType: string;
  permitReference: string | null;
  permitStatus: PermitStatus;
  validFrom: Date | null;
  validUntil: Date | null;
  readinessStatus: PermitReadinessStatus;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const READINESS_SELECT = `
  id,
  client_id AS "clientId",
  vendor_work_id AS "vendorWorkId",
  building_id AS "buildingId",
  work_order_id AS "workOrderId",
  permit_requirement_type AS "permitRequirementType",
  permit_reference AS "permitReference",
  permit_status AS "permitStatus",
  valid_from AS "validFrom",
  valid_until AS "validUntil",
  readiness_status AS "readinessStatus",
  notes,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: WorkPermitReadinessRow): WorkPermitReadinessRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    vendorWorkId: row.vendorWorkId,
    buildingId: row.buildingId,
    workOrderId: row.workOrderId,
    permitRequirementType: row.permitRequirementType,
    permitReference: row.permitReference,
    permitStatus: row.permitStatus,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    readinessStatus: row.readinessStatus,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewWorkPermitReadiness,
): Promise<WorkPermitReadinessRecord> {
  const result = await getPool().query<WorkPermitReadinessRow>(
    `INSERT INTO work_permit_readiness
       (id, client_id, vendor_work_id, building_id, work_order_id,
        permit_requirement_type, permit_reference, permit_status, valid_from,
        valid_until, readiness_status, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${READINESS_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.vendorWorkId,
      input.buildingId,
      input.workOrderId,
      input.permitRequirementType,
      input.permitReference,
      input.permitStatus,
      input.validFrom,
      input.validUntil,
      input.readinessStatus,
      input.notes,
      input.createdByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<WorkPermitReadinessRecord | null> {
  const result = await getPool().query<WorkPermitReadinessRow>(
    `SELECT ${READINESS_SELECT} FROM work_permit_readiness WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByVendorWorkAndType(
  vendorWorkId: string,
  permitRequirementType: string,
): Promise<WorkPermitReadinessRecord | null> {
  const result = await getPool().query<WorkPermitReadinessRow>(
    `SELECT ${READINESS_SELECT} FROM work_permit_readiness
     WHERE vendor_work_id = $1 AND permit_requirement_type = $2
     LIMIT 1`,
    [vendorWorkId, permitRequirementType],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByVendorWorkId(
  vendorWorkId: string,
): Promise<WorkPermitReadinessRecord[]> {
  const result = await getPool().query<WorkPermitReadinessRow>(
    `SELECT ${READINESS_SELECT} FROM work_permit_readiness
     WHERE vendor_work_id = $1
     ORDER BY created_at ASC`,
    [vendorWorkId],
  );

  return result.rows.map(mapRow);
}

/**
 * Lists readiness records scoped to the caller's accessible Building set,
 * optionally narrowed by Vendor Work / Vendor (via `vendor_works`) /
 * Building.
 */
async function list(input: {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
  buildingIds: string[];
}): Promise<WorkPermitReadinessRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`wpr.building_id = ANY($${values.length})`);

  if (input.vendorWorkId) {
    values.push(input.vendorWorkId);
    conditions.push(`wpr.vendor_work_id = $${values.length}`);
  }
  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`wpr.building_id = $${values.length}`);
  }

  const result = await getPool().query<WorkPermitReadinessRow>(
    `SELECT
       wpr.id,
       wpr.client_id AS "clientId",
       wpr.vendor_work_id AS "vendorWorkId",
       wpr.building_id AS "buildingId",
       wpr.work_order_id AS "workOrderId",
       wpr.permit_requirement_type AS "permitRequirementType",
       wpr.permit_reference AS "permitReference",
       wpr.permit_status AS "permitStatus",
       wpr.valid_from AS "validFrom",
       wpr.valid_until AS "validUntil",
       wpr.readiness_status AS "readinessStatus",
       wpr.notes,
       wpr.created_by_user_id AS "createdByUserId",
       wpr.created_at AS "createdAt",
       wpr.updated_at AS "updatedAt"
     FROM work_permit_readiness wpr
     LEFT JOIN vendor_works vw ON vw.id = wpr.vendor_work_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY wpr.created_at ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

type UpdateWorkPermitReadiness = {
  permitReference: string | null;
  permitStatus: PermitStatus;
  validFrom: Date | null;
  validUntil: Date | null;
  readinessStatus: PermitReadinessStatus;
  notes: string | null;
};

async function update(
  id: string,
  input: UpdateWorkPermitReadiness,
): Promise<WorkPermitReadinessRecord | null> {
  const result = await getPool().query<WorkPermitReadinessRow>(
    `UPDATE work_permit_readiness
     SET permit_reference = $2,
         permit_status = $3,
         valid_from = $4,
         valid_until = $5,
         readiness_status = $6,
         notes = $7,
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${READINESS_SELECT}`,
    [
      id,
      input.permitReference,
      input.permitStatus,
      input.validFrom,
      input.validUntil,
      input.readinessStatus,
      input.notes,
    ],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workPermitReadinessRepository = {
  create,
  findById,
  findByVendorWorkAndType,
  list,
  listByVendorWorkId,
  update,
};
