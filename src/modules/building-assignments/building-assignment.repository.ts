import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewUserBuildingAssignment,
  UserBuildingAssignmentRecord,
  UserBuildingAssignmentStatus,
} from './building-assignment.types';

type AssignmentRow = {
  id: string;
  userId: string;
  buildingId: string;
  status: UserBuildingAssignmentStatus;
  assignedByUserId: string | null;
  assignedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const ASSIGNMENT_SELECT = `
  id,
  user_id AS "userId",
  building_id AS "buildingId",
  status,
  assigned_by_user_id AS "assignedByUserId",
  assigned_at AS "assignedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapAssignmentRow(row: AssignmentRow): UserBuildingAssignmentRecord {
  return {
    id: row.id,
    userId: row.userId,
    buildingId: row.buildingId,
    status: row.status,
    assignedByUserId: row.assignedByUserId,
    assignedAt: row.assignedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createAssignment(
  input: NewUserBuildingAssignment,
): Promise<UserBuildingAssignmentRecord> {
  const result = await getPool().query<AssignmentRow>(
    `INSERT INTO user_building_assignments
       (id, user_id, building_id, status, assigned_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [
      randomUUID(),
      input.userId,
      input.buildingId,
      input.status,
      input.assignedByUserId,
    ],
  );

  return mapAssignmentRow(result.rows[0]);
}

async function findById(id: string): Promise<UserBuildingAssignmentRecord | null> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM user_building_assignments WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapAssignmentRow(row) : null;
}

async function findActiveByUserAndBuilding(
  userId: string,
  buildingId: string,
): Promise<UserBuildingAssignmentRecord | null> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM user_building_assignments
     WHERE user_id = $1 AND building_id = $2 AND status = 'ACTIVE'`,
    [userId, buildingId],
  );

  const row = result.rows[0];
  return row ? mapAssignmentRow(row) : null;
}

async function listByUser(userId: string): Promise<UserBuildingAssignmentRecord[]> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM user_building_assignments
     WHERE user_id = $1 ORDER BY assigned_at DESC`,
    [userId],
  );

  return result.rows.map(mapAssignmentRow);
}

async function listActiveByUser(
  userId: string,
): Promise<UserBuildingAssignmentRecord[]> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM user_building_assignments
     WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY assigned_at DESC`,
    [userId],
  );

  return result.rows.map(mapAssignmentRow);
}

async function listByBuilding(
  buildingId: string,
): Promise<UserBuildingAssignmentRecord[]> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM user_building_assignments
     WHERE building_id = $1 ORDER BY assigned_at DESC`,
    [buildingId],
  );

  return result.rows.map(mapAssignmentRow);
}

async function updateStatus(
  id: string,
  status: UserBuildingAssignmentStatus,
): Promise<UserBuildingAssignmentRecord | null> {
  const result = await getPool().query<AssignmentRow>(
    `UPDATE user_building_assignments SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSIGNMENT_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapAssignmentRow(row) : null;
}

export const buildingAssignmentRepository = {
  createAssignment,
  findActiveByUserAndBuilding,
  findById,
  listActiveByUser,
  listByBuilding,
  listByUser,
  updateStatus,
};
