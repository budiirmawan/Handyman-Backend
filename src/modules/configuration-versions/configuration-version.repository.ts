import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import type {
  CaptureConfigurationVersionInput,
  ConfigurationLifecycleStatus,
  ConfigurationValidationError,
  ConfigurationValidationRecord,
  ConfigurationVersionRecord,
  ConfigurationVersionSourceType,
} from './configuration-version.types';

const SELECT = `
  id,
  source_type AS "sourceType",
  source_configuration_id AS "sourceConfigurationId",
  client_id AS "clientId",
  building_id AS "buildingId",
  version_number AS "versionNumber",
  status,
  lifecycle_status AS "lifecycleStatus",
  previous_version_id AS "previousVersionId",
  snapshot,
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt"
`;

async function createNext(
  input: CaptureConfigurationVersionInput,
  createdByUserId: string,
): Promise<ConfigurationVersionRecord> {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
      [input.sourceType, input.sourceConfigurationId],
    );
    const previous = await client.query<{
      id: string;
      versionNumber: number;
    }>(
      `SELECT id,version_number AS "versionNumber"
         FROM configuration_versions
        WHERE source_type=$1 AND source_configuration_id=$2
        ORDER BY version_number DESC LIMIT 1`,
      [input.sourceType, input.sourceConfigurationId],
    );
    const prior = previous.rows[0];
    const id = randomUUID();
    const result = await client.query<ConfigurationVersionRecord>(
      `INSERT INTO configuration_versions(
         id,source_type,source_configuration_id,client_id,building_id,
         version_number,status,previous_version_id,snapshot,created_by_user_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING ${SELECT}`,
      [
        id,
        input.sourceType,
        input.sourceConfigurationId,
        input.clientId,
        input.buildingId,
        (prior?.versionNumber ?? 0) + 1,
        input.status,
        prior?.id ?? null,
        JSON.stringify(input.snapshot),
        createdByUserId,
      ],
    );
    return result.rows[0];
  });
}

async function findById(id: string): Promise<ConfigurationVersionRecord | null> {
  const result = await getPool().query<ConfigurationVersionRecord>(
    `SELECT ${SELECT} FROM configuration_versions WHERE id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveBySource(
  sourceType: ConfigurationVersionSourceType,
  sourceConfigurationId: string,
): Promise<ConfigurationVersionRecord | null> {
  const result = await getPool().query<ConfigurationVersionRecord>(
    `SELECT ${SELECT} FROM configuration_versions
      WHERE source_type=$1 AND source_configuration_id=$2
        AND lifecycle_status='ACTIVE'`,
    [sourceType, sourceConfigurationId],
  );
  return result.rows[0] ?? null;
}

async function listBySource(
  sourceType: ConfigurationVersionSourceType,
  sourceConfigurationId: string,
): Promise<ConfigurationVersionRecord[]> {
  const result = await getPool().query<ConfigurationVersionRecord>(
    `SELECT ${SELECT} FROM configuration_versions
      WHERE source_type=$1 AND source_configuration_id=$2
      ORDER BY version_number ASC`,
    [sourceType, sourceConfigurationId],
  );
  return result.rows;
}

async function addValidation(
  versionId: string,
  valid: boolean,
  errors: ConfigurationValidationError[],
  userId: string,
): Promise<ConfigurationValidationRecord> {
  return withTransaction(async (client) => {
    const version = await client.query<ConfigurationVersionRecord>(
      `SELECT ${SELECT} FROM configuration_versions WHERE id=$1 FOR UPDATE`,
      [versionId],
    );
    const current = version.rows[0];
    if (!current) throw new Error('CONFIGURATION_VERSION_NOT_FOUND');
    const id = randomUUID();
    const validation = await client.query<ConfigurationValidationRecord>(
      `INSERT INTO configuration_version_validations(
         id,configuration_version_id,valid,errors,validated_by_user_id
       ) VALUES($1,$2,$3,$4::jsonb,$5)
       RETURNING id,configuration_version_id AS "configurationVersionId",valid,
         errors,validated_by_user_id AS "validatedByUserId",
         validated_at AS "validatedAt"`,
      [id, versionId, valid, JSON.stringify(errors), userId],
    );
    if (valid && current.lifecycleStatus === 'DRAFT') {
      await client.query(
        `UPDATE configuration_versions SET lifecycle_status='VALIDATED' WHERE id=$1`,
        [versionId],
      );
      await client.query(
        `INSERT INTO configuration_version_transitions(
           id,configuration_version_id,from_status,to_status,transitioned_by_user_id
         ) VALUES($1,$2,'DRAFT','VALIDATED',$3)`,
        [randomUUID(), versionId, userId],
      );
    }
    return validation.rows[0];
  });
}

async function listValidations(
  versionId: string,
): Promise<ConfigurationValidationRecord[]> {
  const result = await getPool().query<ConfigurationValidationRecord>(
    `SELECT id,configuration_version_id AS "configurationVersionId",valid,
       errors,validated_by_user_id AS "validatedByUserId",
       validated_at AS "validatedAt"
     FROM configuration_version_validations
     WHERE configuration_version_id=$1 ORDER BY validated_at,id`,
    [versionId],
  );
  return result.rows;
}

async function transition(
  versionId: string,
  expected: ConfigurationLifecycleStatus,
  target: ConfigurationLifecycleStatus,
  userId: string,
): Promise<ConfigurationVersionRecord | null> {
  return withTransaction(async (client) => {
    const locked = await client.query<ConfigurationVersionRecord>(
      `SELECT ${SELECT} FROM configuration_versions WHERE id=$1 FOR UPDATE`,
      [versionId],
    );
    const current = locked.rows[0];
    if (!current || current.lifecycleStatus !== expected) return null;
    const updated = await client.query<ConfigurationVersionRecord>(
      `UPDATE configuration_versions SET lifecycle_status=$1 WHERE id=$2
       RETURNING ${SELECT}`,
      [target, versionId],
    );
    await client.query(
      `INSERT INTO configuration_version_transitions(
         id,configuration_version_id,from_status,to_status,transitioned_by_user_id
       ) VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), versionId, expected, target, userId],
    );
    return updated.rows[0];
  });
}

async function activate(
  versionId: string,
  userId: string,
): Promise<ConfigurationVersionRecord | null> {
  return withTransaction(async (client) => {
    const targetResult = await client.query<ConfigurationVersionRecord>(
      `SELECT ${SELECT} FROM configuration_versions WHERE id=$1 FOR UPDATE`,
      [versionId],
    );
    const target = targetResult.rows[0];
    if (!target || target.lifecycleStatus !== 'PUBLISHED') return null;
    const active = await client.query<ConfigurationVersionRecord>(
      `SELECT ${SELECT} FROM configuration_versions
       WHERE source_type=$1 AND source_configuration_id=$2
         AND lifecycle_status='ACTIVE' AND id<>$3
       FOR UPDATE`,
      [target.sourceType, target.sourceConfigurationId, target.id],
    );
    for (const previous of active.rows) {
      await client.query(
        `UPDATE configuration_versions SET lifecycle_status='SUPERSEDED' WHERE id=$1`,
        [previous.id],
      );
      await client.query(
        `INSERT INTO configuration_version_transitions(
           id,configuration_version_id,from_status,to_status,transitioned_by_user_id
         ) VALUES($1,$2,'ACTIVE','SUPERSEDED',$3)`,
        [randomUUID(), previous.id, userId],
      );
    }
    const updated = await client.query<ConfigurationVersionRecord>(
      `UPDATE configuration_versions SET lifecycle_status='ACTIVE' WHERE id=$1
       RETURNING ${SELECT}`,
      [target.id],
    );
    await client.query(
      `INSERT INTO configuration_version_transitions(
         id,configuration_version_id,from_status,to_status,transitioned_by_user_id
       ) VALUES($1,$2,'PUBLISHED','ACTIVE',$3)`,
      [randomUUID(), target.id, userId],
    );
    return updated.rows[0];
  });
}

type SourceContext = { clientId: string; buildingId: string | null };
async function findSourceContext(
  sourceType: ConfigurationVersionSourceType,
  sourceId: string,
): Promise<SourceContext | null> {
  const scoped = (table: string) => `
    SELECT COALESCE(x.client_id,p.client_id) AS "clientId",
      x.building_id AS "buildingId"
    FROM ${table} x
    LEFT JOIN buildings b ON b.id=x.building_id
    LEFT JOIN properties p ON p.id=b.property_id
    WHERE x.id=$1`;
  const sql: Record<ConfigurationVersionSourceType, string> = {
    CLIENT_CONFIGURATION:
      'SELECT client_id AS "clientId",NULL::uuid AS "buildingId" FROM client_configurations WHERE id=$1',
    BUILDING_CONFIGURATION: `
      SELECT p.client_id AS "clientId",bc.building_id AS "buildingId"
      FROM building_configurations bc
      JOIN buildings b ON b.id=bc.building_id
      JOIN properties p ON p.id=b.property_id
      WHERE bc.id=$1`,
    MODULE_CONFIGURATION: scoped('module_configurations'),
    FEATURE_ENTITLEMENT_CONFIGURATION: scoped(
      'feature_entitlement_configurations',
    ),
    NAVIGATION_ITEM: scoped('navigation_items'),
    WORKSPACE: scoped('workspaces'),
    DASHBOARD: scoped('dashboards'),
    DASHBOARD_WIDGET: `
      SELECT COALESCE(d.client_id,p.client_id) AS "clientId",
        d.building_id AS "buildingId"
      FROM dashboard_widgets w JOIN dashboards d ON d.id=w.dashboard_id
      LEFT JOIN buildings b ON b.id=d.building_id
      LEFT JOIN properties p ON p.id=b.property_id
      WHERE w.id=$1`,
    CMS_CONTENT: scoped('cms_content'),
  };
  const result = await getPool().query<SourceContext>(sql[sourceType], [sourceId]);
  return result.rows[0] ?? null;
}

export const configurationVersionRepository = {
  activate,
  addValidation,
  createNext,
  findActiveBySource,
  findById,
  findSourceContext,
  listBySource,
  listValidations,
  transition,
};
