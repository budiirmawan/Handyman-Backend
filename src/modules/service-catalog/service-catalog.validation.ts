import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isServiceCatalogStatus,
  SERVICE_CATALOG_CODE_MAX_LENGTH,
  SERVICE_CATALOG_CODE_MIN_LENGTH,
  SERVICE_CATALOG_CODE_PATTERN,
  type CreateServiceCatalogEntryInput,
  type ServiceCatalogFilters,
  type UpdateServiceCatalogEntryInput,
} from './service-catalog.types';

export type ValidationDetail = { field: string; message: string };

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_CATEGORY_LENGTH = 100;
const MAX_SEARCH_LENGTH = 200;

/** Server-side normalization: trim + uppercase, matching service-request's service_type. */
export function normalizeServiceCatalogCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidServiceCatalogCode(value: string): boolean {
  return (
    value.length >= SERVICE_CATALOG_CODE_MIN_LENGTH &&
    value.length <= SERVICE_CATALOG_CODE_MAX_LENGTH &&
    SERVICE_CATALOG_CODE_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field, message: `${field} is required.` });
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

function readOptionalText(
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

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalText(value, field, maxLength, details);
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'code is required.' });
    return undefined;
  }
  const normalized = normalizeServiceCatalogCode(value);
  if (!isValidServiceCatalogCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }
  return normalized;
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

export function parseServiceCatalogIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Service catalog entry id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateServiceCatalogEntryBody(
  body: unknown,
): Omit<CreateServiceCatalogEntryInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const clientId = readRequiredUuid(body.clientId, 'clientId', details);
  const code = readCode(body.code, details);
  const name = readRequiredText(body.name, 'name', MAX_NAME_LENGTH, details);
  const category = readRequiredText(
    body.category,
    'category',
    MAX_CATEGORY_LENGTH,
    details,
  );
  const description = readOptionalText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );

  if (!clientId || !code || !name || !category || details.length > 0) {
    fail(details);
  }

  return {
    clientId,
    code,
    name,
    category,
    ...(description === undefined ? {} : { description }),
  };
}

export function parseUpdateServiceCatalogEntryBody(
  body: unknown,
): UpdateServiceCatalogEntryInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  // `code` is immutable (governance §5/§11). If a caller supplies it, reject
  // explicitly so the immutability is a governed, messageable outcome rather
  // than a silent ignore.
  if (body.code !== undefined) {
    details.push({
      field: 'code',
      message:
        'code is immutable; create a new entry to change a service identity.',
    });
  }

  const name =
    body.name === undefined
      ? undefined
      : readRequiredText(body.name, 'name', MAX_NAME_LENGTH, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const category =
    body.category === undefined
      ? undefined
      : readRequiredText(body.category, 'category', MAX_CATEGORY_LENGTH, details);

  if (details.length > 0) {
    fail(details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
  };
}

export function parseServiceCatalogFilters(
  query: unknown,
): ServiceCatalogFilters {
  if (!isRecord(query)) {
    return {};
  }

  const details: ValidationDetail[] = [];
  const filters: ServiceCatalogFilters = {};

  const clientIdRaw = first(query.clientId);
  if (clientIdRaw !== undefined && clientIdRaw !== '') {
    const clientId = readRequiredUuid(clientIdRaw, 'clientId', details);
    if (clientId) filters.clientId = clientId;
  }

  const statusRaw = first(query.status);
  if (statusRaw !== undefined && statusRaw !== '') {
    if (isServiceCatalogStatus(statusRaw)) {
      filters.status = statusRaw;
    } else {
      details.push({
        field: 'status',
        message: 'status must be one of: ACTIVE, INACTIVE.',
      });
    }
  }

  const categoryRaw = first(query.category);
  if (categoryRaw !== undefined && categoryRaw !== '') {
    const category = readOptionalText(
      categoryRaw,
      'category',
      MAX_CATEGORY_LENGTH,
      details,
    );
    if (category) filters.category = category;
  }

  const searchRaw = first(query.search);
  if (searchRaw !== undefined && searchRaw !== '') {
    const search = readOptionalText(searchRaw, 'search', MAX_SEARCH_LENGTH, details);
    if (search) filters.search = search;
  }

  if (details.length > 0) {
    fail(details);
  }

  return filters;
}
