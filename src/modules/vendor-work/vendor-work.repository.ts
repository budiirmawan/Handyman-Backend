import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorWork,
  VendorWorkRecord,
  VendorWorkStatus,
} from './vendor-work.types';

type VendorWorkRow = {
  id: string;
  vendorAssignmentId: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  status: VendorWorkStatus;
  notes: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const WORK_SELECT = `
  id,
  vendor_assignment_id AS "vendorAssignmentId",
  vendor_id AS "vendorId",
  work_order_id AS "workOrderId",
  building_id AS "buildingId",
  status,
  notes,
  started_at AS "startedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: VendorWorkRow): VendorWorkRecord {
  return {
    id: row.id,
    vendorAssignmentId: row.vendorAssignmentId,
    vendorId: row.vendorId,
    workOrderId: row.workOrderId,
    buildingId: row.buildingId,
    status: row.status,
    notes: row.notes,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(input: NewVendorWork): Promise<VendorWorkRecord> {
  const result = await getPool().query<VendorWorkRow>(
    `INSERT INTO vendor_works
       (id, vendor_assignment_id, vendor_id, work_order_id, building_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${WORK_SELECT}`,
    [
      randomUUID(),
      input.vendorAssignmentId,
      input.vendorId,
      input.workOrderId,
      input.buildingId,
      input.notes,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorWorkRecord | null> {
  const result = await getPool().query<VendorWorkRow>(
    `SELECT ${WORK_SELECT} FROM vendor_works WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The single Vendor Work record of one Vendor Assignment, if any. */
async function findByAssignmentId(
  vendorAssignmentId: string,
): Promise<VendorWorkRecord | null> {
  const result = await getPool().query<VendorWorkRow>(
    `SELECT ${WORK_SELECT} FROM vendor_works
     WHERE vendor_assignment_id = $1
     LIMIT 1`,
    [vendorAssignmentId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lists Vendor Work scoped to the caller's accessible Building set, optionally
 * narrowed by Vendor / Building / status. The accessible Building set is
 * resolved by the service (BE-02G) — the repository never trusts a
 * caller-supplied Building scope.
 */
async function list(input: {
  vendorId?: string;
  buildingId?: string;
  status?: VendorWorkStatus;
  buildingIds: string[];
}): Promise<VendorWorkRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`building_id = ANY($${values.length})`);

  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vendor_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<VendorWorkRow>(
    `SELECT ${WORK_SELECT} FROM vendor_works
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

type UpdateVendorWork = {
  status: VendorWorkStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  notes?: string | null;
};

async function update(
  id: string,
  input: UpdateVendorWork,
): Promise<VendorWorkRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  values.push(input.status);
  sets.push(`status = $${values.length}`);

  if (input.startedAt !== undefined) {
    values.push(input.startedAt);
    sets.push(`started_at = $${values.length}`);
  }
  if (input.completedAt !== undefined) {
    values.push(input.completedAt);
    sets.push(`completed_at = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<VendorWorkRow>(
    `UPDATE vendor_works SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${WORK_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorWorkRepository = {
  create,
  findByAssignmentId,
  findById,
  list,
  update,
};
