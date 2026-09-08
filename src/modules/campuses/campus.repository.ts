import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CampusRecord,
  CampusStatus,
  NewCampus,
  UpdateCampusInput,
} from './campus.types';

type CampusRow = {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  description: string | null;
  status: CampusStatus;
  createdAt: Date;
  updatedAt: Date;
};

const CAMPUS_SELECT = `
  id,
  property_id AS "propertyId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapCampusRow(row: CampusRow): CampusRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createCampus(input: NewCampus): Promise<CampusRecord> {
  const result = await getPool().query<CampusRow>(
    `INSERT INTO campuses
       (id, property_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${CAMPUS_SELECT}`,
    [
      randomUUID(),
      input.propertyId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapCampusRow(result.rows[0]);
}

async function findById(id: string): Promise<CampusRecord | null> {
  const result = await getPool().query<CampusRow>(
    `SELECT ${CAMPUS_SELECT} FROM campuses WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapCampusRow(row) : null;
}

async function findByCodeForProperty(
  propertyId: string,
  code: string,
): Promise<CampusRecord | null> {
  const result = await getPool().query<CampusRow>(
    `SELECT ${CAMPUS_SELECT} FROM campuses
     WHERE property_id = $1 AND code = $2`,
    [propertyId, code],
  );

  const row = result.rows[0];
  return row ? mapCampusRow(row) : null;
}

async function listByProperty(propertyId: string): Promise<CampusRecord[]> {
  const result = await getPool().query<CampusRow>(
    `SELECT ${CAMPUS_SELECT} FROM campuses
     WHERE property_id = $1 ORDER BY code ASC`,
    [propertyId],
  );

  return result.rows.map(mapCampusRow);
}

async function updateCampus(
  id: string,
  input: UpdateCampusInput,
): Promise<CampusRecord | null> {
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

  const result = await getPool().query<CampusRow>(
    `UPDATE campuses SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${CAMPUS_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapCampusRow(row) : null;
}

async function updateStatus(
  id: string,
  status: CampusStatus,
): Promise<CampusRecord | null> {
  const result = await getPool().query<CampusRow>(
    `UPDATE campuses SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${CAMPUS_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapCampusRow(row) : null;
}

export const campusRepository = {
  createCampus,
  findByCodeForProperty,
  findById,
  listByProperty,
  updateCampus,
  updateStatus,
};
