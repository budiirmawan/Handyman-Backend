import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { EvaluateHandymanArrivalInput }
  from '../handyman-arrival-results';

/**
 * CR-HM-07 PART 04C — terminal arrival-verification HTTP input
 * validation. Whitelist parsers ONLY: callers may submit exactly
 * `{ challengeToken, qrOpaqueCode, deviceLocation? }`; executionScopeId
 * comes from the URL. EVERYTHING else — actorUserId/workerId/crewId/
 * assignmentId/expected-location/policyId/distance/geofence/status/
 * primaryReason/clientId/enrichment fields — is structurally ignored
 * (never spread, never forwarded into the PART 04B evaluator).
 */

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function fail(
  message: string,
  details: { field: string; message: string }[],
): never {
  throw AppError.validation(message, details);
}

function uuid(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isValidUuid(raw)) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return raw;
}

export function parseArrivalScopeParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'executionScopeId');
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('Request validation failed.', [
      { field, message: `${field} is required as a non-empty string.` },
    ]);
  }
  if (value.length > maxLength) {
    fail('Request validation failed.', [
      { field, message: `${field} must be at most ${maxLength} characters.` },
    ]);
  }
  return value;
}

function finiteNumber(
  value: unknown,
  field: string,
): number {
  const num = Number(value);
  if (value === null || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
    || !Number.isFinite(num)) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a finite number.` },
    ]);
  }
  return num;
}

/** `capturedAt`: parseable timestamp type check ONLY (bounds are
 *  PART 03B evaluator territory). */
function isoTimestamp(value: unknown, field: string): string {
  const raw = requiredString(value, field, 64);
  if (!Number.isFinite(Date.parse(raw))) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a valid ISO timestamp.` },
    ]);
  }
  return raw;
}

/**
 * Bounded body parse: exactly the PART 04B caller input minus scope id.
 */
export function parseArrivalVerificationBody(
  body: unknown,
): Omit<EvaluateHandymanArrivalInput, 'executionScopeId'> {
  const obj = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};
  const challengeToken = requiredString(obj.challengeToken,
    'challengeToken', 1024);
  const qrOpaqueCode = requiredString(obj.qrOpaqueCode, 'qrOpaqueCode',
    1024);
  const rawDevice = obj.deviceLocation;
  let deviceLocation: EvaluateHandymanArrivalInput['deviceLocation'] = null;
  if (rawDevice !== undefined && rawDevice !== null) {
    if (typeof rawDevice !== 'object' || Array.isArray(rawDevice)) {
      fail('Request validation failed.', [
        { field: 'deviceLocation',
          message: 'deviceLocation must be an object or null.' },
      ]);
    }
    const d = rawDevice as Record<string, unknown>;
    deviceLocation = {
      latitude: finiteNumber(d.latitude, 'deviceLocation.latitude'),
      longitude: finiteNumber(d.longitude, 'deviceLocation.longitude'),
      accuracyMeters: finiteNumber(d.accuracyMeters,
        'deviceLocation.accuracyMeters'),
      capturedAt: isoTimestamp(d.capturedAt, 'deviceLocation.capturedAt'),
    };
  }
  return { challengeToken, qrOpaqueCode, deviceLocation };
}
