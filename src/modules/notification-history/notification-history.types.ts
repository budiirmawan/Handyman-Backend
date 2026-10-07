/**
 * BE-26K — Notification history (read model) types.
 *
 * A unified, chronological, recipient-scoped read model over the delivery
 * records already produced by BE-26E (in-app), BE-26F (email), and BE-26G
 * (WhatsApp). It is READ-ONLY: no new persistence, no second audit engine.
 * Provider credentials/tokens and sensitive payloads are never exposed.
 */

export const NOTIFICATION_HISTORY_CHANNELS = [
  'IN_APP',
  'EMAIL',
  'WHATSAPP',
] as const;

export type NotificationHistoryChannel =
  (typeof NOTIFICATION_HISTORY_CHANNELS)[number];

export function isNotificationHistoryChannel(
  value: unknown,
): value is NotificationHistoryChannel {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_HISTORY_CHANNELS as readonly string[]).includes(value)
  );
}

/** Channel-specific status values appearing in the history. */
export const NOTIFICATION_HISTORY_STATUSES = [
  'UNREAD',
  'READ',
  'SENT',
  'FAILED',
] as const;

export type NotificationHistoryStatus =
  (typeof NOTIFICATION_HISTORY_STATUSES)[number];

export function isNotificationHistoryStatus(
  value: unknown,
): value is NotificationHistoryStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_HISTORY_STATUSES as readonly string[]).includes(value)
  );
}

/** The raw row returned by the unified union query (camelCase aliases). */
export type NotificationHistoryRow = {
  channel: NotificationHistoryChannel;
  id: string;
  clientId: string;
  recipientUserId: string;
  type: string | null;
  templateKey: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  sourceEventType: string | null;
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  readAt: Date | null;
  provider: string | null;
  providerReference: string | null;
  failureReason: string | null;
  /**
   * CR-BE-NOTIFY-PROV-01 PART 04 enrichment — the outbound delivery ledger
   * row an EMAIL/WHATSAPP attempt belongs to (NULL for in-app rows and for
   * pre-ledger attempts).
   */
  deliveryId: string | null;
  /**
   * CR-BE-NOTIFY-PROV-01 PART 07 enrichment — post-acceptance provider
   * feedback from the linked ledger row (DELIVERED / PROVIDER_FAILED / …;
   * NULL when no feedback or no ledger linkage).
   */
  providerFeedbackStatus: string | null;
  feedbackAt: Date | null;
  createdAt: Date;
  /** Internal ordering key — not exposed. */
  occurredAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicNotificationHistoryItem = Omit<
  NotificationHistoryRow,
  'sentAt' | 'deliveredAt' | 'failedAt' | 'readAt' | 'feedbackAt' | 'createdAt' | 'occurredAt'
> & {
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  readAt: string | null;
  feedbackAt: string | null;
  createdAt: string;
};

/** Inbox list filters (channel + status in this read model). */
export type NotificationHistoryFilters = {
  channel?: NotificationHistoryChannel;
  status?: NotificationHistoryStatus;
};
