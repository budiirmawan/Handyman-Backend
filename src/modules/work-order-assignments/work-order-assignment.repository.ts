import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWorkOrderAssignment,
  WorkOrderAssignmentRecord,
  WorkOrderAssignmentStatus,
  WorkOrderAssigneeType,
} from './work-order-assignment.types';

type WorkOrderAssignmentRow = {
  id: string;
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  status: WorkOrderAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ASSIGNMENT_SELECT = `
  id,
  work_order_id AS "workOrderId",
  assignee_type AS "assigneeType",
  workforce_profile_id AS "workforceProfileId",
  team_id AS "teamId",
  vendor_id AS "vendorId",
  assigned_by_user_id AS "assignedByUserId",
  assigned_at AS "assignedAt",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: WorkOrderAssignmentRow): WorkOrderAssignmentRecord {
  return {
    id: row.id,
    workOrderId: row.workOrderId,
    assigneeType: row.assigneeType,
    workforceProfileId: row.workforceProfileId,
    teamId: row.teamId,
    vendorId: row.vendorId,
    assignedByUserId: row.assignedByUserId,
    assignedAt: row.assignedAt,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewWorkOrderAssignment,
): Promise<WorkOrderAssignmentRecord> {
  const result = await getPool().query<WorkOrderAssignmentRow>(
    `INSERT INTO work_order_assignments
       (id, work_order_id, assignee_type, workforce_profile_id, team_id,
        vendor_id, assigned_by_user_id, assigned_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'ACTIVE')
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.workOrderId,
      input.assigneeType,
      input.workforceProfileId,
      input.teamId,
      input.vendorId,
      input.assignedByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<WorkOrderAssignmentRecord | null> {
  const result = await getPool().query<WorkOrderAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM work_order_assignments WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByWorkOrderId(
  workOrderId: string,
): Promise<WorkOrderAssignmentRecord | null> {
  const result = await getPool().query<WorkOrderAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM work_order_assignments
     WHERE work_order_id = $1 AND status = 'ACTIVE'
     LIMIT 1`,
    [workOrderId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByWorkOrderId(
  workOrderId: string,
): Promise<WorkOrderAssignmentRecord[]> {
  const result = await getPool().query<WorkOrderAssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM work_order_assignments
     WHERE work_order_id = $1
     ORDER BY created_at ASC`,
    [workOrderId],
  );

  return result.rows.map(mapRow);
}

async function updateStatus(
  id: string,
  status: WorkOrderAssignmentStatus,
): Promise<WorkOrderAssignmentRecord | null> {
  const result = await getPool().query<WorkOrderAssignmentRow>(
    `UPDATE work_order_assignments SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSIGNMENT_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workOrderAssignmentRepository = {
  create,
  findActiveByWorkOrderId,
  findById,
  listByWorkOrderId,
  updateStatus,
};
