import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_CAPABILITY_STATUSES,
  isVendorCapabilityStatus,
  type CreateVendorCapabilityInput,
  type UpdateVendorCapabilityInput,
  type UpdateVendorCapabilityStatusInput,
  type VendorCapabilityStatus,
} from './vendor-capability.types';

/**
 * Capability codes are the stable machine-readable identifier (e.g.
 * `ELECTRICAL`, `HVAC`, `FIRE_PROTECTION`). Normalized to uppercase,
 * matching every other code in the system: start with a letter; letters,
 * digits, hyphens, underscores. Codes are reference DATA — never behavior.
 */
const VENDOR_CAPABILITY_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_VENDOR_CAPABILITY_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeVendorCapabilityCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidVendorCapabilityCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_VENDOR_CAPABILITY_CODE_LENGTH &&
    VENDOR_CAPABILITY_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorCapabilityIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'vendorCapabilityId',
        message: 'Vendor capability id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseVendorCapabilityVendorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'vendorId', message: 'Vendor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVendorCapabilityBody(
  body: unknown,
): Omit<CreateVendorCapabilityInput, 'vendorId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const vendorBuildingRelationshipId = readRelationshipId(
    body.vendorBuildingRelationshipId,
    details,
  );
  const serviceCatalogId = readRelationshipId(
    body.serviceCatalogId,
    details,
  );
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(vendorBuildingRelationshipId === undefined
      ? {}
      : { vendorBuildingRelationshipId }),
    ...(serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorCapabilityBody(
  body: unknown,
): UpdateVendorCapabilityInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.vendorId !== undefined || body.code !== undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: body.vendorId !== undefined ? 'vendorId' : 'code',
        message: 'This field is immutable and cannot be updated.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const description =
    body.description === null
      ? null
      : readOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const vendorBuildingRelationshipId = readRelationshipId(
    body.vendorBuildingRelationshipId,
    details,
  );
  const serviceCatalogId = readRelationshipId(
    body.serviceCatalogId,
    details,
  );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(vendorBuildingRelationshipId === undefined
      ? {}
      : { vendorBuildingRelationshipId }),
    ...(serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorCapabilityStatusBody(
  body: unknown,
): UpdateVendorCapabilityStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${VENDOR_CAPABILITY_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Capability code is required.' });
    return undefined;
  }

  const normalized = normalizeVendorCapabilityCode(value);
  if (!isValidVendorCapabilityCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Capability code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Capability name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Capability name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Capability name must be at most ${MAX_NAME_LENGTH} characters.`,
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

/**
 * `vendorBuildingRelationshipId` scopes the capability to one BE-06D
 * relationship; explicit null returns it to vendor-wide.
 */
function readRelationshipId(
  value: unknown,
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
      field: 'vendorBuildingRelationshipId',
      message: 'vendorBuildingRelationshipId must be a valid UUID or null.',
    });
    return undefined;
  }

  return value.trim().toLowerCase();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VendorCapabilityStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorCapabilityStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_CAPABILITY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
