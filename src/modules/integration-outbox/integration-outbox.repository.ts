import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import { clampDueItemLimit } from '../../shared/due-retrieval';
import type {
  IntegrationOutboxCreateResult,
  IntegrationOutboxEventRecord,
  NewIntegrationOutboxEvent,
} from './integration-outbox.types';

/**
 * CR-BE-INTEG-01 PART 01 — integration outbox repository.
 *
 * Guarded seams over `integration_outbox_events`, shaped after the proven
 * CR-BE-NOTIFY-PROV-01 ledger pattern:
 *
 *   - idempotent creation (insert-on-conflict-return on the UNIQUE
 *     `operational_event_id` reference — one outbox row per authoritative
 *     event, and a replay can never overwrite the original snapshot),
 *   - bounded PENDING enumeration with `FOR UPDATE SKIP LOCKED`,
 *   - guarded fan-out claim (`PENDING → PROCESSING`) and result seams
 *     (`PROCESSING → PROCESSED / FAILED`), each a status-guarded single
 *     UPDATE returning the row (or null when the guard matched nothing).
 *
 * No fan-out orchestration, endpoint knowledge, delivery, HTTP, or scheduler
 * concern lives here — PART 03+ are the callers of the claim/mark seams.
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

const COLUMNS = `id,
  operational_event_id AS "operationalEventId",
  client_id AS "clientId",
  building_id AS "buildingId",
  event_type AS "eventType",
  entity_type AS "entityType",
  entity_id AS "entityId",
  payload,
  occurred_at AS "occurredAt",
  status,
  processed_at AS "processedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

/**
 * Idempotent creation seam (governance §2 / §6.1).
 *
 * Inserts one PENDING outbox row for an operational event. On a conflict with
 * the UNIQUE `operational_event_id` constraint nothing is inserted and the
 * EXISTING row is returned with `created: false` — the original payload
 * snapshot is never overwritten by a replay.
 */
async function createOnConflictReturn(
  input: NewIntegrationOutboxEvent,
  q: Q = getPool(),
): Promise<IntegrationOutboxCreateResult> {
  const inserted = await q.query<IntegrationOutboxEventRecord>(
    `INSERT INTO integration_outbox_events (
       id, operational_event_id, client_id, building_id,
       event_type, entity_type, entity_id, payload, occurred_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ON CONSTRAINT integration_outbox_events_operational_event_unique
       DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      randomUUID(),
      input.operationalEventId,
      input.clientId,
      input.buildingId,
      input.eventType,
      input.entityType,
      input.entityId,
      input.payload,
      input.occurredAt,
    ],
  );

  if (inserted.rows[0]) {
    return { record: inserted.rows[0], created: true };
  }

  const existing = await findByOperationalEventId(input.operationalEventId, q);
  if (!existing) {
    // The conflict was observed but the row is not readable on this executor —
    // fail loudly rather than silently reporting a creation.
    throw new Error(
      'Integration outbox idempotency conflict: the conflicting row could not be read back.',
    );
  }
  return { record: existing, created: false };
}

/** Read seam by the authoritative event reference. */
async function findByOperationalEventId(
  operationalEventId: string,
  q: Q = getPool(),
): Promise<IntegrationOutboxEventRecord | null> {
  const result = await q.query<IntegrationOutboxEventRecord>(
    `SELECT ${COLUMNS} FROM integration_outbox_events WHERE operational_event_id = $1`,
    [operationalEventId],
  );
  return result.rows[0] ?? null;
}

/** Read seam by outbox id. */
async function findById(
  id: string,
  q: Q = getPool(),
): Promise<IntegrationOutboxEventRecord | null> {
  const result = await q.query<IntegrationOutboxEventRecord>(
    `SELECT ${COLUMNS} FROM integration_outbox_events WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Bounded PENDING enumeration for one fan-out pass, oldest first, with
 * `FOR UPDATE SKIP LOCKED` so concurrent workers never enumerate the same
 * row. The caller MUST hold an open transaction for the lock to be
 * meaningful (the PART 03 fan-out orchestration is that caller).
 */
async function findPendingBatch(
  limit: number,
  q: Q,
): Promise<IntegrationOutboxEventRecord[]> {
  const result = await q.query<IntegrationOutboxEventRecord>(
    `SELECT ${COLUMNS}
       FROM integration_outbox_events
      WHERE status = 'PENDING'
      ORDER BY created_at ASC, id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [clampDueItemLimit(limit)],
  );
  return result.rows;
}

/** Guarded fan-out claim: `PENDING → PROCESSING`. Null = claim lost. */
async function claimPending(
  id: string,
  q: Q = getPool(),
): Promise<IntegrationOutboxEventRecord | null> {
  const result = await q.query<IntegrationOutboxEventRecord>(
    `UPDATE integration_outbox_events
        SET status = 'PROCESSING', updated_at = NOW()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING ${COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Guarded result seam: `PROCESSING → PROCESSED`. Null = guard missed. */
async function markProcessed(
  id: string,
  q: Q = getPool(),
): Promise<IntegrationOutboxEventRecord | null> {
  const result = await q.query<IntegrationOutboxEventRecord>(
    `UPDATE integration_outbox_events
        SET status = 'PROCESSED', processed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'PROCESSING'
      RETURNING ${COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Guarded result seam: `PROCESSING → FAILED`. Null = guard missed. */
async function markFailed(
  id: string,
  q: Q = getPool(),
): Promise<IntegrationOutboxEventRecord | null> {
  const result = await q.query<IntegrationOutboxEventRecord>(
    `UPDATE integration_outbox_events
        SET status = 'FAILED', updated_at = NOW()
      WHERE id = $1 AND status = 'PROCESSING'
      RETURNING ${COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const integrationOutboxRepository = {
  createOnConflictReturn,
  findByOperationalEventId,
  findById,
  findPendingBatch,
  claimPending,
  markProcessed,
  markFailed,
};
