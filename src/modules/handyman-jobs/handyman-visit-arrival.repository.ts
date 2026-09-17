import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanVisitArrivalFailureReason,
  HandymanVisitArrivalMethod,
  HandymanVisitArrivalRecord,
  HandymanVisitArrivalResult,
} from './handyman-visit-arrival.types';

/**
 * CR-HM-BE-06 RUN 1 — arrival attempt persistence (APPEND-ONLY).
 *
 * There is no update and no delete surface: an attempt row is immutable
 * evidence. `received_at` is never supplied by callers — the database clock
 * stamps it (server-authoritative receipt). Idempotency follows the
 * CR-HM-BE-01 convention: client-scoped key + fingerprint, insert-or-read
 * under `ON CONFLICT DO NOTHING`, and the one-VERIFIED-per-visit partial
 * unique index as the structural backstop against concurrent verification.
 */

type Executor = Pick<PoolClient, 'query'>;

const ARRIVAL_SELECT = `
  id,
  client_id                   AS "clientId",
  handyman_service_visit_id   AS "handymanServiceVisitId",
  verification_method         AS "verificationMethod",
  verification_result         AS "verificationResult",
  received_at                 AS "receivedAt",
  occurred_at                 AS "occurredAt",
  latitude,
  longitude,
  accuracy_meters             AS "accuracyMeters",
  distance_meters             AS "distanceMeters",
  building_configuration_id   AS "buildingConfigurationId",
  configuration_version_id    AS "configurationVersionId",
  assisted_reason             AS "assistedReason",
  failure_reason              AS "failureReason",
  recorded_by_user_id         AS "recordedByUserId",
  idempotency_key             AS "idempotencyKey",
  idempotency_fingerprint     AS "idempotencyFingerprint",
  created_at                  AS "createdAt"
`;

/** One immutable attempt row to insert (the service owns every fact). */
export type NewHandymanVisitArrival = {
  clientId: string;
  handymanServiceVisitId: string;
  verificationMethod: HandymanVisitArrivalMethod;
  verificationResult: HandymanVisitArrivalResult;
  occurredAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  distanceMeters: number | null;
  buildingConfigurationId: string | null;
  configurationVersionId: string | null;
  assistedReason: string | null;
  failureReason: HandymanVisitArrivalFailureReason | null;
  recordedByUserId: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
};

/**
 * Insert-or-read under the client-scoped idempotency unique constraint (the
 * CR-HM-BE-01 repository convention): `created: false` means a concurrent
 * duplicate won and its row is returned for fingerprint comparison — the
 * caller decides replay-convergence vs idempotency conflict.
 */
async function create(
  input: NewHandymanVisitArrival,
  executor: Executor,
): Promise<{ record: HandymanVisitArrivalRecord; created: boolean }> {
  const result = await executor.query<HandymanVisitArrivalRecord>(
    `INSERT INTO handyman_visit_arrivals
       (id, client_id, handyman_service_visit_id, verification_method,
        verification_result, occurred_at, latitude, longitude,
        accuracy_meters, distance_meters, building_configuration_id,
        configuration_version_id, assisted_reason, failure_reason,
        recorded_by_user_id, idempotency_key, idempotency_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${ARRIVAL_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanServiceVisitId,
      input.verificationMethod,
      input.verificationResult,
      input.occurredAt,
      input.latitude,
      input.longitude,
      input.accuracyMeters,
      input.distanceMeters,
      input.buildingConfigurationId,
      input.configurationVersionId,
      input.assistedReason,
      input.failureReason,
      input.recordedByUserId,
      input.idempotencyKey,
      input.idempotencyFingerprint,
    ],
  );
  if (result.rows[0]) {
    return { record: result.rows[0], created: true };
  }
  const existing = await findByIdempotencyKey(
    input.clientId,
    input.idempotencyKey,
    executor,
  );
  if (!existing) {
    // Unreachable under the visit-row lock + unique constraint; never guess.
    throw new Error(
      'Arrival idempotency conflict resolved to no row; retry the command.',
    );
  }
  return { record: existing, created: false };
}

async function findById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanVisitArrivalRecord | null> {
  const result = await executor.query<HandymanVisitArrivalRecord>(
    `SELECT ${ARRIVAL_SELECT} FROM handyman_visit_arrivals WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Executor = getPool(),
): Promise<HandymanVisitArrivalRecord | null> {
  const result = await executor.query<HandymanVisitArrivalRecord>(
    `SELECT ${ARRIVAL_SELECT} FROM handyman_visit_arrivals
     WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/** The visit's ONE VERIFIED arrival (partial unique index guarantees ≤ 1). */
async function findVerifiedByVisitId(
  handymanServiceVisitId: string,
  executor: Executor = getPool(),
): Promise<HandymanVisitArrivalRecord | null> {
  const result = await executor.query<HandymanVisitArrivalRecord>(
    `SELECT ${ARRIVAL_SELECT} FROM handyman_visit_arrivals
     WHERE handyman_service_visit_id = $1 AND verification_result = 'VERIFIED'`,
    [handymanServiceVisitId],
  );
  return result.rows[0] ?? null;
}

/** Full append-only attempt history of one visit (oldest first). */
async function listByVisitId(
  handymanServiceVisitId: string,
  executor: Executor = getPool(),
): Promise<HandymanVisitArrivalRecord[]> {
  const result = await executor.query<HandymanVisitArrivalRecord>(
    `SELECT ${ARRIVAL_SELECT} FROM handyman_visit_arrivals
     WHERE handyman_service_visit_id = $1
     ORDER BY created_at ASC, id ASC`,
    [handymanServiceVisitId],
  );
  return result.rows;
}

export const handymanVisitArrivalRepository = {
  create,
  findById,
  findByIdempotencyKey,
  findVerifiedByVisitId,
  listByVisitId,
};
