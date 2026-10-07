import { AppError } from '../../shared/errors';
import {
  isValidClientCode,
  isValidUuid,
  normalizeClientCode,
} from '../clients';
import type {
  CreateSaaSCustomerInput,
  ListSaaSCustomerFilters,
  SaaSCustomerStorageStatus,
  UpdateSaaSCustomerInput,
} from './platform-customer.types';
import { SAAS_CUSTOMER_STORAGE_STATUSES } from './platform-customer.types';

/**
 * CR-BE-SAAS-01 PART 01 — SaaS Customer request validation.
 *
 * Reuses the canonical client code normalization/grammar from the existing
 * `clients` module (same machine identity, same rules). `status` is rejected
 * on create and update — the lifecycle is server-authoritative and
 * subscription-driven (frozen §7.2); `code` is the immutable identity.
 */

const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_LEGAL_NAME_LENGTH = 255;
const MAX_TAX_ID_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_BILLING_PHONE_LENGTH = 32;
const MAX_ADDRESS_LENGTH = 512;
const MAX_TIMEZONE_LENGTH = 64;
const MAX_QUERY_LENGTH = 64;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,31}$/;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

export type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationError(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/**
 * Registry fields that may appear in a create/update body — anything outside
 * this set (notably `status`, `code`, `id`) is rejected with a field detail
 * rather than silently ignored, so the console cannot smuggle authority.
 */
const CREATE_OPTIONAL_FIELDS = [
  'legalName',
  'displayName',
  'taxId',
  'description',
  'billingEmail',
  'billingPhone',
  'address',
  'country',
  'currencyCode',
  'timezone',
] as const;

const UPDATE_OPTIONAL_FIELDS = [
  'name',
  'legalName',
  'displayName',
  'taxId',
  'description',
  'billingEmail',
  'billingPhone',
  'address',
  'country',
  'currencyCode',
  'timezone',
] as const;

function assertOnlyKnownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  details: ValidationDetail[],
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      details.push({
        field: key,
        message:
          key === 'status'
            ? 'status cannot be set directly; the customer lifecycle is server-authoritative.'
            : key === 'code'
              ? 'code is the immutable customer identity and cannot be changed.'
              : `Field is not accepted.`,
      });
    }
  }
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

function readBillingEmail(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'billingEmail', message: 'billingEmail must be a string.' });
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '') {
    return undefined;
  }
  if (normalized.length > 255 || !EMAIL_PATTERN.test(normalized)) {
    details.push({
      field: 'billingEmail',
      message: 'billingEmail must be a valid email address.',
    });
    return undefined;
  }
  return normalized;
}

function readBillingPhone(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'billingPhone', message: 'billingPhone must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (
    trimmed.length < 7 ||
    trimmed.length > MAX_BILLING_PHONE_LENGTH ||
    !PHONE_PATTERN.test(trimmed)
  ) {
    details.push({
      field: 'billingPhone',
      message: 'billingPhone must be a phone number (7-32 characters, digits, spaces, "+", "-" or "(").',
    });
    return undefined;
  }
  return trimmed;
}

function readCountry(value: unknown, details: ValidationDetail[]): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'country', message: 'country must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!COUNTRY_PATTERN.test(trimmed)) {
    details.push({ field: 'country', message: 'country must be an ISO-3166-1 alpha-2 code.' });
    return undefined;
  }
  return trimmed.toUpperCase();
}

function readCurrencyCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'currencyCode', message: 'currencyCode must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!CURRENCY_PATTERN.test(trimmed)) {
    details.push({ field: 'currencyCode', message: 'currencyCode must be a 3-letter ISO-4217 code.' });
    return undefined;
  }
  return trimmed.toUpperCase();
}

function readRequiredName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'name is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'name is required.' });
    return undefined;
  }
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

/** Parses `POST /platform/customers`. Creation always starts at PROSPECT. */
export function parseCreateSaaSCustomerBody(body: unknown): CreateSaaSCustomerInput {
  if (!isRecord(body)) {
    validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  assertOnlyKnownFields(
    body,
    ['code', 'name', ...CREATE_OPTIONAL_FIELDS],
    details,
  );

  let code: string | undefined;
  const codeRaw = body.code;
  if (typeof codeRaw !== 'string') {
    details.push({ field: 'code', message: 'code is required.' });
  } else {
    const normalized = normalizeClientCode(codeRaw);
    if (!isValidClientCode(normalized)) {
      details.push({
        field: 'code',
        message:
          'code must start with a letter and contain only uppercase letters, digits, and underscores (2-64 characters).',
      });
    } else {
      code = normalized;
    }
  }

  const name = readRequiredName(body.name, details);
  const legalName = readOptionalString(body.legalName, 'legalName', MAX_LEGAL_NAME_LENGTH, details);
  const displayName = readOptionalString(body.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH, details);
  const taxId = readOptionalString(body.taxId, 'taxId', MAX_TAX_ID_LENGTH, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const billingEmail = readBillingEmail(body.billingEmail, details);
  const billingPhone = readBillingPhone(body.billingPhone, details);
  const address = readOptionalString(body.address, 'address', MAX_ADDRESS_LENGTH, details);
  const country = readCountry(body.country, details);
  const currencyCode = readCurrencyCode(body.currencyCode, details);
  const timezone = readOptionalString(body.timezone, 'timezone', MAX_TIMEZONE_LENGTH, details);

  if (details.length > 0) {
    validationError(details);
  }

  return {
    code: code as string,
    name: name as string,
    ...(legalName === undefined ? {} : { legalName }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(taxId === undefined ? {} : { taxId }),
    ...(description === undefined ? {} : { description }),
    ...(billingEmail === undefined ? {} : { billingEmail }),
    ...(billingPhone === undefined ? {} : { billingPhone }),
    ...(address === undefined ? {} : { address }),
    ...(country === undefined ? {} : { country }),
    ...(currencyCode === undefined ? {} : { currencyCode }),
    ...(timezone === undefined ? {} : { timezone }),
  };
}

/** Parses `PATCH /platform/customers/:id`. `expectedVersion` is required. */
export function parseUpdateSaaSCustomerBody(body: unknown): UpdateSaaSCustomerInput {
  if (!isRecord(body)) {
    validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  assertOnlyKnownFields(body, [...UPDATE_OPTIONAL_FIELDS, 'expectedVersion'], details);

  const expectedVersion = body.expectedVersion;
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion is required and must be an integer >= 1.',
    });
  }

  const name =
    body.name === undefined ? undefined : readRequiredName(body.name, details);
  const legalName =
    body.legalName === undefined
      ? undefined
      : readOptionalString(body.legalName, 'legalName', MAX_LEGAL_NAME_LENGTH, details);
  const displayName =
    body.displayName === undefined
      ? undefined
      : readOptionalString(body.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH, details);
  const taxId =
    body.taxId === undefined
      ? undefined
      : readOptionalString(body.taxId, 'taxId', MAX_TAX_ID_LENGTH, details);
  const description =
    body.description === undefined
      ? undefined
      : readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const billingEmail =
    body.billingEmail === undefined ? undefined : readBillingEmail(body.billingEmail, details);
  const billingPhone =
    body.billingPhone === undefined ? undefined : readBillingPhone(body.billingPhone, details);
  const address =
    body.address === undefined
      ? undefined
      : readOptionalString(body.address, 'address', MAX_ADDRESS_LENGTH, details);
  const country = body.country === undefined ? undefined : readCountry(body.country, details);
  const currencyCode =
    body.currencyCode === undefined ? undefined : readCurrencyCode(body.currencyCode, details);
  const timezone =
    body.timezone === undefined
      ? undefined
      : readOptionalString(body.timezone, 'timezone', MAX_TIMEZONE_LENGTH, details);

  if (details.length > 0) {
    validationError(details);
  }

  return {
    expectedVersion: expectedVersion as number,
    ...(name === undefined ? {} : { name }),
    ...(legalName === undefined ? {} : { legalName }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(taxId === undefined ? {} : { taxId }),
    ...(description === undefined ? {} : { description }),
    ...(billingEmail === undefined ? {} : { billingEmail }),
    ...(billingPhone === undefined ? {} : { billingPhone }),
    ...(address === undefined ? {} : { address }),
    ...(country === undefined ? {} : { country }),
    ...(currencyCode === undefined ? {} : { currencyCode }),
    ...(timezone === undefined ? {} : { timezone }),
  };
}

/** Parses `GET /platform/customers` filters (`status`, `q`). */
export function parseListSaaSCustomerFilters(
  query: Record<string, unknown>,
): ListSaaSCustomerFilters {
  const details: ValidationDetail[] = [];
  const filters: ListSaaSCustomerFilters = {};

  const statusRaw = query.status;
  if (statusRaw !== undefined && statusRaw !== null && statusRaw !== '') {
    if (typeof statusRaw !== 'string') {
      details.push({ field: 'status', message: 'status must be a string.' });
    } else {
      const status = statusRaw.trim().toUpperCase();
      if (!(SAAS_CUSTOMER_STORAGE_STATUSES as readonly string[]).includes(status)) {
        details.push({
          field: 'status',
          message: `status must be one of: ${SAAS_CUSTOMER_STORAGE_STATUSES.join(', ')}.`,
        });
      } else {
        filters.status = status as SaaSCustomerStorageStatus;
      }
    }
  }

  const qRaw = query.q;
  if (qRaw !== undefined && qRaw !== null && qRaw !== '') {
    if (typeof qRaw !== 'string') {
      details.push({ field: 'q', message: 'q must be a string.' });
    } else {
      const q = qRaw.trim();
      if (q === '') {
        // no-op
      } else if (q.length > MAX_QUERY_LENGTH) {
        details.push({ field: 'q', message: `q must be at most ${MAX_QUERY_LENGTH} characters.` });
      } else {
        filters.q = q;
      }
    }
  }

  if (details.length > 0) {
    validationError(details);
  }
  return filters;
}

/** Validates a customer id path parameter (canonical UUID grammar). */
export function parseCustomerIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    validationError([
      { field: 'customerId', message: 'customerId must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}
