/**
 * CR-BE-SAAS-01 PART 06 — platform-billing request validation.
 *
 * Focused, frozen-surface only (frozen §22): the caller supplies
 * REFERENCE + registry data (customerId, subscriptionId, billing-account
 * registry fields, period bounds, `issue` flag, expectedVersion, void
 * reason). Commercial values (unit price, base price, discount,
 * currency, totals) are NEVER accepted from the caller — the frozen
 * adjustment command does not exist in PART 06.
 */
import { AppError } from '../../shared/errors';
import {
  SAAS_INVOICE_STATUSES,
  type CreateSaasBillingAccountInput,
  type CreateSaasInvoiceInput,
  type IssueSaasInvoiceInput,
  type ListSaasInvoiceFilters,
  type SaasInvoiceStatus,
  type UpdateSaasBillingAccountInput,
  type VoidSaasInvoiceInput,
} from './platform-billing.types';

type Detail = { field: string; message: string };

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function readRequiredString(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (value.length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
    return undefined;
  }
  return value;
}

function readOptionalString(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push({ field, message: `${field} must be a non-empty string.` });
    return undefined;
  }
  if (value.length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
    return undefined;
  }
  return value;
}

/**
 * PATCH nullable field: `undefined` = leave unchanged, explicit `null`
 * = clear, string = set.
 */
function readClearableString(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxLength: number,
): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push({
      field,
      message: `${field} must be a non-empty string or null.`,
    });
    return undefined;
  }
  if (value.length > maxLength) {
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
    return undefined;
  }
  return value;
}

function readUuid(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
): string | undefined {
  const value = body[field];
  if (!isUuid(value)) {
    details.push({ field, message: `${field} must be a UUID.` });
    return undefined;
  }
  return value;
}

function readExpectedVersion(
  body: Record<string, unknown>,
  details: Detail[],
): number | undefined {
  const value = body.expectedVersion;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be a positive integer.',
    });
    return undefined;
  }
  return value;
}

function readTimestamp(
  source: Record<string, unknown>,
  field: string,
  details: Detail[],
  required: boolean,
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') {
    if (required) {
      details.push({ field, message: `${field} is required.` });
    }
    return undefined;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: `${field} must be an ISO-8601 timestamp.` });
    return undefined;
  }
  return value;
}

function readPaymentTerms(
  body: Record<string, unknown>,
  details: Detail[],
): number | undefined {
  const value = body.paymentTerms;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 365) {
    details.push({
      field: 'paymentTerms',
      message: 'paymentTerms must be an integer between 0 and 365 (days).',
    });
    return undefined;
  }
  return value;
}

function readBillingAddress(
  body: Record<string, unknown>,
  details: Detail[],
): Record<string, unknown> | undefined {
  const value = body.billingAddress;
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    details.push({
      field: 'billingAddress',
      message: 'billingAddress must be a non-empty JSON object.',
    });
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readOptionalBoolean(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    details.push({ field, message: `${field} must be a boolean.` });
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Billing accounts
// ---------------------------------------------------------------------------

/** POST /platform/billing-accounts body (frozen §22). */
export function parseCreateSaasBillingAccountBody(
  body: unknown,
): CreateSaasBillingAccountInput {
  const source: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const details: Detail[] = [];

  const customerId = readUuid(source, 'customerId', details);
  const legalName = readRequiredString(source, 'legalName', details, 255);
  const taxIdentity = readOptionalString(source, 'taxIdentity', details, 120);
  const billingAddress = readBillingAddress(source, details);
  const billingEmail = readOptionalString(source, 'billingEmail', details, 255);
  const currencyCode = readRequiredString(source, 'currencyCode', details, 8);
  const paymentTerms = readPaymentTerms(source, details);

  if (details.length > 0) fail(details);

  const result: CreateSaasBillingAccountInput = {
    customerId: customerId as string,
    legalName: (legalName as string).trim(),
    currencyCode: (currencyCode as string).trim().toUpperCase(),
  };
  if (taxIdentity) result.taxIdentity = taxIdentity.trim();
  result.billingAddress = billingAddress ?? {};
  if (billingEmail) result.billingEmail = billingEmail.trim();
  if (paymentTerms !== undefined) result.paymentTerms = paymentTerms;
  return result;
}

/**
 * PATCH /platform/billing-accounts/:id body (frozen §22, ver).
 * Registry fields only — customer binding and invoice fields are
 * immutable; unknown keys are rejected.
 */
export function parseUpdateSaasBillingAccountBody(
  body: unknown,
): UpdateSaasBillingAccountInput {
  const source: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const details: Detail[] = [];

  const expectedVersion = readExpectedVersion(source, details);

  const allowedKeys = [
    'expectedVersion',
    'legalName',
    'taxIdentity',
    'billingAddress',
    'billingEmail',
    'currencyCode',
    'paymentTerms',
    'status',
  ];
  for (const key of Object.keys(source)) {
    if (!allowedKeys.includes(key)) {
      details.push({
        field: key,
        message: `field '${key}' is not updatable on a billing account.`,
      });
    }
  }

  const legalName = readOptionalString(source, 'legalName', details, 255);
  const taxIdentity = readClearableString(source, 'taxIdentity', details, 120);
  const billingAddress = readBillingAddress(source, details);
  const billingEmail = readClearableString(source, 'billingEmail', details, 255);
  const currencyCode = readOptionalString(source, 'currencyCode', details, 8);
  const paymentTerms = readPaymentTerms(source, details);

  let status: 'ACTIVE' | 'INACTIVE' | undefined;
  const rawStatus = source.status;
  if (rawStatus !== undefined) {
    if (rawStatus !== 'ACTIVE' && rawStatus !== 'INACTIVE') {
      details.push({
        field: 'status',
        message: "status must be 'ACTIVE' or 'INACTIVE'.",
      });
    } else {
      status = rawStatus;
    }
  }

  if (
    legalName === undefined &&
    taxIdentity === undefined &&
    billingAddress === undefined &&
    billingEmail === undefined &&
    currencyCode === undefined &&
    paymentTerms === undefined &&
    status === undefined
  ) {
    details.push({
      field: 'body',
      message: 'at least one updatable billing-account field is required.',
    });
  }

  if (details.length > 0) fail(details);

  return {
    expectedVersion: expectedVersion as number,
    legalName: legalName?.trim(),
    taxIdentity: taxIdentity === undefined ? undefined : taxIdentity?.trim() ?? null,
    billingAddress,
    billingEmail: billingEmail === undefined ? undefined : billingEmail?.trim() ?? null,
    currencyCode: currencyCode?.trim().toUpperCase(),
    paymentTerms,
    status,
  };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * POST /platform/invoices body (frozen §22): subscription reference,
 * optional explicit period, optional `issue` flag. No commercial fields
 * are accepted.
 */
export function parseCreateSaasInvoiceBody(
  body: unknown,
): CreateSaasInvoiceInput {
  const source: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const details: Detail[] = [];

  const subscriptionId = readUuid(source, 'subscriptionId', details);
  const periodStart = readTimestamp(source, 'periodStart', details, false);
  const periodEnd = readTimestamp(source, 'periodEnd', details, false);
  const issue = readOptionalBoolean(source, 'issue', details);

  const rejectedCommercial: string[] = [];
  for (const key of Object.keys(source)) {
    if (
      !['subscriptionId', 'periodStart', 'periodEnd', 'issue'].includes(key)
    ) {
      rejectedCommercial.push(key);
    }
  }
  if (rejectedCommercial.length > 0) {
    details.push({
      field: rejectedCommercial.join(', '),
      message:
        'commercial fields (prices, discounts, currency, totals) are not accepted; amounts are resolved from the bound pricebook version.',
    });
  }

  if (details.length > 0) fail(details);

  const input: CreateSaasInvoiceInput = {
    subscriptionId: subscriptionId as string,
  };
  if (periodStart) input.periodStart = periodStart;
  if (periodEnd) input.periodEnd = periodEnd;
  if (issue !== undefined) input.issue = issue;
  return input;
}

/** GET /platform/invoices query (frozen §22 filters). */
export function parseListSaasInvoiceFilters(
  query: Record<string, unknown>,
): ListSaasInvoiceFilters {
  const details: Detail[] = [];
  const filters: ListSaasInvoiceFilters = {};

  if (query.customerId !== undefined) {
    if (!isUuid(query.customerId)) {
      details.push({ field: 'customerId', message: 'customerId must be a UUID.' });
    } else {
      filters.customerId = query.customerId as string;
    }
  }
  if (query.status !== undefined) {
    const status = query.status as string;
    if (!SAAS_INVOICE_STATUSES.includes(status as SaasInvoiceStatus)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${SAAS_INVOICE_STATUSES.join(', ')}.`,
      });
    } else {
      filters.status = status as SaasInvoiceStatus;
    }
  }
  if (query.periodStart !== undefined) {
    filters.periodStart = readTimestamp(query, 'periodStart', details, true);
  }
  if (query.periodEnd !== undefined) {
    filters.periodEnd = readTimestamp(query, 'periodEnd', details, true);
  }

  if (details.length > 0) fail(details);
  return filters;
}

/** POST /platform/invoices/:id/issue body (frozen §22, Idem. + ver). */
export function parseIssueSaasInvoiceBody(
  body: unknown,
): IssueSaasInvoiceInput {
  const source: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const details: Detail[] = [];
  const expectedVersion = readExpectedVersion(source, details);
  if (details.length > 0) fail(details);
  return { expectedVersion: expectedVersion as number };
}

/** POST /platform/invoices/:id/void body (frozen §22, ver; reason mandatory). */
export function parseVoidSaasInvoiceBody(
  body: unknown,
): VoidSaasInvoiceInput {
  const source: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const details: Detail[] = [];
  const expectedVersion = readExpectedVersion(source, details);
  const reason = readRequiredString(source, 'reason', details, 500);
  if (details.length > 0) fail(details);
  return { expectedVersion: expectedVersion as number, reason: (reason as string).trim() };
}
