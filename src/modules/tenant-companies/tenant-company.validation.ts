import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  IDENTITY_DOCUMENT_PATTERNS,
  INDIVIDUAL_IDENTITY_DOCUMENT_TYPES,
  LEGAL_ENTITY_IDENTITY_DOCUMENT_TYPES,
  TENANT_COMPANY_STATUSES,
  TENANT_PARTY_KINDS,
  isTenantCompanyStatus,
  isTenantIdentityDocumentType,
  isTenantPartyKind,
  isTenantVerificationStatus,
  type CreateTenantCompanyInput,
  type TenantCompanyListFilters,
  type TenantCompanyStatus,
  type TenantIdentityDocumentType,
  type TenantPartyKind,
  type TenantVerificationStatus,
  type UpdateTenantCompanyInput,
} from './tenant-company.types';

type Detail = { field: string; message: string };
const CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-\s.]{5,}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never { throw AppError.validation('Request validation failed.', details); }

export function normalizeTenantCompanyCode(value: string): string { return value.trim().toUpperCase(); }
export function isValidTenantCompanyCode(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && CODE_PATTERN.test(value);
}

/** Identity documents are stored uppercase, without surrounding/inner spaces. */
export function normalizeIdentityDocumentNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

/** Identity fields after transport parsing (create or update). */
export type PartyIdentityFields = {
  legalName?: string | null;
  identityDocumentType?: TenantIdentityDocumentType | null;
  identityDocumentNumber?: string | null;
};

/**
 * CR-HM-MASTER-IND-01 — one authoritative party-shape rule, shared by the
 * create and update paths (and therefore by every entry point).
 *
 *  - identity document type and number are all-or-nothing;
 *  - INDIVIDUAL accepts KTP / PASSPORT / KITAS and MUST be identified —
 *    an unnamed/undocumented physical customer is not operable master data;
 *  - LEGAL_ENTITY accepts NPWP / NIB and keeps them optional;
 *  - an INDIVIDUAL must not carry a separate `legalName` (one physical
 *    person, one name — no fictitious legal entity).
 */
export function assertPartyIdentity(
  partyKind: TenantPartyKind,
  fields: PartyIdentityFields,
): void {
  const details: Detail[] = [];
  const type = fields.identityDocumentType ?? null;
  const number = fields.identityDocumentNumber ?? null;

  if ((type === null) !== (number === null)) {
    details.push({
      field: type === null ? 'identityDocumentType' : 'identityDocumentNumber',
      message:
        'identityDocumentType and identityDocumentNumber must be supplied together.',
    });
  }

  const allowed: readonly TenantIdentityDocumentType[] =
    partyKind === 'INDIVIDUAL'
      ? INDIVIDUAL_IDENTITY_DOCUMENT_TYPES
      : LEGAL_ENTITY_IDENTITY_DOCUMENT_TYPES;

  if (type !== null && !allowed.includes(type)) {
    details.push({
      field: 'identityDocumentType',
      message: `identityDocumentType for a ${partyKind} party must be one of: ${allowed.join(', ')}.`,
    });
  }

  if (type !== null && number !== null) {
    const pattern = IDENTITY_DOCUMENT_PATTERNS[type];
    if (!pattern.test(number)) {
      details.push({
        field: 'identityDocumentNumber',
        message: `identityDocumentNumber is not a valid ${type} number.`,
      });
    }
  }

  if (partyKind === 'INDIVIDUAL') {
    if (fields.legalName !== undefined && fields.legalName !== null) {
      details.push({
        field: 'legalName',
        message:
          'legalName is not accepted for an INDIVIDUAL party; tenantName is the person name.',
      });
    }
    if (type === null || number === null) {
      details.push({
        field: 'identityDocumentType',
        message:
          'An INDIVIDUAL party requires identityDocumentType and identityDocumentNumber.',
      });
    }
  }

  if (details.length) fail(details);
}

export function parseTenantCompanyIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'tenantCompanyId', message: 'Tenant company id must be a valid UUID.' }]);
  return value;
}
export function parseTenantCompanyClientIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'clientId', message: 'Client id must be a valid UUID.' }]);
  return value;
}

export function parseCreateTenantCompanyBody(body: unknown): Omit<CreateTenantCompanyInput, 'clientId'> {
  if (!object(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const tenantCode = code(body.tenantCode, details);
  const tenantName = requiredString(body.tenantName, 'tenantName', 160, details);
  const partyKind = readPartyKind(body.partyKind, details) ?? 'LEGAL_ENTITY';
  const legalName = optionalString(body.legalName, 'legalName', 255, details);
  const identity = readIdentity(body, details);
  const email = optionalEmail(body.email, details);
  const phone = optionalPhone(body.phone, details);
  const address = optionalString(body.address, 'address', 512, details);
  const status = readStatus(body.status, details);
  const verificationStatus = readCreatableVerificationStatus(body.verificationStatus, details);
  if (!tenantCode || !tenantName || details.length) fail(details);
  assertPartyIdentity(partyKind, {
    legalName: legalName ?? null,
    ...identity,
  });
  // `partyKind` is only echoed when the caller supplied it: the create
  // contract stays byte-compatible for existing LEGAL_ENTITY callers, and the
  // repository applies the LEGAL_ENTITY default.
  return { tenantCode, tenantName,
    ...(body.partyKind === undefined ? {} : { partyKind }),
    ...(legalName ? { legalName } : {}),
    ...(identity.identityDocumentType
      ? {
        identityDocumentType: identity.identityDocumentType,
        identityDocumentNumber: identity.identityDocumentNumber ?? undefined,
      }
      : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}), ...(address ? { address } : {}), ...(status ? { status } : {}),
    ...(verificationStatus ? { verificationStatus } : {}) };
}

export function parseUpdateTenantCompanyBody(body: unknown): UpdateTenantCompanyInput {
  if (!object(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (
    body.clientId !== undefined ||
    body.tenantCode !== undefined ||
    body.partyKind !== undefined ||
    body.verificationStatus !== undefined
  ) {
    const field = body.clientId !== undefined
      ? 'clientId'
      : body.tenantCode !== undefined
        ? 'tenantCode'
        : body.partyKind !== undefined
          ? 'partyKind'
          : 'verificationStatus';
    fail([{
      field,
      message:
        field === 'verificationStatus'
          ? 'verificationStatus is not patchable; use the verification action.'
          : field === 'partyKind'
          ? 'partyKind is immutable; a physical customer does not change kind.'
          : 'This field is immutable and cannot be updated.',
    }]);
  }
  const details: Detail[] = [];
  const tenantName = body.tenantName === undefined ? undefined : requiredString(body.tenantName, 'tenantName', 160, details);
  const legalName = nullableString(body.legalName, 'legalName', 255, details);
  const identity = readIdentity(body, details, true);
  const email = body.email === null ? null : optionalEmail(body.email, details);
  const phone = body.phone === null ? null : optionalPhone(body.phone, details);
  const address = nullableString(body.address, 'address', 512, details);
  const status = readStatus(body.status, details);
  if (details.length) fail(details);
  return { ...(tenantName !== undefined ? { tenantName } : {}), ...(legalName !== undefined ? { legalName } : {}),
    ...identity,
    ...(email !== undefined ? { email } : {}), ...(phone !== undefined ? { phone } : {}),
    ...(address !== undefined ? { address } : {}), ...(status !== undefined ? { status } : {}) };
}

export function parseTenantCompanyListQuery(query: Record<string, unknown>): TenantCompanyListFilters {
  const details: Detail[] = [];
  const search = optionalString(query.search, 'search', 160, details);
  const status = readStatus(query.status, details);
  const partyKind = readPartyKind(query.partyKind, details);
  if (details.length) fail(details);
  return { ...(search ? { search } : {}), ...(status ? { status } : {}),
    ...(partyKind ? { partyKind } : {}) };
}

/**
 * Reads the identity pair. On update (`allowNull`) a JSON null clears a
 * value; `assertPartyIdentity` re-checks the merged record in the service.
 */
function readIdentity(
  body: Record<string, unknown>,
  details: Detail[],
  allowNull = false,
): {
  identityDocumentType?: TenantIdentityDocumentType | null;
  identityDocumentNumber?: string | null;
} {
  const rawType = body.identityDocumentType;
  const rawNumber = body.identityDocumentNumber;
  const result: {
    identityDocumentType?: TenantIdentityDocumentType | null;
    identityDocumentNumber?: string | null;
  } = {};

  if (rawType === null && allowNull) {
    result.identityDocumentType = null;
  } else if (rawType !== undefined && rawType !== null) {
    if (typeof rawType !== 'string' || !isTenantIdentityDocumentType(rawType.trim().toUpperCase())) {
      details.push({
        field: 'identityDocumentType',
        message: `identityDocumentType must be one of: KTP, PASSPORT, KITAS, NPWP, NIB.`,
      });
    } else {
      result.identityDocumentType = rawType.trim().toUpperCase() as TenantIdentityDocumentType;
    }
  }

  if (rawNumber === null && allowNull) {
    result.identityDocumentNumber = null;
  } else if (rawNumber !== undefined && rawNumber !== null) {
    if (typeof rawNumber !== 'string' || !rawNumber.trim()) {
      details.push({
        field: 'identityDocumentNumber',
        message: 'identityDocumentNumber must be a non-empty string.',
      });
    } else {
      result.identityDocumentNumber = normalizeIdentityDocumentNumber(rawNumber);
    }
  }

  return result;
}

function readPartyKind(value: unknown, details: Detail[]): TenantPartyKind | undefined {
  if (value === undefined || value === null) return;
  if (!isTenantPartyKind(value)) {
    details.push({
      field: 'partyKind',
      message: `partyKind must be one of: ${TENANT_PARTY_KINDS.join(', ')}.`,
    });
    return;
  }
  return value;
}

function code(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') { details.push({ field: 'tenantCode', message: 'Tenant code is required.' }); return; }
  const normalized = normalizeTenantCompanyCode(value);
  if (!isValidTenantCompanyCode(normalized)) {
    details.push({ field: 'tenantCode', message: 'Tenant code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).' }); return;
  }
  return normalized;
}
function requiredString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) { details.push({ field, message: `${field} is required.` }); return; }
  const result = value.trim();
  if (result.length > max) { details.push({ field, message: `${field} must be at most ${max} characters.` }); return; }
  return result;
}
function optionalString(value: unknown, field: string, max: number, details: Detail[]): string | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') { details.push({ field, message: `${field} must be a string.` }); return; }
  const result = value.trim();
  if (!result) return;
  if (result.length > max) { details.push({ field, message: `${field} must be at most ${max} characters.` }); return; }
  return result;
}
function nullableString(value: unknown, field: string, max: number, details: Detail[]): string | null | undefined {
  return value === null ? null : optionalString(value, field, max, details);
}
function optionalEmail(value: unknown, details: Detail[]): string | undefined {
  const result = optionalString(value, 'email', 255, details)?.toLowerCase();
  if (result && !EMAIL_PATTERN.test(result)) { details.push({ field: 'email', message: 'email must be a valid email address.' }); return; }
  return result;
}
function optionalPhone(value: unknown, details: Detail[]): string | undefined {
  const result = optionalString(value, 'phone', 32, details);
  if (result && !PHONE_PATTERN.test(result)) { details.push({ field: 'phone', message: 'phone has an invalid format.' }); return; }
  return result;
}
function readStatus(value: unknown, details: Detail[]): TenantCompanyStatus | undefined {
  if (value === undefined) return;
  if (!isTenantCompanyStatus(value)) { details.push({ field: 'status', message: `Status must be one of: ${TENANT_COMPANY_STATUSES.join(', ')}.` }); return; }
  return value;
}

/**
 * Create-time verification state: PENDING_VERIFICATION (temporary
 * registration) or VERIFIED (the existing default). REJECTED is only settable
 * through the auditable verification action.
 */
function readCreatableVerificationStatus(
  value: unknown,
  details: Detail[],
): 'PENDING_VERIFICATION' | 'VERIFIED' | undefined {
  if (value === undefined) return undefined;
  if (value === 'PENDING_VERIFICATION' || value === 'VERIFIED') return value;
  details.push({
    field: 'verificationStatus',
    message: 'verificationStatus must be PENDING_VERIFICATION or VERIFIED.',
  });
  return undefined;
}

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — verification action body. Only the three
 * documented verdicts; REJECTED is settable here (the action is the single
 * auditable channel) but never through create/PATCH.
 */
export function parseTenantVerificationBody(body: unknown): TenantVerificationStatus {
  const value = object(body) ? body.status : undefined;
  if (!isTenantVerificationStatus(value)) {
    fail([{ field: 'status', message: 'status must be PENDING_VERIFICATION, VERIFIED or REJECTED.' }]);
  }
  return value;
}
