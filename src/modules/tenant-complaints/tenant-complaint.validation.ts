import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidFindingNumber, normalizeFindingNumber } from '../findings';
import {
  WORK_ORDER_PRIORITIES,
  isValidWorkOrderNumber,
  isWorkOrderPriority,
  normalizeWorkOrderNumber,
  type WorkOrderPriority,
} from '../work-orders';
import { isValidRequestType, normalizeRequestType } from '../work-requests';
import {
  TENANT_COMPLAINT_STATUSES,
  isTenantComplaintStatus,
  type CreateComplaintWorkOrderInput,
  type CreateTenantComplaintInput,
  type TenantComplaintFilters,
  type TenantComplaintStatus,
  type UpdateTenantComplaintInput,
} from './tenant-complaint.types';

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
export const parseTenantComplaintIdParam = (raw: string): string =>
  parseId(raw, 'tenantComplaintId');
export const parseTenantComplaintCompanyIdParam = (raw: string): string =>
  parseId(raw, 'tenantCompanyId');
export const parseTenantComplaintBuildingIdParam = (raw: string): string =>
  parseId(raw, 'buildingId');

export function parseCreateTenantComplaintBody(
  body: unknown,
): Omit<CreateTenantComplaintInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const tenantPicId = readId(body.tenantPicId, 'tenantPicId', true, details);
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const spaceId = readId(body.spaceId, 'spaceId', false, details);
  const complaintNumber = readComplaintNumber(body.complaintNumber, details);
  const complaintType = readComplaintType(body.complaintType, details);
  const title = requiredString(body.title, 'title', 200, details);
  const description = optionalString(body.description, 'description', 2000, details);
  const severity = readSeverity(body.severity, details);
  if (!tenantPicId || !buildingId || !complaintNumber || !complaintType || !title || details.length) fail(details);
  return {
    tenantPicId,
    buildingId,
    ...(spaceId ? { spaceId } : {}),
    complaintNumber,
    complaintType,
    title,
    ...(description ? { description } : {}),
    ...(severity ? { severity } : {}),
  };
}

export function parseUpdateTenantComplaintBody(body: unknown): UpdateTenantComplaintInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'clientId', 'tenantCompanyId', 'tenantPicId', 'buildingId', 'spaceId',
    'complaintNumber', 'status', 'reportedAt', 'findingId', 'workOrderId',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const complaintType = body.complaintType === undefined
    ? undefined : readComplaintType(body.complaintType, details);
  const title = body.title === undefined
    ? undefined : requiredString(body.title, 'title', 200, details);
  const description = body.description === null
    ? null : optionalString(body.description, 'description', 2000, details);
  const severity = readSeverity(body.severity, details);
  if (details.length) fail(details);
  return {
    ...(complaintType !== undefined ? { complaintType } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(severity !== undefined ? { severity } : {}),
  };
}

export function parseTenantComplaintFilters(query: unknown): TenantComplaintFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const status = readStatus(query.status, details);
  const complaintType = query.complaintType === undefined
    ? undefined : readComplaintType(query.complaintType, details);
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  if (details.length) fail(details);
  return {
    ...(status ? { status } : {}),
    ...(complaintType ? { complaintType } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
  };
}

export function parseCreateComplaintWorkOrderBody(body: unknown): CreateComplaintWorkOrderInput {
  if (!isRecord(body) || typeof body.workOrderNumber !== 'string') {
    fail([{ field: 'workOrderNumber', message: 'workOrderNumber is required.' }]);
  }
  const workOrderNumber = normalizeWorkOrderNumber(body.workOrderNumber);
  if (!isValidWorkOrderNumber(workOrderNumber)) {
    fail([{ field: 'workOrderNumber', message: 'workOrderNumber has an invalid format.' }]);
  }
  return { workOrderNumber };
}

function readId(value: unknown, field: string, required: boolean, details: Detail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function readComplaintNumber(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'complaintNumber', message: 'complaintNumber is required.' });
    return undefined;
  }
  const result = normalizeFindingNumber(value);
  if (!isValidFindingNumber(result)) {
    details.push({ field: 'complaintNumber', message: 'complaintNumber has an invalid format.' });
    return undefined;
  }
  return result;
}
function readComplaintType(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'complaintType', message: 'complaintType is required.' });
    return undefined;
  }
  const result = normalizeRequestType(value);
  if (!isValidRequestType(result)) {
    details.push({ field: 'complaintType', message: 'complaintType has an invalid format.' });
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
function readSeverity(value: unknown, details: Detail[]): WorkOrderPriority | undefined {
  if (value === undefined) return undefined;
  if (!isWorkOrderPriority(value)) {
    details.push({ field: 'severity', message: `severity must be one of: ${WORK_ORDER_PRIORITIES.join(', ')}.` });
    return undefined;
  }
  return value;
}
function readStatus(value: unknown, details: Detail[]): TenantComplaintStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantComplaintStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${TENANT_COMPLAINT_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
