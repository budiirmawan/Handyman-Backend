import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_PERMIT_TYPES,
} from '../handyman-scheduling';
import type {
  CreateHandymanPermitReadinessInput,
  CreateHandymanSchedulingReadinessInput,
  CreateHandymanUnitAccessReadinessInput,
  SupersedeHandymanPermitReadinessInput,
  SupersedeHandymanSchedulingReadinessInput,
  SupersedeHandymanUnitAccessReadinessInput,
} from '../handyman-scheduling';

/**
 * CR-HM-05 PART 06A — request/DTO parsing for the Handyman readiness
 * surface (FROZEN F7). Validation-only: PART 01–04 services remain the
 * sole business authority (derivation, invariants, history semantics).
 *
 * Authority rule: bodies expose ONLY caller-owned readiness fields.
 * Any smuggled keys — actor/user ids, clientId, building/location
 * references, timezone, provider/crew, FM permit/work order,
 * executionScopeId/targetId, QR/arrival/challenge data — are
 * structurally IGNORED: parsers never spread the source object, so
 * smuggled fields cannot even reach the service layer.
 */

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readId(
  value: unknown,
  field: string,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} is required and must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readText(
  value: unknown,
  field: string,
  details: Detail[],
  max: number,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (typeof value !== 'string' || trimmed.length < 1 || trimmed.length > max) {
    details.push({
      field,
      message: `${field} is required and must be between 1 and ${max} characters.`,
    });
  }
  return trimmed;
}

function readOptionalText(
  value: unknown,
  field: string,
  details: Detail[],
  max: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length > max) {
    details.push({
      field,
      message: `${field} must be a string of at most ${max} characters.`,
    });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Path parameter authority: the Handyman request id or a readiness id. */
export function parseReadinessApiUuidParam(
  value: unknown,
  field: string,
): string {
  const details: Detail[] = [];
  const id = readId(value, field, details);
  if (!id || details.length) fail(details);
  return id;
}

/** POST /handyman/requests/:handymanRequestId/scheduling-readiness */
export function parseSchedulingReadinessCreateBody(
  body: unknown,
): Omit<CreateHandymanSchedulingReadinessInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const preferredWindowStart = readText(
    source.preferredWindowStart, 'preferredWindowStart', details, 64);
  const preferredWindowEnd = readText(
    source.preferredWindowEnd, 'preferredWindowEnd', details, 64);
  const changeReason = readOptionalText(
    source.changeReason, 'changeReason', details, 500);
  if (details.length) fail(details);
  return {
    preferredWindowStart,
    preferredWindowEnd,
    ...(changeReason !== undefined ? { changeReason } : {}),
  };
}

/** POST /handyman/scheduling-readiness/:readinessId/supersede */
export function parseSchedulingReadinessSupersedeBody(
  body: unknown,
): SupersedeHandymanSchedulingReadinessInput {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const preferredWindowStart = readText(
    source.preferredWindowStart, 'preferredWindowStart', details, 64);
  const preferredWindowEnd = readText(
    source.preferredWindowEnd, 'preferredWindowEnd', details, 64);
  const changeReason = readOptionalText(
    source.changeReason, 'changeReason', details, 500);
  if (details.length) fail(details);
  return {
    preferredWindowStart,
    preferredWindowEnd,
    ...(changeReason !== undefined ? { changeReason } : {}),
  };
}

/** POST /handyman/requests/:handymanRequestId/unit-access-readiness */
export function parseUnitAccessReadinessCreateBody(
  body: unknown,
): Omit<CreateHandymanUnitAccessReadinessInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const accessWindowStart = readText(
    source.accessWindowStart, 'accessWindowStart', details, 64);
  const accessWindowEnd = readText(
    source.accessWindowEnd, 'accessWindowEnd', details, 64);
  const authorizationNote = readText(
    source.authorizationNote, 'authorizationNote', details, 1000);
  if (details.length) fail(details);
  return { accessWindowStart, accessWindowEnd, authorizationNote };
}

/** POST /handyman/unit-access-readiness/:readinessId/supersede */
export function parseUnitAccessReadinessSupersedeBody(
  body: unknown,
): SupersedeHandymanUnitAccessReadinessInput {
  return parseUnitAccessReadinessCreateBody(body);
}

/** POST /handyman/requests/:handymanRequestId/permit-readiness */
export function parsePermitReadinessCreateBody(
  body: unknown,
): Omit<CreateHandymanPermitReadinessInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];
  const permitType =
    typeof source.permitType === 'string' &&
    (HANDYMAN_PERMIT_TYPES as readonly string[])
      .includes(source.permitType.trim())
      ? source.permitType.trim()
      : (details.push({
          field: 'permitType',
          message: `permitType must be one of: ${HANDYMAN_PERMIT_TYPES.join(', ')}.`,
        }),
        '');
  const validFrom = readText(source.validFrom, 'validFrom', details, 64);
  const validUntil = readText(source.validUntil, 'validUntil', details, 64);
  const authorizationNote = readText(
    source.authorizationNote, 'authorizationNote', details, 1000);
  if (details.length) fail(details);
  return { permitType, validFrom, validUntil, authorizationNote };
}

/** POST /handyman/permit-readiness/:readinessId/supersede */
export function parsePermitReadinessSupersedeBody(
  body: unknown,
): SupersedeHandymanPermitReadinessInput {
  return parsePermitReadinessCreateBody(body);
}
