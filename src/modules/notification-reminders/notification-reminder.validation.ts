import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parseRecipientRule, type RecipientRule } from '../recipient-resolution';
import {
  NOTIFICATION_REMINDER_STATUSES,
  isNotificationReminderStatus,
  type CreateNotificationReminderInput,
  type NotificationReminderStatus,
  type UpdateNotificationReminderInput,
} from './notification-reminder.types';

/**
 * BE-26H — Notification reminder validation.
 *
 * HTTP-level parsing only. The reminder `key` is immutable after creation.
 * The recipient rule shape is validated by BE-26C's single authority
 * (`parseRecipientRule`).
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

function uuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim().toLowerCase())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function timestamp(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: `${field} must be a valid ISO timestamp.` });
    return undefined;
  }
  return new Date(value).toISOString();
}

function variablesOf(
  value: unknown,
  details: ValidationDetail[],
): Record<string, string | number> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    details.push({ field: 'variables', message: 'variables must be an object.' });
    return undefined;
  }
  const normalized: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      details.push({
        field: 'variables',
        message: `variables.${key} must be a string or number.`,
      });
      continue;
    }
    normalized[key] = entry;
  }
  return details.some((d) => d.field === 'variables')
    ? undefined
    : normalized;
}

function recipientRuleOf(
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
          field: `recipientRule.${detail.field}`.replace(
            /^recipientRule\.recipientRule\./,
            'recipientRule.',
          ),
          message: detail.message,
        });
      }
      return undefined;
    }
    throw error;
  }
}

export function parseReminderStatusFilter(
  raw: unknown,
): NotificationReminderStatus | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (Array.isArray(raw)) {
    fail([{ field: 'status', message: 'status must be a single value.' }]);
  }
  if (!isNotificationReminderStatus(raw)) {
    fail([
      {
        field: 'status',
        message: `status must be one of: ${NOTIFICATION_REMINDER_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

export function parseReminderIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      {
        field: 'notificationReminderId',
        message: 'notificationReminderId must be a valid UUID.',
      },
    ]);
  }
  return value;
}

export function parseCreateReminderBody(
  body: unknown,
): CreateNotificationReminderInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const key = code(body.key, 'key', true, details);
  const clientId = uuid(body.clientId, 'clientId', details);
  const sourceEntityType = code(body.sourceEntityType, 'sourceEntityType', true, details);
  const sourceEntityId = uuid(body.sourceEntityId, 'sourceEntityId', details);
  const recipientRule = recipientRuleOf(body.recipientRule, details);
  const templateKey = code(body.templateKey, 'templateKey', true, details);
  const reminderAt = timestamp(body.reminderAt, 'reminderAt', true, details);
  const variables = variablesOf(body.variables, details);

  if (details.length > 0) {
    fail(details);
  }

  return {
    key: key as string,
    clientId: clientId as string,
    sourceEntityType: sourceEntityType as string,
    sourceEntityId: sourceEntityId as string,
    recipientRule: recipientRule as RecipientRule,
    templateKey: templateKey as string,
    reminderAt: reminderAt as string,
    ...(variables !== undefined ? { variables } : {}),
  };
}

export function parseUpdateReminderBody(
  body: unknown,
): UpdateNotificationReminderInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  // The reminder key is immutable after creation.
  if (body.key !== undefined) {
    fail([{ field: 'key', message: 'The reminder key is immutable.' }]);
  }

  const details: ValidationDetail[] = [];
  const reminderAt = timestamp(body.reminderAt, 'reminderAt', false, details);
  const templateKey = code(body.templateKey, 'templateKey', false, details);
  const recipientRule = recipientRuleOf(body.recipientRule, details);
  const variables = variablesOf(body.variables, details);

  if (details.length > 0) {
    fail(details);
  }

  const result: UpdateNotificationReminderInput = {};
  if (reminderAt !== undefined) result.reminderAt = reminderAt;
  if (templateKey !== undefined) result.templateKey = templateKey;
  if (recipientRule !== undefined) result.recipientRule = recipientRule;
  if (variables !== undefined) result.variables = variables;

  if (Object.keys(result).length === 0) {
    fail([{ field: 'body', message: 'At least one reminder field is required.' }]);
  }

  return result;
}
