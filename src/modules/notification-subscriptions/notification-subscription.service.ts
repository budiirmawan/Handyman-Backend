import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { notificationTemplateRepository } from '../notification-templates';
import { notificationSubscriptionRepository } from './notification-subscription.repository';
import {
  notificationSubscriptionKeyAlreadyExistsError,
  notificationSubscriptionNotFoundError,
  notificationSubscriptionTemplateMissingError,
} from './notification-subscription.errors';
import type {
  CreateNotificationEventSubscriptionInput,
  NotificationEventSubscriptionRecord,
  PublicNotificationEventSubscription,
  SubscriptionMatchContext,
  UpdateNotificationEventSubscriptionInput,
} from './notification-subscription.types';

/**
 * BE-26D — Notification event subscription service.
 *
 * Maps existing backend domain events to notification triggers, declaratively:
 *   - CRUD for subscription records (event → template + recipient rule),
 *   - `findMatchingSubscriptions` — the mapping seam: given an occurred
 *     event type + Client/Building context, returns the ACTIVE subscriptions
 *     to apply (no delivery, no rendering, no recipient resolution here).
 *
 * Business domains stay the source of truth; no workflow logic is duplicated
 * and no new domain events are created.
 */

export function toPublicNotificationEventSubscription(
  record: NotificationEventSubscriptionRecord,
): PublicNotificationEventSubscription {
  return {
    id: record.id,
    key: record.key,
    eventType: record.eventType,
    templateKey: record.templateKey,
    recipientRule: record.recipientRule,
    clientId: record.clientId,
    buildingId: record.buildingId,
    status: record.status,
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

/** Resolves a Building's owning Client (via Building → Property → Client). */
async function resolveBuildingClient(buildingId: string): Promise<string | null> {
  const result = await getPool().query<{ clientId: string }>(
    `SELECT p.client_id AS "clientId"
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [buildingId],
  );
  return result.rows[0]?.clientId ?? null;
}

/**
 * Guards Client/Building context consistency: when both are supplied, the
 * Building must resolve to that Client. Preserves the isolation rule that a
 * Building's scope is derived authoritatively, never client-asserted.
 */
async function assertContextConsistency(
  clientId: string | null | undefined,
  buildingId: string | null | undefined,
): Promise<void> {
  if (!buildingId) {
    return;
  }
  if (clientId) {
    const buildingClient = await resolveBuildingClient(buildingId);
    if (buildingClient !== clientId) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'buildingId',
          message: 'Building does not belong to the given Client.',
        },
      ]);
    }
  }
}

/** Validates that the referenced BE-26B template exists. */
async function assertTemplateExists(templateKey: string): Promise<void> {
  const template = await notificationTemplateRepository.findByKey(templateKey);
  if (!template) {
    throw notificationSubscriptionTemplateMissingError();
  }
}

export async function createNotificationEventSubscription(
  input: CreateNotificationEventSubscriptionInput,
): Promise<PublicNotificationEventSubscription> {
  await assertTemplateExists(input.templateKey);
  await assertContextConsistency(input.clientId, input.buildingId);

  try {
    const record = await notificationSubscriptionRepository.create(input);
    return toPublicNotificationEventSubscription(record);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw notificationSubscriptionKeyAlreadyExistsError();
    }
    throw error;
  }
}

export async function listNotificationEventSubscriptions(
  status?: NotificationEventSubscriptionRecord['status'],
): Promise<PublicNotificationEventSubscription[]> {
  const rows = await notificationSubscriptionRepository.list(status);
  return rows.map(toPublicNotificationEventSubscription);
}

export async function getNotificationEventSubscription(
  id: string,
): Promise<PublicNotificationEventSubscription> {
  const record = await notificationSubscriptionRepository.findById(id);
  if (!record) {
    throw notificationSubscriptionNotFoundError(id);
  }
  return toPublicNotificationEventSubscription(record);
}

export async function updateNotificationEventSubscription(
  id: string,
  input: UpdateNotificationEventSubscriptionInput,
): Promise<PublicNotificationEventSubscription> {
  const existing = await notificationSubscriptionRepository.findById(id);
  if (!existing) {
    throw notificationSubscriptionNotFoundError(id);
  }

  const mergedTemplateKey = input.templateKey ?? existing.templateKey;
  const mergedClientId = input.clientId !== undefined ? input.clientId : existing.clientId;
  const mergedBuildingId =
    input.buildingId !== undefined ? input.buildingId : existing.buildingId;

  await assertTemplateExists(mergedTemplateKey);
  await assertContextConsistency(mergedClientId, mergedBuildingId);

  const record = await notificationSubscriptionRepository.update(id, input);
  if (!record) {
    throw notificationSubscriptionNotFoundError(id);
  }
  return toPublicNotificationEventSubscription(record);
}

/**
 * Maps an occurred domain event to the ACTIVE subscriptions that apply,
 * given the event's Client/Building context. The seam BE-26E uses to decide
 * which triggers fire — no delivery or rendering happens here.
 */
export async function findMatchingSubscriptions(
  eventType: string,
  context: SubscriptionMatchContext = {},
): Promise<PublicNotificationEventSubscription[]> {
  const rows = await notificationSubscriptionRepository.findMatching(
    eventType,
    context.clientId,
    context.buildingId,
  );
  return rows.map(toPublicNotificationEventSubscription);
}

export const notificationSubscriptionService = {
  createNotificationEventSubscription,
  findMatchingSubscriptions,
  getNotificationEventSubscription,
  listNotificationEventSubscriptions,
  toPublicNotificationEventSubscription,
  updateNotificationEventSubscription,
};
