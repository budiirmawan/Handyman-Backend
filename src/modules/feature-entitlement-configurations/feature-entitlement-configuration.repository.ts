import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { ModuleConfigurationScope } from '../module-configurations';
import type {
  FeatureEntitlementConfigurationRecord,
  FeatureEntitlementState,
  NewFeatureEntitlementConfiguration,
} from './feature-entitlement-configuration.types';

const SELECT = `
  fec.id,
  fec.scope_type AS "scopeType",
  COALESCE(fec.client_id, p.client_id) AS "clientId",
  fec.building_id AS "buildingId",
  fec.module_id AS "moduleId",
  m.code AS "moduleKey",
  m.name AS "moduleName",
  fec.feature_key AS "featureKey",
  fec.state,
  fec.created_at AS "createdAt",
  fec.updated_at AS "updatedAt"
`;
const FROM = `
  FROM feature_entitlement_configurations fec
  JOIN modules m ON m.id = fec.module_id
  LEFT JOIN buildings b ON b.id = fec.building_id
  LEFT JOIN properties p ON p.id = b.property_id
`;

async function create(
  input: NewFeatureEntitlementConfiguration,
): Promise<FeatureEntitlementConfigurationRecord> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO feature_entitlement_configurations
       (id, scope_type, client_id, building_id, module_id, feature_key, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.scopeType,
      input.clientId,
      input.buildingId,
      input.moduleId,
      input.featureKey,
      input.state,
    ],
  );
  return (await findById(id)) as FeatureEntitlementConfigurationRecord;
}

async function findById(
  id: string,
): Promise<FeatureEntitlementConfigurationRecord | null> {
  const result = await getPool().query<FeatureEntitlementConfigurationRecord>(
    `SELECT ${SELECT} ${FROM} WHERE fec.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByScopeModuleFeature(
  scopeType: ModuleConfigurationScope,
  scopeId: string,
  moduleId: string,
  featureKey: string,
): Promise<FeatureEntitlementConfigurationRecord | null> {
  const column = scopeType === 'CLIENT' ? 'fec.client_id' : 'fec.building_id';
  const result = await getPool().query<FeatureEntitlementConfigurationRecord>(
    `SELECT ${SELECT} ${FROM}
      WHERE fec.scope_type = $1 AND ${column} = $2
        AND fec.module_id = $3 AND fec.feature_key = $4`,
    [scopeType, scopeId, moduleId, featureKey],
  );
  return result.rows[0] ?? null;
}

async function listByScope(
  scopeType: ModuleConfigurationScope,
  scopeId: string,
): Promise<FeatureEntitlementConfigurationRecord[]> {
  const column = scopeType === 'CLIENT' ? 'fec.client_id' : 'fec.building_id';
  const result = await getPool().query<FeatureEntitlementConfigurationRecord>(
    `SELECT ${SELECT} ${FROM}
      WHERE fec.scope_type = $1 AND ${column} = $2
      ORDER BY m.code ASC, fec.feature_key ASC`,
    [scopeType, scopeId],
  );
  return result.rows;
}

async function updateState(
  id: string,
  state: FeatureEntitlementState,
): Promise<FeatureEntitlementConfigurationRecord | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE feature_entitlement_configurations
        SET state = $2, updated_at = NOW()
      WHERE id = $1 RETURNING id`,
    [id, state],
  );
  return result.rows[0] ? findById(result.rows[0].id) : null;
}

export const featureEntitlementConfigurationRepository = {
  create,
  findById,
  findByScopeModuleFeature,
  listByScope,
  updateState,
};
