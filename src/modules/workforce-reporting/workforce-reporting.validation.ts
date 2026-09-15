import { AppError } from '../../shared/errors';
import { WORKFORCE_STATUSES, WORKFORCE_TYPES, isWorkforceStatus, isWorkforceType, type WorkforceStatus, type WorkforceType } from '../workforce';
import type { WorkforceReportingQuery } from './workforce-reporting.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function readUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!UUID_PATTERN.test(raw)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return raw.toLowerCase();
}

function readEnum<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
  label: string,
  details: ValidationDetail[],
): T | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const upper = raw.toUpperCase();
  if (!values.includes(upper as T)) {
    details.push({
      field,
      message: `${label} must be one of: ${values.join(', ')}.`,
    });
    return undefined;
  }
  return upper as T;
}

function readBoolean(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): boolean | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  details.push({ field, message: `${field} must be true or false.` });
  return undefined;
}

function readPositiveInt(
  value: unknown,
  field: string,
  fallback: number,
  max: number,
  details: ValidationDetail[],
): number {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    details.push({ field, message: `${field} must be a positive integer.` });
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1 || parsed > max) {
    details.push({
      field,
      message: `${field} must be between 1 and ${max}.`,
    });
    return fallback;
  }
  return parsed;
}

export function parseWorkforceReportingQuery(
  query: Record<string, unknown>,
): WorkforceReportingQuery {
  const details: ValidationDetail[] = [];
  const organizationId = readUuid(
    query.organizationId,
    'organizationId',
    'Organization id',
    details,
  );
  const departmentId = readUuid(
    query.departmentId,
    'departmentId',
    'Department id',
    details,
  );
  const teamId = readUuid(query.teamId, 'teamId', 'Team id', details);
  const positionId = readUuid(
    query.positionId,
    'positionId',
    'Position id',
    details,
  );
  const buildingId = readUuid(
    query.buildingId,
    'buildingId',
    'Building id',
    details,
  );
  const shiftId = readUuid(query.shiftId, 'shiftId', 'Shift id', details);
  const externalOrganizationId = readUuid(
    query.externalOrganizationId,
    'externalOrganizationId',
    'External organization id',
    details,
  );
  const workforceType = readEnum<WorkforceType>(
    query.workforceType,
    'workforceType',
    WORKFORCE_TYPES,
    'Workforce type',
    details,
  );
  const status = readEnum<WorkforceStatus>(
    query.status,
    'status',
    WORKFORCE_STATUSES,
    'Status',
    details,
  );
  const includeInactive = readBoolean(
    query.includeInactive,
    'includeInactive',
    details,
  );
  const page = readPositiveInt(query.page, 'page', DEFAULT_PAGE, 10_000, details);
  const limit = readPositiveInt(
    query.limit,
    'limit',
    DEFAULT_LIMIT,
    MAX_LIMIT,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (status && includeInactive) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: 'Do not set status when includeInactive is true.',
      },
    ]);
  }

  if (!isWorkforceType(workforceType ?? 'INTERNAL') || !isWorkforceStatus(status ?? 'ACTIVE')) {
    throw AppError.validation('Request validation failed.', []);
  }

  return {
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(departmentId === undefined ? {} : { departmentId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(positionId === undefined ? {} : { positionId }),
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(shiftId === undefined ? {} : { shiftId }),
    ...(externalOrganizationId === undefined
      ? {}
      : { externalOrganizationId }),
    ...(workforceType === undefined ? {} : { workforceType }),
    ...(status === undefined ? {} : { status }),
    ...(includeInactive === undefined ? {} : { includeInactive }),
    page,
    limit,
  };
}

export function parseWorkforceReportingIdParam(raw: string): string {
  const value = raw.trim();
  if (!UUID_PATTERN.test(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'workforceProfileId', message: 'Workforce profile id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}
