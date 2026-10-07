import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  NOTIFICATION_HISTORY_CHANNELS,
  NOTIFICATION_HISTORY_STATUSES,
  isNotificationHistoryChannel,
  isNotificationHistoryStatus,
  type NotificationHistoryChannel,
  type NotificationHistoryFilters,
} from './notification-history.types';

/**
 * BE-26K — Notification history validation.
 *
 * HTTP-level parsing only (path params and query filters). There is no
 * create/update body contract — this is a read-only model.
 */

type ValidationDetail = { field: string; message: string };

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseHistoryChannelParam(raw: string): NotificationHistoryChannel {
  const value = raw.trim().toUpperCase();
  if (!isNotificationHistoryChannel(value)) {
    fail([
      {
        field: 'channel',
        message: `channel must be one of: ${NOTIFICATION_HISTORY_CHANNELS.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseHistoryIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      {
        field: 'historyId',
        message: 'historyId must be a valid UUID.',
      },
    ]);
  }
  return value;
}

export function parseHistoryFilters(
  query: unknown,
): NotificationHistoryFilters {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return {};
  }

  const source = query as Record<string, unknown>;
  const details: ValidationDetail[] = [];
  const filters: NotificationHistoryFilters = {};

  if (source.channel !== undefined && source.channel !== '') {
    const channel =
      typeof source.channel === 'string'
        ? source.channel.trim().toUpperCase()
        : '';
    if (!isNotificationHistoryChannel(channel)) {
      details.push({
        field: 'channel',
        message: `channel must be one of: ${NOTIFICATION_HISTORY_CHANNELS.join(', ')}.`,
      });
    } else {
      filters.channel = channel;
    }
  }

  if (source.status !== undefined && source.status !== '') {
    if (!isNotificationHistoryStatus(source.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${NOTIFICATION_HISTORY_STATUSES.join(', ')}.`,
      });
    } else {
      filters.status = source.status;
    }
  }

  if (details.length > 0) {
    fail(details);
  }

  return filters;
}
