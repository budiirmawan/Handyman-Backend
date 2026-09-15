import type { RecipientRule } from '../recipient-resolution';

/**
 * BE-26I — Notification escalation types.
 *
 * An escalation is a time-deferred notification trigger: when the current
 * recipient has not resolved the source resource by `escalationAt`, the
 * escalation renders its template and triggers notification delivery to the
 * escalation recipients. It triggers delivery only — the source domain
 * remains authoritative, and no workflow/approval engine is created.
 */

export const NOTIFICATION_ESCALATION_STATUSES = [
  'PENDING',
  'TRIGGERED',
  'CANCELLED',
] as const;

export type NotificationEscalationStatus =
  (typeof NOTIFICATION_ESCALATION_STATUSES)[number];

export function isNotificationEscalationStatus(
  value: unknown,
): value is NotificationEscalationStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_ESCALATION_STATUSES as readonly string[]).includes(value)
  );
}

/** The raw persisted shape of an escalation row. */
export type NotificationEscalationRecord = {
  id: string;
  key: string;
  clientId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  currentRecipientUserId: string | null;
  escalationRule: RecipientRule;
  templateKey: string;
  escalationAt: Date;
  triggeredAt: Date | null;
  status: NotificationEscalationStatus;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicNotificationEscalation = Omit<
  NotificationEscalationRecord,
  'escalationAt' | 'triggeredAt' | 'createdAt' | 'updatedAt'
> & {
  escalationAt: string;
  triggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateNotificationEscalationInput = {
  key: string;
  clientId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  currentRecipientUserId?: string | null;
  escalationRule: RecipientRule;
  templateKey: string;
  escalationAt: string;
  reason?: string | null;
};

export type UpdateNotificationEscalationInput = {
  escalationAt?: string;
  currentRecipientUserId?: string | null;
  escalationRule?: RecipientRule;
  templateKey?: string;
  reason?: string | null;
};

/** Summary of a trigger run (for observability, not persisted). */
export type TriggerEscalationResult = {
  triggered: number;
  notificationsCreated: number;
};
