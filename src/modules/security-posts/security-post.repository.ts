import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateSecurityPostInput,
  SecurityPostFilter,
  SecurityPostRecord,
  SecurityPostStatus,
  SecurityPostType,
  UpdateSecurityPostInput,
} from './security-post.types';

type SecurityPostRow = {
  id: string;
  client_id: string;
  building_id: string;
  floor_id: string | null;
  area_id: string | null;
  room_id: string | null;
  space_id: string | null;
  functional_location_id: string | null;
  code: string;
  name: string;
  description: string | null;
  post_type: SecurityPostType;
  status: SecurityPostStatus;
  created_at: Date;
  updated_at: Date;
};

const SECURITY_POST_COLUMNS = `
  id, client_id, building_id, floor_id, area_id, room_id, space_id,
  functional_location_id, code, name, description, post_type, status,
  created_at, updated_at
`;

function mapRow(row: SecurityPostRow): SecurityPostRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    floorId: row.floor_id,
    areaId: row.area_id,
    roomId: row.room_id,
    spaceId: row.space_id,
    functionalLocationId: row.functional_location_id,
    code: row.code,
    name: row.name,
    description: row.description,
    postType: row.post_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: CreateSecurityPostInput & { clientId: string },
): Promise<SecurityPostRecord> {
  const result = await getPool().query<SecurityPostRow>(
    `INSERT INTO security_posts
       (id, client_id, building_id, floor_id, area_id, room_id, space_id,
        functional_location_id, code, name, description, post_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${SECURITY_POST_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.floorId ?? null,
      input.areaId ?? null,
      input.roomId ?? null,
      input.spaceId ?? null,
      input.functionalLocationId ?? null,
      input.code,
      input.name,
      input.description ?? null,
      input.postType ?? 'GENERAL',
      input.status ?? 'ACTIVE',
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SecurityPostRecord | null> {
  const result = await getPool().query<SecurityPostRow>(
    `SELECT ${SECURITY_POST_COLUMNS}
     FROM security_posts
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByCodeForBuilding(
  buildingId: string,
  code: string,
): Promise<SecurityPostRecord | null> {
  const result = await getPool().query<SecurityPostRow>(
    `SELECT ${SECURITY_POST_COLUMNS}
     FROM security_posts
     WHERE building_id = $1 AND code = $2`,
    [buildingId, code],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuilding(
  buildingId: string,
  filter: SecurityPostFilter = {},
): Promise<SecurityPostRecord[]> {
  const conditions = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  if (filter.postType !== undefined) {
    values.push(filter.postType);
    conditions.push(`post_type = $${values.length}`);
  }

  if (filter.floorId !== undefined) {
    values.push(filter.floorId);
    conditions.push(`floor_id = $${values.length}`);
  }

  if (filter.areaId !== undefined) {
    values.push(filter.areaId);
    conditions.push(`area_id = $${values.length}`);
  }

  if (filter.roomId !== undefined) {
    values.push(filter.roomId);
    conditions.push(`room_id = $${values.length}`);
  }

  if (filter.spaceId !== undefined) {
    values.push(filter.spaceId);
    conditions.push(`space_id = $${values.length}`);
  }

  if (filter.functionalLocationId !== undefined) {
    values.push(filter.functionalLocationId);
    conditions.push(`functional_location_id = $${values.length}`);
  }

  const result = await getPool().query<SecurityPostRow>(
    `SELECT ${SECURITY_POST_COLUMNS}
     FROM security_posts
     WHERE ${conditions.join(' AND ')}
     ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateSecurityPostInput,
): Promise<SecurityPostRecord | null> {
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

  if (input.postType !== undefined) {
    values.push(input.postType);
    sets.push(`post_type = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (input.floorId !== undefined) {
    values.push(input.floorId);
    sets.push(`floor_id = $${values.length}`);
  }

  if (input.areaId !== undefined) {
    values.push(input.areaId);
    sets.push(`area_id = $${values.length}`);
  }

  if (input.roomId !== undefined) {
    values.push(input.roomId);
    sets.push(`room_id = $${values.length}`);
  }

  if (input.spaceId !== undefined) {
    values.push(input.spaceId);
    sets.push(`space_id = $${values.length}`);
  }

  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<SecurityPostRow>(
    `UPDATE security_posts
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${SECURITY_POST_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function updateStatus(
  id: string,
  status: SecurityPostStatus,
): Promise<SecurityPostRecord | null> {
  const result = await getPool().query<SecurityPostRow>(
    `UPDATE security_posts
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING ${SECURITY_POST_COLUMNS}`,
    [status, id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const securityPostRepository = {
  create,
  findByCodeForBuilding,
  findById,
  listByBuilding,
  update,
  updateStatus,
};
