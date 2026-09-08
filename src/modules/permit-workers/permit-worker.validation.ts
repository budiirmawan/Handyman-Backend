import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isPermitContractorContextType,
} from '../permits/permit.types';
import {
  isValidRequestType,
  normalizeRequestType,
} from '../work-requests';
import {
  PERMIT_WORKER_STATUSES,
  isPermitWorkerStatus,
  type AddPermitWorkerInput,
  type PermitWorkerFilters,
  type PermitWorkerStatus,
  type UpdatePermitWorkerInput,
} from './permit-worker.types';

type ValidationDetail = { field: string; message: string };
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export const parsePermitWorkerIdParam = (raw: string): string =>
  parseId(raw, 'permitWorkerId');
export const parsePermitWorkerPermitIdParam = (raw: string): string =>
  parseId(raw, 'permitId');

export function parseAddPermitWorkerBody(body: unknown): AddPermitWorkerInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const controlled = [
    'workerName',
    'employeeCode',
    'vendorPersonnelCode',
    'identificationReference',
    'status',
    'deactivatedAt',
    'deactivatedByUserId',
    'createdByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (controlled) {
    fail([{ field: controlled, message: 'This Worker field is backend-resolved.' }]);
  }
  const details: ValidationDetail[] = [];
  const permitApplicationId = readId(
    body.permitApplicationId,
    'permitApplicationId',
    true,
    details,
  );
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const workforceProfileId = readId(
    body.workforceProfileId ?? body.workerPersonReference,
    'workforceProfileId',
    true,
    details,
  );
  const vendorWorkforceBindingId = readId(
    body.vendorWorkforceBindingId,
    'vendorWorkforceBindingId',
    false,
    details,
  );
  const roleTrade = readRoleTrade(body.roleTrade, true, details);
  const validFrom = readTimestamp(body.validFrom, 'validFrom', false, details);
  const validUntil = readTimestamp(body.validUntil, 'validUntil', false, details);
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime()) {
    details.push({ field: 'validUntil', message: 'validUntil must be after validFrom.' });
  }
  if (
    !permitApplicationId ||
    !buildingId ||
    !workforceProfileId ||
    !roleTrade ||
    details.length > 0
  ) {
    fail(details);
  }
  return {
    permitApplicationId,
    buildingId,
    workforceProfileId,
    ...(vendorWorkforceBindingId ? { vendorWorkforceBindingId } : {}),
    roleTrade,
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdatePermitWorkerBody(
  body: unknown,
): UpdatePermitWorkerInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const immutable = [
    'permitId',
    'permitApplicationId',
    'buildingId',
    'contractorContextType',
    'contractorContextId',
    'contractorVendorId',
    'workforceProfileId',
    'vendorWorkforceBindingId',
    'workerName',
    'employeeCode',
    'vendorPersonnelCode',
    'status',
    'deactivatedAt',
    'deactivatedByUserId',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([{ field: immutable, message: 'This Worker context field is immutable.' }]);
  }
  const details: ValidationDetail[] = [];
  const roleTrade = readRoleTrade(body.roleTrade, false, details);
  const validFrom = readTimestamp(body.validFrom, 'validFrom', false, details);
  const validUntil = readTimestamp(body.validUntil, 'validUntil', false, details);
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  const parsed: UpdatePermitWorkerInput = {
    ...(roleTrade ? { roleTrade } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({ field: 'body', message: 'At least one Worker field is required.' });
  }
  if (details.length > 0) fail(details);
  return parsed;
}

export function parsePermitWorkerFilters(query: unknown): PermitWorkerFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const permitId = readId(query.permitId, 'permitId', false, details);
  const permitApplicationId = readId(
    query.permitApplicationId,
    'permitApplicationId',
    false,
    details,
  );
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const contractorVendorId = readId(
    query.contractorVendorId ?? query.contractorId,
    'contractorVendorId',
    false,
    details,
  );
  const contractorContextId = readId(
    query.contractorContextId,
    'contractorContextId',
    false,
    details,
  );
  const workforceProfileId = readId(
    query.workforceProfileId,
    'workforceProfileId',
    false,
    details,
  );
  const contractorContextType = readContractorContextType(
    query.contractorContextType ?? query.sourceType,
    details,
  );
  const status = readStatus(query.status, details);
  if (details.length > 0) fail(details);
  return {
    ...(permitId ? { permitId } : {}),
    ...(permitApplicationId ? { permitApplicationId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(contractorContextType ? { contractorContextType } : {}),
    ...(contractorContextId ? { contractorContextId } : {}),
    ...(contractorVendorId ? { contractorVendorId } : {}),
    ...(workforceProfileId ? { workforceProfileId } : {}),
    ...(status ? { status } : {}),
  };
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRoleTrade(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'roleTrade', message: 'roleTrade is required.' });
    return undefined;
  }
  const normalized = normalizeRequestType(value);
  if (!isValidRequestType(normalized)) {
    details.push({ field: 'roleTrade', message: 'roleTrade must be a valid data-driven code.' });
    return undefined;
  }
  return normalized;
}

function readTimestamp(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): Date | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({
      field,
      message: `${field} must be an ISO-8601 date-time with a timezone.`,
    });
    return undefined;
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be valid.` });
    return undefined;
  }
  return parsed;
}

function readContractorContextType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitContractorContextType(normalized)) {
    details.push({
      field: 'contractorContextType',
      message: 'contractorContextType must be TENANT_CONTRACTOR or VENDOR_CONTRACTOR.',
    });
    return undefined;
  }
  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PermitWorkerStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitWorkerStatus(normalized)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${PERMIT_WORKER_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length === 0) return null;
  if (result.length > maxLength) {
    details.push({ field, message: `${field} is too long.` });
    return undefined;
  }
  return result;
}
