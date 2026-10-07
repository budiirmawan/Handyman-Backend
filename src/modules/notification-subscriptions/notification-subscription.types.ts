import type { RecipientRule } from '../recipient-resolution';

/**
 * BE-26D — Notification event subscription types.
 *
 * A subscription maps an existing backend domain event (`event_type`) to a
 * notification trigger: a BE-26B template plus a BE-26C recipient rule, with
 * an optional Client/Building context and an enabled status. Declaration
 * only — no delivery, no in-app execution, and no new domain events.
 */

export const NOTIFICATION_SUBSCRIPTION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type NotificationSubscriptionStatus =
  (typeof NOTIFICATION_SUBSCRIPTION_STATUSES)[number];

export function isNotificationSubscriptionStatus(
  value: unknown,
): value is NotificationSubscriptionStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

/** The raw persisted shape of a subscription row. */
export type NotificationEventSubscriptionRecord = {
  id: string;
  key: string;
  eventType: string;
  templateKey: string;
  recipientRule: RecipientRule;
  clientId: string | null;
  buildingId: string | null;
  status: NotificationSubscriptionStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicNotificationEventSubscription = Omit<
  NotificationEventSubscriptionRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateNotificationEventSubscriptionInput = {
  key: string;
  eventType: string;
  templateKey: string;
  recipientRule: RecipientRule;
  clientId?: string | null;
  buildingId?: string | null;
  status?: NotificationSubscriptionStatus;
};

export type UpdateNotificationEventSubscriptionInput = {
  eventType?: string;
  templateKey?: string;
  recipientRule?: RecipientRule;
  clientId?: string | null;
  buildingId?: string | null;
  status?: NotificationSubscriptionStatus;
};

/** The event context used when matching subscriptions to an occurred event. */
export type SubscriptionMatchContext = {
  clientId?: string;
  buildingId?: string;
};
