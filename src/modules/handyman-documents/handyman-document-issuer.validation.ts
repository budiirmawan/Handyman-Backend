/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — issuer profile input validation.
 *
 * Strict, structural, and identical in both layers of the contract: every rule
 * here mirrors a CHECK constraint in migration 0490, so an input that passes
 * validation cannot be rejected by the database, and anything the database
 * would refuse is already explained by a field-level detail. Nothing is
 * defaulted: an omitted optional field stays NULL instead of receiving a
 * plausible-looking value, and a full profile must be supplied on every write
 * so a partial patch can never silently drop an identity element.
 */
import { handymanDocumentIssuerProfileValidationError } from './handyman-document-issuer.errors';
import {
  HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS,
  HANDYMAN_DOCUMENT_ISSUER_PROFILE_REQUIRED_FIELDS,
  type HandymanDocumentIssuerProfileContent,
  type HandymanDocumentIssuerProfileField,
  type UpdateHandymanDocumentIssuerProfileInput,
} from './handyman-document-issuer.types';

export type FieldIssue = { field: string; message: string };

const LIMITS: Record<HandymanDocumentIssuerProfileField, number> = {
  legalName: 200,
  displayName: 200,
  registeredAddress: 500,
  businessAddress: 500,
  city: 120,
  province: 120,
  postalCode: 20,
  email: 254,
  phone: 40,
  whatsapp: 40,
  website: 300,
  taxId: 40,
  businessRegistrationId: 40,
  logoReference: 500,
};

const PATTERNS: Partial<Record<HandymanDocumentIssuerProfileField, RegExp>> = {
  postalCode: /^[0-9A-Za-z -]{3,20}$/,
  phone: /^[0-9+][0-9 ()/ .-]{3,38}$/,
  whatsapp: /^[0-9+][0-9 ()/ .-]{3,38}$/,
  website: /^https?:\/\/\S+$/,
  taxId: /^[0-9][0-9 ./-]{6,38}$/,
  businessRegistrationId: /^[0-9A-Z][0-9A-Z ./-]{4,38}$/,
  logoReference: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapses whitespace runs; it never rewrites the text itself. */
function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlainBody(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseIssuerProfileUpdate(
  body: unknown,
  clientId: string,
): UpdateHandymanDocumentIssuerProfileInput {
  const issues: FieldIssue[] = [];
  if (!isPlainBody(body)) {
    throw handymanDocumentIssuerProfileValidationError([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const allowed = new Set<string>([
    ...HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS,
    'expectedVersion',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      issues.push({
        field: key,
        message: 'Unsupported field for the Handyman document issuer profile.',
      });
    }
  }

  const values: Record<string, string | null> = {};
  for (const field of HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS) {
    const required =
      (HANDYMAN_DOCUMENT_ISSUER_PROFILE_REQUIRED_FIELDS as readonly string[]).includes(field);
    const raw = body[field];
    if (raw === undefined) {
      if (required) {
        issues.push({ field, message: `${field} is required.` });
        continue;
      }
      values[field] = null;
      continue;
    }
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (required) {
        issues.push({ field, message: `${field} cannot be empty.` });
        continue;
      }
      values[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      issues.push({ field, message: `${field} must be a string.` });
      continue;
    }
    let value = normalizeText(raw);
    if (field === 'email') value = value.toLowerCase();
    if (field === 'businessRegistrationId') value = value.toUpperCase();
    if (value === '') {
      issues.push({ field, message: `${field} cannot be blank.` });
      continue;
    }
    if (value.length > LIMITS[field]) {
      issues.push({
        field,
        message: `${field} must not exceed ${LIMITS[field]} characters.`,
      });
      continue;
    }
    const pattern = PATTERNS[field];
    if (pattern && !pattern.test(value)) {
      issues.push({ field, message: `${field} is not in an accepted format.` });
      continue;
    }
    if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      issues.push({ field, message: 'email must be a single valid address.' });
      continue;
    }
    if (field === 'logoReference') {
      if (value.includes('..') || value.startsWith('/')) {
        issues.push({
          field,
          message: 'logoReference must be a relative media reference without traversal.',
        });
        continue;
      }
    }
    if ((field === 'legalName' || field === 'displayName') && !/[A-Za-z0-9]/.test(value)) {
      issues.push({ field, message: `${field} must contain letters or digits.` });
      continue;
    }
    values[field] = value;
  }

  const expectedVersion = body.expectedVersion;
  if (expectedVersion === undefined) {
    issues.push({
      field: 'expectedVersion',
      message:
        'expectedVersion is required: send the current version, or null when no profile exists yet.',
    });
  } else if (expectedVersion !== null) {
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
      issues.push({
        field: 'expectedVersion',
        message: 'expectedVersion must be null or a positive integer.',
      });
    }
  }

  if (issues.length > 0) {
    throw handymanDocumentIssuerProfileValidationError(issues);
  }
  return {
    clientId,
    expectedVersion: (expectedVersion ?? null) as number | null,
    ...(values as unknown as HandymanDocumentIssuerProfileContent),
  };
}

export function parseClientIdParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    throw handymanDocumentIssuerProfileValidationError([
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  return raw.toLowerCase();
}

/** History listing accepts exactly one bounded query key. */
export function parseHistoryQuery(
  query: Record<string, unknown>,
): { limit: number } {
  const keys = Object.keys(query);
  for (const key of keys) {
    if (key !== 'limit') {
      throw handymanDocumentIssuerProfileValidationError([
        { field: 'query', message: `Unsupported query parameter "${key}".` },
      ]);
    }
  }
  if (query.limit === undefined) return { limit: 20 };
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw handymanDocumentIssuerProfileValidationError([
      { field: 'limit', message: 'limit must be an integer between 1 and 100.' },
    ]);
  }
  return { limit };
}
