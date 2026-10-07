import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isPermitValidityStatus,
  PERMIT_VALIDITY_STATUSES,
} from '../permit-validities/permit-validity.types';
import {
  isPermitWorkLocationType,
  PERMIT_WORK_LOCATION_TYPES,
} from '../permit-work-contexts/permit-work-context.types';
import {
  isValidWorkType,
  normalizeWorkType,
} from '../work-orders/work-order.validation';
import {
  PERMIT_CONTRACTOR_CONTEXT_TYPES,
  PERMIT_STATUSES,
  isPermitContractorContextType,
  isPermitStatus,
  type CreatePermitInput,
  type PermitContractorContextType,
  type PermitFilters,
  type PermitStatus,
  type UpdatePermitInput,
} from './permit.types';

type ValidationDetail = { field: string; message: string };

const PERMIT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{0,99}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,99}$/;
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

export const parsePermitIdParam = (raw: string): string =>
  parseId(raw, 'permitId');

export function parseCreatePermitBody(body: unknown): CreatePermitInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const controlled = [
    'clientId',
    'status',
    'requestedAt',
    'createdByUserId',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (controlled) {
    fail([{ field: controlled, message: 'This field is controlled by the backend.' }]);
  }

  const details: ValidationDetail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const permitNumber = readPermitNumber(body.permitNumber, details);
  const permitType = readCode(body.permitType, 'permitType', details);
  const title = readText(body.title, 'title', 200, true, details);
  const workDescription = readText(
    body.workDescription,
    'workDescription',
    4000,
    true,
    details,
  );
  const applicantReference = readNullableText(
    body.applicantReference,
    'applicantReference',
    200,
    details,
  );
  const contractorContextType = readContractorContextType(
    body.contractorContextType,
    details,
  );
  const contractorContextId = readId(
    body.contractorContextId,
    'contractorContextId',
    true,
    details,
  );

  if (
    !buildingId ||
    !permitNumber ||
    !permitType ||
    !title ||
    !workDescription ||
    !contractorContextType ||
    !contractorContextId ||
    details.length > 0
  ) {
    fail(details);
  }

  return {
    buildingId,
    permitNumber,
    permitType,
    title,
    workDescription,
    ...(applicantReference !== undefined ? { applicantReference } : {}),
    contractorContextType,
    contractorContextId,
  };
}

export function parseUpdatePermitBody(body: unknown): UpdatePermitInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const immutable = [
    'clientId',
    'buildingId',
    'permitNumber',
    'contractorContextType',
    'contractorContextId',
    'contractorVendorId',
    'tenantContractorRelationshipId',
    'status',
    'requestedAt',
    'createdByUserId',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([{ field: immutable, message: 'This Permit context field is immutable.' }]);
  }

  const details: ValidationDetail[] = [];
  const permitType = body.permitType === undefined
    ? undefined
    : readCode(body.permitType, 'permitType', details);
  const title = body.title === undefined
    ? undefined
    : readText(body.title, 'title', 200, true, details);
  const workDescription = body.workDescription === undefined
    ? undefined
    : readText(
        body.workDescription,
        'workDescription',
        4000,
        true,
        details,
      );
  const applicantReference = readNullableText(
    body.applicantReference,
    'applicantReference',
    200,
    details,
  );

  const parsed: UpdatePermitInput = {
    ...(permitType ? { permitType } : {}),
    ...(title ? { title } : {}),
    ...(workDescription ? { workDescription } : {}),
    ...(applicantReference !== undefined ? { applicantReference } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one basic Permit metadata field is required.',
    });
  }
  if (details.length > 0) fail(details);
  return parsed;
}

export function parsePermitFilters(query: unknown): PermitFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const explicitContractorVendorId = readId(
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
  if (
    explicitContractorVendorId &&
    contractorId &&
    explicitContractorVendorId !== contractorId
  ) {
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
  const permitType = query.permitType === undefined
    ? undefined
    : readCode(query.permitType, 'permitType', details);
  const locationType = readPermitLocationType(query.locationType, details);
  const locationId = readId(query.locationId, 'locationId', false, details);
  const workType = readPermitWorkType(query.workType, details);
  const validityStatus = readPermitValidityStatus(
    query.validityStatus,
    details,
  );
  const validAt = readPermitValidAt(query.validAt, details);
  if (details.length > 0) fail(details);

  return {
    ...(buildingId ? { buildingId } : {}),
    ...(explicitContractorVendorId || contractorId
      ? { contractorVendorId: explicitContractorVendorId ?? contractorId }
      : {}),
    ...(contractorContextId ? { contractorContextId } : {}),
    ...(status ? { status } : {}),
    ...(permitType ? { permitType } : {}),
    ...(locationType ? { locationType } : {}),
    ...(locationId ? { locationId } : {}),
    ...(workType ? { workType } : {}),
    ...(validityStatus ? { validityStatus } : {}),
    ...(validAt ? { validAt } : {}),
  };
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

function readPermitNumber(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'permitNumber', message: 'permitNumber is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!PERMIT_NUMBER_PATTERN.test(normalized)) {
    details.push({
      field: 'permitNumber',
      message: 'permitNumber has an invalid format.',
    });
    return undefined;
  }
  return normalized;
}

function readCode(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    details.push({ field, message: `${field} must be a valid data-driven code.` });
    return undefined;
  }
  return normalized;
}

function readText(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field,
      message: `${field}${required ? ' is required' : ' must be a string'}.`,
    });
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

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readText(value, field, maxLength, false, details);
}

function readContractorContextType(
  value: unknown,
  details: ValidationDetail[],
): PermitContractorContextType | undefined {
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

function readPermitLocationType(
  value: unknown,
  details: ValidationDetail[],
): PermitFilters['locationType'] {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitWorkLocationType(normalized)) {
    details.push({
      field: 'locationType',
      message: `locationType must be one of: ${PERMIT_WORK_LOCATION_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readPermitWorkType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'workType', message: 'workType must be a string.' });
    return undefined;
  }
  const normalized = normalizeWorkType(value);
  if (!isValidWorkType(normalized)) {
    details.push({
      field: 'workType',
      message: 'workType must be a valid controlled data code.',
    });
    return undefined;
  }
  return normalized;
}

function readPermitValidityStatus(
  value: unknown,
  details: ValidationDetail[],
): PermitFilters['validityStatus'] {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitValidityStatus(normalized)) {
    details.push({
      field: 'validityStatus',
      message: `validityStatus must be one of: ${PERMIT_VALIDITY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readPermitValidAt(
  value: unknown,
  details: ValidationDetail[],
): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({
      field: 'validAt',
      message: 'validAt must be an ISO-8601 date-time with a timezone.',
    });
    return undefined;
  }
  const result = new Date(value.trim());
  if (Number.isNaN(result.getTime())) {
    details.push({ field: 'validAt', message: 'validAt must be valid.' });
    return undefined;
  }
  return result;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PermitStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitStatus(normalized)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${PERMIT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}
