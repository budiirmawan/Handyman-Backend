import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parseRecipientRule, type RecipientRule } from '../recipient-resolution';
import {
  NOTIFICATION_SUBSCRIPTION_STATUSES,
  isNotificationSubscriptionStatus,
  type CreateNotificationEventSubscriptionInput,
  type NotificationSubscriptionStatus,
  type UpdateNotificationEventSubscriptionInput,
} from './notification-subscription.types';

/**
 * BE-26D — Notification event subscription validation.
 *
 * HTTP-level parsing only. The subscription `key` is immutable after
 * creation. The recipient rule shape is validated by BE-26C's single
 * authority (`parseRecipientRule`).
 */

type ValidationDetail = { field: string; message: string };

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function code(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || !CODE_PATTERN.test(value.trim().toUpperCase())) {
    details.push({
      field,
      message: `${field} must be an uppercase code (letters, digits, underscore).`,
    });
    return undefined;
  }
  return value.trim().toUpperCase();
}

function uuidOrNull(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim().toLowerCase())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function statusOf(
  value: unknown,
  details: ValidationDetail[],
): NotificationSubscriptionStatus | undefined {
  if (!isNotificationSubscriptionStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${NOTIFICATION_SUBSCRIPTION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

export function parseSubscriptionStatusFilter(
  raw: unknown,
): NotificationSubscriptionStatus | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (Array.isArray(raw)) {
    fail([{ field: 'status', message: 'status must be a single value.' }]);
  }
  if (!isNotificationSubscriptionStatus(raw)) {
    fail([
      {
        field: 'status',
        message: `status must be one of: ${NOTIFICATION_SUBSCRIPTION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

export function parseSubscriptionIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      {
        field: 'notificationSubscriptionId',
        message: 'notificationSubscriptionId must be a valid UUID.',
      },
    ]);
  }
  return value;
}

export function parseCreateSubscriptionBody(
  body: unknown,
): CreateNotificationEventSubscriptionInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const key = code(body.key, 'key', true, details);
  const eventType = code(body.eventType, 'eventType', true, details);
  const templateKey = code(body.templateKey, 'templateKey', true, details);
  const recipientRule = parseRecipientRuleValue(body.recipientRule, details);
  const clientId = uuidOrNull(body.clientId, 'clientId', details);
  const buildingId = uuidOrNull(body.buildingId, 'buildingId', details);
  const status = body.status === undefined ? undefined : statusOf(body.status, details);

  if (details.length > 0) {
    fail(details);
  }

  return {
    key: key as string,
    eventType: eventType as string,
    templateKey: templateKey as string,
    recipientRule: recipientRule as RecipientRule,
    ...(clientId !== undefined ? { clientId } : {}),
    ...(buildingId !== undefined ? { buildingId } : {}),
    ...(status ? { status } : {}),
  };
}

export function parseUpdateSubscriptionBody(
  body: unknown,
): UpdateNotificationEventSubscriptionInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  // The subscription key is immutable after creation.
  if (body.key !== undefined) {
    fail([{ field: 'key', message: 'The subscription key is immutable.' }]);
  }

  const details: ValidationDetail[] = [];
  const eventType = code(body.eventType, 'eventType', false, details);
  const templateKey = code(body.templateKey, 'templateKey', false, details);
  const recipientRule = body.recipientRule === undefined
    ? undefined
    : parseRecipientRuleValue(body.recipientRule, details);
  const clientId = uuidOrNull(body.clientId, 'clientId', details);
  const buildingId = uuidOrNull(body.buildingId, 'buildingId', details);
  const status = body.status === undefined ? undefined : statusOf(body.status, details);

  if (details.length > 0) {
    fail(details);
  }

  const result: UpdateNotificationEventSubscriptionInput = {};
  if (eventType !== undefined) result.eventType = eventType;
  if (templateKey !== undefined) result.templateKey = templateKey;
  if (recipientRule !== undefined) result.recipientRule = recipientRule;
  if (clientId !== undefined) result.clientId = clientId;
  if (buildingId !== undefined) result.buildingId = buildingId;
  if (status !== undefined) result.status = status;

  if (Object.keys(result).length === 0) {
    fail([{ field: 'body', message: 'At least one subscription field is required.' }]);
  }

  return result;
}

function parseRecipientRuleValue(
  value: unknown,
  details: ValidationDetail[],
): RecipientRule | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parseRecipientRule(value);
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === 'VALIDATION_ERROR' &&
      Array.isArray(error.details)
    ) {
      for (const detail of error.details as ValidationDetail[]) {
        details.push({
          field: `recipientRule.${detail.field}`.replace(/^recipientRule\.recipientRule\./, 'recipientRule.'),
          message: detail.message,
        });
      }
      return undefined;
    }
    throw error;
  }
}
