import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  NOTIFICATION_STATUSES,
  isNotificationStatus,
  type NotificationFilters,
} from './notification.types';

/**
 * BE-26A — Notification validation.
 *
 * HTTP-level parsing only (path params and query filters). There is no
 * create/update body contract — notification creation is internal to the
 * backend (the service `recordNotification` entry point).
 */

type ValidationDetail = { field: string; message: string };

export function parseNotificationIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'notificationId', message: 'notificationId must be a valid UUID.' },
    ]);
  }
  return value;
}

export function parseNotificationFilters(
  query: unknown,
): NotificationFilters {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return {};
  }

  const source = query as Record<string, unknown>;
  const details: ValidationDetail[] = [];
  let status: NotificationFilters['status'];

  if (source.status !== undefined) {
    if (!isNotificationStatus(source.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${NOTIFICATION_STATUSES.join(', ')}.`,
      });
    } else {
      status = source.status;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return status ? { status } : {};
}
