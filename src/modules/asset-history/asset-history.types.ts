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
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — the Asset operational-state axis
  // (IN_SERVICE / OUT_OF_SERVICE / ISOLATED / SHUT_DOWN) moved. Recorded here
  // rather than in a parallel audit engine: the existing append-only Asset
  // history is structurally capable of representing it (free-TEXT event_type
  // plus JSONB metadata), and `assets.status` moving is a SEPARATE event
  // (ASSET_STATUS_CHANGED) because the two axes are independent.
  'ASSET_OPERATIONAL_STATE_CHANGED',
  // CR-BE-RN10-SAFE-EQUIPMENT-01 PART 03 — the governed return-to-service
  // command. A DISTINCT event from ASSET_OPERATIONAL_STATE_CHANGED even though
  // it also moves the operational axis: this one carries the authorizing
  // approval facts (approvalMode / approvedByUserId / approvedAt) and the
  // safety-risk gate outcome, so "who authorized putting this equipment back
  // into service, and on what evidence" is answerable from the timeline alone.
  'ASSET_RETURNED_TO_SERVICE',
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
