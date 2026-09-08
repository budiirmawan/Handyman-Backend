import { logger } from '../../shared/logger';
import { sanitizeHistoryMetadata } from './asset-history.metadata';
import { assetHistoryRepository } from './asset-history.repository';
import type {
  AssetHistoryEventRecord,
  AssetHistoryListFilters,
  AssetHistoryListResult,
  PublicAssetHistoryEvent,
  RecordAssetHistoryInput,
} from './asset-history.types';

export function toPublicAssetHistoryEvent(
  record: AssetHistoryEventRecord,
): PublicAssetHistoryEvent {
  return {
    id: record.id,
    assetId: record.assetId,
    eventType: record.eventType,
    actorUserId: record.actorUserId,
    summary: record.summary,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * BE-05I — records one Asset history event.
 *
 * BEST-EFFORT BY DESIGN, following the BE-01H audit precedent: a history
 * write failure must never roll back or corrupt the Asset state change that
 * already succeeded. Failures are logged and swallowed, so the domain
 * operation stays consistent and the caller never sees a 500 because an
 * audit row could not be appended.
 *
 * Metadata is sanitized centrally here, so no call site can leak credentials,
 * tokens, session material, or Authorization headers into permanent history.
 */
export async function recordAssetHistory(
  input: RecordAssetHistoryInput,
): Promise<void> {
  try {
    await assetHistoryRepository.insertEvent({
      assetId: input.assetId,
      eventType: input.eventType,
      actorUserId: input.actorUserId ?? null,
      summary: input.summary,
      metadata: sanitizeHistoryMetadata(input.metadata),
    });
  } catch (error) {
    logger.warn('Asset history event could not be persisted', {
      operation: 'asset_history.record_failed',
      eventType: input.eventType,
      assetId: input.assetId,
      errorMessage: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

/**
 * Reads one Asset's history, newest first.
 *
 * The query is scoped to `asset_id`, so another Asset's timeline is never
 * reachable through this route. Asset existence (404) and Building isolation
 * are enforced by the controller before this runs — deliberately, so this
 * module imports nothing from the Asset domain and the
 * `assets → asset-history` dependency stays one-directional.
 */
export async function listAssetHistory(
  assetId: string,
  filters: AssetHistoryListFilters,
): Promise<AssetHistoryListResult> {
  const { events, total } = await assetHistoryRepository.listByAssetId(
    assetId,
    filters,
  );

  return {
    events: events.map(toPublicAssetHistoryEvent),
    total,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export const assetHistoryService = {
  listAssetHistory,
  recordAssetHistory,
  toPublicAssetHistoryEvent,
};
