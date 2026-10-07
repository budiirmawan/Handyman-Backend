import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { Pool, PoolClient } from 'pg';
import type {
  CreateReportArchiveInput,
  ReportArchiveAccessibleScope,
  ReportArchiveCompletionInput,
  ReportArchiveFailureInput,
  ReportArchiveListFilters,
  ReportArchiveListPage,
  ReportArchiveRecord,
} from './reporting-archive.types';

/** CR-BE-EXP-01 PART 01 — request/archive persistence authority. */

type QueryExecutor = Pick<Pool | PoolClient, 'query'>;

const ARCHIVE_COLUMNS = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  building_ids AS "buildingIds",
  dataset,
  format,
  status,
  filter_snapshot AS "filterSnapshot",
  source_provenance AS "sourceProvenance",
  as_of AS "asOf",
  requested_by_user_id AS "requestedByUserId",
  requested_at AS "requestedAt",
  generated_at AS "generatedAt",
  storage_reference AS "storageReference",
  filename,
  content_type AS "contentType",
  file_size AS "fileSize",
  checksum,
  checksum_algorithm AS "checksumAlgorithm",
  failure_code AS "failureCode",
  failure_message AS "failureMessage",
  failed_at AS "failedAt",
  attempt_count AS "attemptCount",
  max_attempts AS "maxAttempts",
  next_attempt_at AS "nextAttemptAt",
  idempotency_key_hash AS "idempotencyKeyHash",
  request_fingerprint AS "requestFingerprint",
  supersedes_archive_id AS "supersedesArchiveId",
  retention_policy_id AS "retentionPolicyId",
  retention_policy_code AS "retentionPolicyCode",
  retention_days_snapshot AS "retentionDaysSnapshot",
  retention_applied_at AS "retentionAppliedAt",
  retained_until AS "retainedUntil",
  retention_state AS "retentionState",
  retention_hold AS "retentionHold",
  retention_hold_reason AS "retentionHoldReason",
  retention_hold_set_at AS "retentionHoldSetAt",
  purged_at AS "purgedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export type CreateReportArchiveResult = {
  record: ReportArchiveRecord;
  created: boolean;
};

async function createOnConflictReturn(
  input: CreateReportArchiveInput,
  q: QueryExecutor = getPool(),
): Promise<CreateReportArchiveResult> {
  const inserted = await q.query<ReportArchiveRecord>(
    `INSERT INTO report_archives (
       id, client_id, building_id, building_ids, dataset, format, status,
       filter_snapshot, source_provenance, requested_by_user_id,
       idempotency_key_hash, request_fingerprint
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'REQUESTED', $7, $8, $9, $10, $11)
     ON CONFLICT (requested_by_user_id, client_id, idempotency_key_hash)
       WHERE idempotency_key_hash IS NOT NULL
       DO NOTHING
     RETURNING ${ARCHIVE_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.buildingIds,
      input.dataset,
      input.format,
      input.filters,
      input.sourceProvenance,
      input.requestedByUserId,
      input.idempotencyKeyHash,
      input.requestFingerprint,
    ],
  );

  if (inserted.rows[0]) {
    return { record: inserted.rows[0], created: true };
  }

  if (input.idempotencyKeyHash === null) {
    throw new Error('Report archive insert did not return a created row.');
  }

  const existing = await findByIdempotency(
    input.requestedByUserId,
    input.clientId,
    input.idempotencyKeyHash,
    q,
  );
  if (!existing) {
    throw new Error(
      'Report archive idempotency conflict: the existing row could not be read back.',
    );
  }
  return { record: existing, created: false };
}

async function findById(
  id: string,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveRecord | null> {
  const result = await q.query<ReportArchiveRecord>(
    `SELECT ${ARCHIVE_COLUMNS} FROM report_archives WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByIdempotency(
  requestedByUserId: string,
  clientId: string,
  idempotencyKeyHash: string,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveRecord | null> {
  const result = await q.query<ReportArchiveRecord>(
    `SELECT ${ARCHIVE_COLUMNS}
       FROM report_archives
      WHERE requested_by_user_id = $1
        AND client_id = $2
        AND idempotency_key_hash = $3`,
    [requestedByUserId, clientId, idempotencyKeyHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Reads one archive only when its complete recorded Building scope is still
 * contained in the caller's accessible scope. An inaccessible row is not
 * returned, avoiding an archive-ID existence oracle.
 */
async function findAccessibleById(
  id: string,
  scope: ReportArchiveAccessibleScope,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveRecord | null> {
  const result = await q.query<ReportArchiveRecord>(
    `SELECT ${ARCHIVE_COLUMNS}
       FROM report_archives
      WHERE id = $1
        AND client_id = ANY($2::uuid[])
        AND (
          cardinality(building_ids) = 0
          OR building_ids <@ $3::uuid[]
        )`,
    [id, scope.clientIds, scope.buildingIds],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: ReportArchiveListFilters,
  scope: ReportArchiveAccessibleScope,
  limit: number,
  offset: number,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveListPage> {
  const values: unknown[] = [scope.clientIds, scope.buildingIds];
  const where = [
    'client_id = ANY($1::uuid[])',
    '(cardinality(building_ids) = 0 OR building_ids <@ $2::uuid[])',
  ];

  const add = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };

  if (filters.clientId) add('client_id = ?', filters.clientId);
  if (filters.buildingId) {
    values.push(filters.buildingId);
    const parameter = `$${values.length}`;
    where.push(`(building_id = ${parameter} OR ${parameter} = ANY(building_ids))`);
  }
  if (filters.dataset) add('dataset = ?', filters.dataset);
  if (filters.format) add('format = ?', filters.format);
  if (filters.status) add('status = ?', filters.status);

  const clause = where.join(' AND ');
  const totalResult = await q.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM report_archives WHERE ${clause}`,
    values,
  );

  const pageValues = [...values, limit, offset];
  const result = await q.query<ReportArchiveRecord>(
    `SELECT ${ARCHIVE_COLUMNS}
       FROM report_archives
      WHERE ${clause}
      ORDER BY requested_at DESC, id DESC
      LIMIT $${pageValues.length - 1}
     OFFSET $${pageValues.length}`,
    pageValues,
  );

  return {
    items: result.rows,
    total: totalResult.rows[0]?.total ?? 0,
  };
}

/** Internal generation read; public callers use the scoped read seam. */
async function findByIdForGeneration(
  id: string,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveRecord | null> {
  return findById(id, q);
}

/** REQUESTED → GENERATING, guarded so one execution owns the request. */
async function claimForGeneration(
  id: string,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveRecord | null> {
  const result = await q.query<ReportArchiveRecord>(
    `UPDATE report_archives
        SET status = 'GENERATING',
            attempt_count = attempt_count + 1,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'REQUESTED'
        AND attempt_count < max_attempts
      RETURNING ${ARCHIVE_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** GENERATING → COMPLETED, with all artifact metadata written together. */
async function completeGeneration(
  id: string,
  input: ReportArchiveCompletionInput,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveRecord | null> {
  const result = await q.query<ReportArchiveRecord>(
    `UPDATE report_archives
        SET status = 'COMPLETED',
            source_provenance = $2,
            as_of = $3,
            generated_at = $4,
            storage_reference = $5,
            filename = $6,
            content_type = $7,
            file_size = $8,
            checksum = $9,
            checksum_algorithm = $10,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'GENERATING'
      RETURNING ${ARCHIVE_COLUMNS}`,
    [
      id,
      input.sourceProvenance,
      input.asOf,
      input.generatedAt,
      input.storageReference,
      input.filename,
      input.contentType,
      input.fileSize,
      input.checksum,
      input.checksumAlgorithm,
    ],
  );
  return result.rows[0] ?? null;
}

/** GENERATING → FAILED, guarded so a completed row cannot be overwritten. */
async function failGeneration(
  id: string,
  input: ReportArchiveFailureInput,
  q: QueryExecutor = getPool(),
): Promise<ReportArchiveRecord | null> {
  const result = await q.query<ReportArchiveRecord>(
    `UPDATE report_archives
        SET status = 'FAILED',
            failure_code = $2,
            failure_message = $3,
            failed_at = $4,
            next_attempt_at = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'GENERATING'
      RETURNING ${ARCHIVE_COLUMNS}`,
    [id, input.failureCode, input.failureMessage, input.failedAt],
  );
  return result.rows[0] ?? null;
}

export const reportArchiveRepository = {
  claimForGeneration,
  completeGeneration,
  createOnConflictReturn,
  failGeneration,
  findAccessibleById,
  findByIdForGeneration,
  list,
};
