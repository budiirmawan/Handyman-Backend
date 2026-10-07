import { AppError } from '../../shared/errors';
import type {
  AttachSaasAddOnInput,
  CreateSaasAddOnInput,
  ListSaasAddOnFilters,
  SaasAddOnEntitlementEffect,
  SaasAddOnQuotaEffect,
  SaasAddOnStatus,
  UpdateSaasAddOnInput,
} from './platform-addon.types';

/**
 * CR-BE-SAAS-01 PART 13C PART 02 — Add-on HTTP request parsing.
 *
 * Validation here is STRUCTURAL (presence, types, basic shapes). Domain
 * authority (catalog semantics, duplicate detection, add-on existence,
 * frozen source-precedence) lives in the service layer.
 *
 * Idempotency: catalogue POST / PATCH DO NOT consume an Idempotency-Key
 * (frozen §17.2 omits these operations). Subscription attach / detach
 * DO require `expectedVersion` against the SUBSCRIPTION aggregate (frozen
 * §22 `ver`); no Idempotency-Key for either.
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
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
  }
  return value;
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
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
  }
  return value;
}

function readRequiredUuid(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
): string | undefined {
  const value = body[field];
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    details.push({ field, message: `${field} must be a UUID.` });
    return undefined;
  }
  return value;
}

function readStatus(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
): SaasAddOnStatus | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value !== 'ACTIVE' && value !== 'INACTIVE') {
    details.push({ field, message: `${field} must be ACTIVE or INACTIVE.` });
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

function readOptionalArray(
  body: Record<string, unknown>,
  field: string,
  details: Detail[],
  maxItems: number,
): unknown[] | undefined {
  const value = body[field];
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

function parseEntitlementEffect(
  value: unknown,
  index: number,
  details: Detail[],
): SaasAddOnEntitlementEffect | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    details.push({
      field: `entitlementEffects[${index}]`,
      message: 'must be an object.',
    });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const capabilityCode = record.capabilityCode;
  if (
    typeof capabilityCode !== 'string' ||
    capabilityCode.trim() === '' ||
    capabilityCode.length > 100
  ) {
    details.push({
      field: `entitlementEffects[${index}].capabilityCode`,
      message: 'capabilityCode is required (max 100 characters).',
    });
    return undefined;
  }
  const action = record.action;
  if (action !== 'ENABLE' && action !== 'LIMIT') {
    details.push({
      field: `entitlementEffects[${index}].action`,
      message: 'action must be ENABLE or LIMIT.',
    });
    return undefined;
  }
  let limitKey: string | undefined;
  let limitValue: number | undefined;
  if (action === 'LIMIT') {
    const rawKey = record.limitKey;
    if (typeof rawKey !== 'string' || rawKey.trim() === '' || rawKey.length > 100) {
      details.push({
        field: `entitlementEffects[${index}].limitKey`,
        message: 'limitKey is required for action=LIMIT (max 100 characters).',
      });
    } else {
      limitKey = rawKey;
    }
    const rawValue = record.limitValue;
    if (
      typeof rawValue !== 'number' ||
      !Number.isInteger(rawValue) ||
      rawValue < 0
    ) {
      details.push({
        field: `entitlementEffects[${index}].limitValue`,
        message: 'limitValue must be a non-negative integer when action=LIMIT.',
      });
    } else {
      limitValue = rawValue;
    }
  }
  return {
    capabilityCode,
    action,
    ...(limitKey !== undefined ? { limitKey } : {}),
    ...(limitValue !== undefined ? { limitValue } : {}),
  };
}

function parseQuotaEffect(
  value: unknown,
  index: number,
  details: Detail[],
): SaasAddOnQuotaEffect | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    details.push({
      field: `quotaEffects[${index}]`,
      message: 'must be an object.',
    });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const limitKey = record.limitKey;
  if (typeof limitKey !== 'string' || limitKey.trim() === '' || limitKey.length > 100) {
    details.push({
      field: `quotaEffects[${index}].limitKey`,
      message: 'limitKey is required (max 100 characters).',
    });
    return undefined;
  }
  const deltaValue = record.deltaValue;
  if (
    typeof deltaValue !== 'number' ||
    !Number.isInteger(deltaValue)
  ) {
    details.push({
      field: `quotaEffects[${index}].deltaValue`,
      message: 'deltaValue must be an integer.',
    });
    return undefined;
  }
  // Frozen schema does NOT restrict sign; preserve existing canonical
  // behavior (no sign rule invented in this layer).
  return { limitKey, deltaValue };
}

// ---------------------------------------------------------------------------
// Catalogue bodies
// ---------------------------------------------------------------------------

export function parseCreateSaasAddOnBody(body: unknown): CreateSaasAddOnInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;
  const productId = readRequiredUuid(record, 'productId', details);
  const code = readRequiredString(record, 'code', details, 100);
  const name = readRequiredString(record, 'name', details, 255);
  const description = readOptionalString(record, 'description', details, 2000);
  const status = readStatus(record, 'status', details);
  const rawEntitlementEffects = readOptionalArray(
    record,
    'entitlementEffects',
    details,
    500,
  );
  const entitlementEffects = rawEntitlementEffects?.map((value, index) =>
    parseEntitlementEffect(value, index, details),
  );
  const rawQuotaEffects = readOptionalArray(
    record,
    'quotaEffects',
    details,
    500,
  );
  const quotaEffects = rawQuotaEffects?.map((value, index) =>
    parseQuotaEffect(value, index, details),
  );
  if (details.length > 0) fail(details);
  return {
    productId: productId!,
    code: code!,
    name: name!,
    description: description ?? undefined,
    status,
    entitlementEffects: entitlementEffects as SaasAddOnEntitlementEffect[] | undefined,
    quotaEffects: quotaEffects as SaasAddOnQuotaEffect[] | undefined,
  };
}

export function parseUpdateSaasAddOnBody(body: unknown): UpdateSaasAddOnInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;
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

export function parseListSaasAddOnFilters(
  query: Record<string, unknown>,
): ListSaasAddOnFilters {
  const details: Detail[] = [];
  const filters: ListSaasAddOnFilters = {};
  if (query.productId !== undefined) {
    const value = Array.isArray(query.productId) ? '' : (query.productId as string);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ) {
      details.push({ field: 'productId', message: 'productId must be a UUID.' });
    } else {
      filters.productId = value;
    }
  }
  if (query.status !== undefined) {
    const value = Array.isArray(query.status) ? '' : (query.status as string);
    if (value !== 'ACTIVE' && value !== 'INACTIVE') {
      details.push({ field: 'status', message: 'status must be ACTIVE or INACTIVE.' });
    } else {
      filters.status = value;
    }
  }
  if (details.length > 0) fail(details);
  return filters;
}

// ---------------------------------------------------------------------------
// Subscription binding bodies
// ---------------------------------------------------------------------------

export function parseAttachSaasAddOnBody(body: unknown): AttachSaasAddOnInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;
  const addOnId = readRequiredUuid(record, 'addOnId', details);
  const expectedVersion = readExpectedVersion(record, details);
  if (details.length > 0) fail(details);
  return {
    // subscriptionId comes from the URL path, not the body.
    subscriptionId: '',
    addOnId: addOnId!,
    expectedVersion: expectedVersion!,
  };
}

export function parseDetachSaasAddOnBody(body: unknown): { expectedVersion: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'body must be an object.' }]);
  }
  const details: Detail[] = [];
  const record = body as Record<string, unknown>;
  const expectedVersion = readExpectedVersion(record, details);
  if (details.length > 0) fail(details);
  return { expectedVersion: expectedVersion! };
}

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

function readUuidParam(raw: string | string[], field: string): string {
  const value = Array.isArray(raw) ? '' : raw;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    fail([{ field, message: `${field} must be a UUID.` }]);
  }
  return value;
}

export function parseAddOnIdParam(raw: string | string[]): string {
  return readUuidParam(raw, 'id');
}

export function parseSubscriptionIdParam(raw: string | string[]): string {
  return readUuidParam(raw, 'subscriptionId');
}
