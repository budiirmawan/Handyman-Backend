import { AppError } from '../../shared/errors';
import type {
  CreateSaasPackageInput,
  CreateSaasProductInput,
  ListSaasPackageFilters,
  ListSaasProductFilters,
  UpdateSaasPackageInput,
  UpdateSaasProductInput,
} from './platform-product.types';

/**
 * CR-BE-SAAS-01 PART 02 — catalog request parsing.
 *
 * Validation here is structural (types, presence, obvious ranges).
 * Domain authority (catalog semantics, capability existence, frozen limit
 * vocabulary) lives in the service layer.
 */

type Detail = { field: string; message: string };

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readOptionalString(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxLength: number,
): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  if (value.length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
  }
  return value;
}

function readRequiredString(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  if (value.length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
  }
  return value;
}

function readStatus(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
): 'ACTIVE' | 'INACTIVE' | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value !== 'ACTIVE' && value !== 'INACTIVE') {
    details.push({ field, message: `${field} must be ACTIVE or INACTIVE.` });
    return undefined;
  }
  return value;
}

function readOptionalUuid(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    details.push({ field, message: `${field} must be a UUID.` });
    return undefined;
  }
  return value;
}

function readUuidParam(raw: string | string[], field: string): string {
  const value = Array.isArray(raw) ? '' : raw;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    fail([{ field, message: `${field} must be a UUID.` }]);
  }
  return value;
}

/** Express 5 types path params as `string | string[]`; normalize. */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export function parseCreateSaasProductBody(
  body: unknown,
): CreateSaasProductInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;
  const code = readRequiredString(record, 'code', details, 64);
  const name = readRequiredString(record, 'name', details, 255);
  const description = readOptionalString(record, 'description', details, 2000);
  const status = readStatus(record, 'status', details);
  if (details.length > 0) fail(details);
  return {
    code: code!,
    name: name!,
    description: description ?? undefined,
    status,
  };
}

export function parseUpdateSaasProductBody(
  body: unknown,
): UpdateSaasProductInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;
  // name is non-nullable: explicit null is a validation error, absence is OK.
  if (record['name'] === null) {
    details.push({ field: 'name', message: 'name must be a string.' });
  }
  const name = readOptionalString(record, 'name', details, 255) ?? undefined;
  const description = readOptionalString(record, 'description', details, 2000);
  const status = readStatus(record, 'status', details);
  if (name === undefined && description === undefined && status === undefined) {
    details.push({
      field: 'body',
      message: 'Provide at least one of name, description, status.',
    });
  }
  if (details.length > 0) fail(details);
  return {
    name,
    description,
    status,
  };
}

export function parseListSaasProductFilters(
  query: Record<string, unknown>,
): ListSaasProductFilters {
  const details: Detail[] = [];
  const filters: ListSaasProductFilters = {};
  if (query.status !== undefined) {
    const value = paramString(query.status as string | string[]);
    if (value !== 'ACTIVE' && value !== 'INACTIVE') {
      details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
    } else {
      filters.status = value;
    }
  }
  if (details.length > 0) fail(details);
  return filters;
}

export function parseProductIdParam(raw: string | string[]): string {
  return readUuidParam(raw, 'id');
}

export function parsePackageFeatureInput(
  value: unknown,
  index: number,
  details: Detail[],
): { capabilityCode: string; enabled?: boolean } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    details.push({ field: `features[${index}]`, message: 'must be an object.' });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const capabilityCode = record.capabilityCode;
  if (
    typeof capabilityCode !== 'string' ||
    capabilityCode.trim() === '' ||
    capabilityCode.length > 64
  ) {
    details.push({
      field: `features[${index}].capabilityCode`,
      message: 'capabilityCode is required (max 64 characters).',
    });
    return undefined;
  }
  const enabled = record.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    details.push({
      field: `features[${index}].enabled`,
      message: 'enabled must be a boolean.',
    });
    return undefined;
  }
  return { capabilityCode, enabled };
}

export function parsePackageLimitInput(
  value: unknown,
  index: number,
  details: Detail[],
): { limitKey: string; limitValue: number; unit: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    details.push({ field: `limits[${index}]`, message: 'must be an object.' });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const limitKey = record.limitKey;
  if (typeof limitKey !== 'string' || limitKey.trim() === '' || limitKey.length > 64) {
    details.push({
      field: `limits[${index}].limitKey`,
      message: 'limitKey is required (max 64 characters).',
    });
    return undefined;
  }
  const limitValue = record.limitValue;
  if (
    typeof limitValue !== 'number' ||
    !Number.isFinite(limitValue) ||
    !Number.isInteger(limitValue) ||
    limitValue < 0
  ) {
    details.push({
      field: `limits[${index}].limitValue`,
      message: 'limitValue must be a non-negative integer.',
    });
    return undefined;
  }
  const unit = record.unit;
  if (typeof unit !== 'string' || unit.trim() === '' || unit.length > 50) {
    details.push({
      field: `limits[${index}].unit`,
      message: 'unit is required (max 50 characters).',
    });
    return undefined;
  }
  return { limitKey, limitValue, unit };
}

function readOptionalArray(
  record: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxItems: number,
): unknown[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    details.push({ field, message: `${field} must be an array.` });
    return undefined;
  }
  if (value.length > maxItems) {
    details.push({ field, message: `${field} must have at most ${maxItems} entries.` });
  }
  return value;
}

export function parseCreateSaasPackageBody(
  body: unknown,
): CreateSaasPackageInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  const productId = readOptionalUuid(record, 'productId', details);
  if (productId === undefined) {
    details.push({ field: 'productId', message: 'productId is required.' });
  }
  const code = readRequiredString(record, 'code', details, 64);
  const name = readRequiredString(record, 'name', details, 255);
  const description = readOptionalString(record, 'description', details, 2000);
  const status = readStatus(record, 'status', details);

  const rawFeatures = readOptionalArray(record, 'features', details, 500);
  const features = rawFeatures?.map((value, index) =>
    parsePackageFeatureInput(value, index, details),
  );
  const rawLimits = readOptionalArray(record, 'limits', details, 500);
  const limits = rawLimits?.map((value, index) =>
    parsePackageLimitInput(value, index, details),
  );

  if (details.length > 0) fail(details);
  return {
    productId: productId!,
    code: code!,
    name: name!,
    description: description ?? undefined,
    status,
    features: features as CreateSaasPackageInput['features'],
    limits: limits as CreateSaasPackageInput['limits'],
  };
}

export function parseUpdateSaasPackageBody(
  body: unknown,
): UpdateSaasPackageInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  // name is non-nullable: explicit null is a validation error, absence is OK.
  if (record['name'] === null) {
    details.push({ field: 'name', message: 'name must be a string.' });
  }
  const name = readOptionalString(record, 'name', details, 255) ?? undefined;
  const description = readOptionalString(record, 'description', details, 2000);
  const status = readStatus(record, 'status', details);

  const rawFeatures = readOptionalArray(record, 'features', details, 500);
  const features = rawFeatures?.map((value, index) =>
    parsePackageFeatureInput(value, index, details),
  );
  const rawLimits = readOptionalArray(record, 'limits', details, 500);
  const limits = rawLimits?.map((value, index) =>
    parsePackageLimitInput(value, index, details),
  );

  if (
    name === undefined &&
    description === undefined &&
    status === undefined &&
    features === undefined &&
    limits === undefined
  ) {
    details.push({
      field: 'body',
      message: 'Provide at least one updatable field.',
    });
  }
  if (details.length > 0) fail(details);
  return {
    name,
    description,
    status,
    features: features as UpdateSaasPackageInput['features'],
    limits: limits as UpdateSaasPackageInput['limits'],
  };
}

export function parseListSaasPackageFilters(
  query: Record<string, unknown>,
): ListSaasPackageFilters {
  const details: Detail[] = [];
  const filters: ListSaasPackageFilters = {};
  if (query.productId !== undefined) {
    const value = paramString(query.productId as string | string[]);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ) {
      details.push({ field: 'productId', message: 'productId must be a UUID.' });
    } else {
      filters.productId = value;
    }
  }
  if (query.status !== undefined) {
    const value = paramString(query.status as string | string[]);
    if (value !== 'ACTIVE' && value !== 'INACTIVE') {
      details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
    } else {
      filters.status = value;
    }
  }
  if (details.length > 0) fail(details);
  return filters;
}

export function parsePackageIdParam(raw: string | string[]): string {
  return readUuidParam(raw, 'id');
}
