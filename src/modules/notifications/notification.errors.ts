import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26A — Notification errors.
 *
 * A notification is only ever reachable by its recipient; a lookup that
 * returns nothing (missing OR belonging to another user) is reported as a
 * NOT_FOUND with a resource reference, never as a distinguishable leak.
 */
export function notificationNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_NOT_FOUND,
    message: 'Notification not found.',
    statusCode: 404,
    resource: { type: 'NOTIFICATION', id },
  });
}

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 — the notification's explicit navigation
 * target matched more than one assignment visible to the caller.
 *
 * The resolver requires exactly one match. Selecting one of several —
 * `rows[0]`, `LIMIT 1`, ordering — would be the backend choosing a winner from
 * an ambiguous set, and the client would then act on a decision nobody made.
 *
 * This is currently a DEFENSIVE guard rather than an everyday outcome: the
 * baseline schema keeps at most one ACTIVE assignment per Work Order
 * (`work_order_active_assignment_unique`, migration 0085 — partial unique index
 * on `(work_order_id) WHERE status = 'ACTIVE'`). The guard exists because the
 * resolver must not depend on an invariant it does not own: an assignment row
 * added under a relaxed constraint, a migrated legacy data set, or any future
 * assignment model widening (Workforce AND Team, vendor-side rows, …) would
 * otherwise silently hand the client an arbitrary assignment.
 *
 * Not a leak: the caller already owns the notification, and the conflict
 * carries no assignment content — only the notification id and how many
 * candidate assignments were visible.
 */
export function notificationNavigationTargetAmbiguousError(
  notificationId: string,
  matchingAssignments: number,
): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_NAVIGATION_TARGET_AMBIGUOUS,
    message:
      'Notification navigation target is ambiguous: more than one visible assignment matches the target.',
    statusCode: 409,
    resource: { type: 'NOTIFICATION', id: notificationId },
    conflict: { matchingAssignments },
  });
}
