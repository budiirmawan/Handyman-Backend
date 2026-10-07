import { getPool } from '../../database';
import { CONFIGURATION_VERSION_SOURCE_TYPES } from '../configuration-versions/configuration-version.types';
import {
  CONFIGURATION_AUDIT_ACTIONS,
  type ConfigurationAuditAction,
  type ConfigurationAuditFilters,
} from './configuration-audit.types';
type AuditRow = {
  id: string;
  client_id: string;
  event_type: ConfigurationAuditAction;
  entity_id: string;
  actor_user_id: string | null;
  building_id: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
};

async function findById(id: string): Promise<AuditRow | null> {
  const result = await getPool().query<AuditRow>(
    `SELECT id,client_id,event_type,entity_id,actor_user_id,building_id,
       summary,metadata,occurred_at
     FROM operational_events
     WHERE id=$1 AND entity_type='CONFIGURATION'
       AND event_type=ANY($2::text[])
       AND metadata->>'sourceType'=ANY($3::text[])`,
    [id, CONFIGURATION_AUDIT_ACTIONS, CONFIGURATION_VERSION_SOURCE_TYPES],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: ConfigurationAuditFilters,
  buildingIds: string[],
  clientIds: string[],
): Promise<AuditRow[]> {
  const values: unknown[] = [
    buildingIds,
    clientIds,
    CONFIGURATION_AUDIT_ACTIONS,
    CONFIGURATION_VERSION_SOURCE_TYPES,
  ];
  const where = [
    `entity_type='CONFIGURATION'`,
    `(building_id=ANY($1::uuid[]) OR (building_id IS NULL AND client_id=ANY($2::uuid[])))`,
    `event_type=ANY($3::text[])`,
    `metadata->>'sourceType'=ANY($4::text[])`,
  ];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.configurationId) add('entity_id=?', filters.configurationId);
  if (filters.configurationVersionId) {
    add(`metadata->>'configurationVersionId'=?`, filters.configurationVersionId);
  }
  if (filters.sourceType) add(`metadata->>'sourceType'=?`, filters.sourceType);
  if (filters.action) add('event_type=?', filters.action);
  if (filters.buildingId) add('building_id=?', filters.buildingId);
  if (filters.from) add('occurred_at>=?', filters.from);
  if (filters.to) add('occurred_at<=?', filters.to);
  const result = await getPool().query<AuditRow>(
    `SELECT id,client_id,event_type,entity_id,actor_user_id,building_id,
       summary,metadata,occurred_at
     FROM operational_events
     WHERE ${where.join(' AND ')}
     ORDER BY occurred_at ASC,id ASC`,
    values,
  );
  return result.rows;
}

export type { AuditRow };
export const configurationAuditRepository = { findById, list };
