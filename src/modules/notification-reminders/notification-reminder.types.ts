import type { RecipientRule } from '../recipient-resolution';

/**
 * BE-26H — Notification reminder types.
 *
 * A reminder is a time-deferred notification trigger: it references the
 * source/resource being reminded about, the recipients (via the BE-26C
 * rule), and the BE-26B template to render at dispatch time. It triggers
 * notification delivery only — no scheduler engine and no escalation here.
 */

export const NOTIFICATION_REMINDER_STATUSES = [
  'PENDING',
  'SENT',
  'CANCELLED',
] as const;

export type NotificationReminderStatus =
  (typeof NOTIFICATION_REMINDER_STATUSES)[number];

export function isNotificationReminderStatus(
  value: unknown,
): value is NotificationReminderStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_REMINDER_STATUSES as readonly string[]).includes(value)
  );
}

/** The raw persisted shape of a reminder row. */
export type NotificationReminderRecord = {
  id: string;
  key: string;
  clientId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  recipientRule: RecipientRule;
  templateKey: string;
  variables: Record<string, string | number>;
  reminderAt: Date;
  status: NotificationReminderStatus;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicNotificationReminder = Omit<
  NotificationReminderRecord,
  'reminderAt' | 'sentAt' | 'createdAt' | 'updatedAt'
> & {
  reminderAt: string;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateNotificationReminderInput = {
  key: string;
  clientId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  recipientRule: RecipientRule;
  templateKey: string;
  variables?: Record<string, string | number>;
  reminderAt: string;
};

export type UpdateNotificationReminderInput = {
  reminderAt?: string;
  templateKey?: string;
  recipientRule?: RecipientRule;
  variables?: Record<string, string | number>;
};

/** Summary of a dispatch run (for observability, not persisted). */
export type DispatchReminderResult = {
  dispatched: number;
  notificationsCreated: number;
};
