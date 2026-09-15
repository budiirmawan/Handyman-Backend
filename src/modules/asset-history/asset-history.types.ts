/**
 * BE-05I — Asset History domain types.
 *
 * An append-oriented record of important Asset master-data events across the
 * BE-05 domains. History is written by the domain services and read back
 * through a read-only API; entries are never edited.
 *
 * Ownership context is derived through
 * History → Asset → Building → Property → Client and never duplicated.
 *
 * Asset History is NOT PM history, breakdown history, work order history,
 * checklist execution history, meter reading history, finding/verification
 * history, or a maintenance timeline engine.
 */
export const ASSET_HISTORY_EVENT_TYPES = [
  'ASSET_CREATED',
  'ASSET_UPDATED',
  'ASSET_CLASSIFICATION_CHANGED',
  'ASSET_LOCATION_CHANGED',
  'ASSET_STATUS_CHANGED',
  'EQUIPMENT_PROFILE_CREATED',
  'EQUIPMENT_PROFILE_UPDATED',
  'WARRANTY_CREATED',
  'WARRANTY_UPDATED',
  'CERTIFICATION_CREATED',
  'CERTIFICATION_UPDATED',
  'IDENTIFIER_CREATED',
  'IDENTIFIER_UPDATED',
] as const;

export type AssetHistoryEventType =
  (typeof ASSET_HISTORY_EVENT_TYPES)[number];

export function isAssetHistoryEventType(
  value: unknown,
): value is AssetHistoryEventType {
  return (
    typeof value === 'string' &&
    (ASSET_HISTORY_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Safe, minimal structured detail: field names, ids, before/after states. */
export type AssetHistoryMetadata = Record<string, unknown>;

/** Full database record. */
export type AssetHistoryEventRecord = {
  id: string;
  assetId: string;
  eventType: string;
  actorUserId: string | null;
  summary: string;
  metadata: AssetHistoryMetadata;
  createdAt: Date;
};

/** Safe public representation exposed through the read-only API. */
export type PublicAssetHistoryEvent = {
  id: string;
  assetId: string;
  eventType: string;
  actorUserId: string | null;
  summary: string;
  metadata: AssetHistoryMetadata;
  createdAt: string;
};

/** Input accepted by `recordAssetHistory`. */
export type RecordAssetHistoryInput = {
  assetId: string;
  eventType: AssetHistoryEventType;
  /** NULL for system-initiated events with no authenticated user. */
  actorUserId?: string | null;
  summary: string;
  metadata?: AssetHistoryMetadata;
};

/** Fully-resolved history data ready for persistence. */
export type NewAssetHistoryEvent = {
  assetId: string;
  eventType: string;
  actorUserId: string | null;
  summary: string;
  metadata: AssetHistoryMetadata;
};

export type AssetHistoryListFilters = {
  eventType?: string;
  limit: number;
  offset: number;
};

export type AssetHistoryListResult = {
  events: PublicAssetHistoryEvent[];
  total: number;
  limit: number;
  offset: number;
};
