import { notificationHistoryRepository } from './notification-history.repository';
import { notificationHistoryNotFoundError } from './notification-history.errors';
import type {
  NotificationHistoryChannel,
  NotificationHistoryFilters,
  NotificationHistoryRow,
  PublicNotificationHistoryItem,
} from './notification-history.types';

/**
 * BE-26K — Notification history service (read-only).
 *
 * A unified, chronological, recipient-scoped read model over the delivery
 * records produced by BE-26E (in-app), BE-26F (email), and BE-26G (WhatsApp).
 * No new persistence and no second audit engine: this only reads the existing
 * delivery tables. Provider credentials/tokens and sensitive payloads are
 * never exposed (failure reasons were already sanitized at write time).
 */

export function toPublicHistoryItem(
  row: NotificationHistoryRow,
): PublicNotificationHistoryItem {
  return {
    channel: row.channel,
    id: row.id,
    clientId: row.clientId,
    recipientUserId: row.recipientUserId,
    type: row.type,
    templateKey: row.templateKey,
    sourceEntityType: row.sourceEntityType,
    sourceEntityId: row.sourceEntityId,
    sourceEventType: row.sourceEventType,
    status: row.status,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    failedAt: row.failedAt ? row.failedAt.toISOString() : null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    provider: row.provider,
    providerReference: row.providerReference,
    failureReason: row.failureReason,
    deliveryId: row.deliveryId,
    providerFeedbackStatus: row.providerFeedbackStatus,
    feedbackAt: row.feedbackAt ? row.feedbackAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Lists the recipient's own delivery history (newest first). */
export async function listHistory(
  recipientUserId: string,
  filters: NotificationHistoryFilters = {},
  limit?: number,
  offset?: number,
): Promise<PublicNotificationHistoryItem[]> {
  const rows = await notificationHistoryRepository.listByRecipient(
    recipientUserId,
    filters,
    limit,
    offset,
  );
  return rows.map(toPublicHistoryItem);
}

/** Counts the recipient's own history items (for pagination meta). */
export async function countHistory(
  recipientUserId: string,
  filters: NotificationHistoryFilters = {},
): Promise<number> {
  return notificationHistoryRepository.countByRecipient(recipientUserId, filters);
}

/** Returns the recipient's own history item by channel + id. */
export async function getHistoryItem(
  recipientUserId: string,
  channel: NotificationHistoryChannel,
  id: string,
): Promise<PublicNotificationHistoryItem> {
  const row = await notificationHistoryRepository.findById(
    recipientUserId,
    channel,
    id,
  );
  if (!row) {
    throw notificationHistoryNotFoundError(id);
  }
  return toPublicHistoryItem(row);
}

export const notificationHistoryService = {
  countHistory,
  getHistoryItem,
  listHistory,
  toPublicHistoryItem,
};
