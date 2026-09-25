import { AppError } from '../../shared/errors';
import {
  isSaasSubscriptionBillingCycle,
  isSaasSubscriptionStorageStatus,
  type ActivateSaasSubscriptionInput,
  type CancelSaasSubscriptionInput,
  type ConvertSaasSubscriptionInput,
  type CreateSaasSubscriptionInput,
  type ListSaasSubscriptionFilters,
  type RenewSaasSubscriptionInput,
  type TerminateSaasSubscriptionInput,
  type UpdateSaasSubscriptionInput,
} from './platform-subscription.types';

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

function readUuid(body: Record<string, unknown>, field: string, details: Detail[]): string | undefined {
  const value = body[field];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
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

/**
 * Valid ISO-8601 timestamp that is in the future. Returns a Date, or
 * pushes a detail and returns undefined.
 */
function readFutureTimestamp(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
): Date | undefined {
  const value = body[field];
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: `${field} must be an ISO-8601 timestamp.` });
    return undefined;
  }
  const date = new Date(value);
  if (date.getTime() <= Date.now()) {
    details.push({ field, message: `${field} must be in the future.` });
    return undefined;
  }
  return date;
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
// Bodies
// ---------------------------------------------------------------------------

export function parseCreateSaasSubscriptionBody(
  body: unknown,
): CreateSaasSubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  const clientId = readUuid(record, 'clientId', details);
  const productId = readUuid(record, 'productId', details);
  const packageId = readUuid(record, 'packageId', details);
  const pricebookVersionId = readUuid(record, 'pricebookVersionId', details);

  const rawCycle = record.billingCycle;
  if (!isSaasSubscriptionBillingCycle(rawCycle)) {
    details.push({
      field: 'billingCycle',
      message: 'billingCycle must be one of MONTHLY, ANNUAL, CUSTOM.',
    });
  }

  let currencyCode: string | undefined;
  const rawCurrency = record.currencyCode;
  if (rawCurrency !== undefined) {
    if (typeof rawCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(rawCurrency)) {
      details.push({ field: 'currencyCode', message: 'currencyCode must be a 3-letter ISO-4217 code.' });
    } else {
      currencyCode = rawCurrency.toUpperCase();
    }
  }

  let trialEndDate: string | undefined;
  if (record.trialEndDate !== undefined) {
    const trialDate = readFutureTimestamp(record, 'trialEndDate', details);
    if (trialDate) trialEndDate = trialDate.toISOString();
  }

  if (details.length > 0) fail(details);
  return {
    clientId: clientId!,
    productId: productId!,
    packageId: packageId!,
    pricebookVersionId: pricebookVersionId!,
    billingCycle: rawCycle as CreateSaasSubscriptionInput['billingCycle'],
    currencyCode,
    trialEndDate,
  };
}

export function parseUpdateSaasSubscriptionBody(
  body: unknown,
): UpdateSaasSubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  // Frozen §11.2 rule 1: no generic status setter (nor identity change) on
  // the PATCH surface — lifecycle uses the command endpoints.
  if ('status' in record) {
    details.push({
      field: 'status',
      message: 'status is not mutable via PATCH; use the lifecycle command endpoints.',
    });
  }
  if ('code' in record) {
    details.push({ field: 'code', message: 'code is immutable.' });
  }

  const expectedVersion = readExpectedVersion(record, details);

  let renewalDate: string | undefined;
  const renewalValue = record.renewalDate;
  if (renewalValue !== undefined) {
    const date = readFutureTimestamp(record, 'renewalDate', details);
    if (date) renewalDate = date.toISOString();
  }
  let trialEndDate: string | undefined;
  const trialValue = record.trialEndDate;
  if (trialValue !== undefined) {
    const date = readFutureTimestamp(record, 'trialEndDate', details);
    if (date) trialEndDate = date.toISOString();
  }

  if (renewalDate === undefined && trialEndDate === undefined) {
    details.push({
      field: 'body',
      message: 'Provide at least one of renewalDate, trialEndDate.',
    });
  }
  if (details.length > 0) fail(details);
  return { renewalDate, trialEndDate, expectedVersion: expectedVersion! };
}

export function parseActivateSaasSubscriptionBody(
  body: unknown,
): ActivateSaasSubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  const mode = record.mode;
  if (mode !== 'TRIAL' && mode !== 'PAID') {
    details.push({ field: 'mode', message: "mode must be 'TRIAL' or 'PAID'." });
  }

  let trialEndDate: string | undefined;
  if (record.trialEndDate !== undefined) {
    const date = readFutureTimestamp(record, 'trialEndDate', details);
    if (date) trialEndDate = date.toISOString();
  }
  let periodStart: string | undefined;
  if (record.periodStart !== undefined) {
    const date = readFutureTimestamp(record, 'periodStart', details);
    if (date) periodStart = date.toISOString();
  }
  let periodEnd: string | undefined;
  if (record.periodEnd !== undefined) {
    const date = readFutureTimestamp(record, 'periodEnd', details);
    if (date) periodEnd = date.toISOString();
  }
  let renewalDate: string | undefined;
  if (record.renewalDate !== undefined) {
    const date = readFutureTimestamp(record, 'renewalDate', details);
    if (date) renewalDate = date.toISOString();
  }

  if (mode === 'TRIAL' && record.trialEndDate === undefined) {
    details.push({ field: 'trialEndDate', message: 'trialEndDate is required for TRIAL activation.' });
  }
  if (details.length > 0) fail(details);
  return {
    mode: mode as ActivateSaasSubscriptionInput['mode'],
    trialEndDate,
    periodStart,
    periodEnd,
    renewalDate,
  };
}

export function parseConvertSaasSubscriptionBody(
  body: unknown,
): ConvertSaasSubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  let periodStart: string | undefined;
  if (record.periodStart !== undefined) {
    const date = readFutureTimestamp(record, 'periodStart', details);
    if (date) periodStart = date.toISOString();
  }
  let periodEnd: string | undefined;
  if (record.periodEnd !== undefined) {
    const date = readFutureTimestamp(record, 'periodEnd', details);
    if (date) periodEnd = date.toISOString();
  }
  let renewalDate: string | undefined;
  if (record.renewalDate !== undefined) {
    const date = readFutureTimestamp(record, 'renewalDate', details);
    if (date) renewalDate = date.toISOString();
  }
  if (details.length > 0) fail(details);
  return { periodStart, periodEnd, renewalDate };
}

export function parseRenewSaasSubscriptionBody(
  body: unknown,
): RenewSaasSubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  const expectedVersion = readExpectedVersion(record, details);

  let periodEnd: string | undefined;
  if (record.periodEnd !== undefined) {
    const date = readFutureTimestamp(record, 'periodEnd', details);
    if (date) periodEnd = date.toISOString();
  }

  let pricebookVersionId: string | undefined;
  if (record.pricebookVersionId !== undefined) {
    pricebookVersionId = readUuid(record, 'pricebookVersionId', details);
  }

  let reason: string | undefined;
  const rawReason = record.reason;
  if (rawReason !== undefined) {
    reason = readOptionalString(record, 'reason', details, 500);
  }
  if (pricebookVersionId !== undefined && reason === undefined) {
    details.push({
      field: 'reason',
      message: 'reason is mandatory when rebinding the commercial version.',
    });
  }

  if (details.length > 0) fail(details);
  return { periodEnd, pricebookVersionId, reason, expectedVersion: expectedVersion! };
}

export function parseCancelSaasSubscriptionBody(
  body: unknown,
): CancelSaasSubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  const expectedVersion = readExpectedVersion(record, details);
  const reason = readRequiredString(record, 'reason', details, 500);
  const immediate = readOptionalBoolean(record, 'immediate', details);

  if (details.length > 0) fail(details);
  return { reason: reason!, immediate, expectedVersion: expectedVersion! };
}

export function parseTerminateSaasSubscriptionBody(
  body: unknown,
): TerminateSaasSubscriptionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;

  const expectedVersion = readExpectedVersion(record, details);
  const reason = readRequiredString(record, 'reason', details, 500);

  if (details.length > 0) fail(details);
  return { reason: reason!, expectedVersion: expectedVersion! };
}

// ---------------------------------------------------------------------------
// Query filters (frozen §22: customerId, status, packageId)
// ---------------------------------------------------------------------------

export function parseListSaasSubscriptionFilters(
  query: Record<string, unknown>,
): ListSaasSubscriptionFilters {
  const details: Detail[] = [];
  const filters: ListSaasSubscriptionFilters = {};

  if (query.customerId !== undefined) {
    const value = query.customerId;
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      details.push({ field: 'customerId', message: 'customerId must be a UUID.' });
    } else {
      filters.customerId = value;
    }
  }
  if (query.status !== undefined) {
    const value = query.status;
    if (!isSaasSubscriptionStorageStatus(value)) {
      details.push({ field: 'status', message: 'status must be a valid subscription status.' });
    } else {
      filters.status = value;
    }
  }
  if (query.packageId !== undefined) {
    const value = query.packageId;
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      details.push({ field: 'packageId', message: 'packageId must be a UUID.' });
    } else {
      filters.packageId = value;
    }
  }

  if (details.length > 0) fail(details);
  return filters;
}
