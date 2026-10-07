import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TENANT_SPACE_RELATIONSHIP_STATUSES,
  isTenantSpaceRelationshipStatus,
  type AssignTenantSpaceInput,
  type TenantSpaceRelationshipStatus,
  type UpdateTenantSpaceRelationshipInput,
} from './tenant-space.types';

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

export function parseTenantSpaceRelationshipIdParam(raw: string): string {
  return parseId(raw, 'tenantSpaceRelationshipId');
}
export function parseTenantSpaceCompanyIdParam(raw: string): string {
  return parseId(raw, 'tenantCompanyId');
}
export function parseTenantSpaceBuildingIdParam(raw: string): string {
  return parseId(raw, 'buildingId');
}

export function parseAssignTenantSpaceBody(
  body: unknown,
): Omit<AssignTenantSpaceInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const buildingId = readRequiredId(body.buildingId, 'buildingId', details);
  const spaceId = readRequiredId(body.spaceId, 'spaceId', details);
  const effectiveFrom = readDate(body.effectiveFrom, 'effectiveFrom', details);
  const effectiveUntil = readDate(body.effectiveUntil, 'effectiveUntil', details);
  const status = readStatus(body.status, details);
  assertOrder(effectiveFrom, effectiveUntil, details);
  if (!buildingId || !spaceId || details.length) fail(details);
  return {
    buildingId,
    spaceId,
    ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
    ...(effectiveUntil !== undefined ? { effectiveUntil } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdateTenantSpaceBody(
  body: unknown,
): UpdateTenantSpaceRelationshipInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = ['tenantCompanyId', 'buildingId', 'spaceId'].find(
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
): TenantSpaceRelationshipStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantSpaceRelationshipStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${TENANT_SPACE_RELATIONSHIP_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
