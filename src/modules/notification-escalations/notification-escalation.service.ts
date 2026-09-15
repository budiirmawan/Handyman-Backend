import { notificationEscalationRepository } from './notification-escalation.repository';
import {
  notificationEscalationKeyAlreadyExistsError,
  notificationEscalationNotFoundError,
  notificationEscalationNotPendingError,
  notificationEscalationTemplateMissingError,
} from './notification-escalation.errors';
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
  CreateNotificationEscalationInput,
  NotificationEscalationRecord,
  PublicNotificationEscalation,
  TriggerEscalationResult,
  UpdateNotificationEscalationInput,
} from './notification-escalation.types';

/**
 * BE-26I — Notification escalation service.
 *
 * An escalation is a time-deferred notification trigger: when the current
 * recipient has not resolved the source resource by `escalationAt`, the
 * escalation renders its template and triggers notification delivery to the
 * escalation recipients.
 *
 * The escalation triggers delivery ONLY — the source domain remains
 * authoritative, no workflow/approval engine is created, and no
 * business-resource state is altered. It follows the BE-26H reminder pattern
 * (durable record + `findDueEscalations` / `triggerDueEscalations` seams,
 * claim-before-send at trigger time).
 */

const ESCALATION_SOURCE_EVENT_TYPE = 'ESCALATION_TRIGGERED';

export function toPublicNotificationEscalation(
  record: NotificationEscalationRecord,
): PublicNotificationEscalation {
  return {
    id: record.id,
    key: record.key,
    clientId: record.clientId,
    sourceEntityType: record.sourceEntityType,
    sourceEntityId: record.sourceEntityId,
    currentRecipientUserId: record.currentRecipientUserId,
    escalationRule: record.escalationRule,
    templateKey: record.templateKey,
    escalationAt: record.escalationAt.toISOString(),
    triggeredAt: record.triggeredAt ? record.triggeredAt.toISOString() : null,
    status: record.status,
    reason: record.reason,
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
    throw notificationEscalationTemplateMissingError();
  }
}

export async function createEscalation(
  input: CreateNotificationEscalationInput,
): Promise<PublicNotificationEscalation> {
  await assertTemplateExists(input.templateKey);

  try {
    const record = await notificationEscalationRepository.create({
      key: input.key,
      clientId: input.clientId,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      currentRecipientUserId: input.currentRecipientUserId ?? null,
      escalationRule: input.escalationRule,
      templateKey: input.templateKey,
      escalationAt: new Date(input.escalationAt),
      reason: input.reason ?? null,
    });
    return toPublicNotificationEscalation(record);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw notificationEscalationKeyAlreadyExistsError();
    }
    throw error;
  }
}

export async function listEscalations(
  status?: NotificationEscalationRecord['status'],
): Promise<PublicNotificationEscalation[]> {
  const rows = await notificationEscalationRepository.list(status);
  return rows.map(toPublicNotificationEscalation);
}

export async function getEscalation(id: string): Promise<PublicNotificationEscalation> {
  const record = await notificationEscalationRepository.findById(id);
  if (!record) {
    throw notificationEscalationNotFoundError(id);
  }
  return toPublicNotificationEscalation(record);
}

export async function updateEscalation(
  id: string,
  input: UpdateNotificationEscalationInput,
): Promise<PublicNotificationEscalation> {
  const existing = await notificationEscalationRepository.findById(id);
  if (!existing) {
    throw notificationEscalationNotFoundError(id);
  }
  if (existing.status !== 'PENDING') {
    throw notificationEscalationNotPendingError();
  }

  const mergedTemplateKey = input.templateKey ?? existing.templateKey;
  await assertTemplateExists(mergedTemplateKey);

  const record = await notificationEscalationRepository.update(id, input);
  if (!record) {
    throw notificationEscalationNotFoundError(id);
  }
  return toPublicNotificationEscalation(record);
}

/** Cancels a PENDING escalation (terminal: PENDING → CANCELLED). */
export async function cancelEscalation(
  id: string,
): Promise<PublicNotificationEscalation> {
  const existing = await notificationEscalationRepository.findById(id);
  if (!existing) {
    throw notificationEscalationNotFoundError(id);
  }
  const record = await notificationEscalationRepository.markCancelled(id);
  if (!record) {
    throw notificationEscalationNotPendingError();
  }
  return toPublicNotificationEscalation(record);
}

/**
 * The scheduler seam: returns PENDING escalations due at or before `before`
 * (defaults to now). An external scheduler/worker polls this — no scheduler
 * engine lives here.
 */
export async function findDueEscalations(
  before: Date = new Date(),
): Promise<PublicNotificationEscalation[]> {
  const rows = await notificationEscalationRepository.findDue(before);
  return rows.map(toPublicNotificationEscalation);
}

/**
 * Triggers a single escalation using claim-before-send (CR-BE-STAB-03
 * PART 05). After the read-only pre-checks (exists, still PENDING, template
 * ACTIVE), the PENDING → TRIGGERED transition is CLAIMED FIRST via the
 * guarded `markTriggered` UPDATE (`WHERE status = 'PENDING' RETURNING ...`)
 * which also stamps `triggeredAt`. Only the claim winner renders the
 * template, resolves the escalation recipients, and records in-app
 * notifications; a worker that loses the claim (null) sends and records
 * nothing, so concurrent trigger attempts can never double-deliver. Returns
 * null when the escalation is not PENDING or the claim is lost (idempotent
 * for repeat trigger).
 */
export async function triggerEscalation(
  id: string,
): Promise<{ escalation: PublicNotificationEscalation; notifications: PublicNotification[] } | null> {
  const existing = await notificationEscalationRepository.findById(id);
  if (!existing) {
    throw notificationEscalationNotFoundError(id);
  }
  if (existing.status !== 'PENDING') {
    return null;
  }

  const template = await getActiveTemplateByKey(existing.templateKey);
  if (!template) {
    // Template no longer ACTIVE — leave the escalation PENDING (unclaimed)
    // so a later trigger (after re-enabling the template) can deliver it.
    return null;
  }

  // CR-BE-STAB-03 PART 05 — claim BEFORE send: atomically transition
  // PENDING → TRIGGERED. When this returns null another worker already
  // claimed the escalation: do NOT resolve recipients or recordNotification.
  const claimed = await notificationEscalationRepository.markTriggered(
    existing.id,
    new Date(),
  );
  if (!claimed) {
    return null;
  }

  const rendered = renderTemplate(
    { subject: template.subject, body: template.body },
    {},
  );

  const recipientIds = await resolveRecipients(
    claimed.escalationRule.specs,
    claimed.escalationRule.scope,
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
        sourceEventType: ESCALATION_SOURCE_EVENT_TYPE,
        templateKey: claimed.templateKey,
        metadata: {
          escalationKey: claimed.key,
          escalationId: claimed.id,
          currentRecipientUserId: claimed.currentRecipientUserId,
        },
      }),
    );
  }

  return { escalation: toPublicNotificationEscalation(claimed), notifications };
}

/**
 * Triggers PENDING escalations due at or before `before` (bounded retrieval:
 * the repository caps one pass at a small batch; leftovers stay PENDING for
 * the next pass). Best-effort: escalations whose template is no longer
 * ACTIVE are skipped (left PENDING), as are escalations whose claim is lost.
 */
export async function triggerDueEscalations(
  before: Date = new Date(),
): Promise<TriggerEscalationResult> {
  const due = await notificationEscalationRepository.findDue(before);

  let triggered = 0;
  let notificationsCreated = 0;
  for (const escalation of due) {
    const result = await triggerEscalation(escalation.id);
    if (result) {
      triggered += 1;
      notificationsCreated += result.notifications.length;
    }
  }

  return { triggered, notificationsCreated };
}

export const notificationEscalationService = {
  cancelEscalation,
  createEscalation,
  findDueEscalations,
  getEscalation,
  listEscalations,
  toPublicNotificationEscalation,
  triggerDueEscalations,
  triggerEscalation,
  updateEscalation,
};
