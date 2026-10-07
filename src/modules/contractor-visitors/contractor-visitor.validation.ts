import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  CONTRACTOR_VISITOR_STATUSES,
  isContractorVisitorStatus,
  type ContractorVisitorListFilters,
  type ContractorVisitorStatus,
  type CreateContractorVisitorInput,
  type UpdateContractorVisitorInput,
} from './contractor-visitor.types';

export type ValidationDetail = { field: string; message: string };

const MAX_COMPANY_LENGTH = 255;
const MAX_PURPOSE_LENGTH = 1024;
const MAX_HOST_NAME_LENGTH = 255;
const MAX_WORK_LOCATION_LENGTH = 512;
const MAX_NOTES_LENGTH = 4096;
const MAX_SEARCH_LENGTH = 255;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseContractorVisitorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Contractor visitor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateContractorVisitorBody(
  body: unknown,
): Omit<CreateContractorVisitorInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const buildingId = readOptionalUuid(body.buildingId, 'buildingId', details);
  const visitorId = readOptionalUuid(body.visitorId, 'visitorId', details);
  const expectedVisitorId = readOptionalUuid(
    body.expectedVisitorId,
    'expectedVisitorId',
    details,
  );
  const walkInVisitId = readOptionalUuid(
    body.walkInVisitId,
    'walkInVisitId',
    details,
  );
  const contractorCompany = readRequiredText(
    body.contractorCompany,
    'contractorCompany',
    MAX_COMPANY_LENGTH,
    details,
  );
  const contractorPurpose = readRequiredText(
    body.contractorPurpose,
    'contractorPurpose',
    MAX_PURPOSE_LENGTH,
    details,
  );
  const responsibleHostUserId = readOptionalNullableUuid(
    body.responsibleHostUserId,
    'responsibleHostUserId',
    details,
  );
  const responsibleHostWorkforceId = readOptionalNullableUuid(
    body.responsibleHostWorkforceId,
    'responsibleHostWorkforceId',
    details,
  );
  const responsibleHostName = readOptionalText(
    body.responsibleHostName,
    'responsibleHostName',
    MAX_HOST_NAME_LENGTH,
    details,
  );
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );
  const workLocation = readOptionalText(
    body.workLocation,
    'workLocation',
    MAX_WORK_LOCATION_LENGTH,
    details,
  );
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!contractorCompany || !contractorPurpose || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    contractorCompany,
    contractorPurpose,
    ...(responsibleHostUserId === undefined
      ? {}
      : { responsibleHostUserId }),
    ...(responsibleHostWorkforceId === undefined
      ? {}
      : { responsibleHostWorkforceId }),
    ...(responsibleHostName === undefined ? {} : { responsibleHostName }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(workLocation === undefined ? {} : { workLocation }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateContractorVisitorBody(
  body: unknown,
): UpdateContractorVisitorInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateContractorVisitorInput = {};

  assignText(
    input,
    'contractorCompany',
    body.contractorCompany,
    MAX_COMPANY_LENGTH,
    details,
    true,
  );
  assignText(
    input,
    'contractorPurpose',
    body.contractorPurpose,
    MAX_PURPOSE_LENGTH,
    details,
    true,
  );
  assignNullableUuid(
    input,
    'responsibleHostUserId',
    body.responsibleHostUserId,
    details,
  );
  assignNullableUuid(
    input,
    'responsibleHostWorkforceId',
    body.responsibleHostWorkforceId,
    details,
  );
  assignText(
    input,
    'responsibleHostName',
    body.responsibleHostName,
    MAX_HOST_NAME_LENGTH,
    details,
    false,
  );
  assignNullableUuid(
    input,
    'functionalLocationId',
    body.functionalLocationId,
    details,
  );
  assignText(
    input,
    'workLocation',
    body.workLocation,
    MAX_WORK_LOCATION_LENGTH,
    details,
    false,
  );
  assignText(input, 'notes', body.notes, MAX_NOTES_LENGTH, details, false);

  if (body.status !== undefined) {
    const status = readStatus(body.status, details);
    if (status) input.status = status;
  }

  if (Object.keys(input).length === 0) {
    details.push({
      field: 'body',
      message: 'At least one updatable field is required.',
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return input;
}

export function parseContractorVisitorListQuery(
  query: Record<string, unknown>,
): ContractorVisitorListFilters {
  const details: ValidationDetail[] = [];
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const visitorId = readOptionalUuid(query.visitorId, 'visitorId', details);
  const expectedVisitorId = readOptionalUuid(
    query.expectedVisitorId,
    'expectedVisitorId',
    details,
  );
  const walkInVisitId = readOptionalUuid(
    query.walkInVisitId,
    'walkInVisitId',
    details,
  );
  const status = readStatus(readSingle(query.status), details);
  const search = readOptionalSearch(query.search, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    ...(status === undefined ? {} : { status }),
    ...(search === undefined ? {} : { search }),
  };
}

function readSingle(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingle(value);
  if (single === undefined || single === null || single === '') return undefined;
  if (typeof single !== 'string' || !isValidUuid(single.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return single.trim().toLowerCase();
}

function readOptionalNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequiredText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): ContractorVisitorStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isContractorVisitorStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${CONTRACTOR_VISITOR_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalSearch(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingle(value);
  if (single === undefined || single === null || single === '') return undefined;
  if (typeof single !== 'string') {
    details.push({ field: 'search', message: 'search must be a string.' });
    return undefined;
  }
  const trimmed = single.trim();
  if (trimmed.length > MAX_SEARCH_LENGTH) {
    details.push({
      field: 'search',
      message: `search must be at most ${MAX_SEARCH_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed === '' ? undefined : trimmed;
}

function assignText<K extends keyof UpdateContractorVisitorInput>(
  target: UpdateContractorVisitorInput,
  key: K,
  value: unknown,
  max: number,
  details: ValidationDetail[],
  required: boolean,
): void {
  if (value === undefined) return;
  const parsed = required
    ? readRequiredText(value, String(key), max, details)
    : readOptionalText(value, String(key), max, details);
  if (parsed !== undefined) {
    (target as Record<string, unknown>)[key] = parsed;
  }
}

function assignNullableUuid<K extends keyof UpdateContractorVisitorInput>(
  target: UpdateContractorVisitorInput,
  key: K,
  value: unknown,
  details: ValidationDetail[],
): void {
  if (value === undefined) return;
  const parsed = readOptionalNullableUuid(value, String(key), details);
  if (parsed !== undefined) {
    (target as Record<string, unknown>)[key] = parsed;
  }
}
