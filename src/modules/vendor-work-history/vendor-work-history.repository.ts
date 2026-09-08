import { getPool } from '../../database';
import type {
  PublicVendorWorkHistoryEvent,
  VendorWorkHistoryFilters,
} from './vendor-work-history.types';

/**
 * BE-15K — Vendor Work History repository.
 *
 * Reads the shared BE-07 `operational_events` table. Events are scoped to a
 * Vendor Work either by the `vendor_work_id` link or, for the ancestor Vendor
 * Assignment event, by the work's own assignment reference. History is
 * append-oriented and read-only.
 */

type EventRow = {
  id: string;
  client_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string | null;
  building_id: string | null;
  vendor_work_id: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
};

function mapRow(row: EventRow, vendorWorkId: string): PublicVendorWorkHistoryEvent {
  const metadata = row.metadata ?? {};
  const related: Record<string, unknown> = {};
  for (const key of RELATED_METADATA_KEYS) {
    if (metadata[key] !== undefined) {
      related[key] = metadata[key];
    }
  }

  return {
    id: row.id,
    vendorWorkId,
    clientId: row.client_id,
    buildingId: row.building_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    summary: row.summary,
    metadata,
    related,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/** Metadata keys that reference other BE-15 operational entities. */
const RELATED_METADATA_KEYS = [
  'vendorAssignmentId',
  'vendorId',
  'workOrderId',
  'checklistBindingId',
  'checklistTemplateId',
  'checklistExecutionId',
  'evidenceId',
  'permitReadinessId',
  'completionReportId',
  'serviceReportId',
  'bastId',
  'reviewId',
  'reworkCycleId',
] as const;

async function listByVendorWork(
  vendorWorkId: string,
  vendorAssignmentId: string,
  filters: VendorWorkHistoryFilters,
): Promise<PublicVendorWorkHistoryEvent[]> {
  const conditions: string[] = [
    '(vendor_work_id = $1 OR (entity_type = $2 AND entity_id = $3))',
  ];
  const values: unknown[] = [vendorWorkId, 'VENDOR_ASSIGNMENT', vendorAssignmentId];
  let index = 3;

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

  return result.rows.map((row) => mapRow(row, vendorWorkId));
}

export const vendorWorkHistoryRepository = {
  listByVendorWork,
};
