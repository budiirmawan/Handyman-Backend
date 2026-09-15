import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { MobileSyncRequestItem, MobileSyncResultItem } from './mobile-sync.types';

/**
 * BE-25H — Mobile sync idempotency store.
 *
 * Persists the processing result of every sync operation keyed by
 * (user_id, operation_id) so a duplicate retry of the same operation
 * replays the ORIGINAL result instead of executing the write again.
 *
 * The uniqueness constraint doubles as the race guard: if two concurrent
 * requests carry the same operation id, exactly one INSERT succeeds and the
 * other falls back to reading the stored result.
 */

export type StoredSyncOperation = {
  id: string;
  user_id: string;
  operation_id: string;
  resource_type: string;
  resource_id: string;
  operation: string;
  status: 'SUCCESS' | 'FAILED';
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  client_timestamp: string;
  processed_at: Date;
};

export function storedToResult(row: StoredSyncOperation): MobileSyncResultItem {
  return {
    operationId: row.operation_id,
    clientTimestamp: row.client_timestamp,
    success: row.status === 'SUCCESS',
    status: row.status,
    result: row.status === 'SUCCESS' ? row.result : null,
    error:
      row.status === 'FAILED'
        ? {
            code: row.error_code ?? 'UNKNOWN',
            message: row.error_message ?? '',
            // BE-25K — resource/context reference where useful (replayed
            // from the stored operation binding).
            resource: {
              type: row.resource_type,
              id: row.resource_id,
            },
          }
        : null,
    serverTimestamp: row.processed_at.toISOString(),
  };
}

export async function findStoredOperation(
  userId: string,
  operationId: string,
): Promise<StoredSyncOperation | null> {
  const result = await getPool().query<StoredSyncOperation>(
    `SELECT * FROM mobile_sync_idempotency WHERE user_id = $1 AND operation_id = $2`,
    [userId, operationId],
  );
  return result.rows[0] ?? null;
}

export async function storeOperationResult(
  userId: string,
  operation: MobileSyncRequestItem,
  result: MobileSyncResultItem,
): Promise<StoredSyncOperation> {
  const inserted = await getPool().query<StoredSyncOperation>(
    `INSERT INTO mobile_sync_idempotency (
       id, user_id, operation_id, resource_type, resource_id, operation,
       status, result, error_code, error_message, client_timestamp
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      randomUUID(),
      userId,
      operation.operationId,
      operation.resourceType,
      operation.resourceId,
      operation.operation,
      result.status,
      result.status === 'SUCCESS' ? JSON.stringify(result.result ?? null) : null,
      result.error?.code ?? null,
      result.error?.message ?? null,
      operation.clientTimestamp,
    ],
  );
  return inserted.rows[0];
}

export const mobileSyncIdempotencyStore = {
  findStoredOperation,
  storeOperationResult,
  storedToResult,
};
