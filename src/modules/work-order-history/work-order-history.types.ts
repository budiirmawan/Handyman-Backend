/**
 * BE-08J — Work Order Audit / History domain types.
 *
 * Work Order history reuses the BE-07 Operational Event binding
 * (`operational_events`) with `entity_type = 'WORK_ORDER'` and
 * `entity_id = work_order_id`. No second audit engine is created. History is
 * append-oriented: events are only read, never updated or deleted through
 * this API.
 */

/** A Work Order history event (a BE-07 operational event scoped to a Work Order). */
export type PublicWorkOrderHistoryEvent = {
  id: string;
  workOrderId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  actorUserId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
};

/** Filters for GET /work-orders/:id/history. */
export type WorkOrderHistoryFilters = {
  eventType?: string;
  from?: string;
  to?: string;
};
