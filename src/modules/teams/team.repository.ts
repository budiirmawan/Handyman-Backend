import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTeam,
  TeamRecord,
  TeamStatus,
  UpdateTeamInput,
} from './team.types';

type TeamRow = {
  id: string;
  department_id: string;
  code: string;
  name: string;
  description: string | null;
  status: TeamStatus;
  created_at: Date;
  updated_at: Date;
};

const TEAM_SELECT = `
  id,
  department_id,
  code,
  name,
  description,
  status,
  created_at,
  updated_at
`;

function mapRow(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    departmentId: row.department_id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createTeam(input: NewTeam): Promise<TeamRecord> {
  const result = await getPool().query<TeamRow>(
    `INSERT INTO teams (id, department_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${TEAM_SELECT}`,
    [
      randomUUID(),
      input.departmentId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<TeamRecord | null> {
  const result = await getPool().query<TeamRow>(
    `SELECT ${TEAM_SELECT} FROM teams WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByDepartmentIdAndCode(
  departmentId: string,
  code: string,
): Promise<TeamRecord | null> {
  const result = await getPool().query<TeamRow>(
    `SELECT ${TEAM_SELECT}
       FROM teams
      WHERE department_id = $1 AND code = $2`,
    [departmentId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByDepartmentId(departmentId: string): Promise<TeamRecord[]> {
  const result = await getPool().query<TeamRow>(
    `SELECT ${TEAM_SELECT}
       FROM teams
      WHERE department_id = $1
      ORDER BY code ASC`,
    [departmentId],
  );

  return result.rows.map(mapRow);
}

async function updateTeam(
  id: string,
  input: UpdateTeamInput,
): Promise<TeamRecord | null> {
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

  const result = await getPool().query<TeamRow>(
    `UPDATE teams SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${TEAM_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const teamRepository = {
  createTeam,
  findById,
  findByDepartmentIdAndCode,
  listByDepartmentId,
  updateTeam,
};
