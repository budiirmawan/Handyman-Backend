import { notificationReminderRepository } from './notification-reminder.repository';
import {
  notificationReminderKeyAlreadyExistsError,
  notificationReminderNotFoundError,
  notificationReminderNotPendingError,
  notificationReminderTemplateMissingError,
} from './notification-reminder.errors';
import {
  getActiveTemplateByKey,
  notificationTemplateRepository,
  renderTemplate,
} from '../notification-templates';
import {
  recordNotification,
  type PublicNotification,
} from '../notifications';
import { resolveRecipients } from '../recipient-resolution';
import type {
  CreateNotificationReminderInput,
  DispatchReminderResult,
  NotificationReminderRecord,
  PublicNotificationReminder,
  UpdateNotificationReminderInput,
} from './notification-reminder.types';

/**
 * BE-26H — Notification reminder service.
 *
 * A reminder is a time-deferred notification trigger. The service provides:
 *   - CRUD for reminder records (platform configuration),
 *   - `findDueReminders` — the scheduler seam (NO scheduler engine is
 *     created; an external worker calls this),
 *   - `dispatchReminder` / `dispatchDueReminders` — the trigger that claims
 *     the PENDING → SENT transition FIRST (claim-before-send, so concurrent
 *     dispatchers can never double-deliver), then renders the template,
 *     resolves recipients, and records in-app notifications.
 *
 * The reminder only triggers delivery — the source domain remains
 * authoritative, and no escalation is implemented here.
 */

const REMINDER_SOURCE_EVENT_TYPE = 'REMINDER_DUE';

export function toPublicNotificationReminder(
  record: NotificationReminderRecord,
): PublicNotificationReminder {
  return {
    id: record.id,
    key: record.key,
    clientId: record.clientId,
    sourceEntityType: record.sourceEntityType,
    sourceEntityId: record.sourceEntityId,
    recipientRule: record.recipientRule,
    templateKey: record.templateKey,
    variables: record.variables,
    reminderAt: record.reminderAt.toISOString(),
    status: record.status,
    sentAt: record.sentAt ? record.sentAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === '23505'
  );
}

/** Validates that the referenced BE-26B template exists. */
async function assertTemplateExists(templateKey: string): Promise<void> {
  const template = await notificationTemplateRepository.findByKey(templateKey);
  if (!template) {
    throw notificationReminderTemplateMissingError();
  }
}

export async function createReminder(
  input: CreateNotificationReminderInput,
): Promise<PublicNotificationReminder> {
  await assertTemplateExists(input.templateKey);

  try {
    const record = await notificationReminderRepository.create({
      key: input.key,
      clientId: input.clientId,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      recipientRule: input.recipientRule,
      templateKey: input.templateKey,
      variables: input.variables ?? {},
      reminderAt: new Date(input.reminderAt),
    });
    return toPublicNotificationReminder(record);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw notificationReminderKeyAlreadyExistsError();
    }
    throw error;
  }
}

export async function listReminders(
  status?: NotificationReminderRecord['status'],
): Promise<PublicNotificationReminder[]> {
  const rows = await notificationReminderRepository.list(status);
  return rows.map(toPublicNotificationReminder);
}

export async function getReminder(id: string): Promise<PublicNotificationReminder> {
  const record = await notificationReminderRepository.findById(id);
  if (!record) {
    throw notificationReminderNotFoundError(id);
  }
  return toPublicNotificationReminder(record);
}

export async function updateReminder(
  id: string,
  input: UpdateNotificationReminderInput,
): Promise<PublicNotificationReminder> {
  const existing = await notificationReminderRepository.findById(id);
  if (!existing) {
    throw notificationReminderNotFoundError(id);
  }
  if (existing.status !== 'PENDING') {
    throw notificationReminderNotPendingError();
  }

  const mergedTemplateKey = input.templateKey ?? existing.templateKey;
  await assertTemplateExists(mergedTemplateKey);

  const record = await notificationReminderRepository.update(id, input);
  if (!record) {
    throw notificationReminderNotFoundError(id);
  }
  return toPublicNotificationReminder(record);
}

/** Cancels a PENDING reminder (terminal: PENDING → CANCELLED). */
export async function cancelReminder(
  id: string,
): Promise<PublicNotificationReminder> {
  const existing = await notificationReminderRepository.findById(id);
  if (!existing) {
    throw notificationReminderNotFoundError(id);
  }
  const record = await notificationReminderRepository.markCancelled(id);
  if (!record) {
    throw notificationReminderNotPendingError();
  }
  return toPublicNotificationReminder(record);
}

/**
 * The scheduler seam: returns PENDING reminders due at or before `before`
 * (defaults to now). An external scheduler/worker polls this — no scheduler
 * engine lives here.
 */
export async function findDueReminders(
  before: Date = new Date(),
): Promise<PublicNotificationReminder[]> {
  const rows = await notificationReminderRepository.findDue(before);
  return rows.map(toPublicNotificationReminder);
}

/**
 * Dispatches a single reminder using claim-before-send (CR-BE-STAB-03
 * PART 05). After the read-only pre-checks (exists, still PENDING, template
 * ACTIVE), the PENDING → SENT transition is CLAIMED FIRST via the guarded
 * `markSent` UPDATE (`WHERE status = 'PENDING' RETURNING ...`). Only the
 * claim winner renders the template, resolves recipients, and records in-app
 * notifications; a dispatcher that loses the claim (null) sends and records
 * nothing, so concurrent dispatch attempts can never double-deliver. Returns
 * null when the reminder is not PENDING or the claim is lost (idempotent for
 * repeat dispatch).
 */
export async function dispatchReminder(
  id: string,
): Promise<{ reminder: PublicNotificationReminder; notifications: PublicNotification[] } | null> {
  const existing = await notificationReminderRepository.findById(id);
  if (!existing) {
    throw notificationReminderNotFoundError(id);
  }
  if (existing.status !== 'PENDING') {
    return null;
  }

  const template = await getActiveTemplateByKey(existing.templateKey);
  if (!template) {
    // Template no longer ACTIVE — leave the reminder PENDING (unclaimed) so a
    // later dispatch (after re-enabling the template) can deliver it.
    return null;
  }

  // CR-BE-STAB-03 PART 05 — claim BEFORE send: atomically transition
  // PENDING → SENT. When this returns null another dispatcher already
  // claimed the reminder: do NOT resolve recipients or recordNotification.
  const claimed = await notificationReminderRepository.markSent(
    existing.id,
    new Date(),
  );
  if (!claimed) {
    return null;
  }

  const rendered = renderTemplate(
    { subject: template.subject, body: template.body },
    claimed.variables,
  );

  const recipientIds = await resolveRecipients(
    claimed.recipientRule.specs,
    claimed.recipientRule.scope,
  );

  const notifications: PublicNotification[] = [];
  for (const recipientUserId of recipientIds) {
    notifications.push(
      await recordNotification({
        clientId: claimed.clientId,
        recipientUserId,
        type: template.type,
        channel: 'IN_APP',
        title: rendered.subject,
        body: rendered.body,
        sourceEntityType: claimed.sourceEntityType,
        sourceEntityId: claimed.sourceEntityId,
        sourceEventType: REMINDER_SOURCE_EVENT_TYPE,
        templateKey: claimed.templateKey,
        metadata: { reminderKey: claimed.key, reminderId: claimed.id },
      }),
    );
  }

  return { reminder: toPublicNotificationReminder(claimed), notifications };
}

/**
 * Dispatches PENDING reminders due at or before `before` (bounded retrieval:
 * the repository caps one pass at a small batch; leftovers stay PENDING for
 * the next pass). Best-effort: reminders whose template is no longer ACTIVE
 * are skipped (left PENDING), as are reminders whose claim is lost.
 */
export async function dispatchDueReminders(
  before: Date = new Date(),
): Promise<DispatchReminderResult> {
  const due = await notificationReminderRepository.findDue(before);

  let dispatched = 0;
  let notificationsCreated = 0;
  for (const reminder of due) {
    const result = await dispatchReminder(reminder.id);
    if (result) {
      dispatched += 1;
      notificationsCreated += result.notifications.length;
    }
  }

  return { dispatched, notificationsCreated };
}

export const notificationReminderService = {
  cancelReminder,
  createReminder,
  dispatchDueReminders,
  dispatchReminder,
  findDueReminders,
  getReminder,
  listReminders,
  toPublicNotificationReminder,
  updateReminder,
};
