import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import {
  handymanAssignmentResponseExpiredError,
  handymanAssignmentResponseIdempotencyConflictError,
} from './assignment-response.errors';
import { assignmentResponseRepository } from './assignment-response.repository';
import type { HandymanAssignmentTargetType } from './assignment-response.types';

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 01 — the two response-time guards shared by all
 * three assignment lanes. Both run INSIDE the caller's existing
 * `withTransaction` (after the parent scope/visit/work-order row is locked),
 * so a reassignment racing a worker response is serialized by the locks the
 * assignment services already own.
 *
 * Ordering rule (enforced by each service): identical-decision replay is
 * evaluated BEFORE these guards, so two devices replaying the same decision
 * after the window closed still converge on one 200 response and one event.
 */

export const ASSIGNMENT_RESPONSE_CLIENT_KEY_MIN_LENGTH = 8;
export const ASSIGNMENT_RESPONSE_CLIENT_KEY_MAX_LENGTH = 128;

/**
 * Bounded, caller-owned concurrency key. It is NOT an authority field: the
 * actor, assignment, tenant and decision are always resolved server-side.
 */
export function normalizeAssignmentResponseClientKey(
  value: unknown,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'idempotencyKey', message: 'idempotencyKey must be a string.' },
    ]);
  }
  const key = value.trim();
  if (
    key.length < ASSIGNMENT_RESPONSE_CLIENT_KEY_MIN_LENGTH ||
    key.length > ASSIGNMENT_RESPONSE_CLIENT_KEY_MAX_LENGTH
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'idempotencyKey',
        message: `idempotencyKey must be ${ASSIGNMENT_RESPONSE_CLIENT_KEY_MIN_LENGTH}-${ASSIGNMENT_RESPONSE_CLIENT_KEY_MAX_LENGTH} characters when supplied.`,
      },
    ]);
  }
  return key;
}

/**
 * Rejects a key that was already used by this actor to finalize a DIFFERENT
 * assignment. This is the concurrent-device / post-reassignment replay guard:
 * an offline queue must not acknowledge the replacement worker's assignment.
 * Matching on the SAME assignment is intentionally allowed — the service's
 * existing replay/conflict check owns that case.
 */
export async function assertClientKeyAvailableForAssignment(
  params: {
    actorUserId: string;
    assignmentId: string;
    clientIdempotencyKey: string | null;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  if (!params.clientIdempotencyKey) return;
  const prior = await assignmentResponseRepository.findFinalizedByClientKey(
    params.actorUserId,
    params.clientIdempotencyKey,
    executor,
  );
  if (prior && prior.assignmentId !== params.assignmentId) {
    throw handymanAssignmentResponseIdempotencyConflictError();
  }
}

/**
 * Resolves the ONE authoritative expiry fact for an assignment response:
 *   - INSPECTOR_VISIT_ASSIGNMENT → the inspection visit's own `end_at`;
 *   - EXECUTION_SCOPE_ASSIGNMENT → the end of the CONFIRMED/IN_PROGRESS
 *     EXECUTION appointment bound to the SAME scope AND the assignment's crew.
 *     An unscheduled scope has NO expiry fact and is governed only by the
 *     existing lifecycle late guard (no deadline is invented server-side).
 *   - WORK_ORDER_ASSIGNMENT → no Handyman appointment authority exists; the
 *     existing Work Order status late guard remains the sole lifecycle gate.
 *
 * The server clock is authoritative. A past end closes the response window;
 * Operations must reschedule/reassign rather than let a worker back-date an
 * acknowledgment. This deliberately does NOT touch the CR-HM-07 arrival
 * challenge (out of scope for this PART).
 */
export async function assertAssignmentResponseWindowOpen(
  params: {
    assignmentTargetType: HandymanAssignmentTargetType;
    assignmentId: string;
    visitAppointmentId?: string | null;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<{ respondByAt: Date | null }> {
  let respondByAt: Date | null = null;

  if (params.assignmentTargetType === 'INSPECTOR_VISIT_ASSIGNMENT') {
    if (!params.visitAppointmentId) return { respondByAt: null };
    const result = await executor.query<{ end_at: Date | null }>(
      `SELECT v.end_at
         FROM handyman_visit_appointments v
        WHERE v.id = $1
          AND v.kind = 'INSPECTION'
        LIMIT 1`,
      [params.visitAppointmentId],
    );
    respondByAt = result.rows[0]?.end_at ?? null;
  } else if (params.assignmentTargetType === 'EXECUTION_SCOPE_ASSIGNMENT') {
    const result = await executor.query<{ end_at: Date | null }>(
      `SELECT MAX(v.end_at) AS end_at
         FROM handyman_execution_scope_assignments a
         JOIN handyman_visit_appointments v
           ON v.execution_scope_id = a.execution_scope_id
          AND v.client_id = a.client_id
          AND v.kind = 'EXECUTION'
          AND v.resource_type = 'CREW'
          AND v.resource_id = a.handyman_crew_id
          AND v.state IN ('CONFIRMED', 'IN_PROGRESS')
        WHERE a.id = $1`,
      [params.assignmentId],
    );
    respondByAt = result.rows[0]?.end_at ?? null;
  }

  if (respondByAt && respondByAt.getTime() <= Date.now()) {
    throw handymanAssignmentResponseExpiredError();
  }
  return { respondByAt };
}
