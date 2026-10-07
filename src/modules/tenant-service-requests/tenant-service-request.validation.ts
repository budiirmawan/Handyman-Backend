import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INTAKE_CHANNELS,
  isIntakeChannel,
  type IntakeChannel,
} from '../tenant-intake';
import {
  WORK_ORDER_PRIORITIES,
  isValidWorkOrderNumber,
  isWorkOrderPriority,
  normalizeWorkOrderNumber,
  type WorkOrderPriority,
} from '../work-orders';
import {
  isValidRequestNumber,
  isValidRequestType,
  normalizeRequestNumber,
  normalizeRequestType,
} from '../work-requests';
import {
  TENANT_SERVICE_REQUEST_STATUSES,
  isTenantServiceRequestStatus,
  type CreateServiceRequestWorkOrderInput,
  type CreateTenantServiceRequestInput,
  type TenantServiceRequestFilters,
  type TenantServiceRequestStatus,
  type UpdateTenantServiceRequestInput,
} from './tenant-service-request.types';

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

export function parseTenantServiceRequestIdParam(raw: string): string {
  return parseId(raw, 'tenantServiceRequestId');
}
export function parseTenantServiceRequestCompanyIdParam(raw: string): string {
  return parseId(raw, 'tenantCompanyId');
}
export function parseTenantServiceRequestBuildingIdParam(raw: string): string {
  return parseId(raw, 'buildingId');
}

export function parseCreateTenantServiceRequestBody(
  body: unknown,
): Omit<CreateTenantServiceRequestInput, 'tenantCompanyId'> {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const tenantPicId = readId(body.tenantPicId, 'tenantPicId', true, details);
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const spaceId = readId(body.spaceId, 'spaceId', false, details);
  const intakeChannel = readIntakeChannel(body.intakeChannel, details);
  const reporterName = readOptionalString(body.reporterName, 'reporterName', 200, details);
  const reporterPhone = readReporterPhone(body.reporterPhone, details);
  const reporterEmail = readReporterEmail(body.reporterEmail, details);
  const requestNumber = readRequestNumber(body.requestNumber, details);
  const requestType = readRequestType(body.requestType, details);
  const title = readRequiredString(body.title, 'title', 200, details);
  const description = readOptionalString(body.description, 'description', 1000, details);
  const priority = readPriority(body.priority, details);
  if (!tenantPicId || !buildingId || !requestNumber || !requestType || !title || details.length) {
    fail(details);
  }
  return {
    tenantPicId,
    buildingId,
    ...(spaceId ? { spaceId } : {}),
    ...(intakeChannel ? { intakeChannel } : {}),
    ...(reporterName ? { reporterName } : {}),
    ...(reporterPhone ? { reporterPhone } : {}),
    ...(reporterEmail ? { reporterEmail } : {}),
    requestNumber,
    requestType,
    title,
    ...(description ? { description } : {}),
    ...(priority ? { priority } : {}),
  };
}

export function parseUpdateTenantServiceRequestBody(
  body: unknown,
): UpdateTenantServiceRequestInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'clientId', 'tenantCompanyId', 'tenantPicId', 'buildingId', 'spaceId',
    'requestNumber', 'status', 'requestedAt', 'workRequestId', 'workOrderId',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This field is immutable and cannot be updated.' }]);
  const details: Detail[] = [];
  const requestType = body.requestType === undefined
    ? undefined
    : readRequestType(body.requestType, details);
  const title = body.title === undefined
    ? undefined
    : readRequiredString(body.title, 'title', 200, details);
  const description = body.description === null
    ? null
    : readOptionalString(body.description, 'description', 1000, details);
  const priority = readPriority(body.priority, details);
  if (details.length) fail(details);
  return {
    ...(requestType !== undefined ? { requestType } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
}

export function parseTenantServiceRequestFilters(
  query: unknown,
): TenantServiceRequestFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const status = readStatus(query.status, details);
  const requestType = query.requestType === undefined
    ? undefined
    : readRequestType(query.requestType, details);
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  if (details.length) fail(details);
  return {
    ...(status ? { status } : {}),
    ...(requestType ? { requestType } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
  };
}

export function parseCreateServiceRequestWorkOrderBody(
  body: unknown,
): CreateServiceRequestWorkOrderInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (typeof body.workOrderNumber !== 'string') {
    fail([{ field: 'workOrderNumber', message: 'workOrderNumber is required.' }]);
  }
  const workOrderNumber = normalizeWorkOrderNumber(body.workOrderNumber);
  if (!isValidWorkOrderNumber(workOrderNumber)) {
    fail([{ field: 'workOrderNumber', message: 'workOrderNumber has an invalid format.' }]);
  }
  return { workOrderNumber };
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

function readRequestType(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'requestType', message: 'requestType is required.' });
    return undefined;
  }
  const result = normalizeRequestType(value);
  if (!isValidRequestType(result)) {
    details.push({ field: 'requestType', message: 'requestType has an invalid format.' });
    return undefined;
  }
  return result;
}

function readRequiredString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | undefined {
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
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}

function readPriority(value: unknown, details: Detail[]): WorkOrderPriority | undefined {
  if (value === undefined) return undefined;
  if (!isWorkOrderPriority(value)) {
    details.push({ field: 'priority', message: `priority must be one of: ${WORK_ORDER_PRIORITIES.join(', ')}.` });
    return undefined;
  }
  return value;
}

function readIntakeChannel(
  value: unknown,
  details: Detail[],
): IntakeChannel | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!isIntakeChannel(normalized)) {
    details.push({
      field: 'intakeChannel',
      message: `intakeChannel must be one of: ${INTAKE_CHANNELS.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

const REPORTER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPORTER_PHONE_PATTERN = /^\+?[0-9()\-\s.]{5,}$/;

function readReporterEmail(value: unknown, details: Detail[]): string | undefined {
  const result = readOptionalString(value, 'reporterEmail', 255, details)?.toLowerCase();
  if (result && !REPORTER_EMAIL_PATTERN.test(result)) {
    details.push({
      field: 'reporterEmail',
      message: 'reporterEmail must be a valid email address.',
    });
    return undefined;
  }
  return result;
}

function readReporterPhone(value: unknown, details: Detail[]): string | undefined {
  const result = readOptionalString(value, 'reporterPhone', 32, details);
  if (result && !REPORTER_PHONE_PATTERN.test(result)) {
    details.push({
      field: 'reporterPhone',
      message: 'reporterPhone has an invalid format.',
    });
    return undefined;
  }
  return result;
}

function readStatus(
  value: unknown,
  details: Detail[],
): TenantServiceRequestStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTenantServiceRequestStatus(value)) {
    details.push({ field: 'status', message: `status must be one of: ${TENANT_SERVICE_REQUEST_STATUSES.join(', ')}.` });
    return undefined;
  }
  return value;
}
