import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CompleteInput,
  RequestIdempotencyRecord,
  TryClaimInput,
} from './request-idempotency.types';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — generic idempotency repository.
 *
 * All operations accept Executor/PoolClient explicitly — no hidden pool.
 * No raw SQL outside repository.
 *
 * Retention cleanup is separate infrastructure governance; correctness does
 * not depend on deletion.
 */

type Executor = Pick<Pool | PoolClient, 'query'>;

const SELECT_COLUMNS = `
  id,
  actor_user_id AS "actorUserId",
  operation_key AS "operationKey",
  idempotency_key_hash AS "idempotencyKeyHash",
  request_fingerprint AS "requestFingerprint",
  status,
  response_status AS "responseStatus",
  response_body AS "responseBody",
  created_at AS "createdAt",
  completed_at AS "completedAt"
`;

async function tryClaim(
  input: TryClaimInput,
  client: Executor,
): Promise<RequestIdempotencyRecord | null> {
  const result = await client.query<RequestIdempotencyRecord>(
    `INSERT INTO request_idempotency_records (
       id, actor_user_id, operation_key, idempotency_key_hash,
       request_fingerprint, status
     )
     VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')
     ON CONFLICT (actor_user_id, operation_key, idempotency_key_hash)
     DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.actorUserId,
      input.operationKey,
      input.idempotencyKeyHash,
      input.requestFingerprint,
    ],
  );
  return result.rows[0] ?? null;
}

async function findByIdentity(
  actorUserId: string,
  operationKey: string,
  idempotencyKeyHash: string,
  client: Executor,
): Promise<RequestIdempotencyRecord | null> {
  const result = await client.query<RequestIdempotencyRecord>(
    `SELECT ${SELECT_COLUMNS}
       FROM request_idempotency_records
      WHERE actor_user_id = $1
        AND operation_key = $2
        AND idempotency_key_hash = $3`,
    [actorUserId, operationKey, idempotencyKeyHash],
  );
  return result.rows[0] ?? null;
}

async function complete(
  input: CompleteInput,
  client: Executor,
): Promise<RequestIdempotencyRecord | null> {
  const result = await client.query<RequestIdempotencyRecord>(
    `UPDATE request_idempotency_records
        SET status = 'COMPLETED',
            response_status = $2,
            response_body = $3,
            completed_at = NOW()
      WHERE id = $1
        AND status = 'IN_PROGRESS'
      RETURNING ${SELECT_COLUMNS}`,
    [input.id, input.responseStatus, input.responseBody],
  );
  return result.rows[0] ?? null;
}

export const requestIdempotencyRepository = {
  tryClaim,
  findByIdentity,
  complete,
};
