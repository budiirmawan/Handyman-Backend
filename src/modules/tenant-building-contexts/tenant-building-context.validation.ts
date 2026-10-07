import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TENANT_BUILDING_CONTEXT_STATUSES,
  isTenantBuildingContextStatus,
  type CreateTenantBuildingContextInput,
  type TenantBuildingContextStatus,
  type UpdateTenantBuildingContextInput,
} from './tenant-building-context.types';

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}

export function parseTenantBuildingContextIdParam(raw: string): string {
  return parseId(raw, 'tenantBuildingContextId');
}
export function parseTenantBuildingCompanyIdParam(raw: string): string {
  return parseId(raw, 'tenantCompanyId');
}
export function parseTenantBuildingIdParam(raw: string): string {
  return parseId(raw, 'buildingId');
}

export function parseCreateTenantBuildingContextBody(
  body: unknown,
): Omit<CreateTenantBuildingContextInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const buildingId = readRequiredId(body.buildingId, 'buildingId', details);
  const effectiveFrom = readDate(body.effectiveFrom, 'effectiveFrom', details);
  const effectiveUntil = readDate(body.effectiveUntil, 'effectiveUntil', details);
  const status = readStatus(body.status, details);
  assertOrder(effectiveFrom, effectiveUntil, details);
  if (!buildingId || details.length) fail(details);
  return {
    buildingId,
    ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
    ...(effectiveUntil !== undefined ? { effectiveUntil } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdateTenantBuildingContextBody(
  body: unknown,
): UpdateTenantBuildingContextInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = ['tenantCompanyId', 'buildingId'].find(
    (field) => body[field] !== undefined,
  );
  if (immutable) {
    fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  }
  const details: Detail[] = [];
  const effectiveFrom = readDate(body.effectiveFrom, 'effectiveFrom', details);
  const effectiveUntil = readDate(body.effectiveUntil, 'effectiveUntil', details);
  const status = readStatus(body.status, details);
  assertOrder(effectiveFrom, effectiveUntil, details);
  if (details.length) fail(details);
  return {
    ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
    ...(effectiveUntil !== undefined ? { effectiveUntil } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function readRequiredId(
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

function readDate(
  value: unknown,
  field: string,
  details: Detail[],
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} must be an ISO-8601 date string or null.` });
    return undefined;
  }
  const result = new Date(value.trim());
  if (Number.isNaN(result.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 date string.` });
    return undefined;
  }
  return result;
}

function assertOrder(
  from: Date | null | undefined,
  until: Date | null | undefined,
  details: Detail[],
): void {
  if (from instanceof Date && until instanceof Date && until < from) {
    details.push({
      field: 'effectiveUntil',
      message: 'effectiveUntil must be the same as or after effectiveFrom.',
    });
  }
}

function readStatus(
  value: unknown,
  details: Detail[],
): TenantBuildingContextStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantBuildingContextStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${TENANT_BUILDING_CONTEXT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
