import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidRequestType, normalizeRequestType } from '../work-requests';
import {
  TENANT_CONTRACTOR_RELATIONSHIP_STATUSES,
  isTenantContractorRelationshipStatus,
  type CreateTenantContractorRelationshipInput,
  type TenantContractorRelationshipFilters,
  type TenantContractorRelationshipStatus,
  type UpdateTenantContractorRelationshipInput,
} from './tenant-contractor.types';

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
export const parseTenantContractorIdParam = (raw: string): string =>
  parseId(raw, 'tenantContractorRelationshipId');
export const parseTenantContractorCompanyIdParam = (raw: string): string =>
  parseId(raw, 'tenantCompanyId');
export const parseTenantContractorBuildingIdParam = (raw: string): string =>
  parseId(raw, 'buildingId');
export const parseTenantContractorVendorIdParam = (raw: string): string =>
  parseId(raw, 'contractorVendorId');

export function parseCreateTenantContractorBody(
  body: unknown,
): Omit<CreateTenantContractorRelationshipInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const contractorVendorId = readId(body.contractorVendorId, 'contractorVendorId', true, details);
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const spaceId = readId(body.spaceId, 'spaceId', false, details);
  const relationshipType = readRelationshipType(body.relationshipType, details);
  const effectiveFrom = readDate(body.effectiveFrom, 'effectiveFrom', details);
  const effectiveUntil = readDate(body.effectiveUntil, 'effectiveUntil', details);
  const status = readStatus(body.status, details);
  const notes = readString(body.notes, 'notes', 1000, details);
  assertOrder(effectiveFrom, effectiveUntil, details);
  if (!contractorVendorId || !buildingId || !relationshipType || details.length) fail(details);
  return {
    contractorVendorId,
    buildingId,
    ...(spaceId ? { spaceId } : {}),
    relationshipType,
    ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
    ...(effectiveUntil !== undefined ? { effectiveUntil } : {}),
    ...(status ? { status } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function parseUpdateTenantContractorBody(
  body: unknown,
): UpdateTenantContractorRelationshipInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'clientId', 'tenantCompanyId', 'contractorVendorId', 'buildingId',
    'spaceId', 'relationshipType',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const effectiveFrom = readDate(body.effectiveFrom, 'effectiveFrom', details);
  const effectiveUntil = readDate(body.effectiveUntil, 'effectiveUntil', details);
  const status = readStatus(body.status, details);
  const notes = body.notes === null
    ? null
    : readString(body.notes, 'notes', 1000, details);
  assertOrder(effectiveFrom, effectiveUntil, details);
  if (details.length) fail(details);
  return {
    ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
    ...(effectiveUntil !== undefined ? { effectiveUntil } : {}),
    ...(status ? { status } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseTenantContractorFilters(
  query: unknown,
): TenantContractorRelationshipFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const contractorVendorId = readId(query.contractorVendorId, 'contractorVendorId', false, details);
  const relationshipType = query.relationshipType === undefined
    ? undefined
    : readRelationshipType(query.relationshipType, details);
  const status = readStatus(query.status, details);
  if (details.length) fail(details);
  return {
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(contractorVendorId ? { contractorVendorId } : {}),
    ...(relationshipType ? { relationshipType } : {}),
    ...(status ? { status } : {}),
  };
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function readRelationshipType(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'relationshipType', message: 'relationshipType is required.' });
    return undefined;
  }
  const result = normalizeRequestType(value);
  if (!isValidRequestType(result)) {
    details.push({ field: 'relationshipType', message: 'relationshipType must be a valid data-driven code.' });
    return undefined;
  }
  return result;
}
function readDate(value: unknown, field: string, details: Detail[]): Date | null | undefined {
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
    details.push({ field: 'effectiveUntil', message: 'effectiveUntil must be the same as or after effectiveFrom.' });
  }
}
function readStatus(value: unknown, details: Detail[]): TenantContractorRelationshipStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantContractorRelationshipStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${TENANT_CONTRACTOR_RELATIONSHIP_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
function readString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}
