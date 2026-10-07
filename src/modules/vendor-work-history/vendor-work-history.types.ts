/**
 * BE-15K — Vendor Work History domain types.
 *
 * Vendor Work history reuses the shared BE-07 operational-events audit
 * foundation (a single append-oriented store). No second generic audit engine
 * is created: every BE-15 domain event carries a `vendor_work_id` link (or is
 * the Vendor Assignment event of the work's assignment) and is read back in
 * chronological order. History is read-only — events are never updated or
 * deleted through this API.
 */

/** A Vendor Work history event (a BE-07 operational event scoped to a Vendor Work). */
export type PublicVendorWorkHistoryEvent = {
  id: string;
  vendorWorkId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  actorUserId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  /** Related operational references resolved from the event's metadata. */
  related: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
};

/** Filters for GET /vendor-works/:id/history. */
export type VendorWorkHistoryFilters = {
  eventType?: string;
  from?: string;
  to?: string;
};
