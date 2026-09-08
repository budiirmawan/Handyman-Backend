import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isValidWorkOrderNumber,
  normalizeWorkOrderNumber,
} from '../work-orders';
import {
  isValidRequestNumber,
  isValidRequestType,
  isWorkRequestStatus,
  normalizeRequestNumber,
  normalizeRequestType,
} from '../work-requests';
import {
  TENANT_UTILITY_REQUEST_STATUSES,
  type CreateTenantUtilityRequestInput,
  type CreateUtilityRequestWorkOrderInput,
  type TenantUtilityRequestFilters,
  type TenantUtilityRequestStatus,
  type UpdateTenantUtilityRequestInput,
} from './tenant-utility-request.types';

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
export const parseTenantUtilityRequestIdParam = (raw: string): string =>
  parseId(raw, 'tenantUtilityRequestId');
export const parseTenantUtilityRequestCompanyIdParam = (raw: string): string =>
  parseId(raw, 'tenantCompanyId');
export const parseTenantUtilityRequestBuildingIdParam = (raw: string): string =>
  parseId(raw, 'buildingId');

export function parseCreateTenantUtilityRequestBody(
  body: unknown,
): Omit<CreateTenantUtilityRequestInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const tenantPicId = readId(body.tenantPicId, 'tenantPicId', details);
  const buildingId = readId(body.buildingId, 'buildingId', details);
  const spaceId = readId(body.spaceId, 'spaceId', details);
  const utilityType = readUtilityType(body.utilityType, details);
  const requestNumber = readRequestNumber(body.requestNumber, details);
  const requestDetails = requiredString(body.requestDetails, 'requestDetails', 2000, details);
  const notes = optionalString(body.notes, 'notes', 1000, details);
  if (!tenantPicId || !buildingId || !spaceId || !utilityType || !requestNumber || !requestDetails || details.length) fail(details);
  return {
    tenantPicId,
    buildingId,
    spaceId,
    utilityType,
    requestNumber,
    requestDetails,
    ...(notes ? { notes } : {}),
  };
}

export function parseUpdateTenantUtilityRequestBody(
  body: unknown,
): UpdateTenantUtilityRequestInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'clientId', 'tenantCompanyId', 'tenantPicId', 'buildingId', 'spaceId',
    'requestNumber', 'requestedAt', 'status', 'workRequestId', 'workOrderId',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const utilityType = body.utilityType === undefined
    ? undefined : readUtilityType(body.utilityType, details);
  const requestDetails = body.requestDetails === undefined
    ? undefined : requiredString(body.requestDetails, 'requestDetails', 2000, details);
  const notes = body.notes === null
    ? null : optionalString(body.notes, 'notes', 1000, details);
  if (details.length) fail(details);
  return {
    ...(utilityType !== undefined ? { utilityType } : {}),
    ...(requestDetails !== undefined ? { requestDetails } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseTenantUtilityRequestFilters(query: unknown): TenantUtilityRequestFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const status = readStatus(query.status, details);
  const utilityType = query.utilityType === undefined
    ? undefined : readUtilityType(query.utilityType, details);
  const tenantCompanyId = readOptionalId(query.tenantCompanyId, 'tenantCompanyId', details);
  const buildingId = readOptionalId(query.buildingId, 'buildingId', details);
  if (details.length) fail(details);
  return {
    ...(status ? { status } : {}),
    ...(utilityType ? { utilityType } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
  };
}

export function parseCreateUtilityRequestWorkOrderBody(
  body: unknown,
): CreateUtilityRequestWorkOrderInput {
  if (!isRecord(body) || typeof body.workOrderNumber !== 'string') {
    fail([{ field: 'workOrderNumber', message: 'workOrderNumber is required.' }]);
  }
  const workOrderNumber = normalizeWorkOrderNumber(body.workOrderNumber);
  if (!isValidWorkOrderNumber(workOrderNumber)) {
    fail([{ field: 'workOrderNumber', message: 'workOrderNumber has an invalid format.' }]);
  }
  return { workOrderNumber };
}

function readId(value: unknown, field: string, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} is required and must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function readOptionalId(value: unknown, field: string, details: Detail[]): string | undefined {
  if (value === undefined) return undefined;
  return readId(value, field, details);
}
function readUtilityType(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'utilityType', message: 'utilityType is required.' });
    return undefined;
  }
  const result = normalizeRequestType(value);
  if (!isValidRequestType(result)) {
    details.push({ field: 'utilityType', message: 'utilityType must be a valid data-driven code.' });
    return undefined;
  }
  return result;
}
function readRequestNumber(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'requestNumber', message: 'requestNumber is required.' });
    return undefined;
  }
  const result = normalizeRequestNumber(value);
  if (!isValidRequestNumber(result)) {
    details.push({ field: 'requestNumber', message: 'requestNumber has an invalid format.' });
    return undefined;
  }
  return result;
}
function requiredString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}
function optionalString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
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
function readStatus(value: unknown, details: Detail[]): TenantUtilityRequestStatus | undefined {
  if (value === undefined) return undefined;
  if (!isWorkRequestStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${TENANT_UTILITY_REQUEST_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
