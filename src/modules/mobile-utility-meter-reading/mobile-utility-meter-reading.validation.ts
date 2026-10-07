import { AppError } from '../../shared/errors';
import { parseUtilityMeterReadingIdParam } from '../utility-meter-readings';
import { parseReadingDueId } from '../utility-reading-dues';
import {
  MOBILE_UTILITY_METER_READING_BODY_FIELDS,
  MOBILE_UTILITY_METER_READING_DERIVED_FIELDS,
  type MobileUtilityMeterReadingInput,
} from './mobile-utility-meter-reading.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 01 — mobile field meter-reading validation.
 *
 * Strict by construction. The body is an allowlist of three fields and behaves
 * as `additionalProperties: false`: an unrecognised key is a 400, and an
 * authority key is refused with the specific reason it is server-derived rather
 * than being silently dropped. A client must never be able to discover by trial
 * that supplying `meterId`, `uomId`, `source` or `previousReadingId` was quietly
 * ignored — silence would leave it believing it had steered the reading.
 *
 * The `readingDueId` / `readingId` path parameters are parsed by the EXISTING
 * BE-18 validators rather than copies, so the UUID rule, lowercase
 * normalization and `VALIDATION_ERROR` envelope stay single-sourced.
 *
 * Numeric and note bounds reproduce canonical BE-18E exactly (`reading_value >=
 * 0` at the database level, notes ≤ 1024). Decimal precision is NOT checked
 * here: it is governed by BE-18B configuration and asserted inside
 * `recordUtilityMeterReading`, which is the single place that knows the meter's
 * utility type. Re-implementing it here would create a second, divergent rule.
 */

/** BE-18E bound, reproduced rather than re-derived. */
const MAX_NOTES_LENGTH = 1024;

type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/** `readingDueId` path parameter — the field execution identity. */
export function parseMobileReadingDueIdParam(raw: string): string {
  return parseReadingDueId(raw, 'readingDueId');
}

/** `readingId` path parameter, scoped under a Reading Due. */
export function parseMobileReadingIdParam(raw: string): string {
  return parseUtilityMeterReadingIdParam(raw);
}

/**
 * Strict field submit body: `{ readingValue, readingAt, notes? }`.
 *
 * `readingAt` is required and must be a real instant. It is a caller-provided
 * DOMAIN FACT, not a convenience: `completeUtilityReadingDue` only links a
 * reading whose `readingAt` falls between the due's `periodStart` and
 * `periodEnd`, so a server-derived `NOW()` would make every OVERDUE due
 * impossible to complete. The field client therefore states when the meter was
 * physically read, and the server derives everything else.
 */
export function parseMobileUtilityMeterReadingBody(
  body: unknown,
): MobileUtilityMeterReadingInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const allowed = new Set<string>(MOBILE_UTILITY_METER_READING_BODY_FIELDS);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    rejected.push({
      field: key,
      message:
        MOBILE_UTILITY_METER_READING_DERIVED_FIELDS[key] ??
        `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);

  const details: ValidationDetail[] = [];

  let readingValue: number | undefined;
  if (
    typeof body.readingValue !== 'number' ||
    !Number.isFinite(body.readingValue) ||
    body.readingValue < 0
  ) {
    details.push({
      field: 'readingValue',
      message: 'readingValue must be a finite number greater than or equal to 0.',
    });
  } else {
    readingValue = body.readingValue;
  }

  let readingAt: Date | undefined;
  if (typeof body.readingAt !== 'string' || body.readingAt.trim() === '') {
    details.push({
      field: 'readingAt',
      message: 'readingAt is required and must be an ISO 8601 timestamp.',
    });
  } else {
    const parsed = new Date(body.readingAt.trim());
    if (Number.isNaN(parsed.getTime())) {
      details.push({
        field: 'readingAt',
        message: 'readingAt must be a valid ISO 8601 timestamp.',
      });
    } else {
      readingAt = parsed;
    }
  }

  let notes: string | undefined;
  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string') {
      details.push({ field: 'notes', message: 'Notes must be a string.' });
    } else {
      const trimmed = body.notes.trim();
      if (trimmed.length > MAX_NOTES_LENGTH) {
        details.push({
          field: 'notes',
          message: `Notes must be at most ${MAX_NOTES_LENGTH} characters.`,
        });
      } else if (trimmed.length > 0) {
        notes = trimmed;
      }
    }
  }

  if (details.length > 0 || readingValue === undefined || readingAt === undefined) {
    fail(details.length > 0 ? details : [
      { field: 'body', message: 'readingValue and readingAt are required.' },
    ]);
  }

  return { readingValue, readingAt, ...(notes === undefined ? {} : { notes }) };
}

/**
 * Optional `limit` for the bounded mobile history.
 *
 * Delegates to the EXISTING canonical BE-18E list bound rather than inventing a
 * mobile-specific one, so the field surface and the management surface cannot
 * drift apart on how much history a single call may return.
 */
export function parseMobileReadingLimitQuery(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') {
    fail([{ field: 'limit', message: 'limit must be an integer.' }]);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    fail([
      { field: 'limit', message: 'limit must be an integer between 1 and 500.' },
    ]);
  }
  return parsed;
}
