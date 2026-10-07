import { AppError } from '../../shared/errors';
import {
  USER_STATUSES,
  isUserStatus,
  isUserWhatsAppConsentAction,
  type CreateUserInput,
  type UpdateUserWhatsAppContactInput,
  type UserStatus,
} from './user.types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function isValidEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value);
}

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Parses and validates the JSON body for `POST /users`.
 * Throws a 400 VALIDATION_ERROR when any field is invalid.
 */
export function parseCreateUserBody(body: unknown): CreateUserInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const source = body as Record<string, unknown>;

  const email = readEmail(source.email, details);
  const displayName = readDisplayName(source.displayName, details);
  const status = readStatus(source.status, details);

  if (!email || !displayName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    email,
    displayName,
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * Parses a user id path parameter. Throws a 400 VALIDATION_ERROR when the
 * value is not a well-formed UUID.
 */
export function parseUserIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'User id must be a valid UUID.' },
    ]);
  }

  return value.toLowerCase();
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — parses the JSON body for
 * `PATCH /users/:id/whatsapp-contact`. Both fields are optional (omitted =
 * keep); `whatsappPhone: null` is the explicit clear. E.164/consent business
 * rules are enforced by the service seam.
 */
export function parseUpdateUserWhatsAppContactBody(
  body: unknown,
): UpdateUserWhatsAppContactInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const source = body as Record<string, unknown>;
  const details: ValidationDetail[] = [];
  const result: UpdateUserWhatsAppContactInput = {};

  if (source.whatsappPhone !== undefined) {
    if (source.whatsappPhone === null) {
      result.whatsappPhone = null;
    } else if (typeof source.whatsappPhone === 'string') {
      result.whatsappPhone = source.whatsappPhone;
    } else {
      details.push({
        field: 'whatsappPhone',
        message: 'whatsappPhone must be a string or null.',
      });
    }
  }

  if (source.consent !== undefined) {
    if (isUserWhatsAppConsentAction(source.consent)) {
      result.consent = source.consent;
    } else {
      details.push({
        field: 'consent',
        message: 'consent must be one of: OPT_IN, OPT_OUT.',
      });
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return result;
}

function readEmail(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'email', message: 'Email is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'email', message: 'Email is required.' });
    return undefined;
  }

  if (!isValidEmail(trimmed)) {
    details.push({
      field: 'email',
      message: 'Email must be a valid email address.',
    });
    return undefined;
  }

  return trimmed;
}

function readDisplayName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'displayName', message: 'Display name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'displayName', message: 'Display name is required.' });
    return undefined;
  }

  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): UserStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isUserStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${USER_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
