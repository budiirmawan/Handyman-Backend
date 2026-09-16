import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanServiceVisitRecord,
  HandymanServiceVisitScheduleRecord,
  NewHandymanServiceVisit,
  NewHandymanServiceVisitSchedule,
} from './handyman-service-visit.types';

type Executor = Pick<PoolClient, 'query'>;

const VISIT_SELECT = `
  id,
  client_id            AS "clientId",
  handyman_job_id      AS "handymanJobId",
  visit_sequence       AS "visitSequence",
  created_by_user_id   AS "createdByUserId",
  created_at           AS "createdAt",
  updated_at           AS "updatedAt"
`;

const SCHEDULE_SELECT = `
  id,
  client_id                   AS "clientId",
  handyman_service_visit_id   AS "handymanServiceVisitId",
  planned_start_at            AS "plannedStartAt",
  planned_end_at              AS "plannedEndAt",
  status,
  created_by_user_id          AS "createdByUserId",
  superseded_at               AS "supersededAt",
  superseded_by_user_id       AS "supersededByUserId",
  cancelled_at                AS "cancelledAt",
  cancelled_by_user_id        AS "cancelledByUserId",
  created_at                  AS "createdAt",
  updated_at                  AS "updatedAt"
`;

/** One conflicting ACTIVE window (IDs only — safe for error messages). */
export type ScheduleConflictRow = {
  scheduleId: string;
  visitId: string;
  jobId: string;
  /** Present on worker conflicts: the shared vendor workforce BINDING id. */
  bindingId?: string;
};

/* ------------------------------------------------------------------ */
/* handyman_service_visits                                             */
/* ------------------------------------------------------------------ */

async function createVisit(
  input: NewHandymanServiceVisit,
  executor: Executor,
): Promise<HandymanServiceVisitRecord> {
  const result = await executor.query<HandymanServiceVisitRecord>(
    `INSERT INTO handyman_service_visits
       (id, client_id, handyman_job_id, visit_sequence, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${VISIT_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanJobId,
      input.visitSequence,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findVisitById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanServiceVisitRecord | null> {
  const result = await executor.query<HandymanServiceVisitRecord>(
    `SELECT ${VISIT_SELECT} FROM handyman_service_visits WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Locks the visit row (reschedule/cancel serialization point). */
async function lockVisitById(
  id: string,
  executor: Executor,
): Promise<HandymanServiceVisitRecord | null> {
  const result = await executor.query<HandymanServiceVisitRecord>(
    `SELECT ${VISIT_SELECT} FROM handyman_service_visits WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listVisitsByJob(
  handymanJobId: string,
  executor: Executor = getPool(),
): Promise<HandymanServiceVisitRecord[]> {
  const result = await executor.query<HandymanServiceVisitRecord>(
    `SELECT ${VISIT_SELECT} FROM handyman_service_visits
     WHERE handyman_job_id = $1
     ORDER BY visit_sequence ASC`,
    [handymanJobId],
  );
  return result.rows;
}

/**
 * Next server-side sequence for a job. MUST be called while the caller's
 * transaction holds the job row lock (handymanJobRepository.lockById FOR
 * UPDATE) — that lock serializes visit creation per job, so max+1 cannot
 * race; the UNIQUE (handyman_job_id, visit_sequence) constraint is the
 * structural backstop.
 */
async function nextVisitSequence(
  handymanJobId: string,
  executor: Executor,
): Promise<number> {
  const result = await executor.query<{ next: number }>(
    `SELECT COALESCE(MAX(visit_sequence), 0) + 1 AS next
     FROM handyman_service_visits
     WHERE handyman_job_id = $1`,
    [handymanJobId],
  );
  return result.rows[0].next;
}

/* ------------------------------------------------------------------ */
/* handyman_service_visit_schedules (append-only versioned windows)    */
/* ------------------------------------------------------------------ */

async function createSchedule(
  input: NewHandymanServiceVisitSchedule,
  executor: Executor,
): Promise<HandymanServiceVisitScheduleRecord> {
  const result = await executor.query<HandymanServiceVisitScheduleRecord>(
    `INSERT INTO handyman_service_visit_schedules
       (id, client_id, handyman_service_visit_id, planned_start_at,
        planned_end_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SCHEDULE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanServiceVisitId,
      input.plannedStartAt,
      input.plannedEndAt,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findScheduleById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanServiceVisitScheduleRecord | null> {
  const result = await executor.query<HandymanServiceVisitScheduleRecord>(
    `SELECT ${SCHEDULE_SELECT} FROM handyman_service_visit_schedules
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveScheduleByVisitId(
  handymanServiceVisitId: string,
  executor: Executor = getPool(),
): Promise<HandymanServiceVisitScheduleRecord | null> {
  const result = await executor.query<HandymanServiceVisitScheduleRecord>(
    `SELECT ${SCHEDULE_SELECT} FROM handyman_service_visit_schedules
     WHERE handyman_service_visit_id = $1 AND status = 'ACTIVE'`,
    [handymanServiceVisitId],
  );
  return result.rows[0] ?? null;
}

/** Locks the visit's ACTIVE window (reschedule/cancel guard target). */
async function lockActiveScheduleByVisitId(
  handymanServiceVisitId: string,
  executor: Executor,
): Promise<HandymanServiceVisitScheduleRecord | null> {
  const result = await executor.query<HandymanServiceVisitScheduleRecord>(
    `SELECT ${SCHEDULE_SELECT} FROM handyman_service_visit_schedules
     WHERE handyman_service_visit_id = $1 AND status = 'ACTIVE'
     FOR UPDATE`,
    [handymanServiceVisitId],
  );
  return result.rows[0] ?? null;
}

async function listSchedulesByVisitId(
  handymanServiceVisitId: string,
  executor: Executor = getPool(),
): Promise<HandymanServiceVisitScheduleRecord[]> {
  const result = await executor.query<HandymanServiceVisitScheduleRecord>(
    `SELECT ${SCHEDULE_SELECT} FROM handyman_service_visit_schedules
     WHERE handyman_service_visit_id = $1
     ORDER BY created_at ASC`,
    [handymanServiceVisitId],
  );
  return result.rows;
}

/**
 * Guarded ACTIVE→SUPERSEDED closure with attribution. The old window row is
 * NEVER mutated in its time columns; only the closure fields are written.
 * Returns null when the row was no longer ACTIVE (a concurrent reschedule
 * won) — the caller translates that into a domain 409.
 */
async function supersedeActiveSchedule(
  id: string,
  supersededByUserId: string,
  executor: Executor,
): Promise<HandymanServiceVisitScheduleRecord | null> {
  const result = await executor.query<HandymanServiceVisitScheduleRecord>(
    `UPDATE handyman_service_visit_schedules
     SET status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${SCHEDULE_SELECT}`,
    [id, supersededByUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * Guarded ACTIVE→CANCELLED closure with attribution. Cancellation frees the
 * window: conflict scans only ever consider ACTIVE schedules, so the closed
 * window becomes reusable immediately. Returns null when the row was no
 * longer ACTIVE (concurrent closure won).
 */
async function cancelActiveSchedule(
  id: string,
  cancelledByUserId: string,
  executor: Executor,
): Promise<HandymanServiceVisitScheduleRecord | null> {
  const result = await executor.query<HandymanServiceVisitScheduleRecord>(
    `UPDATE handyman_service_visit_schedules
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         cancelled_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${SCHEDULE_SELECT}`,
    [id, cancelledByUserId],
  );
  return result.rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Temporal conflict scans (half-open tstzrange '[)' — the 0319/0333    */
/* repository interval idiom; back-to-back windows never overlap).      */
/*                                                                     */
/* The conflicting party is always resolved through ANOTHER job's ACTIVE */
/* composition (handyman_job_assignments), never through data copied     */
/* onto visit/schedule rows. Same-job visits share the one composition   */
/* and are therefore excluded (a conflict requires ANOTHER non-cancelled */
/* job assignment). SUPERSEDED/CANCELLED windows are invisible to these  */
/* scans, which is exactly how cancellation frees a window and how a     */
/* reschedule ignores its own replaced window (subsumed by the same-job  */
/* exclusion; the explicit excludeScheduleId parameter keeps the guard   */
/* self-evident).                                                      */
/* ------------------------------------------------------------------ */

/** Overlap of the proposed window with the SAME crew on another job. */
async function findCrewScheduleConflict(
  input: {
    handymanWorkCrewId: string;
    handymanJobId: string;
    plannedStartAt: Date;
    plannedEndAt: Date;
    excludeScheduleId?: string | null;
  },
  executor: Executor = getPool(),
): Promise<ScheduleConflictRow | null> {
  const result = await executor.query<ScheduleConflictRow>(
    `SELECT s.id                     AS "scheduleId",
            s.handyman_service_visit_id AS "visitId",
            v.handyman_job_id        AS "jobId"
     FROM handyman_service_visit_schedules s
     JOIN handyman_service_visits v ON v.id = s.handyman_service_visit_id
     JOIN handyman_job_assignments a
       ON a.handyman_job_id = v.handyman_job_id AND a.status = 'ACTIVE'
     WHERE s.status = 'ACTIVE'
       AND a.handyman_work_crew_id = $1
       AND v.handyman_job_id <> $2
       AND ($3::uuid IS NULL OR s.id <> $3)
       AND tstzrange(s.planned_start_at, s.planned_end_at, '[)')
           && tstzrange($4::timestamptz, $5::timestamptz, '[)')
     ORDER BY s.planned_start_at ASC
     LIMIT 1`,
    [
      input.handymanWorkCrewId,
      input.handymanJobId,
      input.excludeScheduleId ?? null,
      input.plannedStartAt,
      input.plannedEndAt,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Overlap of the proposed window with ANY shared worker: ACTIVE members of
 * OTHER crews assigned to OTHER jobs, matched by vendor workforce BINDING
 * id. Temporal only — multiple-crew membership itself is never rejected.
 */
async function findWorkerScheduleConflict(
  input: {
    vendorWorkforceBindingIds: string[];
    handymanJobId: string;
    plannedStartAt: Date;
    plannedEndAt: Date;
    excludeScheduleId?: string | null;
  },
  executor: Executor = getPool(),
): Promise<ScheduleConflictRow | null> {
  if (input.vendorWorkforceBindingIds.length === 0) {
    return null;
  }
  const result = await executor.query<ScheduleConflictRow>(
    `SELECT s.id                     AS "scheduleId",
            s.handyman_service_visit_id AS "visitId",
            v.handyman_job_id        AS "jobId",
            m.vendor_workforce_binding_id AS "bindingId"
     FROM handyman_service_visit_schedules s
     JOIN handyman_service_visits v ON v.id = s.handyman_service_visit_id
     JOIN handyman_job_assignments a
       ON a.handyman_job_id = v.handyman_job_id AND a.status = 'ACTIVE'
     JOIN handyman_work_crew_members m
       ON m.crew_id = a.handyman_work_crew_id AND m.status = 'ACTIVE'
     WHERE s.status = 'ACTIVE'
       AND v.handyman_job_id <> $1
       AND m.vendor_workforce_binding_id = ANY($2::uuid[])
       AND ($3::uuid IS NULL OR s.id <> $3)
       AND tstzrange(s.planned_start_at, s.planned_end_at, '[)')
           && tstzrange($4::timestamptz, $5::timestamptz, '[)')
     ORDER BY s.planned_start_at ASC
     LIMIT 1`,
    [
      input.handymanJobId,
      input.vendorWorkforceBindingIds,
      input.excludeScheduleId ?? null,
      input.plannedStartAt,
      input.plannedEndAt,
    ],
  );
  return result.rows[0] ?? null;
}

export const handymanServiceVisitRepository = {
  cancelActiveSchedule,
  createSchedule,
  createVisit,
  findActiveScheduleByVisitId,
  findCrewScheduleConflict,
  findScheduleById,
  findVisitById,
  findWorkerScheduleConflict,
  listSchedulesByVisitId,
  listVisitsByJob,
  lockActiveScheduleByVisitId,
  lockVisitById,
  nextVisitSequence,
  supersedeActiveSchedule,
};
