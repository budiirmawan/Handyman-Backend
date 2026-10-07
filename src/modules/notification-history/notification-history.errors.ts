import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * BE-26K — Notification history errors.
 *
 * A history item is only ever reachable by its recipient; a lookup that
 * returns nothing (missing OR belonging to another user) is reported as a
 * NOT_FOUND with a resource reference, never as a distinguishable leak.
 */
export function notificationHistoryNotFoundError(id: string): AppError {
  return new AppError({
    code: ERROR_CODES.NOTIFICATION_HISTORY_NOT_FOUND,
    message: 'Notification history item not found.',
    statusCode: 404,
    resource: { type: 'NOTIFICATION_HISTORY', id },
  });
}
