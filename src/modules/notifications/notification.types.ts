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

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 — the persisted navigation target type
 * vocabulary.
 *
 * A CLOSED list, mirrored by the `notifications_navigation_target_check`
 * database constraint (migration 0358). Exactly one type exists today —
 * `WORK_ORDER_FIELD_WORK`: "open this notification's Work Order on the mobile
 * FieldWork surface". A destination is deliberately NOT a frontend route
 * string: the backend owns the target identity, the client owns its routing.
 */
export const NOTIFICATION_NAVIGATION_TARGET_TYPES = [
  'WORK_ORDER_FIELD_WORK',
] as const;

export type NotificationNavigationTargetType =
  (typeof NOTIFICATION_NAVIGATION_TARGET_TYPES)[number];

export function isNotificationNavigationTargetType(
  value: unknown,
): value is NotificationNavigationTargetType {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_NAVIGATION_TARGET_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The public, explicit navigation target of a notification.
 *
 * This is the ONLY navigation authority a client needs. `sourceEntityType` /
 * `sourceEntityId` / `metadata` remain NON-NAVIGATION fields: they describe
 * what produced the notification, they were never a routing contract, and no
 * client may derive a destination from them.
 */
export type PublicNotificationNavigationTarget = {
  type: NotificationNavigationTargetType;
  /** The canonical backend entity id the target points at. */
  id: string;
};

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
  /**
   * CR-BE-RN21-NOTIFICATION-NAV-01 — explicit navigation target type, set ONLY
   * by a producer that knows the canonical entity (null otherwise). Never
   * derived from `sourceEntityType` / `metadata`.
   */
  navigationTargetType: string | null;
  /** The canonical target entity id; NOT NULL exactly when the type is set. */
  navigationTargetId: string | null;
  createdAt: Date;
  /** When the in-app delivery became visible to the recipient (BE-26E). */
  deliveredAt: Date;
  readAt: Date | null;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicNotification = Omit<
  NotificationRecord,
  | 'createdAt'
  | 'deliveredAt'
  | 'readAt'
  | 'updatedAt'
  | 'navigationTargetType'
  | 'navigationTargetId'
> & {
  /**
   * CR-BE-RN21-NOTIFICATION-NAV-01 — the persisted target pair exposed as one
   * explicit object, or null when the producer declared no target. The raw
   * columns are never surfaced separately.
   */
  navigationTarget: PublicNotificationNavigationTarget | null;
  createdAt: string;
  deliveredAt: string;
  readAt: string | null;
  updatedAt: string;
};

/**
 * Input for creating a notification. Creation is internal (the foundation for
 * later event-reaction wiring) — there is no client-facing create endpoint.
 *
 * CR-BE-RN21-NOTIFICATION-NAV-01 — `navigationTarget` is supplied EXPLICITLY by
 * a producer that knows the canonical backend entity. A producer that does not
 * know one omits it and the notification carries no target. It is never derived
 * from `sourceEntityType` / `sourceEntityId` / `metadata`.
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
  navigationTarget?: PublicNotificationNavigationTarget | null;
};

/** Inbox list filters (status only in this foundation). */
export type NotificationFilters = {
  status?: NotificationStatus;
};
