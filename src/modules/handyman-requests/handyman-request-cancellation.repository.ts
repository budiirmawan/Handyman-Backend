import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanRequestCancellationRecord,
  NewHandymanRequestCancellationRecord,
} from './handyman-request-cancellation.types';

/**
 * CR-HM-18 REQUEST-CANCEL-01 — append-only cancellation repository.
 *
 * INSERT + bounded reads only: the 0459 trigger refuses UPDATE/DELETE.
 * The request row itself is projected through the existing
 * `handymanServiceRequestRepository.updateStatus` seam, never here.
 */

type Executor = Pick<PoolClient, 'query'>;

type Row = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  building_id: string;
  previous_status: HandymanRequestCancellationRecord['previousStatus'];
  reason: string;
  cancelled_by_user_id: string;
  idempotency_key: string;
  occurred_at: Date;
};

const SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         building_id, previous_status, reason, cancelled_by_user_id,
         idempotency_key, occurred_at
    FROM handyman_request_cancellations`;

function map(row: Row): HandymanRequestCancellationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    buildingId: row.building_id,
    previousStatus: row.previous_status,
    reason: row.reason,
    cancelledByUserId: row.cancelled_by_user_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
  };
}

async function insertCancellation(
  executor: Executor,
  record: NewHandymanRequestCancellationRecord,
): Promise<HandymanRequestCancellationRecord> {
  const result = await executor.query<Row>(
    `INSERT INTO handyman_request_cancellations (
       id, client_id, handyman_request_id, channel_attribution_id,
       building_id, previous_status, reason, cancelled_by_user_id,
       idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               building_id, previous_status, reason, cancelled_by_user_id,
               idempotency_key, occurred_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanRequestId,
      record.channelAttributionId,
      record.buildingId,
      record.previousStatus,
      record.reason,
      record.cancelledByUserId,
      record.idempotencyKey,
    ],
  );
  return map(result.rows[0]);
}

async function findByRequest(
  executor: Executor = getPool(),
  handymanRequestId: string,
): Promise<HandymanRequestCancellationRecord | null> {
  const result = await executor.query<Row>(
    `${SELECT} WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function findByIdempotencyKey(
  executor: Executor,
  idempotencyKey: string,
): Promise<HandymanRequestCancellationRecord | null> {
  const result = await executor.query<Row>(
    `${SELECT} WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

/** Commit gate: any execution scope means an approved quotation exists. */
async function requestHasExecutionScope(
  executor: Executor,
  handymanRequestId: string,
): Promise<boolean> {
  const result = await executor.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM handyman_execution_scopes
        WHERE handyman_request_id = $1
     ) AS exists`,
    [handymanRequestId],
  );
  return result.rows[0]?.exists === true;
}

export const handymanRequestCancellationRepository = {
  insertCancellation,
  findByRequest,
  findByIdempotencyKey,
  requestHasExecutionScope,
};
