import { recordOperationalEvent } from '../operational-events';
import { workOrderNotFoundError } from '../work-orders/work-order.errors';
import { workOrderRepository } from '../work-orders/work-order.repository';
import { workOrderHistoryInvalidFilterError } from './work-order-history.errors';
import { workOrderHistoryRepository } from './work-order-history.repository';
import type {
  PublicWorkOrderHistoryEvent,
  WorkOrderHistoryFilters,
} from './work-order-history.types';

/**
 * Records a Work Order domain event through the shared BE-07 Operational Event
 * service (`recordOperationalEvent`), always scoped as
 * `entity_type = 'WORK_ORDER'`, `entity_id = work_order_id`. Event types are
 * constrained to those produced by the existing BE-08 implementation — clients
 * cannot fabricate arbitrary events through the public API (no creation
 * endpoint is exposed).
 *
 * The caller supplies the Work Order's client/building context (it has already
 * resolved the Work Order), which keeps this helper free of a dependency on the
 * work-order module and avoids circular imports.
 */
export async function recordWorkOrderEvent(input: {
  workOrderId: string;
  clientId: string;
  buildingId: string;
  eventType: string;
  actorUserId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<PublicWorkOrderHistoryEvent> {
  const record = await recordOperationalEvent({
    clientId: input.clientId,
    eventType: input.eventType,
    entityType: 'WORK_ORDER',
    entityId: input.workOrderId,
    actorUserId: input.actorUserId ?? null,
    buildingId: input.buildingId,
    summary: input.summary,
    metadata: input.metadata,
  });

  return {
    id: record.id,
    workOrderId: record.entity_id,
    clientId: record.client_id,
    buildingId: record.building_id,
    eventType: record.event_type,
    actorUserId: record.actor_user_id,
    summary: record.summary,
    metadata: record.metadata ?? {},
    occurredAt: new Date(record.occurred_at).toISOString(),
    createdAt: new Date(record.created_at).toISOString(),
  };
}

/**
 * Lists the Work Order history in chronological order, reusing the BE-07
 * operational events. Optional filters: `eventType`, `from`, `to`. History is
 * read-only and append-oriented — no update/delete is exposed.
 */
export async function getWorkOrderHistory(
  workOrderId: string,
  filters: WorkOrderHistoryFilters,
): Promise<PublicWorkOrderHistoryEvent[]> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }

  if (
    filters.from !== undefined &&
    filters.to !== undefined &&
    new Date(filters.from) > new Date(filters.to)
  ) {
    throw workOrderHistoryInvalidFilterError();
  }

  return workOrderHistoryRepository.listByWorkOrder(workOrderId, filters);
}

export const workOrderHistoryService = {
  getWorkOrderHistory,
  recordWorkOrderEvent,
};
