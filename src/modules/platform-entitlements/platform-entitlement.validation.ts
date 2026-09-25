import { AppError } from '../../shared/errors';
import type { OverrideSaasEntitlementInput } from './platform-entitlement.types';

type Detail = { field: string; message: string };

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/**
 * POST /platform/subscriptions/:id/entitlements body (frozen §22 console
 * OVERRIDE: capabilityCode, optional enabled/limitValue, reason MANDATORY,
 * expectedVersion MANDATORY — the route is "ver").
 */
export function parseOverrideSaasEntitlementBody(
  body: unknown,
): OverrideSaasEntitlementInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const record = body as Record<string, unknown>;
  const details: Detail[] = [];

  // capabilityCode — required, canonical modules catalogue code.
  let capabilityCode: string | undefined;
  if (
    typeof record.capabilityCode !== 'string' ||
    record.capabilityCode.trim().length === 0
  ) {
    details.push({ field: 'capabilityCode', message: 'capabilityCode is required.' });
  } else if (record.capabilityCode.length > 100) {
    details.push({
      field: 'capabilityCode',
      message: 'capabilityCode must be at most 100 characters.',
    });
  } else {
    capabilityCode = record.capabilityCode.trim();
  }

  // enabled — optional boolean (default true: the console override grants).
  let enabled = true;
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') {
      details.push({ field: 'enabled', message: 'enabled must be a boolean.' });
    } else {
      enabled = record.enabled;
    }
  }

  // limitValue — optional non-negative integer (0 = explicitly unlimited).
  let limitValue: number | undefined;
  if (record.limitValue !== undefined) {
    if (
      typeof record.limitValue !== 'number' ||
      !Number.isInteger(record.limitValue) ||
      record.limitValue < 0
    ) {
      details.push({
        field: 'limitValue',
        message: 'limitValue must be a non-negative integer (0 = unlimited).',
      });
    } else {
      limitValue = record.limitValue;
    }
  }

  // reason — MANDATORY (frozen §18.3: reason mandatory for overrides).
  let reason: string | undefined;
  if (
    typeof record.reason !== 'string' ||
    record.reason.trim().length === 0
  ) {
    details.push({ field: 'reason', message: 'reason is required.' });
  } else if (record.reason.length > 1000) {
    details.push({
      field: 'reason',
      message: 'reason must be at most 1000 characters.',
    });
  } else {
    reason = record.reason.trim();
  }

  // expectedVersion — MANDATORY (frozen §17.3, route is "ver").
  let expectedVersion: number | undefined;
  if (
    typeof record.expectedVersion !== 'number' ||
    !Number.isInteger(record.expectedVersion) ||
    record.expectedVersion < 1
  ) {
    details.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be a positive integer.',
    });
  } else {
    expectedVersion = record.expectedVersion;
  }

  if (details.length > 0) fail(details);
  return {
    capabilityCode: capabilityCode!,
    enabled,
    ...(limitValue !== undefined ? { limitValue } : {}),
    reason: reason!,
    expectedVersion: expectedVersion!,
  };
}
