import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HousekeepingComplaintBindingFilter,
  HousekeepingComplaintBindingRecord,
  HousekeepingComplaintBindingStatus,
  HousekeepingComplaintSourceType,
  UpdateHousekeepingComplaintBindingInput,
} from './housekeeping-complaint.types';

type ComplaintBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  complaint_reference: string;
  work_request_id: string | null;
  cleaning_area_id: string | null;
  housekeeping_source_type: HousekeepingComplaintSourceType | null;
  housekeeping_source_id: string | null;
  finding_id: string | null;
  description: string | null;
  status: HousekeepingComplaintBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type ComplaintBindingWithContextRow = ComplaintBindingRow & {
  area_code: string | null;
  area_name: string | null;
  area_status: string | null;
  finding_number: string | null;
  finding_title: string | null;
  finding_status: string | null;
  work_request_number: string | null;
  work_request_title: string | null;
  work_request_status: string | null;
};

function mapRow(row: ComplaintBindingRow): HousekeepingComplaintBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    complaintReference: row.complaint_reference,
    workRequestId: row.work_request_id,
    cleaningAreaId: row.cleaning_area_id,
    housekeepingSourceType: row.housekeeping_source_type,
    housekeepingSourceId: row.housekeeping_source_id,
    findingId: row.finding_id,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  complaintReference: string;
  workRequestId: string | null;
  cleaningAreaId: string | null;
  housekeepingSourceType: HousekeepingComplaintSourceType | null;
  housekeepingSourceId: string | null;
  findingId: string | null;
  description: string | null;
  status: HousekeepingComplaintBindingStatus;
  createdByUserId: string;
}): Promise<HousekeepingComplaintBindingRecord> {
  const result = await getPool().query<ComplaintBindingRow>(
    `INSERT INTO housekeeping_complaint_bindings
       (id, client_id, building_id, complaint_reference, work_request_id,
        cleaning_area_id, housekeeping_source_type, housekeeping_source_id,
        finding_id, description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.complaintReference,
      input.workRequestId,
      input.cleaningAreaId,
      input.housekeepingSourceType,
      input.housekeepingSourceId,
      input.findingId,
      input.description,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<ComplaintBindingWithContextRow | null> {
  const result = await getPool().query<ComplaintBindingWithContextRow>(
    `SELECT
       hcb.*,
       ca.code AS area_code,
       ca.name AS area_name,
       ca.status AS area_status,
       f.finding_number AS finding_number,
       f.title AS finding_title,
       f.status AS finding_status,
       wr.request_number AS work_request_number,
       wr.title AS work_request_title,
       wr.status AS work_request_status
     FROM housekeeping_complaint_bindings hcb
     LEFT JOIN cleaning_areas ca ON ca.id = hcb.cleaning_area_id
     LEFT JOIN findings f ON f.id = hcb.finding_id
     LEFT JOIN work_requests wr ON wr.id = hcb.work_request_id
     WHERE hcb.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findActiveByReferenceAndSource(
  complaintReference: string,
  sourceType: string | null,
  sourceId: string | null,
): Promise<HousekeepingComplaintBindingRecord | null> {
  if (!sourceId) return null;
  const result = await getPool().query<ComplaintBindingRow>(
    `SELECT * FROM housekeeping_complaint_bindings
     WHERE complaint_reference = $1
       AND housekeeping_source_type = $2
       AND housekeeping_source_id = $3
       AND status = 'ACTIVE'`,
    [complaintReference, sourceType, sourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: HousekeepingComplaintBindingFilter = {},
): Promise<ComplaintBindingWithContextRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`hcb.building_id = $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`hcb.cleaning_area_id = $${values.length}`);
  }

  if (filter.findingId) {
    values.push(filter.findingId);
    conditions.push(`hcb.finding_id = $${values.length}`);
  }

  if (filter.workRequestId) {
    values.push(filter.workRequestId);
    conditions.push(`hcb.work_request_id = $${values.length}`);
  }

  if (filter.complaintReference) {
    values.push(filter.complaintReference);
    conditions.push(`hcb.complaint_reference = $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`hcb.status = $${values.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query<ComplaintBindingWithContextRow>(
    `SELECT
       hcb.*,
       ca.code AS area_code,
       ca.name AS area_name,
       ca.status AS area_status,
       f.finding_number AS finding_number,
       f.title AS finding_title,
       f.status AS finding_status,
       wr.request_number AS work_request_number,
       wr.title AS work_request_title,
       wr.status AS work_request_status
     FROM housekeeping_complaint_bindings hcb
     LEFT JOIN cleaning_areas ca ON ca.id = hcb.cleaning_area_id
     LEFT JOIN findings f ON f.id = hcb.finding_id
     LEFT JOIN work_requests wr ON wr.id = hcb.work_request_id
     ${whereClause}
     ORDER BY hcb.created_at DESC`,
    values,
  );
  return result.rows;
}

export async function update(
  id: string,
  input: UpdateHousekeepingComplaintBindingInput,
): Promise<HousekeepingComplaintBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }

  if (input.findingId !== undefined) {
    values.push(input.findingId);
    sets.push(`finding_id = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    const existing = await findById(id);
    return existing ? mapRow(existing) : null;
  }

  values.push(id);
  const result = await getPool().query<ComplaintBindingRow>(
    `UPDATE housekeeping_complaint_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING *`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const housekeepingComplaintRepository = {
  create,
  findActiveByReferenceAndSource,
  findById,
  list,
  update,
};
