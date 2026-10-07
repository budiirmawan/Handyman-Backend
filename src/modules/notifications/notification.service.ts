import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { notificationRepository } from './notification.repository';
import { notificationNotFoundError } from './notification.errors';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_NAVIGATION_TARGET_TYPES,
  isNotificationChannel,
  isNotificationNavigationTargetType,
  type NewNotification,
  type NotificationFilters,
  type NotificationRecord,
  type PublicNotification,
} from './notification.types';

/**
 * BE-26A — Notification service.
 *
 * The shared notification foundation:
 *   - `recordNotification` — internal creation entry point (the seam later
 *     BE-26 parts call when reacting to operational events). No HTTP create.
 *   - `listNotifications` / `countNotifications` — the authenticated user's
 *     own inbox (recipient-scoped; Client/Building isolation is preserved by
 *     never resolving another user's rows).
 *   - `getNotification` / `markNotificationRead` — own-record read + the
 *     idempotent UNREAD → READ transition.
 *
 * No push / email / WhatsApp / SMS delivery and no provider integration here.
 */

export function toPublicNotification(
  record: NotificationRecord,
): PublicNotification {
  return {
    id: record.id,
    clientId: record.clientId,
    recipientUserId: record.recipientUserId,
    type: record.type,
    channel: record.channel,
    status: record.status,
    title: record.title,
    body: record.body,
    sourceEntityType: record.sourceEntityType,
    sourceEntityId: record.sourceEntityId,
    sourceEventType: record.sourceEventType,
    templateKey: record.templateKey,
    metadata: record.metadata,
    navigationTarget: toPublicNavigationTarget(record),
    createdAt: record.createdAt.toISOString(),
    deliveredAt: record.deliveredAt.toISOString(),
    readAt: record.readAt ? record.readAt.toISOString() : null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 — maps the persisted target pair onto the
 * public contract.
 *
 * Degrades to `null` rather than throwing: a row is only ever written through
 * the closed vocabulary (enforced by the migration 0358 CHECK), so an
 * unrecognised type means the storage no longer honours this contract. Serving
 * "no target" is the safe failure — the client falls back to the inbox, and it
 * is never invited to interpret `sourceEntityType` instead.
 */
function toPublicNavigationTarget(
  record: NotificationRecord,
): PublicNotification['navigationTarget'] {
  if (
    !isNotificationNavigationTargetType(record.navigationTargetType) ||
    record.navigationTargetId === null
  ) {
    return null;
  }
  return {
    type: record.navigationTargetType,
    id: record.navigationTargetId,
  };
}

function validateNewNotification(input: NewNotification): void {
  const details: { field: string; message: string }[] = [];

  if (!isNotificationChannel(input.channel)) {
    details.push({
      field: 'channel',
      message: `channel must be one of: ${NOTIFICATION_CHANNELS.join(', ')}.`,
    });
  }
  if (typeof input.type !== 'string' || input.type.trim().length === 0) {
    details.push({ field: 'type', message: 'type must be a non-empty string.' });
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    details.push({
      field: 'title',
      message: 'title must be a non-empty string.',
    });
  }
  if (typeof input.sourceEntityType !== 'string' || input.sourceEntityType.trim().length === 0) {
    details.push({
      field: 'sourceEntityType',
      message: 'sourceEntityType must be a non-empty string.',
    });
  }
  for (const field of ['clientId', 'recipientUserId', 'sourceEntityId'] as const) {
    if (typeof input[field] !== 'string' || !isValidUuid(input[field])) {
      details.push({ field, message: `${field} must be a valid UUID.` });
    }
  }

  // CR-BE-RN21-NOTIFICATION-NAV-01 — a supply-side guard mirroring the
  // migration 0358 CHECK: either no target at all, or a recognised type with a
  // valid UUID id. The target is taken from the caller as-is; it is never
  // synthesised from `sourceEntityType`, `sourceEntityId` or `metadata`.
  if (input.navigationTarget !== undefined && input.navigationTarget !== null) {
    const target = input.navigationTarget;
    if (!isNotificationNavigationTargetType(target.type)) {
      details.push({
        field: 'navigationTarget.type',
        message: `navigationTarget.type must be one of: ${NOTIFICATION_NAVIGATION_TARGET_TYPES.join(', ')}.`,
      });
    }
    if (typeof target.id !== 'string' || !isValidUuid(target.id)) {
      details.push({
        field: 'navigationTarget.id',
        message: 'navigationTarget.id must be a valid UUID.',
      });
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
}

/** Creates a notification record (internal seam; no HTTP endpoint). */
export async function recordNotification(
  input: NewNotification,
): Promise<PublicNotification> {
  validateNewNotification(input);
  const record = await notificationRepository.create({
    ...input,
    title: input.title.trim(),
    type: input.type.trim(),
    sourceEntityType: input.sourceEntityType.trim(),
    body: input.body ?? null,
    sourceEventType: input.sourceEventType ?? null,
    templateKey: input.templateKey ?? null,
    metadata: input.metadata ?? {},
    navigationTarget: input.navigationTarget ?? null,
  });
  return toPublicNotification(record);
}

/** Lists the recipient's own notifications (newest first). */
export async function listNotifications(
  recipientUserId: string,
  filters: NotificationFilters = {},
  limit?: number,
  offset?: number,
): Promise<PublicNotification[]> {
  const rows = await notificationRepository.listByRecipient(
    recipientUserId,
    filters,
    limit,
    offset,
  );
  return rows.map(toPublicNotification);
}

/** Counts the recipient's own notifications (for pagination meta). */
export async function countNotifications(
  recipientUserId: string,
  filters: NotificationFilters = {},
): Promise<number> {
  return notificationRepository.countByRecipient(recipientUserId, filters);
}

/** Returns the recipient's own notification by id. */
export async function getNotification(
  recipientUserId: string,
  id: string,
): Promise<PublicNotification> {
  const record = await notificationRepository.findById(recipientUserId, id);
  if (!record) {
    throw notificationNotFoundError(id);
  }
  return toPublicNotification(record);
}

/**
 * Marks the recipient's own notification as READ. Idempotent: the original
 * `read_at` is preserved on repeat calls.
 */
export async function markNotificationRead(
  recipientUserId: string,
  id: string,
): Promise<PublicNotification> {
  const record = await notificationRepository.markRead(recipientUserId, id);
  if (!record) {
    throw notificationNotFoundError(id);
  }
  return toPublicNotification(record);
}

export const notificationService = {
  countNotifications,
  getNotification,
  listNotifications,
  markNotificationRead,
  recordNotification,
  toPublicNotification,
};
