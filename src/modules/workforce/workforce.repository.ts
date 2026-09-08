import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWorkforceProfile,
  UpdateWorkforceProfileInput,
  WorkforceProfileRecord,
  WorkforceStatus,
  WorkforceType,
} from './workforce.types';

type WorkforceProfileRow = {
  id: string;
  organization_id: string;
  department_id: string;
  team_id: string | null;
  position_id: string;
  user_id: string | null;
  employee_code: string;
  full_name: string;
  workforce_type: WorkforceType;
  status: WorkforceStatus;
  created_at: Date;
  updated_at: Date;
};

const WORKFORCE_SELECT = `
  id,
  organization_id,
  department_id,
  team_id,
  position_id,
  user_id,
  employee_code,
  full_name,
  workforce_type,
  status,
  created_at,
  updated_at
`;

function mapRow(row: WorkforceProfileRow): WorkforceProfileRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    departmentId: row.department_id,
    teamId: row.team_id,
    positionId: row.position_id,
    userId: row.user_id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    workforceType: row.workforce_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createWorkforceProfile(
  input: NewWorkforceProfile,
): Promise<WorkforceProfileRecord> {
  const result = await getPool().query<WorkforceProfileRow>(
    `INSERT INTO workforce_profiles (
       id, organization_id, department_id, team_id, position_id, user_id,
       employee_code, full_name, workforce_type, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${WORKFORCE_SELECT}`,
    [
      randomUUID(),
      input.organizationId,
      input.departmentId,
      input.teamId,
      input.positionId,
      input.userId,
      input.employeeCode,
      input.fullName,
      input.workforceType,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<WorkforceProfileRecord | null> {
  const result = await getPool().query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_SELECT} FROM workforce_profiles WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByOrganizationIdAndEmployeeCode(
  organizationId: string,
  employeeCode: string,
): Promise<WorkforceProfileRecord | null> {
  const result = await getPool().query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_SELECT}
       FROM workforce_profiles
      WHERE organization_id = $1 AND employee_code = $2`,
    [organizationId, employeeCode],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByUserId(
  userId: string,
): Promise<WorkforceProfileRecord | null> {
  const result = await getPool().query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_SELECT} FROM workforce_profiles WHERE user_id = $1`,
    [userId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByOrganizationId(
  organizationId: string,
): Promise<WorkforceProfileRecord[]> {
  const result = await getPool().query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_SELECT}
       FROM workforce_profiles
      WHERE organization_id = $1
      ORDER BY employee_code ASC`,
    [organizationId],
  );

  return result.rows.map(mapRow);
}

async function listByDepartmentId(
  departmentId: string,
): Promise<WorkforceProfileRecord[]> {
  const result = await getPool().query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_SELECT}
       FROM workforce_profiles
      WHERE department_id = $1
      ORDER BY employee_code ASC`,
    [departmentId],
  );

  return result.rows.map(mapRow);
}

async function listByTeamId(teamId: string): Promise<WorkforceProfileRecord[]> {
  const result = await getPool().query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_SELECT}
       FROM workforce_profiles
      WHERE team_id = $1
      ORDER BY employee_code ASC`,
    [teamId],
  );

  return result.rows.map(mapRow);
}

async function updateWorkforceProfile(
  id: string,
  input: UpdateWorkforceProfileInput,
): Promise<WorkforceProfileRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.departmentId !== undefined) {
    values.push(input.departmentId);
    sets.push(`department_id = $${values.length}`);
  }
  if (input.teamId !== undefined) {
    values.push(input.teamId);
    sets.push(`team_id = $${values.length}`);
  }
  if (input.positionId !== undefined) {
    values.push(input.positionId);
    sets.push(`position_id = $${values.length}`);
  }
  if (input.userId !== undefined) {
    values.push(input.userId);
    sets.push(`user_id = $${values.length}`);
  }
  if (input.fullName !== undefined) {
    values.push(input.fullName);
    sets.push(`full_name = $${values.length}`);
  }
  if (input.workforceType !== undefined) {
    values.push(input.workforceType);
    sets.push(`workforce_type = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await getPool().query<WorkforceProfileRow>(
    `UPDATE workforce_profiles SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${WORKFORCE_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workforceRepository = {
  createWorkforceProfile,
  findById,
  findByOrganizationIdAndEmployeeCode,
  findByUserId,
  listByOrganizationId,
  listByDepartmentId,
  listByTeamId,
  updateWorkforceProfile,
};
