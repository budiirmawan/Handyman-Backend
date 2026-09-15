import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  DepartmentRecord,
  DepartmentStatus,
  NewDepartment,
  UpdateDepartmentInput,
} from './department.types';

type DepartmentRow = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string | null;
  status: DepartmentStatus;
  created_at: Date;
  updated_at: Date;
};

const DEPT_SELECT = `
  id,
  organization_id,
  code,
  name,
  description,
  status,
  created_at,
  updated_at
`;

function mapRow(row: DepartmentRow): DepartmentRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createDepartment(input: NewDepartment): Promise<DepartmentRecord> {
  const result = await getPool().query<DepartmentRow>(
    `INSERT INTO departments (id, organization_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${DEPT_SELECT}`,
    [
      randomUUID(),
      input.organizationId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<DepartmentRecord | null> {
  const result = await getPool().query<DepartmentRow>(
    `SELECT ${DEPT_SELECT} FROM departments WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByOrganizationIdAndCode(
  organizationId: string,
  code: string,
): Promise<DepartmentRecord | null> {
  const result = await getPool().query<DepartmentRow>(
    `SELECT ${DEPT_SELECT}
       FROM departments
      WHERE organization_id = $1 AND code = $2`,
    [organizationId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByOrganizationId(organizationId: string): Promise<DepartmentRecord[]> {
  const result = await getPool().query<DepartmentRow>(
    `SELECT ${DEPT_SELECT}
       FROM departments
      WHERE organization_id = $1
      ORDER BY code ASC`,
    [organizationId],
  );

  return result.rows.map(mapRow);
}

async function updateDepartment(
  id: string,
  input: UpdateDepartmentInput,
): Promise<DepartmentRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<DepartmentRow>(
    `UPDATE departments SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${DEPT_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const departmentRepository = {
  createDepartment,
  findById,
  findByOrganizationIdAndCode,
  listByOrganizationId,
  updateDepartment,
};
