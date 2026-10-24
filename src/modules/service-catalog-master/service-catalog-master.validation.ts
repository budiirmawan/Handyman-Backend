import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isPriceCatalogCurrency,
  type PriceCatalogCurrency,
} from '../price-catalog-entries/price-catalog-entry.types';
import {
  isValidServiceCatalogCode,
  normalizeServiceCatalogCode,
} from '../service-catalog/service-catalog.validation';
import {
  isServiceCategoryStatus,
  type CreateServiceCategoryInput,
  type ServiceCategoryFilters,
  type ServiceCategoryStatus,
  type UpdateServiceCategoryInput,
} from './service-catalog-master.types';

export type ValidationDetail = { field: string; message: string };

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;

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
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
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
  if (value === null) return null;
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

export function parseServiceCategoryIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Service category id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseServiceCatalogAvailabilityIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'availabilityId',
        message: 'Availability grant id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateServiceCategoryBody(
  body: unknown,
): Omit<CreateServiceCategoryInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const clientId = readRequiredUuid(body.clientId, 'clientId', details);
  const code = readCode(body.code, details);
  const name = readRequiredText(body.name, 'name', MAX_NAME_LENGTH, details);
  const description = readOptionalText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  if (!clientId || !code || !name || details.length > 0) fail(details);
  return {
    clientId,
    code,
    name,
    ...(description === undefined ? {} : { description }),
  };
}

export function parseUpdateServiceCategoryBody(
  body: unknown,
): UpdateServiceCategoryInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
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
  if (details.length > 0) fail(details);
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

export function parseServiceCategoryFilters(
  query: unknown,
): ServiceCategoryFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const filters: ServiceCategoryFilters = {};

  const clientIdRaw = first(query.clientId);
  if (clientIdRaw !== undefined && clientIdRaw !== '') {
    const clientId = readRequiredUuid(clientIdRaw, 'clientId', details);
    if (clientId) filters.clientId = clientId;
  }
  const statusRaw = first(query.status);
  if (statusRaw !== undefined && statusRaw !== '') {
    if (isServiceCategoryStatus(statusRaw)) {
      filters.status = statusRaw;
    } else {
      details.push({
        field: 'status',
        message: 'status must be one of: ACTIVE, INACTIVE.',
      });
    }
  }
  if (details.length > 0) fail(details);
  return filters;
}

export function parseAvailabilityGrantBody(body: unknown): {
  buildingId: string;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  if (!buildingId || details.length > 0) fail(details);
  return { buildingId };
}

export function parseLinkCategoryBody(body: unknown): {
  serviceCategoryId: string;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const serviceCategoryId = readRequiredUuid(
    body.serviceCategoryId,
    'serviceCategoryId',
    details,
  );
  if (!serviceCategoryId || details.length > 0) fail(details);
  return { serviceCategoryId };
}

export function parseStarterPackImportBody(body: unknown): {
  clientId: string;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const clientId = readRequiredUuid(body.clientId, 'clientId', details);
  if (!clientId || details.length > 0) fail(details);
  return { clientId };
}

export type ServiceCatalogReadQuery = {
  clientId?: string;
  buildingId?: string;
  currency?: PriceCatalogCurrency;
  status?: ServiceCategoryStatus;
};

export function parseServiceCatalogReadQuery(query: unknown): ServiceCatalogReadQuery {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const result: ServiceCatalogReadQuery = {};

  const clientIdRaw = first(query.clientId);
  if (clientIdRaw !== undefined && clientIdRaw !== '') {
    const clientId = readRequiredUuid(clientIdRaw, 'clientId', details);
    if (clientId) result.clientId = clientId;
  }
  const buildingIdRaw = first(query.buildingId);
  if (buildingIdRaw !== undefined && buildingIdRaw !== '') {
    const buildingId = readRequiredUuid(buildingIdRaw, 'buildingId', details);
    if (buildingId) result.buildingId = buildingId;
  }
  const currencyRaw = first(query.currency);
  if (currencyRaw !== undefined && currencyRaw !== '') {
    if (isPriceCatalogCurrency(currencyRaw)) {
      result.currency = currencyRaw;
    } else {
      details.push({
        field: 'currency',
        message: 'currency must be one of the supported price-catalog currencies.',
      });
    }
  }
  const statusRaw = first(query.status);
  if (statusRaw !== undefined && statusRaw !== '') {
    if (isServiceCategoryStatus(statusRaw)) {
      result.status = statusRaw;
    } else {
      details.push({
        field: 'status',
        message: 'status must be one of: ACTIVE, INACTIVE.',
      });
    }
  }
  if (details.length > 0) fail(details);
  return result;
}
