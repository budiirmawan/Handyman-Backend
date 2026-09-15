import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPermission,
  PermissionRecord,
  PermissionStatus,
  RolePermissionAssignmentRecord,
  RolePermissionAssignmentStatus,
} from './permission.types';

type PermissionRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: PermissionStatus;
  createdAt: Date;
  updatedAt: Date;
};

type AssignmentRow = {
  id: string;
  roleId: string;
  permissionId: string;
  status: RolePermissionAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

const PERMISSION_SELECT = `
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
  role_id AS "roleId",
  permission_id AS "permissionId",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapPermissionRow(row: PermissionRow): PermissionRecord {
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

function mapAssignmentRow(row: AssignmentRow): RolePermissionAssignmentRecord {
  return {
    id: row.id,
    roleId: row.roleId,
    permissionId: row.permissionId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createPermission(input: NewPermission): Promise<PermissionRecord> {
  const result = await getPool().query<PermissionRow>(
    `INSERT INTO permissions (id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PERMISSION_SELECT}`,
    [randomUUID(), input.code, input.name, input.description, input.status],
  );

  return mapPermissionRow(result.rows[0]);
}

async function findById(id: string): Promise<PermissionRecord | null> {
  const result = await getPool().query<PermissionRow>(
    `SELECT ${PERMISSION_SELECT} FROM permissions WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapPermissionRow(row) : null;
}

async function findByCode(code: string): Promise<PermissionRecord | null> {
  const result = await getPool().query<PermissionRow>(
    `SELECT ${PERMISSION_SELECT} FROM permissions WHERE code = $1`,
    [code],
  );

  const row = result.rows[0];
  return row ? mapPermissionRow(row) : null;
}

async function listPermissions(): Promise<PermissionRecord[]> {
  const result = await getPool().query<PermissionRow>(
    `SELECT ${PERMISSION_SELECT} FROM permissions ORDER BY code ASC`,
  );

  return result.rows.map(mapPermissionRow);
}

async function updateStatus(
  id: string,
  status: PermissionStatus,
): Promise<PermissionRecord | null> {
  const result = await getPool().query<PermissionRow>(
    `UPDATE permissions SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${PERMISSION_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapPermissionRow(row) : null;
}

async function createAssignment(
  roleId: string,
  permissionId: string,
): Promise<RolePermissionAssignmentRecord> {
  const result = await getPool().query<AssignmentRow>(
    `INSERT INTO role_permission_assignments (id, role_id, permission_id)
     VALUES ($1, $2, $3)
     RETURNING ${ASSIGNMENT_SELECT}`,
    [randomUUID(), roleId, permissionId],
  );

  return mapAssignmentRow(result.rows[0]);
}

async function findActiveAssignment(
  roleId: string,
  permissionId: string,
): Promise<RolePermissionAssignmentRecord | null> {
  const result = await getPool().query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SELECT} FROM role_permission_assignments
     WHERE role_id = $1 AND permission_id = $2 AND status = 'ACTIVE'`,
    [roleId, permissionId],
  );

  const row = result.rows[0];
  return row ? mapAssignmentRow(row) : null;
}

async function listActivePermissionsForRole(
  roleId: string,
): Promise<PermissionRecord[]> {
  const result = await getPool().query<PermissionRow>(
    `SELECT
       p.id,
       p.code,
       p.name,
       p.description,
       p.status,
       p.created_at AS "createdAt",
       p.updated_at AS "updatedAt"
     FROM role_permission_assignments rpa
     JOIN permissions p ON p.id = rpa.permission_id
     WHERE rpa.role_id = $1 AND rpa.status = 'ACTIVE' AND p.status = 'ACTIVE'
     ORDER BY p.code ASC`,
    [roleId],
  );

  return result.rows.map(mapPermissionRow);
}

/**
 * Resolves the deduplicated set of ACTIVE permission codes for a user by
 * walking: active user-role assignments → active roles → active
 * role-permission assignments → active permissions.
 */
async function listActivePermissionCodesForUser(userId: string): Promise<string[]> {
  const result = await getPool().query<{ code: string }>(
    `SELECT DISTINCT p.code
     FROM user_role_assignments ura
     JOIN roles r ON r.id = ura.role_id
     JOIN role_permission_assignments rpa ON rpa.role_id = r.id
     JOIN permissions p ON p.id = rpa.permission_id
     WHERE ura.user_id = $1
       AND ura.status = 'ACTIVE'
       AND r.status = 'ACTIVE'
       AND rpa.status = 'ACTIVE'
       AND p.status = 'ACTIVE'
     ORDER BY p.code ASC`,
    [userId],
  );

  return result.rows.map((row) => row.code);
}

export const permissionRepository = {
  createAssignment,
  createPermission,
  findActiveAssignment,
  findById,
  findByCode,
  listActivePermissionCodesForUser,
  listActivePermissionsForRole,
  listPermissions,
  updateStatus,
};
