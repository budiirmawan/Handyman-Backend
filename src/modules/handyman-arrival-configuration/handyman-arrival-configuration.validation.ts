import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-FIELD-OPERATIONS-01 PART 04 — bounded HTTP validation for the
 * approved G-2 (QR registry) and G-3 (Building geofence) configuration
 * surfaces.
 *
 * Whitelist ONLY. Every parser returns a literal object built from named
 * fields, so authority/derived/secret-shaped keys a caller may smuggle
 * (`clientId`, `status`, `id`, `opaqueCode`, `opaqueCodeHash`,
 * `createdByUserId`, `policyId`, `distanceMeters`, `geofenceSignal`, …) are
 * structurally ignored and can never reach a service.
 */

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function fail(
  message: string,
  details: { field: string; message: string }[],
): never {
  throw AppError.validation(message, details);
}

function uuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isValidUuid(raw)) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return raw;
}

export function parseBuildingIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'buildingId');
}

export function parseIdentifierIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'identifierId');
}

/** Optional `?status=ACTIVE|INACTIVE` registry filter. */
export function parseIdentifierStatusQuery(
  query: Record<string, unknown>,
): 'ACTIVE' | 'INACTIVE' | null {
  const raw = query.status;
  if (raw === undefined) return null;
  if (raw !== 'ACTIVE' && raw !== 'INACTIVE') {
    fail('Request validation failed.', [
      {
        field: 'status',
        message: 'status must be ACTIVE or INACTIVE.',
      },
    ]);
  }
  return raw;
}

/** Reject unsupported query parameters on the non-list routes. */
export function ensureEmptyQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length) {
    fail('Request validation failed.', [
      { field: 'query', message: 'Query parameters not supported.' },
    ]);
  }
}

function optionalUuidField(
  obj: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim().toLowerCase())) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a valid UUID or null.` },
    ]);
  }
  return value.trim().toLowerCase();
}

export type RegisterIdentifierInput = {
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
};

/**
 * G-2 registration body: the LOCATION CHAIN only. `clientId`, `status`,
 * `id`, `opaqueCode` and `opaqueCodeHash` are server-derived; supplying
 * them changes nothing.
 */
export function parseRegisterIdentifierBody(
  body: unknown,
): RegisterIdentifierInput {
  const obj = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};
  return {
    floorId: optionalUuidField(obj, 'floorId') ?? null,
    areaId: optionalUuidField(obj, 'areaId') ?? null,
    roomId: optionalUuidField(obj, 'roomId') ?? null,
    spaceId: optionalUuidField(obj, 'spaceId') ?? null,
  };
}

function finiteNumber(value: unknown, field: string): number {
  const num = Number(value);
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || typeof value === 'object'
    || (typeof value === 'string' && value.trim() === '')
    || !Number.isFinite(num)
  ) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a finite number.` },
    ]);
  }
  return num;
}

export type GeofencePolicyInput = {
  referenceLatitude: number;
  referenceLongitude: number;
  geofenceRadiusMeters: number;
  maxAccuracyMeters: number;
  maxLocationAgeSeconds: number;
  effectiveFrom: string | null;
};

/**
 * G-3 policy body: the five operator-configured values plus optional
 * `effectiveFrom`. `buildingId` comes from the URL; `clientId`, `status`,
 * `createdByUserId` and every computed field are server-derived. Type/shape
 * checks live here; physical bounds remain the existing service's
 * responsibility (it is the single validation authority).
 */
export function parseGeofencePolicyBody(body: unknown): GeofencePolicyInput {
  const obj = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};
  const rawEffective = obj.effectiveFrom;
  let effectiveFrom: string | null = null;
  if (rawEffective !== undefined && rawEffective !== null) {
    if (typeof rawEffective !== 'string'
      || !Number.isFinite(Date.parse(rawEffective))) {
      fail('Request validation failed.', [
        {
          field: 'effectiveFrom',
          message: 'effectiveFrom must be a valid ISO timestamp or null.',
        },
      ]);
    }
    effectiveFrom = rawEffective;
  }
  return {
    referenceLatitude: finiteNumber(
      obj.referenceLatitude,
      'referenceLatitude',
    ),
    referenceLongitude: finiteNumber(
      obj.referenceLongitude,
      'referenceLongitude',
    ),
    geofenceRadiusMeters: finiteNumber(
      obj.geofenceRadiusMeters,
      'geofenceRadiusMeters',
    ),
    maxAccuracyMeters: finiteNumber(
      obj.maxAccuracyMeters,
      'maxAccuracyMeters',
    ),
    maxLocationAgeSeconds: finiteNumber(
      obj.maxLocationAgeSeconds,
      'maxLocationAgeSeconds',
    ),
    effectiveFrom,
  };
}
