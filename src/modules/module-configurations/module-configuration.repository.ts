import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ModuleConfigurationRecord,
  ModuleConfigurationScope,
  NewModuleConfiguration,
} from './module-configuration.types';

const MODULE_CONFIGURATION_SELECT = `
  mc.id,
  mc.scope_type AS "scopeType",
  COALESCE(mc.client_id, p.client_id) AS "clientId",
  mc.building_id AS "buildingId",
  mc.module_id AS "moduleId",
  m.code AS "moduleKey",
  m.name AS "moduleName",
  mc.enabled,
  mc.created_at AS "createdAt",
  mc.updated_at AS "updatedAt"
`;

const MODULE_CONFIGURATION_FROM = `
  FROM module_configurations mc
  JOIN modules m ON m.id = mc.module_id
  LEFT JOIN buildings b ON b.id = mc.building_id
  LEFT JOIN properties p ON p.id = b.property_id
`;

async function create(
  input: NewModuleConfiguration,
): Promise<ModuleConfigurationRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO module_configurations
       (id, scope_type, client_id, building_id, module_id, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.scopeType,
      input.clientId,
      input.buildingId,
      input.moduleId,
      input.enabled,
    ],
  );
  return (await findById(id)) as ModuleConfigurationRecord;
}

async function findById(id: string): Promise<ModuleConfigurationRecord | null> {
  const result = await getPool().query<ModuleConfigurationRecord>(
    `SELECT ${MODULE_CONFIGURATION_SELECT}
       ${MODULE_CONFIGURATION_FROM}
      WHERE mc.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByScopeAndModule(
  scopeType: ModuleConfigurationScope,
  scopeId: string,
  moduleId: string,
): Promise<ModuleConfigurationRecord | null> {
  const column = scopeType === 'CLIENT' ? 'mc.client_id' : 'mc.building_id';
  const result = await getPool().query<ModuleConfigurationRecord>(
    `SELECT ${MODULE_CONFIGURATION_SELECT}
       ${MODULE_CONFIGURATION_FROM}
      WHERE mc.scope_type = $1 AND ${column} = $2 AND mc.module_id = $3`,
    [scopeType, scopeId, moduleId],
  );
  return result.rows[0] ?? null;
}

async function listByScope(
  scopeType: ModuleConfigurationScope,
  scopeId: string,
): Promise<ModuleConfigurationRecord[]> {
  const column = scopeType === 'CLIENT' ? 'mc.client_id' : 'mc.building_id';
  const result = await getPool().query<ModuleConfigurationRecord>(
    `SELECT ${MODULE_CONFIGURATION_SELECT}
       ${MODULE_CONFIGURATION_FROM}
      WHERE mc.scope_type = $1 AND ${column} = $2
      ORDER BY m.code ASC`,
    [scopeType, scopeId],
  );
  return result.rows;
}

async function updateEnabled(
  id: string,
  enabled: boolean,
): Promise<ModuleConfigurationRecord | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE module_configurations
        SET enabled = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [id, enabled],
  );
  if (!result.rows[0]) return null;
  return findById(result.rows[0].id);
}

export const moduleConfigurationRepository = {
  create,
  findById,
  findByScopeAndModule,
  listByScope,
  updateEnabled,
};
