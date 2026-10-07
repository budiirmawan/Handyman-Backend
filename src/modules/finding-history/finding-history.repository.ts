import { getPool } from '../../database';
import type {
  FindingHistoryFilters,
  PublicFindingHistoryEvent,
} from './finding-history.types';

type Row = {
  id: string;
  client_id: string;
  entity_id: string;
  actor_user_id: string | null;
  building_id: string | null;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
};

function map(row: Row): PublicFindingHistoryEvent {
  return {
    id: row.id,
    findingId: row.entity_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    summary: row.summary,
    metadata: row.metadata ?? {},
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

async function listByFinding(
  findingId: string,
  filters: FindingHistoryFilters,
): Promise<PublicFindingHistoryEvent[]> {
  const conditions = ["entity_type='FINDING'", 'entity_id=$1'];
  const values: unknown[] = [findingId];
  if (filters.eventType !== undefined) {
    values.push(filters.eventType);
    conditions.push(`event_type=$${values.length}`);
  }
  if (filters.from !== undefined) {
    values.push(new Date(filters.from));
    conditions.push(`occurred_at >= $${values.length}`);
  }
  if (filters.to !== undefined) {
    values.push(new Date(filters.to));
    conditions.push(`occurred_at <= $${values.length}`);
  }
  const result = await getPool().query<Row>(
    `SELECT * FROM operational_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY occurred_at ASC, id ASC`,
    values,
  );
  return result.rows.map(map);
}

export const findingHistoryRepository = { listByFinding };
