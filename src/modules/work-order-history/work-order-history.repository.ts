import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import type {
  PublicWorkOrderHistoryEvent,
  WorkOrderHistoryFilters,
} from './work-order-history.types';

type EventRow = {
  id: string;
  client_id: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string | null;
  building_id: string | null;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
};

function mapRow(row: EventRow): PublicWorkOrderHistoryEvent {
  return {
    id: row.id,
    workOrderId: row.entity_id,
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

/**
 * Compatibility adapter for the repository's existing insert seam. The
 * shared BE-07 writer now owns correlation, scrubbing, and the integration
 * outbox hook; an optional executor preserves callers that need one
 * transaction for the Work Order mutation and event.
 */
async function insertEvent(
  input: {
    clientId: string;
    eventType: string;
    entityId: string;
    actorUserId: string | null;
    buildingId: string | null;
    summary: string;
    metadata?: Record<string, unknown>;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<PublicWorkOrderHistoryEvent> {
  const record = await recordOperationalEvent(
    {
      clientId: input.clientId,
      eventType: input.eventType,
      entityType: 'WORK_ORDER',
      entityId: input.entityId,
      actorUserId: input.actorUserId,
      buildingId: input.buildingId,
      summary: input.summary,
      metadata: input.metadata,
    },
    executor,
  );

  return mapRow(record);
}

async function listByWorkOrder(
  workOrderId: string,
  filters: WorkOrderHistoryFilters,
): Promise<PublicWorkOrderHistoryEvent[]> {
  const conditions: string[] = [
    "entity_type = 'WORK_ORDER'",
    'entity_id = $1',
  ];
  const values: unknown[] = [workOrderId];
  let index = 1;

  if (filters.eventType !== undefined) {
    values.push(filters.eventType);
    index += 1;
    conditions.push(`event_type = $${index}`);
  }
  if (filters.from !== undefined) {
    values.push(new Date(filters.from));
    index += 1;
    conditions.push(`occurred_at >= $${index}`);
  }
  if (filters.to !== undefined) {
    values.push(new Date(filters.to));
    index += 1;
    conditions.push(`occurred_at <= $${index}`);
  }

  const result = await getPool().query<EventRow>(
    `SELECT * FROM operational_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY occurred_at ASC, id ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const workOrderHistoryRepository = {
  insertEvent,
  listByWorkOrder,
};
