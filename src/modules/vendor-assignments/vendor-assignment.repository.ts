import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorAssignment,
  VendorAssignmentRecord,
  VendorAssignmentStatus,
} from './vendor-assignment.types';

type VendorAssignmentRow = {
  id: string;
  vendorId: string;
  workOrderId: string;
  buildingId: string;
  status: VendorAssignmentStatus;
  notes: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const ASSIGNMENT_SELECT = `
  id,
  vendor_id AS "vendorId",
  work_order_id AS "workOrderId",
  building_id AS "buildingId",
  status,
  notes,
  assigned_by_user_id AS "assignedByUserId",
  assigned_at AS "assignedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: VendorAssignmentRow): VendorAssignmentRecord {
  return {
    id: row.id,
    vendorId: row.vendorId,
    workOrderId: row.workOrderId,
    buildingId: row.buildingId,
    status: row.status,
    notes: row.notes,
    assignedByUserId: row.assignedByUserId,
    assignedAt: row.assignedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewVendorAssignment,
): Promise<VendorAssignmentRecord> {
  const result = await getPool().query<VendorAssignmentRow>(
    `INSERT INTO vendor_assignments
       (id, vendor_id, work_order_id, building_id, notes,
        assigned_by_user_id, assigned_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'ACTIVE')
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.vendorId,
      input.workOrderId,
      input.buildingId,
      input.notes,
      input.assignedByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorAssignmentRecord | null> {
  const result = await getPool().query<VendorAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM vendor_assignments WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The ACTIVE assignment of one Vendor for one Work Order, if any. */
async function findActiveByVendorAndWorkOrder(
  vendorId: string,
  workOrderId: string,
): Promise<VendorAssignmentRecord | null> {
  const result = await getPool().query<VendorAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM vendor_assignments
     WHERE vendor_id = $1 AND work_order_id = $2 AND status = 'ACTIVE'
     LIMIT 1`,
    [vendorId, workOrderId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lists assignments (history included) scoped to the caller's accessible
 * Building set, optionally narrowed by Vendor / Work Order. The accessible
 * Building set is resolved by the service (BE-02G) — the repository never
 * trusts a caller-supplied Building scope.
 */
async function list(input: {
  vendorId?: string;
  workOrderId?: string;
  buildingIds: string[];
}): Promise<VendorAssignmentRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`building_id = ANY($${values.length})`);

  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vendor_id = $${values.length}`);
  }
  if (input.workOrderId) {
    values.push(input.workOrderId);
    conditions.push(`work_order_id = $${values.length}`);
  }

  const result = await getPool().query<VendorAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM vendor_assignments
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function updateStatus(
  id: string,
  status: VendorAssignmentStatus,
): Promise<VendorAssignmentRecord | null> {
  const result = await getPool().query<VendorAssignmentRow>(
    `UPDATE vendor_assignments SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSIGNMENT_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorAssignmentRepository = {
  create,
  findActiveByVendorAndWorkOrder,
  findById,
  list,
  updateStatus,
};
