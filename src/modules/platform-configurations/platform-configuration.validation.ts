/**
 * CR-BE-SAAS-01 PART 12A — Platform configuration value-shape
 * validation (frozen §20.2 catalogue).
 *
 * Each frozen key has a frozen shape. `validatePlatformConfigValue`
 * returns `{ok, value|message}` (non-throwing) for the resolver's
 * graceful fallback; `assertValidPlatformConfigValue` throws
 * `AppError.validation(400)` for the controller path.
 *
 * PART 12B keeps this file untouched. Body-shape validation for the
 * HTTP routes lives in `platform-configuration.body-validation.ts`.
 */
import { AppError } from '../../shared/errors';
import type { PlatformConfigValueShape } from './platform-configuration.types';

interface ValidationOk<T> {
  ok: true;
  value: T;
}
interface ValidationErr {
  ok: false;
  message: string;
}
type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function ok<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}
function err(message: string): ValidationErr {
  return { ok: false, message };
}

// ---- per-shape validators ------------------------------------------------

function validateInt(value: unknown): ValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return err('expected a positive integer');
  }
  return ok(value);
}

function validateSuspendedAccessPolicy(
  value: unknown,
): ValidationResult<string> {
  if (
    value !== 'READ_ONLY' &&
    value !== 'LIMITED_ACCESS' &&
    value !== 'FULL_BLOCK'
  ) {
    return err(
      'expected one of READ_ONLY | LIMITED_ACCESS | FULL_BLOCK',
    );
  }
  return ok(value);
}

function validateStringArray(
  value: unknown,
): ValidationResult<string[]> {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    return err('expected an array of strings');
  }
  return ok(value as string[]);
}

function validateBillingCycleList(
  value: unknown,
): ValidationResult<string[]> {
  const result = validateStringArray(value);
  if (!result.ok) return result;
  for (const cycle of result.value) {
    if (cycle !== 'MONTHLY' && cycle !== 'ANNUAL' && cycle !== 'CUSTOM') {
      return err(
        `billing cycle must be one of MONTHLY | ANNUAL | CUSTOM (got "${cycle}")`,
      );
    }
  }
  return result;
}

function validateRoutePatternList(
  value: unknown,
): ValidationResult<string[]> {
  const result = validateStringArray(value);
  if (!result.ok) return result;
  for (const pattern of result.value) {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      return err('route pattern must be a non-empty string');
    }
  }
  return result;
}

function validateProductAvailabilityList(
  value: unknown,
): ValidationResult<Array<{ productId: string; available: boolean }>> {
  if (!Array.isArray(value)) {
    return err('expected an array of { productId, available } objects');
  }
  const out: Array<{ productId: string; available: boolean }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return err('each item must be an object');
    }
    const o = item as Record<string, unknown>;
    if (typeof o['productId'] !== 'string' || o['productId'].length === 0) {
      return err('productId must be a non-empty string');
    }
    if (typeof o['available'] !== 'boolean') {
      return err('available must be a boolean');
    }
    out.push({
      productId: o['productId'],
      available: o['available'],
    });
  }
  return ok(out);
}

function validateProviderEnablementList(
  value: unknown,
): ValidationResult<Array<{ providerType: string; enabled: boolean }>> {
  if (!Array.isArray(value)) {
    return err('expected an array of { providerType, enabled } objects');
  }
  const out: Array<{ providerType: string; enabled: boolean }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return err('each item must be an object');
    }
    const o = item as Record<string, unknown>;
    if (
      typeof o['providerType'] !== 'string' ||
      o['providerType'].length === 0
    ) {
      return err('providerType must be a non-empty string');
    }
    if (typeof o['enabled'] !== 'boolean') {
      return err('enabled must be a boolean');
    }
    out.push({
      providerType: o['providerType'],
      enabled: o['enabled'],
    });
  }
  return ok(out);
}

function validateCommercialDefaults(
  value: unknown,
): ValidationResult<{
  paymentTermsDays: number;
  invoiceNumberPrefix: string;
}> {
  if (typeof value !== 'object' || value === null) {
    return err('expected an object');
  }
  const o = value as Record<string, unknown>;
  if (
    typeof o['paymentTermsDays'] !== 'number' ||
    !Number.isInteger(o['paymentTermsDays']) ||
    (o['paymentTermsDays'] as number) < 1
  ) {
    return err('paymentTermsDays must be a positive integer');
  }
  if (
    typeof o['invoiceNumberPrefix'] !== 'string' ||
    (o['invoiceNumberPrefix'] as string).length === 0
  ) {
    return err('invoiceNumberPrefix must be a non-empty string');
  }
  return ok({
    paymentTermsDays: o['paymentTermsDays'] as number,
    invoiceNumberPrefix: o['invoiceNumberPrefix'] as string,
  });
}

// ---- public surface -------------------------------------------------------

const VALIDATORS: Readonly<
  Record<PlatformConfigValueShape, (v: unknown) => ValidationResult<unknown>>
> = {
  int: validateInt as (v: unknown) => ValidationResult<unknown>,
  suspended_access_policy:
    validateSuspendedAccessPolicy as (v: unknown) => ValidationResult<unknown>,
  currency_code_list: validateStringArray as (
    v: unknown,
  ) => ValidationResult<unknown>,
  billing_cycle_list: validateBillingCycleList as (
    v: unknown,
  ) => ValidationResult<unknown>,
  route_pattern_list: validateRoutePatternList as (
    v: unknown,
  ) => ValidationResult<unknown>,
  product_availability_list: validateProductAvailabilityList as (
    v: unknown,
  ) => ValidationResult<unknown>,
  provider_enablement_list: validateProviderEnablementList as (
    v: unknown,
  ) => ValidationResult<unknown>,
  commercial_defaults: validateCommercialDefaults as (
    v: unknown,
  ) => ValidationResult<unknown>,
};

/**
 * Non-throwing shape validation. Used by the resolver to fall back
 * to the frozen default when the persisted row is malformed.
 */
export function validatePlatformConfigValue(
  _key: string,
  shape: PlatformConfigValueShape,
  value: unknown,
): ValidationResult<unknown> {
  const validator = VALIDATORS[shape];
  return validator(value);
}

/**
 * Throwing shape validation. Used by the controller / service to
 * reject mismatched input.
 */
export function assertValidPlatformConfigValue(
  key: string,
  shape: PlatformConfigValueShape,
  value: unknown,
): unknown {
  const result = validatePlatformConfigValue(key, shape, value);
  if (!result.ok) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'value',
        message: `${key}: ${result.message}`,
      },
    ]);
  }
  return result.value;
}
