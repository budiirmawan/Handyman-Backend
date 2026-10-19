import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { SPACE_STATUSES } from '../spaces';
import {
  UNIT_PARTY_ROLES,
  UNIT_PARTY_ROLE_STATUSES,
  isUnitPartyRole,
  isUnitPartyRoleStatus,
  type UnitPartyRoleFilters,
} from './unit-party-role.types';
import {
  APARTMENT_UNIT_STATUSES,
  isApartmentUnitStatus,
  type ApartmentUnitFilters,
  type ApartmentUnitOccupancyFilters,
} from './unit.types';

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'buildingId', message: 'buildingId must be a valid UUID.' }]);
  }
  return value;
}

export function parseUnitIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'unitId', message: 'unitId must be a valid UUID.' }]);
  }
  return value;
}

export function parseUnitPartyRoleIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      { field: 'unitPartyRoleId', message: 'unitPartyRoleId must be a valid UUID.' },
    ]);
  }
  return value;
}

function readOptionalString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

/** Unit list query. Pagination is parsed by the shared pagination contract. */
export function parseApartmentUnitListQuery(
  query: Record<string, unknown>,
): ApartmentUnitFilters {
  const details: Detail[] = [];
  let floorId: string | undefined;
  if (query.floorId !== undefined) {
    if (typeof query.floorId !== 'string' || !isValidUuid(query.floorId)) {
      details.push({ field: 'floorId', message: 'floorId must be a valid UUID.' });
    } else {
      floorId = query.floorId.trim().toLowerCase();
    }
  }
  let status: (typeof APARTMENT_UNIT_STATUSES)[number] | undefined;
  if (query.status !== undefined) {
    if (!isApartmentUnitStatus(query.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${APARTMENT_UNIT_STATUSES.join(', ')}.`,
      });
    } else {
      status = query.status;
    }
  }
  const search = readOptionalString(query.search, 'search', 120, details);
  if (details.length) fail(details);
  return {
    ...(floorId === undefined ? {} : { floorId }),
    ...(status === undefined ? {} : { status }),
    ...(search === undefined ? {} : { search }),
  };
}

export function parseApartmentUnitOccupancyQuery(
  query: Record<string, unknown>,
): ApartmentUnitOccupancyFilters {
  const details: Detail[] = [];
  let status: 'ACTIVE' | 'INACTIVE' | undefined;
  if (query.status !== undefined) {
    if (query.status !== 'ACTIVE' && query.status !== 'INACTIVE') {
      details.push({
        field: 'status',
        message: 'status must be one of: ACTIVE, INACTIVE.',
      });
    } else {
      status = query.status;
    }
  }
  const unsupported = Object.keys(query).find(
    (key) => !['status', 'page', 'pageSize'].includes(key),
  );
  if (unsupported) {
    details.push({
      field: unsupported,
      message: 'This query parameter is not accepted.',
    });
  }
  if (details.length) fail(details);
  return { ...(status === undefined ? {} : { status }) };
}

export function parseApartmentUnitUpdateBody(body: unknown): {
  name?: string;
  description?: string;
  status?: (typeof SPACE_STATUSES)[number];
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const allowed = ['name', 'description', 'status'];
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key));
  if (unsupported) {
    fail([
      {
        field: unsupported,
        message:
          'Only name, description and status are accepted; Unit identity (code/room/floor) is immutable.',
      },
    ]);
  }
  const details: Detail[] = [];
  const name = readOptionalString(body.name, 'name', 160, details);
  const description = readOptionalString(body.description, 'description', 512, details);
  let status: (typeof SPACE_STATUSES)[number] | undefined;
  if (body.status !== undefined) {
    if (
      typeof body.status !== 'string' ||
      !(SPACE_STATUSES as readonly string[]).includes(body.status)
    ) {
      details.push({
        field: 'status',
        message: `status must be one of: ${SPACE_STATUSES.join(', ')}.`,
      });
    } else {
      status = body.status as (typeof SPACE_STATUSES)[number];
    }
  }
  if (details.length) fail(details);
  if (name === undefined && description === undefined && status === undefined) {
    fail([{ field: 'body', message: 'At least one updatable field is required.' }]);
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUnitPartyRoleListQuery(
  query: Record<string, unknown>,
): UnitPartyRoleFilters {
  const details: Detail[] = [];
  let partyRole: UnitPartyRoleFilters['partyRole'];
  if (query.role !== undefined) {
    if (!isUnitPartyRole(query.role)) {
      details.push({
        field: 'role',
        message: `role must be one of: ${UNIT_PARTY_ROLES.join(', ')}.`,
      });
    } else {
      partyRole = query.role;
    }
  }
  let status: UnitPartyRoleFilters['status'];
  if (query.status !== undefined) {
    if (!isUnitPartyRoleStatus(query.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${UNIT_PARTY_ROLE_STATUSES.join(', ')}.`,
      });
    } else {
      status = query.status;
    }
  }
  const unsupported = Object.keys(query).find(
    (key) => !['role', 'status', 'page', 'pageSize'].includes(key),
  );
  if (unsupported) {
    details.push({
      field: unsupported,
      message: 'This query parameter is not accepted.',
    });
  }
  if (details.length) fail(details);
  return {
    ...(partyRole === undefined ? {} : { partyRole }),
    ...(status === undefined ? {} : { status }),
  };
}

function readOptionalIsoDate(
  value: unknown,
  field: string,
  details: Detail[],
): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be an ISO-8601 timestamp.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO-8601 timestamp.` });
    return undefined;
  }
  return parsed;
}

export function parseAssignUnitPartyRoleBody(body: unknown): {
  tenantCompanyId: string;
  partyRole: (typeof UNIT_PARTY_ROLES)[number];
  effectiveFrom?: Date;
  effectiveUntil?: Date;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const allowed = [
    'tenantCompanyId',
    'partyRole',
    'effectiveFrom',
    'effectiveUntil',
  ];
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key));
  if (unsupported) {
    fail([
      {
        field: unsupported,
        message:
          'Only tenantCompanyId, partyRole and the effective window are accepted.',
      },
    ]);
  }
  const details: Detail[] = [];
  if (
    typeof body.tenantCompanyId !== 'string' ||
    !isValidUuid(body.tenantCompanyId)
  ) {
    details.push({
      field: 'tenantCompanyId',
      message: 'tenantCompanyId is required and must be a valid UUID.',
    });
  }
  if (!isUnitPartyRole(body.partyRole)) {
    details.push({
      field: 'partyRole',
      message: `partyRole must be one of: ${UNIT_PARTY_ROLES.join(', ')}.`,
    });
  }
  const effectiveFrom = readOptionalIsoDate(
    body.effectiveFrom,
    'effectiveFrom',
    details,
  );
  const effectiveUntil = readOptionalIsoDate(
    body.effectiveUntil,
    'effectiveUntil',
    details,
  );
  if (details.length) fail(details);
  return {
    tenantCompanyId: (body.tenantCompanyId as string).trim().toLowerCase(),
    partyRole: body.partyRole as (typeof UNIT_PARTY_ROLES)[number],
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
  };
}

export function parseEndUnitPartyRoleBody(body: unknown): { effectiveUntil?: Date } {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const allowed = ['effectiveUntil'];
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key));
  if (unsupported) {
    fail([
      { field: unsupported, message: 'Only effectiveUntil is accepted.' },
    ]);
  }
  const details: Detail[] = [];
  const effectiveUntil = readOptionalIsoDate(
    body.effectiveUntil,
    'effectiveUntil',
    details,
  );
  if (details.length) fail(details);
  return { ...(effectiveUntil === undefined ? {} : { effectiveUntil }) };
}
