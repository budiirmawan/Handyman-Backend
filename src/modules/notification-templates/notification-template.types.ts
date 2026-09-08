/**
 * BE-26B — Notification template types.
 *
 * A reusable notification template: the rendering recipe for a notification
 * type. Pure foundation — no recipient resolution, no sending, no
 * provider-specific logic.
 */

/**
 * Template channels. BE-26B founded IN_APP only; CR-BE-NOTIFY-PROV-01
 * PART 03 widens the vocabulary additively with EMAIL / WHATSAPP (migration
 * 0300) so outbound delivery intents can render from templates. IN_APP stays
 * the in-app inbox channel; EMAIL / WHATSAPP are outbound-intent channels.
 */
export const NOTIFICATION_TEMPLATE_CHANNELS = ['IN_APP', 'EMAIL', 'WHATSAPP'] as const;
export type NotificationTemplateChannel =
  (typeof NOTIFICATION_TEMPLATE_CHANNELS)[number];

export const NOTIFICATION_TEMPLATE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type NotificationTemplateStatus =
  (typeof NOTIFICATION_TEMPLATE_STATUSES)[number];

export function isNotificationTemplateChannel(
  value: unknown,
): value is NotificationTemplateChannel {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_TEMPLATE_CHANNELS as readonly string[]).includes(value)
  );
}

export function isNotificationTemplateStatus(
  value: unknown,
): value is NotificationTemplateStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_TEMPLATE_STATUSES as readonly string[]).includes(value)
  );
}

/** Template variable names: letters, digits, underscore (no leading digit). */
export const TEMPLATE_VARIABLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Extracts the declared `{{variable}}` placeholders from a template string. */
export function extractTemplateVariables(text: string): string[] {
  const names: string[] = [];
  const pattern = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/** The raw persisted shape of a notification template row. */
export type NotificationTemplateRecord = {
  id: string;
  key: string;
  type: string;
  channel: NotificationTemplateChannel;
  subject: string;
  body: string | null;
  variables: string[];
  status: NotificationTemplateStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicNotificationTemplate = Omit<
  NotificationTemplateRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateNotificationTemplateInput = {
  key: string;
  type: string;
  channel: NotificationTemplateChannel;
  subject: string;
  body?: string | null;
  variables?: string[];
};

export type UpdateNotificationTemplateInput = {
  type?: string;
  channel?: NotificationTemplateChannel;
  subject?: string;
  body?: string | null;
  variables?: string[];
  status?: NotificationTemplateStatus;
};

/** The rendered result of a template (title + body with variables resolved). */
export type RenderedNotificationTemplate = {
  subject: string;
  body: string | null;
};
