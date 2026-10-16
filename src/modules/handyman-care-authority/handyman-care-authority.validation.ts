import { AppError, ERROR_CODES } from '../../shared/errors';
import { careIdentityNotAcceptedError } from './handyman-care-authority.errors';
import { isValidUuid } from '../users';

/**
 * CR-HM-BM-CARE-AUTH-01 — request validation for the Care authority surface.
 *
 * Two responsibilities:
 *
 *  1. `parseBuildingIdParam` — a UUID-shaped Building id.
 *  2. `assertNoSuppliedRecordingIdentity` — SD-19 enforcement at the edge.
 *     A browser-supplied recording identity is REJECTED, not silently
 *     ignored: silently ignoring it would let a client believe it was
 *     honoured. `recordedByUserId` (and any sibling spelling) is always
 *     derived from the authenticated Backend session.
 */

export function parseBuildingIdParam(value: unknown): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw new AppError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'A valid building id is required.',
      statusCode: 400,
      details: [{ field: 'buildingId', reason: 'invalid_uuid' }],
    });
  }
  return value;
}

/** Optional, and only ever a narrowing assertion — never a scope source. */
export function parseOptionalClientIdParam(
  value: unknown,
): string | null | undefined {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw new AppError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'clientId must be a valid UUID when supplied.',
      statusCode: 400,
      details: [{ field: 'clientId', reason: 'invalid_uuid' }],
    });
  }
  return value;
}

/**
 * Rejects any caller-supplied recording identity (SD-19).
 *
 * Checks the query string and, when present, a JSON object body. The Care
 * authority surface accepts no body at all, so a body carrying an identity
 * field is unambiguously a spoof attempt.
 */
export function assertNoSuppliedRecordingIdentity(
  fields: readonly string[],
  sources: readonly (Record<string, unknown> | undefined | null)[],
): void {
  for (const source of sources) {
    if (!source) continue;
    for (const field of fields) {
      if (source[field] !== undefined && source[field] !== null) {
        throw careIdentityNotAcceptedError(field);
      }
    }
  }
}
