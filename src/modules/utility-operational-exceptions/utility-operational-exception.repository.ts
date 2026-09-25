import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateUtilityOperationalExceptionInput,
  ResolvedUtilityExceptionContext,
  UtilityExceptionExecutor,
  UtilityExceptionFilters,
  UtilityExceptionReadingReread,
  UtilityOperationalExceptionRecord,
} from './utility-operational-exception.types';

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  utility_type AS "utilityType", meter_id AS "meterId",
  meter_reading_id AS "meterReadingId", reading_due_id AS "readingDueId",
  consumption_id AS "consumptionId",
  abnormal_consumption_id AS "abnormalConsumptionId",
  ocr_candidate_id AS "ocrCandidateId", reconciliation_id AS "reconciliationId",
  exception_type AS "exceptionType", severity, status, summary, details,
  detected_at AS "detectedAt", detected_by_user_id AS "detectedByUserId",
  reviewer_user_id AS "reviewerUserId", review_notes AS "reviewNotes",
  review_started_at AS "reviewStartedAt",
  resolved_by_user_id AS "resolvedByUserId", resolved_at AS "resolvedAt",
  resolution_notes AS "resolutionNotes",
  cancelled_by_user_id AS "cancelledByUserId", cancelled_at AS "cancelledAt",
  cancellation_reason AS "cancellationReason",
  /* CR-BE-RN12-METER-FIELD-01 PART 03 — recheck payload. Additive columns,
     null for every exception that is not a READING_RECHECK. NUMERIC is read as
     text (the sibling BE-18 repositories' convention) and converted once, in
     the service's public mapper. */
  replacement_meter_reading_id AS "replacementMeterReadingId",
  proposed_reading_value::text AS "proposedReadingValue",
  proposed_reading_at AS "proposedReadingAt",
  proposed_reading_notes AS "proposedReadingNotes",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(
  input: Pick<CreateUtilityOperationalExceptionInput,
    'exceptionType' | 'severity' | 'summary' | 'details'> &
    ResolvedUtilityExceptionContext & { detectedByUserId: string },
): Promise<UtilityOperationalExceptionRecord> {
  const result = await getPool().query<UtilityOperationalExceptionRecord>(
    `INSERT INTO utility_operational_exceptions
      (id, client_id, building_id, utility_type, meter_id, meter_reading_id,
       reading_due_id, consumption_id, abnormal_consumption_id,
       ocr_candidate_id, reconciliation_id, exception_type, severity,
       summary, details, detected_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.buildingId, input.utilityType,
      input.meterId, input.meterReadingId, input.readingDueId,
      input.consumptionId, input.abnormalConsumptionId, input.ocrCandidateId,
      input.reconciliationId, input.exceptionType, input.severity,
      input.summary, input.details ?? null, input.detectedByUserId],
  );
  return result.rows[0];
}
async function findById(id: string): Promise<UtilityOperationalExceptionRecord | null> {
  const result = await getPool().query<UtilityOperationalExceptionRecord>(
    `SELECT ${SELECT} FROM utility_operational_exceptions WHERE id=$1`, [id],
  );
  return result.rows[0] ?? null;
}
async function list(filters: UtilityExceptionFilters, buildingIds: string[]) {
  if (!buildingIds.length) return [];
  const values: unknown[] = [buildingIds];
  const clauses = ['building_id=ANY($1::uuid[])'];
  const fields: [keyof UtilityExceptionFilters, string][] = [
    ['clientId', 'client_id'], ['buildingId', 'building_id'],
    ['utilityType', 'utility_type'], ['exceptionType', 'exception_type'],
    ['severity', 'severity'], ['status', 'status'],
    ['reconciliationId', 'reconciliation_id'],
  ];
  for (const [key, column] of fields) {
    if (filters[key] !== undefined) {
      values.push(filters[key]);
      clauses.push(`${column}=$${values.length}`);
    }
  }
  return (await getPool().query<UtilityOperationalExceptionRecord>(
    `SELECT ${SELECT} FROM utility_operational_exceptions
     WHERE ${clauses.join(' AND ')} ORDER BY detected_at DESC,id`, values,
  )).rows;
}
/**
 * OPEN → UNDER_REVIEW.
 *
 * CR-BE-RN12-METER-FIELD-01 PART 03 adds one OPTIONAL `executor`, on the same
 * pattern as `resolve` below: the SQL, the guard and the stamps are unchanged,
 * and every existing caller keeps running on the pool. A caller that owns a
 * transaction passes its connection so that this transition and a following
 * resolve commit or roll back together.
 */
async function startReview(
  id: string,
  reviewerUserId: string,
  notes: string | null,
  executor: UtilityExceptionExecutor = getPool(),
) {
  const result = await executor.query<UtilityOperationalExceptionRecord>(
    `UPDATE utility_operational_exceptions
     SET status='UNDER_REVIEW',reviewer_user_id=$2,review_notes=$3,
       review_started_at=NOW(),updated_at=NOW()
     WHERE id=$1 AND status='OPEN' RETURNING ${SELECT}`,
    [id, reviewerUserId, notes],
  );
  return result.rows[0] ?? null;
}
/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — stage (or re-stage) the reread of a
 * `READING_RECHECK` and open its review, in ONE guarded statement.
 *
 * A dedicated function rather than an extra parameter on `startReview`, so the
 * register's generic transition keeps its exact SQL and its exact meaning for
 * every other exception type. The guard is the register's own:
 * `WHERE status IN ('OPEN','UNDER_REVIEW')` admits the first staging (which
 * performs OPEN → UNDER_REVIEW) and a correction of the staged measurement while
 * the review is open — the field analogue of retrying an online submit that the
 * canonical reading rules refused. RESOLVED and CANCELLED are terminal and can
 * never be re-staged, and `reviewer_user_id` / `review_started_at` are kept from
 * the first transition by COALESCE, so no stamp is rewritten and NO NEW STATUS
 * exists.
 *
 * The reread is STAGED, not recorded: BE-18E readings are immutable, so the
 * canonical replacement reading is created only when a human accepts it.
 */
async function stageReadingReread(
  id: string,
  reviewerUserId: string,
  reread: UtilityExceptionReadingReread,
) {
  const result = await getPool().query<UtilityOperationalExceptionRecord>(
    `UPDATE utility_operational_exceptions
     SET status='UNDER_REVIEW',
       reviewer_user_id=COALESCE(reviewer_user_id,$2),
       review_started_at=COALESCE(review_started_at,NOW()),
       proposed_reading_value=$3,proposed_reading_at=$4,
       proposed_reading_notes=$5,updated_at=NOW()
     WHERE id=$1 AND exception_type='READING_RECHECK'
       AND status IN ('OPEN','UNDER_REVIEW')
     RETURNING ${SELECT}`,
    [id, reviewerUserId, reread.readingValue, reread.readingAt,
      reread.notes ?? null],
  );
  return result.rows[0] ?? null;
}
/**
 * UNDER_REVIEW → RESOLVED, optionally LINKING the accepted replacement reading.
 *
 * CR-BE-RN12-METER-FIELD-01 PART 03. `replacementMeterReadingId` is written by
 * the same guarded UPDATE that resolves, so a replacement reading can never be
 * linked to a recheck that did not resolve, and the resolve can never succeed
 * without its link. `executor` lets the caller own ONE transaction across the
 * canonical BE-18E reading INSERT and this resolution: a replacement must never
 * commit without the exception row that makes it auditable, and an immutable
 * reading can never be rolled back later.
 *
 * Both parameters are optional and defaulted, so every existing caller keeps
 * the identical SQL on the pool.
 */
async function resolve(
  id: string,
  userId: string,
  notes: string,
  replacementMeterReadingId: string | null = null,
  executor: UtilityExceptionExecutor = getPool(),
) {
  const result = await executor.query<UtilityOperationalExceptionRecord>(
    `UPDATE utility_operational_exceptions
     SET status='RESOLVED',resolved_by_user_id=$2,resolved_at=NOW(),
       resolution_notes=$3,replacement_meter_reading_id=$4,updated_at=NOW()
     WHERE id=$1 AND status='UNDER_REVIEW' RETURNING ${SELECT}`,
    [id, userId, notes, replacementMeterReadingId],
  );
  return result.rows[0] ?? null;
}

/**
 * PART 03 — the rechecks of ONE Meter Reading, newest first.
 *
 * Scoped by `meter_reading_id` (the ORIGINAL reading) and, by default, by the
 * `READING_RECHECK` type, which is what the field projection and the
 * backend-derived `availableActions` read. Every status is returned — resolved
 * and cancelled rechecks are the audit trail of the correction, not noise.
 */
async function listByMeterReading(
  meterReadingId: string,
  exceptionType = 'READING_RECHECK',
): Promise<UtilityOperationalExceptionRecord[]> {
  const result = await getPool().query<UtilityOperationalExceptionRecord>(
    `SELECT ${SELECT} FROM utility_operational_exceptions
     WHERE meter_reading_id=$1 AND exception_type=$2
     ORDER BY detected_at DESC,id`,
    [meterReadingId, exceptionType],
  );
  return result.rows;
}
async function cancel(id: string, userId: string, reason: string) {
  const result = await getPool().query<UtilityOperationalExceptionRecord>(
    `UPDATE utility_operational_exceptions
     SET status='CANCELLED',cancelled_by_user_id=$2,cancelled_at=NOW(),
       cancellation_reason=$3,updated_at=NOW()
     WHERE id=$1 AND status IN ('OPEN','UNDER_REVIEW') RETURNING ${SELECT}`,
    [id, userId, reason],
  );
  return result.rows[0] ?? null;
}
export const utilityOperationalExceptionRepository = {
  cancel, create, findById, list, listByMeterReading, resolve, stageReadingReread,
  startReview,
};
