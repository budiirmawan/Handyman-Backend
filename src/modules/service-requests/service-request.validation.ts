import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isServiceRequestStatus,
  SERVICE_REQUEST_STATUSES,
  type CreateServiceRequestInput,
  type ServiceRequestFilters,
  type ServiceRequestStatus,
  type UpdateServiceRequestInput,
} from './service-request.types';

const SERVICE_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_SERVICE_TYPE_LENGTH = 64;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_NOTES_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeServiceType(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidServiceType(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= MAX_SERVICE_TYPE_LENGTH &&
    SERVICE_TYPE_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function readUuidOrNull(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID or null.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequiredDate(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    details.push({
      field: 'requiredDate',
      message: 'requiredDate must be a valid ISO date string or null.',
    });
    return undefined;
  }
  return value;
}

function readNotes(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'notes', message: 'notes must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    details.push({
      field: 'notes',
      message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableNotes(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readNotes(value, details);
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): ServiceRequestStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isServiceRequestStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${SERVICE_REQUEST_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readServiceType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'serviceType',
      message: 'Service type is required.',
    });
    return undefined;
  }

  const normalized = normalizeServiceType(value);
  if (!isValidServiceType(normalized)) {
    details.push({
      field: 'serviceType',
      message:
        'Service type must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readTitle(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'title',
      message: 'Service request title is required.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({
      field: 'title',
      message: 'Service request title is required.',
    });
    return undefined;
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    details.push({
      field: 'title',
      message: `Service request title must be at most ${MAX_TITLE_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalString(value, field, maxLength, details);
}

export function parseServiceRequestIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'serviceRequestId',
        message: 'Service request id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parsePurchaseRequestIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'purchaseRequestId',
        message: 'Purchase request id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseServiceRequestFilters(
  query: unknown,
): ServiceRequestFilters {
  if (!isRecord(query)) {
    return {};
  }

  const details: ValidationDetail[] = [];
  const status = readStatus(query.status, details);
  const purchaseRequestId =
    query.purchaseRequestId === undefined
      ? undefined
      : readUuid(query.purchaseRequestId, 'purchaseRequestId', details);
  const serviceType =
    query.serviceType === undefined
      ? undefined
      : readServiceType(query.serviceType, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(purchaseRequestId === undefined ? {} : { purchaseRequestId }),
    ...(serviceType === undefined ? {} : { serviceType }),
  };
}

export function parseCreateServiceRequestBody(
  body: unknown,
): Omit<CreateServiceRequestInput, 'purchaseRequestId' | 'requestedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const serviceType = readServiceType(body.serviceType, details);
  const title = readTitle(body.title, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const requiredDate = readRequiredDate(body.requiredDate, details);
  const functionalLocationId = readUuidOrNull(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );
  const vendorId = readUuidOrNull(body.vendorId, 'vendorId', details);
  const serviceCatalogId = readUuidOrNull(
    body.serviceCatalogId,
    'serviceCatalogId',
    details,
  );
  const notes = readNotes(body.notes, details);

  if (!serviceType || !title || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    serviceType,
    title,
    ...(description === undefined ? {} : { description }),
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateServiceRequestBody(
  body: unknown,
): UpdateServiceRequestInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const serviceType =
    body.serviceType === undefined
      ? undefined
      : readServiceType(body.serviceType, details);
  const title =
    body.title === undefined ? undefined : readTitle(body.title, details);
  const description =
    body.description === undefined
      ? undefined
      : readNullableOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const requiredDate =
    body.requiredDate === undefined
      ? undefined
      : readRequiredDate(body.requiredDate, details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readUuidOrNull(body.functionalLocationId, 'functionalLocationId', details);
  const vendorId =
    body.vendorId === undefined
      ? undefined
      : readUuidOrNull(body.vendorId, 'vendorId', details);
  const serviceCatalogId =
    body.serviceCatalogId === undefined
      ? undefined
      : readUuidOrNull(body.serviceCatalogId, 'serviceCatalogId', details);
  const notes =
    body.notes === undefined ? undefined : readNullableNotes(body.notes, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(serviceType === undefined ? {} : { serviceType }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(notes === undefined ? {} : { notes }),
  };
}
