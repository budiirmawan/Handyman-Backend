import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanInspectionAssignmentRecord,
  NewHandymanInspectionAssignmentRecord,
} from './handyman-request-inspection-assignment.types';

/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment
 * repository (executor-first convention identical to the sibling triage /
 * inspection repositories: shared pool by default; transaction executor as
 * argument ONE).
 *
 * Bounded to the 0445 assignment fact: INSERT of a new assignment,
 * the supersession write (reason + link, on the predecessor only), the
 * current/history lookups, and the two read-only target validations the
 * assignment service needs (active building assignment, active permission
 * code). The 0445 trigger refuses every other UPDATE and every DELETE.
 */

type Row = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  building_id: string;
  assigned_field_user_id: string;
  assigned_by_user_id: string;
  assigned_at: Date;
  status: HandymanInspectionAssignmentRecord['status'];
  superseded_at: Date | null;
  superseded_by_assignment_id: string | null;
  supersedes_assignment_id: string | null;
  supersession_reason: string | null;
};

const ASSIGNMENT_SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         building_id, assigned_field_user_id, assigned_by_user_id,
         assigned_at, status, superseded_at, superseded_by_assignment_id,
         supersedes_assignment_id, supersession_reason
    FROM handyman_request_inspection_assignments`;

function map(row: Row): HandymanInspectionAssignmentRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    buildingId: row.building_id,
    assignedFieldUserId: row.assigned_field_user_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at,
    status: row.status,
    supersededAt: row.superseded_at,
    supersededByAssignmentId: row.superseded_by_assignment_id,
    supersedesAssignmentId: row.supersedes_assignment_id,
    supersessionReason: row.supersession_reason,
  };
}

async function insertAssignment(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanInspectionAssignmentRecord,
): Promise<HandymanInspectionAssignmentRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_request_inspection_assignments (
       id, client_id, handyman_request_id, channel_attribution_id,
       building_id, assigned_field_user_id, assigned_by_user_id,
       supersedes_assignment_id, supersession_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               building_id, assigned_field_user_id, assigned_by_user_id,
               assigned_at, status, superseded_at,
               superseded_by_assignment_id, supersedes_assignment_id,
               supersession_reason`,
    [
      record.id,
      record.clientId,
      record.handymanRequestId,
      record.channelAttributionId,
      record.buildingId,
      record.assignedFieldUserId,
      record.assignedByUserId,
      record.supersedesAssignmentId,
    ],
  );
  return map(result.rows[0]);
}

/**
 * Supersede the ACTIVE predecessor: reason + forward link only. The 0445
 * guard refuses anything else (immutable columns, resurrection, delete).
 */
async function supersedeAssignment(
  executor: Pick<PoolClient, 'query'>,
  input: {
    assignmentId: string;
    supersededByAssignmentId: string;
    reason: string;
  },
): Promise<void> {
  await executor.query(
    `UPDATE handyman_request_inspection_assignments
        SET status = 'SUPERSEDED',
            superseded_at = NOW(),
            superseded_by_assignment_id = $2,
            supersession_reason = $3
      WHERE id = $1
        AND status = 'ACTIVE'`,
    [input.assignmentId, input.supersededByAssignmentId, input.reason],
  );
}

async function findActiveByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanInspectionAssignmentRecord | null> {
  const result = await executor.query<Row>(
    `${ASSIGNMENT_SELECT}
      WHERE handyman_request_id = $1 AND status = 'ACTIVE'`,
    [handymanRequestId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Immutable supersession history, oldest first (the current row last). */
async function listByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanInspectionAssignmentRecord[]> {
  const result = await executor.query<Row>(
    `${ASSIGNMENT_SELECT}
      WHERE handyman_request_id = $1
      ORDER BY assigned_at ASC, id ASC`,
    [handymanRequestId],
  );
  return result.rows.map(map);
}

/** The target must be an ACTIVE user (FROZEN F7 local identity only). */
async function isActiveUser(
  executor: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<boolean> {
  const result = await executor.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'
     ) AS active`,
    [userId],
  );
  return result.rows[0]?.active === true;
}

/**
 * The target must hold the dedicated Field report-submission authority
 * (BE-01E resolver shape: active assignment → active role → active
 * permission). A generic `tenant_company.manage` grant never satisfies it.
 */
async function hasActivePermission(
  executor: Pick<PoolClient, 'query'>,
  userId: string,
  code: string,
): Promise<boolean> {
  const result = await executor.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         JOIN role_permission_assignments rpa ON rpa.role_id = r.id
         JOIN permissions p ON p.id = rpa.permission_id
        WHERE ura.user_id = $1
          AND p.code = $2
          AND ura.status = 'ACTIVE'
          AND r.status = 'ACTIVE'
          AND rpa.status = 'ACTIVE'
          AND p.status = 'ACTIVE'
     ) AS allowed`,
    [userId, code],
  );
  return result.rows[0]?.allowed === true;
}

/**
 * The target must already have active resource access to the request's
 * exact Building (BE-02G). A Building assignment elsewhere under the same
 * Client is not access (no same-Client shortcut).
 */
async function hasActiveBuildingAssignment(
  executor: Pick<PoolClient, 'query'>,
  userId: string,
  buildingId: string,
): Promise<boolean> {
  const result = await executor.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM user_building_assignments uba
         JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
         JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
        WHERE uba.user_id = $1
          AND uba.building_id = $2
          AND uba.status = 'ACTIVE'
     ) AS allowed`,
    [userId, buildingId],
  );
  return result.rows[0]?.allowed === true;
}

export const handymanRequestInspectionAssignmentRepository = {
  findActiveByRequest,
  hasActiveBuildingAssignment,
  hasActivePermission,
  insertAssignment,
  isActiveUser,
  listByRequest,
  supersedeAssignment,
};
