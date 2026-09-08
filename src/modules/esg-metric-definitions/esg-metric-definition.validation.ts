import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ESG_METRIC_CATEGORIES,
  ESG_CALCULATION_METHODS,
  ESG_METRIC_CODE_MAX_LENGTH,
  ESG_METRIC_CODE_MIN_LENGTH,
  ESG_METRIC_CODE_PATTERN,
  isEsgCalculationMethod,
  isEsgMetricCategory,
  isEsgMetricStatus,
  type CreateEsgMetricDefinitionInput,
  type EsgMetricDefinitionFilters,
  type UpdateEsgMetricDefinitionInput,
} from './esg-metric-definition.types';

export type ValidationDetail = { field: string; message: string };

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SEARCH_LENGTH = 200;

export function normalizeEsgMetricCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidEsgMetricCode(value: string): boolean {
  return (
    value.length >= ESG_METRIC_CODE_MIN_LENGTH &&
    value.length <= ESG_METRIC_CODE_MAX_LENGTH &&
    ESG_METRIC_CODE_PATTERN.test(value)
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

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'code is required.' });
    return undefined;
  }
  const normalized = normalizeEsgMetricCode(value);
  if (!isValidEsgMetricCode(normalized)) {
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

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

export function parseEsgMetricDefinitionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'ESG metric definition id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateEsgMetricDefinitionBody(
  body: unknown,
): Omit<CreateEsgMetricDefinitionInput, 'createdByUserId'> & {
  clientId: string;
  code: string;
  name: string;
  category: typeof ESG_METRIC_CATEGORIES[number];
} {
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

  const categoryRaw = body.category;
  let category: typeof ESG_METRIC_CATEGORIES[number] | undefined;
  if (typeof categoryRaw !== 'string' || !isEsgMetricCategory(categoryRaw)) {
    details.push({
      field: 'category',
      message: `category must be one of: ${ESG_METRIC_CATEGORIES.join(', ')}.`,
    });
  } else {
    category = categoryRaw;
  }

  const calcRaw = body.calculationMethod;
  let calculationMethod: typeof ESG_CALCULATION_METHODS[number] | undefined;
  if (calcRaw !== undefined) {
    if (typeof calcRaw !== 'string' || !isEsgCalculationMethod(calcRaw)) {
      details.push({
        field: 'calculationMethod',
        message: `calculationMethod must be one of: ${ESG_CALCULATION_METHODS.join(', ')}.`,
      });
    } else {
      calculationMethod = calcRaw;
    }
  }

  const uomId = readOptionalUuid(body.uomId, 'uomId', details);

  if (!clientId || !code || !name || !category || details.length > 0) {
    fail(details);
  }

  return {
    clientId: clientId!,
    code: code!,
    name: name!,
    category: category!,
    ...(description === undefined ? {} : { description }),
    ...(calculationMethod === undefined ? {} : { calculationMethod }),
    ...(uomId === undefined ? {} : { uomId }),
  };
}

export function parseUpdateEsgMetricDefinitionBody(
  body: unknown,
): UpdateEsgMetricDefinitionInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  if (body.code !== undefined) {
    details.push({
      field: 'code',
      message:
        'code is immutable; create a new definition to change ESG metric identity.',
    });
  }
  if (body.clientId !== undefined) {
    details.push({
      field: 'clientId',
      message: 'clientId is immutable.',
    });
  }
  if (body.status !== undefined) {
    details.push({
      field: 'status',
      message:
        'status is not editable via PATCH; use the deactivate endpoint for ACTIVE → INACTIVE.',
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

  let category: typeof ESG_METRIC_CATEGORIES[number] | undefined;
  if (body.category !== undefined) {
    if (
      typeof body.category !== 'string' ||
      !isEsgMetricCategory(body.category)
    ) {
      details.push({
        field: 'category',
        message: `category must be one of: ${ESG_METRIC_CATEGORIES.join(', ')}.`,
      });
    } else {
      category = body.category;
    }
  }

  let calculationMethod: typeof ESG_CALCULATION_METHODS[number] | undefined;
  if (body.calculationMethod !== undefined) {
    if (
      typeof body.calculationMethod !== 'string' ||
      !isEsgCalculationMethod(body.calculationMethod)
    ) {
      details.push({
        field: 'calculationMethod',
        message: `calculationMethod must be one of: ${ESG_CALCULATION_METHODS.join(', ')}.`,
      });
    } else {
      calculationMethod = body.calculationMethod;
    }
  }

  const uomId = readOptionalUuid(body.uomId, 'uomId', details);

  if (details.length > 0) {
    fail(details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
    ...(calculationMethod === undefined ? {} : { calculationMethod }),
    ...(uomId === undefined ? {} : { uomId }),
  };
}

export function parseEsgMetricDefinitionFilters(
  query: unknown,
): EsgMetricDefinitionFilters {
  if (!isRecord(query)) {
    return {};
  }

  const details: ValidationDetail[] = [];
  const filters: EsgMetricDefinitionFilters = {};

  const clientIdRaw = first((query as Record<string, unknown>).clientId);
  if (clientIdRaw !== undefined && clientIdRaw !== '') {
    const clientId = readRequiredUuid(clientIdRaw, 'clientId', details);
    if (clientId) filters.clientId = clientId;
  }

  const statusRaw = first((query as Record<string, unknown>).status);
  if (statusRaw !== undefined && statusRaw !== '') {
    if (isEsgMetricStatus(statusRaw)) {
      filters.status = statusRaw;
    } else {
      details.push({
        field: 'status',
        message: 'status must be one of: ACTIVE, INACTIVE.',
      });
    }
  }

  const categoryRaw = first((query as Record<string, unknown>).category);
  if (categoryRaw !== undefined && categoryRaw !== '') {
    if (isEsgMetricCategory(categoryRaw)) {
      filters.category = categoryRaw;
    } else {
      details.push({
        field: 'category',
        message: `category must be one of: ${ESG_METRIC_CATEGORIES.join(', ')}.`,
      });
    }
  }

  const calcRaw = first((query as Record<string, unknown>).calculationMethod);
  if (calcRaw !== undefined && calcRaw !== '') {
    if (isEsgCalculationMethod(calcRaw)) {
      filters.calculationMethod = calcRaw;
    } else {
      details.push({
        field: 'calculationMethod',
        message: `calculationMethod must be one of: ${ESG_CALCULATION_METHODS.join(', ')}.`,
      });
    }
  }

  const uomIdRaw = first((query as Record<string, unknown>).uomId);
  if (uomIdRaw !== undefined && uomIdRaw !== '') {
    const uomId = readRequiredUuid(uomIdRaw, 'uomId', details);
    if (uomId) filters.uomId = uomId;
  }

  const searchRaw = first((query as Record<string, unknown>).search);
  if (searchRaw !== undefined && searchRaw !== '') {
    const search = readOptionalText(searchRaw, 'search', MAX_SEARCH_LENGTH, details);
    if (search) filters.search = search;
  }

  if (details.length > 0) {
    fail(details);
  }

  return filters;
}
