import { AppError } from '../../shared/errors';
import {
  ASSET_FAILURE_CATEGORIES,
  isAssetFailureCategory,
  type AssetFailureCategory,
} from '../asset-failures';
import {
  MOBILE_UNSAFE_CONDITION_BODY_FIELDS,
  MOBILE_UNSAFE_CONDITION_DERIVED_FIELDS,
  type MobileUnsafeConditionInput,
} from './mobile-unsafe-condition.types';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — strict DTO for the mobile unsafe
 * condition report.
 *
 * STRICT BY CONSTRUCTION. This is an ALLOWLIST, not a denylist: any key that
 * is not one of the four accepted narrative/observation fields is rejected,
 * so the contract is `additionalProperties: false` by behaviour rather than by
 * documentation alone. The well-known authority keys additionally get a
 * specific message (see MOBILE_UNSAFE_CONDITION_DERIVED_FIELDS) so a client
 * that tries to assert Client / Building / Asset / impact / status / reporter
 * is told exactly why it cannot.
 *
 * `severity` and `priority` are refused here for a governance reason, not a
 * formatting one: triage is management authority on the existing BE-21C update
 * path, and accepting them from a field report is the first step towards
 * inferring CRITICAL from field input — which RN-10 forbids.
 */

export type ValidationDetail = { field: string; message: string };

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    details.push({ field, message: `${field} must not be empty.` });
    return undefined;
  }
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

/**
 * Mirrors BE-21C's own timestamp contract. Absence is NOT defaulted here: the
 * service supplies the server report time, so an omitted `occurredAt` means
 * "this was observed now" rather than silently resolving to null.
 */
function readTimestamp(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({
      field,
      message: `${field} must be an ISO-8601 date-time with a timezone.`,
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

function readCategory(
  value: unknown,
  details: ValidationDetail[],
): AssetFailureCategory | undefined {
  if (value === undefined) return undefined;
  if (!isAssetFailureCategory(value)) {
    details.push({
      field: 'failureCategory',
      message: `failureCategory must be one of: ${ASSET_FAILURE_CATEGORIES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

/**
 * Parses the report body.
 *
 * `title` is the required human narrative/reason: an unsafe-condition report
 * with no statement of what was observed is not a report. It reuses BE-21C's
 * existing field name and its 200-character bound rather than inventing an
 * alias.
 */
export function parseMobileUnsafeConditionBody(
  body: unknown,
): MobileUnsafeConditionInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const allowed = new Set<string>(MOBILE_UNSAFE_CONDITION_BODY_FIELDS);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    const derived = MOBILE_UNSAFE_CONDITION_DERIVED_FIELDS[key];
    rejected.push({
      field: key,
      message: derived ?? `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);

  const details: ValidationDetail[] = [];
  if (body.title === undefined) {
    details.push({ field: 'title', message: 'title is required.' });
  }
  const title =
    body.title === undefined
      ? undefined
      : readText(body.title, 'title', MAX_TITLE_LENGTH, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const failureCategory = readCategory(body.failureCategory, details);
  const occurredAt = readTimestamp(body.occurredAt, 'occurredAt', details);

  if (!title || details.length > 0) fail(details);

  return {
    title: title as string,
    ...(description === undefined ? {} : { description }),
    ...(failureCategory === undefined ? {} : { failureCategory }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}
