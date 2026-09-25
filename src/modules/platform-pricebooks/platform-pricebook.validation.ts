import { AppError } from '../../shared/errors';
import type {
  CreateSaasPricebookInput,
  CreateSaasPricebookVersionInput,
  ListSaasPricebookFilters,
  PriceItemInput,
} from './platform-pricebook.types';

/**
 * CR-BE-SAAS-01 PART 02 — pricebook request parsing (structural).
 * Domain authority (currency, product/package existence, uniqueness) lives
 * in the service.
 */

type Detail = { field: string; message: string };

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readRequiredString(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  ) {
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

function readUuid(
  value: unknown,
  field: string,
  details: Detail[],
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    details.push({ field, message: `${field} must be a UUID.` });
    return undefined;
  }
  return value;
}

function readNumber(
  value: unknown,
  field: string,
  details: Detail[],
  required: boolean,
): number | undefined {
  if (value === undefined || value === null) {
    if (required) details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    details.push({ field, message: `${field} must be a number.` });
    return undefined;
  }
  return value;
}

/** Express 5 types path params as `string | string[]`; normalize. */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export function parseCreateSaasPricebookBody(
  body: unknown,
): CreateSaasPricebookInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;
  const code = readRequiredString(record, 'code', details, 64);
  const name = readRequiredString(record, 'name', details, 255);
  const currencyCode = readRequiredString(record, 'currencyCode', details, 3);
  const status = readStatus(record, 'status', details);
  if (details.length > 0) fail(details);
  return {
    code: code!,
    name: name!,
    currencyCode: currencyCode!,
    status,
  };
}

function parsePriceItem(
  value: unknown,
  index: number,
  details: Detail[],
): PriceItemInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    details.push({ field: `items[${index}]`, message: 'must be an object.' });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const field = (key: string) => `items[${index}].${key}`;

  const detailsBefore = details.length;
  const productId = readUuid(record.productId, field('productId'), details, true);
  const packageId = readUuid(record.packageId, field('packageId'), details, false);

  const currencyCode = record.currencyCode;
  if (
    currencyCode !== undefined &&
    currencyCode !== null &&
    (typeof currencyCode !== 'string' || currencyCode.length > 3)
  ) {
    details.push({ field: field('currencyCode'), message: 'currencyCode must be a 3-letter code.' });
  }

  const billingCycle = record.billingCycle;
  if (
    billingCycle !== 'MONTHLY' &&
    billingCycle !== 'ANNUAL' &&
    billingCycle !== 'CUSTOM'
  ) {
    details.push({
      field: field('billingCycle'),
      message: 'billingCycle must be MONTHLY, ANNUAL, or CUSTOM.',
    });
  }

  const basePrice = readNumber(record.basePrice, field('basePrice'), details, true);
  const includedBuildingCount = readNumber(
    record.includedBuildingCount,
    field('includedBuildingCount'),
    details,
    false,
  );
  if (
    includedBuildingCount !== undefined &&
    (!Number.isInteger(includedBuildingCount) || includedBuildingCount < 0)
  ) {
    details.push({
      field: field('includedBuildingCount'),
      message: 'includedBuildingCount must be a non-negative integer.',
    });
  }
  const additionalBuildingPrice = readNumber(
    record.additionalBuildingPrice,
    field('additionalBuildingPrice'),
    details,
    false,
  );

  if (details.length > detailsBefore) {
    return undefined; // this item failed; details already recorded
  }
  return {
    productId: productId!,
    packageId: packageId ?? null,
    currencyCode:
      currencyCode === undefined || currencyCode === null
        ? undefined
        : (currencyCode as string),
    billingCycle: billingCycle as PriceItemInput['billingCycle'],
    basePrice: basePrice!,
    includedBuildingCount,
    additionalBuildingPrice,
  };
}

export function parseCreateSaasPricebookVersionBody(
  body: unknown,
): CreateSaasPricebookVersionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  const effectiveFrom = record.effectiveFrom;
  if (typeof effectiveFrom !== 'string' || effectiveFrom.trim() === '') {
    details.push({ field: 'effectiveFrom', message: 'effectiveFrom is required.' });
  }

  const rawItems = record.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    details.push({ field: 'items', message: 'items must be a non-empty array.' });
  } else if (rawItems.length > 500) {
    details.push({ field: 'items', message: 'items must have at most 500 entries.' });
  }
  const items = Array.isArray(rawItems)
    ? rawItems.map((value, index) => parsePriceItem(value, index, details))
    : [];

  if (details.length > 0) fail(details);
  return {
    effectiveFrom: effectiveFrom as string,
    items: items as PriceItemInput[],
  };
}

export function parseListSaasPricebookFilters(
  query: Record<string, unknown>,
): ListSaasPricebookFilters {
  const details: Detail[] = [];
  const filters: ListSaasPricebookFilters = {};
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

export function parsePricebookIdParam(raw: string | string[]): string {
  const value = paramString(raw);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    fail([{ field: 'id', message: 'id must be a UUID.' }]);
  }
  return value;
}

export function parsePricebookVersionIdParam(raw: string | string[]): string {
  const value = paramString(raw);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    fail([{ field: 'id', message: 'id must be a UUID.' }]);
  }
  return value;
}
