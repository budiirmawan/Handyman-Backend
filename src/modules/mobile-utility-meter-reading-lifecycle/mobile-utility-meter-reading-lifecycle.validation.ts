import { AppError } from '../../shared/errors';
import {
  parseRequiredLifecycleNotes,
  parseUtilityExceptionId,
} from '../utility-operational-exceptions/utility-operational-exception.validation';
import {
  MOBILE_READING_RECHECK_BODY_FIELDS,
  MOBILE_READING_RECHECK_DECISIONS,
  MOBILE_READING_RECHECK_DERIVED_FIELDS,
  MOBILE_READING_RECHECK_RESOLVE_BODY_FIELDS,
  MOBILE_READING_RECHECK_RESOLVE_DERIVED_FIELDS,
  type MobileReadingRecheckRequestInput,
  type MobileReadingRecheckResolveInput,
} from './mobile-utility-meter-reading-lifecycle.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — field recheck validation.
 *
 * Strict by construction, on the PART 01 / PART 02 pattern: every body is an
 * allowlist that behaves as `additionalProperties: false`, and an AUTHORITY key
 * is refused with the specific reason it is server-derived rather than silently
 * dropped. Silence would leave a field client believing it had chosen the
 * recheck's severity, its target reading, its status, or the replacement reading
 * an acceptance produced.
 *
 * SINGLE-SOURCED RULES
 * --------------------
 * The `recheckId` path parameter is parsed by the register's own
 * `parseUtilityExceptionId`, and the resolve command's `resolutionNotes` by the
 * register's own `parseRequiredLifecycleNotes` — so the UUID rule, the
 * lowercase normalization, the 2000-character bound and the VALIDATION_ERROR
 * envelope are the exception register's, not copies. The reread body is parsed
 * by PART 01's `parseMobileUtilityMeterReadingBody` in the controller, because a
 * reread states exactly the same measurement facts as the online field submit
 * and must be validated by exactly the same rule.
 */

type ValidationDetail = { field: string; message: string };

/** The register's own bound for its free-text note columns. */
const MAX_REASON_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function rejectForeignKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  derived: Readonly<Record<string, string>>,
): void {
  const allow = new Set<string>(allowed);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allow.has(key)) continue;
    rejected.push({
      field: key,
      message: derived[key] ?? `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);
}

/** `recheckId` path parameter — the register's own id validator. */
export function parseMobileReadingRecheckIdParam(raw: string): string {
  return parseUtilityExceptionId(raw, 'recheckId');
}

/**
 * Body of the recheck REQUEST: an optional reason, and nothing else.
 *
 * The type, severity, summary, target reading, requester and every lifecycle
 * stamp are server-derived. An empty body is a valid request — a technician who
 * cannot explain a suspect value in the moment still gets the recheck filed.
 */
export function parseMobileReadingRecheckRequestBody(
  body: unknown,
): MobileReadingRecheckRequestInput {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  rejectForeignKeys(
    body,
    MOBILE_READING_RECHECK_BODY_FIELDS,
    MOBILE_READING_RECHECK_DERIVED_FIELDS,
  );

  if (body.reason === undefined || body.reason === null) {
    return {};
  }
  if (typeof body.reason !== 'string') {
    fail([{ field: 'reason', message: 'Reason must be a string.' }]);
  }
  const trimmed = body.reason.trim();
  if (trimmed.length > MAX_REASON_LENGTH) {
    fail([
      {
        field: 'reason',
        message: `Reason must be at most ${MAX_REASON_LENGTH} characters.`,
      },
    ]);
  }
  return trimmed.length > 0 ? { reason: trimmed } : {};
}

/**
 * Body of the RESOLVE command: one of the two decisions, plus the register's own
 * required resolution notes.
 *
 * `decision` is validated against the closed pair — a decision is a human choice
 * between the two outcomes this command has, never a status value, and an
 * unknown token is refused rather than defaulted.
 */
export function parseMobileReadingRecheckResolveBody(
  body: unknown,
): MobileReadingRecheckResolveInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  rejectForeignKeys(
    body,
    MOBILE_READING_RECHECK_RESOLVE_BODY_FIELDS,
    MOBILE_READING_RECHECK_RESOLVE_DERIVED_FIELDS,
  );

  const details: ValidationDetail[] = [];
  const decision = body.decision;
  if (
    typeof decision !== 'string' ||
    !(MOBILE_READING_RECHECK_DECISIONS as readonly string[]).includes(decision)
  ) {
    details.push({
      field: 'decision',
      message: `decision must be one of: ${MOBILE_READING_RECHECK_DECISIONS.join(', ')}.`,
    });
  }
  if (details.length > 0) fail(details);

  // The register's own required-notes rule (non-empty, trimmed, ≤ 2000).
  const resolutionNotes = parseRequiredLifecycleNotes(body, 'resolutionNotes');

  return {
    decision: decision as MobileReadingRecheckResolveInput['decision'],
    resolutionNotes,
  };
}
