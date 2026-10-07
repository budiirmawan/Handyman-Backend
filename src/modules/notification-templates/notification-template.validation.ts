import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  NOTIFICATION_TEMPLATE_CHANNELS,
  NOTIFICATION_TEMPLATE_STATUSES,
  TEMPLATE_VARIABLE_PATTERN,
  extractTemplateVariables,
  isNotificationTemplateChannel,
  isNotificationTemplateStatus,
  type CreateNotificationTemplateInput,
  type NotificationTemplateChannel,
  type NotificationTemplateStatus,
  type UpdateNotificationTemplateInput,
} from './notification-template.types';

/**
 * BE-26B — Notification template validation.
 *
 * HTTP-level parsing only (path params and bodies). The template `key` is
 * immutable after creation. Cross-field placeholder consistency (every
 * `{{variable}}` used must be declared in `variables`) is validated against
 * the merged content by the service for updates.
 */

type ValidationDetail = { field: string; message: string };

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 4000;
const MAX_VARIABLES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function code(value: unknown, field: string, required: boolean, details: ValidationDetail[]): string | undefined {
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

function channelOf(
  value: unknown,
  details: ValidationDetail[],
): NotificationTemplateChannel | undefined {
  if (!isNotificationTemplateChannel(value)) {
    details.push({
      field: 'channel',
      message: `channel must be one of: ${NOTIFICATION_TEMPLATE_CHANNELS.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function text(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (value === null && !required) {
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

function variablesOf(
  value: unknown,
  details: ValidationDetail[],
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_VARIABLES) {
    details.push({
      field: 'variables',
      message: `variables must be an array of at most ${MAX_VARIABLES} variable names.`,
    });
    return undefined;
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !TEMPLATE_VARIABLE_PATTERN.test(item)) {
      details.push({
        field: 'variables',
        message: 'variables must be names of letters, digits, and underscore.',
      });
      return undefined;
    }
    if (seen.has(item)) {
      details.push({
        field: 'variables',
        message: `variables must be unique (duplicate '${item}').`,
      });
      return undefined;
    }
    seen.add(item);
    names.push(item);
  }
  return names;
}

/**
 * Validates that every `{{variable}}` placeholder used in `subject` / `body`
 * is declared in `variables`. Keeps templates self-consistent so rendering
 * can never reference an undeclared variable.
 */
export function validateTemplateVariableConsistency(
  subject: string,
  body: string | null | undefined,
  variables: string[],
): void {
  const declared = new Set(variables);
  const used = new Set([
    ...extractTemplateVariables(subject),
    ...(body ? extractTemplateVariables(body) : []),
  ]);
  const undeclared = [...used].filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    fail(
      undeclared.map((name) => ({
        field: 'variables',
        message: `Template references undeclared variable '${name}'.`,
      })),
    );
  }
}

export function parseNotificationTemplateStatusFilter(
  raw: unknown,
): NotificationTemplateStatus | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (Array.isArray(raw)) {
    fail([{ field: 'status', message: 'status must be a single value.' }]);
  }
  if (!isNotificationTemplateStatus(raw)) {
    fail([
      {
        field: 'status',
        message: `status must be one of: ${NOTIFICATION_TEMPLATE_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return raw;
}

export function parseNotificationTemplateIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      {
        field: 'notificationTemplateId',
        message: 'notificationTemplateId must be a valid UUID.',
      },
    ]);
  }
  return value;
}

export function parseCreateNotificationTemplateBody(
  body: unknown,
): CreateNotificationTemplateInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const key = code(body.key, 'key', true, details);
  const type = code(body.type, 'type', true, details);
  const channel = channelOf(body.channel, details);
  const subject = text(body.subject, 'subject', MAX_SUBJECT_LENGTH, true, details);
  const bodyValue = text(body.body, 'body', MAX_BODY_LENGTH, false, details);
  const variables = variablesOf(body.variables, details);

  if (details.length > 0) {
    fail(details);
  }

  const resolvedVariables = variables ?? [];
  validateTemplateVariableConsistency(
    subject as string,
    bodyValue,
    resolvedVariables,
  );

  return {
    key: key as string,
    type: type as string,
    channel: channel as NotificationTemplateChannel,
    subject: subject as string,
    ...(bodyValue !== undefined ? { body: bodyValue } : {}),
    variables: resolvedVariables,
  };
}

export function parseUpdateNotificationTemplateBody(
  body: unknown,
): UpdateNotificationTemplateInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  // The template key is immutable after creation.
  if (body.key !== undefined) {
    fail([{ field: 'key', message: 'The template key is immutable.' }]);
  }

  const details: ValidationDetail[] = [];
  const type = code(body.type, 'type', false, details);
  const channel = body.channel === undefined ? undefined : channelOf(body.channel, details);
  const subject = body.subject === undefined ? undefined : text(body.subject, 'subject', MAX_SUBJECT_LENGTH, true, details);
  const bodyValue = body.body === undefined ? undefined : text(body.body, 'body', MAX_BODY_LENGTH, false, details);
  const variables = variablesOf(body.variables, details);
  const status = body.status === undefined ? undefined : statusOf(body.status, details);

  if (details.length > 0) {
    fail(details);
  }

  const result: UpdateNotificationTemplateInput = {};
  if (type !== undefined) result.type = type;
  if (channel !== undefined) result.channel = channel;
  if (typeof subject === 'string') result.subject = subject;
  if (bodyValue !== undefined) result.body = bodyValue;
  if (variables !== undefined) result.variables = variables;
  if (status !== undefined) result.status = status;

  if (Object.keys(result).length === 0) {
    fail([
      { field: 'body', message: 'At least one template field is required.' },
    ]);
  }

  return result;
}

function statusOf(
  value: unknown,
  details: ValidationDetail[],
): NotificationTemplateStatus | undefined {
  if (!isNotificationTemplateStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${NOTIFICATION_TEMPLATE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
