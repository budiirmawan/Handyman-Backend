/**
 * BE-26A — Notification foundation types.
 *
 * The shared notification record: a recipient-scoped, append-only in-app
 * notification that reacts to existing operational events. Only the IN_APP
 * channel exists in this foundation — push / email / WhatsApp / SMS delivery,
 * provider adapters, and delivery/retry state are out of scope here.
 */

export const NOTIFICATION_CHANNELS = ['IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['UNREAD', 'READ'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export function isNotificationStatus(value: unknown): value is NotificationStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
  );
}

/** The raw persisted shape of a notification row. */
export type NotificationRecord = {
  id: string;
  clientId: string;
  recipientUserId: string;
  type: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  title: string;
  body: string | null;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceEventType: string | null;
  /** BE-26B template that rendered this notification (null when created directly). */
  templateKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  /** When the in-app delivery became visible to the recipient (BE-26E). */
  deliveredAt: Date;
  readAt: Date | null;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicNotification = Omit<
  NotificationRecord,
  'createdAt' | 'deliveredAt' | 'readAt' | 'updatedAt'
> & {
  createdAt: string;
  deliveredAt: string;
  readAt: string | null;
  updatedAt: string;
};

/**
 * Input for creating a notification. Creation is internal (the foundation for
 * later event-reaction wiring) — there is no client-facing create endpoint.
 */
export type NewNotification = {
  clientId: string;
  recipientUserId: string;
  type: string;
  channel: NotificationChannel;
  title: string;
  body?: string | null;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceEventType?: string | null;
  templateKey?: string | null;
  metadata?: Record<string, unknown>;
};

/** Inbox list filters (status only in this foundation). */
export type NotificationFilters = {
  status?: NotificationStatus;
};
