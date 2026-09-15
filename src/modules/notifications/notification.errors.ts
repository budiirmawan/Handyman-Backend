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
