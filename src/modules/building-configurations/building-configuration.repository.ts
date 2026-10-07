import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  BuildingConfigurationFilters,
  BuildingConfigurationRecord,
  NewBuildingConfiguration,
  UpdateBuildingConfigurationInput,
} from './building-configuration.types';

/** Client context is always derived from the existing Building hierarchy. */
const BUILDING_CONFIGURATION_SELECT = `
  bc.id,
  p.client_id AS "clientId",
  bc.building_id AS "buildingId",
  bc.key,
  bc.value,
  bc.status,
  bc.created_at AS "createdAt",
  bc.updated_at AS "updatedAt"
`;

const BUILDING_CONFIGURATION_FROM = `
  FROM building_configurations bc
  JOIN buildings b ON b.id = bc.building_id
  JOIN properties p ON p.id = b.property_id
`;

async function create(
  input: NewBuildingConfiguration,
): Promise<BuildingConfigurationRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO building_configurations (id, building_id, key, value, status)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      id,
      input.buildingId,
      input.key,
      JSON.stringify(input.value),
      input.status,
    ],
  );
  return (await findById(id)) as BuildingConfigurationRecord;
}

async function findById(id: string): Promise<BuildingConfigurationRecord | null> {
  const result = await getPool().query<BuildingConfigurationRecord>(
    `SELECT ${BUILDING_CONFIGURATION_SELECT}
       ${BUILDING_CONFIGURATION_FROM}
      WHERE bc.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByBuildingAndKey(
  buildingId: string,
  key: string,
): Promise<BuildingConfigurationRecord | null> {
  const result = await getPool().query<BuildingConfigurationRecord>(
    `SELECT ${BUILDING_CONFIGURATION_SELECT}
       ${BUILDING_CONFIGURATION_FROM}
      WHERE bc.building_id = $1 AND bc.key = $2`,
    [buildingId, key],
  );
  return result.rows[0] ?? null;
}

async function listByBuilding(
  buildingId: string,
  filters: BuildingConfigurationFilters = {},
): Promise<BuildingConfigurationRecord[]> {
  const values: unknown[] = [buildingId];
  const where = ['bc.building_id = $1'];
  if (filters.status) {
    values.push(filters.status);
    where.push(`bc.status = $${values.length}`);
  }

  const result = await getPool().query<BuildingConfigurationRecord>(
    `SELECT ${BUILDING_CONFIGURATION_SELECT}
       ${BUILDING_CONFIGURATION_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY bc.key ASC`,
    values,
  );
  return result.rows;
}

async function listActiveByBuilding(
  buildingId: string,
): Promise<BuildingConfigurationRecord[]> {
  return listByBuilding(buildingId, { status: 'ACTIVE' });
}

async function update(
  id: string,
  input: UpdateBuildingConfigurationInput,
): Promise<BuildingConfigurationRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.value !== undefined) {
    values.push(JSON.stringify(input.value));
    sets.push(`value = $${values.length}::jsonb`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (sets.length === 0) return findById(id);

  values.push(id);
  const result = await getPool().query<{ id: string }>(
    `UPDATE building_configurations
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING id`,
    values,
  );
  if (!result.rows[0]) return null;
  return findById(result.rows[0].id);
}

export const buildingConfigurationRepository = {
  create,
  findByBuildingAndKey,
  findById,
  listActiveByBuilding,
  listByBuilding,
  update,
};
