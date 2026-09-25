/**
 * CR-BE-SAAS-01 PART 05 — Provisioning request validation (frozen §13.1).
 *
 * The provisioning command body is INTENTIONALLY narrow. Anything that
 * looks like commercial authority (subscription status, pricebook version,
 * entitlement overrides, billing status, platform role, etc.) MUST be
 * rejected at the request boundary so the SaaS control plane cannot be
 * mutated via the provisioning surface.
 */
import type { ProvisionCustomerInput } from './platform-provisioning.types';

const FORBIDDEN_KEYS = [
  'platformPermissions',
  'platformRole',
  'subscriptionStatus',
  'customerStatus',
  'entitlements',
  'pricebookVersion',
  'billingStatus',
  'status',
  'quota',
  'tenantId',
] as const;

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_PATTERN.test(value.trim());
}

function isValidCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

function ensureString(
  obj: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | null | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLen) return undefined;
  return trimmed;
}

export interface ProvisionValidationFailure {
  field: string;
  message: string;
}

export interface ProvisionValidationResult {
  value?: ProvisionCustomerInput;
  failures: ProvisionValidationFailure[];
}

/** Reject unknown keys that could mutate commercial / lifecycle state. */
export function rejectForbiddenKeys(
  body: unknown,
): ProvisionValidationFailure[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [
      { field: 'body', message: 'body must be a JSON object.' },
    ];
  }
  const obj = body as Record<string, unknown>;
  const failures: ProvisionValidationFailure[] = [];
  for (const k of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      failures.push({
        field: k,
        message: `Field "${k}" is not permitted on the provisioning command.`,
      });
    }
  }
  return failures;
}

/** Validate frozen §13.1 body. */
export function parseProvisionCustomerInput(
  body: unknown,
): ProvisionValidationResult {
  const failures: ProvisionValidationFailure[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      failures: [{ field: 'body', message: 'body must be a JSON object.' }],
    };
  }
  const obj = body as Record<string, unknown>;

  const organizationCode = ensureString(obj, 'organizationCode', 64);
  if (organizationCode !== undefined && organizationCode !== null && !isValidCode(organizationCode)) {
    failures.push({
      field: 'organizationCode',
      message: 'organizationCode must be 1-64 chars (A-Z, 0-9, _ or -).',
    });
  }
  const organizationName = ensureString(obj, 'organizationName', 200);
  const propertyCode = ensureString(obj, 'propertyCode', 64);
  if (propertyCode !== undefined && propertyCode !== null && !isValidCode(propertyCode)) {
    failures.push({
      field: 'propertyCode',
      message: 'propertyCode must be 1-64 chars (A-Z, 0-9, _ or -).',
    });
  }
  const propertyName = ensureString(obj, 'propertyName', 200);
  const buildingCode = ensureString(obj, 'buildingCode', 64);
  if (buildingCode !== undefined && buildingCode !== null && !isValidCode(buildingCode)) {
    failures.push({
      field: 'buildingCode',
      message: 'buildingCode must be 1-64 chars (A-Z, 0-9, _ or -).',
    });
  }
  const buildingName = ensureString(obj, 'buildingName', 200);

  const adminEmailRaw = ensureString(obj, 'adminEmail', 254);
  if (adminEmailRaw !== undefined && adminEmailRaw !== null && !isValidEmail(adminEmailRaw)) {
    failures.push({
      field: 'adminEmail',
      message: 'adminEmail must be a valid email address.',
    });
  }
  const adminName = ensureString(obj, 'adminName', 200);
  const reason = ensureString(obj, 'reason', 500);

  let expectedVersion = 1;
  const expectedVersionRaw = obj.expectedVersion;
  if (
    expectedVersionRaw !== undefined &&
    expectedVersionRaw !== null &&
    typeof expectedVersionRaw === 'number' &&
    Number.isInteger(expectedVersionRaw) &&
    expectedVersionRaw >= 1
  ) {
    expectedVersion = expectedVersionRaw;
  } else if (expectedVersionRaw !== undefined && expectedVersionRaw !== null) {
    failures.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be an integer ≥ 1 when supplied.',
    });
  }

  if (failures.length > 0) return { failures };

  return {
    value: {
      ...(organizationCode !== null && organizationCode !== undefined
        ? { organizationCode }
        : {}),
      ...(organizationName !== null && organizationName !== undefined
        ? { organizationName }
        : {}),
      ...(propertyCode !== null && propertyCode !== undefined
        ? { propertyCode }
        : {}),
      ...(propertyName !== null && propertyName !== undefined
        ? { propertyName }
        : {}),
      ...(buildingCode !== null && buildingCode !== undefined
        ? { buildingCode }
        : {}),
      ...(buildingName !== null && buildingName !== undefined
        ? { buildingName }
        : {}),
      ...(adminEmailRaw !== null && adminEmailRaw !== undefined
        ? { adminEmail: adminEmailRaw }
        : {}),
      ...(adminName !== null && adminName !== undefined
        ? { adminName }
        : {}),
      ...(reason !== null && reason !== undefined ? { reason } : {}),
      expectedVersion,
    },
    failures,
  };
}

/** Validate path param `customerId`. */
export function isValidCustomerId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 64) return false;
  // Accept either a client-code (c-prefix) or a UUID format (frozen §7.3).
  return (
    /^c[a-z0-9_]{4,63}$/.test(value) ||
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  );
}

/** Validate runId path param. */
export function isValidRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}
