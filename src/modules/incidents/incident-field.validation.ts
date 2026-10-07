import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INCIDENT_PRIORITIES,
  INCIDENT_SEVERITIES,
  isIncidentPriority,
  isIncidentSeverity,
  type IncidentPriority,
  type IncidentSeverity,
} from './incident.types';

/**
 * Shared BE-21 request-field parsers.
 *
 * BE-21B, BE-21C, and BE-21D each grew their own private copies of these
 * helpers. They are identical by intent — every BE-21 endpoint must normalize
 * a UUID, an enum, or a timestamp the same way, or the API becomes subtly
 * inconsistent (one endpoint accepting a lowercase enum that another rejects).
 * BE-21E onward uses this single copy instead of adding another.
 *
 * These are deliberately pure field-level helpers: they accumulate problems
 * into a `ValidationDetail[]` rather than throwing, so a parser can report
 * every bad field in one response instead of only the first.
 *
 * The pre-existing per-module copies in BE-21B/C/D are left untouched here:
 * rewriting working, tested validators is a separate change from adding a new
 * PART, and doing both at once would make a regression impossible to attribute.
 */

export type ValidationDetail = { field: string; message: string };

/** ISO-8601 with an explicit timezone — a bare local time is ambiguous. */
export const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function failValidation(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/**
 * Rejects the first present field from `fields`, if any.
 *
 * Backend-derived and immutable fields are REFUSED rather than silently
 * ignored: dropping a caller's value would hide that their intent was not
 * honoured.
 */
export function rejectForbiddenFields(
  body: Record<string, unknown>,
  fields: readonly string[],
  message: (field: string) => string,
): void {
  const present = fields.find((field) => body[field] !== undefined);
  if (present) {
    failValidation([{ field: present, message: message(present) }]);
  }
}

export function readUuid(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

/** Nullable UUID: explicit null clears the reference, absent leaves it alone. */
export function readNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readUuid(value, field, false, details);
}

/** Enum values are normalized (trim + uppercase) before the guard runs. */
export function readEnum<T extends string>(
  value: unknown,
  field: string,
  guard: (candidate: unknown) => candidate is T,
  allowed: readonly string[],
  required: boolean,
  details: ValidationDetail[],
): T | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!guard(normalized)) {
    details.push({
      field,
      message: `${field} must be one of: ${allowed.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

export function readText(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field,
      message: `${field}${required ? ' is required' : ' must be a string'}.`,
    });
    return undefined;
  }
  const result = value.trim();
  if (result.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return result;
}

export function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readText(value, field, maxLength, false, details);
}

export function readTimestamp(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): Date | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be an ISO-8601 date-time with a timezone.`,
    });
    return undefined;
  }
  const result = new Date(value.trim());
  if (Number.isNaN(result.getTime())) {
    details.push({ field, message: `${field} must be valid.` });
    return undefined;
  }
  return result;
}

export function readIncidentSeverityField(
  value: unknown,
  details: ValidationDetail[],
): IncidentSeverity | undefined {
  return readEnum(
    value,
    'severity',
    isIncidentSeverity,
    INCIDENT_SEVERITIES,
    false,
    details,
  );
}

export function readIncidentPriorityField(
  value: unknown,
  details: ValidationDetail[],
): IncidentPriority | undefined {
  return readEnum(
    value,
    'priority',
    isIncidentPriority,
    INCIDENT_PRIORITIES,
    false,
    details,
  );
}
