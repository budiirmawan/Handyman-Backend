import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewRole,
  RoleRecord,
  RoleStatus,
  UserRoleAssignmentRecord,
  UserRoleAssignmentStatus,
} from './role.types';

type RoleRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: RoleStatus;
  createdAt: Date;
  updatedAt: Date;
};

type AssignmentRow = {
  id: string;
  userId: string;
  roleId: string;
  status: UserRoleAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ROLE_SELECT = `
  id,
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const ASSIGNMENT_SELECT = `
  id,
  user_id AS "userId",
  role_id AS "roleId",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRoleRow(row: RoleRow): RoleRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAssignmentRow(row: AssignmentRow): UserRoleAssignmentRecord {
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createRole(input: NewRole): Promise<RoleRecord> {
  const result = await getPool().query<RoleRow>(
    `INSERT INTO roles (id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ROLE_SELECT}`,
    [randomUUID(), input.code, input.name, input.description, input.status],
  );

  return mapRoleRow(result.rows[0]);
}

async function findById(id: string): Promise<RoleRecord | null> {
  const result = await getPool().query<RoleRow>(
    `SELECT ${ROLE_SELECT} FROM roles WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRoleRow(row) : null;
}

async function findByCode(code: string): Promise<RoleRecord | null> {
  const result = await getPool().query<RoleRow>(
    `SELECT ${ROLE_SELECT} FROM roles WHERE code = $1`,
    [code],
  );

  const row = result.rows[0];
  return row ? mapRoleRow(row) : null;
}

async function listRoles(): Promise<RoleRecord[]> {
  const result = await getPool().query<RoleRow>(
    `SELECT ${ROLE_SELECT} FROM roles ORDER BY code ASC`,
  );

  return result.rows.map(mapRoleRow);
}

async function updateStatus(id: string, status: RoleStatus): Promise<RoleRecord | null> {
  const result = await getPool().query<RoleRow>(
    `UPDATE roles SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ROLE_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRoleRow(row) : null;
}

async function createAssignment(
  userId: string,
  roleId: string,
): Promise<UserRoleAssignmentRecord> {
  const result = await getPool().query<AssignmentRow>(
    `INSERT INTO user_role_assignments (id, user_id, role_id)
     VALUES ($1, $2, $3)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [randomUUID(), userId, roleId],
  );

  return mapAssignmentRow(result.rows[0]);
}

async function findActiveAssignment(
  userId: string,
  roleId: string,
): Promise<UserRoleAssignmentRecord | null> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM user_role_assignments
     WHERE user_id = $1 AND role_id = $2 AND status = 'ACTIVE'`,
    [userId, roleId],
  );

  const row = result.rows[0];
  return row ? mapAssignmentRow(row) : null;
}

async function listActiveRolesForUser(userId: string): Promise<RoleRecord[]> {
  const result = await getPool().query<RoleRow>(
    `SELECT
       r.id,
       r.code,
       r.name,
       r.description,
       r.status,
       r.created_at AS "createdAt",
       r.updated_at AS "updatedAt"
     FROM user_role_assignments ura
     JOIN roles r ON r.id = ura.role_id
     WHERE ura.user_id = $1 AND ura.status = 'ACTIVE' AND r.status = 'ACTIVE'
     ORDER BY r.code ASC`,
    [userId],
  );

  return result.rows.map(mapRoleRow);
}

export const roleRepository = {
  createAssignment,
  createRole,
  findActiveAssignment,
  findById,
  findByCode,
  listActiveRolesForUser,
  listRoles,
  updateStatus,
};
