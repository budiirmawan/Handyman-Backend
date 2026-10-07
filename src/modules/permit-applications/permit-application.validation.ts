import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PERMIT_CONTRACTOR_CONTEXT_TYPES,
  isPermitContractorContextType,
  type PermitContractorContextType,
} from '../permits/permit.types';
import {
  PERMIT_APPLICATION_STATUSES,
  isPermitApplicationStatus,
  type CreatePermitApplicationInput,
  type PermitApplicationFilters,
  type PermitApplicationStatus,
  type UpdatePermitApplicationInput,
} from './permit-application.types';

type ValidationDetail = { field: string; message: string };
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export const parsePermitApplicationIdParam = (raw: string): string =>
  parseId(raw, 'permitApplicationId');

export function parseCreatePermitApplicationBody(
  body: unknown,
): CreatePermitApplicationInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const controlled = [
    'clientId',
    'buildingId',
    'permitReference',
    'permitStatus',
    'status',
    'submittedAt',
    'submittedByUserId',
    'cancelledAt',
    'cancelledByUserId',
    'createdByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (controlled) {
    fail([{ field: controlled, message: 'This field is controlled by the backend.' }]);
  }

  const details: ValidationDetail[] = [];
  const permitId = readId(body.permitId, 'permitId', true, details);
  const requestedWorkAt = readTimestamp(
    body.requestedWorkAt,
    'requestedWorkAt',
    true,
    details,
  );
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  const applicantReference = readNullableText(
    body.applicantReference,
    'applicantReference',
    200,
    details,
  );
  const workDescription = body.workDescription === undefined
    ? undefined
    : readRequiredText(
        body.workDescription,
        'workDescription',
        4000,
        details,
      );
  const contractorContextType = readContractorContextType(
    body.contractorContextType,
    details,
  );
  const contractorContextId = readId(
    body.contractorContextId,
    'contractorContextId',
    false,
    details,
  );
  if (
    (contractorContextType === undefined) !==
    (contractorContextId === undefined)
  ) {
    details.push({
      field: 'contractorContext',
      message: 'contractorContextType and contractorContextId must be supplied together.',
    });
  }
  if (!permitId || !requestedWorkAt || details.length > 0) fail(details);

  return {
    permitId,
    requestedWorkAt,
    ...(notes !== undefined ? { notes } : {}),
    ...(applicantReference !== undefined ? { applicantReference } : {}),
    ...(workDescription !== undefined ? { workDescription } : {}),
    ...(contractorContextType ? { contractorContextType } : {}),
    ...(contractorContextId ? { contractorContextId } : {}),
  };
}

export function parseUpdatePermitApplicationBody(
  body: unknown,
): UpdatePermitApplicationInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const immutable = [
    'permitId',
    'permitReference',
    'clientId',
    'buildingId',
    'applicantReference',
    'contractorContextType',
    'contractorContextId',
    'contractorVendorId',
    'tenantContractorRelationshipId',
    'workDescription',
    'status',
    'submittedAt',
    'submittedByUserId',
    'cancelledAt',
    'cancelledByUserId',
    'createdByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([{
      field: immutable,
      message: 'This field is inherited or controlled and cannot be updated on the Application.',
    }]);
  }

  const details: ValidationDetail[] = [];
  const requestedWorkAt = body.requestedWorkAt === undefined
    ? undefined
    : readTimestamp(
        body.requestedWorkAt,
        'requestedWorkAt',
        true,
        details,
      );
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  const parsed: UpdatePermitApplicationInput = {
    ...(requestedWorkAt ? { requestedWorkAt } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one DRAFT Application field is required.',
    });
  }
  if (details.length > 0) fail(details);
  return parsed;
}

export function parsePermitApplicationFilters(
  query: unknown,
): PermitApplicationFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const explicitVendorId = readId(
    query.contractorVendorId,
    'contractorVendorId',
    false,
    details,
  );
  const contractorId = readId(
    query.contractorId,
    'contractorId',
    false,
    details,
  );
  if (explicitVendorId && contractorId && explicitVendorId !== contractorId) {
    details.push({
      field: 'contractorId',
      message: 'contractorId and contractorVendorId must identify the same Vendor.',
    });
  }
  const contractorContextId = readId(
    query.contractorContextId,
    'contractorContextId',
    false,
    details,
  );
  const status = readStatus(query.status, details);
  const requestedWorkFrom = readAliasedTimestamp(
    query.requestedWorkFrom,
    query.dateFrom,
    'requestedWorkFrom',
    'dateFrom',
    details,
  );
  const requestedWorkTo = readAliasedTimestamp(
    query.requestedWorkTo,
    query.dateTo,
    'requestedWorkTo',
    'dateTo',
    details,
  );
  const requestedWorkDate = readDate(
    query.requestedWorkDate ?? query.date,
    'requestedWorkDate',
    details,
  );
  if (
    requestedWorkFrom &&
    requestedWorkTo &&
    requestedWorkTo.getTime() < requestedWorkFrom.getTime()
  ) {
    details.push({
      field: 'requestedWorkTo',
      message: 'requestedWorkTo must not be before requestedWorkFrom.',
    });
  }
  if (details.length > 0) fail(details);
  const contractorVendorId = explicitVendorId ?? contractorId;
  return {
    ...(buildingId ? { buildingId } : {}),
    ...(contractorVendorId ? { contractorVendorId } : {}),
    ...(contractorContextId ? { contractorContextId } : {}),
    ...(status ? { status } : {}),
    ...(requestedWorkFrom ? { requestedWorkFrom } : {}),
    ...(requestedWorkTo ? { requestedWorkTo } : {}),
    ...(requestedWorkDate ? { requestedWorkDate } : {}),
  };
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
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
  const normalized = value.trim();
  if (!isCalendarDate(normalized.slice(0, 10))) {
    details.push({ field, message: `${field} contains an invalid calendar date.` });
    return undefined;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid date and time.` });
    return undefined;
  }
  return parsed;
}

function readAliasedTimestamp(
  primary: unknown,
  alias: unknown,
  primaryField: string,
  aliasField: string,
  details: ValidationDetail[],
): Date | undefined {
  const primaryDate = readTimestamp(primary, primaryField, false, details);
  const aliasDate = readTimestamp(alias, aliasField, false, details);
  if (
    primaryDate &&
    aliasDate &&
    primaryDate.getTime() !== aliasDate.getTime()
  ) {
    details.push({
      field: primaryField,
      message: `${primaryField} and ${aliasField} must be the same date-time.`,
    });
  }
  return primaryDate ?? aliasDate;
}

function readDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !DATE_ONLY.test(value) ||
    !isCalendarDate(value)
  ) {
    details.push({ field, message: `${field} must be a valid YYYY-MM-DD date.` });
    return undefined;
  }
  return value;
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
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
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return result;
}

function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} must be a non-empty string.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return result;
}

function readContractorContextType(
  value: unknown,
  details: ValidationDetail[],
): PermitContractorContextType | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitContractorContextType(normalized)) {
    details.push({
      field: 'contractorContextType',
      message: `contractorContextType must be one of: ${PERMIT_CONTRACTOR_CONTEXT_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PermitApplicationStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitApplicationStatus(normalized)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${PERMIT_APPLICATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}
