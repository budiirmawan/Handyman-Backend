import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  FunctionalLocationRecord,
  FunctionalLocationStatus,
  NewFunctionalLocation,
  UpdateFunctionalLocationInput,
} from './functional-location.types';

type FunctionalLocationRow = {
  id: string;
  buildingId: string;
  spaceId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: FunctionalLocationStatus;
  createdAt: Date;
  updatedAt: Date;
};

const FUNCTIONAL_LOCATION_SELECT = `
  id,
  building_id AS "buildingId",
  space_id AS "spaceId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: FunctionalLocationRow): FunctionalLocationRecord {
  return {
    id: row.id,
    buildingId: row.buildingId,
    spaceId: row.spaceId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createFunctionalLocation(
  input: NewFunctionalLocation,
): Promise<FunctionalLocationRecord> {
  const result = await getPool().query<FunctionalLocationRow>(
    `INSERT INTO functional_locations
       (id, building_id, space_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${FUNCTIONAL_LOCATION_SELECT}`,
    [
      randomUUID(),
      input.buildingId,
      input.spaceId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<FunctionalLocationRecord | null> {
  const result = await getPool().query<FunctionalLocationRow>(
    `SELECT ${FUNCTIONAL_LOCATION_SELECT} FROM functional_locations
     WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCodeForBuilding(
  buildingId: string,
  code: string,
): Promise<FunctionalLocationRecord | null> {
  const result = await getPool().query<FunctionalLocationRow>(
    `SELECT ${FUNCTIONAL_LOCATION_SELECT} FROM functional_locations
     WHERE building_id = $1 AND code = $2`,
    [buildingId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByBuilding(
  buildingId: string,
  spaceId?: string,
): Promise<FunctionalLocationRecord[]> {
  if (spaceId !== undefined) {
    const result = await getPool().query<FunctionalLocationRow>(
      `SELECT ${FUNCTIONAL_LOCATION_SELECT} FROM functional_locations
       WHERE building_id = $1 AND space_id = $2 ORDER BY code ASC`,
      [buildingId, spaceId],
    );
    return result.rows.map(mapRow);
  }

  const result = await getPool().query<FunctionalLocationRow>(
    `SELECT ${FUNCTIONAL_LOCATION_SELECT} FROM functional_locations
     WHERE building_id = $1 ORDER BY code ASC`,
    [buildingId],
  );
  return result.rows.map(mapRow);
}

async function updateFunctionalLocation(
  id: string,
  input: UpdateFunctionalLocationInput,
): Promise<FunctionalLocationRecord | null> {
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
  if (input.spaceId !== undefined) {
    values.push(input.spaceId);
    sets.push(`space_id = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<FunctionalLocationRow>(
    `UPDATE functional_locations SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${FUNCTIONAL_LOCATION_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: FunctionalLocationStatus,
): Promise<FunctionalLocationRecord | null> {
  const result = await getPool().query<FunctionalLocationRow>(
    `UPDATE functional_locations SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${FUNCTIONAL_LOCATION_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const functionalLocationRepository = {
  createFunctionalLocation,
  findByCodeForBuilding,
  findById,
  listByBuilding,
  updateFunctionalLocation,
  updateStatus,
};
