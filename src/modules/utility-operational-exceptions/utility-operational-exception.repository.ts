import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateUtilityOperationalExceptionInput,
  ResolvedUtilityExceptionContext,
  UtilityExceptionFilters,
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
  cancellation_reason AS "cancellationReason", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

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
async function startReview(id: string, reviewerUserId: string, notes: string | null) {
  const result = await getPool().query<UtilityOperationalExceptionRecord>(
    `UPDATE utility_operational_exceptions
     SET status='UNDER_REVIEW',reviewer_user_id=$2,review_notes=$3,
       review_started_at=NOW(),updated_at=NOW()
     WHERE id=$1 AND status='OPEN' RETURNING ${SELECT}`,
    [id, reviewerUserId, notes],
  );
  return result.rows[0] ?? null;
}
async function resolve(id: string, userId: string, notes: string) {
  const result = await getPool().query<UtilityOperationalExceptionRecord>(
    `UPDATE utility_operational_exceptions
     SET status='RESOLVED',resolved_by_user_id=$2,resolved_at=NOW(),
       resolution_notes=$3,updated_at=NOW()
     WHERE id=$1 AND status='UNDER_REVIEW' RETURNING ${SELECT}`,
    [id, userId, notes],
  );
  return result.rows[0] ?? null;
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
  cancel, create, findById, list, resolve, startReview,
};
