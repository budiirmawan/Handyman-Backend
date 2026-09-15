import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parseRecipientRule, type RecipientRule } from '../recipient-resolution';
import {
  NOTIFICATION_ESCALATION_STATUSES,
  isNotificationEscalationStatus,
  type CreateNotificationEscalationInput,
  type NotificationEscalationStatus,
  type UpdateNotificationEscalationInput,
} from './notification-escalation.types';

/**
 * BE-26I — Notification escalation validation.
 *
 * HTTP-level parsing only. The escalation `key` is immutable after creation.
 * The escalation recipient rule is validated by BE-26C's single authority
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
  return uuid(value, field, details);
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

function text(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push({ field, message: `${field} must be a non-empty string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
    return undefined;
  }
  return trimmed;
}

function escalationRuleOf(
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
          field: `escalationRule.${detail.field}`.replace(
            /^escalationRule\.escalationRule\./,
            'escalationRule.',
          ),
          message: detail.message,
        });
      }
      return undefined;
    }
    throw error;
  }
}

export function parseEscalationStatusFilter(
  raw: unknown,
): NotificationEscalationStatus | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (Array.isArray(raw)) {
    fail([{ field: 'status', message: 'status must be a single value.' }]);
  }
  if (!isNotificationEscalationStatus(raw)) {
    fail([
      {
        field: 'status',
        message: `status must be one of: ${NOTIFICATION_ESCALATION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

export function parseEscalationIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      {
        field: 'notificationEscalationId',
        message: 'notificationEscalationId must be a valid UUID.',
      },
    ]);
  }
  return value;
}

export function parseCreateEscalationBody(
  body: unknown,
): CreateNotificationEscalationInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const key = code(body.key, 'key', true, details);
  const clientId = uuid(body.clientId, 'clientId', details);
  const sourceEntityType = code(body.sourceEntityType, 'sourceEntityType', true, details);
  const sourceEntityId = uuid(body.sourceEntityId, 'sourceEntityId', details);
  const currentRecipientUserId = uuidOrNull(body.currentRecipientUserId, 'currentRecipientUserId', details);
  const escalationRule = escalationRuleOf(body.escalationRule, details);
  const templateKey = code(body.templateKey, 'templateKey', true, details);
  const escalationAt = timestamp(body.escalationAt, 'escalationAt', true, details);
  const reason = text(body.reason, 'reason', 2000, details);

  if (details.length > 0) {
    fail(details);
  }

  return {
    key: key as string,
    clientId: clientId as string,
    sourceEntityType: sourceEntityType as string,
    sourceEntityId: sourceEntityId as string,
    ...(currentRecipientUserId !== undefined ? { currentRecipientUserId } : {}),
    escalationRule: escalationRule as RecipientRule,
    templateKey: templateKey as string,
    escalationAt: escalationAt as string,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function parseUpdateEscalationBody(
  body: unknown,
): UpdateNotificationEscalationInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  // The escalation key is immutable after creation.
  if (body.key !== undefined) {
    fail([{ field: 'key', message: 'The escalation key is immutable.' }]);
  }

  const details: ValidationDetail[] = [];
  const escalationAt = timestamp(body.escalationAt, 'escalationAt', false, details);
  const currentRecipientUserId = uuidOrNull(body.currentRecipientUserId, 'currentRecipientUserId', details);
  const escalationRule = escalationRuleOf(body.escalationRule, details);
  const templateKey = code(body.templateKey, 'templateKey', false, details);
  const reason = text(body.reason, 'reason', 2000, details);

  if (details.length > 0) {
    fail(details);
  }

  const result: UpdateNotificationEscalationInput = {};
  if (escalationAt !== undefined) result.escalationAt = escalationAt;
  if (currentRecipientUserId !== undefined) result.currentRecipientUserId = currentRecipientUserId;
  if (escalationRule !== undefined) result.escalationRule = escalationRule;
  if (templateKey !== undefined) result.templateKey = templateKey;
  if (reason !== undefined) result.reason = reason;

  if (Object.keys(result).length === 0) {
    fail([{ field: 'body', message: 'At least one escalation field is required.' }]);
  }

  return result;
}
