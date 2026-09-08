import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPosition,
  PositionRecord,
  PositionStatus,
  UpdatePositionInput,
} from './position.types';

type PositionRow = {
  id: string;
  organization_id: string;
  department_id: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PositionStatus;
  created_at: Date;
  updated_at: Date;
};

const POSITION_SELECT = `
  id,
  organization_id,
  department_id,
  code,
  name,
  description,
  status,
  created_at,
  updated_at
`;

function mapRow(row: PositionRow): PositionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    departmentId: row.department_id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createPosition(input: NewPosition): Promise<PositionRecord> {
  const result = await getPool().query<PositionRow>(
    `INSERT INTO positions (id, organization_id, department_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${POSITION_SELECT}`,
    [
      randomUUID(),
      input.organizationId,
      input.departmentId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<PositionRecord | null> {
  const result = await getPool().query<PositionRow>(
    `SELECT ${POSITION_SELECT} FROM positions WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByOrganizationIdAndCode(
  organizationId: string,
  code: string,
): Promise<PositionRecord | null> {
  const result = await getPool().query<PositionRow>(
    `SELECT ${POSITION_SELECT}
       FROM positions
      WHERE organization_id = $1 AND code = $2`,
    [organizationId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByOrganizationId(organizationId: string): Promise<PositionRecord[]> {
  const result = await getPool().query<PositionRow>(
    `SELECT ${POSITION_SELECT}
       FROM positions
      WHERE organization_id = $1
      ORDER BY code ASC`,
    [organizationId],
  );

  return result.rows.map(mapRow);
}

async function listByDepartmentId(departmentId: string): Promise<PositionRecord[]> {
  const result = await getPool().query<PositionRow>(
    `SELECT ${POSITION_SELECT}
       FROM positions
      WHERE department_id = $1
      ORDER BY code ASC`,
    [departmentId],
  );

  return result.rows.map(mapRow);
}

async function updatePosition(
  id: string,
  input: UpdatePositionInput,
): Promise<PositionRecord | null> {
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

  const result = await getPool().query<PositionRow>(
    `UPDATE positions SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${POSITION_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const positionRepository = {
  createPosition,
  findById,
  findByOrganizationIdAndCode,
  listByOrganizationId,
  listByDepartmentId,
  updatePosition,
};
